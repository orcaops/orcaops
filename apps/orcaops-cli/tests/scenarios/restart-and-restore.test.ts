import Database from 'better-sqlite3';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ProjectDatabase } from '@orcaops/storage/history/database';

import { PROJECT_DATABASE_SCHEMA_VERSION } from '../../../../packages/storage/src/history/database/schema.js';
import { knowledgeEnableAction } from '../../src/commands/knowledge/enable.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import {
  InteractiveConsentConfirmation,
  processingGrantsFilePath,
} from '../../src/lib/knowledge-processing-grants.js';
import { placeReleasedProjectDatabase } from '../helpers/released-project-database.js';
import { scenarioWorkflow, type ScenarioWorkflow } from '../helpers/scenario-workflow.js';

/**
 * A worker killed in the middle of a paid call, the machine coming back, and then the verified
 * pre-upgrade backup put in place.
 *
 * The worker is killed as a real process, because what survives one is the whole question: the
 * provider it started keeps running and spending, and only the next invocation can settle what
 * became of it.
 */
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(() => true),
}));

const BIN = fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url));
const RELEASED_SCHEMA_VERSION = 29;

const CONSENT_TERMINAL = {
  isInteractive: () => true,
  ask: () => Promise.resolve('yes'),
  confirm: InteractiveConsentConfirmation.forTermsAcceptedAtTerminal.bind(
    InteractiveConsentConfirmation
  ),
};

let workflow: ScenarioWorkflow;
let writer: ProjectDatabase;
let databaseFile: string;
let backupName: string;
let jobId: string;
let orphanPid: number;
const children: ChildProcess[] = [];

interface Attempt {
  attemptId: string;
  attemptNumber: number;
  outcome: string | null;
  usage: string | null;
  process: string | null;
}

const attempts = (): Attempt[] =>
  writer.read((view) =>
    view.all<Attempt>(
      `SELECT attempt_id AS attemptId, attempt_number AS attemptNumber, outcome,
         usage_json AS usage, process_json AS process
       FROM processing_attempts ORDER BY attempt_number`
    )
  ).value;

const job = () =>
  writer.read((view) =>
    view.get<{ state: string; waitReason: string | null; retryAt: string | null }>(
      `SELECT state, wait_reason AS waitReason, retry_at AS retryAt
         FROM processing_jobs WHERE job_id = ?`,
      jobId
    )
  ).value;

const lease = () =>
  writer.read((view) =>
    view.get<{ ownerId: string | null; expiresAt: string | null }>(
      'SELECT owner_id AS ownerId, expires_at AS expiresAt FROM processing_lease'
    )
  ).value;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The worker as its own process, which is the only kind that can be killed outright. */
function startWorker(extraEnv: Record<string, string> = {}): {
  child: ChildProcess;
  output: () => string;
  ended: Promise<number | null>;
} {
  const chunks: string[] = [];
  const child = spawn(process.execPath, [BIN, 'knowledge', 'worker'], {
    cwd: workflow.repoPath,
    env: { ...process.env, ...workflow.env(), ...extraEnv } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return {
    child,
    output: () => chunks.join(''),
    ended: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
  };
}

function tableExists(file: string, table: string): boolean {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (
      (
        database.prepare('SELECT count(*) AS n FROM sqlite_schema WHERE name = ?').get(table) as {
          n: number;
        }
      ).n > 0
    );
  } finally {
    database.close();
  }
}

function schemaVersionOf(file: string): number {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return database.pragma('user_version', { simple: true }) as number;
  } finally {
    database.close();
  }
}

const capturePlan = async (task: string, label: string) =>
  workflow.json([
    'capture',
    'plan',
    '--input',
    await workflow.inputDocument({
      idempotency_key: `plan-${randomUUID()}`,
      task,
      label,
      plan_steps: [
        {
          text: 'survive the restart',
          label: 'Survive',
          acceptance_criteria: [{ text: 'the job is settled once' }],
        },
      ],
      touched_scope: ['storage'],
    }),
  ]);

beforeAll(async () => {
  workflow = await scenarioWorkflow({ database: true });
  await workflow.writeConfig({
    schema_version: 8,
    install: { scope: 'project' },
    llm: { tool: 'claude' },
    knowledge_processing: { enabled: true, idle_exit_ms: 1_000, timeout_ms: 120_000 },
  });
  writer = await workflow.open();
  databaseFile = writer.databasePath;
  await placeReleasedProjectDatabase(writer);
}, 240_000);

afterAll(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  // A worker killed mid-call deliberately leaves its provider running, so the one every attempt
  // recorded is reaped here rather than left on the machine.
  for (const pid of pidsRecorded()) {
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
  await workflow.cleanup();
});

function pidsRecorded(): number[] {
  try {
    return attempts().flatMap((attempt) => {
      const pid =
        attempt.process === null ? null : (JSON.parse(attempt.process) as { pid: number });
      return pid === null ? [] : [pid.pid];
    });
  } catch {
    return [];
  }
}

describe('a worker killed mid-call, and the backup put back', { timeout: 300_000 }, () => {
  it('upgrades the released store behind a backup, then admits one consented capture', async () => {
    const applied = await workflow.json(['history', 'upgrade', '--apply', '--json']);
    backupName = (applied.backup as { name: string }).name;
    expect(schemaVersionOf(databaseFile)).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
    writer = await workflow.open();

    await runInInvocationContext(
      { cwd: workflow.repoPath, env: { ...process.env, ...workflow.env() } },
      () => knowledgeEnableAction({ terminal: CONSENT_TERMINAL, json: true })
    );
    const plan = await capturePlan(
      'A call interrupted by a crash is settled once, never paid for twice.',
      'Interrupted call'
    );
    jobId = writer.read((view) =>
      view.get<{ jobId: string }>('SELECT job_id AS jobId FROM processing_jobs')
    ).value!.jobId;

    expect(plan.ok).toBe(true);
    expect(job()).toMatchObject({ state: 'pending' });
  });

  it('leaves the call it was making unsettled, with what it spawned recorded', async () => {
    const worker = startWorker({ FAKE_PROPOSER_HANG: '1' });
    await waitFor(() => attempts()[0]?.process != null, 'the provider process record');
    worker.child.kill('SIGKILL');
    await worker.ended;

    const [attempt] = attempts();
    expect(attempt.outcome).toBeNull();
    expect(job()).toMatchObject({ state: 'running' });
    orphanPid = (JSON.parse(attempt.process!) as { pid: number }).pid;
    // The provider leads its own process group, so killing the worker leaves it running and
    // spending; that is the whole reason the attempt records it.
    expect(isAlive(orphanPid)).toBe(true);
    // The worker records the process as soon as it is spawned, which can be before the provider
    // has started far enough to log the call.
    await waitFor(() => workflow.providerCalls().length > 0, 'the provider to log its call');
    expect(workflow.providerCalls()).toHaveLength(1);
  });

  it('settles the lost call as unknown after the lease expires, keeping usage unknown', async () => {
    const held = lease();
    expect(held?.ownerId).not.toBeNull();
    // Nothing released the dead owner's lease, so the next worker waits for it to expire, which
    // is what a machine coming back does.
    await waitFor(
      () => Date.now() > Date.parse(held!.expiresAt!) + 250,
      'the dead owner’s lease to expire'
    );

    const resumed = await workflow.json(['knowledge', 'resume', '--json']);
    expect(resumed).toMatchObject({ paused: false });
    const recovered = startWorker();
    await waitFor(
      () => recovered.output().includes('provider process was confirmed gone'),
      'the lost attempt to be settled'
    );
    recovered.child.kill('SIGTERM');
    await recovered.ended;

    expect(recovered.output()).toContain('confirmed gone');
    expect(isAlive(orphanPid)).toBe(false);
    const [attempt] = attempts();
    expect(attempt.outcome).toBe('unknown');
    expect(attempt.usage).toBeNull();
    expect(job()).toMatchObject({ state: 'retryable_failure', waitReason: 'call_result_unknown' });
    expect(job()?.retryAt).not.toBeNull();
    // An unknown result is not a free retry: the replacement waits for the retry time.
    expect(workflow.providerCalls()).toHaveLength(1);
  });

  it('completes the job on one replacement call, and makes no further one', async () => {
    await workflow.json(['knowledge', 'retry', '--json']);
    const replacement = startWorker();
    await replacement.ended;

    expect(job()).toMatchObject({ state: 'completed' });
    expect(attempts()).toHaveLength(2);
    expect(workflow.providerCalls()).toHaveLength(2);

    const again = startWorker();
    await again.ended;
    expect(workflow.providerCalls()).toHaveLength(2);
  });

  it('restores the verified pre-upgrade backup without claiming the work written after it', async () => {
    workflow.closeConnections();

    const restored = await workflow.json(['history', 'restore', backupName, '--apply', '--json']);

    expect(restored).toMatchObject({
      mode: 'apply',
      changed: true,
      work_written_after_backup: 'not-restored',
    });
    // The database that was in place is set aside whole, never removed.
    const replaced = restored.replaced as { database_file: string; schema_version: number };
    expect(replaced.schema_version).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
    expect(schemaVersionOf(databaseFile)).toBe(RELEASED_SCHEMA_VERSION);
  });

  it('reads as the tested history basis, and revives no lease', async () => {
    const listed = await workflow.json(['list', '--json']);
    expect(listed).toMatchObject({
      completeness: {
        complete: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'HISTORY_UPGRADE_REQUIRED' }),
        ]),
      },
    });
    expect(listed.results).toEqual([]);

    const status = await workflow.json(['knowledge', 'status', '--json']);
    expect(status.history_problem).toMatchObject({ code: 'upgrade_required' });
    expect(status.lease).toBeNull();
    // The backup predates every processing table, so there is no lease row to revive at all.
    expect(tableExists(databaseFile, 'processing_lease')).toBe(false);
  });

  it('repeats no settled paid work: the restored store holds neither the job nor its source', async () => {
    const worker = startWorker();
    await worker.ended;

    expect(workflow.providerCalls()).toHaveLength(2);
    expect(worker.output()).not.toContain('Took the processing lease');

    // The grant lives outside the repository, so it survived the restore; what did not survive is
    // the capture that was admitted after the backup, so there is nothing left to pay for.
    expect(
      JSON.parse(await readFile(processingGrantsFilePath(workflow.configHome), 'utf8')).grants
    ).toHaveLength(1);
    await workflow.json(['history', 'upgrade', '--apply', '--json']);
    writer = await workflow.open();
    expect(
      writer.read((view) => view.get<{ n: number }>('SELECT count(*) AS n FROM processing_jobs'))
        .value?.n
    ).toBe(0);
    const after = startWorker();
    await after.ended;
    expect(workflow.providerCalls()).toHaveLength(2);
  });
});
