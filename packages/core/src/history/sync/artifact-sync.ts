import { realpath } from 'node:fs/promises';

import { sha256Hex, uuidv7 } from '@orcaops/storage';
import {
  hasProjectSessionBranchState,
  listProjectArtifacts,
  ProjectDatabaseError,
  readProjectArtifact,
  readProjectCloudSyncState,
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
} from '@orcaops/storage/history/database';
import type { ProjectDatabase, ProjectWait } from '@orcaops/storage/history/database';
import {
  type ProjectArtifactPushInput,
  readProjectArtifactPushCurrent,
} from '@orcaops/storage/history/database/artifact-push';
import { readProjectSessionBranch } from '@orcaops/storage/history/database/session-branch';

import {
  type ArtifactPushClient,
  composeProjectArtifactPush,
  dispatchProjectArtifactPush,
} from './dispatch.js';
import {
  readDatabaseCheckpointDiffFingerprints,
  resolveDatabaseDoneCriterionText,
} from '../../cloud/database-checkpoint-sources.js';
import { readDatabaseArtifactUsageSnapshot } from '../../cloud/database-usage.js';
import { ImportedArtifactLocalOnlyError, SourcePlanIntegrityError } from '../../cloud/errors.js';
import { type ArtifactSnapshot, computeArtifactHash } from '../../cloud/hash.js';
import { callsForSnapshot } from '../../cloud/push-calls.js';
import {
  buildBranchAPin,
  buildBranchBPin,
  type PreflightClient,
  preflightSourcePlan,
  resolveBranchBPinTitle,
} from '../../cloud/source-plan-pin.js';

/**
 * A grouped push cannot yet be assembled for this artifact, and no partial or file-authority
 * push is taken instead. Carries a `code` the push command maps to its typed cloud-unavailable
 * disclosure.
 */
export class DatabaseArtifactPushUnavailableError extends Error {
  readonly code = 'CLOUD_PUSH_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseArtifactPushUnavailableError';
  }
}

export interface BuildDatabaseArtifactPushInputOptions {
  readonly target: ProjectArtifactPushInput['target'];
  /** The artifact's repository URL, threaded from the registered git context. */
  readonly repoUrl: string;
  readonly signal?: AbortSignal;
  readonly sourcePlanClient?: PreflightClient;
  readonly repoRoot?: string;
  readonly session?: { readonly repoUrl: string; readonly workingDir: string };
  /** Clock for `preparedAt`. */
  readonly now?: () => string;
}

export async function buildDatabaseArtifactPushInput(
  handle: ProjectDatabase,
  artifactId: string,
  options: BuildDatabaseArtifactPushInputOptions
): Promise<ProjectArtifactPushInput> {
  if (options.signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Push preparation cancelled before reading its inputs'
    );
  return prepareDatabaseArtifactPushInput(
    handle,
    artifactId,
    options,
    await readDatabasePushSources(handle, artifactId)
  );
}

function readDatabasePushArtifact(handle: ProjectDatabase, artifactId: string) {
  const retained = readProjectArtifact(handle, artifactId);
  const plan = retained?.thread.plan ?? null;
  if (retained === null || plan === null)
    throw new DatabaseArtifactPushUnavailableError(
      `Artifact ${artifactId} has no retained plan to push. Nothing was sent.`
    );
  const thread = retained.thread;
  if (plan.origin?.kind === 'git-import') throw new ImportedArtifactLocalOnlyError(artifactId);
  const sourcePlan = thread.artifactJson?.source_plan ?? null;
  if (sourcePlan && sha256Hex(sourcePlan.content) !== sourcePlan.hash)
    throw new SourcePlanIntegrityError(artifactId, sourcePlan.hash, sha256Hex(sourcePlan.content));
  return { retained, plan, thread, sourcePlan };
}

async function readDatabasePushSources(
  handle: ProjectDatabase,
  artifactId: string,
  artifact = readDatabasePushArtifact(handle, artifactId)
) {
  const { retained, plan, thread, sourcePlan } = artifact;
  const usage = readDatabaseArtifactUsageSnapshot(handle, artifactId);
  const manifests = await readDatabaseCheckpointDiffFingerprints(thread);
  const fingerprintByN: ArtifactSnapshot['fingerprintByN'] = new Map();
  for (const cp of thread.checkpoints) {
    if (cp.status !== 'closed' || cp.diff_fingerprint_summary.manifest_hash === null) continue;
    const manifest = manifests.get(cp.n);
    if (!manifest)
      throw new DatabaseArtifactPushUnavailableError(
        `Checkpoint ${cp.n} declares a diff-fingerprint manifest that could not be validated against retained history; explicit repair is required. Nothing was sent.`
      );
    fingerprintByN.set(cp.n, manifest);
  }
  const snapshot: ArtifactSnapshot = {
    plan,
    checkpoints: thread.checkpoints,
    summary: thread.summary,
    evaluators: thread.events.some((event) =>
      ['evaluator_run_recorded', 'evaluator_disposition_recorded', 'checkpoint_opened'].includes(
        event.record.type
      )
    )
      ? thread.evaluatorLog
      : null,
    source_plan: sourcePlan,
    fingerprintByN,
    usage: usage.source,
  };
  return { retained, plan, thread, sourcePlan, usage, snapshot };
}

async function prepareDatabaseArtifactPushInput(
  handle: ProjectDatabase,
  artifactId: string,
  options: BuildDatabaseArtifactPushInputOptions,
  sources: Awaited<ReturnType<typeof readDatabasePushSources>>
): Promise<ProjectArtifactPushInput> {
  const { target, repoUrl, now = () => new Date().toISOString() } = options;
  const { retained, plan, thread, sourcePlan, usage, snapshot } = sources;
  const sessionKey = options.session ? { target, ...options.session } : null;
  if (sessionKey === null && hasProjectSessionBranchState(handle))
    throw new DatabaseArtifactPushUnavailableError(
      'Provide the current repository and worktree session identity before pushing retained session state.'
    );
  const session = sessionKey ? readProjectSessionBranch(handle, sessionKey) : null;
  const historical =
    session !== null &&
    session.state.current_branch !== plan.branch &&
    !session.state.branch_history.includes(plan.branch);
  const pushCurrent = readProjectArtifactPushCurrent(handle, artifactId, target).value;
  const cloudState = readProjectCloudSyncState(handle, artifactId, target);
  const preparedAt = now();
  let pin = null;
  if (sourcePlan !== null) {
    const client = options.sourcePlanClient;
    if (!client)
      throw new DatabaseArtifactPushUnavailableError(
        'Provide the authenticated Source Plan client to validate this pin before sending the artifact.'
      );
    await preflightSourcePlan(client, {
      sourcePlan,
      baseUrl: target.server_url,
      currentOrgId: target.org_id,
      currentThreadExternalId: cloudState?.publicState?.externalId ?? null,
    });
    const title =
      sourcePlan.source_ref.kind === 'local'
        ? await resolveBranchBPinTitle(client, { artifactId, planLabel: plan.label })
        : plan.label;
    const args = {
      artifactId,
      sourcePlan,
      planLabel: title,
      baseUrl: target.server_url,
      currentOrgId: target.org_id,
      repoRoot: options.repoRoot,
      authoredAt: preparedAt,
      sourcePlanLookup: async (filePath: string) => {
        const realPath = await realpath(filePath).catch(() => null);
        if (realPath === null) return null;
        const namespace = readProjectSourcePlanNamespace(handle, {
          serverUrl: target.server_url,
          orgId: target.org_id,
          accountId: target.account_id,
        });
        if (!namespace) return null;
        const found = readProjectSourcePlanLocator(handle, {
          namespaceId: namespace.namespaceId,
          kind: 'path',
          realPath,
        });
        return found && found.record.approvedVersion !== null
          ? { external_id: found.record.externalId, version_number: found.record.approvedVersion }
          : null;
      },
    };
    pin =
      sourcePlan.source_ref.kind === 'cloud' ? buildBranchAPin(args) : await buildBranchBPin(args);
  }
  const calls = await callsForSnapshot(
    snapshot,
    {
      repoUrl,
      externalId: artifactId,
      branch: historical ? plan.branch : (session?.state.current_branch ?? plan.branch),
      branchHistory: !historical && session ? session.state.branch_history : [],
      description: plan.task,
      label: plan.label,
      agent: plan.agent,
      startedAt: plan.started_at,
    },
    pin,
    (cp) => resolveDatabaseDoneCriterionText(thread, cp)
  );
  if (options.signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'Push preparation cancelled before admission');
  return {
    pushId: uuidv7(),
    operationId: uuidv7(),
    terminalOperationId: uuidv7(),
    artifactId,
    target: structuredClone(target),
    artifactRevision: retained.revision,
    usageRevision: usage.revision,
    artifactPayloadHash: computeArtifactHash(snapshot),
    expectedPushSelection: pushCurrent?.currentSelection ?? null,
    expectedCloudSelection: cloudState?.selection ?? null,
    session:
      session && !historical
        ? {
            key: session.key,
            expectedSelection: session.selection,
            acknowledgementId: uuidv7(),
            resultRevisionId: uuidv7(),
          }
        : null,
    cloudAcknowledgementId: uuidv7(),
    preparedAt,
    result: {
      checkpoints: thread.checkpoints.filter((cp) => cp.status === 'closed').length,
      summary: snapshot.summary !== null,
      evaluators: snapshot.evaluators?.runs.length ?? 0,
      sourcePlanPinned: sourcePlan ? (sourcePlan.source_ref.kind === 'cloud' ? 'A' : 'B') : null,
    },
    calls: calls.map((call) => ({
      requestId: uuidv7(),
      method: call.method,
      targetExternalId: call.target_external_id,
      payloadBytes: Buffer.from(call.payload_json),
    })),
  };
}

export interface PushDatabaseArtifactOptions extends BuildDatabaseArtifactPushInputOptions {
  /** Tests provide a fake transport. */
  readonly client: ArtifactPushClient;
  /** Push even when the artifact tree matches the last successful push. */
  readonly force?: boolean;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
  readonly onWait?: (wait: ProjectWait) => void;
}
export type PushDatabaseArtifactOutcome =
  | { readonly status: 'skipped'; readonly artifactId: string; readonly hash: string }
  | {
      readonly status: 'pushed';
      readonly artifactId: string;
      readonly pushId: string;
      readonly hash: string;
      readonly cloudApplied: boolean;
      readonly sessionApplied: boolean | null;
      readonly replayed: boolean;
    };

/**
 * Assemble one artifact's grouped push and settle it over the injected client. Skips cleanly
 * when the artifact tree is byte-identical to the last successful push (unless `force`), so a
 * re-push of unchanged work sends nothing. The settlement's honest outcome is returned
 * verbatim — a push whose artifact or usage source advanced between admission and settlement
 * reports `cloudApplied:false` under its original identities with no retarget.
 */
export async function pushDatabaseArtifact(
  handle: ProjectDatabase,
  artifactId: string,
  options: PushDatabaseArtifactOptions
): Promise<PushDatabaseArtifactOutcome> {
  const { target, client, force = false, now, signal, onWait } = options;
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Push cancelled before recovering or preparing its input'
    );
  const artifact = readDatabasePushArtifact(handle, artifactId);
  const original = readProjectArtifactPushCurrent(handle, artifactId, target).value;
  if (original !== null && original.terminal === null) {
    const settled = await dispatchProjectArtifactPush(handle, client, original.input.pushId, {
      now,
      signal,
      onWait,
    });
    return {
      status: 'pushed',
      artifactId,
      pushId: original.input.pushId,
      hash: original.input.artifactPayloadHash,
      cloudApplied: settled.value.cloudApplied,
      sessionApplied: settled.value.sessionApplied,
      replayed: settled.replayed,
    };
  }
  const sources = await readDatabasePushSources(handle, artifactId, artifact);
  const hash = computeArtifactHash(sources.snapshot);
  const cloud = readProjectCloudSyncState(handle, artifactId, target);
  if (
    !force &&
    cloud?.publicState != null &&
    !cloud.pending &&
    cloud.sources.artifactGeneration === sources.retained.revision.generation &&
    cloud.sources.usageGeneration === (sources.usage.revision?.generation ?? null) &&
    cloud.publicState.hash === hash &&
    cloud.publicState.orgId === target.org_id
  )
    return { status: 'skipped', artifactId, hash };
  const input = await prepareDatabaseArtifactPushInput(handle, artifactId, options, sources);
  const settled = await composeProjectArtifactPush(handle, client, input, {
    secretAllow: [],
    now,
    signal,
    onWait,
  });
  return {
    status: 'pushed',
    artifactId,
    pushId: input.pushId,
    hash: input.artifactPayloadHash,
    cloudApplied: settled.value.cloudApplied,
    sessionApplied: settled.value.sessionApplied,
    replayed: settled.replayed,
  };
}

export interface ResyncDatabaseArtifactsOptions extends BuildDatabaseArtifactPushInputOptions {
  /** Tests provide a fake transport. */
  readonly client: ArtifactPushClient;
  readonly selection?: readonly PendingDatabaseArtifactPushSelection[];
  readonly force?: boolean;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
  readonly onWait?: (wait: ProjectWait) => void;
}
export type ResyncArtifactResult =
  | { readonly artifactId: string; readonly outcome: PushDatabaseArtifactOutcome }
  | {
      readonly artifactId: string;
      readonly error: { readonly code: string; readonly message: string };
    };
export interface ResyncDatabaseArtifactsResult {
  readonly pending: number;
  readonly results: readonly ResyncArtifactResult[];
}

export interface PendingDatabaseArtifactPushSelection {
  readonly artifactId: string;
  readonly requiresSourcePlanOwnerRef: boolean;
}

export function requiresDatabasePushOwnerRef(
  handle: ProjectDatabase,
  artifactId: string,
  target: BuildDatabaseArtifactPushInputOptions['target']
) {
  const original = readProjectArtifactPushCurrent(handle, artifactId, target).value;
  if (original !== null && original.terminal === null) {
    if (original.input.result.sourcePlanPinned !== 'A') return false;
    for (const call of original.calls) {
      const latest = call.outcomes.at(-1) ?? null;
      if (latest?.kind === 'acknowledged') continue;
      if (latest?.kind === 'ack_unknown' || call.attempt !== null) return false;
      if (call.request.scope.method === 'sourcePlan.attachPin') return true;
    }
    return false;
  }
  return (
    readProjectArtifact(handle, artifactId)?.thread.artifactJson?.source_plan?.source_ref.kind ===
    'cloud'
  );
}

export function selectPendingDatabaseArtifactPushes(
  handle: ProjectDatabase,
  target: BuildDatabaseArtifactPushInputOptions['target']
): PendingDatabaseArtifactPushSelection[] {
  return listPendingDatabaseArtifactPushIds(handle, target).map((artifactId) => ({
    artifactId,
    requiresSourcePlanOwnerRef: requiresDatabasePushOwnerRef(handle, artifactId, target),
  }));
}

export function listPendingDatabaseArtifactPushIds(
  handle: ProjectDatabase,
  target: BuildDatabaseArtifactPushInputOptions['target']
): string[] {
  const pending: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = listProjectArtifacts(handle, { limit: 1000, offset });
    for (const artifact of page.artifacts) {
      if (artifact.originKind === 'git-import') continue;
      const state = readProjectCloudSyncState(handle, artifact.artifactId, target);
      const original = readProjectArtifactPushCurrent(handle, artifact.artifactId, target).value;
      if (state === null || state.pending || (original !== null && original.terminal === null))
        pending.push(artifact.artifactId);
    }
    if (page.artifacts.length < 1000) return pending;
  }
}

/**
 * Retry every artifact whose retained cloud sync is still pending, flushing each through the
 * same builder + dispatch as `push`.
 *
 * There is no dedicated cross-artifact pending index on the project database, so the scan is
 * composed from the accepted push-state readers: page the artifact listing and keep any whose
 * `readProjectCloudSyncState` reports pending (never synced, a prior failure, or a source that
 * advanced past the last success). Each pending artifact is pushed over the injected client; a
 * per-artifact failure is recorded and the scan continues; cancellation aborts the flush.
 */
export async function resyncDatabaseArtifacts(
  handle: ProjectDatabase,
  options: ResyncDatabaseArtifactsOptions
): Promise<ResyncDatabaseArtifactsResult> {
  const { target, repoUrl, client, force, now, signal, onWait } = options;
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Resync cancelled before selecting pending artifacts'
    );
  const pending = options.selection
    ? options.selection.map((selected) => ({ ...selected }))
    : selectPendingDatabaseArtifactPushes(handle, target);
  const results: ResyncArtifactResult[] = [];
  for (const selected of pending) {
    const artifactId = selected.artifactId;
    try {
      if (
        !selected.requiresSourcePlanOwnerRef &&
        requiresDatabasePushOwnerRef(handle, artifactId, target)
      )
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          `Artifact ${artifactId} changed its cloud capability requirement after resync qualification; rerun resync to qualify the current work`
        );
      results.push({
        artifactId,
        outcome: await pushDatabaseArtifact(handle, artifactId, {
          ...options,
          target,
          repoUrl,
          client,
          force,
          now,
          signal,
          onWait,
        }),
      });
    } catch (error) {
      if (error instanceof ProjectDatabaseError && error.code === 'CANCELLED') throw error;
      results.push({
        artifactId,
        error: {
          code: (error as { code?: string }).code ?? 'PUSH_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return { pending: pending.length, results };
}

export type CaptureCloudSyncReport =
  | { readonly status: 'synced'; readonly cloudApplied: boolean; readonly hash: string }
  | { readonly status: 'skipped'; readonly reason: 'unchanged'; readonly hash: string }
  | { readonly status: 'refused'; readonly code: string; readonly message: string };

/**
 * Record a completed capture's cloud sync through the project database: push the artifact's
 * retained thread over the injected client and report the outcome. A non-cancellation refusal is
 * reported (never thrown) so an eager sync never fails an already-committed capture — the artifact
 * stays retained and `resync` can drain it later; cancellation propagates.
 */
export async function syncCompletedCapture(
  handle: ProjectDatabase,
  artifactId: string,
  options: PushDatabaseArtifactOptions
): Promise<CaptureCloudSyncReport> {
  try {
    const outcome = await pushDatabaseArtifact(handle, artifactId, options);
    return outcome.status === 'skipped'
      ? { status: 'skipped', reason: 'unchanged', hash: outcome.hash }
      : { status: 'synced', cloudApplied: outcome.cloudApplied, hash: outcome.hash };
  } catch (error) {
    if (error instanceof ProjectDatabaseError && error.code === 'CANCELLED') throw error;
    return {
      status: 'refused',
      code: (error as { code?: string }).code ?? 'PUSH_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
