import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROMPT_VERSION, PROPOSAL_SCHEMA_VERSION } from '@orcaops/core';
import { uuidv7 } from '@orcaops/storage';
import {
  claimProcessingJob,
  publishProjectKnowledgeSource,
  readLatestProcessingJobReopening,
  readProcessingControl,
  releaseProcessingLease,
  reopenProcessingJob,
  retryProcessingJob,
  startProcessingAttempt,
  takeProcessingLease,
} from '@orcaops/storage/history/database';

import { type KnowledgeWorkerReport, runKnowledgeWorker } from './loop.js';
import {
  FAKE_CLAUDE,
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
  type WorkerFixtureOptions,
} from './worker-fixture.test-support.js';

// Recording a grant is deliberately possible only at a terminal. The fixture
// records one through the same store API a person's `knowledge enable` uses, so
// the terminal check is what has to be answered here.
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

/**
 * Every test here drives the real worker against a real project database, a
 * real git worktree, a real user-local grant store and a real child process for
 * the provider. Ownership, spend accounting, signals and the spawn log do not
 * survive being mocked.
 */

const fixtures: WorkerFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function fixture(options: WorkerFixtureOptions = {}): Promise<WorkerFixture> {
  const made = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER, ...options });
  fixtures.push(made);
  return made;
}

async function work(
  f: WorkerFixture,
  overrides: Partial<Parameters<typeof runKnowledgeWorker>[0]> = {}
): Promise<KnowledgeWorkerReport> {
  const lines: string[] = [];
  const report = await runKnowledgeWorker({
    authority: f.authority,
    projectId: f.projectId,
    providerAvailability: { claude: 'present', codex: 'absent' },
    log: (line) => lines.push(line),
    idleExitMs: 1,
    env: f.env,
    heartbeatMs: 250,
    leaseTermMs: 2_000,
    killGraceMs: 200,
    scratchParentDir: f.scratchParentDir,
    ...overrides,
  });
  return { ...report, detail: `${report.detail}\n${lines.join('\n')}` };
}

const providerWasSpawned = (f: WorkerFixture): boolean => existsSync(f.providerStartedMarker);

async function reopen(f: WorkerFixture, jobId: string, attemptsAllowed: number): Promise<void> {
  const previous = f.handle.read((view) => readLatestProcessingJobReopening(view, jobId)).value;
  const reopened = await reopenProcessingJob(f.handle, {
    reopeningId: uuidv7(),
    jobId,
    expectedUpdatedAt: f.job(jobId).updatedAt,
    expectedPreviousSequence: previous?.reopeningSequence ?? null,
    attemptsAllowed,
    reopenedAt: new Date().toISOString(),
    reopenedBy: 'owner@example.test',
    reopenedByBasis: 'authenticated',
    grantId: 'reopening-grant',
  });
  if (reopened.outcome !== 'reopened')
    throw new Error(`the job was not reopened: ${reopened.outcome}`);
}

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the background knowledge worker', () => {
  it('processes a consented job with restricted Codex access and unknown cost', async () => {
    const f = await fixture({ providerId: 'codex' });
    const { jobId } = await f.admit();

    const report = await work(f, {
      providerAvailability: { claude: 'absent', codex: 'present' },
    });

    expect(report.callsMade).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
    expect(f.attempts(jobId)[0]).toMatchObject({
      outcome: 'succeeded',
      usage: {
        tokens: { in: 1200, out: 300 },
        cost_usd: null,
      },
    });
  });

  it('does not spawn restricted Codex without a matching grant', async () => {
    const f = await fixture({ providerId: 'codex', withoutGrant: true });
    await f.admit();

    const report = await work(f, {
      providerAvailability: { claude: 'absent', codex: 'present' },
    });

    expect(providerWasSpawned(f)).toBe(false);
    expect(report.callsMade).toBe(0);
    expect(report.detail).toContain('no_grant');
  });

  it('does not spawn restricted Codex after its grant is revoked', async () => {
    const f = await fixture({ providerId: 'codex' });
    await f.revoke();
    await f.admit();

    const report = await work(f, {
      providerAvailability: { claude: 'absent', codex: 'present' },
    });

    expect(providerWasSpawned(f)).toBe(false);
    expect(report.callsMade).toBe(0);
    expect(report.detail).toContain('revoked');
  });

  it('interprets an admitted capture end to end and settles a reconciliation plan', async () => {
    const f = await fixture();
    const { jobId } = await f.admit();

    const report = await work(f);

    expect(report.outcome).toBe('idle');
    expect(report.callsMade).toBe(1);
    const job = f.job(jobId);
    expect(job.state).toBe('completed');
    const result = job.result as Record<string, unknown>;
    expect(result.coverage).toMatchObject({ scheduled_units: 1, settled_units: 1 });
    expect(result.processor_contract).toBe('knowledge-interpretation@2');
    expect(result.prompt_version).toBe(PROMPT_VERSION);
    expect(result.proposal_schema_version).toBe(PROPOSAL_SCHEMA_VERSION);
    const plan = result.reconciliation_plan as { records: unknown[] };
    expect(plan.records.length).toBeGreaterThan(0);

    const [attempt] = f.attempts(jobId);
    expect(attempt.outcome).toBe('succeeded');
    // What the plan established is published, in one operation the attempt names.
    expect(attempt.publishingOperationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(attempt.grantId).toMatch(/^[0-9a-f-]{36}$/);
    // The versions this attempt ran under are recorded here, and nowhere else: they take no part
    // in the division, so an upgrade mid-job leaves the units a job has already taken alone.
    expect(attempt.configuration).toMatchObject({
      processor_contract: 'knowledge-interpretation@2',
      prompt_version: PROMPT_VERSION,
      proposal_schema_version: PROPOSAL_SCHEMA_VERSION,
      permission: {
        v: 1,
        confirmation_id: null,
        attempt_grant_id: attempt.grantId,
        execution_terms: {
          project_id: f.projectId,
          job_id: jobId,
          origin: { worktree_root: f.repoPath },
        },
      },
    });
  });

  it('dispatches a job the real capture settlement admitted, from what it retained', async () => {
    const f = await fixture();
    const { jobId, artifactId } = await f.captureAndAdmit();

    const report = await work(f);

    // Nothing here hands the worker a context: the capture settlement retained
    // it, and dispatch found the artifact and the origin worktree in what it
    // wrote.
    expect((f.job(jobId).admission as { context: unknown }).context).toEqual({
      artifact_id: artifactId,
      origin: { worktree_root: f.repoPath },
    });
    expect(report.callsMade).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
  });

  it('exits idle with the lease released and nothing claimed', async () => {
    const f = await fixture();

    const report = await work(f);

    expect(report.outcome).toBe('idle');
    expect(report.callsMade).toBe(0);
    const lease = f.lease();
    expect(lease?.ownerId).toBeNull();
    expect(lease?.ownerGeneration).toBe(1);
  });

  it('wakes for a retry scheduled by an earlier worker and runs it when due', async () => {
    const f = await fixture({
      provider: FAKE_CLAUDE,
      behavior: 'budget-exceeded',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 2 },
    });
    const { jobId } = await f.admit();
    let now = new Date();
    const stopFirstWorker = new AbortController();
    const first = await work(f, {
      idleExitMs: 10_000,
      now: () => now,
      signal: stopFirstWorker.signal,
      sleep: async () => stopFirstWorker.abort(),
    });
    expect(first.outcome).toBe('stopped');
    expect(first.callsMade).toBe(1);
    expect(f.job(jobId).state).toBe('retryable_failure');

    writeFileSync(f.providerPath, `await import(${JSON.stringify(KNOWLEDGE_PROPOSER)});\n`);
    const waits: number[] = [];

    const report = await work(f, {
      idleExitMs: 10_000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now = new Date(now.getTime() + ms);
      },
    });

    expect(waits.slice(0, 3)).toEqual([10_000, 10_000, 10_000]);
    expect(report.callsMade).toBe(1);
    expect(f.attempts(jobId)).toHaveLength(2);
    expect(f.job(jobId).state).toBe('completed');
  });

  it('claims a retry that comes due while the worker is checking how long to wait', async () => {
    const f = await fixture({
      provider: FAKE_CLAUDE,
      behavior: 'budget-exceeded',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 2 },
    });
    const { jobId } = await f.admit();
    let now = new Date();
    const stopFirstWorker = new AbortController();
    await work(f, {
      idleExitMs: 10_000,
      now: () => now,
      signal: stopFirstWorker.signal,
      sleep: async () => stopFirstWorker.abort(),
    });
    expect(f.job(jobId).state).toBe('retryable_failure');
    writeFileSync(f.providerPath, `await import(${JSON.stringify(KNOWLEDGE_PROPOSER)});\n`);

    // Time passes while the worker works and a timer can fire early, so the claim can run just
    // before the retry time and the wait check just after it.
    const report = await work(f, {
      idleExitMs: 10_000,
      heartbeatMs: 60_000,
      now: () => {
        const read = now;
        now = new Date(now.getTime() + 1);
        return read;
      },
      sleep: async (ms) => {
        now = new Date(now.getTime() + Math.max(ms - 2, 0));
      },
    });

    expect(report.callsMade, report.detail).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
  });

  it('wakes for two jobs with staggered retry times', async () => {
    const f = await fixture({
      provider: FAKE_CLAUDE,
      behavior: 'budget-exceeded',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 2 },
    });
    const first = await f.admit();
    const second = await f.admit();
    let now = new Date();
    let attemptsStarted = 0;
    let providerReplaced = false;
    const waits: number[] = [];

    const report = await work(f, {
      idleExitMs: 10_000,
      now: () => now,
      afterAttemptStart: () => {
        attemptsStarted += 1;
        if (attemptsStarted === 2) now = new Date(now.getTime() + 5_000);
      },
      sleep: async (ms) => {
        waits.push(ms);
        now = new Date(now.getTime() + ms);
        if (!providerReplaced) {
          providerReplaced = true;
          writeFileSync(f.providerPath, `await import(${JSON.stringify(KNOWLEDGE_PROPOSER)});\n`);
        }
      },
    });

    expect(waits.slice(0, 4)).toEqual([10_000, 10_000, 5_000, 5_000]);
    expect(report.callsMade).toBe(4);
    expect(f.job(first.jobId).state).toBe('completed');
    expect(f.job(second.jobId).state).toBe('completed');
  });

  it('exits when a retry moves beyond the original backoff horizon', async () => {
    const f = await fixture({
      provider: FAKE_CLAUDE,
      behavior: 'budget-exceeded',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 2 },
    });
    const { jobId } = await f.admit();
    let now = new Date();
    const stopFirstWorker = new AbortController();
    await work(f, {
      idleExitMs: 10_000,
      now: () => now,
      signal: stopFirstWorker.signal,
      sleep: async () => stopFirstWorker.abort(),
    });
    const waits: number[] = [];
    let moved = false;

    const report = await work(f, {
      idleExitMs: 10_000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now = new Date(now.getTime() + ms);
        if (!moved) {
          moved = true;
          const database = new Database(f.handle.databasePath);
          try {
            database
              .prepare('UPDATE processing_jobs SET retry_at=? WHERE job_id=?')
              .run(new Date(now.getTime() + 16 * 60_000).toISOString(), jobId);
          } finally {
            database.close();
          }
        }
      },
    });

    expect(waits).toEqual([10_000]);
    expect(report.callsMade).toBe(0);
    expect(f.job(jobId).state).toBe('retryable_failure');
  });

  it('rechecks consent before a scheduled retry and then exits idle', async () => {
    const f = await fixture({
      provider: FAKE_CLAUDE,
      behavior: 'budget-exceeded',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 2 },
    });
    const { jobId } = await f.admit();
    let now = new Date();
    let revoked = false;
    const waits: number[] = [];

    const report = await work(f, {
      idleExitMs: 10_000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now = new Date(now.getTime() + ms);
        if (!revoked) {
          revoked = true;
          await f.revoke();
        }
      },
    });

    expect(waits).toHaveLength(4);
    expect(report.callsMade).toBe(1);
    expect(f.attempts(jobId)).toHaveLength(1);
    expect(f.job(jobId)).toMatchObject({ state: 'pending', waitReason: 'revoked' });
  });

  it('lets one of two starters own the project and turns the other away', async () => {
    const f = await fixture();
    await f.admit();

    const reports = await Promise.all([work(f), work(f)]);
    const owners = reports.filter((report) => report.outcome !== 'lease_held_by_other');

    expect(owners).toHaveLength(1);
    expect(reports.filter((report) => report.outcome === 'lease_held_by_other')).toHaveLength(1);
  });

  it('records the provider process group on the attempt it spawned', async () => {
    const f = await fixture();
    const { jobId } = await f.admit();

    await work(f);

    const [attempt] = f.attempts(jobId);
    const spawned = attempt.process as { pid: number; process_group_id: number | null };
    expect(spawned.pid).toBeGreaterThan(0);
    expect(spawned.process_group_id).toBe(spawned.pid);
  });

  it('cancels an active provider when recording its process fails', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'sleep' });
    await f.writeConfig({ enabled: true, timeout_ms: 10_000, max_attempts: 1 });
    const { jobId } = await f.admit();
    const startedAt = Date.now();

    await work(f, {
      recordProviderProcess: async () => {
        throw new Error('process record unavailable');
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(f.job(jobId)).toMatchObject({
      state: 'retryable_failure',
      waitReason: 'provider_failed',
    });
    expect(f.attempts(jobId)[0]).toMatchObject({
      outcome: 'failed',
      process: null,
      detail: { call: { code: 'CANCELLED' } },
    });
  });

  it('publishes nothing when a provider answer races process registration failure', async () => {
    const f = await fixture({
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    const { jobId } = await f.admit();

    await work(f, {
      recordProviderProcess: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        throw new Error('process record unavailable');
      },
    });

    expect(f.job(jobId)).toMatchObject({
      state: 'retryable_failure',
      waitReason: 'provider_failed',
    });
    expect(f.attempts(jobId)[0]).toMatchObject({
      outcome: 'failed',
      process: null,
      usage: {
        tokens: { in: 1200, out: 300 },
        cost_usd: 0.0042,
      },
      detail: {
        call: {
          code: 'CANCELLED',
          message: expect.stringContaining('process record unavailable'),
        },
      },
    });
  });

  it('keeps usage unknown when the provider reports none', async () => {
    const f = await fixture({
      provider: undefined,
      behavior: 'answer-without-usage',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    const { jobId } = await f.admit();

    await work(f);

    const [attempt] = f.attempts(jobId);
    // The provider answered but reported nothing, so the attempt carries no
    // usage at all rather than a zero that would read as a free call.
    expect(attempt.usage).toBeNull();
    const reservation = f.handle.read((view) =>
      view.get<{ state: string; reportedCostUsd: number | null }>(
        'SELECT state, reported_cost_usd AS reportedCostUsd FROM processing_usage WHERE attempt_id=?',
        attempt.attemptId
      )
    ).value;
    expect(reservation?.state).toBe('settled');
    expect(reservation?.reportedCostUsd).toBeNull();
  });
});

describe('what the worker refuses before constructing a provider', () => {
  it('refuses a revoked grant and never spawns the provider', async () => {
    const f = await fixture();
    await f.admit();
    await f.revoke();

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('revoked');
  });

  it('revalidates the exact grant after attempt admission and before provider spawn', async () => {
    const f = await fixture({
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    const { jobId } = await f.admit();

    const report = await work(f, { afterAttemptStart: () => f.revoke() });

    expect(report.callsMade).toBe(0);
    expect(providerWasSpawned(f)).toBe(false);
    expect(f.job(jobId)).toMatchObject({
      state: 'retryable_failure',
      waitReason: 'revoked',
    });
    expect(f.attempts(jobId)[0]).toMatchObject({
      outcome: 'failed',
      detail: {
        provider_started: false,
        withdrawn: { wait_reason: 'revoked' },
      },
    });
  });

  it('refuses a grant recorded for another project', async () => {
    const f = await fixture({ withoutGrant: true });
    await f.grant({ project_id: '019606f0-0000-7000-8000-00000000000a' });
    await f.admit();

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('other_project');
  });

  it('refuses a grant recorded for another provider', async () => {
    const f = await fixture({ withoutGrant: true });
    await f.grant({ provider: 'codex' });
    await f.admit();

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('other_provider');
  });

  it('refuses limits looser than the grant disclosed', async () => {
    const f = await fixture({ withoutGrant: true });
    await f.grant({
      disclosed: {
        tool_access: 'none',
        model: { selection: 'provider_default' },
        limits: {
          max_cost_usd_per_call: 'none',
          max_cost_usd_per_day: 'none',
          max_calls_per_hour: 10,
          max_input_bytes: 131_072,
          max_output_bytes: 65_536,
        },
        paused_backlog_count: 0,
      },
    });
    await f.writeConfig({ enabled: true, max_calls_per_hour: 600 });
    await f.admit();

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('limits_wider_than_disclosed');
  });

  it('never runs a job whose capture chose no model', async () => {
    const f = await fixture();
    await f.admit({ withoutModel: true });

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('awaiting_model_resume');
  });

  it('claims nothing while processing is paused project-wide', async () => {
    const f = await fixture();
    await f.admit();
    const { pauseProcessing } = await import('@orcaops/storage/history/database');
    await pauseProcessing(f.handle, {
      changedAt: new Date().toISOString(),
      changedBy: 'a person',
      changedByBasis: 'other_assertion',
      reason: 'stopped by hand',
    });

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('paused');
  });

  it('runs nothing under llm.tool: none, even with the workload enabled', async () => {
    const f = await fixture({ llm: { tool: 'none' } });
    await f.admit();

    const report = await work(f, { providerAvailability: { claude: 'absent', codex: 'absent' } });

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('llm.tool is "none"');
  });

  it('parks a job whose originating worktree is gone', async () => {
    const f = await fixture();
    await f.admit({ worktreeRoot: `${f.repoPath}-removed` });

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('is gone');
  });

  it('parks a job whose origin names a provider this machine does not have', async () => {
    const f = await fixture();
    // The origin names codex; the run's snapshot says this machine has none.
    await f.writeConfig({ enabled: true, provider: 'codex' });
    const { jobId } = await f.admit();

    const report = await work(f, {
      providerAvailability: { claude: 'present', codex: 'absent' },
    });

    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(f.job(jobId).waitReason).toBe('configuration_paused');
    expect(report.detail).toContain('codex');
  });

  it('parks a job whose worktree disabled the workload', async () => {
    const f = await fixture({ processing: { enabled: false } });
    await f.admit();

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('configuration_paused');
  });

  it('refuses an imported artifact that reached dispatch through a live path', async () => {
    const f = await fixture();
    await f.admit({ importedOrigin: true });

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('source_not_eligible');
  });

  it('refuses a job that retains no originating worktree', async () => {
    const f = await fixture();
    await f.admit({ withoutDispatchContext: true });

    const report = await work(f);

    // The spawn log is checked first: the point is that nothing was sent,
    // not merely that the refusal was reported.
    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(report.detail).toContain('dispatch_context_missing');
  });

  it('parks a refused job with its wait reason, spending none of its allowance', async () => {
    const f = await fixture();
    const { jobId } = await f.admit({ withoutDispatchContext: true });

    const report = await work(f);

    expect(report.jobsParked).toBe(1);
    const job = f.job(jobId);
    expect(job.state).toBe('pending');
    expect(job.waitReason).toBe('dispatch_context_missing');
    expect(job.retryAt).toBeNull();
    expect(f.attempts(jobId)).toHaveLength(0);
  });

  it('processes the jobs behind a refused one instead of stopping at it', async () => {
    const f = await fixture();
    // Claiming takes the oldest first, so the refused one is met first.
    const refused = await f.admit({ withoutDispatchContext: true });
    const ready = await f.admit();

    const report = await work(f);

    expect(report.outcome).toBe('idle');
    expect(report.callsMade).toBe(1);
    expect(f.job(ready.jobId).state).toBe('completed');
    expect(f.job(refused.jobId)).toMatchObject({
      state: 'pending',
      waitReason: 'dispatch_context_missing',
    });
  });

  it('parks a job whose related knowledge cannot be read, and re-examines it next run', async () => {
    const f = await fixture();
    const { jobId } = await f.admit();

    const first = await work(f, {
      retrieve: () => {
        throw new Error('the search projection could not be read');
      },
    });

    // No provider is constructed for a manifest whose related knowledge is
    // unknown: an empty related set would tell the model nothing related exists.
    expect(providerWasSpawned(f)).toBe(false);
    expect(first.callsMade).toBe(0);
    expect(f.job(jobId).waitReason).toBe('retrieval_failed');
    expect(f.attempts(jobId)).toHaveLength(0);
    expect(first.detail).toContain('the search projection could not be read');

    // The store, not the job, was the condition; the next run reads it again.
    const second = await work(f);
    expect(second.callsMade).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
  }, 40_000);

  it('records on the attempt what retrieval looked for and under which bounds', async () => {
    const f = await fixture();
    const { jobId } = await f.admit();

    await work(f);

    const [attempt] = f.attempts(jobId);
    const configuration = attempt.configuration as {
      retrieval: {
        knowledge_boundary: number;
        bounds: { maxIdentities: number; maxStatementBytes: number };
        counts: { candidates: number; included: number };
        limits: string[];
      };
    };
    expect(configuration.retrieval.knowledge_boundary).toBeGreaterThan(0);
    expect(configuration.retrieval.bounds.maxIdentities).toBeGreaterThanOrEqual(1);
    expect(configuration.retrieval.bounds.maxStatementBytes).toBeGreaterThan(0);
    expect(configuration.retrieval.counts.included).toBeLessThanOrEqual(
      configuration.retrieval.counts.candidates
    );
    expect(configuration.retrieval.limits).toContain('wording_match_bounded');
  });

  it('re-examines a job parked on a configuration reason once its origin is enabled', async () => {
    const f = await fixture({ processing: { enabled: false } });
    const { jobId } = await f.admit();

    const first = await work(f);
    expect(f.job(jobId).waitReason).toBe('configuration_paused');
    expect(first.callsMade).toBe(0);

    await f.writeConfig({ enabled: true });
    const second = await work(f);

    expect(second.callsMade).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
  }, 40_000);

  it('never re-examines a job parked on a reason nothing outside it resolves', async () => {
    const f = await fixture();
    const { jobId } = await f.admit({ withoutDispatchContext: true });

    await work(f);
    const second = await work(f);

    // The second run leaves it exactly as the first did: no dispatch decision,
    // no provider, no change.
    expect(second.jobsParked).toBe(0);
    expect(second.callsMade).toBe(0);
    expect(f.job(jobId).waitReason).toBe('dispatch_context_missing');
    expect(providerWasSpawned(f)).toBe(false);
  }, 40_000);

  it('lets `knowledge retry` free a permanently parked job', async () => {
    const f = await fixture();
    const { jobId } = await f.admit({ withoutDispatchContext: true });
    await work(f);

    await retryProcessingJob(f.handle, { jobId, now: new Date().toISOString() });

    expect(f.job(jobId).waitReason).toBeNull();
    // Still refused, and parked again rather than starving the queue.
    const after = await work(f);
    expect(after.jobsParked).toBe(1);
    expect(f.job(jobId).waitReason).toBe('dispatch_context_missing');
  }, 40_000);
});

describe('how a call that goes wrong ends', () => {
  it('finishes a job that has spent its allowance as a terminal failure', async () => {
    const f = await fixture({
      provider: FAKE_CLAUDE,
      behavior: 'budget-exceeded',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    const { jobId } = await f.admit();
    await work(f);
    expect(f.job(jobId).state).toBe('retryable_failure');

    await retryProcessingJob(f.handle, { jobId, now: new Date().toISOString() });
    const report = await work(f);

    expect(report.callsMade, report.detail).toBe(0);
    expect(f.job(jobId)).toMatchObject({
      state: 'terminal_failure',
      waitReason: null,
      result: { outcome: 'attempts_exhausted', attempts: 1, max_attempts: 1 },
    });
    expect(f.attempts(jobId)).toHaveLength(1);
  });

  it('finishes an exhausted job the same way after its allowance is lowered', async () => {
    const f = await fixture({
      provider: FAKE_CLAUDE,
      behavior: 'budget-exceeded',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 3 },
    });
    const { jobId } = await f.admit();
    const failOnce = async (): Promise<void> => {
      const stop = new AbortController();
      await work(f, { idleExitMs: 10_000, signal: stop.signal, sleep: async () => stop.abort() });
    };
    await failOnce();
    await retryProcessingJob(f.handle, { jobId, now: new Date().toISOString() });
    await failOnce();
    expect(f.attempts(jobId)).toHaveLength(2);

    await f.writeConfig({ enabled: true, max_calls_per_hour: 60, max_attempts: 1 });
    await retryProcessingJob(f.handle, { jobId, now: new Date().toISOString() });
    const report = await work(f);

    expect(report.callsMade, report.detail).toBe(0);
    expect(f.job(jobId), report.detail).toMatchObject({
      state: 'terminal_failure',
      result: { outcome: 'attempts_exhausted', attempts: 2, max_attempts: 1 },
    });
  });

  it('completes a job that gave up once a person reopens it', async () => {
    const f = await fixture({ proposerAnswer: 'wrong-manifest' });
    const { jobId } = await f.admit();
    await work(f);
    expect(f.job(jobId).state).toBe('terminal_failure');

    await reopen(f, jobId, 3);
    const report = await work(f, { env: { ...f.env, FAKE_PROPOSER_ANSWER: 'statement' } });

    expect(report.callsMade, report.detail).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
    expect(f.attempts(jobId).map((attempt) => attempt.attemptNumber)).toEqual([2, 1]);
  });

  it('gives up again after the approved allowance even when configuration later allows more', async () => {
    const f = await fixture({
      provider: FAKE_CLAUDE,
      behavior: 'budget-exceeded',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    const { jobId } = await f.admit();
    const failOnce = async (): Promise<KnowledgeWorkerReport> => {
      const stop = new AbortController();
      return work(f, { idleExitMs: 10_000, signal: stop.signal, sleep: async () => stop.abort() });
    };
    await failOnce();
    await retryProcessingJob(f.handle, { jobId, now: new Date().toISOString() });
    await work(f);
    expect(f.job(jobId).state).toBe('terminal_failure');

    await reopen(f, jobId, 1);
    await f.writeConfig({ enabled: true, max_calls_per_hour: 60, max_attempts: 3 });
    expect((await failOnce()).callsMade).toBe(1);
    await retryProcessingJob(f.handle, { jobId, now: new Date().toISOString() });
    const report = await work(f);

    expect(report.callsMade, report.detail).toBe(0);
    expect(f.job(jobId), report.detail).toMatchObject({
      state: 'terminal_failure',
      result: { outcome: 'attempts_exhausted', attempts: 1, max_attempts: 1 },
    });
    expect(f.attempts(jobId)).toHaveLength(2);
  });

  describe('finishes an exhausted job instead of parking it', () => {
    async function exhausted(): Promise<{ f: WorkerFixture; jobId: string; eventId: string }> {
      const f = await fixture({
        provider: FAKE_CLAUDE,
        behavior: 'budget-exceeded',
        processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
      });
      const { jobId, eventId } = await f.admit();
      await work(f);
      expect(f.job(jobId).state).toBe('retryable_failure');
      await retryProcessingJob(f.handle, { jobId, now: new Date().toISOString() });
      return { f, jobId, eventId };
    }

    const finishedAsExhausted = {
      state: 'terminal_failure',
      waitReason: null,
      result: { outcome: 'attempts_exhausted', attempts: 1, max_attempts: 1 },
    };

    it('when its related knowledge cannot be read', async () => {
      const { f, jobId } = await exhausted();

      const report = await work(f, {
        retrieve: () => {
          throw new Error('the search projection could not be read');
        },
      });

      expect(report.callsMade, report.detail).toBe(0);
      expect(f.job(jobId), report.detail).toMatchObject(finishedAsExhausted);
    }, 40_000);

    it('when its grant was revoked', async () => {
      const { f, jobId } = await exhausted();
      await f.revoke();

      const report = await work(f);

      expect(report.callsMade, report.detail).toBe(0);
      expect(f.job(jobId), report.detail).toMatchObject(finishedAsExhausted);
    }, 40_000);

    it('when a field its schedule froze has since been restricted', async () => {
      const { f, jobId, eventId } = await exhausted();
      await publishProjectKnowledgeSource(f.handle, {
        operationId: uuidv7(),
        source: {
          source_id: uuidv7(),
          occurrence: {
            kind: 'capture_field',
            artifact_id: f.artifactId,
            event_id: eventId,
            field_path: 'task',
            position: 0,
          },
          source_author: { identity: 'the project owner', basis: 'authenticated' },
          interpreted_by: null,
          access_restriction: 'owner only',
        },
        recordedBy: { identity: 'the project owner', basis: 'authenticated' },
        secretAllow: [],
      });

      const report = await work(f);

      expect(report.callsMade, report.detail).toBe(0);
      expect(f.job(jobId), report.detail).toMatchObject(finishedAsExhausted);
    }, 40_000);

    it('but still parks it when its configuration cannot be resolved', async () => {
      const { f, jobId } = await exhausted();
      await f.writeConfig({ enabled: false });

      const report = await work(f);

      expect(report.callsMade, report.detail).toBe(0);
      expect(f.job(jobId), report.detail).toMatchObject({
        state: 'pending',
        waitReason: 'configuration_paused',
      });
    }, 40_000);
  });

  it('ends a timed-out call as a retryable failure with a diagnosis', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'sleep' });
    await f.writeConfig({ enabled: true, timeout_ms: 10_000, max_attempts: 1 });
    const { jobId } = await f.admit();

    await work(f);

    const job = f.job(jobId);
    expect(job.state).toBe('retryable_failure');
    expect(job.waitReason).toBe('provider_failed');
    expect(job.retryAt).not.toBeNull();
    const [attempt] = f.attempts(jobId);
    expect(attempt.outcome).toBe('failed');
    expect((attempt.detail as { call: { code: string } }).call.code).toBe('TIMEOUT');
  }, 40_000);

  it('ends an oversized answer as a terminal failure, not a completion', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'flood-without-newline' });
    await f.writeConfig({ enabled: true, max_output_bytes: 1024 });
    const { jobId } = await f.admit();

    await work(f);

    const job = f.job(jobId);
    expect(job.state).toBe('terminal_failure');
    expect((job.result as { call: { code: string } }).call.code).toBe('OUTPUT_TOO_LARGE');
  }, 40_000);

  it('settles a valid envelope whose malformed item is rejected locally', async () => {
    const f = await fixture({ proposerAnswer: 'invalid' });
    const { jobId } = await f.admit();

    await work(f);

    const job = f.job(jobId);
    expect(job.state).toBe('completed');
    expect(job.waitReason).toBeNull();
    expect(job.result).toMatchObject({
      interpretation_quality: { outcome: 'all_rejected' },
    });
    const [attempt] = f.attempts(jobId);
    expect((attempt.detail as { rejected_items: { rule: string }[] }).rejected_items[0].rule).toBe(
      'ITEM_SCHEMA_INVALID'
    );
  });

  it('terminates an answer about a manifest that was never asked for', async () => {
    const f = await fixture({ proposerAnswer: 'wrong-manifest' });
    const { jobId } = await f.admit();

    await work(f);

    expect(f.job(jobId)).toMatchObject({ state: 'terminal_failure', waitReason: null });
    expect((f.attempts(jobId)[0].detail as { failures: { rule: string }[] }).failures[0].rule).toBe(
      'MANIFEST_MISMATCH'
    );
  });

  it('ends a spend refusal from the provider as a retryable failure', async () => {
    const f = await fixture({
      provider: FAKE_CLAUDE,
      behavior: 'budget-exceeded',
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    const { jobId } = await f.admit();

    await work(f);

    const job = f.job(jobId);
    expect(job.state).toBe('retryable_failure');
    expect((f.attempts(jobId)[0].detail as { call: { code: string } }).call.code).toBe(
      'BUDGET_EXCEEDED'
    );
  });

  it('settles a plan that publishes nothing as a completion', async () => {
    const f = await fixture({ proposerAnswer: 'empty' });
    const { jobId } = await f.admit();

    await work(f);

    const job = f.job(jobId);
    expect(job.state).toBe('completed');
    expect(
      (job.result as { reconciliation_plan: { records: unknown[] } }).reconciliation_plan.records
    ).toEqual([]);
  });

  it('waits out a condition local to this machine, without pausing the project', async () => {
    const f = await fixture({
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    const { jobId } = await f.admit();

    // The call would run inside a git working tree, which it refuses. The
    // machine is what is wrong, not the job and not the project.
    const report = await work(f, { scratchParentDir: f.repoPath });

    expect(providerWasSpawned(f)).toBe(false);
    expect(report.outcome).toBe('idle');
    expect(readProcessingControl(f.handle)?.paused ?? false).toBe(false);
    const job = f.job(jobId);
    expect(job.state).toBe('retryable_failure');
    expect(job.waitReason).toBe('provider_environment');
    expect(job.retryAt).not.toBeNull();
  }, 40_000);

  it('pauses the project when the same local condition ends three attempts in a row', async () => {
    const f = await fixture({
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    // Three jobs, so one run meets the same condition three times.
    await f.admit();
    await f.admit();
    const third = await f.admit();

    const report = await work(f, { scratchParentDir: f.repoPath });

    expect(report.outcome).toBe('workload_paused');
    const control = readProcessingControl(f.handle);
    expect(control?.paused).toBe(true);
    expect(control?.reason).toContain('3 attempts in a row on this machine');
    expect(control?.reason).toContain('WORKING_DIRECTORY_IN_REPOSITORY');
    expect(f.job(third.jobId).waitReason).toBe('provider_environment');
  }, 60_000);

  for (const [behavior, code] of [
    ['tool-use', 'TOOL_USE_OBSERVED'],
    ['init-lists-tools', 'TOOLS_AVAILABLE'],
    ['init-without-tool-list', 'NO_TOOL_MODE_UNCONFIRMED'],
  ] as const) {
    it(`pauses the workload when the provider answers with ${code}`, async () => {
      const f = await fixture({ provider: FAKE_CLAUDE, behavior });
      const { jobId } = await f.admit();
      await f.admit();

      const report = await work(f);

      expect(report.outcome).toBe('workload_paused');
      // The second job is never attempted: the pause stops claiming at once.
      expect(report.callsMade).toBe(1);
      expect(readProcessingControl(f.handle)?.paused).toBe(true);
      expect(f.job(jobId).waitReason).toBe('no_tool_guarantee');
      expect((f.attempts(jobId)[0].detail as { call: { code: string } }).call.code).toBe(code);
    }, 40_000);
  }

  it('still pauses the workload on a tool-use failure whose process was not recorded', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'tool-use' });
    const { jobId } = await f.admit();

    const report = await work(f, {
      recordProviderProcess: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        throw new Error('process record unavailable');
      },
    });

    expect(report.outcome).toBe('workload_paused');
    expect(f.job(jobId).waitReason).toBe('no_tool_guarantee');
    expect(f.attempts(jobId)[0]).toMatchObject({
      detail: {
        call: {
          code: 'TOOL_USE_OBSERVED',
          message: expect.stringContaining('process record unavailable'),
        },
      },
    });
  }, 40_000);
});

describe('shared accounting and ownership', () => {
  it('parks a job on the hourly window without spending its attempt allowance', async () => {
    const f = await fixture();
    await f.writeConfig({ enabled: true, max_calls_per_hour: 1 });
    const first = await f.admit();
    const second = await f.admit();

    const report = await work(f);

    expect(report.callsMade).toBe(1);
    expect(f.job(first.jobId).state).toBe('completed');
    const parked = f.job(second.jobId);
    expect(parked.state).toBe('retryable_failure');
    expect(parked.waitReason).toBe('calls_per_hour');
    expect(parked.retryAt).not.toBeNull();
    expect(f.attempts(second.jobId)).toHaveLength(0);
  }, 40_000);

  it('takes no call of the hour for a job with nothing to interpret', async () => {
    const f = await fixture();
    await f.writeConfig({ enabled: true, max_calls_per_hour: 1 });
    const interpreted = await f.admit();
    // A passage of whitespace is retained bytes with nothing authored in them,
    // which is the source the worker decides without asking a provider.
    const nothing = await f.admit({ task: '   ' });

    const report = await work(f);

    expect(report.callsMade).toBe(1);
    expect(f.job(interpreted.jobId).state).toBe('completed');
    // The hour's one call went to the job that made one. This job makes none,
    // so the spent window does not hold it.
    const completed = f.job(nothing.jobId);
    expect(completed.state).toBe('completed');
    expect(completed.result).toMatchObject({ outcome: 'nothing_to_interpret' });
    const [attempt] = f.attempts(nothing.jobId);
    expect(attempt.outcome).toBe('succeeded');
    const reservations = f.handle.read((view) =>
      view.get<{ held: number }>(
        'SELECT count(*) AS held FROM processing_usage WHERE attempt_id=?',
        attempt.attemptId
      )
    ).value;
    expect(reservations?.held).toBe(0);
  }, 40_000);

  it('lets one worktree’s lower limit restrict only its own jobs', async () => {
    const f = await fixture();
    const restricted = await f.addWorktree('restricted', {
      enabled: true,
      max_calls_per_hour: 1,
    });
    const permissive = await f.admit();
    const limited = await f.admit({ worktreeRoot: restricted });
    const alsoPermissive = await f.admit();

    const report = await work(f);

    expect(report.callsMade).toBe(2);
    expect(f.job(permissive.jobId).state).toBe('completed');
    expect(f.job(alsoPermissive.jobId).state).toBe('completed');
    const parked = f.job(limited.jobId);
    expect(parked.state).toBe('retryable_failure');
    expect(parked.waitReason).toBe('calls_per_hour');
  }, 40_000);

  it('refuses a superseded owner’s settlement and leaves its attempt open', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'sleep' });
    await f.writeConfig({ enabled: true, timeout_ms: 10_000 });
    const { jobId } = await f.admit();

    const running = work(f, { leaseTermMs: 1_000, heartbeatMs: 100 });
    await waitFor(() => existsSync(f.providerStartedMarker));
    // A takeover after the lease expired, exactly as a second worker performs
    // it: the generation moves, so nothing the first owner writes is accepted.
    const takeover = await takeProcessingLease(f.handle, {
      ownerId: 'a-later-worker',
      now: new Date(Date.now() + 2_000).toISOString(),
      expiresAt: new Date(Date.now() + 4_000).toISOString(),
      maxTermMs: 2_000,
    });
    expect(takeover.outcome).toBe('taken');

    const report = await running;

    expect(report.outcome).toBe('lost_lease');
    const [attempt] = f.attempts(jobId);
    expect(attempt.outcome).toBeNull();
    expect(f.job(jobId).state).toBe('running');
    const reservation = f.handle.read((view) =>
      view.get<{ state: string }>(
        'SELECT state FROM processing_usage WHERE attempt_id=?',
        attempt.attemptId
      )
    ).value;
    expect(reservation?.state).toBe('reserved');
  }, 40_000);

  it('cancels an active call when the workload is disabled, and starts no other', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'sleep' });
    await f.writeConfig({ enabled: true, timeout_ms: 10_000, max_attempts: 1 });
    const first = await f.admit();
    const second = await f.admit();

    const running = work(f, { revalidateMs: 100 });
    await waitFor(() => existsSync(f.providerStartedMarker));
    await f.writeConfig({ enabled: false });

    const report = await running;

    expect(report.callsMade).toBe(1);
    const cancelled = f.job(first.jobId);
    expect(cancelled.state).toBe('retryable_failure');
    // Settlement judged the configuration again and found it withdrawn, so the
    // job waits on that rather than on the cancelled call.
    expect(cancelled.waitReason).toBe('configuration_paused');
    expect(f.attempts(first.jobId)[0].detail).toMatchObject({
      call: { code: 'CANCELLED' },
      withdrawn: { wait_reason: 'configuration_paused' },
    });
    expect(f.attempts(second.jobId)).toHaveLength(0);
  }, 40_000);

  it('does not let a replacement grant rescue the active call', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'sleep' });
    await f.writeConfig({ enabled: true, timeout_ms: 10_000, max_attempts: 1 });
    const first = await f.admit();

    const running = work(f, { revalidateMs: 100 });
    await waitFor(() => existsSync(f.providerStartedMarker));
    await f.grant();

    const report = await running;

    expect(report.callsMade).toBe(1);
    const [attempt] = f.attempts(first.jobId);
    expect(attempt.detail).toMatchObject({
      call: { code: 'CANCELLED' },
      withdrawn: { wait_reason: 'revoked' },
    });
    // Whatever the provider said it spent is still on the attempt: a revoked
    // grant stops the next call, it does not unspend this one.
    expect(attempt.outcome).toBe('failed');
    const reservation = f.handle.read((view) =>
      view.get<{ state: string }>(
        'SELECT state FROM processing_usage WHERE attempt_id=?',
        attempt.attemptId
      )
    ).value;
    expect(reservation?.state).toBe('settled');
  }, 40_000);

  it('cancels an active call when a newly tighter bound cannot constrain it', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'sleep' });
    await f.writeConfig({
      enabled: true,
      timeout_ms: 10_000,
      max_output_bytes: 65_536,
      max_attempts: 1,
    });
    const { jobId } = await f.admit();

    const running = work(f, { revalidateMs: 100 });
    await waitFor(() => existsSync(f.providerStartedMarker));
    await f.writeConfig({
      enabled: true,
      timeout_ms: 10_000,
      max_output_bytes: 1024,
      max_attempts: 1,
    });

    const report = await running;

    expect(report.callsMade).toBe(1);
    expect(f.job(jobId)).toMatchObject({
      state: 'retryable_failure',
      waitReason: 'execution_terms_changed',
    });
    expect(f.attempts(jobId)[0].detail).toMatchObject({
      call: { code: 'CANCELLED' },
      withdrawn: { wait_reason: 'execution_terms_changed' },
    });
  }, 40_000);

  it('publishes nothing when the grant is withdrawn between the answer and the settlement', async () => {
    const f = await fixture({
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    const { jobId } = await f.admit();
    const grantFile = path.join(f.configHome, 'knowledge-processing-grants.json');

    // The provider revokes the grant itself, just before it answers, so the
    // withdrawal lands in the one window nothing else can reach: after the call
    // was paid for and before its result is settled. The watchdog is set beyond
    // the call's own life so nothing but the settlement can see it.
    const report = await work(f, {
      env: { ...f.env, FAKE_PROPOSER_REVOKE_GRANTS: grantFile },
      revalidateMs: 600_000,
    });

    expect(report.callsMade).toBe(1);
    const job = f.job(jobId);
    expect(job.state).toBe('retryable_failure');
    expect(job.waitReason).toBe('revoked');
    // Nothing the answer proposed is carried forward: it was prepared under an
    // authorization that no longer holds. Counting the rows is what says so — the
    // publication is behind the revalidation, and moving it ahead would leave
    // every assertion about the attempt passing.
    expect(f.knowledgeRows()).toBe(0);
    expect(job.result).toBeNull();
    const [attempt] = f.attempts(jobId);
    expect(attempt.outcome).toBe('failed');
    expect(attempt.detail).not.toHaveProperty('reconciliation_plan');
    expect(attempt.detail).toMatchObject({ withdrawn: { wait_reason: 'revoked' } });
    // The call happened, so its spend is real and stays counted.
    expect(attempt.usage).toMatchObject({ cost_usd: 0.0042 });
    const reservation = f.handle.read((view) =>
      view.get<{ state: string; reportedCostUsd: number | null }>(
        'SELECT state, reported_cost_usd AS reportedCostUsd FROM processing_usage WHERE attempt_id=?',
        attempt.attemptId
      )
    ).value;
    expect(reservation).toMatchObject({ state: 'settled', reportedCostUsd: 0.0042 });
  }, 40_000);

  it('revalidates permission immediately before an uncontended publication', async () => {
    const f = await fixture({
      processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
    });
    const { jobId } = await f.admit();

    const report = await work(f, {
      beforePublication: () => {
        const grantFile = path.join(f.configHome, 'knowledge-processing-grants.json');
        const store = JSON.parse(readFileSync(grantFile, 'utf8')) as {
          grants: Record<string, unknown>[];
        };
        const revoked_at = new Date().toISOString();
        store.grants = store.grants.map((grant) => ({ ...grant, revoked_at }));
        writeFileSync(grantFile, `${JSON.stringify(store, null, 2)}\n`);
      },
    });

    expect(report.callsMade).toBe(1);
    expect(f.job(jobId)).toMatchObject({
      state: 'retryable_failure',
      waitReason: 'revoked',
      result: null,
    });
    expect(f.attempts(jobId)[0].detail).toMatchObject({
      unit_settled: false,
      withdrawn: { wait_reason: 'revoked' },
    });
    expect(f.knowledgeRows()).toBe(0);
  }, 40_000);

  it('finishes after an in-flight lease renewal outlives publication', async () => {
    const f = await fixture();
    const { jobId } = await f.admit();
    let renewalEntered!: () => void;
    const renewalStarted = new Promise<void>((resolve) => {
      renewalEntered = resolve;
    });
    let renewalCancelled = false;

    const report = await work(f, {
      heartbeatMs: 1,
      renewLease: async (signal) => {
        renewalEntered();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        renewalCancelled = signal.aborted;
      },
      beforePublication: () => renewalStarted,
    });

    expect(report.callsMade).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
    expect(f.knowledgeRows()).toBeGreaterThan(0);
    expect(renewalCancelled).toBe(true);
  }, 40_000);

  it.each([
    ['an authored result', 'statement'],
    ['a no-new-row result', 'empty'],
  ] as const)(
    'revalidates permission after publication waits for %s',
    async (_description, proposerAnswer) => {
      const f = await fixture({
        proposerAnswer,
        processing: { enabled: true, max_calls_per_hour: 60, max_attempts: 1 },
      });
      const { jobId } = await f.admit();
      const blocker = new Database(f.handle.databasePath);
      let waits = 0;
      try {
        const running = work(f, {
          beforePublication: () => {
            blocker.exec('BEGIN IMMEDIATE');
          },
          onPublicationWait: () => {
            waits += 1;
            const grantFile = path.join(f.configHome, 'knowledge-processing-grants.json');
            const store = JSON.parse(readFileSync(grantFile, 'utf8')) as {
              grants: Record<string, unknown>[];
            };
            const revoked_at = new Date().toISOString();
            store.grants = store.grants.map((grant) => ({ ...grant, revoked_at }));
            writeFileSync(grantFile, `${JSON.stringify(store, null, 2)}\n`);
            blocker.exec('COMMIT');
          },
        });

        const report = await running;

        expect(report.callsMade).toBe(1);
        expect(waits).toBe(1);
        expect(f.job(jobId)).toMatchObject({
          state: 'retryable_failure',
          waitReason: 'revoked',
          result: null,
        });
        expect(f.attempts(jobId)[0].detail).toMatchObject({
          unit_settled: false,
          withdrawn: { wait_reason: 'revoked' },
        });
        expect(f.knowledgeRows()).toBe(0);
      } finally {
        if (blocker.inTransaction) blocker.exec('ROLLBACK');
        blocker.close();
      }
    },
    40_000
  );

  it('writes neither the grant file nor the configuration', async () => {
    const f = await fixture();
    await f.admit();
    const grantFile = path.join(f.configHome, 'knowledge-processing-grants.json');
    const configFile = path.join(f.repoPath, '.orcaops', 'config.json');
    const before = [await readFile(grantFile), await readFile(configFile)];

    await work(f);

    expect([await readFile(grantFile), await readFile(configFile)]).toEqual(before);
  });
});

describe('recovering what a lost owner left', () => {
  it('settles a lost attempt as unknown, keeping its whole conservative hold', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'sleep' });
    await f.writeConfig({ enabled: true, timeout_ms: 10_000, max_attempts: 1 });
    const { jobId } = await f.admit();

    const lost = work(f, { leaseTermMs: 1_000, heartbeatMs: 100 });
    await waitFor(() => existsSync(f.providerStartedMarker));
    const takeover = await takeProcessingLease(f.handle, {
      ownerId: 'a-later-worker',
      now: new Date(Date.now() + 2_000).toISOString(),
      expiresAt: new Date(Date.now() + 4_000).toISOString(),
      maxTermMs: 2_000,
    });
    await lost;
    if (takeover.outcome !== 'taken') throw new Error('the takeover did not happen');
    await releaseProcessingLease(f.handle, {
      ownerId: 'a-later-worker',
      generation: takeover.lease.ownerGeneration,
    });

    // The call's bounded lifetime has elapsed for this owner, so the attempt
    // it could not settle is settled as unknown rather than as a failure.
    const recovered = await work(f, { callLifetimeMs: 1 });

    const [attempt] = f.attempts(jobId);
    expect(attempt.outcome).toBe('unknown');
    expect(attempt.usage).toBeNull();
    const reservation = f.handle.read((view) =>
      view.get<{ state: string; reportedCostUsd: number | null }>(
        'SELECT state, reported_cost_usd AS reportedCostUsd FROM processing_usage WHERE attempt_id=?',
        attempt.attemptId
      )
    ).value;
    expect(reservation?.state).toBe('unknown');
    expect(reservation?.reportedCostUsd).toBeNull();
    const job = f.job(jobId);
    expect(job.state).toBe('retryable_failure');
    expect(job.waitReason).toBe('call_result_unknown');
    expect(job.retryAt).not.toBeNull();
    // The lost call was the job's first attempt, and the recovering owner made
    // no second one: an unknown result is not a free retry. A lost call publishes
    // nothing whatever it answered, which the rows are what says.
    expect(recovered.callsMade).toBe(0);
    expect(f.attempts(jobId)).toHaveLength(1);
    expect(f.knowledgeRows()).toBe(0);
  }, 40_000);

  it('makes no replacement call while a lost call may still be running', async () => {
    const f = await fixture();
    const { jobId } = await f.admit();
    // An owner that died between starting its attempt and spawning the provider:
    // the attempt is open, nothing is recorded to terminate, and no observation
    // can say the call is over. Only the bound can.
    const lost = await takeProcessingLease(f.handle, {
      ownerId: 'a-lost-worker',
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      maxTermMs: 1_000,
    });
    if (lost.outcome !== 'taken') throw new Error('the lease was not taken');
    const generation = lost.lease.ownerGeneration;
    await claimProcessingJob(f.handle, { generation, now: new Date().toISOString() });
    const job = f.job(jobId);
    const permission = {
      v: 1 as const,
      confirmation_id: null,
      confirmed_terms: null,
      execution_terms: {
        v: 1 as const,
        project_id: f.handle.authority.projectId,
        job_id: jobId,
        source: job.source,
        origin: { worktree_root: f.repoPath },
        processor_contract: job.processorContract,
        provider: { id: 'claude' as const, selection: 'explicit' as const },
        model: { selection: 'explicit' as const, id: 'fixture-model' },
        effort: { selection: 'provider_default' as const, value: null },
        tool_access: 'none' as const,
        limits: {
          max_cost_usd_per_call: 'none' as const,
          max_cost_usd_per_day: 'none' as const,
          max_calls_per_hour: 60,
          max_input_bytes: 131072,
          max_output_bytes: 65536,
        },
        output_token_cap: { kind: 'none' as const },
        timeout_ms: 120000,
        max_attempts: 3,
      },
      attempt_grant_id: 'a-grant',
    };
    const started = await startProcessingAttempt(f.handle, {
      generation,
      jobId,
      attemptId: uuidv7(),
      usageId: uuidv7(),
      startedAt: new Date().toISOString(),
      maxAttempts: 3,
      maxCallsPerHour: 60,
      configurationIdentity: 'c'.repeat(64),
      configuration: { model: 'whatever it was', permission },
      confirmationId: null,
      grantId: 'a-grant',
    });
    if (started.outcome !== 'started') throw new Error('the attempt did not start');
    await releaseProcessingLease(f.handle, { ownerId: 'a-lost-worker', generation });

    const recovered = await work(f, { callLifetimeMs: 3_600_000 });

    expect(recovered.callsMade).toBe(0);
    expect(providerWasSpawned(f)).toBe(false);
    expect(recovered.outcome).toBe('idle');
    // Which of the two waits this is: nothing was recorded to watch, so only
    // the lifetime can end it.
    expect(recovered.detail).toContain('recorded no provider process');
    expect(f.attempts(jobId)).toHaveLength(1);
    expect(f.attempts(jobId)[0].outcome).toBeNull();
    expect(f.job(jobId).state).toBe('running');
  }, 40_000);

  it('settles a lost call at once when it watched the provider go', async () => {
    const f = await fixture({ provider: FAKE_CLAUDE, behavior: 'sleep' });
    await f.writeConfig({ enabled: true, timeout_ms: 10_000, max_attempts: 1 });
    const { jobId } = await f.admit();

    const lost = work(f, { leaseTermMs: 1_000, heartbeatMs: 100 });
    await waitFor(() => existsSync(f.providerStartedMarker));
    const takeover = await takeProcessingLease(f.handle, {
      ownerId: 'a-later-worker',
      now: new Date(Date.now() + 2_000).toISOString(),
      expiresAt: new Date(Date.now() + 4_000).toISOString(),
      maxTermMs: 2_000,
    });
    await lost;
    if (takeover.outcome !== 'taken') throw new Error('the takeover did not happen');
    await releaseProcessingLease(f.handle, {
      ownerId: 'a-later-worker',
      generation: takeover.lease.ownerGeneration,
    });

    // The bound is an hour; the provider is already gone, and watching it go is
    // better evidence than the bound.
    const recovered = await work(f, { callLifetimeMs: 3_600_000 });

    expect(recovered.detail).toContain('confirmed gone');
    const [attempt] = f.attempts(jobId);
    expect(attempt.outcome).toBe('unknown');
    expect(attempt.usage).toBeNull();
    expect(f.job(jobId)).toMatchObject({
      state: 'retryable_failure',
      waitReason: 'call_result_unknown',
    });
  }, 40_000);
});

describe('a source larger than one call', () => {
  it('carries it unit by unit and completes the job only at the last one', async () => {
    const long = 'A sentence a technician would read about saving notes.\n'.repeat(4_000);
    const f = await fixture({ task: long });
    await f.writeConfig({
      enabled: true,
      max_attempts: 8,
      max_input_bytes: 100_000,
    });
    const { jobId } = await f.admit({ task: long });

    const report = await work(f);

    const attempts = f.attempts(jobId).reverse();
    expect(attempts.length).toBeGreaterThan(1);
    expect(report.callsMade).toBe(attempts.length);
    for (const attempt of attempts.slice(0, -1)) {
      const detail = attempt.detail as {
        unit: { index: number };
        interpretation_unit_receipt: { unit_index: number };
      };
      expect(detail.interpretation_unit_receipt.unit_index).toBe(detail.unit.index);
      expect(attempt.outcome).toBe('failed');
    }
    expect(attempts.at(-1)!.outcome).toBe('succeeded');
    const job = f.job(jobId);
    expect(job.state).toBe('completed');
    expect(job.result).toMatchObject({
      coverage: { settled_units: attempts.length, unfinished_unit_ids: [] },
    });
  }, 60_000);

  it('spends one call per unit and finishes within the exact allowance', async () => {
    const long = 'A sentence a technician would read about saving notes.\n'.repeat(4_000);
    const f = await fixture({ task: long });
    await f.writeConfig({
      enabled: true,
      max_attempts: 8,
      max_input_bytes: 100_000,
    });
    const { jobId } = await f.admit({ task: long });

    const report = await work(f);

    const attempts = f.attempts(jobId);
    expect(attempts.length).toBeGreaterThan(1);
    expect(report.callsMade).toBe(attempts.length);
    const job = f.job(jobId);
    expect(job.state).toBe('completed');
    expect(JSON.stringify(job.result)).not.toContain('Nothing was sent');
  }, 90_000);
});
