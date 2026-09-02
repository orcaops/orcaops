import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore, type Config, getDefaultConfig } from '@orcaops/storage';
import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { buildRepoState } from './builder.js';
import { Repo } from '../git/repo.js';

async function commitFile(
  repoPath: string,
  file: string,
  content: string,
  msg: string
): Promise<string> {
  const full = path.join(repoPath, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  const git = gitClient(repoPath);
  await git.add(file);
  await git.commit(msg);
  return (await git.revparse(['HEAD'])).trim();
}

/**
 * Add a `.gitignore` entry for `.orcaops/` so the artifact store's
 * write side-effects don't dirty the working tree under test.
 */
async function planGitignore(repoPath: string): Promise<void> {
  await writeFile(path.join(repoPath, '.gitignore'), '.orcaops/\n', 'utf8');
  const git = gitClient(repoPath);
  await git.add('.gitignore');
  await git.commit('add .gitignore');
}

describe('buildRepoState', () => {
  let tmpRepo: TempRepo;
  let config: Config;
  let store: ArtifactStore;
  let repo: Repo;

  const artifactId = '01999999-9999-7000-8000-000000000001';

  beforeEach(async () => {
    tmpRepo = await createTempRepo({ initialBranch: 'main' });
    await planGitignore(tmpRepo.path);
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: tmpRepo.path, config });
    repo = new Repo(tmpRepo.path);
  });

  afterEach(async () => {
    store.close();
    await tmpRepo.cleanup();
  });

  async function seedPlan(baseSha: string): Promise<void> {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'main',
      base_sha: baseSha,
      agent: 'claude-code',
      agent_session_id: null,
      task: 'do thing',
      label: 'lbl',
      // 5-step plan so seedCheckpoint(n) can declare [n] for n up to 5.
      plan_steps: [
        { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 's2', label: 'step-2', acceptance_criteria: [] },
        { step_id: 'step-3', text: 's3', label: 'step-3', acceptance_criteria: [] },
        { step_id: 'step-4', text: 's4', label: 'step-4', acceptance_criteria: [] },
        { step_id: 'step-5', text: 's5', label: 'step-5', acceptance_criteria: [] },
      ],
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
  }

  async function seedCheckpoint(n: number, headSha: string, files: string[]): Promise<void> {
    const stepId = `step-${n}`;
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [stepId] },
      { idempotencyKey: `cp-open-${n}`, headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n,
        summary: `cp ${n}`,
        files_changed: files,
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [stepId],
        head_sha: headSha,
      },
      { idempotencyKey: `cp-close-${n}` }
    );
  }

  it('returns null for an artifact with no plan', async () => {
    const out = await buildRepoState({ store, repo, artifactId: 'no-such' });
    expect(out).toBeNull();
  });

  it('artifact_head_sha = plan.base_sha when there are no checkpoints or summary', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    const state = await buildRepoState({ store, repo, artifactId });
    expect(state).not.toBeNull();
    if (!state) return;
    expect(state.artifact_head_sha).toBe(initialSha);
    expect(state.head_matches_artifact).toBe(true);
    expect(state.commits_since_artifact_head_touching_artifact_files).toEqual([]);
    expect(state.open_items_addressed_since).toEqual([]);
  });

  it('artifact_head_sha = last checkpoint head when checkpoints exist', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await seedCheckpoint(1, 'aaaa1111', ['src/a.ts']);
    await seedCheckpoint(2, 'bbbb2222', ['src/a.ts']);
    const state = await buildRepoState({ store, repo, artifactId });
    expect(state?.artifact_head_sha).toBe('bbbb2222');
  });

  it('artifact_head_sha = summary.head_sha when summarized', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await seedCheckpoint(1, 'aaaa1111', ['src/a.ts']);
    await store.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'shipped',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'cccc3333',
      ts: '2026-04-25T14:00:00.000Z',
    });
    const state = await buildRepoState({ store, repo, artifactId });
    expect(state?.artifact_head_sha).toBe('cccc3333');
  });

  it('working_tree_dirty=false for clean tree', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    const state = await buildRepoState({ store, repo, artifactId });
    expect(state?.working_tree_dirty).toBe(false);
    expect(state?.working_tree_status).toBe('');
  });

  it('working_tree_dirty=true with status output when working tree is dirty', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await writeFile(path.join(tmpRepo.path, 'untracked.ts'), 'x\n', 'utf8');
    const state = await buildRepoState({ store, repo, artifactId });
    expect(state?.working_tree_dirty).toBe(true);
    expect(state?.working_tree_status).toMatch(/\?\?\s+untracked\.ts/);
  });

  it('caps working_tree_status at the configured line count', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(tmpRepo.path, `f${i}.ts`), 'x\n', 'utf8');
    }
    const state = await buildRepoState({
      store,
      repo,
      artifactId,
      workingTreeStatusMaxLines: 3,
    });
    const lines = state?.working_tree_status.split('\n') ?? [];
    expect(lines.length).toBe(4); // 3 capped + the "… (+N more)" trailer
    expect(lines[3]).toMatch(/\+\d+ more lines/);
  });

  it('lists in-range commits that touch the artifact files', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await commitFile(tmpRepo.path, 'src/a.ts', 'orig\n', 'add a');
    const cpSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await seedCheckpoint(1, cpSha, ['src/a.ts']);

    // Two more commits past the checkpoint head.
    await commitFile(tmpRepo.path, 'src/a.ts', 'changed\n', 'modify a');
    await commitFile(tmpRepo.path, 'unrelated.ts', 'u\n', 'add unrelated');

    const state = await buildRepoState({ store, repo, artifactId });
    const commits = state?.commits_since_artifact_head_touching_artifact_files ?? [];
    // Only the modify-a commit touches src/a.ts; the unrelated commit drops out.
    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe('modify a');
    expect(commits[0].files).toEqual(['src/a.ts']);
  });

  it('returns no in-range commits when artifact has no files (no checkpoints)', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await commitFile(tmpRepo.path, 'src/a.ts', 'one\n', 'add');
    const state = await buildRepoState({ store, repo, artifactId });
    expect(state?.commits_since_artifact_head_touching_artifact_files).toEqual([]);
  });

  it('open_items get file_changed evidence when artifact files were modified since head', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await commitFile(tmpRepo.path, 'src/a.ts', 'one\n', 'add a');
    const cpSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await seedCheckpoint(1, cpSha, ['src/a.ts']);
    await store.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'shipped',
      tests_written: [],
      tests_run: [],
      open_items: ['Wire up retries', 'Document edge cases'],
      deferred_decisions: [],
      head_sha: cpSha,
      ts: '2026-04-25T14:00:00.000Z',
    });
    // Post-summary commit modifies the artifact's file.
    await commitFile(tmpRepo.path, 'src/a.ts', 'two\n', 'follow-up tweak');
    const state = await buildRepoState({ store, repo, artifactId });
    const ev = state?.open_items_addressed_since ?? [];
    expect(ev).toHaveLength(2);
    expect(ev[0].evidence.kind).toBe('file_changed');
    if (ev[0].evidence.kind === 'file_changed') {
      expect(ev[0].evidence.files).toEqual(['src/a.ts']);
    }
  });

  it('open_items get later_artifact evidence when a later artifact references the same file', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await commitFile(tmpRepo.path, 'src/a.ts', 'one\n', 'add a');
    const cpSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await seedCheckpoint(1, cpSha, ['src/a.ts']);
    await store.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'shipped',
      tests_written: [],
      tests_run: [],
      open_items: ['retries'],
      deferred_decisions: [],
      head_sha: cpSha,
      ts: '2026-04-25T14:00:00.000Z',
    });

    // Plant a second, later artifact on the same branch with overlapping files.
    const laterId = '01999999-9999-7000-8000-000000000002';
    await store.writePlan({
      schema_version: 4,
      artifact_id: laterId,
      branch: 'main',
      base_sha: cpSha,
      agent: 'claude-code',
      agent_session_id: null,
      task: 'follow-up',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T15:00:00.000Z',
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
      { artifact_id: laterId, declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-2', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: laterId,
        n: 1,
        summary: 'cp',
        files_changed: ['src/a.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: cpSha,
      },
      { idempotencyKey: 'cp-close-2' }
    );

    // No commits in range — head is unchanged, so file_changed is empty;
    // later_artifact evidence should win.
    const state = await buildRepoState({ store, repo, artifactId });
    const ev = state?.open_items_addressed_since ?? [];
    expect(ev).toHaveLength(1);
    if (ev[0].evidence.kind !== 'later_artifact') {
      throw new Error(`expected later_artifact evidence, got ${ev[0].evidence.kind}`);
    }
    expect(ev[0].evidence.artifact_id).toBe(laterId);
    expect(ev[0].evidence.files).toEqual(['src/a.ts']);
  });

  it('skips a sibling with a rotted event log instead of failing the build', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await commitFile(tmpRepo.path, 'src/a.ts', 'one\n', 'add a');
    const cpSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await seedCheckpoint(1, cpSha, ['src/a.ts']);
    await store.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'shipped',
      tests_written: [],
      tests_run: [],
      open_items: ['retries'],
      deferred_decisions: [],
      head_sha: cpSha,
      ts: '2026-04-25T14:00:00.000Z',
    });

    const laterId = '01999999-9999-7000-8000-000000000003';
    await store.writePlan({
      schema_version: 4,
      artifact_id: laterId,
      branch: 'main',
      base_sha: cpSha,
      agent: 'claude-code',
      agent_session_id: null,
      task: 'follow-up',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T15:00:00.000Z',
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
      { artifact_id: laterId, declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-3', headSha: 'cafef00d' }
    );

    // Rot the sibling: zero a checksum and delete its projection so any
    // recovery-aware read of it refuses. The build must skip it, not fail.
    const siblingLog = path.join(tmpRepo.path, '.orcaops', 'artifacts', laterId, 'events.ndjson');
    const raw = await readFile(siblingLog, 'utf8');
    await writeFile(
      siblingLog,
      raw.replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`),
      'utf8'
    );
    await rm(path.join(tmpRepo.path, '.orcaops', 'artifacts', laterId, 'checkpoint-1.json'), {
      force: true,
    });

    const state = await buildRepoState({ store, repo, artifactId });
    expect(state).not.toBeNull();
    // The rotted sibling contributed no evidence — it was skipped, and the
    // build itself survived it.
    expect(state?.open_items_addressed_since ?? []).toHaveLength(0);
  });

  it('open_items_addressed_since is empty when artifact has no files', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await store.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'shipped',
      tests_written: [],
      tests_run: [],
      open_items: ['something'],
      deferred_decisions: [],
      head_sha: initialSha,
      ts: '2026-04-25T14:00:00.000Z',
    });
    const state = await buildRepoState({ store, repo, artifactId });
    expect(state?.open_items_addressed_since).toEqual([]);
  });

  it('does not surface evidence for an artifact with no open_items', async () => {
    const initialSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await commitFile(tmpRepo.path, 'src/a.ts', 'one\n', 'add a');
    const cpSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
    await seedPlan(initialSha);
    await seedCheckpoint(1, cpSha, ['src/a.ts']);
    // Summary with empty open_items.
    await store.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'shipped',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: cpSha,
      ts: '2026-04-25T14:00:00.000Z',
    });
    await commitFile(tmpRepo.path, 'src/a.ts', 'two\n', 'follow-up');
    const state = await buildRepoState({ store, repo, artifactId });
    expect(state?.open_items_addressed_since).toEqual([]);
  });
});
