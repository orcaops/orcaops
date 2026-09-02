import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { artifactPathsFor, ArtifactStore, readEventLog, uuidv7 } from '@orcaops/storage';
import {
  createHistoryRepo,
  gitClient,
  type HistoryOperation,
  type HistoryRepo,
} from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const execFileAsync = promisify(execFile);

/** gitClient has no `.env()`, and commit dates only travel as environment. */
async function datedGit(
  cwd: string,
  args: string[],
  authorDate: string,
  committerDate: string = authorDate
): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: committerDate },
  });
}

const datedCommit = (
  cwd: string,
  message: string,
  authorDate: string,
  committerDate: string
): Promise<void> => datedGit(cwd, ['commit', '-m', message], authorDate, committerDate);

describe('orcaops seed', () => {
  let repo: HistoryRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish the service',
        files: { 'src/service.ts': 'export const service = true;\n' },
      },
      {
        type: 'commit',
        label: 'next',
        subject: 'fix: stabilize the service',
        files: { 'src/health.ts': 'export const healthy = true;\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await repo.cleanup();
  });

  it('suggests the agent workflow after init with a raw-command fallback', async () => {
    const git = gitClient(repo.path);
    for (let index = 0; index < 18; index++) {
      await writeFile(path.join(repo.path, 'history.txt'), `${index}\n`);
      await git.add('history.txt');
      await git.commit(`chore: history ${index}`);
    }

    const result = await agent.runRaw(['init', '--force', '--yes', '--no-llm']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Ask your agent to seed orcaops from git history.');
    expect(result.stdout).toContain(
      'No agent available? Preview the local fallback with `orcaops seed --dry-run`.'
    );
    expect(result.stdout.indexOf('orcaops seed --dry-run')).toBeLessThan(
      result.stdout.indexOf('Next:')
    );
  });

  it('discloses an open checkpoint during preview and refuses to apply', async () => {
    const plan = await agent.capturePlan(
      {
        task: 'Continue live checkout work',
        label: 'Live checkout work',
        plan_steps: [{ text: 'Finish the active change', label: 'active change' }],
        touched_scope: ['src/**'],
      },
      { noLlm: true }
    );
    const stepId = plan.plan_steps[0]!.step_id;
    await agent.captureCheckpointOpen(
      { artifact_id: plan.artifact_id, declared_step_ids: [stepId] },
      { noLlm: true }
    );

    const previewResult = await agent.runRaw(['seed', '--dry-run', '--json']);
    expect(previewResult.exitCode).toBe(0);
    expect(JSON.parse(previewResult.stdout)).toMatchObject({
      open_checkpoint_guard: {
        blocked: true,
        open_checkpoints: [
          {
            artifact_id: plan.artifact_id,
            artifact_label: 'Live checkout work',
            checkpoint_n: 1,
          },
        ],
        message: expect.stringMatching(/close or abandon it first/i),
      },
    });

    const applyResult = await agent.runRaw(['seed', '--yes', '--json']);
    expect(applyResult.exitCode).toBe(1);
    expect(JSON.parse(applyResult.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'SEED_OPEN_CHECKPOINT',
        message: expect.stringMatching(/Live checkout work.*close or abandon it first/i),
      },
    });
  });

  it('recovers an interrupted seed run rather than refusing over its own checkpoint', async () => {
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    const artifactId = uuidv7();
    const stepId = uuidv7();
    const ts = '2025-06-01T00:00:00.000Z';
    const plan = await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'origin/main',
      base_sha: repo.shas.root!,
      agent: 'other',
      agent_session_id: null,
      task: 'Interrupted import',
      label: 'Interrupted import',
      plan_steps: [
        {
          step_id: stepId,
          text: 'Land the commit',
          label: 'Land the commit',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      origin: {
        kind: 'git-import',
        imported_at: ts,
        tool_version: 'test',
        source_range: `${repo.shas.root}..${repo.shas.next}`,
        authors: ['test@orcaops.local'],
        enriched_at: null,
      },
      started_at: ts,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    });
    await store.writeCheckpointOpened(
      {
        artifact_id: artifactId,
        declared_step_ids: [stepId],
        policy_exceptions: [],
        plan_revision_id: plan.event_id,
      },
      {
        headSha: repo.shas.root!,
        openedAt: ts,
        idempotencyKey: `${artifactId}:open:1`,
        invokedByAgent: 'other',
      }
    );
    store.close();

    const preview = JSON.parse((await agent.runRaw(['seed', '--dry-run', '--json'])).stdout);
    expect(preview).toMatchObject({
      open_checkpoint_guard: {
        blocked: false,
        message: null,
        stranded: [{ artifact_id: artifactId, checkpoint_n: 1, seed_owned: true }],
        recovery_message: expect.stringMatching(/recovering an interrupted seed run/i),
      },
    });

    const applied = await agent.runRaw(['seed', '--yes', '--json']);
    expect(applied.exitCode).toBe(0);
    const result = JSON.parse(applied.stdout);
    expect(result).toMatchObject({ mode: 'applied', recovery: { resumed: 0, abandoned: 1 } });
    expect(result.totals.created).toBeGreaterThan(0);
    expect(result.notes.join('\n')).toMatch(/recovering an interrupted seed run/i);

    const reopened = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      expect(await reopened.readCheckpoints(artifactId)).toMatchObject([{ status: 'abandoned' }]);
    } finally {
      reopened.close();
    }
  });

  it('materializes archive-held imports into a linked worktree', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-seed-worktree-data-'));
    const env = { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataRoot };
    const enableArchive = async (root: string): Promise<void> => {
      const configPath = path.join(root, '.orcaops', 'config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.archive = { enabled: true, redact_secrets: false };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    };

    const agentA = makeAgent({ cwd: repo.path, env });
    await agentA.runRaw(['init', '--force', '--yes', '--json', '--no-llm']);
    await enableArchive(repo.path);
    const seeded = JSON.parse((await agentA.runRaw(['seed', '--yes', '--json'])).stdout);
    expect(seeded.totals.created).toBeGreaterThan(0);

    const worktreePath = path.join(
      await mkdtemp(path.join(tmpdir(), 'orcaops-seed-worktree-')),
      'linked'
    );
    await gitClient(repo.path).raw(['worktree', 'add', '-b', 'linked', worktreePath]);
    const agentB = makeAgent({ cwd: worktreePath, env });
    await agentB.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    await enableArchive(worktreePath);

    // Before the fix this reported covered-N beside an empty store.
    expect(JSON.parse((await agentB.runRaw(['seed', 'status', '--json'])).stdout)).toMatchObject({
      imported_artifacts: 0,
    });

    const applied = JSON.parse((await agentB.runRaw(['seed', '--yes', '--json'])).stdout);
    expect(applied.restored_from_archive).toBe(seeded.totals.created);
    expect(applied.totals.created).toBe(0);
    expect(applied.notes.join('\n')).toMatch(/Restored \d+ artifacts? from the shared project/i);

    expect(JSON.parse((await agentB.runRaw(['seed', 'status', '--json'])).stdout)).toMatchObject({
      imported_artifacts: seeded.totals.created,
    });
    const listed = await agentB.runRaw(['list', '--imported']);
    expect(listed.stdout).not.toContain('No artifacts captured.');
    expect(listed.stdout).toContain('[imported]');
  });

  it('refuses to call an interrupted store complete or fresh', async () => {
    expect((await agent.runRaw(['seed', '--yes', '--json'])).exitCode).toBe(0);
    const journalPath = path.join(repo.path, '.orcaops', 'cache', 'seed', 'journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    const [firstCluster] = Object.keys(journal.clusters);
    journal.clusters[firstCluster!].status = 'writing';
    await writeFile(journalPath, JSON.stringify(journal, null, 2));

    const status = JSON.parse((await agent.runRaw(['seed', 'status', '--json'])).stdout);
    expect(status).toMatchObject({
      state: 'partial',
      coverage_interrupted: true,
      coverage_stale: true,
    });
    const human = (await agent.runRaw(['seed', 'status'])).stdout;
    expect(human).toContain('Coverage (interrupted run — rerun `orcaops seed --yes` to finish):');
    expect(human).not.toContain('Coverage (complete)');
  });

  it('covers every seed cluster spanned by a live checkpoint commit range', async () => {
    await repo.cleanup();
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish the baseline',
        committerDate: '2025-01-01T00:00:00.000Z',
        files: { 'src/baseline.ts': 'export const baseline = true;\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

    const plan = await agent.capturePlan(
      {
        task: 'Capture a multi-session live change',
        label: 'Multi-session live change',
        plan_steps: [{ text: 'Land both sessions', label: 'land sessions' }],
        touched_scope: ['src/**'],
      },
      { noLlm: true }
    );
    const stepId = plan.plan_steps[0]!.step_id;
    const open = await agent.captureCheckpointOpen(
      { artifact_id: plan.artifact_id, declared_step_ids: [stepId] },
      { noLlm: true }
    );
    expect(open.ok).toBe(true);
    if (!open.ok) return;

    const git = gitClient(repo.path);
    await writeFile(path.join(repo.path, 'src/first.ts'), 'export const first = true;\n');
    await git.add('src/first.ts');
    await datedCommit(
      repo.path,
      'feat: land the first session',
      '2025-01-02T00:00:00.000Z',
      '2025-01-02T00:00:00.000Z'
    );
    await writeFile(path.join(repo.path, 'src/second.ts'), 'export const second = true;\n');
    await git.add('src/second.ts');
    await datedCommit(
      repo.path,
      'feat: land the second session',
      '2025-01-02T04:00:00.000Z',
      '2025-01-02T04:00:00.000Z'
    );

    const close = await agent.captureCheckpointClose(
      {
        artifact_id: plan.artifact_id,
        n: open.n,
        summary: 'Landed both sessions',
        files_changed: ['src/first.ts', 'src/second.ts'],
        verification: [{ command: 'test fixture', exit_code: 0 }],
        completed_step_ids: [stepId],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
      },
      { noLlm: true }
    );
    expect(close.ok).toBe(true);

    const applied = await agent.runRaw([
      'seed',
      '--since',
      '2025-01-01T00:00:00.000Z',
      '--max-commits',
      '3',
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      totals: { selected: 3, created: 1, covered: 2, failed: 0 },
    });
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    expect(
      store.store.listArtifacts().filter((row) => row.origin_kind === 'git-import')
    ).toHaveLength(1);
    store.close();
  });

  it('imports history untouched by a checkpoint that was rebased between open and close', async () => {
    await repo.cleanup();
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish the baseline',
        committerDate: '2025-01-01T00:00:00.000Z',
        files: { 'src/baseline.ts': 'export const baseline = true;\n' },
      },
      { type: 'branch', name: 'feature', from: 'root' },
      {
        type: 'commit',
        label: 'legacy',
        subject: 'feat: ship the legacy pipeline',
        committerDate: '2025-01-02T00:00:00.000Z',
        files: { 'src/legacy.ts': 'export const legacy = true;\n' },
      },
      { type: 'checkout', branch: 'feature' },
      {
        type: 'commit',
        label: 'session',
        subject: 'feat: land the live session',
        committerDate: '2025-01-03T00:00:00.000Z',
        files: { 'src/session.ts': 'export const session = true;\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

    const plan = await agent.capturePlan(
      {
        task: 'Rebase a live change mid-checkpoint',
        label: 'Rebased live change',
        plan_steps: [{ text: 'Land the session', label: 'land session' }],
        touched_scope: ['src/**'],
      },
      { noLlm: true }
    );
    const stepId = plan.plan_steps[0]!.step_id;
    const open = await agent.captureCheckpointOpen(
      { artifact_id: plan.artifact_id, declared_step_ids: [stepId] },
      { noLlm: true }
    );
    expect(open.ok).toBe(true);
    if (!open.ok) return;

    await datedGit(repo.path, ['rebase', 'main'], '2025-01-03T00:00:00.000Z');

    const close = await agent.captureCheckpointClose(
      {
        artifact_id: plan.artifact_id,
        n: open.n,
        summary: 'Landed the session on top of main',
        files_changed: ['src/session.ts'],
        verification: [{ command: 'test fixture', exit_code: 0 }],
        completed_step_ids: [stepId],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
      },
      { noLlm: true }
    );
    expect(close.ok).toBe(true);

    // The rebased close head no longer descends from the open head; the
    // covered range must collapse to the close head alone, so the legacy
    // cluster the checkpoint never touched still imports.
    const applied = await agent.runRaw([
      'seed',
      '--branch',
      'feature',
      '--since',
      '2025-01-01T00:00:00.000Z',
      '--max-commits',
      '3',
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      totals: { selected: 3, created: 2, covered: 1, failed: 0 },
    });
  });

  it('imports history when a checkpoint open head is no longer in the repository', async () => {
    await repo.cleanup();
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish the baseline',
        committerDate: '2025-01-01T00:00:00.000Z',
        files: { 'src/baseline.ts': 'export const baseline = true;\n' },
      },
      {
        type: 'commit',
        label: 'legacy',
        subject: 'feat: ship the legacy pipeline',
        committerDate: '2025-01-02T00:00:00.000Z',
        files: { 'src/legacy.ts': 'export const legacy = true;\n' },
      },
      { type: 'branch', name: 'feature', from: 'root' },
      { type: 'checkout', branch: 'feature' },
      {
        type: 'commit',
        label: 'stray',
        subject: 'feat: start a stray attempt',
        committerDate: '2025-01-03T00:00:00.000Z',
        files: { 'src/stray.ts': 'export const stray = true;\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

    const plan = await agent.capturePlan(
      {
        task: 'Abandon a stray attempt for main',
        label: 'Stray attempt moved to main',
        plan_steps: [{ text: 'Land the work on main', label: 'land on main' }],
        touched_scope: ['src/**'],
      },
      { noLlm: true }
    );
    const stepId = plan.plan_steps[0]!.step_id;
    const open = await agent.captureCheckpointOpen(
      { artifact_id: plan.artifact_id, declared_step_ids: [stepId] },
      { noLlm: true }
    );
    expect(open.ok).toBe(true);
    if (!open.ok) return;

    const git = gitClient(repo.path);
    await git.checkout('main');
    await writeFile(path.join(repo.path, 'src/work.ts'), 'export const work = true;\n');
    await git.add('src/work.ts');
    await datedCommit(
      repo.path,
      'feat: land the work on main',
      '2025-01-04T00:00:00.000Z',
      '2025-01-04T00:00:00.000Z'
    );

    const close = await agent.captureCheckpointClose(
      {
        artifact_id: plan.artifact_id,
        n: open.n,
        summary: 'Landed the work on main instead',
        files_changed: ['src/work.ts'],
        verification: [{ command: 'test fixture', exit_code: 0 }],
        completed_step_ids: [stepId],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
      },
      { noLlm: true }
    );
    expect(close.ok).toBe(true);

    const straySha = repo.shas.stray!;
    await git.raw(['branch', '-D', 'feature']);
    await git.raw(['reflog', 'expire', '--expire=now', '--all']);
    // `gc`, not `prune`: this repository's objects are packed, and `prune` only
    // evicts LOOSE ones — so the stray commit survived and the assertion below
    // was failing on its own precondition rather than on the behaviour under test.
    await git.raw(['gc', '--prune=now', '--quiet']);
    // `cat-file -t`, not `-e`: `-e` signals absence through a silent exit
    // code, which simple-git resolves instead of rejecting.
    await expect(git.raw(['cat-file', '-t', straySha])).rejects.toThrow();

    // The recorded open head no longer resolves; coverage must fall back
    // to the close head alone instead of aborting or widening, so the
    // untouched baseline and legacy clusters still import.
    const applied = await agent.runRaw([
      'seed',
      '--since',
      '2025-01-01T00:00:00.000Z',
      '--max-commits',
      '3',
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      totals: { selected: 3, created: 2, covered: 1, failed: 0 },
    });
  });

  it('doctor distinguishes never-run and partial history, then resumes with --fix', async () => {
    const neverRun = JSON.parse((await agent.runRaw(['doctor', '--json'])).stdout) as {
      checks: Array<{ name: string; status: string; summary: string }>;
    };
    expect(neverRun.checks.find((check) => check.name === 'seed')).toMatchObject({
      status: 'warn',
      summary: 'git history exists but Orcaops has never been seeded',
    });

    // A preview writes no journal state, so doctor keeps reporting
    // never-seeded rather than flipping to partial.
    await agent.runRaw(['seed', '--dry-run', '--json']);
    const afterPreview = JSON.parse((await agent.runRaw(['doctor', '--json'])).stdout) as {
      checks: Array<{ name: string; status: string; summary: string }>;
    };
    expect(afterPreview.checks.find((check) => check.name === 'seed')).toMatchObject({
      status: 'warn',
      summary: 'git history exists but Orcaops has never been seeded',
    });

    const fixed = JSON.parse((await agent.runRaw(['doctor', '--fix', '--json'])).stdout) as {
      checks: Array<{ name: string; status: string; summary: string }>;
    };
    expect(fixed.checks.find((check) => check.name === 'seed')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('1 imported artifact'),
    });
    expect(fixed.checks.find((check) => check.name === 'fix')?.summary).toContain(
      'resumed `orcaops seed --yes`'
    );
  });

  it('previews without artifacts, then writes summarized imports and reruns as a no-op', async () => {
    const previewResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--dry-run',
      '--json',
    ]);
    expect(previewResult.exitCode).toBe(0);
    const preview = JSON.parse(previewResult.stdout) as {
      mode: string;
      branch: { ref: string; source: string };
      totals: { pending: number };
    };
    expect(preview).toMatchObject({
      mode: 'dry-run',
      branch: { ref: 'main', source: 'main' },
      totals: { pending: 1 },
    });

    const config = await loadConfig(repo.path);
    let store = new ArtifactStore({ repoRoot: repo.path, config });
    expect(store.store.listArtifacts()).toHaveLength(0);
    store.close();

    const appliedResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(appliedResult.exitCode).toBe(0);
    const applied = JSON.parse(appliedResult.stdout) as {
      mode: string;
      seeded: Array<{ artifactId: string; outcome: string }>;
      totals: { created: number; failed: number };
    };
    expect(applied).toMatchObject({
      mode: 'applied',
      totals: { created: 1, failed: 0 },
    });
    const artifactId = applied.seeded[0]!.artifactId;

    store = new ArtifactStore({ repoRoot: repo.path, config });
    expect(await store.readArtifact(artifactId)).toMatchObject({
      origin: {
        kind: 'git-import',
        job: { job_id: expect.stringMatching(/^[0-9a-f-]{36}$/u), kind: 'initial' },
      },
    });
    expect(await store.readSummary(artifactId)).not.toBeNull();
    expect(store.store.listLifecycles(artifactId)).toEqual([]);
    const paths = artifactPathsFor(repo.path, config, artifactId);
    const before = await readEventLog({
      eventLogPath: paths.eventsNdjson,
      sidecarsDir: paths.sidecarsDir,
    });
    store.close();

    const rerunResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(rerunResult.exitCode).toBe(0);
    expect(JSON.parse(rerunResult.stdout)).toMatchObject({
      totals: { created: 0, resumed: 0, covered: 1, failed: 0 },
    });
    const after = await readEventLog({
      eventLogPath: paths.eventsNdjson,
      sidecarsDir: paths.sidecarsDir,
    });
    expect(after.events).toHaveLength(before.events.length);

    await gitClient(repo.path).checkoutLocalBranch('current-work');
    const livePlan = await agent.capturePlan(
      {
        task: 'Continue normal captured work',
        label: 'Normal captured work',
        plan_steps: [{ text: 'Finish the live change', label: 'live change' }],
        touched_scope: ['src/**'],
      },
      { noLlm: true }
    );

    const bareList = JSON.parse((await agent.runRaw(['list', '--json'])).stdout) as {
      artifacts: Array<{ id: string; origin: string | null }>;
      imported_artifacts: { count: number; hint: string };
    };
    expect(bareList.artifacts).toEqual([
      expect.objectContaining({ id: livePlan.artifact_id, origin: null }),
    ]);
    expect(bareList.imported_artifacts).toEqual({
      count: 1,
      hint: 'orcaops list --imported',
    });
    const importedList = JSON.parse(
      (await agent.runRaw(['list', '--imported', '--json'])).stdout
    ) as { artifacts: Array<{ id: string; origin: string | null }> };
    expect(importedList.artifacts).toEqual([
      expect.objectContaining({ id: artifactId, origin: 'git-import' }),
    ]);
    const importedTable = (await agent.runRaw(['list', '--imported'])).stdout;
    const importedRows = importedTable
      .split('\n')
      .filter((tableLine) => tableLine.includes('[imported]'));
    expect(importedRows).toHaveLength(1);
    expect(importedRows[0]).toContain('Imported from git history:');
    expect(importedTable).not.toMatch(/^\s*- [0-9a-f]{7} /mu);

    const status = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as {
      artifacts: Array<{ id: string }>;
      imported_artifacts: { count: number };
    };
    expect(status.artifacts).toEqual([expect.objectContaining({ id: livePlan.artifact_id })]);
    expect(status.imported_artifacts.count).toBe(1);

    store = new ArtifactStore({ repoRoot: repo.path, config });
    for (const rankedArtifactId of [livePlan.artifact_id, artifactId]) {
      store.store.replaceSearchEntry({
        artifact_id: rankedArtifactId,
        source: 'digest',
        branch: 'main',
        ts: '2025-01-01T00:00:00.000Z',
        content: 'equivalent ranking containmentneedle',
      });
    }
    store.close();

    const rankedSearch = JSON.parse(
      (await agent.runRaw(['search', 'containmentneedle', '--json'])).stdout
    ) as { results: Array<{ artifact_id: string; origin: string | null }> };
    expect(rankedSearch.results.map((result) => [result.artifact_id, result.origin])).toEqual([
      [livePlan.artifact_id, null],
      [artifactId, 'git-import'],
    ]);

    await gitClient(repo.path).checkout('main');

    const search = JSON.parse((await agent.runRaw(['search', 'service', '--json'])).stdout) as {
      results: Array<{ artifact_id: string; origin: string | null }>;
    };
    expect(search.results).toContainEqual(
      expect.objectContaining({ artifact_id: artifactId, origin: 'git-import' })
    );
    expect(
      JSON.parse((await agent.runRaw(['search', 'service', '--no-imported', '--json'])).stdout)
    ).toMatchObject({ count: 0, results: [] });
    expect((await agent.runRaw(['search', 'service'])).stdout).toContain('[imported]');

    const why = JSON.parse((await agent.runRaw(['why', 'src/health.ts:1', '--json'])).stdout) as {
      best: { artifact_id: string; origin?: { kind: string } } | null;
    };
    expect(why.best).toMatchObject({
      artifact_id: artifactId,
      origin: { kind: 'git-import' },
    });
    const whyText = (await agent.runRaw(['why', 'src/health.ts:1'])).stdout;
    expect(whyText).toContain('origin:     imported from git history (synthesized)');
    expect(whyText).toMatch(/task: {7}Imported from git history: .+ … \(2 commits\)/u);
    expect(whyText).not.toMatch(/^\s*- [0-9a-f]{7} /mu);

    const between = JSON.parse(
      (await agent.runRaw(['list', '--between', `${repo.shas.root}..${repo.shas.next}`, '--json']))
        .stdout
    ) as { matched: Array<{ id: string; origin: string | null }> };
    expect(between.matched).toContainEqual(
      expect.objectContaining({ id: artifactId, origin: 'git-import' })
    );
    expect((await agent.runRaw(['show', artifactId])).stdout).toContain(
      'Origin: imported from git history (synthesized)'
    );
    const digest = JSON.parse(
      (await agent.runRaw(['digest', '--artifact', artifactId, '--json'])).stdout
    ) as { data: { origin: { kind: string } }; markdown: string };
    expect(digest.data.origin.kind).toBe('git-import');
    expect(digest.markdown).toContain(
      'Imported from git history (synthesized, not captured reasoning)'
    );
    // Section tags must agree with the banner: synthesized content is
    // never presented as "(captured)".
    expect(digest.markdown).not.toContain('_(captured)_');
    expect(digest.markdown).toContain('## why  _(imported)_');

    await writeFile(path.join(repo.path, 'uncovered.ts'), 'export const uncovered = true;\n');
    const git = gitClient(repo.path);
    await git.add('uncovered.ts');
    await git.commit('feat: add uncovered work');
    const uncoveredSha = (await git.revparse(['HEAD'])).trim();
    const uncovered = JSON.parse(
      (await agent.runRaw(['why', 'uncovered.ts:1', '--json'])).stdout
    ) as { best: null; hint: string };
    expect(uncovered.best).toBeNull();
    expect(uncovered.hint).toContain(
      `orcaops seed --commit ${uncoveredSha}\` will import its cluster`
    );

    // A declined area swaps the import call-to-action for the decline state.
    await writeFile(path.join(repo.path, 'src', 'later.ts'), 'export const later = true;\n');
    await git.add('src/later.ts');
    await git.commit('feat: add later work');
    await agent.runRaw(['seed', 'status', '--decline', 'src', '--json']);
    const declinedWhy = JSON.parse(
      (await agent.runRaw(['why', 'src/later.ts:1', '--json'])).stdout
    ) as { best: null; hint: string };
    expect(declinedWhy.hint).toContain('imports for src were declined');
    expect(declinedWhy.hint).toContain('orcaops seed status --offer-again src');
    expect(declinedWhy.hint).not.toContain('seed --commit');
    const declinedWhyText = (await agent.runRaw(['why', 'src/later.ts:1'])).stdout;
    expect(declinedWhyText).toContain('imports for src were declined');
  });

  it('excludes imported artifacts from cloud drain and capture-health aggregates', async () => {
    const appliedResult = await agent.runRaw(['seed', '--yes', '--json']);
    expect(appliedResult.exitCode).toBe(0);
    const applied = JSON.parse(appliedResult.stdout) as {
      seeded: Array<{ artifactId: string }>;
    };
    const artifactId = applied.seeded[0]!.artifactId;

    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    expect(store.store.findArtifactsForCloudSyncDrain({ force: true }).included).not.toContain(
      artifactId
    );
    expect(store.store.countCloudSyncPendingArtifacts()).toBe(0);
    store.close();

    const stats = JSON.parse((await agent.runRaw(['stats', '--json'])).stdout) as {
      plan_revisions: { artifacts_with_plan: number; histogram: Record<string, number> };
      checkpoint_durations: { closed_total: number; median_ms: number | null };
      hygiene: {
        summaries_without_pre_pr_run: number;
        closed_cp_without_uncertainty: number;
        closed_cp_without_decisions: number;
        closed_cp_without_files_changed: number;
      };
    };
    expect(stats.plan_revisions).toMatchObject({ artifacts_with_plan: 0, histogram: {} });
    expect(stats.checkpoint_durations).toMatchObject({ closed_total: 0, median_ms: null });
    expect(stats.hygiene).toMatchObject({
      summaries_without_pre_pr_run: 0,
      closed_cp_without_uncertainty: 0,
      closed_cp_without_decisions: 0,
      closed_cp_without_files_changed: 0,
    });
    expect((stats as { imported_artifacts?: number }).imported_artifacts).toBe(
      applied.seeded.length
    );
    const statsText = (await agent.runRaw(['stats'])).stdout;
    expect(statsText).toContain(
      `imported:    ${applied.seeded.length} (excluded from duration aggregates)`
    );
  });

  it('prefixes the imported trailer with the empty live state on plain list', async () => {
    const appliedResult = await agent.runRaw(['seed', '--yes', '--json']);
    expect(appliedResult.exitCode).toBe(0);

    const bare = (await agent.runRaw(['list'])).stdout;
    expect(bare).toContain('No live artifacts captured.');
    expect(bare).toMatch(/… and \d+ imported artifact/u);
    expect(bare.indexOf('No live artifacts captured.')).toBeLessThan(
      bare.indexOf('imported artifact')
    );
  });

  it('swaps the apply CTA for a nothing-to-do line when the preview has no pending clusters', async () => {
    const appliedResult = await agent.runRaw(['seed', '--yes', '--json']);
    expect(appliedResult.exitCode).toBe(0);

    const preview = await agent.runRaw(['seed', '--dry-run']);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Pending 0');
    expect(preview.stdout).toContain('Nothing pending to write — no apply needed.');
    expect(preview.stdout).not.toContain('Run `orcaops seed --yes` to write these artifacts.');
  });

  it('refuses an explicit push of an imported artifact before any cloud call', async () => {
    const appliedResult = await agent.runRaw(['seed', '--yes', '--json']);
    expect(appliedResult.exitCode).toBe(0);
    const applied = JSON.parse(appliedResult.stdout) as {
      seeded: Array<{ artifactId: string }>;
    };
    const artifactId = applied.seeded[0]!.artifactId;

    // No credentials exist in this environment: reaching the cloud client
    // would surface NOT_CONNECTED, so the containment code doubles as proof
    // the refusal fired before any client construction.
    const pushed = await agent.runRaw(['push', artifactId, '--json']);
    expect(pushed.exitCode).toBe(1);
    expect(JSON.parse(pushed.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'IMPORTED_ARTIFACT_LOCAL_ONLY',
        message: expect.stringContaining('local-only in this version'),
      },
    });

    const pushedHuman = await agent.runRaw(['push', artifactId]);
    expect(pushedHuman.exitCode).toBe(1);
    expect(pushedHuman.stdout).toContain('IMPORTED_ARTIFACT_LOCAL_ONLY');
  });

  it('fills path ownership and commit gaps and reports cached coverage', async () => {
    await repo.cleanup();
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'backend',
        subject: 'feat: add backend',
        committerDate: '2025-01-01T00:00:00.000Z',
        files: { 'backend/service.ts': 'one\ntwo\nthree\n' },
      },
      {
        type: 'commit',
        label: 'frontend',
        subject: 'feat: add frontend',
        committerDate: '2025-01-01T04:00:00.000Z',
        files: { 'frontend/app.ts': 'four\nfive\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

    const pathResult = await agent.runRaw(['seed', '--path', 'backend', '--yes', '--json']);
    expect(pathResult.exitCode).toBe(0);
    expect(JSON.parse(pathResult.stdout)).toMatchObject({
      totals: { selected: 1, created: 1, failed: 0 },
    });
    const statusResult = await agent.runRaw(['seed', 'status', '--json']);
    expect(statusResult.exitCode).toBe(0);
    // A store built only from targeted jobs never processed the whole
    // history: the state line must not pair an unqualified "complete"
    // with the partial coverage table.
    expect(JSON.parse(statusResult.stdout)).toMatchObject({
      state: 'targeted-only',
      targeted_jobs: 1,
      full_history_run: false,
      imported_artifacts: 1,
      coverage: {
        complete: false,
        directories: {
          backend: { covered_lines: 3, total_lines: 3, percent: 100 },
        },
      },
    });
    const statusHuman = await agent.runRaw(['seed', 'status']);
    expect(statusHuman.stdout).toContain(
      'Seed state: targeted-only (1 path/commit job; no full-history run)'
    );
    expect(statusHuman.stdout).toContain('Coverage (partial):');
    const declined = await agent.runRaw(['seed', 'status', '--decline', './frontend/', '--json']);
    expect(JSON.parse(declined.stdout).declined_discovery_areas).toEqual(['frontend']);

    const commitResult = await agent.runRaw([
      'seed',
      '--commit',
      repo.shas.frontend!,
      '--yes',
      '--json',
    ]);
    expect(commitResult.exitCode).toBe(0);
    const commitPayload = JSON.parse(commitResult.stdout) as { notes: string[] };
    expect(commitPayload).toMatchObject({
      totals: { selected: 1, created: 1, failed: 0 },
    });
    // One surgical cluster is not the user choosing to import the area's
    // history, so the decline it lands in survives untouched.
    expect(commitPayload.notes).not.toContain('cleared decline for frontend');
    const afterCommitStatus = JSON.parse(
      (await agent.runRaw(['seed', 'status', '--json'])).stdout
    ) as { declined_discovery_areas: string[]; coverage_excluded_commit_imports: number };
    expect(afterCommitStatus.declined_discovery_areas).toEqual(['frontend']);
    // The commit lane blames nothing, so the cached report cannot see this
    // import — the exclusion must be disclosed, not silently understated.
    expect(afterCommitStatus.coverage_excluded_commit_imports).toBe(1);
    const afterCommitHuman = await agent.runRaw(['seed', 'status']);
    expect(afterCommitHuman.stdout).toContain(
      'Coverage excludes 1 commit-lane import — rerun a full or --path seed to refresh.'
    );
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    expect(
      store.store.listArtifacts().filter((artifact) => artifact.origin_kind === 'git-import')
    ).toHaveLength(2);
    store.close();

    const secondPath = await agent.runRaw(['seed', '--path', 'frontend', '--yes', '--json']);
    expect(secondPath.exitCode).toBe(0);
    const mergedStatus = JSON.parse((await agent.runRaw(['seed', 'status', '--json'])).stdout) as {
      coverage: { directories: Record<string, { covered_lines: number }> };
      coverage_excluded_commit_imports: number;
    };
    // A second scoped job merges its rows over the prior report instead of
    // replacing it — the earlier backend row must survive.
    expect(mergedStatus.coverage.directories).toMatchObject({
      backend: { covered_lines: 3 },
      frontend: { covered_lines: 2 },
    });
    // The refreshed report post-dates the commit import, so the exclusion
    // disclosure clears.
    expect(mergedStatus.coverage_excluded_commit_imports).toBe(0);
  });

  it('clears a decline only for the area a targeted import aimed at', async () => {
    await repo.cleanup();
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'links',
        subject: 'docs: fix broken links in Style-Guide.md',
        committerDate: '2025-01-01T00:00:00.000Z',
        files: {
          '.github/workflows/ci.yml': 'name: ci\non: push\n',
          'docs/Style-Guide.md': 'one\ntwo\n',
        },
      },
      {
        type: 'commit',
        label: 'guide',
        subject: 'docs: expand the guide',
        committerDate: '2025-01-03T00:00:00.000Z',
        files: { 'docs/guide.md': 'three\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    await agent.runRaw(['seed', 'status', '--decline', 'docs', '--offered', 'docs', '--json']);

    const targeted = await agent.runRaw(['seed', '--path', '.github', '--yes', '--json']);
    expect(targeted.exitCode).toBe(0);
    const targetedPayload = JSON.parse(targeted.stdout) as {
      notes: string[];
      totals: { created: number };
    };
    // The selected cluster carries whole commits, so its files reach docs —
    // but this import was aimed at .github, so the docs suppression stands.
    expect(targetedPayload.totals.created).toBe(1);
    expect(targetedPayload.notes).not.toContain('cleared decline for docs');
    expect(targetedPayload.notes).not.toContain('cleared offer cooldown for docs');
    const afterTargeted = JSON.parse((await agent.runRaw(['seed', 'status', '--json'])).stdout) as {
      declined_discovery_areas: string[];
    };
    expect(afterTargeted.declined_discovery_areas).toEqual(['docs']);

    const atDocs = await agent.runRaw(['seed', '--path', 'docs', '--yes', '--json']);
    expect(atDocs.exitCode).toBe(0);
    const docsPayload = JSON.parse(atDocs.stdout) as {
      notes: string[];
      totals: { created: number };
    };
    expect(docsPayload.totals.created).toBe(1);
    expect(docsPayload.notes).toContain('cleared decline for docs');
    expect(docsPayload.notes).toContain('cleared offer cooldown for docs');
    const afterDocs = JSON.parse((await agent.runRaw(['seed', 'status', '--json'])).stdout) as {
      declined_discovery_areas: string[];
    };
    expect(afterDocs.declined_discovery_areas).toEqual([]);
  });

  it('clears a decline for every area an untargeted import wrote', async () => {
    await agent.runRaw(['seed', 'status', '--decline', 'src', '--json']);

    const applied = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode).toBe(0);
    const payload = JSON.parse(applied.stdout) as {
      notes: string[];
      totals: { created: number };
    };
    expect(payload.totals.created).toBeGreaterThan(0);
    expect(payload.notes).toContain('cleared decline for src');
    const after = JSON.parse((await agent.runRaw(['seed', 'status', '--json'])).stdout) as {
      declined_discovery_areas: string[];
    };
    expect(after.declined_discovery_areas).toEqual([]);
  });

  it('labels root-level files as (root) in the coverage table', async () => {
    await writeFile(path.join(repo.path, 'CHANGELOG.md'), 'initial\n', 'utf8');
    const rootGit = gitClient(repo.path);
    await rootGit.add('CHANGELOG.md');
    await rootGit.commit('docs: start the changelog');

    const fullRun = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(fullRun.exitCode).toBe(0);

    const statusHuman = await agent.runRaw(['seed', 'status']);
    expect(statusHuman.stdout).toMatch(/^ {2}\(root\): /mu);
    expect(statusHuman.stdout).not.toMatch(/^ {2}\.: /mu);
    // The stored report key stays "."; only the render is labeled.
    const statusJson = JSON.parse((await agent.runRaw(['seed', 'status', '--json'])).stdout) as {
      coverage: { directories: Record<string, unknown> };
    };
    expect(Object.keys(statusJson.coverage.directories)).toContain('.');
  });

  it('validates --decline areas against the top-level directory convention', async () => {
    await repo.cleanup();
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'watch',
        subject: 'feat: add watch app',
        files: { 'apps/orcaops-watch/main.ts': 'export const watch = true;\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

    const rejected = JSON.parse(
      (await agent.runRaw(['seed', 'status', '--decline', 'orcaops-watch', '--json'])).stdout
    ) as { rejected_area?: unknown; declined_discovery_areas: string[] };
    expect(rejected.rejected_area).toEqual({ area: 'orcaops-watch', suggestion: 'apps' });
    expect(rejected.declined_discovery_areas).toEqual([]);
    const rejectedText = await agent.runRaw(['seed', 'status', '--decline', 'orcaops-watch']);
    expect(rejectedText.stdout).toContain('did you mean `apps`?');

    // A first-time exact-name decline confirms like the normalized path does.
    const exactText = await agent.runRaw(['seed', 'status', '--decline', 'apps']);
    expect(exactText.stdout).toContain('Declined apps — suppressing offers for all of apps.');
    const exact = JSON.parse(
      (await agent.runRaw(['seed', 'status', '--decline', 'apps', '--json'])).stdout
    ) as { declined_area?: string; declined_discovery_areas: string[] };
    expect(exact.declined_area).toBe('apps');
    expect(exact.declined_discovery_areas).toEqual(['apps']);

    const clearedText = await agent.runRaw(['seed', 'status', '--offer-again', 'apps']);
    expect(clearedText.stdout).toContain('Cleared decline for apps.');
    const clearedMiss = await agent.runRaw(['seed', 'status', '--offer-again', 'apps', '--json']);
    expect(JSON.parse(clearedMiss.stdout)).toMatchObject({
      offer_again: { area: 'apps', cleared: false, cleared_decline: false, cleared_offer: false },
    });
    const clearedMissText = await agent.runRaw(['seed', 'status', '--offer-again', 'apps']);
    expect(clearedMissText.stdout).toContain('No decline or offer recorded for apps.');

    // Clearing an offer-only row must say so — not claim a decline cleared.
    await agent.runRaw(['seed', 'status', '--offered', 'apps']);
    const offerOnly = await agent.runRaw(['seed', 'status', '--offer-again', 'apps', '--json']);
    expect(JSON.parse(offerOnly.stdout)).toMatchObject({
      offer_again: { area: 'apps', cleared: true, cleared_decline: false, cleared_offer: true },
    });
    await agent.runRaw(['seed', 'status', '--offered', 'apps']);
    const offerOnlyText = await agent.runRaw(['seed', 'status', '--offer-again', 'apps']);
    expect(offerOnlyText.stdout).toContain('Cleared offer cooldown for apps.');
    expect(offerOnlyText.stdout).not.toContain('Cleared decline for apps.');

    // A blank selector reports the same ignored-empty-area line the other
    // area flags print instead of exiting silently.
    const blankOfferAgain = await agent.runRaw(['seed', 'status', '--offer-again', '   ']);
    expect(blankOfferAgain.stdout).toContain('Ignored empty area.');
    expect(
      JSON.parse((await agent.runRaw(['seed', 'status', '--offer-again', ' ', '--json'])).stdout)
    ).toMatchObject({ ignored_empty_area: true });

    const normalized = JSON.parse(
      (await agent.runRaw(['seed', 'status', '--decline', './apps/orcaops-watch/', '--json']))
        .stdout
    ) as { normalized_area?: unknown; declined_discovery_areas: string[] };
    expect(normalized.normalized_area).toEqual({ from: 'apps/orcaops-watch', to: 'apps' });
    expect(normalized.declined_discovery_areas).toEqual(['apps']);

    const widenedText = await agent.runRaw(['seed', 'status', '--decline', 'apps/orcaops-watch']);
    expect(widenedText.stdout).toContain(
      'Declined apps (normalized from apps/orcaops-watch; areas are top-level ' +
        'directories — suppressing offers for all of apps).'
    );
  });

  it('continues from the recency budget with blame-ranked importance clusters', async () => {
    await repo.cleanup();
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'old',
        subject: 'feat: add durable core',
        committerDate: '2025-01-01T00:00:00.000Z',
        files: { 'core/old.ts': 'one\ntwo\nthree\n' },
      },
      {
        type: 'commit',
        label: 'recent',
        subject: 'feat: add recent surface',
        committerDate: '2026-08-01T00:00:00.000Z',
        files: { 'surface/recent.ts': 'four\nfive\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

    const recency = await agent.runRaw(['seed', '--max-commits', '1', '--yes', '--json']);
    expect(recency.exitCode).toBe(0);
    expect(JSON.parse(recency.stdout)).toMatchObject({
      totals: { selected: 1, created: 1 },
      truncation: { importance: true, commits_beyond: 1, clusters_beyond: 1 },
    });

    const truncatedStatus = JSON.parse(
      (await agent.runRaw(['seed', 'status', '--json'])).stdout
    ) as { state: string; budget_truncation: unknown };
    expect(truncatedStatus.state).toBe('partial');
    expect(truncatedStatus.budget_truncation).toEqual({
      commits_beyond: 1,
      clusters_beyond: 1,
    });
    const truncatedHuman = await agent.runRaw(['seed', 'status']);
    expect(truncatedHuman.stdout).toContain(
      'Seed state: partial (budget-truncated — 1 commit/1 cluster beyond the budget; ' +
        'widen with --max-commits/--since)'
    );

    const importance = await agent.runRaw([
      'seed',
      '--importance',
      '--max-commits',
      '2',
      '--yes',
      '--json',
    ]);
    expect(importance.exitCode).toBe(0);
    expect(JSON.parse(importance.stdout)).toMatchObject({
      totals: { selected: 2, created: 1, covered: 1, failed: 0 },
      importance: { deferred: false },
    });
    const status = await agent.runRaw(['seed', 'status', '--json']);
    expect(JSON.parse(status.stdout)).toMatchObject({
      state: 'complete',
      budget_truncation: null,
      imported_artifacts: 2,
      coverage: {
        complete: true,
        directories: {
          core: { percent: 100 },
          surface: { percent: 100 },
        },
      },
    });
    // Whole-history lane: unqualified complete pairs with complete coverage.
    const completeHuman = await agent.runRaw(['seed', 'status']);
    expect(completeHuman.stdout).toContain('Seed state: complete\n');
    expect(completeHuman.stdout).toContain('Coverage (complete):');
  });

  it('does not expose a seed cloud-push option', async () => {
    const pushed = await agent.runRaw(['seed', '--push', '--json']);
    expect(pushed.exitCode).toBe(1);
    expect(pushed.stderr).toContain("unknown option '--push'");
  });

  it('applies a validated dry-run bundle before writing artifact events', async () => {
    const previewResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--dry-run',
      '--json',
    ]);
    const preview = JSON.parse(previewResult.stdout) as {
      enrichment: { bundle_directory: string; bundle_count: number };
    };
    expect(preview.enrichment.bundle_count).toBe(1);
    const manifest = JSON.parse(
      await readFile(path.join(preview.enrichment.bundle_directory, 'manifest.json'), 'utf8')
    ) as { files: string[] };
    const bundle = await readFile(
      path.join(preview.enrichment.bundle_directory, manifest.files[0]!),
      'utf8'
    );
    const template = JSON.parse(bundle.match(/```json\n([\s\S]+?)\n```/u)![1]!) as {
      label: string;
      outcome: string;
      checkpoint_summaries: string[];
    };
    template.label = 'Stable service foundation';
    template.outcome = 'Shipped a stable service foundation.';
    template.checkpoint_summaries = template.checkpoint_summaries.map(
      (_, index) => `Landed service checkpoint ${index + 1}.`
    );
    const enrichmentDir = path.join(repo.path, 'agent-enrichment');
    await mkdir(enrichmentDir);
    await writeFile(
      path.join(enrichmentDir, 'cluster.json'),
      `${JSON.stringify(template, null, 2)}\n`,
      'utf8'
    );

    const appliedResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--enrichment-dir',
      enrichmentDir,
      '--json',
    ]);
    expect(appliedResult.exitCode).toBe(0);
    const applied = JSON.parse(appliedResult.stdout) as {
      seeded: Array<{ artifactId: string }>;
      enrichment: { applied: number; skeleton: number };
    };
    expect(applied.enrichment).toEqual({
      applied: 1,
      skeleton: 0,
      nomination_dispositions: null,
      invalid: [],
      unmatched: [],
      warnings: [],
    });
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    const plan = await store.readPlan(applied.seeded[0]!.artifactId);
    expect(plan).toMatchObject({
      label: 'Stable service foundation',
      origin: { kind: 'git-import' },
    });
    expect(plan?.origin?.enriched_at).toMatch(/^\d{4}-/u);
    expect((await store.readSummary(applied.seeded[0]!.artifactId))?.outcome).toBe(
      'Shipped a stable service foundation.'
    );
    store.close();

    // A re-run writes nothing, so the enriched count reports zero actual
    // writes and the retargeted file is reported as already imported —
    // never as a stale cluster_key.
    const rerunResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--enrichment-dir',
      enrichmentDir,
      '--json',
    ]);
    expect(rerunResult.exitCode).toBe(0);
    const rerun = JSON.parse(rerunResult.stdout) as {
      totals: { covered: number };
      enrichment: { applied: number; unmatched: Array<{ reason: string }> };
    };
    expect(rerun.totals.covered).toBe(1);
    expect(rerun.enrichment.applied).toBe(0);
    expect(rerun.enrichment.unmatched).toEqual([
      expect.objectContaining({ reason: 'already-imported' }),
    ]);
    const rerunHuman = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--enrichment-dir',
      enrichmentDir,
    ]);
    expect(rerunHuman.stdout).toContain(
      "enriching existing imports isn't supported yet — enrichment happens at import time " +
        '(fresh store or before apply)'
    );
  });

  it('keeps seed status byte-identical across previews, including targeted ones after applies', async () => {
    // Fresh store: a preview must not flip never-run.
    await agent.runRaw(['seed', '--dry-run', '--json']);
    expect((await agent.runRaw(['seed', 'status'])).stdout).toContain('Seed state: never-run');

    const applied = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode).toBe(0);

    // New history for the targeted preview to nominate — committed BEFORE
    // the baseline snapshot so HEAD movement is not attributed to the preview.
    const git = gitClient(repo.path);
    await writeFile(path.join(repo.path, 'src/extra.ts'), 'export const extra = true;\n');
    await git.add('src/extra.ts');
    await git.commit('feat: add an extra module');
    const extraSha = (await git.revparse(['HEAD'])).trim();

    const before = await agent.runRaw(['seed', 'status']);
    const beforeJson = await agent.runRaw(['seed', 'status', '--json']);
    const preview = await agent.runRaw(['seed', '--commit', extraSha, '--dry-run', '--json']);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      mode: 'dry-run',
      totals: { pending: 1 },
    });
    const after = await agent.runRaw(['seed', 'status']);
    const afterJson = await agent.runRaw(['seed', 'status', '--json']);
    expect(after.stdout).toBe(before.stdout);
    expect(afterJson.stdout).toBe(beforeJson.stdout);
    expect(before.stdout).toContain('Seed state: complete');
  });

  it('propagates enriched labels to list rows and search content', async () => {
    const previewResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--dry-run',
      '--json',
    ]);
    const preview = JSON.parse(previewResult.stdout) as {
      enrichment: { bundle_directory: string };
    };
    const manifest = JSON.parse(
      await readFile(path.join(preview.enrichment.bundle_directory, 'manifest.json'), 'utf8')
    ) as { files: string[] };
    const bundle = await readFile(
      path.join(preview.enrichment.bundle_directory, manifest.files[0]!),
      'utf8'
    );
    const template = JSON.parse(bundle.match(/```json\n([\s\S]+?)\n```/u)![1]!) as {
      label: string;
      outcome: string;
      checkpoint_summaries: string[];
    };
    // "groundwork" appears ONLY in the enriched label, so the search hit
    // below can come from nothing but the indexed plan label.
    template.label = 'Stable service groundwork';
    template.outcome = 'Shipped a stable service baseline.';
    template.checkpoint_summaries = template.checkpoint_summaries.map(
      (_, index) => `Landed service checkpoint ${index + 1}.`
    );
    const enrichmentDir = path.join(repo.path, 'agent-enrichment');
    await mkdir(enrichmentDir);
    await writeFile(
      path.join(enrichmentDir, 'cluster.json'),
      `${JSON.stringify(template, null, 2)}\n`,
      'utf8'
    );
    const appliedResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--enrichment-dir',
      enrichmentDir,
      '--json',
    ]);
    expect(appliedResult.exitCode).toBe(0);
    const applied = JSON.parse(appliedResult.stdout) as {
      seeded: Array<{ artifactId: string }>;
      enrichment: { applied: number };
    };
    expect(applied.enrichment.applied).toBe(1);
    const artifactId = applied.seeded[0]!.artifactId;

    const importedList = JSON.parse(
      (await agent.runRaw(['list', '--imported', '--json'])).stdout
    ) as { artifacts: Array<{ id: string; label: string }> };
    expect(importedList.artifacts).toEqual([
      expect.objectContaining({ id: artifactId, label: 'Stable service groundwork' }),
    ]);
    const table = (await agent.runRaw(['list', '--imported'])).stdout;
    expect(table).toContain('[imported] Stable service groundwork —');

    const hits = JSON.parse((await agent.runRaw(['search', 'groundwork', '--json'])).stdout) as {
      results: Array<{
        artifact_id: string;
        source: string;
        snippet: string;
        origin: string | null;
      }>;
    };
    const hit = hits.results.find((r) => r.artifact_id === artifactId);
    expect(hit).toMatchObject({ source: 'plan:0', origin: 'git-import' });
    // FTS snippets wrap the matched token in <<>> markers.
    expect(hit!.snippet).toContain('Stable service <<groundwork>>');
  });

  it('derives agent-trace contributors for imported commits from the historical authors', async () => {
    const applied = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode).toBe(0);

    const exported = await agent.runRaw([
      'export',
      'agent-trace',
      '--commit',
      repo.shas.next!,
      '--json',
    ]);
    expect(exported.exitCode).toBe(0);
    const record = (
      JSON.parse(exported.stdout) as {
        record: {
          files: Array<{
            conversations: Array<{
              contributor: { type: string; authors?: string[]; model_id?: string };
              origin?: string;
            }>;
          }>;
        };
      }
    ).record;
    const conversations = record.files.flatMap((file) => file.conversations);
    expect(conversations.length).toBeGreaterThan(0);
    for (const conversation of conversations) {
      expect(conversation.contributor.type).toBe('human');
      expect(conversation.contributor.model_id).toBeUndefined();
      expect(conversation.contributor.authors).toContain('test@orcaops.local');
      expect(conversation.origin).toBe('git-import');
    }
  });

  it('marks imported plan steps on the step brief surface', async () => {
    const appliedResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(appliedResult.exitCode).toBe(0);
    const applied = JSON.parse(appliedResult.stdout) as { seeded: Array<{ artifactId: string }> };
    const artifactId = applied.seeded[0]!.artifactId;
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    const plan = await store.readPlan(artifactId);
    store.close();
    const stepId = plan!.plan_steps[0]!.step_id;

    const brief = JSON.parse((await agent.runRaw(['step', 'brief', stepId, '--json'])).stdout) as {
      ok: boolean;
      origin: string | null;
    };
    expect(brief).toMatchObject({ ok: true, origin: 'git-import' });
    const human = (await agent.runRaw(['step', 'brief', stepId])).stdout;
    expect(human).toContain('origin:       imported from git history (synthesized)');
  });

  it('tags and banners imported rows reached via loose-ends --all-branches', async () => {
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    const artifactId = uuidv7();
    const ts = '2025-06-01T00:00:00.000Z';
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'origin/main',
      base_sha: repo.shas.root!,
      agent: 'other',
      agent_session_id: null,
      task: 'Imported thread with a leftover',
      label: 'Imported leftover thread',
      plan_steps: [
        {
          step_id: uuidv7(),
          text: 'Land the leftover',
          label: 'Land the leftover',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      origin: {
        kind: 'git-import',
        imported_at: ts,
        tool_version: 'test',
        source_range: `${repo.shas.root}..${repo.shas.next}`,
        authors: ['test@orcaops.local'],
        enriched_at: null,
      },
      started_at: ts,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    });
    await store.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      agent: 'other',
      outcome: 'Landed with a leftover',
      tests_written: [],
      tests_run: [],
      open_items: ['follow up the leftover'],
      deferred_decisions: [],
      head_sha: repo.shas.next!,
      ts,
    });
    store.close();

    // The seed ref never matches the local branch name, so the default
    // scope excludes the imported row (the recorded opt-out).
    expect((await agent.runRaw(['loose-ends'])).stdout).toContain('No loose ends in scope.');

    const human = (await agent.runRaw(['loose-ends', '--all-branches'])).stdout;
    expect(human).toContain('[imported] Imported leftover thread');
    expect(human).toContain('origin: imported from git history (synthesized)');
    const json = JSON.parse(
      (await agent.runRaw(['loose-ends', '--all-branches', '--json'])).stdout
    ) as { artifacts: Array<{ artifact_id: string; origin: string | null }> };
    expect(json.artifacts).toEqual([
      expect.objectContaining({ artifact_id: artifactId, origin: 'git-import' }),
    ]);
  });

  it('discloses imported provenance on the decisions surface in the default scope', async () => {
    const previewResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--dry-run',
      '--json',
    ]);
    const preview = JSON.parse(previewResult.stdout) as {
      enrichment: { bundle_directory: string };
    };
    const manifest = JSON.parse(
      await readFile(path.join(preview.enrichment.bundle_directory, 'manifest.json'), 'utf8')
    ) as { files: string[] };
    const bundle = await readFile(
      path.join(preview.enrichment.bundle_directory, manifest.files[0]!),
      'utf8'
    );
    const template = JSON.parse(bundle.match(/```json\n([\s\S]+?)\n```/u)![1]!) as {
      label: string;
      outcome: string;
      checkpoint_summaries: string[];
      decisions: unknown[];
    };
    const sha7 = (await gitClient(repo.path).revparse(['HEAD'])).slice(0, 7);
    template.label = 'Stable service foundation';
    template.outcome = 'Shipped a stable service foundation.';
    template.checkpoint_summaries = template.checkpoint_summaries.map(
      (_, index) => `Landed service checkpoint ${index + 1}.`
    );
    template.decisions = [
      {
        decision: 'Stabilize the service before adding features',
        reason: `Stability outranked feature work (evidence: commit ${sha7} — "stabilize the service")`,
      },
    ];
    const enrichmentDir = path.join(repo.path, 'agent-enrichment');
    await mkdir(enrichmentDir);
    await writeFile(
      path.join(enrichmentDir, 'cluster.json'),
      `${JSON.stringify(template, null, 2)}\n`,
      'utf8'
    );
    const appliedResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--enrichment-dir',
      enrichmentDir,
      '--json',
    ]);
    expect(appliedResult.exitCode).toBe(0);
    const applied = JSON.parse(appliedResult.stdout) as {
      enrichment: { applied: number; invalid: unknown[] };
    };
    expect(applied.enrichment.applied).toBe(1);
    expect(applied.enrichment.invalid).toEqual([]);

    // The seeded artifact's branch is the seed ref, never the branch a
    // later reader happens to be on — the default scope must still reach it.
    await gitClient(repo.path).checkoutLocalBranch('current-work');

    const json = JSON.parse((await agent.runRaw(['decisions', '--json'])).stdout) as {
      artifacts: Array<{
        origin: string | null;
        records: Array<{ source: string; decision: string }>;
      }>;
    };
    expect(json.artifacts).toHaveLength(1);
    expect(json.artifacts[0]!.origin).toBe('git-import');
    expect(json.artifacts[0]!.records).toEqual([
      expect.objectContaining({
        source: 'plan',
        decision: 'Stabilize the service before adding features',
      }),
    ]);

    const text = (await agent.runRaw(['decisions'])).stdout;
    expect(text).toContain('[imported] Stable service foundation');
    expect(text).toContain(
      'origin: imported from git history (synthesized — evidence-cited paraphrases)'
    );
    expect(text).toContain('reason: Stability outranked feature work');
    expect(text).toContain(`evidence: commit ${sha7} — "stabilize the service"`);
    // The citation is quoted on its own line, never left inline in the reason.
    expect(text).not.toContain('reason: Stability outranked feature work (evidence:');

    // loose-ends opted OUT of seeded default-scope participation: imported
    // history owes nothing.
    const looseEnds = (await agent.runRaw(['loose-ends'])).stdout;
    expect(looseEnds).toContain('No loose ends in scope.');
  });

  it('validates default dry-run bundles on a later default apply', async () => {
    const previewResult = await agent.runRaw(['seed', '--dry-run', '--json']);
    expect(previewResult.exitCode).toBe(0);
    const preview = JSON.parse(previewResult.stdout) as {
      enrichment: { bundle_directory: string; bundle_count: number };
    };
    expect(preview.enrichment.bundle_count).toBe(1);
    const manifest = JSON.parse(
      await readFile(path.join(preview.enrichment.bundle_directory, 'manifest.json'), 'utf8')
    ) as { files: string[]; selection: { since: string } };
    expect(manifest.selection.since).toMatch(/T00:00:00\.000Z$/u);
    const enrichmentDir = await enrichFirstBundle(preview.enrichment.bundle_directory, manifest);

    // The apply runs on a later clock; without manifest adoption its
    // default since would differ and reject every bundle.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3 * 24 * 60 * 60 * 1000 });
    try {
      const appliedResult = await agent.runRaw([
        'seed',
        '--yes',
        '--enrichment-dir',
        enrichmentDir,
        '--json',
      ]);
      expect(appliedResult.exitCode).toBe(0);
      const applied = JSON.parse(appliedResult.stdout) as {
        since: string;
        enrichment: { applied: number; skeleton: number; invalid: unknown[]; unmatched: unknown[] };
      };
      expect(applied.since).toBe(manifest.selection.since);
      expect(applied.enrichment).toEqual({
        applied: 1,
        skeleton: 0,
        nomination_dispositions: null,
        invalid: [],
        unmatched: [],
        warnings: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects pending bundles when an explicit --since conflicts with the manifest', async () => {
    const previewResult = await agent.runRaw(['seed', '--dry-run', '--json']);
    const preview = JSON.parse(previewResult.stdout) as {
      enrichment: { bundle_directory: string };
    };
    const manifest = JSON.parse(
      await readFile(path.join(preview.enrichment.bundle_directory, 'manifest.json'), 'utf8')
    ) as { files: string[]; selection: { since: string } };
    const enrichmentDir = await enrichFirstBundle(preview.enrichment.bundle_directory, manifest);

    const appliedResult = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--enrichment-dir',
      enrichmentDir,
      '--json',
    ]);
    expect(appliedResult.exitCode).toBe(0);
    const applied = JSON.parse(appliedResult.stdout) as {
      enrichment: {
        applied: number;
        skeleton: number;
        invalid: Array<{ reason: string }>;
      };
    };
    expect(applied.enrichment.applied).toBe(0);
    expect(applied.enrichment.skeleton).toBe(1);
    expect(applied.enrichment.invalid[0]?.reason).toMatch(
      /options_hash does not match the current seed selection/u
    );
  });

  it('lists each rejected and unmatched enrichment file on the text surface', async () => {
    const previewResult = await agent.runRaw(['seed', '--dry-run', '--json']);
    const preview = JSON.parse(previewResult.stdout) as {
      enrichment: { bundle_directory: string };
    };
    const manifest = JSON.parse(
      await readFile(path.join(preview.enrichment.bundle_directory, 'manifest.json'), 'utf8')
    ) as { files: string[] };
    const bundle = await readFile(
      path.join(preview.enrichment.bundle_directory, manifest.files[0]!),
      'utf8'
    );
    const template = JSON.parse(bundle.match(/```json\n([\s\S]+?)\n```/u)![1]!) as {
      options_hash: string;
      cluster_key: string;
    };
    const enrichmentDir = path.join(repo.path, 'agent-enrichment');
    await mkdir(enrichmentDir);
    await writeFile(
      path.join(enrichmentDir, 'bad-hash.json'),
      JSON.stringify({ ...template, options_hash: 'bogus' }),
      'utf8'
    );
    await writeFile(
      path.join(enrichmentDir, 'unmatched.json'),
      JSON.stringify({ ...template, cluster_key: 'run:gone' }),
      'utf8'
    );

    const appliedResult = await agent.runRaw(['seed', '--yes', '--enrichment-dir', enrichmentDir]);
    expect(appliedResult.exitCode).toBe(0);
    expect(appliedResult.stdout).toContain('1 invalid enrichment files fell back to skeleton:');
    expect(appliedResult.stdout).toContain(
      `  rejected ${path.join(enrichmentDir, 'bad-hash.json')}: ` +
        'options_hash does not match the current seed selection'
    );
    expect(appliedResult.stdout).toContain(
      `  unmatched ${path.join(enrichmentDir, 'unmatched.json')}: cluster_key run:gone`
    );
  });

  async function enrichFirstBundle(
    bundleDirectory: string,
    manifest: { files: string[] }
  ): Promise<string> {
    const bundle = await readFile(path.join(bundleDirectory, manifest.files[0]!), 'utf8');
    const template = JSON.parse(bundle.match(/```json\n([\s\S]+?)\n```/u)![1]!) as {
      label: string;
      outcome: string;
      checkpoint_summaries: string[];
    };
    template.label = 'Stable service foundation';
    template.outcome = 'Shipped a stable service foundation.';
    template.checkpoint_summaries = template.checkpoint_summaries.map(
      (_, index) => `Landed service checkpoint ${index + 1}.`
    );
    const enrichmentDir = path.join(repo.path, 'agent-enrichment');
    await mkdir(enrichmentDir, { recursive: true });
    await writeFile(
      path.join(enrichmentDir, 'cluster.json'),
      `${JSON.stringify(template, null, 2)}\n`,
      'utf8'
    );
    return enrichmentDir;
  }

  it('summarizes nomination dispositions on the apply report', async () => {
    const previewResult = await agent.runRaw(['seed', '--dry-run', '--json']);
    const preview = JSON.parse(previewResult.stdout) as {
      enrichment: { bundle_directory: string };
    };
    const manifest = JSON.parse(
      await readFile(path.join(preview.enrichment.bundle_directory, 'manifest.json'), 'utf8')
    ) as { files: string[] };
    const bundle = await readFile(
      path.join(preview.enrichment.bundle_directory, manifest.files[0]!),
      'utf8'
    );
    const template = JSON.parse(bundle.match(/```json\n([\s\S]+?)\n```/u)![1]!) as {
      nomination_dispositions: Array<Record<string, string>>;
    };
    template.nomination_dispositions = [
      { nomination: 'abc1234 — establish the service.', disposition: 'decision' },
      {
        nomination: 'abc1234 — stabilize the service.',
        disposition: 'skipped',
        reason: 'tactical wording, no recorded alternative',
      },
    ];
    const enrichmentDir = path.join(repo.path, 'dispositioned-enrichment');
    await mkdir(enrichmentDir);
    await writeFile(
      path.join(enrichmentDir, 'cluster.json'),
      `${JSON.stringify(template, null, 2)}\n`,
      'utf8'
    );

    const appliedResult = await agent.runRaw(['seed', '--yes', '--enrichment-dir', enrichmentDir]);
    expect(appliedResult.exitCode).toBe(0);
    expect(appliedResult.stdout).toContain('2 nominations: 1 minted, 1 skipped with reasons.');
  });

  it('announces an ignored whitespace decline area', async () => {
    const result = await agent.runRaw(['seed', 'status', '--decline', '   ']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Ignored empty area.');

    const status = await agent.runRaw(['seed', 'status', '--json']);
    expect(JSON.parse(status.stdout)).toMatchObject({
      declined_discovery_areas: [],
      discovery: { declined: [], offered: [] },
    });
  });

  describe('targets outside the recency window', () => {
    beforeEach(async () => {
      await repo.cleanup();
      repo = await createHistoryRepo([
        {
          type: 'commit',
          label: 'root',
          subject: 'feat: establish the baseline',
          committerDate: '2020-01-01T00:00:00.000Z',
          files: { 'src/baseline.ts': 'export const baseline = true;\n' },
        },
        { type: 'branch', name: 'feature', from: 'root' },
        { type: 'checkout', branch: 'feature' },
        {
          type: 'commit',
          label: 'side',
          subject: 'feat: add the legacy parser',
          committerDate: '2020-01-02T00:00:00.000Z',
          files: { 'legacy/parser.ts': 'export const parse = true;\n' },
        },
        { type: 'checkout', branch: 'main' },
        {
          type: 'merge',
          label: 'merge',
          branch: 'feature',
          committerDate: '2020-01-03T00:00:00.000Z',
        },
        {
          type: 'commit',
          label: 'recent',
          subject: 'feat: recent work',
          committerDate: '2026-08-01T00:00:00.000Z',
          files: { 'src/current.ts': 'export const current = true;\n' },
        },
      ]);
      agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
      await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    });

    it('imports the cluster of a targeted commit older than the recency window', async () => {
      const applied = await agent.runRaw(['seed', '--commit', repo.shas.side!, '--yes', '--json']);
      expect(applied.exitCode).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        totals: { selected: 1, created: 1, failed: 0 },
      });

      const config = await loadConfig(repo.path);
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      expect(
        store.store.listArtifacts().filter((row) => row.origin_kind === 'git-import')
      ).toHaveLength(1);
      store.close();
    });

    it('imports old history for a targeted path', async () => {
      const applied = await agent.runRaw(['seed', '--path', 'legacy', '--yes', '--json']);
      expect(applied.exitCode).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        totals: { selected: 1, created: 1, failed: 0 },
      });
    });

    it('explains a covered target instead of calling it unseedable', async () => {
      const applied = await agent.runRaw(['seed', '--commit', repo.shas.side!, '--yes', '--json']);
      expect(applied.exitCode).toBe(0);

      // The merge sha names the imported cluster but is not one of its
      // members, so selection comes back empty; the note must say the
      // history is covered, not that it is unseedable.
      const preview = await agent.runRaw([
        'seed',
        '--commit',
        repo.shas.merge!,
        '--dry-run',
        '--json',
      ]);
      expect(preview.exitCode).toBe(0);
      const { notes } = JSON.parse(preview.stdout) as { notes: string[] };
      expect(notes.join('\n')).toContain('already covered by an imported or captured artifact');
      expect(notes.join('\n')).toContain("enriching existing imports isn't supported yet");
      expect(notes.join('\n')).not.toContain('not part of any seedable cluster');
    });

    it('says why an explicit --since empties a targeted selection', async () => {
      const preview = await agent.runRaw([
        'seed',
        '--commit',
        repo.shas.side!,
        '--since',
        '2026-01-01T00:00:00.000Z',
        '--dry-run',
      ]);
      expect(preview.exitCode).toBe(0);
      expect(preview.stdout).toContain(
        'Honoring explicit --since 2026-01-01T00:00:00.000Z; targeted runs ignore the selection window by default.'
      );
      expect(preview.stdout).toContain(
        `commit ${repo.shas.side!.slice(0, 7)} falls outside the selection window ` +
          '(--since 2026-01-01T00:00:00.000Z)'
      );
      expect(preview.stdout).toContain('drop --since to import its cluster');
    });

    it('explains a targeted commit that matches no seedable cluster', async () => {
      const preview = await agent.runRaw([
        'seed',
        '--commit',
        repo.shas.merge!,
        '--dry-run',
        '--json',
      ]);
      expect(preview.exitCode).toBe(0);
      const result = JSON.parse(preview.stdout) as { notes: string[]; totals: { pending: number } };
      expect(result.totals.pending).toBe(0);
      expect(result.notes.join('\n')).toContain(
        `commit ${repo.shas.merge!.slice(0, 7)} is not part of any seedable cluster`
      );
    });
  });

  it('never labels an imported cluster with a release-train merge subject', async () => {
    await repo.cleanup();
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish the router',
        committerDate: '2025-01-01T00:00:00.000Z',
        files: { 'src/router.ts': 'export const route = true;\n' },
      },
      { type: 'branch', name: 'release' },
      { type: 'checkout', branch: 'release' },
      {
        type: 'commit',
        label: 'etag',
        subject: 'feat: add ETag support',
        committerDate: '2025-01-02T00:00:00.000Z',
        files: { 'src/etag.ts': 'export const etag = true;\n' },
      },
      {
        type: 'commit',
        label: 'ranges',
        subject: 'feat: add range requests',
        committerDate: '2025-01-03T00:00:00.000Z',
        files: { 'src/ranges.ts': 'export const ranges = true;\n' },
      },
      { type: 'tag', name: 'v1.4.0' },
      { type: 'checkout', branch: 'main' },
      {
        type: 'merge',
        label: 'train',
        branch: 'v1.4.0',
        subject: "Merge tag 'v1.4.0'",
        committerDate: '2025-01-04T00:00:00.000Z',
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

    const preview = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--dry-run',
      '--json',
    ]);
    expect(preview.exitCode).toBe(0);
    const clusters = (JSON.parse(preview.stdout) as { clusters: Array<{ label: string }> })
      .clusters;
    expect(clusters.length).toBeGreaterThan(0);
    // A ceremonial label here leaks into `orcaops why` provenance output.
    for (const cluster of clusters) expect(cluster.label).not.toContain('Merge tag');
    // bestMember ranks by information score, so either feature subject is a
    // correct label; what matters is that the ceremony lost to the work.
    expect(
      clusters.some((cluster) => /add (?:ETag support|range requests)/u.test(cluster.label))
    ).toBe(true);
  });

  describe('durable seed state', () => {
    const HISTORY: readonly HistoryOperation[] = [
      {
        type: 'commit' as const,
        label: 'first',
        subject: 'feat: add the reader',
        committerDate: '2025-01-01T00:00:00.000Z',
        files: { 'src/reader.ts': 'export const read = true;\n' },
      },
      {
        type: 'commit' as const,
        label: 'second',
        subject: 'feat: add the writer',
        committerDate: '2025-02-01T00:00:00.000Z',
        files: { 'src/writer.ts': 'export const write = true;\n' },
      },
    ];

    let dataRoot: string;

    const preciousStatePath = async (repoRoot: string): Promise<string> => {
      const projectId = (
        await gitClient(repoRoot).raw(['config', '--local', '--get', 'orcaops.projectid'])
      ).trim();
      expect(projectId).not.toBe('');
      return path.join(dataRoot, 'projects', projectId, 'seed-state.json');
    };

    const readPrecious = async (repoRoot: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(await preciousStatePath(repoRoot), 'utf8')) as Record<
        string,
        unknown
      >;

    beforeEach(async () => {
      await repo.cleanup();
      repo = await createHistoryRepo(HISTORY);
      dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-seed-data-'));
      agent = makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataRoot },
      });
      await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    });

    /**
     * Reproduce a `kill -9` landing between the durable summary_captured
     * append and the projection + cache writes, for one imported artifact.
     * Deterministic — the projections are pure functions of the log prefix.
     */
    const tearSummaryProjection = async (artifactId: string): Promise<void> => {
      const config = await loadConfig(repo.path);
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await rm(paths.summaryJson);
      await rm(paths.summaryMd);
      const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      artifactJson.state = 'active';
      await writeFile(paths.artifactJson, JSON.stringify(artifactJson, null, 2) + '\n');
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        store.store.db.prepare('DELETE FROM summaries WHERE artifact_id = ?').run(artifactId);
        store.store.db
          .prepare("UPDATE artifacts SET status = 'active', completed_at = NULL WHERE id = ?")
          .run(artifactId);
      } finally {
        store.close();
      }
    };

    const seedOnce = async (): Promise<string> => {
      const applied = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--yes',
        '--json',
      ]);
      expect(applied.exitCode).toBe(0);
      const seeded = (JSON.parse(applied.stdout) as { seeded: Array<{ artifactId: string }> })
        .seeded;
      expect(seeded.length).toBeGreaterThan(0);
      return seeded[0]!.artifactId;
    };

    it('heals a seed whose summary event outlived its projections', async () => {
      const artifactId = await seedOnce();
      await tearSummaryProjection(artifactId);

      // A torn projection must not be reported as a failed cluster.
      const healed = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--yes',
        '--json',
      ]);
      expect(healed.exitCode).toBe(0);
      expect(healed.stdout).not.toContain('canonicalJson');
      expect(healed.stdout).not.toContain('OPEN_CP_OVERLAP');
      expect(healed.stdout).not.toContain('Unable to replay');

      const status = await agent.runRaw(['seed', 'status', '--json']);
      const parsed = JSON.parse(status.stdout) as {
        state: string;
        failures: unknown[];
      };
      expect(parsed.state).toBe('complete');
      expect(parsed.failures).toEqual([]);

      // The repair must reach the cache and the files, not merely leave the
      // run reporting complete — every other read surface goes through these.
      const config = await loadConfig(repo.path);
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        expect(store.store.getSummary(artifactId)).not.toBeNull();
        expect(store.store.getArtifact(artifactId)?.status).toBe('complete');
      } finally {
        store.close();
      }
      const paths = artifactPathsFor(repo.path, config, artifactId);
      expect(JSON.parse(await readFile(paths.artifactJson, 'utf8')).state).toBe('summarized');
      await expect(readFile(paths.summaryJson, 'utf8')).resolves.toContain('"outcome"');

      // A third run is a clean no-op: healed once, not merely non-fatal.
      const again = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--yes',
        '--json',
      ]);
      expect(again.exitCode).toBe(0);
      expect((JSON.parse(again.stdout) as { totals: { failed: number } }).totals.failed).toBe(0);
    });

    it('repairs a torn summary projection through `orcaops rebuild`', async () => {
      // Pins the remedy the seed failure text now names, so that text stays true.
      const artifactId = await seedOnce();
      await tearSummaryProjection(artifactId);

      const rebuilt = await agent.runRaw(['rebuild', '--json']);
      expect(rebuilt.exitCode).toBe(0);

      const config = await loadConfig(repo.path);
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        expect(store.store.getSummary(artifactId)).not.toBeNull();
      } finally {
        store.close();
      }
    });

    it('exits non-zero and refuses to call the run complete when a cluster fails', async () => {
      const artifactId = await seedOnce();
      await tearSummaryProjection(artifactId);
      // Hold that artifact's lock so the repairing write cannot acquire it.
      // This is the field shape: a crashed holder's lock is honored until the
      // stale threshold elapses, and the cluster fails in the meantime.
      await mkdir(path.join(repo.path, '.orcaops', 'tmp', 'locks', `${artifactId}.lock`), {
        recursive: true,
      });

      const failed = await agent.runRaw(['seed', '--since', '2020-01-01T00:00:00.000Z', '--yes']);
      expect(failed.exitCode).toBe(1);
      expect(failed.stdout).toContain('Seed finished with 1 failure');
      expect(failed.stdout).not.toContain('Seed complete —');
      expect(failed.stdout).toContain('failed 1');
      expect(failed.stdout).toContain('orcaops rebuild');
    }, 60_000);

    it('keeps ids, consent, and declines across a cache wipe', async () => {
      const applied = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--pr-context',
        '--yes',
        '--json',
      ]);
      expect(applied.exitCode).toBe(0);
      const importedIds = (
        JSON.parse(applied.stdout) as { seeded: Array<{ artifactId: string }> }
      ).seeded
        .map((entry) => entry.artifactId)
        .sort();
      expect(importedIds.length).toBeGreaterThan(0);
      await agent.runRaw(['seed', 'status', '--decline', './src/', '--json']);

      const before = await readPrecious(repo.path);
      expect(before).toMatchObject({ pr_context: true });
      // Stand in for a large-history run that already printed the hint.
      await writeFile(
        await preciousStatePath(repo.path),
        JSON.stringify({ ...before, commit_graph_hint_shown: true }),
        'utf8'
      );

      await rm(path.join(repo.path, '.orcaops', 'cache'), { recursive: true, force: true });

      const rerun = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--yes',
        '--json',
      ]);
      expect(rerun.exitCode).toBe(0);
      expect(JSON.parse(rerun.stdout)).toMatchObject({
        totals: { created: 0, failed: 0, covered: importedIds.length },
      });

      const config = await loadConfig(repo.path);
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      expect(
        store.store
          .listArtifacts()
          .filter((artifact) => artifact.origin_kind === 'git-import')
          .map((artifact) => artifact.id)
          .sort()
      ).toEqual(importedIds);
      store.close();

      // The rebuilt journal names the ids this run re-derived: identical ids
      // prove the nonce came back from the precious half, not a fresh mint.
      const journal = JSON.parse(
        await readFile(path.join(repo.path, '.orcaops', 'cache', 'seed', 'journal.json'), 'utf8')
      ) as {
        schema_version: number;
        install_nonce: string;
        clusters: Record<string, { artifact_id: string; status: string }>;
      };
      expect(journal.schema_version).toBe(2);
      expect(
        Object.values(journal.clusters)
          .map((cluster) => cluster.artifact_id)
          .sort()
      ).toEqual(importedIds);

      const after = await readPrecious(repo.path);
      expect(after).toMatchObject({
        install_nonce: before.install_nonce,
        pr_context: true,
        commit_graph_hint_shown: true,
      });
      expect(journal.install_nonce).toBe(before.install_nonce);

      const status = await agent.runRaw(['seed', 'status', '--json']);
      expect(JSON.parse(status.stdout)).toMatchObject({
        state: 'complete',
        declined_discovery_areas: ['src'],
      });
    });

    it('reports complete from the store when the journal cache is gone', async () => {
      const applied = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--yes',
        '--json',
      ]);
      expect(applied.exitCode).toBe(0);
      const created = (JSON.parse(applied.stdout) as { totals: { created: number } }).totals
        .created;
      expect(created).toBeGreaterThan(0);

      await rm(path.join(repo.path, '.orcaops', 'cache'), { recursive: true, force: true });

      const text = await agent.runRaw(['seed', 'status']);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain(
        'Seed state: complete (inferred from imported artifacts; the run journal cache was cleared)'
      );
      expect(text.stdout).toContain(`Imported artifacts: ${created}`);

      const status = await agent.runRaw(['seed', 'status', '--json']);
      expect(JSON.parse(status.stdout)).toMatchObject({
        state: 'complete',
        state_inferred_from_store: true,
        imported_artifacts: created,
      });
    });

    it('notes archive-carried coverage in a fresh linked worktree', async () => {
      const applied = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--yes',
        '--json',
      ]);
      expect(applied.exitCode).toBe(0);
      const created = (JSON.parse(applied.stdout) as { totals: { created: number } }).totals
        .created;
      expect(created).toBeGreaterThan(0);

      const linkedRoot = path.join(
        await mkdtemp(path.join(tmpdir(), 'orcaops-seed-wt-')),
        'linked'
      );
      await gitClient(repo.path).raw(['worktree', 'add', '-b', 'linked-coverage', linkedRoot]);
      const linkedAgent = makeAgent({
        cwd: linkedRoot,
        env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataRoot },
      });
      await linkedAgent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

      const preview = await linkedAgent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--dry-run',
        '--json',
      ]);
      expect(preview.exitCode).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        totals: { pending: 0, covered: created, covered_via_archive: created },
      });

      const previewText = await linkedAgent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--dry-run',
      ]);
      expect(previewText.stdout).toContain(`${created} covered via the shared project archive.`);
    });

    it('keeps head-sha coverage from a lossy archived thread instead of re-importing it', async () => {
      const applied = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--yes',
        '--json',
      ]);
      expect(applied.exitCode).toBe(0);
      const seededIds = (
        JSON.parse(applied.stdout) as { seeded: Array<{ artifactId: string }> }
      ).seeded.map((entry) => entry.artifactId);
      expect(seededIds.length).toBeGreaterThan(0);

      const projectId = (
        await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
      ).trim();
      // Rot every archived thread's final complete line (the summary event):
      // the log becomes lossy while the checkpoint prefix stays readable.
      for (const artifactId of seededIds) {
        const eventsPath = path.join(
          dataRoot,
          'projects',
          projectId,
          'artifacts',
          artifactId,
          'events.ndjson'
        );
        const lines = (await readFile(eventsPath, 'utf8')).split('\n');
        const last = lines.length - (lines.at(-1) === '' ? 2 : 1);
        lines[last] = lines[last]!.replace(
          /"checksum":"[0-9a-f]{64}"/u,
          `"checksum":"${'0'.repeat(64)}"`
        );
        await writeFile(eventsPath, lines.join('\n'), 'utf8');
      }

      const linkedRoot = path.join(
        await mkdtemp(path.join(tmpdir(), 'orcaops-seed-lossy-wt-')),
        'linked'
      );
      await gitClient(repo.path).raw(['worktree', 'add', '-b', 'lossy-coverage', linkedRoot]);
      const linkedAgent = makeAgent({
        cwd: linkedRoot,
        env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataRoot },
      });
      await linkedAgent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

      const preview = await linkedAgent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--dry-run',
        '--json',
      ]);
      expect(preview.exitCode).toBe(0);
      const payload = JSON.parse(preview.stdout) as {
        totals: { pending: number; covered: number };
        notes: string[];
      };
      expect(payload.totals.pending).toBe(0);
      expect(payload.totals.covered).toBe(seededIds.length);
      expect(payload.notes.join('\n')).toMatch(
        /archived threads? with corrupt event lines contributed head-sha coverage/u
      );
    });

    it('groups imported artifacts by the job that produced them', async () => {
      // One commit of budget keeps the first apply to the newest cluster, so
      // the older commit is still a genuine gap for the second run to fill.
      const initial = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--max-commits',
        '1',
        '--yes',
        '--invoked-by-agent',
        'claude-code',
        '--json',
      ]);
      expect(initial.exitCode).toBe(0);
      expect(JSON.parse(initial.stdout)).toMatchObject({ totals: { created: 1, failed: 0 } });

      const gapFill = await agent.runRaw(['seed', '--commit', repo.shas.first!, '--yes', '--json']);
      expect(gapFill.exitCode).toBe(0);
      expect(JSON.parse(gapFill.stdout)).toMatchObject({ totals: { created: 1, failed: 0 } });

      const ledger = await agent.runRaw(['seed', 'status', '--jobs', '--json']);
      expect(ledger.exitCode).toBe(0);
      const jobs = (JSON.parse(ledger.stdout) as { jobs: Array<Record<string, unknown>> }).jobs;
      expect(jobs).toHaveLength(2);
      expect(jobs.map((job) => job.kind)).toEqual(['initial', 'commit']);
      expect(jobs.every((job) => job.artifacts === 1 && job.enriched === 0)).toBe(true);
      expect(jobs.every((job) => typeof job.first_imported_at === 'string')).toBe(true);
      // Run extras ride along from the journal while the cache still has them.
      expect(jobs[0]).toMatchObject({
        budget: { max_commits: expect.any(Number), selected_commits: expect.any(Number) },
        skipped_covered: expect.any(Number),
      });
      expect(typeof jobs[0]!.wall_time_ms).toBe('number');
      // Job-ledger attribution: the flag names who RAN the import; the
      // flag-less run resolves through the remaining tiers to 'other'.
      expect(jobs[0]!.invoked_by).toBe('claude-code');
      expect(jobs[1]!.invoked_by).toBe('other');

      const text = await agent.runRaw(['seed', 'status', '--jobs']);
      expect(text.stdout).toContain('Generation jobs: 2');
      expect(text.stdout).toContain('1 artifact(s), 0 enriched');
      expect(text.stdout).toContain('invoked by claude-code');
    });

    it('rejects an invalid --invoked-by-agent value loudly', async () => {
      const result = await agent.runRaw([
        'seed',
        '--dry-run',
        '--invoked-by-agent',
        'not-an-agent',
        '--json',
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('Invalid --invoked-by-agent value');
    });

    it('records an offer, honors its cooldown, and clears one area on request', async () => {
      const offered = await agent.runRaw(['seed', 'status', '--offered', './src/', '--json']);
      expect(offered.exitCode).toBe(0);
      expect(JSON.parse(offered.stdout)).toMatchObject({
        declined_discovery_areas: [],
        discovery: {
          declined: [],
          offered: [{ area: 'src', cooldown_active: true }],
        },
      });

      const cleared = await agent.runRaw(['seed', 'status', '--offer-again', 'src', '--json']);
      expect(JSON.parse(cleared.stdout)).toMatchObject({ discovery: { offered: [] } });

      const declined = await agent.runRaw(['seed', 'status', '--decline', 'src', '--json']);
      expect(JSON.parse(declined.stdout)).toMatchObject({
        discovery: { declined: ['src'], offered: [] },
      });
      const declinedText = await agent.runRaw(['seed', 'status']);
      expect(declinedText.stdout).toContain('Declined areas: src');
      expect(declinedText.stdout).toContain('--offer-again <area>');

      const reoffered = await agent.runRaw(['seed', 'status', '--offer-again', './src/', '--json']);
      expect(JSON.parse(reoffered.stdout)).toMatchObject({
        discovery: { declined: [], offered: [] },
      });
    });

    it('normalizes and announces offered areas like declines', async () => {
      const nested = await agent.runRaw(['seed', 'status', '--offered', 'src/nested', '--json']);
      expect(nested.exitCode).toBe(0);
      expect(JSON.parse(nested.stdout)).toMatchObject({
        normalized_offered_area: { from: 'src/nested', to: 'src' },
        discovery: { offered: [{ area: 'src', cooldown_active: true }] },
      });

      const nestedText = await agent.runRaw(['seed', 'status', '--offered', 'src/nested']);
      expect(nestedText.stdout).toContain(
        'Recorded offer for src (normalized from src/nested; areas are top-level directories).'
      );

      const rejected = await agent.runRaw(['seed', 'status', '--offered', 'bogus', '--json']);
      const rejectedPayload = JSON.parse(rejected.stdout) as {
        rejected_offered_area?: { area: string; suggestion: string | null };
        discovery: { offered: Array<{ area: string }> };
      };
      expect(rejectedPayload.rejected_offered_area).toEqual({ area: 'bogus', suggestion: null });
      expect(rejectedPayload.discovery.offered.map((offer) => offer.area)).not.toContain('bogus');

      const blank = await agent.runRaw(['seed', 'status', '--offered', '   ']);
      expect(blank.stdout).toContain('Ignored empty area.');
    });

    it('retires an offer row when an import covers its area', async () => {
      await agent.runRaw(['seed', 'status', '--offered', './src/', '--json']);
      const applied = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--yes',
        '--json',
      ]);
      expect(applied.exitCode).toBe(0);
      const payload = JSON.parse(applied.stdout) as { notes: string[] };
      expect(payload.notes).toContain('cleared offer cooldown for src');

      const status = await agent.runRaw(['seed', 'status', '--json']);
      expect(JSON.parse(status.stdout)).toMatchObject({ discovery: { offered: [] } });
    });

    it('shares the nonce and remembered declines with a linked worktree', async () => {
      await agent.runRaw(['seed', 'status', '--decline', './src/', '--json']);
      const primaryPreview = await agent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--dry-run',
        '--json',
      ]);
      expect(primaryPreview.exitCode).toBe(0);

      const linkedRoot = path.join(
        await mkdtemp(path.join(tmpdir(), 'orcaops-seed-wt-')),
        'linked'
      );
      await gitClient(repo.path).raw(['worktree', 'add', '-b', 'linked', linkedRoot]);
      const linkedAgent = makeAgent({
        cwd: linkedRoot,
        env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataRoot },
      });
      await linkedAgent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);

      const linkedStatus = await linkedAgent.runRaw(['seed', 'status', '--json']);
      expect(JSON.parse(linkedStatus.stdout)).toMatchObject({
        declined_discovery_areas: ['src'],
      });

      const linkedPreview = await linkedAgent.runRaw([
        'seed',
        '--since',
        '2020-01-01T00:00:00.000Z',
        '--dry-run',
        '--json',
      ]);
      expect(linkedPreview.exitCode).toBe(0);
      const previewIds = (result: string): string[] =>
        (JSON.parse(result) as { clusters: Array<{ artifact_id: string }> }).clusters
          .map((cluster) => cluster.artifact_id)
          .sort();
      // Deterministic ids are nonce-salted, so matching previews across two
      // worktrees is the nonce being shared rather than re-minted per worktree.
      expect(previewIds(linkedPreview.stdout)).toEqual(previewIds(primaryPreview.stdout));
      expect(await readPrecious(linkedRoot)).toMatchObject({
        install_nonce: (await readPrecious(repo.path)).install_nonce,
      });
    });
  });

  describe('error envelopes', () => {
    it.each([
      [['seed', '--dry-run', '--yes', '--json'], /--dry-run and --yes/],
      [['seed', '--path', 'src', '--commit', 'HEAD', '--json'], /--path and --commit/],
      [
        ['seed', '--commit', 'ffffffffffffffffffffffffffffffffffffffff', '--json'],
        /--commit does not resolve/,
      ],
      [['seed', '--enrichment-dir', 'nowhere', '--json'], /--enrichment-dir requires --yes/],
    ] as Array<[string[], RegExp]>)(
      'rejects flag misuse with INVALID_INPUT: %j',
      async (argv, message) => {
        const result = await agent.runRaw(argv);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: 'INVALID_INPUT', message: expect.stringMatching(message) },
        });
      }
    );

    it('reports a held run lock as SEED_RUN_ACTIVE naming the owner and lock path', async () => {
      const dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-seed-lock-data-'));
      const scopedAgent = makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_DATA_DIR: dataRoot },
      });
      // Mints the project identity the lock path is keyed on.
      await scopedAgent.runRaw(['seed', '--dry-run', '--json']);
      const projectId = (
        await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
      ).trim();
      const lockPath = path.join(dataRoot, 'projects', projectId, 'seed-run.lock');
      // A live owner: this test process's own pid.
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`
      );

      const blocked = await scopedAgent.runRaw(['seed', '--dry-run', '--json']);
      expect(blocked.exitCode).toBe(1);
      expect(JSON.parse(blocked.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'SEED_RUN_ACTIVE',
          message: expect.stringMatching(
            new RegExp(`pid ${process.pid}.*seed-run\\.lock.*remove the lock file and retry`, 'su')
          ),
        },
      });
      await rm(dataRoot, { recursive: true, force: true });
    });
  });
});
