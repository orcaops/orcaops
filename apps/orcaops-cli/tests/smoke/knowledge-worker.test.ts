import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { releaseProcessingLease } from '@orcaops/storage/history/database';

import {
  startProcessingWorker,
  WORKER_START_SWITCH,
  workerLogPath,
} from '../../src/knowledge-worker/start.js';
import {
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
  type WorkerFixtureOptions,
} from '../../src/knowledge-worker/worker-fixture.test-support.js';

/**
 * The worker as a real process that can be killed. Crash recovery, the paid
 * call a dead worker leaves running, and the detached start are all about what
 * survives a process, so none of them can be observed in-process.
 */

// The fixture records a grant through the store API, which only a terminal may
// do. The worker child never records one; it only reads what this process wrote.
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

const BIN = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'bin', 'orcaops.js');

const fixtures: WorkerFixture[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  // A worker killed mid-call deliberately leaves its provider running — that is
  // what these tests are about — so the provider every attempt recorded is
  // reaped here rather than left on the machine.
  for (const f of fixtures.splice(0)) {
    for (const pid of recordedProviderPids(f)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    await f.cleanup();
  }
});

function recordedProviderPids(f: WorkerFixture): number[] {
  try {
    return f.handle
      .read((view) =>
        view.all<{ processJson: string | null }>(
          'SELECT process_json AS processJson FROM processing_attempts WHERE process_json IS NOT NULL'
        )
      )
      .value.flatMap((row) => {
        const pid = (JSON.parse(row.processJson!) as { pid?: unknown }).pid;
        return typeof pid === 'number' ? [pid] : [];
      });
  } catch {
    return [];
  }
}

async function fixture(options: WorkerFixtureOptions = {}): Promise<WorkerFixture> {
  const made = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER, ...options });
  fixtures.push(made);
  return made;
}

interface RunningWorker {
  child: ChildProcess;
  output: () => string;
  ended: Promise<number | null>;
}

function startWorker(f: WorkerFixture, extraEnv: Record<string, string> = {}): RunningWorker {
  const chunks: string[] = [];
  const child = spawn(process.execPath, [BIN, 'knowledge', 'worker', '--root', f.repoPath], {
    cwd: f.repoPath,
    env: { ...f.env, ...extraEnv } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const ended = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  return { child, output: () => chunks.join(''), ended };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Give up the lease a killed worker never released. Production waits for it to
 * expire; a test that waited out the whole term would prove nothing more.
 */
async function releaseDeadLease(f: WorkerFixture): Promise<void> {
  const lease = f.lease();
  if (lease?.ownerId == null) return;
  await releaseProcessingLease(f.handle, {
    ownerId: lease.ownerId,
    generation: lease.ownerGeneration,
  });
}

/** The environment of a test that deliberately wants a real detached worker. */
function wantsAWorker(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const wanted = { ...env };
  delete wanted[WORKER_START_SWITCH];
  return wanted;
}

/** Kill the worker outright, as a machine losing power would. */
async function crash(worker: RunningWorker): Promise<void> {
  worker.child.kill('SIGKILL');
  await worker.ended;
}

describe('a worker that dies mid-flight', () => {
  it('leaves a job for the next worker when it dies before dispatching one', async () => {
    const f = await fixture();
    const { jobId } = await f.admit();

    const first = startWorker(f);
    await waitFor(() => first.output().includes('Took the processing lease'), 'the lease');
    await crash(first);

    // A lease nobody released stands until it expires; releasing the dead
    // owner's is what the next worker's take does once it has, without the
    // test waiting out the whole term.
    await releaseDeadLease(f);
    const second = startWorker(f);
    await second.ended;

    expect(f.job(jobId).state).toBe('completed');
    expect(f.attempts(jobId)).toHaveLength(1);
  }, 90_000);

  it('leaves the call it was making unsettled, with what it spawned recorded', async () => {
    const f = await fixture();
    const { jobId } = await f.admit();

    const worker = startWorker(f, { FAKE_PROPOSER_HANG: '1' });
    await waitFor(() => existsSync(f.providerRecordPath), 'the provider to answer');
    await waitFor(() => (f.attempts(jobId)[0]?.process ?? null) !== null, 'the process record');
    await crash(worker);

    const [attempt] = f.attempts(jobId);
    expect(attempt.outcome).toBeNull();
    const spawned = attempt.process as { pid: number };
    // The provider leads its own process group, so killing the worker leaves it
    // running and spending; that is the whole reason it is recorded.
    expect(isAlive(spawned.pid)).toBe(true);
    expect(f.job(jobId).state).toBe('running');
  }, 90_000);

  it('terminates what a lost call spawned and settles it as unknown at once', async () => {
    const f = await fixture();
    await f.writeConfig({ enabled: true, idle_exit_ms: 1_000 });
    const { jobId } = await f.admit();

    const worker = startWorker(f, { FAKE_PROPOSER_HANG: '1' });
    await waitFor(() => (f.attempts(jobId)[0]?.process ?? null) !== null, 'the process record');
    await crash(worker);
    const orphan = (f.attempts(jobId)[0].process as { pid: number }).pid;
    expect(isAlive(orphan)).toBe(true);
    // The marker is removed so its reappearance would be a second paid call.
    await rm(f.providerStartedMarker, { force: true });
    await releaseDeadLease(f);

    const next = startWorker(f);
    await waitFor(
      () => next.output().includes('provider process was confirmed gone'),
      'the lost attempt to be settled'
    );
    next.child.kill('SIGTERM');
    await next.ended;

    // Termination is confirmed before recovery returns, so by the time the
    // worker has exited the orphan is gone and its log says so.
    expect(next.output()).toContain('its provider process is gone');
    expect(isAlive(orphan)).toBe(false);
    // Having watched it go is better evidence than the hour-long bound, so the
    // attempt is settled now and the project's one running slot is free again.
    expect(next.output()).toContain('confirmed gone');
    const attempt = f.attempts(jobId).find((made) => made.attemptNumber === 1)!;
    expect(attempt.outcome).toBe('unknown');
    expect(attempt.usage).toBeNull();
    expect(f.job(jobId)).toMatchObject({
      state: 'retryable_failure',
      waitReason: 'call_result_unknown',
    });
    // The replacement waits for the retry time rather than being made now.
    expect(f.job(jobId).retryAt).not.toBeNull();
  }, 90_000);

  it('settles what can be settled on SIGTERM and gives the lease back', async () => {
    const f = await fixture();
    await f.writeConfig({ enabled: true, timeout_ms: 10_000 });
    const { jobId } = await f.admit();

    const worker = startWorker(f, { FAKE_PROPOSER_HANG: '1' });
    await waitFor(() => (f.attempts(jobId)[0]?.process ?? null) !== null, 'the process record');
    const orphan = (f.attempts(jobId)[0].process as { pid: number }).pid;
    worker.child.kill('SIGTERM');
    await worker.ended;

    expect(worker.output()).toContain('Received SIGTERM');
    const [attempt] = f.attempts(jobId);
    expect(attempt.outcome).toBe('failed');
    expect(f.job(jobId).state).toBe('retryable_failure');
    expect(f.lease()?.ownerId).toBeNull();
    await waitFor(() => !isAlive(orphan), 'the cancelled provider to be reaped');
  }, 90_000);
});

/** A real `orcaops capture plan` in the fixture's checkout, as a person runs it. */
async function capturePlan(
  f: WorkerFixture,
  env: NodeJS.ProcessEnv,
  label: string
): Promise<{ code: number | null; output: string }> {
  const input = path.join(f.configHome, `${label}.json`);
  await writeFile(
    input,
    JSON.stringify({
      idempotency_key: `plan-${label}`,
      task: 'Notes are flushed to disk before the screen reports them saved.',
      label,
      plan_steps: [
        {
          text: 'retain what the capture means',
          label: 'Retention',
          acceptance_criteria: [{ text: 'the capture is retained' }],
        },
      ],
      touched_scope: ['storage'],
    }),
    'utf8'
  );
  const chunks: string[] = [];
  const child = spawn(process.execPath, [BIN, 'capture', 'plan', '--input', input], {
    cwd: f.repoPath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { code, output: chunks.join('') };
}

function admittedJobs(f: WorkerFixture): number {
  return f.handle.read((view) =>
    view.get<{ jobs: number }>('SELECT count(*) AS jobs FROM processing_jobs')
  ).value!.jobs;
}

describe('starting the worker after a capture', () => {
  it('starts one for a capture made while processing is on, and none while it is off', async () => {
    const f = await fixture();
    const log = workerLogPath(f.authority);
    // The switch cleared: whether a worker starts is the configuration's answer
    // here, not the test suite's.
    const env = wantsAWorker(f.env);

    await f.writeConfig({ enabled: false, idle_exit_ms: 1_000 });
    const off = await capturePlan(f, env, 'processing-off');
    expect(off.code, off.output).toBe(0);
    // Admission is unconditional, so the capture is queued all the same.
    expect(admittedJobs(f)).toBe(1);
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await f.writeConfig({ enabled: true, idle_exit_ms: 1_000 });
    const on = await capturePlan(f, env, 'processing-on');
    expect(on.code, on.output).toBe(0);
    expect(admittedJobs(f)).toBe(2);

    const logSays = (text: string) => existsSync(log) && readFileSync(log, 'utf8').includes(text);
    await waitFor(() => logSays('Took the processing lease'), 'the worker to take the lease');
    // Nothing is left running: the worker exits after its idle interval and
    // gives the lease back.
    await waitFor(() => logSays('Worker finished'), 'the worker to finish', 60_000);
    await waitFor(() => f.lease()?.ownerId == null, 'the lease to come back');
  }, 120_000);

  it('starts a detached worker that processes the capture and writes its own log', async () => {
    const f = await fixture();
    // A short idle interval: this is about the detached start, the processing
    // and the log, not about waiting out the default thirty-second idle exit.
    await f.writeConfig({ enabled: true, idle_exit_ms: 1_000 });
    const { jobId } = await f.admit();

    // This is a test that asks for a real worker: it clears the switch the CLI
    // suite sets and names the entry, which is the only way one starts here.
    const started = startProcessingWorker({
      repoRoot: f.repoPath,
      authority: f.authority,
      env: wantsAWorker(f.env),
      entry: { execPath: process.execPath, script: BIN },
    });

    expect(started.started).toBe(true);
    expect(started.logPath).toBe(workerLogPath(f.authority));
    await waitFor(() => f.job(jobId).state === 'completed', 'the job to be processed', 60_000);
    const log = await readFile(started.logPath!, 'utf8');
    expect(log).toContain('Took the processing lease');
    expect(log).toContain('settled as succeeded');
    if (started.pid !== null) await waitFor(() => !isAlive(started.pid!), 'the worker to exit');
  }, 90_000);

  it('never starts a worker from inside a worker', async () => {
    const f = await fixture();

    const started = startProcessingWorker({
      repoRoot: f.repoPath,
      authority: f.authority,
      env: { ...wantsAWorker(f.env), ORCAOPS_KNOWLEDGE_WORKER: '1' },
      entry: { execPath: process.execPath, script: BIN },
    });

    expect(started.started).toBe(false);
    expect(started.pid).toBeNull();
    expect(started.detail).toContain('does not start another worker');
  });
});

describe('what the start switch and the entry check stop', () => {
  it('starts no worker from a real command while the switch is off', async () => {
    const f = await fixture();
    await f.admit();
    const log = workerLogPath(f.authority);

    // `knowledge resume` is one of the verbs that wakes a worker, run as the
    // real binary, whose entry check would otherwise pass. The switch the CLI
    // suite sets is inherited here, and it is what stops the spawn.
    const resumed = await new Promise<string>((resolve) => {
      const chunks: string[] = [];
      const child = spawn(process.execPath, [BIN, 'knowledge', 'resume'], {
        cwd: f.repoPath,
        env: { ...f.env, [WORKER_START_SWITCH]: '0' } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      child.on('exit', () => resolve(chunks.join('')));
    });

    expect(resumed).toContain(WORKER_START_SWITCH);
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 90_000);

  it('refuses to re-run an entry that is not the orcaops one', async () => {
    const f = await fixture();

    // No `entry`, and this process is vitest: there is nothing safe to re-run.
    const started = startProcessingWorker({
      repoRoot: f.repoPath,
      authority: f.authority,
      env: wantsAWorker(f.env),
    });

    expect(started.started).toBe(false);
    expect(started.detail).toContain('not the orcaops entry');
  });

  it('leaves one owner when two workers are started against one database', async () => {
    const f = await fixture();
    await f.admit();

    const first = startWorker(f);
    const second = startWorker(f);
    const outputs = [await first.ended.then(() => first.output()), second.output()];
    await second.ended;

    const both = `${outputs[0]}${second.output()}`;
    expect(both).toContain('lease_held_by_other');
    expect(both.match(/Took the processing lease/g)).toHaveLength(1);
  }, 90_000);
});
