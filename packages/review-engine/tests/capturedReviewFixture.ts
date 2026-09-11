// A repository whose captured artifacts carry real checkpoint open and close
// trees in a project database, so `review data` publishes a floor with outline
// threads over a real diff and every verb downstream of the floor has something
// truthful to read.
//
// The capture path here is the accepted one: plan and checkpoint events are
// prepared through `prepareArtifactDraft` and appended with
// `appendProjectArtifactEvents`, and each close carries the diff fingerprint
// manifest built from the two real trees — the same manifest the CLI's close
// callback prepares. Nothing writes a review file.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach } from 'vitest';

import { buildDiffFingerprintManifest, diffSnapshotTrees, Repo } from '@orcaops/core';
import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import {
  type ArtifactDraftSemantics,
  type PlanInput,
  PlanInputSchema,
  prepareArtifactDraft,
  uuidv7,
} from '@orcaops/storage';
import {
  appendProjectArtifactEvents,
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { executeDatabaseReviewData } from '../src/database/floor-command.js';

const execute = promisify(execFile);
const FINGERPRINT_MAX_DIFF_BYTES = 2_000_000;
/**
 * The local-only snapshot namespace a real capture writes its boundary refs
 * into. `@orcaops/core` keeps `snapshotRefName` out of its public barrel, so the
 * name is built here; the shape must stay `refs/orcaops/snap/<artifact>/<n>/<phase>`
 * because that is what the repository's snapshot listing and pruning parse.
 */
const snapshotRef = (artifactId: string, n: number, phase: 'open' | 'close') =>
  `refs/orcaops/snap/${artifactId}/${n}/${phase}`;

const openFixtures = new Set<{ cleanup: () => Promise<void> }>();
afterEach(async () => {
  for (const fixture of [...openFixtures]) await fixture.cleanup();
});

/** One checkpoint: its close tree is a real commit of the changes it names. */
export interface CapturedCheckpointSpec {
  summary: string;
  /** Worktree paths written and committed as this checkpoint's close tree. */
  changes: Record<string, string>;
  /** Defaults to the changed paths. */
  filesChanged?: string[];
  /** Step indices this checkpoint declares. Defaults to the completed set. */
  declaredSteps?: number[];
  /** Step indices this checkpoint claims complete. Defaults to none. */
  completedSteps?: number[];
  decisions?: { decision: string; reason: string }[];
  uncertainty?: string[];
  verification?: { command: string; exit_code: number }[];
}

export interface CapturedArtifactSpec {
  label: string;
  task: string;
  steps?: { text: string; label: string }[];
  checkpoints: CapturedCheckpointSpec[];
  /** Outcome text for a captured summary; omitted leaves the thread open. */
  outcome?: string;
}

export interface CapturedCheckpointRecord {
  n: number;
  openTreeSha: string;
  closeTreeSha: string;
  headSha: string;
  manifestHash: string | null;
}

export interface CapturedArtifactRecord {
  artifactId: string;
  label: string;
  stepIds: string[];
  criterionIds: string[];
  checkpoints: CapturedCheckpointRecord[];
}

export interface CapturedReviewFixture {
  root: string;
  gitRoot: string;
  dataRoot: string;
  authority: ProjectDatabaseAuthority;
  projectId: string;
  branch: string;
  baseSha: string;
  headSha: string;
  artifacts: CapturedArtifactRecord[];
  git(args: string[]): Promise<string>;
  /** Commit further worktree changes outside any checkpoint window. */
  commit(changes: Record<string, string>, message: string): Promise<string>;
  publishFloor(
    overrides?: Partial<Parameters<typeof executeDatabaseReviewData>[0]>
  ): ReturnType<typeof executeDatabaseReviewData>;
  read<T>(callback: (database: ProjectDatabase) => T | Promise<T>): Promise<T>;
  /**
   * A review runtime descriptor rooted inside the fixture, for the verbs that
   * observe and pin an executable identity. Written under the ignored
   * `.orcaops/` tree so it never enters the reviewed diff.
   */
  runtimeDescriptor(): Promise<{ packageRoot: string; entrypointPath: string }>;
  cleanup(): Promise<void>;
}

/** The default corpus: two threads, four closed checkpoints, real diffs. */
export function defaultCapturedArtifacts(): CapturedArtifactSpec[] {
  return [
    {
      label: 'Rate limit the charge endpoint',
      task: 'Add a sliding-window rate limit to the charge endpoint',
      steps: [
        { text: 'Add the sliding-window limiter', label: 'Sliding-window limiter' },
        { text: 'Mount the limiter on the charge route', label: 'Mount the limiter' },
      ],
      checkpoints: [
        {
          summary: 'Added the sliding-window limiter over the shared clock.',
          changes: {
            'src/limiter.ts':
              'export function allow(now: number, window: number): boolean {\n' +
              '  return now % window !== 0;\n' +
              '}\n',
          },
          completedSteps: [0],
          decisions: [
            {
              decision: 'sliding window over a fixed-window counter',
              reason: 'a fixed window admits a double burst across the boundary',
            },
          ],
          uncertainty: ['the window is not shared across processes yet'],
          verification: [{ command: 'pnpm test limiter', exit_code: 0 }],
        },
        {
          summary: 'Mounted the limiter on the charge route.',
          changes: {
            'src/charge.ts':
              "import { allow } from './limiter.js';\n\n" +
              'export function charge(now: number): string {\n' +
              "  return allow(now, 60) ? 'charged' : 'limited';\n" +
              '}\n',
          },
          completedSteps: [1],
        },
      ],
      outcome: 'The charge endpoint refuses over the limit.',
    },
    {
      label: 'Record the charge outcome',
      task: 'Persist every charge outcome for the ledger',
      steps: [
        { text: 'Append the outcome row', label: 'Append the outcome row' },
        { text: 'Keep the rows ordered', label: 'Keep the rows ordered' },
      ],
      checkpoints: [
        {
          summary: 'Appended the charge outcome to the ledger.',
          changes: {
            'src/ledger.ts':
              'export const rows: string[] = [];\n\n' +
              'export function record(outcome: string): void {\n' +
              '  rows.push(outcome);\n' +
              '}\n',
          },
          completedSteps: [0],
        },
        {
          summary: 'Kept the ledger rows ordered by arrival.',
          changes: {
            'src/ledger.ts':
              'export const rows: string[] = [];\n\n' +
              'export function record(outcome: string): void {\n' +
              '  rows.push(outcome);\n' +
              '  rows.sort();\n' +
              '}\n',
          },
        },
      ],
    },
  ];
}

export interface CapturedReviewFixtureOptions {
  branch?: string;
  artifacts?: CapturedArtifactSpec[];
  /** Files committed before any capture; they form the review base tree. */
  baseFiles?: Record<string, string>;
  /**
   * Defaults to true: the fixture is removed after the test that built it. Pass
   * false for a suite that builds one fixture in `beforeAll` and owns its
   * cleanup, since the automatic removal is per-test.
   */
  autoCleanup?: boolean;
}

export async function capturedReviewFixture(
  options: CapturedReviewFixtureOptions = {}
): Promise<CapturedReviewFixture> {
  const branch = options.branch ?? 'main';
  const specs = options.artifacts ?? defaultCapturedArtifacts();
  const root = await mkdtemp(path.join(tmpdir(), 'captured-review-'));
  const gitRoot = path.join(root, 'repo');
  const dataRoot = path.join(root, 'history');
  await mkdir(gitRoot, { recursive: true });

  const git = async (args: string[]) => {
    const result = await execute(
      'git',
      [
        '-C',
        gitRoot,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 30_000 }
    );
    return result.stdout.trim();
  };
  const write = async (changes: Record<string, string>) => {
    for (const [file, content] of Object.entries(changes)) {
      const target = path.join(gitRoot, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  };
  const commit = async (changes: Record<string, string>, message: string) => {
    await write(changes);
    await git(['add', '-A']);
    await git(['commit', '--quiet', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };

  await git(['init', '--quiet', `--initial-branch=${branch}`]);
  await commit(
    options.baseFiles ?? { 'README.md': '# fixture\n', '.gitignore': '.orcaops/\n' },
    'Base'
  );
  const baseSha = await git(['rev-parse', 'HEAD']);

  const setup = await setupProjectDatabase({
    cwd: gitRoot,
    root: dataRoot,
    authoredPayloads: [],
    secretAllow: [],
  });
  if (setup.status !== 'complete')
    throw new Error('Captured review fixture setup did not complete');
  const authority = setup.initialization.authority;
  const writer = await openProjectDatabase({ authority, mode: 'writer' });
  const repo = new Repo(gitRoot);

  let closed = false;
  const fixtureHandle = {
    cleanup: async () => {
      if (closed) return;
      closed = true;
      writer.close();
      openFixtures.delete(fixtureHandle);
      await rm(root, { recursive: true, force: true });
    },
  };
  if (options.autoCleanup !== false) openFixtures.add(fixtureHandle);

  async function mutate<T>(
    artifactId: string,
    authoredPayload: unknown,
    callback: (semantics: ArtifactDraftSemantics) => Promise<T>
  ): Promise<T> {
    const retained = readProjectArtifact(writer, artifactId);
    if (!retained) throw new Error(`Captured review fixture artifact ${artifactId} is missing`);
    const draft = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: retained.thread.events,
        authoredPayload,
        secretAllow: [],
        idempotencyBlocks: [],
      },
      callback
    );
    if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
    if (draft.idempotencyChanges.length)
      throw new Error('Captured review fixture mutation produced unhandled attempt changes');
    if (draft.events.length)
      await appendProjectArtifactEvents(writer, {
        artifactId,
        operationId: uuidv7(),
        expectedRevision: retained.revision,
        eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
        sidecarPayloads: draft.events.flatMap((event) =>
          event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
        ),
        secretAllow: [],
      });
    return draft.evaluation.value;
  }

  const artifacts: CapturedArtifactRecord[] = [];
  let ts = Date.parse('2026-06-01T00:00:00.000Z');
  const stamp = () => new Date((ts += 60_000)).toISOString();

  for (const spec of specs) {
    const artifactId = uuidv7();
    const steps = spec.steps ?? [{ text: spec.task, label: spec.label }];
    const stepIds = steps.map(() => uuidv7());
    const criterionIds = steps.map(() => uuidv7());
    const startedAt = stamp();
    const plan: PlanInput = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: artifactId,
      branch,
      base_sha: baseSha,
      agent: 'claude-code',
      agent_session_id: null,
      task: spec.task,
      label: spec.label,
      plan_steps: steps.map((step, index) => ({
        step_id: stepIds[index],
        text: step.text,
        label: step.label,
        acceptance_criteria: [
          { criterion_id: criterionIds[index], text: `${step.label} is proved by a control` },
        ],
      })),
      touched_scope: ['payments'],
      non_goals: [],
      decisions: [],
      started_at: startedAt,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    });
    const planOperationId = uuidv7();
    const planDraft = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: [],
        authoredPayload: { plan, sourcePlan: null },
        secretAllow: [],
        idempotencyBlocks: [],
      },
      (semantics) => semantics.writePlan(plan, { idempotencyKey: planOperationId })
    );
    if (planDraft.evaluation.kind === 'threw') throw planDraft.evaluation.error;
    const planEvent = planDraft.events[0];
    if (!planEvent || planDraft.events.length !== 1)
      throw new Error('Captured review fixture plan did not prepare exactly one event');
    await appendProjectArtifactEvents(writer, {
      artifactId,
      operationId: planOperationId,
      expectedRevision: null,
      eventBytes: planEvent.eventBytes,
      sidecarPayloads: planEvent.sidecar
        ? [{ eventId: planEvent.record.event_id, bytes: planEvent.sidecar.bytes }]
        : [],
      secretAllow: [],
    });

    const checkpoints: CapturedCheckpointRecord[] = [];
    const claimedSteps = new Set<string>();
    for (const checkpoint of spec.checkpoints) {
      const openTreeSha = await git(['rev-parse', 'HEAD^{tree}']);
      const openHeadSha = await git(['rev-parse', 'HEAD']);
      // The open ref has to exist before the checkpoint number is known, so it
      // is written under a provisional name and renamed once the store assigns
      // n. Nothing reads it in between.
      const provisionalOpenRef = `refs/orcaops/snap/${artifactId}/pending/open`;
      await git(['update-ref', provisionalOpenRef, openHeadSha]);
      // A declared step already claimed by a closed checkpoint is an overlap
      // refusal, so a checkpoint that names nothing declares what is still free.
      const declaredIndices =
        checkpoint.declaredSteps ??
        (checkpoint.completedSteps?.length
          ? checkpoint.completedSteps
          : stepIds.flatMap((stepId, index) => (claimedSteps.has(stepId) ? [] : [index])));
      const declaredStepIds = declaredIndices.map((index) => stepIds[index]!);
      if (declaredStepIds.length === 0)
        throw new Error(
          `Captured review fixture checkpoint "${checkpoint.summary}" has no unclaimed step to declare`
        );
      const opened = await mutate(artifactId, { declared: declaredStepIds }, async (semantics) =>
        semantics.writeCheckpointOpened(
          {
            artifact_id: artifactId,
            declared_step_ids: declaredStepIds,
            agent_session_id: 'captured-review-fixture',
          },
          {
            idempotencyKey: uuidv7(),
            headSha: openHeadSha,
            openedAt: stamp(),
            snapshotCallbacks: {
              captureOpenSnapshot: async ({ n }) => ({
                boundary: {
                  snapshot_ref: snapshotRef(artifactId, n, 'open'),
                  tree_sha: openTreeSha,
                  snapshot_commit_sha: openHeadSha,
                  snapshot_error_reason: null,
                },
              }),
            },
          }
        )
      );
      if (!('checkpoint' in opened))
        throw new Error('Captured review fixture checkpoint did not open');
      const n = opened.checkpoint.n;
      await git(['update-ref', snapshotRef(artifactId, n, 'open'), openHeadSha]);
      await git(['update-ref', '-d', provisionalOpenRef]);

      const headSha = await commit(checkpoint.changes, checkpoint.summary);
      const closeTreeSha = await git(['rev-parse', 'HEAD^{tree}']);
      await git(['update-ref', snapshotRef(artifactId, n, 'close'), headSha]);
      const diff = await diffSnapshotTrees({
        repo,
        openTreeSha,
        closeTreeSha,
        maxDiffBytes: FINGERPRINT_MAX_DIFF_BYTES,
      });
      if (!diff.ok) throw new Error('Captured review fixture could not diff its checkpoint trees');
      const fingerprint = await buildDiffFingerprintManifest({
        artifactId,
        checkpointN: n,
        openTreeSha,
        closeTreeSha,
        diffBytes: diff.diff,
        truncated: diff.truncated,
        maxDiffBytes: FINGERPRINT_MAX_DIFF_BYTES,
      });
      await mutate(artifactId, { files: checkpoint.filesChanged }, async (semantics) =>
        semantics.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n,
            head_sha: headSha,
            summary: checkpoint.summary,
            files_changed: checkpoint.filesChanged ?? Object.keys(checkpoint.changes),
            completed_step_ids: (checkpoint.completedSteps ?? []).map((index) => stepIds[index]!),
            decisions: checkpoint.decisions ?? [],
            uncertainty: checkpoint.uncertainty ?? [],
            done_criteria: (checkpoint.completedSteps ?? []).map((index) => ({
              criterion_id: criterionIds[index]!,
              evidence: 'the control in this checkpoint',
            })),
            // The store refuses a completion claim that cites no verification.
            verification:
              checkpoint.verification ??
              (checkpoint.completedSteps?.length ? [{ command: 'pnpm test', exit_code: 0 }] : []),
          },
          {
            idempotencyKey: uuidv7(),
            closedAt: stamp(),
            snapshotCallbacks: {
              captureCloseFingerprint: async () => ({
                boundary: {
                  snapshot_ref: snapshotRef(artifactId, n, 'close'),
                  tree_sha: closeTreeSha,
                  snapshot_commit_sha: headSha,
                  snapshot_error_reason: null,
                },
                summary: fingerprint.summary,
                manifest: fingerprint.manifest,
              }),
            },
          }
        )
      );
      for (const index of checkpoint.completedSteps ?? []) claimedSteps.add(stepIds[index]!);
      checkpoints.push({
        n,
        openTreeSha,
        closeTreeSha,
        headSha,
        manifestHash: fingerprint.summary.manifest_hash,
      });
    }

    if (spec.outcome !== undefined)
      await mutate(artifactId, { outcome: spec.outcome }, async (semantics) =>
        semantics.writeSummary({
          schema_version: 1,
          artifact_id: artifactId,
          outcome: spec.outcome!,
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          head_sha: await git(['rev-parse', 'HEAD']),
          ts: stamp(),
        })
      );

    artifacts.push({ artifactId, label: spec.label, stepIds, criterionIds, checkpoints });
  }

  const headSha = await git(['rev-parse', 'HEAD']);
  return {
    root,
    gitRoot,
    dataRoot,
    authority,
    projectId: authority.projectId,
    branch,
    baseSha,
    headSha,
    artifacts,
    git,
    commit,
    publishFloor: (overrides = {}) =>
      executeDatabaseReviewData({
        branch,
        root: gitRoot,
        dataRoot,
        projectId: authority.projectId,
        operationId: uuidv7(),
        generatedAt: stamp(),
        secretAllow: [],
        ...overrides,
      }),
    runtimeDescriptor: async () => {
      const packageRoot = path.join(gitRoot, '.orcaops', 'runtime');
      const entrypointPath = path.join(packageRoot, 'dist', 'sidecar.js');
      await mkdir(path.dirname(entrypointPath), { recursive: true });
      await writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@orcaops/review-engine', version: '0.0.0' })
      );
      await writeFile(entrypointPath, 'export {};\n');
      return { packageRoot, entrypointPath };
    },
    read: async (callback) => {
      const database = await openProjectDatabase({ authority, mode: 'reader' });
      try {
        return await callback(database);
      } finally {
        database.close();
      }
    },
    cleanup: fixtureHandle.cleanup,
  };
}
