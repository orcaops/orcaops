import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore, type Config, getDefaultConfig, type Store } from '@orcaops/storage';
import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { resolveWhy, resolveWhyFile } from './resolver.js';
import { Repo } from '../git/repo.js';

describe('resolveWhy', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;
  let git: ReturnType<typeof gitClient>;
  let coreRepo: Repo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
    git = gitClient(repo.path);
    coreRepo = new Repo(repo.path);
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  /** Helper: write file (mkdir -p), commit, return SHA. */
  async function commit(filePath: string, content: string, message: string): Promise<string> {
    const abs = path.join(repo.path, filePath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    await git.add(filePath);
    await git.commit(message, { '--allow-empty': null });
    return (await git.revparse(['HEAD'])).trim();
  }

  it('returns confidence "exact" when checkpoint.head_sha === blame_sha', async () => {
    // Commit a file. Capture a checkpoint pinned to that SHA. Blame should
    // resolve to that exact commit.
    const sha = await commit('src/api.ts', 'export const x = 1;\nexport const y = 2;\n', 'add api');

    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add api',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      origin: {
        kind: 'git-import',
        imported_at: '2026-04-25T12:00:00.000Z',
        tool_version: '0.0.5',
        source_range: 'root..head',
        authors: ['author@example.com'],
        enriched_at: null,
      },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-1', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'wrote api',
        files_changed: ['src/api.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha,
      },
      { idempotencyKey: 'cp-close-1' }
    );

    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/api.ts',
      line: 1,
    });
    expect(result.blame_sha).toBe(sha);
    expect(result.best?.confidence).toBe('exact');
    expect(result.best?.artifact_id).toBe('a1');
    expect(result.best?.checkpoint_n).toBe(1);
    expect(result.best?.origin).toEqual({ kind: 'git-import' });
  });

  it('attributes plan decisions as-of the revision the checkpoint opened against (not a later revision)', async () => {
    // cp1 opens + closes at plan revision 0 touching src/a.ts; THEN a plan revise
    // adds a decision at revision 1. `why src/a.ts:1` (matching cp1) must surface
    // ONLY the revision-0 decision, never the revision-1 one.
    const sha = await commit('src/a.ts', 'export const a = 1;\n', 'add a');
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'as-of attribution',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      non_goals: [],
      decisions: [{ decision: 'D0 at rev 0', reason: 'made up front', revision_n: 0 }],
      started_at: '2026-04-25T12:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-1', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'wrote a',
        files_changed: ['src/a.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha,
      },
      { idempotencyKey: 'cp-close-1' }
    );
    // Revise → revision 1 adds a NEW decision (base shape; write path stamps it).
    await store.revisePlan(
      {
        idempotency_key: 'rev-1',
        artifact_id: 'a1',
        label: 'lbl rev1',
        plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
        touched_scope: [],
        non_goals: [],
        decisions: [{ decision: 'D1 added at rev 1', reason: 'discovered later' }],
        rationale: 'add a later decision',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'rev-1' }
    );

    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/a.ts',
      line: 1,
    });
    expect(result.best?.checkpoint_n).toBe(1);
    // The cp opened at revision 0 → its plan_decisions are the rev-0 slice only.
    expect(result.best?.plan_decisions.map((d) => [d.decision, d.revision_n])).toEqual([
      ['D0 at rev 0', 0],
    ]);
    expect(result.best?.plan_decisions.map((d) => d.decision)).not.toContain('D1 added at rev 1');
    // The as-of anchor is surfaced on the match for downstream consumers.
    expect(result.best?.open_plan_revision_event_id).not.toBeNull();
  });

  it('fails loudly when a matched checkpoint opened against a revision missing from the cache', async () => {
    const sha = await commit('src/api.ts', 'export const x = 1;\n', 'add api');
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add api',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-broken', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'wrote api',
        files_changed: ['src/api.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha,
      },
      { idempotencyKey: 'cp-close-broken' }
    );
    // Poison the cached row AFTER the close: close-time validation now
    // resolves the open revision unconditionally, so an unresolvable
    // anchor can only arise from post-close cache damage — the exact
    // state the why-path guard exists for.
    store.store.db
      .prepare(
        'UPDATE checkpoints SET open_plan_revision_event_id = ? WHERE artifact_id = ? AND n = 1'
      )
      .run('01999999-9999-7000-8000-00000000dead', 'a1');

    await expect(
      resolveWhy({ repo: coreRepo, store: store.store, file: 'src/api.ts', line: 1 })
    ).rejects.toThrow(/missing from the cache — run `orcaops rebuild` and retry/);
  });

  it('surfaces plan decisions + the matched checkpoint decisions on the match', async () => {
    const sha = await commit('src/api.ts', 'export const x = 1;\nexport const y = 2;\n', 'add api');
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add api',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      decisions: [
        {
          decision: 'imperative in-transaction enqueueCommand',
          reason: 'atomic with the write',
          revision_n: 0,
          alternatives_considered: [
            { option: 'event-listener trigger', rejected_because: 'async double-dispatch' },
          ],
        },
      ],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-dec', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'wrote api',
        files_changed: ['src/api.ts'],
        decisions: [
          {
            decision: 'return 429 on limit',
            reason: 'standard rate-limit status',
            alternatives_considered: [{ option: '503', rejected_because: 'wrong semantics' }],
          },
        ],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha,
      },
      { idempotencyKey: 'cp-close-dec' }
    );

    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/api.ts',
      line: 1,
    });
    expect(result.best?.plan_decisions).toEqual([
      {
        decision: 'imperative in-transaction enqueueCommand',
        reason: 'atomic with the write',
        revision_n: 0,
        alternatives_considered: [
          { option: 'event-listener trigger', rejected_because: 'async double-dispatch' },
        ],
      },
    ]);
    expect(result.best?.checkpoint_decisions).toEqual([
      {
        decision: 'return 429 on limit',
        reason: 'standard rate-limit status',
        alternatives_considered: [{ option: '503', rejected_because: 'wrong semantics' }],
      },
    ]);
  });

  it('keeps plan_decisions on EVERY match (JSON is intentionally un-deduped; dedup is render-only)', async () => {
    const sha = await commit('src/a.ts', 'export const a = 1;\n', 'add a');
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add a',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      decisions: [{ decision: 'd0', reason: 'r0', revision_n: 0 }],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    // Two closed cps of one artifact both touch src/a.ts, claiming nothing (so no
    // open-cp overlap) → both are exact matches.
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'o1', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'cp1',
        files_changed: ['src/a.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [],
        head_sha: sha,
      },
      { idempotencyKey: 'c1' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'o2', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 2,
        summary: 'cp2',
        files_changed: ['src/a.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [],
        head_sha: sha,
      },
      { idempotencyKey: 'c2' }
    );

    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/a.ts',
      line: 1,
    });
    expect(result.all).toHaveLength(2);
    // Both matches carry the artifact's plan decisions — dedup happens only in the
    // human render (why.ts formatHuman), not the data/JSON contract.
    expect(result.all[0].plan_decisions).toHaveLength(1);
    expect(result.all[0].plan_decisions).toEqual(result.all[1].plan_decisions);
  });

  it('returns empty decision arrays when the artifact captured none (clean empty render)', async () => {
    const sha = await commit('src/api.ts', 'export const x = 1;\n', 'add api');
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add api',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-none', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'wrote api',
        files_changed: ['src/api.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha,
      },
      { idempotencyKey: 'cp-close-none' }
    );
    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/api.ts',
      line: 1,
    });
    expect(result.best?.plan_decisions).toEqual([]);
    expect(result.best?.checkpoint_decisions).toEqual([]);
  });

  it('returns confidence "likely" when checkpoint.head_sha is an ancestor of blame_sha', async () => {
    // cp1 captures src/api.ts at sha1. Then a later commit touches the
    // file (sha2) outside any checkpoint. Blame on the new line points to
    // sha2; the cp's head_sha (sha1) is an ancestor of sha2 → likely.
    const sha1 = await commit('src/api.ts', 'export const x = 1;\n', 'init api');

    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'init api',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-2', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'initial api',
        files_changed: ['src/api.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha1,
      },
      { idempotencyKey: 'cp-close-2' }
    );

    const sha2 = await commit(
      'src/api.ts',
      'export const x = 1;\nexport const y = 2;\n',
      'extend api'
    );

    // line 2 was introduced at sha2; cp1 (sha1) is an ancestor of sha2.
    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/api.ts',
      line: 2,
    });
    expect(result.blame_sha).toBe(sha2);
    expect(result.best?.confidence).toBe('likely');
    expect(result.best?.checkpoint_head_sha).toBe(sha1);
  });

  it('returns "likely" when blame_sha is an ancestor of cp.head_sha (retroactive capture)', async () => {
    // Real-world: agent writes the line, commits, THEN the cp gets
    // captured at a later commit that includes the file. cp.head_sha
    // is a descendant of blame_sha. cp's files_changed claims the file,
    // and the line already existed when cp captured → strong signal.
    const sha1 = await commit('src/api.ts', 'export const x = 1;\n', 'init api');
    // Make a follow-up commit on main so the cp's head_sha advances.
    const sha2 = await commit('src/api.ts', 'export const x = 1;\nexport const y = 2;\n', 'extend');

    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    // Cp captures at sha2 (later) with sha1's file in files_changed.
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-3', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'wrote api retroactively',
        files_changed: ['src/api.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha2,
      },
      { idempotencyKey: 'cp-close-3' }
    );

    // Blame on line 1 (the original line) → sha1, which is an ancestor
    // of cp.head_sha (sha2). The bidirectional rule → likely.
    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/api.ts',
      line: 1,
    });
    expect(result.blame_sha).toBe(sha1);
    expect(result.best?.confidence).toBe('likely');
    expect(result.best?.reason).toContain('ancestor of checkpoint');
  });

  it('demotes to "weak" when blame predates the artifact base_sha', async () => {
    // Setup for the pre-existing-line failure mode:
    //   sha1: pre-existing line (authored before the artifact)
    //   sha2: artifact's plan.base_sha (the working-window start)
    //   sha3: cp.head_sha (a descendant of sha2 that touches the file)
    //
    // Naive resolver: blame=sha1 is an ancestor of cp.head_sha=sha3
    //   AND cp.files_changed claims the file → "likely". WRONG — the
    //   artifact didn't author the line; it only modified the file
    //   later.
    // With the base_sha precondition: blame=sha1 is an ancestor of
    //   plan.base_sha=sha2 → demote to "weak" (the line existed before
    //   the artifact started).
    const sha1 = await commit('src/api.ts', 'export const x = 1;\n', 'pre-existing line');
    const sha2 = await commit(
      'src/api.ts',
      'export const x = 1;\nimport "z";\n',
      'base for artifact'
    );
    const sha3 = await commit(
      'src/api.ts',
      'export const x = 1;\nimport "z";\nexport const y = 2;\n',
      'artifact touches file'
    );

    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-late',
      branch: 'main',
      base_sha: sha2, // artifact starts AFTER sha1
      agent: 'claude-code',
      agent_session_id: null,
      task: 'extend api',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a-late', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-4', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-late',
        n: 1,
        summary: 'touched src/api.ts',
        files_changed: ['src/api.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha3,
      },
      { idempotencyKey: 'cp-close-4' }
    );

    // Blame on line 1 → sha1, which is an ancestor of base_sha (sha2).
    // Without the guard the resolver would say "likely"; with it, "weak".
    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/api.ts',
      line: 1,
    });
    expect(result.blame_sha).toBe(sha1);
    expect(result.best?.confidence).toBe('weak');
    expect(result.best?.reason).toMatch(/predates the artifact's base_sha/);
  });

  it('still rates "likely" for descendant-path matches authored *within* the working window', async () => {
    // Same setup but blame is INSIDE the working window, not before it.
    // sha2 = base_sha; line authored at sha3 (descendant of sha2 + ancestor of cp.head_sha=sha4).
    const sha1 = await commit('src/api.ts', 'export const x = 1;\n', 'pre-existing');
    const sha2 = await commit('src/api.ts', 'export const x = 1;\nimport "z";\n', 'base');
    const sha3 = await commit(
      'src/api.ts',
      'export const x = 1;\nimport "z";\nexport const y = 2;\n',
      'authored during artifact'
    );
    const sha4 = await commit(
      'src/api.ts',
      'export const x = 1;\nimport "z";\nexport const y = 2;\nexport const z = 3;\n',
      'cp head'
    );

    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-mid',
      branch: 'main',
      base_sha: sha2,
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a-mid', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-5', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-mid',
        n: 1,
        summary: 'wrote api',
        files_changed: ['src/api.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha4,
      },
      { idempotencyKey: 'cp-close-5' }
    );

    // Blame on line 3 → sha3, which is a descendant of base_sha (sha2)
    // and an ancestor of cp.head_sha (sha4). Should remain "likely".
    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/api.ts',
      line: 3,
    });
    expect(result.blame_sha).toBe(sha3);
    expect(result.best?.confidence).toBe('likely');
    expect(result.best?.reason).toMatch(/ancestor of checkpoint head_sha/);
    // Drive-by: confirm pre-existing line still demotes to weak via the same fixture.
    const lineOne = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/api.ts',
      line: 1,
    });
    expect(lineOne.blame_sha).toBe(sha1);
    expect(lineOne.best?.confidence).toBe('weak');
  });

  it('returns "weak" only when there is genuinely no ancestry between cp.head_sha and blame_sha', async () => {
    // Construct truly parallel histories: branch off the initial commit
    // (before any file touches), then make divergent commits on each
    // branch. Neither sha is an ancestor of the other.
    await git.checkoutBranch('B', 'HEAD'); // B branches at the initial commit
    const shaB = await commit('src/foo.ts', 'export const a = 99;\n', 'foo on B');
    await git.checkout('main');
    const shaMain = await commit('src/foo.ts', 'export const a = 1;\n', 'foo on main');

    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'B',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'work on B',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-6', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'edited foo on B',
        files_changed: ['src/foo.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: shaB,
      },
      { idempotencyKey: 'cp-close-6' }
    );

    // Blame on main: line 1 was authored at shaMain. Neither shaB nor
    // shaMain is an ancestor of the other → weak.
    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/foo.ts',
      line: 1,
    });
    expect(result.blame_sha).toBe(shaMain);
    expect(result.best?.confidence).toBe('weak');
    expect(result.best?.reason).toMatch(/no ancestor relationship.*either direction/);
  });

  it('returns best=null when no checkpoint touched the file', async () => {
    await commit('src/untouched.ts', 'export const z = 1;\n', 'untouched');

    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/untouched.ts',
      line: 1,
    });
    expect(result.best).toBeNull();
    expect(result.all).toEqual([]);
  });

  it('all[] is sorted exact > likely > weak; recency breaks ties', async () => {
    const sha1 = await commit('src/a.ts', 'a\n', 'init');
    // Two checkpoints on the same file: cp1 with head_sha = sha1 (exact),
    // cp2 with a fake unrelated head_sha (weak — not in repo, isAncestor
    // returns false).
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'init',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 's2', label: 'step-2', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: '2026-04-25T11:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-7', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'cp1 exact',
        files_changed: ['src/a.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha1,
      },
      { idempotencyKey: 'cp-close-7' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-2'] },
      { idempotencyKey: 'cp-open-8', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 2,
        summary: 'cp2 fake sha',
        files_changed: ['src/a.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-2'],
        head_sha: '0000000000000000000000000000000000000001',
      },
      { idempotencyKey: 'cp-close-8' }
    );

    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/a.ts',
      line: 1,
    });
    expect(result.all[0].confidence).toBe('exact');
    expect(result.all[0].checkpoint_n).toBe(1);
    expect(result.all[1].confidence).toBe('weak');
  });

  it('branch filter narrows candidates to that branch only', async () => {
    const sha = await commit('src/x.ts', 'x\n', 'add x');

    // Two artifacts touching the same file on different branches.
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T11:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-9', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'main work',
        files_changed: ['src/x.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha,
      },
      { idempotencyKey: 'cp-close-9' }
    );

    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a2',
      branch: 'feat/other',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T11:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a2', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-10', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a2',
        n: 1,
        summary: 'other work',
        files_changed: ['src/x.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: sha,
      },
      { idempotencyKey: 'cp-close-10' }
    );

    const onlyMain = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/x.ts',
      line: 1,
      branch: 'main',
    });
    expect(onlyMain.all.every((m) => m.branch === 'main')).toBe(true);
    expect(onlyMain.all).toHaveLength(1);

    const both = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/x.ts',
      line: 1,
    });
    expect(both.all).toHaveLength(2);
  });

  it('same content in two files: queried file wins, cross-file match labeled, sort stable', async () => {
    // Two checkpoints, both weak by ancestry (fake head shas), both with
    // line-hash membership — but cp2's manifest carries the content under
    // a DIFFERENT file. cp2 is NEWER: a tier→recency-only sort would rank
    // it first; the same-file middle key keeps cp1 on top.
    await commit('src/a.ts', 'const sharedHelper = build(7);\n', 'add a');
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch: 'main',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'cross-file fixture',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 's2', label: 'step-2', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: '2026-04-25T11:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    for (const [n, step] of [
      [1, 'step-1'],
      [2, 'step-2'],
    ] as const) {
      await store.writeCheckpointOpened(
        { artifact_id: 'a1', declared_step_ids: [step] },
        { idempotencyKey: `cf-open-${n}`, headSha: 'cafef00d' }
      );
      await store.writeCheckpointClosed(
        {
          artifact_id: 'a1',
          n,
          summary: `cp${n}`,
          files_changed: ['src/a.ts'],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'fixture verification', exit_code: 0 }],
          completed_step_ids: [step],
          head_sha: `000000000000000000000000000000000000000${n}`,
        },
        { idempotencyKey: `cf-close-${n}` }
      );
    }

    const result = await resolveWhy({
      repo: coreRepo,
      store: store.store,
      file: 'src/a.ts',
      line: 1,
      lineContentProbe: async (_artifactId, n) =>
        n === 1
          ? { matched: true, manifest_files: ['src/a.ts'] }
          : { matched: true, manifest_files: ['src/b.ts'] },
    });

    // Both promote to exact; the same-file match wins despite cp2's recency.
    expect(result.all.map((m) => m.checkpoint_n)).toEqual([1, 2]);
    expect(result.best?.checkpoint_n).toBe(1);
    expect(result.best?.cross_file).toBe(false);
    expect(result.all[1].confidence).toBe('exact');
    expect(result.all[1].cross_file).toBe(true);
    expect(result.all[1].reason).toContain('DIFFERENT file(s): src/b.ts');
  });
});

describe('resolveWhyFile — whole-file window-overlap annotation', () => {
  const candidate = {
    artifact_id: 'a-1',
    branch: 'main',
    task: 'order notifications',
    n: 2,
    summary: 'cpB',
    head_sha: 'deadbeefcafe',
    closed_at: '2026-07-01T00:00:00.000Z',
    open_plan_revision_event_id: 'plan-event-1',
    decisions: [],
  };
  const fakeStore = (candidates: unknown[]): Store =>
    ({ findCheckpointsTouchingFile: () => candidates }) as unknown as Store;
  const dummyRepo = {} as unknown as Repo;
  const PLAIN_REASON =
    'whole-file mode: checkpoint claims this file in files_changed (no line anchor)';

  it('rejects a checkpoint row missing its current plan identity', async () => {
    await expect(
      resolveWhyFile({
        repo: dummyRepo,
        store: fakeStore([{ ...candidate, open_plan_revision_event_id: null }]),
        file: 'notify-shared.js',
      })
    ).rejects.toThrow(/has no recorded open-time plan revision/);
  });

  it('annotates an ambiguous overlap without changing the weak confidence', async () => {
    const res = await resolveWhyFile({
      repo: dummyRepo,
      store: fakeStore([candidate]),
      file: 'notify-shared.js',
      overlapStatusProbe: async () => 'ambiguous',
    });
    expect(res.best?.confidence).toBe('weak');
    expect(res.best?.overlap).toBe('ambiguous');
    expect(res.best?.reason).toContain('claimed by concurrent checkpoints (ambiguous)');
  });

  it('reports own_claim_pending as provisional (weak, overlap set)', async () => {
    const res = await resolveWhyFile({
      repo: dummyRepo,
      store: fakeStore([candidate]),
      file: 'notify-shared.js',
      overlapStatusProbe: async () => 'own_claim_pending',
    });
    expect(res.best?.confidence).toBe('weak');
    expect(res.best?.overlap).toBe('own_claim_pending');
    expect(res.best?.reason).toContain('own-claim pending');
  });

  it('leaves a clean file un-annotated (no overlap field, plain reason)', async () => {
    const res = await resolveWhyFile({
      repo: dummyRepo,
      store: fakeStore([candidate]),
      file: 'notify-shared.js',
      overlapStatusProbe: async () => null,
    });
    expect(res.best?.overlap).toBeUndefined();
    expect(res.best?.reason).toBe(PLAIN_REASON);
  });

  it('probes each candidate by (artifact_id, n) — multi-artifact safe', async () => {
    const c2 = { ...candidate, artifact_id: 'a-2', n: 1 };
    const seen: Array<[string, number]> = [];
    const res = await resolveWhyFile({
      repo: dummyRepo,
      store: fakeStore([candidate, c2]),
      file: 'notify-shared.js',
      overlapStatusProbe: async (aid, n) => {
        seen.push([aid, n]);
        return aid === 'a-1' ? 'ambiguous' : null;
      },
    });
    expect(seen).toEqual([
      ['a-1', 2],
      ['a-2', 1],
    ]);
    expect(res.all.find((m) => m.artifact_id === 'a-1')?.overlap).toBe('ambiguous');
    expect(res.all.find((m) => m.artifact_id === 'a-2')?.overlap).toBeUndefined();
  });
});
