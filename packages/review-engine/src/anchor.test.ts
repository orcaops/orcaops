// Headless coverage for `review anchor`: line hashes, floor hunk keys,
// and finding keys without ad-hoc hashing scripts. The floor and its diff are
// the retained publication of a real capture, so the hunk keys and line numbers
// the verb resolves are the ones a reviewer actually sees.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { findingKey, type Floor, lineHash } from '@orcaops/review-core';

import { runAnchor } from './anchor.js';
import type { ReviewArgs } from './run.js';
import {
  capturedReviewFixture,
  type CapturedReviewFixture,
} from '../tests/capturedReviewFixture.js';

const BASE_A = [
  'import { compute } from "./calc";',
  'const legacy = 7;',
  'export function main() {}',
  '',
].join('\n');

const CHANGED_A = [
  'import { compute } from "./calc";',
  'const answer = compute(42);',
  'const twice = answer * 2;',
  'export function main() {}',
  '',
].join('\n');

let fixture: CapturedReviewFixture;
let floor: Floor;
let artifactId: string;
let hunkKey: string;
let out: string[];
let err: string[];

beforeAll(async () => {
  fixture = await capturedReviewFixture({
    autoCleanup: false,
    baseFiles: { 'src/a.ts': BASE_A, '.gitignore': '.orcaops/\n' },
    artifacts: [
      {
        label: 'Replace the legacy constant',
        task: 'Compute the answer instead of hard-coding it',
        checkpoints: [
          {
            summary: 'Replaced the legacy constant with a computed pair.',
            changes: { 'src/a.ts': CHANGED_A },
            completedSteps: [0],
          },
        ],
      },
    ],
  });
  floor = (await fixture.publishFloor()).floor;
  artifactId = fixture.artifacts[0]!.artifactId;
  const item = floor.coverage.items.find((entry) => entry.file === 'src/a.ts');
  expect(item, 'the published floor covers the changed file').toBeDefined();
  hunkKey = item!.hunkKey;
}, 180_000);

afterAll(async () => {
  await fixture.cleanup();
});

beforeEach(() => {
  vi.stubEnv('ORCAOPS_DATA_DIR', fixture.dataRoot);
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const anchorArgs = (over: Partial<ReviewArgs>): ReviewArgs => ({
  cmd: 'review',
  sub: 'anchor',
  branch: fixture.branch,
  projectId: fixture.projectId,
  json: true,
  ...over,
});

const run = (over: Partial<ReviewArgs>) => runAnchor(anchorArgs(over), fixture.gitRoot);

const last = <T>(): T => JSON.parse(out[out.length - 1]!) as T;

describe('review anchor', () => {
  it('hashes the changed add-lines in range and resolves the floor hunkKey', async () => {
    expect(await run({ file: 'src/a.ts', side: 'add', start: '2', end: '3' })).toBe(0);
    const a = last<{ lineHashes: string[]; hunkKey: string; startLine: number; endLine: number }>();
    expect(a.hunkKey).toBe(hunkKey);
    expect(a.startLine).toBe(2);
    expect(a.endLine).toBe(3);
    // Byte-for-byte the manifest recipe over the raw bodies.
    expect(a.lineHashes).toEqual([
      await lineHash('add', new TextEncoder().encode('const answer = compute(42);')),
      await lineHash('add', new TextEncoder().encode('const twice = answer * 2;')),
    ]);
  });

  it('delete-side ranges use old-file numbers', async () => {
    expect(await run({ file: 'src/a.ts', side: 'delete', start: '2' })).toBe(0);
    expect(last<{ lineHashes: string[] }>().lineHashes).toEqual([
      await lineHash('delete', new TextEncoder().encode('const legacy = 7;')),
    ]);
  });

  it('mints a finding key over explicit refs plus the resolved hunkKey', async () => {
    expect(
      await run({
        file: 'src/a.ts',
        side: 'add',
        start: '2',
        finding: 'VERIFICATION_GAP:CODE:LLM_NATIVE',
        refs: [`cite:${artifactId}:cp1:decision:0`],
      })
    ).toBe(0);
    expect(last<{ findingKey: string }>().findingKey).toBe(
      await findingKey({
        kind: 'VERIFICATION_GAP',
        scope: 'CODE',
        origin: 'LLM_NATIVE',
        anchors: [`cite:${artifactId}:cp1:decision:0`, hunkKey],
      })
    );
  });

  it('key-only mode works without line flags; rejects bad enums and empty refs', async () => {
    expect(await run({ finding: 'VERIFICATION_GAP:CODE:LLM_NATIVE', refs: [hunkKey] })).toBe(0);
    expect(last<{ findingKey: string }>().findingKey).toMatch(/^find_/);

    expect(await run({ finding: 'NOT_A_KIND:CODE:LLM_NATIVE', refs: ['x'] })).toBe(1);
    expect(err.join('')).toContain('unknown finding kind');
    expect(await run({ finding: 'VERIFICATION_GAP:CODE:LLM_NATIVE' })).toBe(1);
    expect(err.join('')).toContain('at least one anchor ref');
  });

  it('a range with no changed lines of that side fails loudly with guidance', async () => {
    expect(await run({ file: 'src/a.ts', side: 'add', start: '99' })).toBe(1);
    expect(err.join('')).toContain("no changed 'add' lines");
    expect(err.join('')).toContain('new-file numbers for add');
  });

  it('--hunk auto-picks the first non-trivial changed add-line — no hand-counted numbers', async () => {
    expect(await run({ hunk: hunkKey })).toBe(0);
    const a = last<{
      file: string;
      side: string;
      startLine: number;
      endLine: number;
      lineHashes: string[];
      hunkKey: string;
    }>();
    // First non-trivial ADD of the hunk: line 2, `const answer = compute(42);`.
    expect(a).toMatchObject({
      file: 'src/a.ts',
      side: 'add',
      startLine: 2,
      endLine: 2,
      hunkKey,
    });
    expect(a.lineHashes).toEqual([
      await lineHash('add', new TextEncoder().encode('const answer = compute(42);')),
    ]);
  });

  it('--hunk composes with --finding (the hunkKey joins the refs) and rejects unknown keys', async () => {
    expect(await run({ hunk: hunkKey, finding: 'VERIFICATION_GAP:CODE:LLM_NATIVE' })).toBe(0);
    expect(last<{ findingKey: string }>().findingKey).toBe(
      await findingKey({
        kind: 'VERIFICATION_GAP',
        scope: 'CODE',
        origin: 'LLM_NATIVE',
        anchors: [hunkKey],
      })
    );
    expect(await run({ hunk: 'hunk_nope' })).toBe(1);
    expect(err.join('')).toContain('not in the floor coverage table');
    expect(await run({ hunk: hunkKey, file: 'src/a.ts' })).toBe(1);
    expect(err.join('')).toContain('do not combine');
  });

  it('--help prints usage and exits 0', async () => {
    expect(await run({ help: true })).toBe(0);
    expect(out.join('')).toContain('usage: review anchor');
    // Usage also rides every usage error.
    expect(await run({})).toBe(1);
    expect(err.join('')).toContain('usage: review anchor');
  });
});
