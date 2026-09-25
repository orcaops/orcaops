import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { relatedKnowledgeBounds } from '@orcaops/core';
import type { ProjectDatabase } from '@orcaops/storage/history/database';
import { retrieveRelatedKnowledge } from '@orcaops/storage/history/database';

import {
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
} from '../../src/knowledge-worker/worker-fixture.test-support.js';
import { adoptedRequirement } from '../helpers/knowledge-records.js';
import {
  processingWorkflow,
  type ProcessingWorkflow,
  type ProviderPace,
} from '../helpers/processing-workflow.js';
import { type ScenarioWorkflow } from '../helpers/scenario-workflow.js';
import { adoptedRequirementAboutASubject } from '../helpers/subject-requirement.js';

/**
 * What a capture costs, what one worker settles, and what a bounded read costs, recorded rather
 * than asserted. `capture-latency.invariant.test.ts` holds the rule these numbers illustrate.
 *
 * Gated, because it takes minutes and its numbers are about the machine it ran on.
 */
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(() => true),
}));

const running = process.env.RUN_MEASUREMENTS === '1';
if (!running)
  process.stdout.write(
    'capture latency, throughput and bounded retrieval are not measured here: ' +
      'set RUN_MEASUREMENTS=1 to record them.\n'
  );

const execute = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ORCAOPS_ENTRY = fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url));

/** The wait the slow provider takes before answering anything. */
const SLOW_PROVIDER_MS = 4_000;
/** Runs made and thrown away before each configuration's measured set. */
const WARM_UP_RUNS = 5;
const MEASURED_RUNS = 20;
const ADMITTED_JOBS = 50;
/** What one worker's `max_calls_per_hour` allows, which the throughput run must stay inside. */
const CALLS_PER_HOUR = 60;
/**
 * How much a capture's median may exceed the processing-off median once a provider is answering
 * slowly or failing.
 */
const SLOW_PROVIDER_TOLERANCE = 1.25;

const CONFIGURATIONS: { name: string; pace: ProviderPace }[] = [
  { name: 'processing off', pace: { kind: 'none' } },
  { name: 'provider answers at once', pace: { kind: 'prompt' } },
  { name: 'provider waits four seconds', pace: { kind: 'delayed', delayMs: SLOW_PROVIDER_MS } },
  { name: 'provider fails every call', pace: { kind: 'failing' } },
];

interface Timings {
  samples: number;
  median_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
}

interface ConfigurationResult {
  'plan capture': Timings;
  'checkpoint close': Timings;
  queue: Record<string, number>;
  provider_calls: number;
}

const measurement: Record<string, unknown> = {};
let workDirectory: string;
let resultsFile: string;
/** The prompt-provider configuration's store, kept for the bounded-retrieval questions. */
let retrievalStore: ProcessingWorkflow | null = null;
let throughputFixture: WorkerFixture | null = null;

const round = (value: number): number => Math.round(value * 10) / 10;

/** Nearest rank: the value at ceil(fraction × n) of the sorted samples, never interpolated. */
function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

function timings(samples: readonly number[]): Timings {
  return {
    samples: samples.length,
    median_ms: round(percentile(samples, 0.5)),
    p95_ms: round(percentile(samples, 0.95)),
    min_ms: round(Math.min(...samples)),
    max_ms: round(Math.max(...samples)),
  };
}

const planBody = () => ({
  idempotency_key: `plan-${randomUUID()}`,
  task: 'Notes are flushed to disk before the screen reports them saved.',
  label: 'Capture latency',
  plan_steps: [
    {
      text: 'record what a capture costs with and without background processing',
      label: 'Record',
      acceptance_criteria: [{ text: 'every number names its build and machine' }],
    },
  ],
  touched_scope: ['storage'],
});

/** A plan capture, then a checkpoint opened and closed on the artifact it made. */
async function captureCycle(
  workflow: ScenarioWorkflow
): Promise<{ planMs: number; closeMs: number }> {
  const planInput = await workflow.inputDocument(planBody());
  const planAt = performance.now();
  const plan = await workflow.json(['capture', 'plan', '--input', planInput]);
  const planMs = performance.now() - planAt;

  const artifactId = plan.artifact_id as string;
  const stepId = (plan.plan_steps as { step_id: string }[])[0].step_id;
  const opened = await workflow.json([
    'capture',
    'checkpoint',
    'open',
    '--input',
    await workflow.inputDocument({
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: artifactId,
      declared_step_ids: [stepId],
    }),
  ]);
  const closeInput = await workflow.inputDocument({
    idempotency_key: `close-${randomUUID()}`,
    artifact_id: artifactId,
    n: opened.n,
    summary: 'Recorded what this checkpoint close costs',
    completed_step_ids: [],
    files_changed: [],
    verification: [],
  });
  const closeAt = performance.now();
  await workflow.json(['capture', 'checkpoint', 'close', '--input', closeInput]);
  return { planMs, closeMs: performance.now() - closeAt };
}

const queueStates = (handle: ProjectDatabase): Record<string, number> =>
  Object.fromEntries(
    handle
      .read((view) =>
        view.all<{ state: string; jobs: number }>(
          'SELECT state, count(*) AS jobs FROM processing_jobs GROUP BY state ORDER BY state'
        )
      )
      .value.map((row) => [row.state, row.jobs])
  );

const attemptCount = (handle: ProjectDatabase): number =>
  handle.read((view) => view.get<{ n: number }>('SELECT count(*) AS n FROM processing_attempts'))
    .value?.n ?? 0;

async function measureConfiguration(
  configuration: (typeof CONFIGURATIONS)[number]
): Promise<ConfigurationResult> {
  const processing = await processingWorkflow({
    pace: configuration.pace,
    callLog: path.join(workDirectory, `${configuration.name.replaceAll(' ', '-')}-calls`),
  });
  const stopWorker = processing.processingOn ? processing.keepAWorkerRunning() : null;
  try {
    for (let run = 0; run < WARM_UP_RUNS; run += 1) await captureCycle(processing.workflow);
    const plan: number[] = [];
    const close: number[] = [];
    for (let run = 0; run < MEASURED_RUNS; run += 1) {
      const cycle = await captureCycle(processing.workflow);
      plan.push(cycle.planMs);
      close.push(cycle.closeMs);
    }
    const handle = await processing.workflow.open();
    const result: ConfigurationResult = {
      'plan capture': timings(plan),
      'checkpoint close': timings(close),
      queue: queueStates(handle),
      provider_calls: attemptCount(handle),
    };
    processing.workflow.closeConnections();
    return result;
  } finally {
    if (stopWorker !== null) await stopWorker();
    if (configuration.pace.kind === 'prompt') retrievalStore = processing;
    else await processing.cleanup();
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function buildIdentity(): Promise<Record<string, unknown>> {
  const at = { cwd: REPO_ROOT };
  const commit = (await execute('git', ['rev-parse', 'HEAD'], at)).stdout.trim();
  const changes = (await execute('git', ['status', '--porcelain'], at)).stdout.trim();
  const manifest = JSON.parse(
    await readFile(path.join(REPO_ROOT, 'apps/orcaops-cli/package.json'), 'utf8')
  ) as { version: string };
  return {
    commit,
    working_tree: changes === '' ? 'clean' : `${changes.split('\n').length} changed files`,
    cli_version: manifest.version,
    node: process.version,
  };
}

function machineIdentity(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model ?? 'unknown',
    cores: cpus.length,
    memory_gib: Math.round(os.totalmem() / 1024 ** 3),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  };
}

beforeAll(async () => {
  workDirectory = await mkdtemp(path.join(os.tmpdir(), 'orcaops-capture-latency-'));
  resultsFile = path.join(workDirectory, 'capture-latency.json');
}, 60_000);

afterAll(async () => {
  await retrievalStore?.cleanup();
  await throughputFixture?.cleanup();
});

describe.skipIf(!running)(
  'capture latency, queue throughput and bounded retrieval',
  { timeout: 900_000 },
  () => {
    it('records capture completion latency with processing off and on', async () => {
      const recorded: Record<string, ConfigurationResult> = {};
      for (const configuration of CONFIGURATIONS)
        recorded[configuration.name] = await measureConfiguration(configuration);
      measurement.capture_latency = recorded;

      expect(Object.keys(recorded)).toEqual(CONFIGURATIONS.map((one) => one.name));
      for (const result of Object.values(recorded)) {
        expect(result['plan capture'].samples).toBe(MEASURED_RUNS);
        expect(result['checkpoint close'].samples).toBe(MEASURED_RUNS);
      }
      // A configuration whose provider was never reached would say nothing about model latency.
      expect(recorded['provider waits four seconds'].provider_calls).toBeGreaterThan(0);
      expect(recorded['provider fails every call'].provider_calls).toBeGreaterThan(0);
      expect(recorded['processing off'].provider_calls).toBe(0);

      // The tolerance the document states. Only the ratio is asserted, and only on medians: the
      // milliseconds belong to the machine that measured them, and the p95 moves with whatever else
      // that machine is doing. A capture that waited on this provider would be four seconds, so
      // this bites long before anything approaching a model wait reaches the capture path.
      const off = recorded['processing off'];
      for (const operation of ['plan capture', 'checkpoint close'] as const)
        for (const name of ['provider waits four seconds', 'provider fails every call'] as const)
          expect(
            recorded[name][operation].median_ms,
            `${name}, ${operation}, against processing off`
          ).toBeLessThanOrEqual(off[operation].median_ms * SLOW_PROVIDER_TOLERANCE);
    });

    it('records what one worker settles from a queue of fifty admitted jobs', async () => {
      const fixture = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER });
      throughputFixture = fixture;
      await fixture.writeConfig({
        enabled: true,
        idle_exit_ms: 1_000,
        max_calls_per_hour: CALLS_PER_HOUR,
      });
      const admitted: string[] = [];
      // Each job is its own captured artifact, settled the way `capture plan` settles one.
      for (let job = 0; job < ADMITTED_JOBS; job += 1)
        admitted.push((await fixture.captureAndAdmit()).jobId);

      const settled = () =>
        admitted.filter((jobId) => {
          const state = fixture.job(jobId).state;
          return state !== 'pending' && state !== 'running';
        }).length;
      const at = Date.now();
      const worker = spawn(process.execPath, [ORCAOPS_ENTRY, 'knowledge', 'worker'], {
        cwd: fixture.repoPath,
        env: fixture.env,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      try {
        await waitFor(() => settled() === ADMITTED_JOBS, 'the queue to settle', 600_000);
      } finally {
        worker.kill('SIGTERM');
      }
      const elapsed = Date.now() - at;
      const completed = admitted.filter((jobId) => fixture.job(jobId).state === 'completed').length;
      const calls = attemptCount(fixture.handle);

      measurement.queue_throughput = {
        admitted: ADMITTED_JOBS,
        settled: settled(),
        completed,
        calls,
        knowledge_rows: fixture.knowledgeRows(),
        elapsed_ms: elapsed,
        jobs_per_minute: round((ADMITTED_JOBS / elapsed) * 60_000),
        workers: 1,
        calls_per_hour_allowed: CALLS_PER_HOUR,
      };
      expect(completed).toBe(ADMITTED_JOBS);
      // A job settled without reaching the provider would make this a measurement of something
      // else: the number is jobs per minute through the model, not through the queue alone.
      expect(calls).toBeGreaterThanOrEqual(ADMITTED_JOBS);
    });

    it('records bounded retrieval over the store these captures built', async () => {
      const store = retrievalStore;
      if (store === null) throw new Error('the prompt-provider store was not kept');
      const handle = await store.workflow.open();
      const projectId = (await store.workflow.authority()).projectId;
      await adoptedRequirement(handle, {
        projectId,
        statement: 'A capture commits without waiting for a provider.',
      });
      const subject = await adoptedRequirementAboutASubject(handle, {
        projectId,
        statement: 'Background processing answers after the capture, never during it.',
        subjectLabel: 'Background processing',
      });

      const questions: { name: string; args: string[] }[] = [
        { name: 'a text question', args: ['knowledge', 'lookup', 'flushed to disk', '--json'] },
        { name: 'every adopted record', args: ['knowledge', 'lookup', '--adopted', '--json'] },
        {
          name: 'one subject',
          args: ['knowledge', 'lookup', '--subject', subject.subjectId, '--json'],
        },
      ];
      const asked: Record<string, unknown> = {};
      for (const question of questions) {
        for (let run = 0; run < WARM_UP_RUNS; run += 1) await store.workflow.json(question.args);
        const samples: number[] = [];
        let entries = 0;
        for (let run = 0; run < MEASURED_RUNS; run += 1) {
          const at = performance.now();
          const answer = await store.workflow.json(question.args);
          samples.push(performance.now() - at);
          entries = (answer.entries as unknown[]).length;
        }
        asked[question.name] = { ...timings(samples), entries };
      }

      const source = handle.read((view) =>
        view.get<{ artifactId: string; eventId: string; task: string }>(
          `SELECT artifact_id AS artifactId, event_id AS eventId,
             json_extract(CAST(record_bytes AS TEXT), '$.payload.task') AS task
           FROM artifact_events WHERE event_type='plan_captured' ORDER BY recorded_at LIMIT 1`
        )
      ).value;
      if (source == null) throw new Error('the kept store holds no captured plan');
      const boundary = handle.read(() => null).counters.writeSequence;
      const request = {
        source: {
          artifactId: source.artifactId,
          eventId: source.eventId,
          planEventId: source.eventId,
          text: source.task,
        },
        projectId,
        scope: { kind: 'artifact' as const, artifact_id: source.artifactId },
        boundary,
        bounds: relatedKnowledgeBounds({ max_input_bytes: 131_072 }),
      };
      for (let run = 0; run < WARM_UP_RUNS; run += 1)
        handle.read((view) => retrieveRelatedKnowledge(view, request));
      const retrieval: number[] = [];
      let identities = 0;
      for (let run = 0; run < MEASURED_RUNS; run += 1) {
        const at = performance.now();
        const answer = handle.read((view) => retrieveRelatedKnowledge(view, request)).value;
        retrieval.push(performance.now() - at);
        identities = answer.entries.length;
      }
      asked['the manifest-filling retrieval (retrieveRelatedKnowledge)'] = {
        ...timings(retrieval),
        identities,
      };

      measurement.bounded_retrieval = asked;
      measurement.store = handle.read((view) => ({
        artifacts: view.get<{ n: number }>('SELECT count(*) AS n FROM artifacts')?.n ?? 0,
        artifact_events:
          view.get<{ n: number }>('SELECT count(*) AS n FROM artifact_events')?.n ?? 0,
        search_sources:
          view.get<{ n: number }>('SELECT count(*) AS n FROM artifact_search_sources')?.n ?? 0,
        knowledge_sources:
          view.get<{ n: number }>('SELECT count(*) AS n FROM knowledge_sources')?.n ?? 0,
        requirement_revisions:
          view.get<{ n: number }>('SELECT count(*) AS n FROM requirement_revisions')?.n ?? 0,
      })).value;

      expect(Object.keys(asked)).toHaveLength(4);
    });

    it('writes what was measured, naming the build and the machine that measured it', async () => {
      measurement.measured_at = new Date().toISOString();
      measurement.build = await buildIdentity();
      measurement.machine = machineIdentity();
      measurement.method = {
        capture_latency:
          'Each configuration is its own repository, project database and user-local ' +
          'configuration. A cycle is one `capture plan`, one `capture checkpoint open` and one ' +
          '`capture checkpoint close`; the plan capture and the close are timed, the open is ' +
          'not. Commands run in process through the CLI test harness, so process start is ' +
          'excluded. With processing on, consent is recorded and one background worker runs as ' +
          'a real process throughout, restarted whenever it exits, because an in-process ' +
          'capture cannot start one.',
        warm_up: `${WARM_UP_RUNS} discarded cycles before ${MEASURED_RUNS} measured ones.`,
        queue_throughput:
          `${ADMITTED_JOBS} jobs admitted through the capture settlement path before the worker ` +
          'starts, then one worker as a real process, timed until every job is settled.',
        bounded_retrieval:
          'Over the store the `provider answers at once` configuration left behind. The three ' +
          'questions run in process through the harness; the manifest-filling retrieval is a ' +
          'direct call on an open reader, with the bounds the worker uses for a 131,072-byte ' +
          'input budget.',
      };

      const block = `${JSON.stringify(measurement, null, 2)}\n`;
      await writeFile(resultsFile, block, 'utf8');
      process.stdout.write(`${block}measurement written to ${resultsFile}\n`);

      expect(Object.keys(measurement).sort()).toEqual([
        'bounded_retrieval',
        'build',
        'capture_latency',
        'machine',
        'measured_at',
        'method',
        'queue_throughput',
        'store',
      ]);
    });
  }
);
