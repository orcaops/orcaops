import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { publishProjectCatalogEntry } from '@orcaops/core/history/registration';
import { type Floor, lineHash } from '@orcaops/review-core';
import {
  type ArtifactDraftResult,
  type CaptureAgentId,
  PlanInputSchema,
  prepareArtifactDraft,
  uuidv7,
} from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  appendProjectArtifactEvents,
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  projectDatabasePath,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { createDatabaseReviewComment } from '../../../review-engine/dist/database/comments.js';
import { prepareDatabaseReviewFloor } from '../../../review-engine/dist/database/floor-preparation.js';
import { publishDatabaseReviewFloor } from '../../../review-engine/dist/database/floors.js';
import { createDatabaseReview } from '../../../review-engine/dist/database/reviews.js';
import {
  appendProjectUsageEvents,
  readProjectUsage,
} from '../../../storage/dist/history/database/usage.js';
import { deriveUsageLedgerRecord } from '../../../storage/dist/usage/record.js';

const exec = promisify(execFile);
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/**
 * A registered checkout plus data root whose history lives only in the
 * project database. Every write goes through the accepted SQLite writers, so
 * the engine under test reads exactly what production captures leave behind.
 */
export interface HistoryDatabaseFixture {
  temporary: string;
  cwd: string;
  root: string;
  authority: ProjectDatabaseAuthority;
  headOid: string;
  writer(): Promise<ProjectDatabase>;
  add(options?: AddArtifactOptions): Promise<string>;
  checkpoint(artifactId: string, options?: CheckpointOptions): Promise<void>;
  summarize(artifactId: string, ts?: string): Promise<void>;
  usage(artifactId: string, options: UsageOptions): Promise<void>;
  review(branch: string, comments: readonly string[]): Promise<string>;
  /** A second, catalogued project in the same data root with no registered checkout. */
  addProject(): Promise<{ authority: ProjectDatabaseAuthority; writer: ProjectDatabase }>;
  cleanup(): Promise<void>;
}
export interface AddArtifactOptions {
  branch?: string;
  agent?: CaptureAgentId;
  task?: string;
  startedAt?: string;
  stepCount?: number;
  writer?: ProjectDatabase;
}
export interface CheckpointOptions {
  summary?: string;
  uncertainty?: string[];
  /** Leave the checkpoint open instead of closing it. */
  open?: boolean;
  ts?: string;
  writer?: ProjectDatabase;
}
export interface UsageOptions {
  agent?: string;
  sessionId: string;
  tokens: number;
  asOf?: string;
}

const HEAD_SHA = 'b'.repeat(40);
type DraftEvent = ArtifactDraftResult<unknown>['events'][number];

function encoded(events: readonly DraftEvent[]) {
  return {
    eventBytes: Buffer.concat(events.map((event) => event.eventBytes)),
    sidecarPayloads: events
      .filter((event) => event.sidecar !== null)
      .map((event) => ({ eventId: event.record.event_id, bytes: event.payloadBytes })),
  };
}

async function git(cwd: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  return (await exec('git', ['-C', cwd, ...args], { env })).stdout.trim();
}

export async function historyDatabaseFixture(
  options: { repositoryName?: string; dataRoot?: string } = {}
): Promise<HistoryDatabaseFixture> {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'history-watch-')));
  const cwd = path.join(temporary, options.repositoryName ?? 'checkout');
  await mkdir(cwd);
  await git(cwd, 'init', '-qb', 'main');
  await writeFile(path.join(cwd, 'value.ts'), 'const value = 1;\n');
  await git(cwd, 'add', 'value.ts');
  await git(
    cwd,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'Retained base'
  );
  const headOid = await git(cwd, 'rev-parse', 'HEAD');
  const root = await normalizeHistoryRoot({
    root: options.dataRoot ?? path.join(temporary, 'data'),
  });
  const setup = await setupProjectDatabase({
    cwd,
    root: root.resolvedRoot,
    authoredPayloads: [],
    secretAllow: [],
  });
  const authority = setup.initialization.authority;
  const writers = new Map<string, ProjectDatabase>();
  async function writerFor(target: ProjectDatabaseAuthority) {
    const key = target.projectId;
    let handle = writers.get(key);
    if (!handle) {
      handle = await openProjectDatabase({ authority: target, mode: 'writer' });
      writers.set(key, handle);
    }
    return handle;
  }
  const writer = () => writerFor(authority);

  async function add(options: AddArtifactOptions = {}) {
    const handle = options.writer ?? (await writer());
    const artifactId = uuidv7();
    const steps = Array.from({ length: options.stepCount ?? 1 }, (_, index) => ({
      step_id: uuidv7(),
      text: `Inspect retained work ${index + 1}`,
      label: `Inspect work ${index + 1}`,
      acceptance_criteria: [],
    }));
    const plan = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: artifactId,
      branch: options.branch ?? 'main',
      base_sha: headOid,
      agent: options.agent ?? 'codex',
      agent_session_id: null,
      task: options.task ?? 'Retain useful Watch history',
      label: 'Watch history',
      plan_steps: steps,
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: options.startedAt ?? '2026-09-05T00:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    });
    const draft = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: [],
        authoredPayload: plan,
        secretAllow: [],
        idempotencyBlocks: [],
      },
      (semantics) => semantics.writePlan(plan, { idempotencyKey: uuidv7() })
    );
    if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
    await appendProjectArtifactEvents(handle, {
      operationId: uuidv7(),
      artifactId,
      expectedRevision: null,
      ...encoded(draft.events),
      secretAllow: [],
    });
    return artifactId;
  }

  async function checkpoint(artifactId: string, options: CheckpointOptions = {}) {
    const handle = options.writer ?? (await writer());
    const current = readProjectArtifact(handle, artifactId);
    if (!current) throw new Error('Fixture artifact is missing');
    const ts = options.ts ?? '2026-09-05T00:00:30.000Z';
    const draft = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: current.thread.events,
        authoredPayload: { summary: options.summary ?? null },
        secretAllow: [],
        idempotencyBlocks: [],
      },
      async (semantics) => {
        const plan = await semantics.readPlan(artifactId);
        const opened = await semantics.writeCheckpointOpened(
          { artifact_id: artifactId, declared_step_ids: [plan!.plan_steps[0]!.step_id] },
          { idempotencyKey: uuidv7(), headSha: headOid, openedAt: ts, invokedByAgent: 'codex' }
        );
        if (opened.outcome !== 'created') throw new Error('Fixture checkpoint did not open');
        if (options.open) return;
        const closed = await semantics.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: opened.checkpoint.n,
            head_sha: HEAD_SHA,
            summary: options.summary ?? 'Changed retained work',
            files_changed: ['src/watch.ts'],
            completed_step_ids: [plan!.plan_steps[0]!.step_id],
            decisions: [],
            uncertainty: options.uncertainty ?? ['Independent reproduction remains'],
            done_criteria: [],
            verification: [{ command: 'pnpm test', exit_code: 0 }],
          },
          {
            idempotencyKey: uuidv7(),
            closedAt: ts,
            invokedByAgent: 'codex',
            skipWallClockOverlapScan: true,
          }
        );
        if (closed.outcome !== 'created') throw new Error('Fixture checkpoint did not close');
      }
    );
    if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
    await appendProjectArtifactEvents(handle, {
      operationId: uuidv7(),
      artifactId,
      expectedRevision: current.revision,
      ...encoded(draft.events),
      secretAllow: [],
    });
  }

  async function summarize(artifactId: string, ts = '2026-09-05T00:01:00.000Z') {
    const handle = await writer();
    const current = readProjectArtifact(handle, artifactId);
    if (!current) throw new Error('Fixture artifact is missing');
    const draft = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: current.thread.events,
        authoredPayload: { outcome: 'Retained' },
        secretAllow: [],
        idempotencyBlocks: [],
      },
      async (semantics) => {
        const result = await semantics.writeSummary(
          {
            schema_version: 1,
            artifact_id: artifactId,
            outcome: 'Retained Watch history.',
            tests_written: [],
            tests_run: [],
            open_items: [],
            deferred_decisions: [],
            head_sha: HEAD_SHA,
            ts,
          },
          { idempotencyKey: uuidv7() }
        );
        if (result.outcome !== 'created') throw new Error('Fixture summary did not record');
      }
    );
    if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
    await appendProjectArtifactEvents(handle, {
      operationId: uuidv7(),
      artifactId,
      expectedRevision: current.revision,
      ...encoded(draft.events),
      secretAllow: [],
    });
  }

  async function usage(artifactId: string, options: UsageOptions) {
    const handle = await writer();
    const cumulative = {
      input_tokens: options.tokens,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const asOf = options.asOf ?? '2026-09-05T00:00:45.000Z';
    const idempotencyKey = uuidv7();
    const { record } = deriveUsageLedgerRecord({
      type: 'agent_usage_snapshot_recorded',
      ts: asOf,
      idempotency_key: idempotencyKey,
      payload: {
        snapshot_id: uuidv7(),
        idempotency_key: idempotencyKey,
        agent: options.agent ?? 'codex',
        session_id: options.sessionId,
        artifact_id: artifactId,
        source_plan_ref_id: null,
        lifecycle_event: 'plan',
        checkpoint_n: null,
        cumulative_usage: cumulative,
        delta_usage: null,
        baseline_kind: 'first_observation',
        model_breakdown: [{ model: 'test', cumulative, delta: null }],
        record_count: 1,
        as_of: asOf,
      },
    });
    await appendProjectUsageEvents(handle, {
      operationId: uuidv7(),
      expectedRevision: readProjectUsage(handle)?.revision ?? null,
      eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
      sidecarPayloads: [],
      secretAllow: [],
    });
  }

  async function review(branch: string, comments: readonly string[]) {
    const reviewId = uuidv7();
    const membershipRevisionId = uuidv7();
    const operationId = uuidv7();
    await createDatabaseReview({
      authority,
      operationId,
      secretAllow: [],
      identityBytes: bytes({
        schema_version: 1,
        review_id: reviewId,
        project_id: authority.projectId,
        store_instance_id: authority.storeInstanceId,
        repository_instance_id: null,
        created_by_operation: operationId,
        initial_context: { worktree_id: null, branch, base_sha: null, head_sha: null },
        artifact_ids: [],
        legacy_source_ids: [],
      }),
      membershipBytes: bytes({ revisionId: membershipRevisionId, members: [], source: null }),
    });
    if (comments.length === 0) return reviewId;
    await writeFile(path.join(cwd, 'value.ts'), 'const value = 2;\n');
    await git(cwd, 'add', 'value.ts');
    const pinnedTreeSha = await git(cwd, 'write-tree');
    const prepared = await prepareDatabaseReviewFloor({
      authority,
      reviewId,
      expected: {
        membershipRevisionId,
        membershipVersion: 1,
        baseRevisionId: null,
        baseVersion: 0,
        floorVersion: 0,
      },
      basis: {
        gitRoot: cwd,
        baseSha: headOid,
        pinnedTreeSha,
        worktreeHead: headOid,
        defaultBranch: null,
        fingerprintMaxDiffBytes: 100000,
        reviewMaxDiffBytes: 100000,
        reviewIncludedUntracked: [],
      },
      generatedAt: '2026-09-05T00:00:40.000Z',
      secretAllow: [],
    });
    const floor = JSON.parse(prepared.floorBytes.toString('utf8')) as Floor;
    const publicationId = uuidv7();
    await publishDatabaseReviewFloor({
      authority,
      reviewId,
      operationId: uuidv7(),
      publicationId,
      secretAllow: [],
      basis: prepared.basis,
      expected: prepared.expected,
      floorBytes: prepared.floorBytes,
      diffBytes: prepared.diffBytes,
    });
    const thread = floor.outline.threads[0];
    const anchor = {
      kind: 'DIFF_LINE',
      file: 'value.ts',
      side: 'add',
      line: 1,
      lineHash: await lineHash('add', new TextEncoder().encode('const value = 2;')),
      hunkKey: floor.coverage.items[0]!.hunkKey,
      ...(thread ? { threadKey: thread.threadKey } : {}),
    };
    for (const body of comments)
      await createDatabaseReviewComment({
        authority,
        reviewId,
        operationId: uuidv7(),
        revisionId: uuidv7(),
        floorPublicationId: publicationId,
        expected: { floorVersion: 1, membershipRevisionId },
        secretAllow: [],
        commentBytes: bytes({
          type: 'add',
          comment_id: uuidv7(),
          ts: '2026-09-05T00:00:50.000Z',
          author: 'reviewer',
          body,
          anchor,
        }),
      });
    return reviewId;
  }

  async function addProject() {
    const target = {
      ...root,
      projectId: uuidv7(),
      storeInstanceId: uuidv7(),
      repositoryInstanceId: uuidv7(),
    };
    await mkdir(path.dirname(projectDatabasePath(target)), { recursive: true });
    const initializationOperationId = uuidv7();
    const handle = await initializeProjectDatabase({
      authority: target,
      initializationOperationId,
      initializedAt: '2026-09-05T00:00:00.000Z',
      authorize() {},
    });
    writers.set(target.projectId, handle);
    await publishProjectCatalogEntry({ expected: target, initializationOperationId });
    return { authority: target, writer: handle };
  }

  return {
    temporary,
    cwd,
    root: root.resolvedRoot,
    authority,
    headOid,
    writer,
    add,
    checkpoint,
    summarize,
    usage,
    review,
    addProject,
    async cleanup() {
      for (const handle of writers.values()) {
        try {
          handle.close();
        } catch {
          // A handle a test already broke must not block temporary removal.
        }
      }
      writers.clear();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
