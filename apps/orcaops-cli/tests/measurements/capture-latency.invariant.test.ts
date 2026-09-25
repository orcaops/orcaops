import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ProjectDatabase } from '@orcaops/storage/history/database';

import { processingWorkflow, type ProcessingWorkflow } from '../helpers/processing-workflow.js';

/**
 * Model latency is never on the capture path. The provider here waits a fixed interval before
 * answering anything, so a capture that waited for one could not return inside that interval, and
 * the call log says when the provider was actually reached.
 *
 * The commands run as a person runs them — real processes, which are the only ones that start a
 * background worker. No timing threshold is asserted beyond the interval itself.
 */
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(() => true),
}));

const ORCAOPS_ENTRY = fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url));

/** How long the provider takes to answer anything. Nothing a capture does may wait this long. */
const PROVIDER_INTERVAL_MS = 4_000;

interface Job {
  jobId: string;
  sourceId: string;
  admittedAt: string;
}

interface ProviderCall {
  beganAt: number;
  pid: number;
}

let processing: ProcessingWorkflow;
let writer: ProjectDatabase;
let callDirectory: string;
let callLog: string;
let artifactId: string;
let stepId: string;
let planJob: Job;
let closeJob: Job;

async function runAsAPerson(
  args: readonly string[],
  body: Record<string, unknown>
): Promise<{ ms: number; envelope: Record<string, unknown> }> {
  const input = await processing.workflow.inputDocument(body);
  const at = Date.now();
  const output = await new Promise<string>((resolve) => {
    const chunks: string[] = [];
    const child = spawn(process.execPath, [ORCAOPS_ENTRY, ...args, '--input', input], {
      cwd: processing.workflow.repoPath,
      env: processing.spawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    child.on('exit', () => resolve(chunks.join('')));
  });
  const ms = Date.now() - at;
  const envelope = JSON.parse(output) as Record<string, unknown>;
  if (envelope.ok !== true) throw new Error(`${args.join(' ')} failed: ${output}`);
  return { ms, envelope };
}

const jobs = (): Job[] =>
  writer.read((view) =>
    view.all<Job>(
      `SELECT job_id AS jobId, source_id AS sourceId, admitted_at AS admittedAt
         FROM processing_jobs ORDER BY admitted_at, job_id`
    )
  ).value;

/** The provider process the job's first attempt spawned, once the worker has recorded it. */
const attemptedProviderPid = (jobId: string): number | null => {
  const row = writer.read((view) =>
    view.get<{ process: string | null }>(
      `SELECT process_json AS process FROM processing_attempts
         WHERE job_id = ? ORDER BY attempt_number LIMIT 1`,
      jobId
    )
  ).value;
  return row?.process == null ? null : (JSON.parse(row.process) as { pid: number }).pid;
};

const providerCalls = (): ProviderCall[] => {
  let lines: string[] = [];
  try {
    lines = readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return lines.map((line) => {
    const [beganAt, pid] = line.split(' ');
    return { beganAt: Number(beganAt), pid: Number(pid) };
  });
};

async function waitFor<T>(
  read: () => T | null | undefined,
  what: string,
  timeoutMs = 90_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = read();
    if (found !== null && found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const planBody = () => ({
  idempotency_key: `plan-${randomUUID()}`,
  task: 'Notes are flushed to disk before the screen reports them saved.',
  label: 'Capture path',
  plan_steps: [
    {
      text: 'keep the model off the capture path',
      label: 'Keep',
      acceptance_criteria: [{ text: 'the capture commits without waiting for a provider' }],
    },
  ],
  touched_scope: ['storage'],
});

beforeAll(async () => {
  callDirectory = await mkdtemp(path.join(tmpdir(), 'orcaops-capture-path-'));
  callLog = path.join(callDirectory, 'provider-calls');
  processing = await processingWorkflow({
    pace: { kind: 'delayed', delayMs: PROVIDER_INTERVAL_MS },
    callLog,
  });
  writer = await processing.workflow.open();
}, 240_000);

afterAll(async () => {
  // A provider still inside its wait outlives the worker that spawned it, and the roots go away
  // underneath it.
  for (const call of providerCalls()) {
    try {
      process.kill(call.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await processing?.cleanup();
  await rm(callDirectory, { recursive: true, force: true });
});

describe('a capture while the provider takes its time', { timeout: 300_000 }, () => {
  it('completes a plan capture in less time than the provider takes to answer', async () => {
    const captured = await runAsAPerson(['capture', 'plan'], planBody());

    expect(captured.ms).toBeLessThan(PROVIDER_INTERVAL_MS);
    artifactId = captured.envelope.artifact_id as string;
    stepId = (captured.envelope.plan_steps as { step_id: string }[])[0].step_id;
    const eventId = captured.envelope.plan_event_id as string;
    planJob = await waitFor(
      () => jobs().find((job) => job.sourceId === eventId),
      'the plan capture to admit a job'
    );
  });

  it('completes a checkpoint close in less time than the provider takes to answer', async () => {
    const opened = await runAsAPerson(['capture', 'checkpoint', 'open'], {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: artifactId,
      declared_step_ids: [stepId],
    });

    const closed = await runAsAPerson(['capture', 'checkpoint', 'close'], {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: artifactId,
      n: opened.envelope.n,
      summary: 'Closed while the provider was still answering the capture before it',
      completed_step_ids: [],
      files_changed: [],
      verification: [],
    });

    expect(closed.ms).toBeLessThan(PROVIDER_INTERVAL_MS);
    closeJob = await waitFor(
      () => jobs().find((job) => job.jobId !== planJob.jobId),
      'the checkpoint close to admit a job'
    );
  });

  it('reaches the provider only after the act that admitted the job committed', async () => {
    const reached: { job: string; afterAdmissionMs: number }[] = [];
    for (const job of [planJob, closeJob]) {
      const pid = await waitFor(
        () => attemptedProviderPid(job.jobId),
        `the provider the worker spawned for job ${job.jobId}`
      );
      const call = await waitFor(
        () => providerCalls().find((made) => made.pid === pid),
        `the call log entry for provider ${pid}`
      );
      reached.push({ job: job.jobId, afterAdmissionMs: call.beganAt - Date.parse(job.admittedAt) });
    }

    expect(reached).toHaveLength(2);
    for (const { job, afterAdmissionMs } of reached)
      expect(
        afterAdmissionMs,
        `the call for job ${job} began before its job was admitted`
      ).toBeGreaterThan(0);
  });
});
