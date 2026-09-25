import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROCESSING_PROCESSOR_CONTRACT } from '@orcaops/core';
import { type ProjectDatabase, readProcessingQueue } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { fixture, git } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * What a real capture command admits. Every job here was admitted by the CLI
 * itself, in the transaction that published its source: nothing in this file
 * calls the storage admission directly.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;

function agentEnv(f: Fixture, session = 'admission-session') {
  return {
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_DISABLE_DRAIN: '1',
    CODEX_SESSION_ID: session,
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
    XDG_STATE_HOME: f.temporary + '/unused-state',
  };
}

function agent(f: Fixture, session = 'admission-session') {
  return makeAgent({ cwd: f.main, timeoutMs: 120_000, env: agentEnv(f, session) });
}

interface AdmittedJob {
  jobId: string;
  sourceId: string;
  contract: string;
  withoutModel: number;
  state: string;
  admission: string;
}

function admitted(handle: ProjectDatabase): AdmittedJob[] {
  return handle.read((view) =>
    view.all<AdmittedJob>(
      `SELECT job_id AS jobId, source_id AS sourceId, processor_contract AS contract,
        without_model AS withoutModel, state, admission_json AS admission
        FROM processing_jobs ORDER BY admitted_at, job_id`
    )
  ).value;
}

function scheduling(handle: ProjectDatabase) {
  return handle.read((view) => ({
    attempts: view.all('SELECT * FROM processing_attempts'),
    lease: view.all('SELECT * FROM processing_lease'),
    usage: view.all('SELECT * FROM processing_usage'),
  })).value;
}

async function run(f: Fixture, args: string[], body?: Record<string, unknown>) {
  const raw = await agent(f).runRaw([
    ...args,
    ...(body === undefined ? [] : ['--input', inputFile(JSON.stringify(body))]),
  ]);
  const result = JSON.parse(raw.stdout) as Record<string, unknown>;
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  expect(result.ok).toBe(true);
  return result;
}

const planBody = (extra: Record<string, unknown> = {}) => ({
  idempotency_key: `plan-${randomUUID()}`,
  task: 'Retain what a capture means',
  label: 'Capture admission',
  plan_steps: [
    {
      text: 'admit a job for every eligible capture',
      label: 'Admission',
      acceptance_criteria: [{ text: 'one job per eligible source event' }],
    },
  ],
  touched_scope: ['storage'],
  ...extra,
});

describe('background processing admission at capture', { timeout: 180_000 }, () => {
  it('admits one job for each eligible capture, with the invocation no-LLM choice', async () => {
    const f = await fixture();
    const plan = await run(f, ['capture', 'plan', '--no-llm'], planBody());
    const artifactId = plan.artifact_id as string;

    expect(admitted(f.writer)).toHaveLength(1);
    expect(admitted(f.writer)[0]).toMatchObject({
      sourceId: plan.plan_event_id,
      contract: PROCESSING_PROCESSOR_CONTRACT,
      withoutModel: 1,
      state: 'pending',
    });
    expect(JSON.parse(admitted(f.writer)[0]!.admission)).toMatchObject({
      path: 'live_capture_settlement',
      origin_kind: 'captured',
      derived_by_processing: false,
    });

    const revision = await run(f, ['capture', 'plan', 'revise'], {
      idempotency_key: `revise-${randomUUID()}`,
      artifact_id: artifactId,
      prior_plan_event_id: plan.plan_event_id,
      rationale: 'the plan grew a step',
      label: 'Capture admission',
      plan_steps: [
        {
          text: 'admit a job for every eligible capture',
          label: 'Admission',
          acceptance_criteria: [{ text: 'one job per eligible source event' }],
        },
      ],
      touched_scope: ['storage'],
      non_goals: [],
    });
    expect(admitted(f.writer)).toHaveLength(2);
    // No flag, so this invocation permits a model and the job records that.
    expect(admitted(f.writer)[1]).toMatchObject({
      sourceId: revision.plan_event_id,
      withoutModel: 0,
    });

    const opened = await run(f, ['capture', 'checkpoint', 'open', '--no-llm'], {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: artifactId,
      declared_step_ids: (revision.plan_steps as { step_id: string }[]).map((s) => s.step_id),
    });
    expect(admitted(f.writer)).toHaveLength(2);

    await run(f, ['capture', 'checkpoint', 'close', '--no-llm'], {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: artifactId,
      n: opened.n,
      summary: 'the admission landed',
      files_changed: ['packages/storage/src/history/database/execution-capture.ts'],
      verification: [{ command: 'pnpm test', exit_code: 0 }],
      completed_step_ids: [],
    });
    expect(admitted(f.writer)).toHaveLength(3);

    const reopened = await run(f, ['capture', 'checkpoint', 'open', '--no-llm'], {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: artifactId,
      declared_step_ids: (revision.plan_steps as { step_id: string }[]).map((s) => s.step_id),
    });
    await run(f, ['capture', 'checkpoint', 'abandon'], {
      idempotency_key: `abandon-${randomUUID()}`,
      artifact_id: artifactId,
      n: reopened.n,
      reason: 'the approach was wrong',
    });
    expect(admitted(f.writer)).toHaveLength(4);

    await run(f, ['capture', 'summary'], {
      idempotency_key: `summary-${randomUUID()}`,
      artifact_id: artifactId,
      outcome: 'the work is done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
    });
    const jobs = admitted(f.writer);
    expect(jobs).toHaveLength(5);
    expect(new Set(jobs.map((job) => job.sourceId)).size).toBe(5);
    expect(jobs.every((job) => job.contract === PROCESSING_PROCESSOR_CONTRACT)).toBe(true);

    // Admission is all that happened: nothing claimed a job, took a lease or spent.
    expect(scheduling(f.writer)).toEqual({ attempts: [], lease: [], usage: [] });
    const queue = readProcessingQueue(f.writer);
    expect(queue.jobs.pending).toBe(5);
    expect(queue.openAttempts).toBe(0);
    // The plan and the close carried `--no-llm`; the other three did not.
    expect(queue.awaitingModelResume).toBe(2);
    // Each job is measured by its own publishing operation, so the newest admitted
    // sequence is a committed write sequence, never a count of jobs.
    expect(queue.latestAdmittedSequence).toBeGreaterThan(0);
    expect(queue.latestAdmittedSequence).toBeLessThanOrEqual(
      f.writer.read(() => null).counters.writeSequence
    );
  });

  it('retains summary model eligibility from the invocation flag', async () => {
    const f = await fixture();
    const heldPlan = await run(f, ['capture', 'plan', '--no-llm'], planBody());
    const planForEligibleSummary = await run(f, ['capture', 'plan', '--no-llm'], planBody());

    const heldSummary = await run(f, ['capture', 'summary', '--no-llm'], {
      idempotency_key: `summary-${randomUUID()}`,
      artifact_id: heldPlan.artifact_id,
      outcome: 'the no-model summary is retained',
    });
    const eligibleSummary = await run(f, ['capture', 'summary'], {
      idempotency_key: `summary-${randomUUID()}`,
      artifact_id: planForEligibleSummary.artifact_id,
      outcome: 'the default summary remains eligible',
    });

    const jobs = admitted(f.writer);
    expect(jobs.find((job) => job.sourceId === heldSummary.summary_event_id)).toMatchObject({
      withoutModel: 1,
      state: 'pending',
    });
    expect(jobs.find((job) => job.sourceId === eligibleSummary.summary_event_id)).toMatchObject({
      withoutModel: 0,
      state: 'pending',
    });
    expect(readProcessingQueue(f.writer)).toMatchObject({
      jobs: { pending: 4 },
      awaitingModelResume: 3,
    });
  });

  it('admits nothing twice when the same capture is replayed', async () => {
    const f = await fixture();
    const body = planBody();
    const first = await run(f, ['capture', 'plan', '--no-llm'], body);
    const replay = await run(f, ['capture', 'plan', '--no-llm'], body);
    expect(replay.idempotency_status).toBe('replay');
    expect(replay.plan_event_id).toBe(first.plan_event_id);
    expect(admitted(f.writer)).toHaveLength(1);
  });

  it('admits for a capture whose processing is enabled but paused, and unconsented', async () => {
    const f = await fixture();
    await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
    // codex cannot withhold every tool, so this configuration always pauses the
    // workload; no grant exists either. The capture must still commit and admit.
    await writeFile(
      path.join(f.main, '.orcaops', 'config.json'),
      JSON.stringify({
        schema_version: 8,
        install: { scope: 'project' },
        knowledge_processing: { enabled: true, provider: 'codex' },
      }),
      'utf8'
    );
    const plan = await run(f, ['capture', 'plan', '--no-llm'], planBody());
    expect(admitted(f.writer)).toMatchObject([{ sourceId: plan.plan_event_id, state: 'pending' }]);
  });

  it('admits nothing for an imported artifact or history written without a live capture', async () => {
    const f = await fixture();
    const imported = await f.capture(undefined, { reason: 'imported' });
    await f.capture(undefined, { reason: 'legacy_unknown' });
    expect(admitted(f.writer)).toEqual([]);

    // A live plan capture beside them still admits, so this proves the origin and
    // the path, not merely that nothing was written at all.
    await run(f, ['capture', 'plan', '--no-llm'], planBody());
    expect(admitted(f.writer)).toHaveLength(1);
    expect(admitted(f.writer)[0]!.sourceId).not.toBe(imported);
  });

  it('starts no provider process on the capture path', async () => {
    const f = await fixture();
    await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(f.main, '.orcaops', 'config.json'),
      JSON.stringify({ schema_version: 6, install: { scope: 'project' } }),
      'utf8'
    );
    const log = path.join(f.temporary, 'provider-invocations');
    const claude = path.join(f.temporary, 'fake-claude');
    await writeFile(claude, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 0\n`, 'utf8');
    await chmod(claude, 0o755);
    const withProvider = (args: string[]) =>
      makeAgent({
        cwd: f.main,
        timeoutMs: 120_000,
        env: {
          ...agentEnv(f),
          ORCAOPS_CLAUDE_PATH: claude,
          ORCAOPS_CODEX_PATH: path.join(f.temporary, 'absent-codex'),
        },
      }).runRaw(args);

    const plan = await withProvider([
      'capture',
      'plan',
      '--input',
      inputFile(JSON.stringify(planBody())),
    ]);
    expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
    expect(admitted(f.writer)).toHaveLength(1);
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('');

    // The same binary is reached by a surface that does probe, so an empty log
    // above is the capture path's silence and not a broken fake.
    const doctor = await withProvider(['doctor', '--json']);
    expect(doctor.exitCode === 0 || doctor.exitCode === 1).toBe(true);
    expect(await readFile(log, 'utf8').catch(() => '')).not.toBe('');
  });

  it('admits nothing when Git history is seeded', async () => {
    const f = await fixture();
    for (const [name, subject] of [
      ['src/service.ts', 'feat: establish the service'],
      ['src/health.ts', 'fix: stabilize the service'],
    ]) {
      await mkdir(path.join(f.main, 'src'), { recursive: true });
      await writeFile(path.join(f.main, name), `export const ${path.basename(name, '.ts')} = 1;\n`);
      await git(f.main, ['add', '-A']);
      await git(f.main, ['commit', '-qm', subject]);
    }
    const seeded = await agent(f).runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(seeded.exitCode, seeded.stdout + seeded.stderr).toBe(0);
    expect(JSON.parse(seeded.stdout)).toMatchObject({ mode: 'applied', totals: { failed: 0 } });
    expect(
      f.writer.read((view) =>
        view.get<{ imported: number }>(
          "SELECT count(*) AS imported FROM artifact_metadata WHERE origin_kind='git-import'"
        )
      ).value!.imported
    ).toBeGreaterThan(0);
    expect(admitted(f.writer)).toEqual([]);
  });
});
