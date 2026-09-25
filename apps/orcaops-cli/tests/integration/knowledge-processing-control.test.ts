import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  claimProcessingJob,
  ProcessingDispatchContextSchema,
  type ProcessingJob,
  type ProjectDatabase,
  releaseProcessingLease,
  settleProcessingAttempt,
  settleProcessingCall,
  startProcessingAttempt,
  takeProcessingLease,
} from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { processingGrantsFilePath } from '../../src/lib/knowledge-processing-grants.js';
import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * `orcaops knowledge pause`, `resume`, `retry` and what `status` reports back,
 * against a real project database holding real admitted jobs.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;

function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 120_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'control-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: f.temporary + '/unused-state',
    },
  });
}

/** Every file a write would land in, absent ones as an explicit absence. */
async function bytes(databasePath: string, grantStore: string) {
  const files = [databasePath, `${databasePath}-wal`, grantStore];
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [file, await readFile(file).catch(() => null)] as const)
    )
  );
}

async function json(f: Fixture, args: string[]) {
  const raw = await agent(f).runRaw(args);
  return { raw, data: JSON.parse(raw.stdout) as Record<string, unknown> };
}

/** Every knowledge verb reads the configuration that governs this checkout. */
async function writeConfig(f: Fixture) {
  await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(f.main, '.orcaops', 'config.json'),
    JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm: { tool: 'none' } }),
    'utf8'
  );
}

async function capturePlan(f: Fixture, extraArgs: string[] = []) {
  const raw = await agent(f).runRaw([
    'capture',
    'plan',
    ...extraArgs,
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `plan-${randomUUID()}`,
        task: 'Retain what a capture means',
        label: 'Control surface',
        plan_steps: [
          {
            text: 'park a job and free it again',
            label: 'Parking',
            acceptance_criteria: [{ text: 'a parked job becomes due' }],
          },
        ],
        touched_scope: ['storage'],
      })
    ),
  ]);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout) as { artifact_id: string; plan_event_id: string };
}

function jobs(handle: ProjectDatabase) {
  return handle.read((view) =>
    view.all<{ jobId: string; state: string; waitReason: string | null; retryAt: string | null }>(
      `SELECT job_id AS jobId, state, wait_reason AS waitReason, retry_at AS retryAt
        FROM processing_jobs ORDER BY admitted_at, job_id`
    )
  ).value;
}

/** Park the one admitted job on a retry a day away, as a failed call would. */
async function parkTheJob(handle: ProjectDatabase, outcome: 'retryable' | 'terminal') {
  const now = new Date().toISOString();
  const lease = await takeProcessingLease(handle, {
    ownerId: uuidv7(),
    now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxTermMs: 120_000,
  });
  if (lease.outcome !== 'taken') throw new Error('The fixture could not take the lease');
  const generation = lease.lease.ownerGeneration;
  const claim = await claimProcessingJob(handle, { generation, now });
  if (claim.outcome !== 'claimed') throw new Error(`Nothing was claimable: ${claim.reason}`);
  const admission = claim.job.admission as { context?: unknown } | null;
  const context = ProcessingDispatchContextSchema.parse(admission?.context);
  const attemptId = uuidv7();
  const usageId = uuidv7();
  const grantId = uuidv7();
  const permission = {
    v: 1 as const,
    confirmation_id: null,
    confirmed_terms: null,
    execution_terms: {
      v: 1 as const,
      project_id: handle.authority.projectId,
      job_id: claim.job.jobId,
      source: claim.job.source,
      origin: context.origin,
      processor_contract: claim.job.processorContract,
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
    attempt_grant_id: grantId,
  };
  const started = await startProcessingAttempt(handle, {
    generation,
    jobId: claim.job.jobId,
    attemptId,
    usageId,
    startedAt: now,
    maxAttempts: 3,
    configurationIdentity: 'a'.repeat(64),
    configuration: { provider: 'claude', permission },
    confirmationId: null,
    grantId,
    maxCallsPerHour: 60,
  });
  if (started.outcome !== 'started') throw new Error('The fixture attempt did not start');
  // The call is settled before the attempt, as the worker does: an attempt cannot be settled
  // while its reservation is still held.
  await settleProcessingCall(handle, {
    generation,
    usageId,
    settledAt: now,
    result: { kind: 'unknown' },
  });
  const settled = await settleProcessingAttempt(handle, {
    generation,
    jobId: claim.job.jobId,
    attemptId,
    finishedAt: now,
    usage: null,
    outcome:
      outcome === 'retryable'
        ? {
            kind: 'retryable_failure',
            waitReason: 'provider_unavailable',
            retryAt: new Date(Date.now() + 86_400_000).toISOString(),
          }
        : { kind: 'terminal_failure', result: { reason: 'the source could not be read' } },
  });
  await releaseProcessingLease(handle, { ownerId: lease.lease.ownerId!, generation });
  return settled.job satisfies ProcessingJob;
}

describe('the background processing control surface', { timeout: 180_000 }, () => {
  it('pauses with a reason and an honest actor, reports it, and resumes without touching a job', async () => {
    const f = await fixture();
    await writeConfig(f);
    await capturePlan(f);
    const before = jobs(f.writer);
    expect(before).toHaveLength(1);

    const paused = await json(f, ['knowledge', 'pause', '--reason', 'the model is down', '--json']);
    expect(paused.raw.exitCode, paused.raw.stdout + paused.raw.stderr).toBe(0);
    expect(paused.data).toMatchObject({
      paused: true,
      control: { paused: true, reason: 'the model is down' },
    });
    // Nothing local authenticates who typed this, and the record says so.
    const control = paused.data.control as { changedBy: string | null; changedByBasis: string };
    expect(control.changedByBasis).toBe('other_assertion');
    expect(control.changedBy).toBeTruthy();
    expect(jobs(f.writer)).toEqual(before);

    const status = await json(f, ['knowledge', 'status', '--json']);
    expect(status.data).toMatchObject({
      queue: { jobs: { pending: 1 }, awaitingModelResume: 0 },
      control: { paused: true, reason: 'the model is down' },
      backlog: { paused_jobs: 1 },
    });

    const resumed = await json(f, ['knowledge', 'resume', '--json']);
    expect(resumed.data).toMatchObject({ paused: false, control: { paused: false } });
    expect(jobs(f.writer)).toEqual(before);
  });

  it('refuses to pause without a reason', async () => {
    const f = await fixture();
    await writeConfig(f);
    const refused = await agent(f).runRaw(['knowledge', 'pause', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('--reason');
  });

  it('makes a parked job due now, and leaves a job that gave up to a person at a terminal', async () => {
    const f = await fixture();
    await writeConfig(f);
    await capturePlan(f);
    const parked = await parkTheJob(f.writer, 'retryable');
    expect(parked.state).toBe('retryable_failure');
    expect(jobs(f.writer)[0]!.retryAt).not.toBeNull();

    const retried = await json(f, ['knowledge', 'retry', '--json']);
    expect(retried.data).toMatchObject({
      retried: [{ job_id: parked.jobId, outcome: 'due' }],
    });
    const due = jobs(f.writer)[0]!;
    expect(Date.parse(due.retryAt!)).toBeLessThanOrEqual(Date.now());
    // The failure's own reason is kept: a retry explains nothing away.
    expect(due.waitReason).toBe('provider_unavailable');

    const finished = await parkTheJob(f.writer, 'terminal');
    expect(finished.state).toBe('terminal_failure');
    const again = await json(f, ['knowledge', 'retry', parked.jobId, '--json']);
    expect(again.data).toMatchObject({
      retried: [{ job_id: parked.jobId, outcome: 'finished', state: 'terminal_failure' }],
    });
    expect(jobs(f.writer)[0]!.state).toBe('terminal_failure');
    const told = await agent(f).runRaw(['knowledge', 'retry', parked.jobId]);
    expect(told.stdout).toContain(
      `\`orcaops knowledge reopen ${parked.jobId}\` can, at a terminal`
    );

    const status = await json(f, ['knowledge', 'status', '--json']);
    expect(status.data).toMatchObject({
      gave_up: { total: 1, jobs: [{ job_id: parked.jobId, reason: expect.any(String) }] },
    });
    const refused = await agent(f).runRaw(['knowledge', 'reopen', parked.jobId, '--json']);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('interactive terminal') },
    });
    expect(jobs(f.writer)[0]!.state).toBe('terminal_failure');
  });

  it('holds a job captured with no model, and names the verb that lifts it', async () => {
    const f = await fixture();
    await writeConfig(f);
    await capturePlan(f, ['--no-llm']);
    const [job] = jobs(f.writer);
    expect(job).toBeDefined();

    const retried = await json(f, ['knowledge', 'retry', job!.jobId, '--json']);
    expect(retried.raw.exitCode, retried.raw.stdout + retried.raw.stderr).toBe(0);
    // Not due, and no worker was woken for a job nothing could claim.
    expect(retried.data).toMatchObject({
      retried: [{ job_id: job!.jobId, outcome: 'held' }],
      wake_up: null,
    });
    const status = await json(f, ['knowledge', 'status', '--json']);
    expect(status.data).toMatchObject({ queue: { awaitingModelResume: 1 } });

    // The verb that lifts it is a person's act at a terminal, and this is not one.
    const refused = await agent(f).runRaw(['knowledge', 'resume', '--model', job!.jobId, '--json']);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('interactive terminal') },
    });
    expect(jobs(f.writer)).toEqual([job]);
  });

  it('refuses a job named without --model, because lifting the pause changes none', async () => {
    const f = await fixture();
    await writeConfig(f);
    await capturePlan(f);
    const [job] = jobs(f.writer);

    const refused = await agent(f).runRaw(['knowledge', 'resume', job!.jobId]);

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('knowledge resume --model');
  });

  it('says nothing was made due when no job is waiting', async () => {
    const f = await fixture();
    await writeConfig(f);
    await capturePlan(f);
    const retried = await agent(f).runRaw(['knowledge', 'retry']);
    expect(retried.exitCode, retried.stdout + retried.stderr).toBe(0);
    expect(retried.stdout).toContain('No admitted processing job is waiting');
    expect(jobs(f.writer)[0]!.state).toBe('pending');
  });

  it('refuses a job id this project never admitted', async () => {
    const f = await fixture();
    await writeConfig(f);
    await capturePlan(f);
    const refused = await agent(f).runRaw(['knowledge', 'retry', uuidv7()]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('is admitted in this project');
  });

  it('reads and reports without writing to the database or the grant store', async () => {
    const f = await fixture();
    await writeConfig(f);
    await capturePlan(f);
    const grantStore = processingGrantsFilePath(process.env.ORCAOPS_CONFIG_HOME!);
    const before = await bytes(f.writer.databasePath, grantStore);
    const scheduling = f.writer.read((view) => ({
      jobs: view.all('SELECT * FROM processing_jobs'),
      control: view.all('SELECT * FROM processing_control'),
      lease: view.all('SELECT * FROM processing_lease'),
    })).value;

    const status = await json(f, ['knowledge', 'status', '--json']);
    expect(status.raw.exitCode, status.raw.stdout + status.raw.stderr).toBe(0);
    const doctor = await agent(f).runRaw(['doctor', '--json']);
    expect(JSON.parse(doctor.stdout).checks).toContainEqual(
      expect.objectContaining({ name: 'knowledge-processing' })
    );

    // The write-ahead log is where a write would land, so both files are compared.
    expect(await bytes(f.writer.databasePath, grantStore)).toEqual(before);
    expect(
      f.writer.read((view) => ({
        jobs: view.all('SELECT * FROM processing_jobs'),
        control: view.all('SELECT * FROM processing_control'),
        lease: view.all('SELECT * FROM processing_lease'),
      })).value
    ).toEqual(scheduling);
  });
});
