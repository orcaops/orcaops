// Headless coverage for `review anchor`: line hashes, floor hunk keys,
// and finding keys without ad-hoc hashing scripts.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CITATION_KIND, findingKey, FLOOR_SCHEMA_VERSION, lineHash } from '@orcaops/review-core';

import { runAnchor } from './anchor.js';
import { FLOOR_PRODUCER_VERSION } from './floor.js';
import type { ReviewArgs } from './run.js';

const A = '019f38b7-1111-7000-8000-000000000001';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' import { compute } from "./calc";',
  '+const answer = compute(42);',
  '+const twice = answer * 2;',
  '-const legacy = 7;',
  ' export function main() {',
  ' }',
  '',
].join('\n');

function makeFloor(): unknown {
  return {
    schema_version: FLOOR_SCHEMA_VERSION,
    input_hash: 'h',
    generated_at: '2026-07-09T00:00:00.000Z',
    scope: {
      branch: 'demo',
      branch_slug: 'demo',
      base_sha: 'base',
      pinned_tree_sha: 'tree',
      head_sha: null,
      default_branch: null,
      artifact_ids: [A],
      threads: [{ artifact: A, branch: 'demo', label: 'demo', first_activity_at: null }],
    },
    coverage: {
      items: [
        {
          hunkKey: 'hunk_1',
          file: 'src/a.ts',
          verdict: 'MATCHED',
          old_start: 1,
          new_start: 1,
          added_lines: 2,
          removed_lines: 1,
          units: [],
        },
      ],
      summary: {
        excluded: 0,
        unreviewable: 0,
        matched_rows: 3,
        unexplained_rows: 0,
        ambiguous_rows: 0,
        reviewable_rows: 3,
      },
    },
    attribution: {
      active_rung: 'snapshot_chain',
    },
    integrity: [],
    outline: {
      threads: [],
      unassigned: {
        gap: { sliceRefs: [], files: [] },
        ambiguous: { hunkKeys: [], files: [] },
      },
    },
    plan_coverage: [],
    citations: [
      {
        id: `cite:${A}:cp1:decision:0`,
        kind: CITATION_KIND.CHECKPOINT_DECISION,
        artifact: A,
        cp: 1,
        text: 'd',
      },
    ],
    landmarks: [],
    disclosure: [],
  };
}

let root: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orcaops-anchor-test-'));
  const dir = path.join(root, '.orcaops', 'reviews', 'demo');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'floor.json'), JSON.stringify(makeFloor()));
  await writeFile(path.join(dir, 'diff.patch'), DIFF);
  await writeFile(
    path.join(dir, 'floor-cache.json'),
    JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: 'fp' })
  );
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
  vi.restoreAllMocks();
});

const anchorArgs = (over: Partial<ReviewArgs>): ReviewArgs => ({
  cmd: 'review',
  sub: 'anchor',
  branch: 'demo',
  json: true,
  ...over,
});

const last = <T>(): T => JSON.parse(out[out.length - 1]!) as T;

describe('review anchor', () => {
  it('hashes the changed add-lines in range and resolves the floor hunkKey', async () => {
    const code = await runAnchor(
      anchorArgs({ file: 'src/a.ts', side: 'add', start: '2', end: '3' }),
      root
    );
    expect(code).toBe(0);
    const a = last<{ lineHashes: string[]; hunkKey: string; startLine: number; endLine: number }>();
    expect(a.hunkKey).toBe('hunk_1');
    expect(a.startLine).toBe(2);
    expect(a.endLine).toBe(3);
    // Byte-for-byte the manifest recipe over the raw bodies.
    expect(a.lineHashes).toEqual([
      await lineHash('add', new TextEncoder().encode('const answer = compute(42);')),
      await lineHash('add', new TextEncoder().encode('const twice = answer * 2;')),
    ]);
  });

  it('delete-side ranges use old-file numbers', async () => {
    const code = await runAnchor(
      anchorArgs({ file: 'src/a.ts', side: 'delete', start: '2' }),
      root
    );
    expect(code).toBe(0);
    const a = last<{ lineHashes: string[] }>();
    expect(a.lineHashes).toEqual([
      await lineHash('delete', new TextEncoder().encode('const legacy = 7;')),
    ]);
  });

  it('mints a finding key over explicit refs plus the resolved hunkKey', async () => {
    const code = await runAnchor(
      anchorArgs({
        file: 'src/a.ts',
        side: 'add',
        start: '2',
        finding: 'VERIFICATION_GAP:CODE:LLM_NATIVE',
        refs: [`cite:${A}:cp1:decision:0`],
      }),
      root
    );
    expect(code).toBe(0);
    const a = last<{ findingKey: string }>();
    expect(a.findingKey).toBe(
      await findingKey({
        kind: 'VERIFICATION_GAP',
        scope: 'CODE',
        origin: 'LLM_NATIVE',
        anchors: [`cite:${A}:cp1:decision:0`, 'hunk_1'],
      })
    );
  });

  it('key-only mode works without line flags; rejects bad enums and empty refs', async () => {
    expect(
      await runAnchor(
        anchorArgs({ finding: 'VERIFICATION_GAP:CODE:LLM_NATIVE', refs: ['hunk_1'] }),
        root
      )
    ).toBe(0);
    expect(last<{ findingKey: string }>().findingKey).toMatch(/^find_/);

    expect(
      await runAnchor(anchorArgs({ finding: 'NOT_A_KIND:CODE:LLM_NATIVE', refs: ['x'] }), root)
    ).toBe(1);
    expect(err.join('')).toContain('unknown finding kind');
    expect(await runAnchor(anchorArgs({ finding: 'VERIFICATION_GAP:CODE:LLM_NATIVE' }), root)).toBe(
      1
    );
    expect(err.join('')).toContain('at least one anchor ref');
  });

  it('a range with no changed lines of that side fails loudly with guidance', async () => {
    expect(await runAnchor(anchorArgs({ file: 'src/a.ts', side: 'add', start: '99' }), root)).toBe(
      1
    );
    expect(err.join('')).toContain("no changed 'add' lines");
    expect(err.join('')).toContain('new-file numbers for add');
  });

  it('--hunk auto-picks the first non-trivial changed add-line — no hand-counted numbers', async () => {
    const code = await runAnchor(anchorArgs({ hunk: 'hunk_1' }), root);
    expect(code).toBe(0);
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
      hunkKey: 'hunk_1',
    });
    expect(a.lineHashes).toEqual([
      await lineHash('add', new TextEncoder().encode('const answer = compute(42);')),
    ]);
  });

  it('--hunk composes with --finding (the hunkKey joins the refs) and rejects unknown keys', async () => {
    expect(
      await runAnchor(
        anchorArgs({ hunk: 'hunk_1', finding: 'VERIFICATION_GAP:CODE:LLM_NATIVE' }),
        root
      )
    ).toBe(0);
    expect(last<{ findingKey: string }>().findingKey).toBe(
      await findingKey({
        kind: 'VERIFICATION_GAP',
        scope: 'CODE',
        origin: 'LLM_NATIVE',
        anchors: ['hunk_1'],
      })
    );
    expect(await runAnchor(anchorArgs({ hunk: 'hunk_nope' }), root)).toBe(1);
    expect(err.join('')).toContain('not in the floor coverage table');
    expect(await runAnchor(anchorArgs({ hunk: 'hunk_1', file: 'src/a.ts' }), root)).toBe(1);
    expect(err.join('')).toContain('do not combine');
  });

  it('--help prints usage and exits 0', async () => {
    expect(await runAnchor(anchorArgs({ help: true }), root)).toBe(0);
    expect(out.join('')).toContain('usage: review anchor');
    // Usage also rides every usage error.
    expect(await runAnchor(anchorArgs({}), root)).toBe(1);
    expect(err.join('')).toContain('usage: review anchor');
  });
});
