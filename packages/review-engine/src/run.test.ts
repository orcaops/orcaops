// The argv routing layer — the exact surface `orcaops review …` (and the
// watch sidecar's internal `review …` argv) depends on. The verbs have their
// own suites; this pins the parser and the dispatcher.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureReviewStateVersion, REVIEW_STATE_VERSION } from './reviewState.js';
import { parseReviewArgs, resolveReviewRoot, runReview } from './run.js';

let root: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orcaops-run-test-'));
  await ensureReviewStateVersion(path.join(root, '.orcaops', 'reviews', 'demo'), root);
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

// The stray-cwd trap. Every review verb must be drivable from
// outside the repo via --root / ORCAOPS_ROOT, and the failure message must
// NAME both remediations.
describe('resolveReviewRoot', () => {
  it('honors --root over ORCAOPS_ROOT over git toplevel', async () => {
    const override = await resolveReviewRoot({ ORCAOPS_ROOT: '/env/root' }, '/flag/root', '/tmp');
    expect(override).toEqual({ ok: true, root: '/flag/root' });
    const fromEnv = await resolveReviewRoot({ ORCAOPS_ROOT: '/env/root' }, undefined, '/tmp');
    expect(fromEnv).toEqual({ ok: true, root: '/env/root' });
  });

  it('fails outside a git repo with a message naming --root and ORCAOPS_ROOT', async () => {
    const stray = await mkdtemp(path.join(tmpdir(), 'orcaops-stray-cwd-'));
    const result = await resolveReviewRoot({}, undefined, stray);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('--root');
      expect(result.message).toContain('ORCAOPS_ROOT');
    }
  });
});

describe('parseReviewArgs', () => {
  it('parses the explicit cache rebuild flag for review data', () => {
    expect(
      parseReviewArgs(['review', 'data', '--branch', 'demo/x', '--rebuild-cache'])
    ).toMatchObject({
      sub: 'data',
      branch: 'demo/x',
      rebuildCache: true,
    });
  });

  it('parses every flag, the comment positional action, and repeatable --ref', () => {
    const args = parseReviewArgs([
      'review',
      'anchor',
      '--branch',
      'demo/x',
      '--file',
      'src/a.ts',
      '--side',
      'add',
      '--start',
      '3',
      '--end',
      '5',
      '--finding',
      'VERIFICATION_GAP:CODE:LLM_NATIVE',
      '--ref',
      'hunk_1',
      '--ref',
      'cite:x',
      '--json',
    ]);
    expect(args).toMatchObject({
      cmd: 'review',
      sub: 'anchor',
      branch: 'demo/x',
      file: 'src/a.ts',
      side: 'add',
      start: '3',
      end: '5',
      finding: 'VERIFICATION_GAP:CODE:LLM_NATIVE',
      refs: ['hunk_1', 'cite:x'],
      json: true,
    });
  });

  it('comment carries its action as the positional third token', () => {
    const args = parseReviewArgs([
      'review',
      'comment',
      'reply',
      '--branch',
      'b',
      '--id',
      'c1',
      '--input',
      '{}',
      '--resolve',
    ]);
    expect(args).toMatchObject({
      sub: 'comment',
      action: 'reply',
      branch: 'b',
      id: 'c1',
      input: '{}',
      resolve: true,
    });
  });

  it('state carries its health or repair action as the positional third token', () => {
    expect(parseReviewArgs(['review', 'state', 'health', '--branch', 'b', '--json'])).toMatchObject(
      {
        sub: 'state',
        action: 'health',
        branch: 'b',
        json: true,
      }
    );
  });
});

describe('runReview dispatch', () => {
  const env = () => ({ ORCAOPS_ROOT: root }) as NodeJS.ProcessEnv;

  it('routes the public durable-state health surface', async () => {
    expect(
      await runReview(['review', 'state', 'health', '--branch', 'demo', '--json'], env())
    ).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      schema_version: 2,
      branch: 'demo',
      status: 'HEALTHY',
    });
  });

  it('routes journal, comments, and anchor to their verbs (root via env)', async () => {
    // journal: empty log ⇒ empty ledger, exit 0.
    expect(await runReview(['review', 'journal', '--branch', 'demo'], env())).toBe(0);
    expect(JSON.parse(out[out.length - 1]!)).toEqual({
      sections: [],
      findings: [],
      uncertainties: [],
      coverage: [],
      prompts: [],
      unassigned: { gapRows: [], gapRowsDigest: null, ambiguousHunkKeys: [] },
      lifecycle: { state: 'OPEN', stale: false, current: null, history: [] },
      ledger_generation: expect.any(String),
    });
    // comments: empty log ⇒ empty payload, exit 0.
    expect(await runReview(['review', 'comments', '--branch', 'demo', '--json'], env())).toBe(0);
    expect(JSON.parse(out[out.length - 1]!)).toMatchObject({ open_count: 0, comments: [] });
    // anchor: no cached diff ⇒ the verb's precondition error.
    expect(
      await runReview(
        ['review', 'anchor', '--branch', 'demo', '--file', 'a', '--side', 'add', '--start', '1'],
        env()
      )
    ).toBe(1);
    expect(err.join('')).toContain('no cached diff');
  });

  it('leaves JSON journal health failures to the typed append boundary', async () => {
    await writeFile(
      path.join(root, '.orcaops', 'reviews', 'demo', 'review-state.json'),
      `${JSON.stringify({ review_state_version: REVIEW_STATE_VERSION - 1 })}\n`
    );
    const event = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:00.000Z',
      threadKey: 'S1',
      action: 'VISIT',
    });

    expect(
      await runReview(['review', 'journal', '--branch', 'demo', '--add', event, '--json'], env())
    ).toBe(1);

    expect(out).toEqual([]);
    expect(JSON.parse(err.join(''))).toMatchObject({
      ok: false,
      code: 'DURABLE_STATE_UNHEALTHY',
      message: expect.stringContaining('repair deletes the complete review directory'),
    });
  });

  it('an unknown subcommand exits 2 with the routing error', async () => {
    expect(await runReview(['review', 'nope'], env())).toBe(2);
    expect(err.join('')).toContain("unknown subcommand 'nope'");
  });

  it('rejects cache rebuild authorization outside review data', async () => {
    expect(
      await runReview(['review', 'journal', '--branch', 'demo', '--rebuild-cache'], env())
    ).toBe(2);
    expect(err.join('')).toContain('--rebuild-cache is only valid with `review data`');
  });

  it.each([
    'check',
    'export',
    'onepass-input',
    'onepass',
    'compose-input',
    'compose',
    'evaluate',
    'audit',
    'narrative',
    'placement',
  ])('rejects the retired %s subcommand', async (subcommand) => {
    expect(await runReview(['review', subcommand], env())).toBe(2);
    expect(err.join('')).toContain(`unknown subcommand '${subcommand}'`);
  });

  it('rejects undocumented comment flags instead of silently ignoring them', async () => {
    expect(
      await runReview(
        ['review', 'comment', 'reply', '--branch', 'demo', '--comment', 'c1', '--body', 'answer'],
        env()
      )
    ).toBe(2);
    expect(err.join('')).toContain('unknown argument(s): --comment, c1, --body, answer');
  });

  it('fails loudly outside a git repo instead of falling back to the cwd', async () => {
    const nonGitCwd = await mkdtemp(path.join(tmpdir(), 'orcaops-nongit-'));
    expect(
      await runReview(['review', 'journal', '--branch', 'demo'], {} as NodeJS.ProcessEnv, nonGitCwd)
    ).toBe(2);
    const stderr = err.join('');
    expect(stderr).toContain('review: not inside a git repository');
    expect(stderr).toContain('--root');
  });

  it('help resolves before the root, so it works from any cwd', async () => {
    const nonGitCwd = await mkdtemp(path.join(tmpdir(), 'orcaops-nongit-'));
    expect(await runReview(['review', 'help'], {} as NodeJS.ProcessEnv, nonGitCwd)).toBe(0);
    expect(out.join('')).toContain('usage: review');
    // `--help` / `-h` arrive as the sub when they are the first token
    // (the CLI wrapper disables commander's built-in help to let them through).
    expect(await runReview(['review', '--help'], {} as NodeJS.ProcessEnv, nonGitCwd)).toBe(0);
    expect(await runReview(['review', '-h'], {} as NodeJS.ProcessEnv, nonGitCwd)).toBe(0);
  });
});
