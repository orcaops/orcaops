import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  CURRENT_STORY_POINTER_FILE,
  serializeStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
} from '@orcaops/review-engine';

import {
  STORY_NAVIGATION_SAMPLES,
  STORY_WHEEL_SAMPLES,
  type StoryInteractionMeasurement,
} from './review-story-interaction-measure';
import { readReviewGenerations } from '../src/data/reviewSource';
import {
  collectCpuAttributedWallSamples,
  externallyDescheduled as isExternallyDescheduled,
  judgePreemptedSample,
} from '../src/perfSamplePolicy';
import { SPINNER_FRAMES } from '../src/tui/components/LoadingScreen';
import { projectStoryPartReaderPage } from '../src/tui/review/pageProjection';
import { buildStoryReader } from '../src/tui/review/readerModel';
import {
  buildReviewAppHarness,
  loadedReviewWithStoryFixture,
} from '../tests/review/reviewAppHarness';
import {
  buildProductionStoryReviewHarnessFixture,
  storyOverlay,
} from '../tests/review/storyReviewHarness';
import { terminalRunFileSeed } from '../tests/support/twolaneRunFile';

const STORY_READER_ITERATIONS = 25;
const STORY_WIDTHS = [80, 110, 160] as const;
const STORY_COLD_BRIEF_SAMPLES = 20;
const STORY_COLD_BRIEF_BATCH_SIZE = 1;
const STORY_ACTIVE_PART_SAMPLES = 200;
const STORY_PASSIVE_PROBE_SAMPLES = 50;
const STORY_MOUNTED_NODE_LIMIT = 1_000;
const STORY_FIRST_USEFUL_P50_BUDGET_MS = 100;
const STORY_FIRST_USEFUL_P95_BUDGET_MS = 150;
const STORY_NAVIGATION_P50_BUDGET_MS = 100;
const STORY_NAVIGATION_P95_BUDGET_MS = 150;
const STORY_WHEEL_P50_BUDGET_MS = 8;
const STORY_WHEEL_P95_BUDGET_MS = 16.7;
const STORY_ACTIVE_PART_P95_BUDGET_MS = 16;
const STORY_READER_BUILD_P95_BUDGET_MS = 150;
const STORY_EVENT_LOOP_STALL_BUDGET_MS = 50;
const STORY_SPINNER_HEARTBEAT_BUDGET_MS = 100;
const STORY_PASSIVE_PROBE_P95_BUDGET_MS = 10;
const STORY_SCHEDULER_ACTIVE_RATIO = 0.8;
const STORY_SCHEDULER_RETRY_LIMIT = 3;

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]!;
}

function sampleStats(values: readonly number[]) {
  const rounded = (value: number) => Number(value.toFixed(3));
  const p50Ms = rounded(percentile(values, 0.5));
  const p95Ms = rounded(percentile(values, 0.95));
  const maxMs = rounded(Math.max(...values));
  return {
    p50Ms,
    p95Ms,
    maxMs,
    sampleCount: values.length,
    percentileMethod: 'nearest-rank' as const,
  };
}

function stats(values: readonly number[], budgetMs: number) {
  const observed = sampleStats(values);
  return {
    ...observed,
    budgetMs,
    pass: observed.p95Ms <= budgetMs,
  };
}

function latencyBudget(values: readonly number[], input: { p50Ms: number; p95Ms: number }) {
  const observed = stats(values, input.p95Ms);
  return {
    ...observed,
    p50BudgetMs: input.p50Ms,
    p95BudgetMs: input.p95Ms,
    pass: observed.p50Ms <= input.p50Ms && observed.p95Ms <= input.p95Ms,
  };
}

interface IsolatedColdBriefSample {
  latencyMs: number;
  activeCpuMs: number;
  useful: boolean;
  mountedNodes: number;
}

interface IsolatedStoryInteractionMeasurement extends StoryInteractionMeasurement {
  readonly schedulerRetries: number;
  readonly schedulerDiscardedNavigationSamples: number;
  readonly schedulerDiscardedWheelSamples: number;
}

interface StoryColdBriefMeasurement {
  readonly samples: readonly IsolatedColdBriefSample[];
  readonly schedulerDiscardedSamples: number;
}

function externallyDescheduled(input: {
  wallMs: number;
  activeCpuMs: number;
  budgetMs: number;
}): boolean {
  return isExternallyDescheduled({ ...input, activeRatio: STORY_SCHEDULER_ACTIVE_RATIO });
}

async function runPerformanceWorker<T>(workerName: string, args: readonly string[]): Promise<T> {
  const worker = path.join(import.meta.dir, workerName);
  return new Promise<T>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, ...args], {
      cwd: path.resolve(import.meta.dir, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${workerName} exited ${code ?? 'without status'}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject(
          new Error(`${workerName} returned invalid JSON: ${stdout}`, {
            cause: error,
          })
        );
      }
    });
  });
}

async function measureSpinnerHeartbeat() {
  const wallSamples: number[] = [];
  const activeCpuSamples: number[] = [];
  let schedulerDiscardedSamples = 0;
  for (let attempt = 0; attempt <= STORY_SCHEDULER_RETRY_LIMIT; attempt += 1) {
    const measured = await runPerformanceWorker<{
      samples?: readonly { wallMs: number; activeCpuMs: number }[];
      observedFrames?: number;
      expectedFrames?: number;
    }>('review-spinner-heartbeat-worker.ts', []);
    if (
      measured.samples?.length !== SPINNER_FRAMES.length ||
      measured.observedFrames !== SPINNER_FRAMES.length ||
      measured.expectedFrames !== SPINNER_FRAMES.length
    ) {
      throw new Error(
        `spinner worker published ${measured.observedFrames ?? 0}/${SPINNER_FRAMES.length} committed frames`
      );
    }
    for (const sample of measured.samples) {
      if (wallSamples.length === SPINNER_FRAMES.length) break;
      if (
        externallyDescheduled({
          wallMs: sample.wallMs,
          activeCpuMs: sample.activeCpuMs,
          budgetMs: STORY_SPINNER_HEARTBEAT_BUDGET_MS,
        })
      ) {
        schedulerDiscardedSamples += 1;
        continue;
      }
      wallSamples.push(sample.wallMs);
      activeCpuSamples.push(sample.activeCpuMs);
    }
    if (wallSamples.length === SPINNER_FRAMES.length) {
      const observed = stats(wallSamples, STORY_SPINNER_HEARTBEAT_BUDGET_MS);
      return {
        ...observed,
        activeCpuAtWallGap: sampleStats(activeCpuSamples),
        schedulerRetries: attempt,
        schedulerDiscardedSamples,
        observedFrames: wallSamples.length,
        expectedFrames: SPINNER_FRAMES.length,
        pass: observed.maxMs <= STORY_SPINNER_HEARTBEAT_BUDGET_MS,
      };
    }
    await Bun.sleep(100);
  }
  throw new Error('spinner worker could not collect scheduler-attributed heartbeat samples');
}

async function measureIsolatedColdBrief(
  width: (typeof STORY_WIDTHS)[number],
  sampleCount: number
): Promise<readonly IsolatedColdBriefSample[]> {
  const parsed = await runPerformanceWorker<{ samples?: readonly IsolatedColdBriefSample[] }>(
    'review-story-cold-brief-worker.ts',
    [String(width), String(sampleCount)]
  );
  if (parsed.samples?.length !== sampleCount) {
    throw new Error(
      `expected ${sampleCount} cold samples, received ${parsed.samples?.length ?? 0}`
    );
  }
  return parsed.samples;
}

async function measureIsolatedStoryInteraction(
  width: (typeof STORY_WIDTHS)[number]
): Promise<IsolatedStoryInteractionMeasurement> {
  const navigationCommitSamples: number[] = [];
  const navigationActiveCpuSamples: number[] = [];
  const wheelCommitSamples: number[] = [];
  const wheelActiveCpuSamples: number[] = [];
  const eventLoopNavigationSamples: number[] = [];
  const eventLoopNavigationActiveSamples: number[] = [];
  const eventLoopWheelSamples: number[] = [];
  const eventLoopWheelActiveSamples: number[] = [];
  let schedulerDiscardedNavigationSamples = 0;
  let schedulerDiscardedWheelSamples = 0;
  let maxMountedNodes = 0;
  for (let attempt = 0; attempt <= STORY_SCHEDULER_RETRY_LIMIT; attempt += 1) {
    const measured = await runPerformanceWorker<StoryInteractionMeasurement>(
      'review-story-interaction-worker.ts',
      [String(width)]
    );
    if (
      measured.validNavigationCommits !== STORY_NAVIGATION_SAMPLES ||
      measured.validWheelCommits !== STORY_WHEEL_SAMPLES ||
      !measured.finalNavigationFrameValid ||
      !measured.finalWheelFrameValid
    ) {
      throw new Error(`Story interaction worker published an invalid frame at ${width} columns`);
    }
    maxMountedNodes = Math.max(maxMountedNodes, measured.maxMountedNodes);

    for (
      let index = 0;
      index < measured.navigationCommitSamples.length &&
      navigationCommitSamples.length < STORY_NAVIGATION_SAMPLES;
      index += 1
    ) {
      const wallMs = measured.navigationCommitSamples[index]!;
      const activeCpuMs = measured.navigationActiveCpuSamples[index] ?? 0;
      const eventLoopWallMs = measured.eventLoopStallSamples[index] ?? 0;
      const eventLoopActiveCpuMs = measured.eventLoopActiveSamples[index] ?? 0;
      const preempted =
        externallyDescheduled({
          wallMs,
          activeCpuMs,
          budgetMs: STORY_NAVIGATION_P50_BUDGET_MS,
        }) ||
        externallyDescheduled({
          wallMs: eventLoopWallMs,
          activeCpuMs: eventLoopActiveCpuMs,
          budgetMs: STORY_EVENT_LOOP_STALL_BUDGET_MS,
        });
      if (preempted) {
        schedulerDiscardedNavigationSamples += 1;
        continue;
      }
      navigationCommitSamples.push(wallMs);
      navigationActiveCpuSamples.push(activeCpuMs);
      eventLoopNavigationSamples.push(eventLoopWallMs);
      eventLoopNavigationActiveSamples.push(eventLoopActiveCpuMs);
    }

    for (
      let index = 0;
      index < measured.wheelCommitSamples.length && wheelCommitSamples.length < STORY_WHEEL_SAMPLES;
      index += 1
    ) {
      const eventIndex = STORY_NAVIGATION_SAMPLES + index;
      const wallMs = measured.wheelCommitSamples[index]!;
      const activeCpuMs = measured.wheelActiveCpuSamples[index] ?? 0;
      const eventLoopWallMs = measured.eventLoopStallSamples[eventIndex] ?? 0;
      const eventLoopActiveCpuMs = measured.eventLoopActiveSamples[eventIndex] ?? 0;
      const preempted =
        externallyDescheduled({
          wallMs,
          activeCpuMs,
          budgetMs: STORY_WHEEL_P50_BUDGET_MS,
        }) ||
        externallyDescheduled({
          wallMs: eventLoopWallMs,
          activeCpuMs: eventLoopActiveCpuMs,
          budgetMs: STORY_EVENT_LOOP_STALL_BUDGET_MS,
        });
      if (preempted) {
        schedulerDiscardedWheelSamples += 1;
        continue;
      }
      wheelCommitSamples.push(wallMs);
      wheelActiveCpuSamples.push(activeCpuMs);
      eventLoopWheelSamples.push(eventLoopWallMs);
      eventLoopWheelActiveSamples.push(eventLoopActiveCpuMs);
    }

    if (
      navigationCommitSamples.length === STORY_NAVIGATION_SAMPLES &&
      wheelCommitSamples.length === STORY_WHEEL_SAMPLES
    ) {
      return {
        navigationCommitSamples,
        navigationActiveCpuSamples,
        wheelCommitSamples,
        wheelActiveCpuSamples,
        eventLoopStallSamples: [...eventLoopNavigationSamples, ...eventLoopWheelSamples],
        eventLoopActiveSamples: [
          ...eventLoopNavigationActiveSamples,
          ...eventLoopWheelActiveSamples,
        ],
        validNavigationCommits: STORY_NAVIGATION_SAMPLES,
        finalNavigationFrameValid: true,
        validWheelCommits: STORY_WHEEL_SAMPLES,
        finalWheelFrameValid: true,
        maxMountedNodes,
        schedulerRetries: attempt,
        schedulerDiscardedNavigationSamples,
        schedulerDiscardedWheelSamples,
      };
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Story interaction worker could not collect scheduler-attributed samples at ${width} columns`
  );
}

async function measureStoryColdBrief(
  width: (typeof STORY_WIDTHS)[number]
): Promise<StoryColdBriefMeasurement> {
  const samples: IsolatedColdBriefSample[] = [];
  let schedulerDiscardedSamples = 0;
  while (samples.length < STORY_COLD_BRIEF_SAMPLES) {
    // Give every measured entry an independently warmed heap. This preserves
    // Watch's already-running/JIT-warm entry condition without allowing
    // destroyed synthetic apps to collect inside a later sample.
    const batchSize = Math.min(
      STORY_COLD_BRIEF_BATCH_SIZE,
      STORY_COLD_BRIEF_SAMPLES - samples.length
    );
    for (const sample of await measureIsolatedColdBrief(width, batchSize)) {
      const preempted = externallyDescheduled({
        wallMs: sample.latencyMs,
        activeCpuMs: sample.activeCpuMs,
        budgetMs: STORY_FIRST_USEFUL_P50_BUDGET_MS,
      });
      const verdict = judgePreemptedSample({
        preempted,
        discardedSoFar: schedulerDiscardedSamples,
        discardBudget: STORY_COLD_BRIEF_SAMPLES,
      });
      if (verdict === 'discard') {
        schedulerDiscardedSamples += 1;
        continue;
      }
      if (verdict === 'fail') {
        // Once the discard budget is exhausted, another preempted sample
        // means the host is too loaded for a trustworthy measurement.
        throw new Error(
          `Story cold-Brief sampling discarded ${String(schedulerDiscardedSamples)} scheduler-preempted samples (budget ${String(STORY_COLD_BRIEF_SAMPLES)}) and the next sample was still preempted — rerun on a quieter host.`
        );
      }
      samples.push(sample);
    }
    // The child has exited and its two renderer roots are no longer live. Give
    // the OS one short idle slice to reclaim them before starting the next
    // independent entry process.
    await Bun.sleep(50);
  }
  return { samples, schedulerDiscardedSamples };
}

async function installPassiveProbeFixture(input: {
  root: string;
  floor: Awaited<ReturnType<typeof buildProductionStoryReviewHarnessFixture>>['floor'];
  reviewDiff: string;
  model: Awaited<ReturnType<typeof buildProductionStoryReviewHarnessFixture>>['model'];
}): Promise<void> {
  const reviewDir = path.join(input.root, '.orcaops', 'reviews', 'probe');
  const twolaneDir = path.join(reviewDir, 'twolane');
  const runId = '77777777-7777-7777-8777-777777777777';
  const runDir = path.join(twolaneDir, runId);
  const historicalDir = path.join(twolaneDir, '66666666-6666-4666-8666-666666666666');
  const modelBytes = serializeStoryReviewModel(input.model);
  const modelSha = createHash('sha256').update(modelBytes).digest('hex');
  const finalizedAt = '2026-07-23T12:00:00.000Z';
  const inputShas = { dossier: 'performance-dossier', projection: 'performance-projection' };
  await Promise.all([
    mkdir(runDir, { recursive: true }),
    mkdir(historicalDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(reviewDir, 'floor.json'), `${JSON.stringify(input.floor)}\n`),
    writeFile(path.join(reviewDir, 'diff.patch'), input.reviewDiff),
    writeFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), modelBytes),
    writeFile(
      path.join(runDir, 'run-v1.json'),
      `${JSON.stringify(
        terminalRunFileSeed({ runId, branch: input.model.branch, finalizedAt, inputShas })
      )}\n`
    ),
    writeFile(
      path.join(runDir, 'run-record-v1.json'),
      `${JSON.stringify({
        schema_version: 1,
        run_id: runId,
        branch: input.model.branch,
        input_shas: inputShas,
        finalized_at: finalizedAt,
        outcome: 'FULL',
        outputs: {
          story_review_model: STORY_REVIEW_MODEL_FILE,
          story_review_model_sha256: modelSha,
        },
      })}\n`
    ),
    writeFile(
      path.join(twolaneDir, CURRENT_STORY_POINTER_FILE),
      `${JSON.stringify({
        schema_version: 1,
        run_id: runId,
        finalized_at: finalizedAt,
        floor_input_hash: input.model.floor_input_hash,
        model_file: STORY_REVIEW_MODEL_FILE,
        model_sha256: modelSha,
      })}\n`
    ),
    // A corrupt historical generation is deliberate: an idle passive probe may
    // stat only the current pointer/run and must never parse or hash this file.
    writeFile(
      path.join(historicalDir, 'story-review-model-v3.json'),
      '{historical generation must not be parsed'
    ),
  ]);
}

async function measurePassiveStoryProbe(input: {
  floor: Awaited<ReturnType<typeof buildProductionStoryReviewHarnessFixture>>['floor'];
  reviewDiff: string;
  model: Awaited<ReturnType<typeof buildProductionStoryReviewHarnessFixture>>['model'];
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-story-passive-perf-'));
  try {
    await installPassiveProbeFixture({ root, ...input });
    const installed = await readReviewGenerations({ root, branch: 'probe' });
    const samples: number[] = [];
    for (let index = 0; index < STORY_PASSIVE_PROBE_SAMPLES; index += 1) {
      const started = performance.now();
      const next = await readReviewGenerations({ root, branch: 'probe' });
      samples.push(performance.now() - started);
      if (
        next.story !== installed.story ||
        next.storyInstallation !== installed.storyInstallation ||
        next.storyAnchors !== installed.storyAnchors
      ) {
        throw new Error('idle passive Story probe changed immutable generation identity');
      }
    }
    return {
      ...stats(samples, STORY_PASSIVE_PROBE_P95_BUDGET_MS),
      historicalCorruptRunPresent: true,
      currentRunOnly: true,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// CI enters this process immediately after other renderer-heavy suites. None of
// that work belongs to the benchmarked Watch process, so start from one short
// scheduler/memory quiescence boundary before launching isolated TUI workers.
await Bun.sleep(250);
const spinnerHeartbeat = await measureSpinnerHeartbeat();
const storyInteractions = new Map<number, IsolatedStoryInteractionMeasurement>();
const storyColdBriefMeasurements = new Map<number, StoryColdBriefMeasurement>();
for (const width of STORY_WIDTHS) {
  await Bun.sleep(100);
  storyInteractions.set(width, await measureIsolatedStoryInteraction(width));
  storyColdBriefMeasurements.set(width, await measureStoryColdBrief(width));
}

const storyFixture = buildProductionStoryReviewHarnessFixture();
const storyBase = await buildReviewAppHarness({ scenario: 'no-narrative' });
const routineStory = await storyOverlay(storyFixture.model, {
  runId: '77777777-7777-7777-8777-777777777777',
  installationToken: 'story-performance-installation',
});
const storyLoaded = await loadedReviewWithStoryFixture({
  base: storyBase.loaded,
  floor: storyFixture.floor,
  reviewDiff: storyFixture.reviewDiff,
  routineStory,
});
const storyReaderInput = {
  floor: storyLoaded.data.floor,
  model: storyFixture.model,
  reviewDiff: storyLoaded.data.reviewDiff,
  semanticAnchors: null,
  eligibleTargets: storyLoaded.data.eligibleTargets,
  ledger: storyLoaded.ledger,
  currentThreads: storyLoaded.data.currentThreads,
  finishFacts: {
    targets: storyLoaded.data.targetsStatus,
    currentGapRows: storyLoaded.data.currentGapRows,
    comments: storyLoaded.comments.comments,
  },
} as const;

const { wallSamples: watchSamples, schedulerDiscardedSamples: watchSchedulerDiscardedSamples } =
  collectCpuAttributedWallSamples({
    sampleCount: STORY_READER_ITERATIONS,
    discardBudget: STORY_READER_ITERATIONS,
    budgetMs: STORY_READER_BUILD_P95_BUDGET_MS,
    activeRatio: STORY_SCHEDULER_ACTIVE_RATIO,
    label: 'Story reader',
    measure: () => {
      const cpuStarted = process.cpuUsage();
      const started = performance.now();
      const reader = buildStoryReader(storyReaderInput);
      const wallMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStarted);
      if (reader.pages.length !== storyFixture.model.parts.length) {
        throw new Error('Story reader dropped a production-scale Part');
      }
      return { wallMs, activeCpuMs: (cpu.user + cpu.system) / 1_000 };
    },
  });

const activePartSamples: number[] = [];
for (let index = 0; index < STORY_ACTIVE_PART_SAMPLES; index += 1) {
  const part = storyFixture.model.parts[index % storyFixture.model.parts.length]!;
  const started = performance.now();
  const projection = projectStoryPartReaderPage({
    floor: storyFixture.floor,
    segments: part.segments,
    ambiguous: part.ambiguous,
  });
  activePartSamples.push(performance.now() - started);
  if (projection.sliceStops.length !== part.segments.length + part.ambiguous.length) {
    throw new Error(`active Part projection lost Story stops for ${part.id}`);
  }
}

async function measureStoryWidth(
  width: (typeof STORY_WIDTHS)[number],
  interaction: IsolatedStoryInteractionMeasurement,
  coldBrief: StoryColdBriefMeasurement
) {
  const coldBriefSamples = coldBrief.samples;
  const firstUsefulSamples = coldBriefSamples.map((sample) => sample.latencyMs);
  const usefulBriefFrames = coldBriefSamples.filter((sample) => sample.useful).length;
  let maxMountedNodes = Math.max(...coldBriefSamples.map((sample) => sample.mountedNodes));

  maxMountedNodes = Math.max(maxMountedNodes, interaction.maxMountedNodes);
  const firstUseful = latencyBudget(firstUsefulSamples, {
    p50Ms: STORY_FIRST_USEFUL_P50_BUDGET_MS,
    p95Ms: STORY_FIRST_USEFUL_P95_BUDGET_MS,
  });
  const navigation = latencyBudget(interaction.navigationCommitSamples, {
    p50Ms: STORY_NAVIGATION_P50_BUDGET_MS,
    p95Ms: STORY_NAVIGATION_P95_BUDGET_MS,
  });
  const wheel = latencyBudget(interaction.wheelCommitSamples, {
    p50Ms: STORY_WHEEL_P50_BUDGET_MS,
    p95Ms: STORY_WHEEL_P95_BUDGET_MS,
  });
  // A zero-delay heartbeat runs from just before each input until its existing
  // layout-commit publication. Wall-clock gaps remain the hard gate. The paired
  // process-CPU samples are disclosed as the attribution witness used only to
  // replace bounded, individually attributed samples.
  const eventLoop = stats(interaction.eventLoopStallSamples, STORY_EVENT_LOOP_STALL_BUDGET_MS);
  const activeCpuAtWallGap = sampleStats(interaction.eventLoopActiveSamples);
  return {
    width,
    firstUsefulBrief: {
      ...firstUseful,
      schedulerDiscardedSamples: coldBrief.schedulerDiscardedSamples,
      usefulFrames: usefulBriefFrames,
      expectedFrames: STORY_COLD_BRIEF_SAMPLES,
      pass: firstUseful.pass && usefulBriefFrames === STORY_COLD_BRIEF_SAMPLES,
    },
    partNavigation: {
      ...navigation,
      schedulerRetries: interaction.schedulerRetries,
      schedulerDiscardedSamples: interaction.schedulerDiscardedNavigationSamples,
      measurement: 'input-to-committed-part' as const,
      validCommits: interaction.validNavigationCommits,
      expectedCommits: STORY_NAVIGATION_SAMPLES,
      finalFrameValid: interaction.finalNavigationFrameValid,
      pass:
        navigation.pass &&
        interaction.validNavigationCommits === STORY_NAVIGATION_SAMPLES &&
        interaction.finalNavigationFrameValid,
    },
    wheel: {
      ...wheel,
      schedulerRetries: interaction.schedulerRetries,
      schedulerDiscardedSamples: interaction.schedulerDiscardedWheelSamples,
      validCommits: interaction.validWheelCommits,
      expectedCommits: STORY_WHEEL_SAMPLES,
      finalFrameValid: interaction.finalWheelFrameValid,
      pass:
        wheel.pass &&
        interaction.validWheelCommits === STORY_WHEEL_SAMPLES &&
        interaction.finalWheelFrameValid,
    },
    postLoadEventLoop: {
      ...eventLoop,
      measurement: 'max-zero-delay-heartbeat-wall-gap-during-input' as const,
      activeCpuAtWallGap,
      schedulerRetries: interaction.schedulerRetries,
      schedulerDiscardedSamples:
        interaction.schedulerDiscardedNavigationSamples +
        interaction.schedulerDiscardedWheelSamples,
      pass: eventLoop.maxMs <= STORY_EVENT_LOOP_STALL_BUDGET_MS,
    },
    maxMountedNodes,
    mountedNodesPass: maxMountedNodes <= STORY_MOUNTED_NODE_LIMIT,
  };
}

const storyWidths = [];
for (const width of STORY_WIDTHS) {
  const interaction = storyInteractions.get(width);
  if (interaction === undefined) throw new Error(`missing Story interaction sample at ${width}`);
  const coldBrief = storyColdBriefMeasurements.get(width);
  if (coldBrief === undefined) {
    throw new Error(`missing Story first-useful samples at ${width}`);
  }
  storyWidths.push(await measureStoryWidth(width, interaction, coldBrief));
}
const passiveStoryResolution = await measurePassiveStoryProbe({
  floor: storyFixture.floor,
  reviewDiff: storyFixture.reviewDiff,
  model: storyFixture.model,
});
const activePartProjection = stats(activePartSamples, STORY_ACTIVE_PART_P95_BUDGET_MS);
const storyReaderBuild = stats(watchSamples, STORY_READER_BUILD_P95_BUDGET_MS);
const storyPerformanceChecks = {
  storyReaderBuildWithinFirstUsefulBudget: storyReaderBuild.pass,
  activePartProjectionWithinBudget: activePartProjection.pass,
  everyWidthFirstUsefulWithinBudget: storyWidths.every((result) => result.firstUsefulBrief.pass),
  everyWidthNavigationWithinBudget: storyWidths.every((result) => result.partNavigation.pass),
  everyWidthWheelWithinBudget: storyWidths.every((result) => result.wheel.pass),
  everyWidthMountBounded: storyWidths.every((result) => result.mountedNodesPass),
  noPostLoadEventLoopStall: storyWidths.every((result) => result.postLoadEventLoop.pass),
  spinnerHeartbeatWithinBudget: spinnerHeartbeat.pass,
  idlePassiveResolutionWithinBudget: passiveStoryResolution.pass,
  passiveResolutionCurrentRunOnly: passiveStoryResolution.currentRunOnly,
};
const storyPerformancePass = Object.values(storyPerformanceChecks).every(Boolean);

const report = {
  schema_version: 4,
  environment: {
    runtime: `Bun ${Bun.version}`,
    percentileMethod: 'nearest-rank',
    note: 'The spinner heartbeat runs in an isolated loading-shell process. Each first-useful Story Brief sample runs in an independent Bun process with one untimed live warm root, then times a second root from fresh immutable-generation reader/shell construction through a useful committed frame. Each width interaction runs in its own mounted Story process with a 16 ms unmeasured inter-input cadence. Host quiescence, process startup, fixture preparation, warm-up work, and teardown occur outside measured intervals. Fixed gates remain wall-clock gates. For measurements with paired process CPU, an over-budget sample is classified as externally preempted only when CPU is below 80% of wall time; replacement is bounded and discarded-sample counts are disclosed.',
  },

  watchProjection: {
    ...storyReaderBuild,
    iterations: STORY_READER_ITERATIONS,
    schedulerDiscardedSamples: watchSchedulerDiscardedSamples,
    operation: 'buildStoryReader over the calibrated 4-Act/8-Part routine Story fixture',
  },
  storyReview: {
    fixture: {
      acts: storyFixture.model.acts.length,
      parts: storyFixture.model.parts.length,
      segments: storyFixture.model.parts.reduce((sum, part) => sum + part.segments.length, 0),
      reviewableRows: storyFixture.model.metrics.reviewableRows,
      widths: STORY_WIDTHS,
    },
    activePartProjection: {
      ...activePartProjection,
      iterations: STORY_ACTIVE_PART_SAMPLES,
      operation: 'projectStoryPartReaderPage for one active Part',
    },
    widths: storyWidths,
    spinnerHeartbeat,
    passiveStoryResolution,
    checks: storyPerformanceChecks,
    pass: storyPerformancePass,
  },
};

process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.watchProjection.pass || !report.storyReview.pass) {
  process.exitCode = 1;
}
