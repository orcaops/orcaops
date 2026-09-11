import { isDeepStrictEqual } from 'node:util';

import {
  publishDatabaseImportedArtifactRetention,
  type RegisteredDatabaseContext,
  resumeDatabaseImportedArtifactRetention,
} from '@orcaops/core/history/database-capture';
import {
  type ArtifactThread,
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  prepareArtifactDraft,
  uuidv7,
} from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  appendProjectImportedArtifact,
  prepareProjectGitRetention,
  prepareProjectImportedArtifactSettlement,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  readProjectArtifact,
  readProjectExecution,
  readProjectPendingCapture,
} from '@orcaops/storage/history/database';

import type { SeedClusterSynthesis } from '../commands/seed/synthesize.js';
import {
  type PreparedSeedCheckpoint,
  redactSeedNarrative,
  type SeedSnapshotPublication,
} from '../commands/seed/write.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface DatabaseSeedWriteResult {
  artifactId: string;
  outcome: 'created' | 'resumed' | 'complete';
  checkpoints: number;
}

export interface DatabaseSeedWriteOptions {
  prepared?: ReadonlyMap<string, PreparedSeedCheckpoint>;
  exactExisting?: boolean;
  registered?: RegisteredDatabaseContext | null;
  operationOptions?: ProjectOperationOptions;
}

function checkpointKey(artifactId: string, n: number): string {
  return `${artifactId}:${n}`;
}

function seedPublication(
  prepared: PreparedSeedCheckpoint | undefined,
  phase: 'open' | 'close'
): SeedSnapshotPublication | null {
  if (!prepared) return null;
  const boundary = phase === 'open' ? prepared.openBoundary : prepared.closeBoundary;
  const candidates = prepared.publications.filter(
    (publication) => publication.checkpointPhase === phase
  );
  if (boundary.snapshot_ref === null && candidates.length === 0) return null;
  const publication = candidates[0];
  if (
    candidates.length !== 1 ||
    !publication ||
    boundary.snapshot_ref !== publication.fullRef ||
    boundary.snapshot_commit_sha !== publication.objectOid ||
    boundary.tree_sha !== publication.treeOid
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Prepared seed snapshot evidence must retain its exact Git publication'
    );
  return publication;
}

function retainedSeedContent(synthesis: SeedClusterSynthesis) {
  return {
    plan: synthesis.plan,
    checkpoints: synthesis.checkpoints.map((checkpoint) => ({
      schema_version: 4 as const,
      artifact_id: synthesis.artifactId,
      n: checkpoint.n,
      declared_step_ids: [checkpoint.stepId],
      agent: 'other' as const,
      policy_exceptions: [],
      opened_at: checkpoint.timestamp,
      open_head_sha: checkpoint.group.parentSha,
      closed_at: checkpoint.timestamp,
      closed_by_agent: 'other' as const,
      summary: checkpoint.summary,
      files_changed: checkpoint.group.files,
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [checkpoint.stepId],
      head_sha: checkpoint.group.headSha,
    })),
    summary: synthesis.summary,
  };
}

function retainedArtifactContent(retained: { thread: ArtifactThread }) {
  const plan = retained.thread.plan!;
  const { source_event_id: planEventId, ...authoredPlan } = plan;
  void planEventId;
  const summary = retained.thread.summary;
  const authoredSummary = summary
    ? ((value) => {
        const { source_event_id: summaryEventId, ...authored } = value;
        void summaryEventId;
        return authored;
      })(summary)
    : null;
  return {
    plan: authoredPlan,
    checkpoints: retained.thread.checkpoints
      .filter((checkpoint) => checkpoint.status === 'closed')
      .map((checkpoint) => ({
        schema_version: checkpoint.schema_version,
        artifact_id: checkpoint.artifact_id,
        n: checkpoint.n,
        declared_step_ids: checkpoint.declared_step_ids,
        agent: checkpoint.agent,
        policy_exceptions: checkpoint.policy_exceptions,
        opened_at: checkpoint.opened_at,
        open_head_sha: checkpoint.open_head_sha,
        closed_at: checkpoint.closed_at,
        closed_by_agent: checkpoint.closed_by_agent,
        summary: checkpoint.summary,
        files_changed: checkpoint.files_changed,
        decisions: checkpoint.decisions,
        uncertainty: checkpoint.uncertainty,
        done_criteria: checkpoint.done_criteria,
        completed_step_ids: checkpoint.completed_step_ids,
        head_sha: checkpoint.head_sha,
      })),
    summary: authoredSummary,
  };
}

function seedRetentionOperationIds(synthesis: SeedClusterSynthesis) {
  const operationId = artifactOperationId(
    synthesis.artifactId,
    synthesis.idempotencyKeys.summary,
    'seed_import_retention'
  );
  return {
    operationId,
    admissionOperationId: artifactOperationId(operationId, 'admission', 'seed_import_retention'),
    preparedTransitionId: artifactOperationId(operationId, 'prepared', 'seed_import_retention'),
  };
}

async function resumePendingSeedRetention(
  handle: ProjectDatabase,
  registered: RegisteredDatabaseContext | null | undefined,
  synthesis: SeedClusterSynthesis,
  operationId: string,
  outcome: 'created' | 'resumed',
  options: ProjectOperationOptions
): Promise<DatabaseSeedWriteResult | null> {
  const pending = readProjectPendingCapture(handle, operationId).value;
  if (!pending) return null;
  if (pending.mode !== 'import')
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The seed retention identity belongs to another capture mode; preserve its retained input'
    );
  if (pending.retention.current.kind !== 'prepared') {
    const complete = readProjectArtifact(handle, synthesis.artifactId);
    if (
      pending.retention.current.kind === 'selected' &&
      complete?.thread.summary &&
      isDeepStrictEqual(retainedArtifactContent(complete), retainedSeedContent(synthesis))
    )
      return {
        artifactId: synthesis.artifactId,
        outcome: 'complete',
        checkpoints: complete.thread.checkpoints.filter(
          (checkpoint) => checkpoint.status === 'closed'
        ).length,
      };
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The original seed retention is no longer pending; preserve its history for explicit repair'
    );
  }
  const retained = await prepareProjectImportedArtifactSettlement(handle, pending.capture);
  if (!isDeepStrictEqual(retainedArtifactContent(retained), retainedSeedContent(synthesis)))
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Pending imported artifact ${synthesis.artifactId} differs from the current Git source. Preserve its retained input and inspect the seed selection.`
    );
  if (!registered)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Seed snapshot publication requires the original registered repository context'
    );
  await resumeDatabaseImportedArtifactRetention(handle, registered, operationId, options);
  const complete = readProjectArtifact(handle, synthesis.artifactId);
  if (!complete?.thread.summary)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Seed retention settled without a complete imported artifact; preserve history for repair'
    );
  return {
    artifactId: synthesis.artifactId,
    outcome,
    checkpoints: complete.thread.checkpoints.filter((checkpoint) => checkpoint.status === 'closed')
      .length,
  };
}

function retainedSeedSource(
  content: ReturnType<typeof retainedSeedContent> | ReturnType<typeof retainedArtifactContent>
) {
  return {
    baseSha: content.plan.base_sha,
    origin: content.plan.origin
      ? {
          kind: content.plan.origin.kind,
          sourceRange: content.plan.origin.source_range,
          authors: content.plan.origin.authors,
          clusterKey: content.plan.origin.cluster_key,
          memberShas: content.plan.origin.member_shas,
          memberShasHash: content.plan.origin.member_shas_hash,
        }
      : null,
    checkpointHeads: content.checkpoints.map((checkpoint) => checkpoint.head_sha),
    summaryHead: content.summary?.head_sha,
  };
}

const replayFailure = (artifactId: string, position: string): OrcaopsError =>
  new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `Unable to replay imported ${position} for artifact ${artifactId}. The durable history is ` +
      'intact; re-run `orcaops seed --yes`. If it persists, run `orcaops doctor`. Do not delete ' +
      'the project database or its immutable seed-state rows.'
  );

/**
 * A cluster is one artifact: `1 plan + 2·N checkpoint events + 1 summary`, all git-import
 * origin. Without retained snapshots it publishes through `appendProjectImportedArtifact`;
 * with snapshots it admits the same imported settlement before immutable Git publication.
 * Both paths settle the event append and unbound execution together. Imported history has
 * no live execution binding, but it still needs its execution rows so later amendment and
 * enrichment classify it correctly. The whole thread is produced in one
 * `prepareArtifactDraft` callback so the events settle atomically under one operation.
 *
 * Resume is by the durable rows, not a journal: an existing thread with no summary
 * reuses its plan event and appends the remaining checkpoints and the summary. The
 * git-import idempotency keys are deterministic from git identity, salted with
 * `#retry<n>` for positions a prior run abandoned, so a re-run neither duplicates nor
 * loses a cluster. Narrative is secret-redacted at write (seed scrubs rather than
 * refuses, because the text is machine-synthesized from commits nobody can reword).
 *
 * Snapshot boundaries and fingerprint manifests are supplied by the command after its Git
 * preparation pass. When that pass cannot retain a boundary, the same explicit skipped
 * evidence used by authored captures is recorded instead.
 */
export async function writeDatabaseSeedCluster(
  handle: ProjectDatabase,
  synthesis: SeedClusterSynthesis,
  options: DatabaseSeedWriteOptions = {}
): Promise<DatabaseSeedWriteResult> {
  const redacted = redactSeedNarrative(synthesis);
  const artifactId = redacted.artifactId;
  const before = readProjectArtifact(handle, artifactId);
  const existingPlan = before?.thread.plan ?? null;
  // Any existing plan that is not itself a git-import is a live capture that
  // happens to share this deterministic id — an authored capture carries no
  // origin at all. This ownership check runs BEFORE the already-complete
  // short-circuit below, so a complete authored artifact at the seed id is
  // refused rather than falsely reported complete.
  if (existingPlan && existingPlan.origin?.kind !== 'git-import')
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Deterministic seed artifact id ${artifactId} belongs to a live capture.`
    );
  if (before?.thread.summary) {
    const retained = retainedArtifactContent(before);
    const intended = retainedSeedContent(redacted);
    const matches = options.exactExisting
      ? isDeepStrictEqual(retained, intended)
      : isDeepStrictEqual(retainedSeedSource(retained), retainedSeedSource(intended));
    if (!matches)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Imported artifact ${artifactId} differs from the current Git source. Preserve the retained history and inspect the seed selection.`
      );
  }
  const closedCount = (): number =>
    before ? before.thread.checkpoints.filter((cp) => cp.status === 'closed').length : 0;
  if (before?.thread.summary)
    return { artifactId, outcome: 'complete', checkpoints: closedCount() };

  const retentionIds = seedRetentionOperationIds(redacted);
  const resumed = await resumePendingSeedRetention(
    handle,
    options.registered,
    redacted,
    retentionIds.operationId,
    existingPlan ? 'resumed' : 'created',
    options.operationOptions ?? {}
  );
  if (resumed) return resumed;

  // An abandoned checkpoint releases its step with no close, so replaying its
  // deterministic open key lands back on the un-closable abandoned checkpoint.
  // Salt each position's keys with how many attempts at it were abandoned so a
  // retried position mints a fresh checkpoint while an untouched one replays.
  const abandonedAttempts = new Map<string, number>();
  for (const checkpoint of before?.thread.checkpoints ?? []) {
    if (checkpoint.status !== 'abandoned') continue;
    for (const stepId of checkpoint.declared_step_ids)
      abandonedAttempts.set(stepId, (abandonedAttempts.get(stepId) ?? 0) + 1);
  }

  const publicationTargets: Array<SeedSnapshotPublication & { targetId: string }> = [];
  const draft = await prepareArtifactDraft(
    {
      artifactId,
      priorEvents: before?.thread.events ?? [],
      authoredPayload: { seedCluster: artifactId },
      secretAllow: [],
      idempotencyBlocks: [],
    },
    async (semantics) => {
      let planEventId: string;
      if (existingPlan) planEventId = existingPlan.source_event_id;
      else {
        const written = await semantics.writePlan(redacted.plan, {
          idempotencyKey: redacted.idempotencyKeys.plan,
        });
        planEventId = written.event_id;
      }
      for (const checkpoint of redacted.checkpoints) {
        const prepared = options.prepared?.get(checkpointKey(artifactId, checkpoint.n));
        const openBoundary = prepared?.openBoundary ?? buildDefaultSkippedSnapshotBoundary();
        const closeBoundary = prepared?.closeBoundary ?? buildDefaultSkippedSnapshotBoundary();
        const fingerprintSummary =
          prepared?.fingerprintSummary ?? buildDefaultSkippedFingerprintSummary();
        const attempts = abandonedAttempts.get(checkpoint.stepId) ?? 0;
        const retry = attempts > 0 ? `#retry${attempts}` : '';
        const opened = await semantics.writeCheckpointOpened(
          {
            artifact_id: artifactId,
            declared_step_ids: [checkpoint.stepId],
            policy_exceptions: [],
            plan_revision_id: planEventId,
          },
          {
            headSha: checkpoint.group.parentSha,
            openedAt: checkpoint.timestamp,
            idempotencyKey: `${checkpoint.idempotencyKeys.open}${retry}`,
            invokedByAgent: 'other',
            snapshotCallbacks: { captureOpenSnapshot: async () => ({ boundary: openBoundary }) },
          }
        );
        if (opened.outcome === 'conflict' || opened.outcome === 'blocked')
          throw replayFailure(artifactId, `checkpoint ${checkpoint.n} open`);
        const openPublication = seedPublication(prepared, 'open');
        if (openPublication)
          publicationTargets.push({
            ...openPublication,
            targetId: opened.checkpoint.source_event_id,
          });
        const closed = await semantics.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: opened.checkpoint.n,
            summary: checkpoint.summary,
            files_changed: checkpoint.group.files,
            decisions: [],
            uncertainty: [],
            done_criteria: [],
            completed_step_ids: [checkpoint.stepId],
            head_sha: checkpoint.group.headSha,
          },
          {
            closedAt: checkpoint.timestamp,
            idempotencyKey: `${checkpoint.idempotencyKeys.close}${retry}`,
            invokedByAgent: 'other',
            skipWallClockOverlapScan: true,
            snapshotCallbacks: {
              captureCloseFingerprint: async () => ({
                boundary: closeBoundary,
                summary: fingerprintSummary,
                manifest: prepared?.fingerprintManifest ?? null,
              }),
            },
          }
        );
        if (closed.outcome === 'conflict')
          throw replayFailure(artifactId, `checkpoint ${checkpoint.n} close`);
        const closePublication = seedPublication(prepared, 'close');
        if (closePublication)
          publicationTargets.push({
            ...closePublication,
            targetId: closed.checkpoint.source_event_id,
          });
      }
      const summarized = await semantics.writeSummary(redacted.summary, {
        idempotencyKey: redacted.idempotencyKeys.summary,
      });
      if (summarized.outcome === 'conflict') throw replayFailure(artifactId, 'summary');
    }
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  // No events means every position replayed — the thread is already whole.
  if (!draft.events.length) return { artifactId, outcome: 'complete', checkpoints: closedCount() };
  const incomingIds = new Set(draft.events.map((event) => event.record.event_id));
  const publications = publicationTargets.filter((publication) =>
    incomingIds.has(publication.targetId)
  );
  try {
    const sidecarPayloads = draft.events.flatMap((event) =>
      event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
    );
    if (publications.length > 0) {
      if (!options.registered?.binding)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Seed snapshot publication requires the original registered repository context'
        );
      const objectFormats = new Set(publications.map((publication) => publication.objectFormat));
      if (objectFormats.size !== 1)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Seed snapshot publications must use one repository object format'
        );
      const previousExecution = before ? readProjectExecution(handle, artifactId) : null;
      if (before && !previousExecution)
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The partial imported artifact has no retained execution state; preserve it for repair'
        );
      const execution = previousExecution
        ? {
            kind: 'historical_maintenance' as const,
            context: options.registered.binding,
            expectedVersion: previousExecution.version,
            expectedGeneration: previousExecution.state.binding_generation,
            explicitTarget: true,
          }
        : {
            kind: 'create' as const,
            context: options.registered.binding,
            ts: redacted.plan.started_at,
          };
      const capture = {
        operationId: retentionIds.operationId,
        artifactId,
        expectedRevision: before?.revision ?? null,
        eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
        sidecarPayloads,
        secretAllow: [],
        execution,
      };
      const retention = prepareProjectGitRetention({
        ...retentionIds,
        repositoryInstanceId: handle.authority.repositoryInstanceId,
        objectFormat: [...objectFormats][0]!,
        createdAt: redacted.plan.origin!.imported_at,
        target: {
          kind: 'capture',
          artifactId,
          expectedRevision: before?.revision ?? null,
          expectedExecutionVersion: previousExecution?.version ?? null,
          expectedBindingGeneration: previousExecution?.state.binding_generation ?? null,
          expectedBaselinePublicationId: null,
        },
        publications: publications.map((publication) => ({
          publicationId: publication.publicationId,
          role: 'checkpoint' as const,
          targetId: publication.targetId,
          checkpointNumber: publication.checkpointNumber,
          checkpointPhase: publication.checkpointPhase,
          objectOid: publication.objectOid,
          treeOid: publication.treeOid,
        })),
        secretAllow: [],
      });
      await publishDatabaseImportedArtifactRetention(
        handle,
        options.registered,
        { capture, retention },
        options.operationOptions
      );
    } else {
      await appendProjectImportedArtifact(
        handle,
        {
          artifactId,
          operationId: uuidv7(),
          expectedRevision: before?.revision ?? null,
          eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
          sidecarPayloads,
          secretAllow: [],
        },
        options.operationOptions
      );
    }
  } catch (cause) {
    if (
      publications.length > 0 &&
      cause instanceof ProjectDatabaseError &&
      ['IDEMPOTENCY_CONFLICT', 'STALE_CONTEXT'].includes(cause.code)
    ) {
      const resumed = await resumePendingSeedRetention(
        handle,
        options.registered,
        redacted,
        retentionIds.operationId,
        existingPlan ? 'resumed' : 'created',
        options.operationOptions ?? {}
      );
      if (resumed) return resumed;
    }
    // A stale create can converge only after the winner's complete authored content is visible.
    if (
      before === null &&
      cause instanceof ProjectDatabaseError &&
      cause.code === 'STALE_CONTEXT'
    ) {
      let published: ReturnType<typeof readProjectArtifact>;
      try {
        published = readProjectArtifact(handle, artifactId);
      } catch {
        throw cause;
      }
      if (published?.thread.summary && published.thread.plan?.origin?.kind === 'git-import') {
        const retained = retainedArtifactContent(published);
        const intended = retainedSeedContent(redacted);
        if (isDeepStrictEqual(retained, intended)) {
          return {
            artifactId,
            outcome: 'complete',
            checkpoints: published.thread.checkpoints.filter(
              (checkpoint) => checkpoint.status === 'closed'
            ).length,
          };
        }
      }
    }
    throw cause;
  }
  return {
    artifactId,
    outcome: existingPlan ? 'resumed' : 'created',
    checkpoints: redacted.checkpoints.length,
  };
}

export async function abandonDatabaseSeedCheckpoint(
  handle: ProjectDatabase,
  input: { artifactId: string; checkpointN: number },
  options: ProjectOperationOptions = {}
): Promise<void> {
  const before = readProjectArtifact(handle, input.artifactId);
  if (!before?.thread.plan || before.thread.plan.origin?.kind !== 'git-import')
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Interrupted seed artifact ${input.artifactId} is missing or no longer seed-owned.`
    );
  const checkpoint = before.thread.checkpoints.find(
    (entry) => entry.n === input.checkpointN && entry.status === 'open'
  );
  if (!checkpoint) return;
  const draft = await prepareArtifactDraft(
    {
      artifactId: input.artifactId,
      priorEvents: before.thread.events,
      authoredPayload: { checkpoint: input.checkpointN, action: 'seed-recovery-abandon' },
      secretAllow: [],
      idempotencyBlocks: [],
    },
    (semantics) =>
      semantics.writeCheckpointAbandoned(
        {
          artifact_id: input.artifactId,
          n: input.checkpointN,
          reason: 'Interrupted seed run; this cluster is outside the current selection.',
        },
        {
          idempotencyKey: `orcaops-seed:recover-abandon:${input.artifactId}:${input.checkpointN}`,
          invokedByAgent: 'other',
        }
      )
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  if (!draft.events.length) return;
  await appendProjectImportedArtifact(
    handle,
    {
      artifactId: input.artifactId,
      operationId: uuidv7(),
      expectedRevision: before.revision,
      eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
      sidecarPayloads: draft.events.flatMap((event) =>
        event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
      ),
      secretAllow: [],
    },
    options
  );
}
