import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * `orcaops search --scope <glob>` end to end: artifact-granularity
 * post-filter over closed-cp files_changed + declared touched_scope,
 * `--limit` applied AFTER the filter, invalid-glob rejection, `--type`
 * composition. Pure filter math is unit-tested in `commands/search.test.ts`.
 */

interface SearchOk {
  ok: true;
  query: string;
  scope: string | null;
  count: number;
  results: Array<{ artifact_id: string; source: string }>;
}

describe('orcaops search --scope', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let authId: string;
  let docsId: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.init({ noLlm: true });

    // Two artifacts sharing the marker token but touching disjoint trees.
    const auth = await agent.capturePlan(
      {
        task: 'sharedmarker auth hardening',
        plan_steps: [{ text: 's1', label: 's1' }],
        touched_scope: ['auth'],
      },
      { noLlm: true }
    );
    authId = auth.artifact_id;
    await agent.captureCheckpoint(
      {
        artifact_id: authId,
        n: 1,
        summary: 'sharedmarker wired the auth flow',
        files_changed: ['src/auth/login.ts'],
      },
      { noLlm: true }
    );

    const docs = await agent.capturePlan(
      {
        task: 'sharedmarker docs pass',
        plan_steps: [{ text: 's1', label: 's1' }],
        touched_scope: ['docs'],
      },
      { noLlm: true }
    );
    docsId = docs.artifact_id;
    await agent.captureCheckpoint(
      {
        artifact_id: docsId,
        n: 1,
        summary: 'sharedmarker rewrote the readme',
        files_changed: ['docs/readme.md'],
      },
      { noLlm: true }
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function search(args: string[]): Promise<SearchOk> {
    const r = await agent.runRaw(['search', ...args, '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as SearchOk;
    expect(parsed.ok).toBe(true);
    return parsed;
  }

  it('isolates artifacts by files_changed glob; count reflects post-filter', async () => {
    const all = await search(['sharedmarker']);
    expect(all.scope).toBeNull();
    const allIds = new Set(all.results.map((r) => r.artifact_id));
    expect(allIds).toContain(authId);
    expect(allIds).toContain(docsId);

    const scoped = await search(['sharedmarker', '--scope', 'src/auth/**']);
    expect(scoped.scope).toBe('src/auth/**');
    expect(scoped.count).toBe(scoped.results.length);
    const scopedIds = new Set(scoped.results.map((r) => r.artifact_id));
    expect(scopedIds).toEqual(new Set([authId]));
  });

  it('matches declared touched_scope entries as literal paths', async () => {
    const scoped = await search(['sharedmarker', '--scope', 'docs']);
    const ids = new Set(scoped.results.map((r) => r.artifact_id));
    expect(ids).toEqual(new Set([docsId]));
  });

  it('--limit applies AFTER the scope filter', async () => {
    // Both artifacts survive '**'; limit 1 then truncates the SURVIVORS,
    // not the pre-filter fetch.
    const limited = await search(['sharedmarker', '--scope', '**', '--limit', '1']);
    expect(limited.count).toBe(1);

    const authOnly = await search(['sharedmarker', '--scope', 'src/auth/**', '--limit', '1']);
    expect(authOnly.count).toBe(1);
    expect(authOnly.results[0].artifact_id).toBe(authId);
  });

  it('composes with --type', async () => {
    const cps = await search(['sharedmarker', '--scope', 'src/auth/**', '--type', 'checkpoint']);
    expect(cps.results.length).toBeGreaterThan(0);
    for (const r of cps.results) {
      expect(r.artifact_id).toBe(authId);
      expect(r.source.startsWith('checkpoint')).toBe(true);
    }
  });

  it('rejects an empty/blank glob with INVALID_INPUT (path: "scope")', async () => {
    // picomatch.makeRe is lenient (even "[" compiles), so the practically
    // rejectable class is the empty/whitespace pattern — which would
    // otherwise match nothing while looking like "no filter".
    const err = await agent.expectError(['search', 'sharedmarker', '--scope', '  ', '--json']);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('scope');
  });
});
