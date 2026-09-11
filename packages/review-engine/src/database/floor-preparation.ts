import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { Repo } from '@orcaops/core';
import { disclosureSchema, slugifyBranch } from '@orcaops/review-core';
import {
  canonicalJson,
  resolveRecordedFingerprintBaseline,
  validateCheckpointFingerprintManifest,
} from '@orcaops/storage';
import {
  type ArtifactRevision,
  type GitRetentionTarget,
  type ProjectDatabase,
  type ProjectReadView,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { buildFloor, isFloorCacheHealthClean } from '../floor.js';
import { revParseTree } from '../git.js';
import { collectReviewDiffBudget } from '../reviewDiffBudget.js';
import { buildReviewArtifact, type ScopeInputs } from '../scope.js';
import {
  decodeRetainedReviewJson,
  decodeRetainedReviewRecord,
  prepareReviewJson,
  prepareReviewRecords,
  prepareReviewText,
} from './records.js';
import {
  authoritySchema,
  cancelled,
  integrity,
  invalid,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
  version,
  withReviewDatabase,
} from './request.js';
import { baseSchema, membershipSchema, selection } from './reviews.js';

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const floorBasisSchema = z.strictObject({
  gitRoot: text,
  baseSha: objectId,
  pinnedTreeSha: objectId,
  worktreeHead: objectId.nullable(),
  defaultBranch: text.nullable(),
  fingerprintMaxDiffBytes: limit,
  reviewMaxDiffBytes: limit,
  reviewIncludedUntracked: z.array(text),
});
export const floorSelectionSchema = z.strictObject({
  membershipRevisionId: revisionId,
  membershipVersion: version.refine((value) => value > 0),
  baseRevisionId: revisionId.nullable(),
  baseVersion: version,
  floorVersion: version,
});
export type FloorSelection = z.infer<typeof floorSelectionSchema>;
export function requireFloorSelection(
  view: ProjectReadView,
  reviewId: string,
  expected: FloorSelection
): void {
  const current = selection(view, reviewId);
  if (
    current.membership_revision_id !== expected.membershipRevisionId ||
    current.membership_version !== expected.membershipVersion ||
    current.base_revision_id !== expected.baseRevisionId ||
    current.base_version !== expected.baseVersion ||
    current.floor_version !== expected.floorVersion
  )
    stale(
      'Review base, membership or floor changed; prepare a new operation for the intended exact inputs'
    );
}
export const floorBaseSchema = z.strictObject({ revisionId, bytes: z.instanceof(Uint8Array) });
const prepareSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  expected: floorSelectionSchema,
  basis: floorBasisSchema,
  generatedAt: z.iso.datetime(),
  base: floorBaseSchema.optional(),
  // Pre-diff scope-resolution warnings (degenerate/merged-branch scope, excluded
  // untracked evidence) computed alongside the basis. Carried beside the basis
  // rather than inside it — the retained basis is byte-validated by the store —
  // and folded into the assembled floor so a review surfaces its scope caveats
  // instead of presenting as complete with them dropped.
  disclosures: z.array(disclosureSchema).optional(),
  secretAllow: z.array(z.string()),
});
export type PrepareDatabaseReviewFloor = Omit<z.infer<typeof prepareSchema>, 'base'> & {
  base?: { revisionId: string; bytes: Uint8Array };
};

export async function prepareDatabaseReviewFloor(
  raw: PrepareDatabaseReviewFloor,
  options: { signal?: AbortSignal } = {}
) {
  options = { signal: options.signal };
  const input = validate(prepareSchema, raw);
  if (input.base) {
    const base = prepareReviewJson(baseSchema, {
      bytes: input.base.bytes,
      secretAllow: input.secretAllow,
    });
    input.base.bytes = Buffer.from(base.bytes);
  }
  scanMetadata(input, input.secretAllow);
  cancelled(options.signal);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    prepareFloorWithDatabase(database, input, options)
  );
}

export async function prepareFloorWithDatabase(
  database: ProjectDatabase,
  input: PrepareDatabaseReviewFloor,
  options: { signal?: AbortSignal }
) {
  options = { signal: options.signal };
  const authoredBase = input.base
    ? {
        revisionId: input.base.revisionId,
        record: prepareReviewJson(baseSchema, {
          bytes: input.base.bytes,
          secretAllow: input.secretAllow,
        }),
      }
    : null;
  const snapshot = database.read((view) => {
    requireFloorSelection(view, input.reviewId, input.expected);
    const membership = view.get<{ bytes: string; hash: string }>(
      'SELECT hex(record_bytes) AS bytes, record_hash AS hash FROM review_membership_revisions WHERE review_id = ? AND revision_id = ?',
      input.reviewId,
      input.expected.membershipRevisionId
    );
    const base =
      input.expected.baseRevisionId === null
        ? null
        : view.get<{ bytes: string; hash: string }>(
            'SELECT hex(record_bytes) AS bytes, record_hash AS hash FROM review_base_revisions WHERE review_id = ? AND revision_id = ?',
            input.reviewId,
            input.expected.baseRevisionId
          );
    const review = view.get<{ bytes: string; hash: string }>(
      'SELECT hex(identity_bytes) AS bytes, identity_hash AS hash FROM reviews WHERE review_id = ?',
      input.reviewId
    )!;
    const current = selection(view, input.reviewId);
    const run =
      current.current_run_id === null
        ? null
        : view.get<{ revisionId: string }>(
            'SELECT current_revision_id AS revisionId FROM review_runs WHERE review_id = ? AND run_id = ?',
            input.reviewId,
            current.current_run_id
          );
    if (current.current_run_id !== null && !run)
      integrity(
        'The selected review run revision is missing; preserve history for explicit repair'
      );
    const retentionTarget: Extract<GitRetentionTarget, { kind: 'review' }> = {
      kind: 'review',
      reviewId: input.reviewId,
      membershipRevisionId: current.membership_revision_id,
      baseRevisionId: current.base_revision_id,
      floorPublicationId: current.floor_publication_id,
      runId: current.current_run_id,
      runRevisionId: run?.revisionId ?? null,
      membershipVersion: current.membership_version,
      baseVersion: current.base_version,
      floorVersion: current.floor_version,
      runSelectionVersion: current.run_selection_version,
    };
    return { membership, base: base ?? null, review, retentionTarget };
  });
  const identity = decodeRetainedReviewRecord({
    kind: 'identity',
    bytes: Buffer.from(snapshot.value.review.bytes, 'hex'),
  });
  if (
    identity.sha256 !== snapshot.value.review.hash ||
    identity.value.review_id !== input.reviewId ||
    identity.value.project_id !== input.authority.projectId ||
    identity.value.store_instance_id !== input.authority.storeInstanceId ||
    (identity.value.repository_instance_id !== null &&
      identity.value.repository_instance_id !== input.authority.repositoryInstanceId)
  )
    integrity('Retained review identity differs from its authority; preserve history for repair');
  const branch = identity.value.initial_context.branch;
  if (branch === null)
    invalid('Floor preparation requires a review with an explicit branch context');
  const retained = snapshot.value.membership;
  if (!retained) integrity('Selected floor membership is missing; preserve history for repair');
  const membership = decodeRetainedReviewJson(membershipSchema, Buffer.from(retained.bytes, 'hex'));
  if (
    membership.sha256 !== retained.hash ||
    membership.value.revisionId !== input.expected.membershipRevisionId
  )
    integrity('Retained floor membership differs from its identity; preserve history for repair');
  let effectiveBase = authoredBase?.record.value ?? null;
  if (input.expected.baseRevisionId !== null) {
    const retainedBase = snapshot.value.base;
    if (!retainedBase) integrity('Selected review base is missing; preserve history for repair');
    const base = decodeRetainedReviewJson(baseSchema, Buffer.from(retainedBase.bytes, 'hex'));
    if (base.sha256 !== retainedBase.hash)
      integrity('Retained review base hash differs; preserve history for repair');
    effectiveBase ??= base.value;
  }
  if (effectiveBase?.kind === 'explicit' && effectiveBase.oid !== input.basis.baseSha)
    stale(
      'The resolved base differs from the exact effective policy; use its original object without retargeting'
    );
  const artifacts = await readDatabaseReviewArtifacts(database, membership.value.members, options);
  prepareReviewText({
    bytes: Buffer.from(canonicalJson(artifacts)),
    secretAllow: input.secretAllow,
  });
  cancelled(options.signal);
  const baseTreeSha = await revParseTree(input.basis.gitRoot, input.basis.baseSha);
  const pinnedTreeSha = await revParseTree(input.basis.gitRoot, input.basis.pinnedTreeSha);
  if (!baseTreeSha || pinnedTreeSha !== input.basis.pinnedTreeSha)
    invalid('Retain the exact base object and target tree before preparing review evidence');
  const diff = await collectReviewDiffBudget({
    repo: new Repo(input.basis.gitRoot),
    openTreeSha: baseTreeSha,
    closeTreeSha: pinnedTreeSha,
    maxDiffBytes: input.basis.reviewMaxDiffBytes,
    includedUntracked: input.basis.reviewIncludedUntracked,
  });
  if (!diff.ok || diff.statsFailed)
    invalid(
      'The exact review diff is unavailable; restore its Git objects before retrying preparation'
    );
  const diffBytes = prepareReviewText({ bytes: diff.diff, secretAllow: input.secretAllow }).bytes;
  cancelled(options.signal);
  const scopeInputs: ScopeInputs = {
    input: {
      branch: branch,
      branchSlug: slugifyBranch(branch),
      baseSha: input.basis.baseSha,
      baseTreeSha,
      pinnedTreeSha,
      defaultBranch: input.basis.defaultBranch,
      worktreeHead: input.basis.worktreeHead,
      artifacts,
    },
    fingerprintMaxDiffBytes: input.basis.fingerprintMaxDiffBytes,
    reviewMaxDiffBytes: input.basis.reviewMaxDiffBytes,
    reviewIncludedUntracked: input.basis.reviewIncludedUntracked,
    disclosures: input.disclosures ?? [],
  };
  const assembled = await buildFloor({
    root: input.basis.gitRoot,
    branch: branch,
    now: input.generatedAt,
    scopeInputs,
  });
  cancelled(options.signal);
  if (
    !isFloorCacheHealthClean(assembled.cacheHealth) ||
    !diffBytes.equals(Buffer.from(assembled.reviewDiff))
  )
    invalid(
      'Review assembly could not retain consistent Git evidence; restore its inputs before a new preparation'
    );
  const [floor] = prepareReviewRecords({
    records: [
      { kind: 'floor', bytes: Buffer.from(JSON.stringify(assembled.floor, null, 2) + '\n') },
    ],
    secretAllow: input.secretAllow,
  });
  return {
    floorBytes: floor!.bytes,
    diffBytes,
    expected: input.expected,
    basis: input.basis,
    counters: snapshot.counters,
    retentionTarget: snapshot.value.retentionTarget,
    ...(authoredBase
      ? {
          base: {
            revisionId: authoredBase.revisionId,
            bytes: Buffer.from(authoredBase.record.bytes),
          },
        }
      : {}),
  };
}

export function requirePreparedFloor(
  actual: { floorBytes: Uint8Array; diffBytes: Uint8Array },
  prepared: { floorBytes: Uint8Array; diffBytes: Uint8Array }
): void {
  const left = JSON.parse(Buffer.from(actual.floorBytes).toString('utf8'));
  const right = JSON.parse(Buffer.from(prepared.floorBytes).toString('utf8'));
  if (
    !isDeepStrictEqual(left, right) ||
    !Buffer.from(actual.diffBytes).equals(Buffer.from(prepared.diffBytes))
  )
    invalid(
      'Floor content or diff differs from its exact assembled inputs; publish the prepared evidence'
    );
}

/**
 * Build the review model for each retained membership member. Shared with the
 * public floor path, which needs the same artifacts to resolve the review's
 * base and target before preparation runs.
 */
export async function readDatabaseReviewArtifacts(
  database: ProjectDatabase,
  members: readonly { artifactId: string; generation: number; orderedHash: string }[],
  options: { signal?: AbortSignal } = {}
) {
  const artifacts = [];
  for (const member of members) {
    cancelled(options.signal);
    const revision = database.read((view) =>
      view.get<ArtifactRevision>(
        `SELECT generation, ordered_hash AS orderedHash, event_count AS eventCount,
       byte_length AS byteLength, tail_event_id AS tailEventId FROM artifact_revisions
       WHERE artifact_id = ? AND generation = ?`,
        member.artifactId,
        member.generation
      )
    ).value;
    if (!revision || revision.orderedHash !== member.orderedHash)
      integrity('Selected artifact revision is missing; preserve history for repair');
    const artifact = readProjectArtifact(database, member.artifactId, revision);
    if (!artifact?.thread.plan)
      integrity('Selected member history is incomplete; preserve history for repair');
    const thread = artifact.thread;
    const plan = thread.plan!;
    const manifests = new Map();
    const events = new Map(thread.events.map((event) => [event.record.event_id, event]));
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.status !== 'closed') continue;
      const payload = events.get(checkpoint.source_event_ids.closed)?.payload as
        | { diff_fingerprint_manifest?: unknown }
        | undefined;
      if (
        payload?.diff_fingerprint_manifest === undefined ||
        payload.diff_fingerprint_manifest === null
      )
        continue;
      const validated = await validateCheckpointFingerprintManifest({
        artifactId: thread.artifactId,
        checkpointN: checkpoint.n,
        openTreeSha: checkpoint.open_snapshot.tree_sha,
        closeTreeSha: checkpoint.close_snapshot.tree_sha,
        summary: checkpoint.diff_fingerprint_summary,
        manifest: payload.diff_fingerprint_manifest,
        recoveredOpenTreeSha: resolveRecordedFingerprintBaseline(thread, checkpoint),
      });
      if (!validated.available && validated.reason === 'malformed')
        integrity('A retained checkpoint manifest is malformed; preserve history for repair');
      if (validated.available) manifests.set(checkpoint.n, validated.manifest);
    }
    artifacts.push(
      await buildReviewArtifact(
        {
          readPlan: async () => plan,
          readCheckpointsRecovered: async () => thread.checkpoints,
          readSummary: async () => thread.summary,
          readEvaluatorLog: async () => thread.evaluatorLog,
          readArtifact: async () => thread.artifactJson,
          readCheckpointDiffFingerprints: async () => manifests,
        },
        {
          id: plan.artifact_id,
          branch: plan.branch,
          label: plan.label,
          task: plan.task,
          base_sha: plan.base_sha,
          started_at: plan.started_at,
        }
      )
    );
  }
  return artifacts;
}
