import path from 'node:path';
import { z } from 'zod';

import { loadReadOnlyProjectConfig, Repo } from '@orcaops/core';
import { HistoryScopeError } from '@orcaops/project-scope/history/database';
import { type Floor } from '@orcaops/review-core';
import { uuidv7 } from '@orcaops/storage';
import { HistoryError } from '@orcaops/storage/history/authority';
import {
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';

import { validateOverrideBase } from '../base.js';
import { revParseTree, runGit } from '../git.js';
import { resolveReviewBasis } from '../reviewBasis.js';
import { writeReviewError, writeReviewOutput } from '../reviewFiles.js';
import { readDatabaseReviewBranchMembers } from './branch-members.js';
import { prepareDatabaseReviewFloor, readDatabaseReviewArtifacts } from './floor-preparation.js';
import {
  hydrateDatabaseReviewFloor,
  publishDatabaseReviewFloor,
  readDatabaseReviewFloor,
  snapshotDatabaseReviewFloor,
} from './floors.js';
import { decodeRetainedReviewJson } from './records.js';
import { cancelled, integrity, invalid, text, validate, withReviewDatabase } from './request.js';
import {
  deriveReviewOperationId,
  readRetainedReviewOperation,
  reviewOperationConflict,
} from './review-operation.js';
import {
  readDatabaseReviewResolution,
  resolveDatabaseReviewForBranch,
} from './review-resolution.js';
import { baseSchema, selection } from './reviews.js';
import { resolveDatabaseReviewAuthority } from './source-scope.js';

/** `--base auto` clears an explicit base policy and re-derives from topology. */
export const REVIEW_BASE_AUTO = 'auto';

const requestSchema = z.strictObject({
  branch: text.refine((value) => Boolean(value.trim()) && !/[\0\r\n]/u.test(value)),
  root: text,
  projectId: z.uuidv7().optional(),
  dataRoot: text.optional(),
  base: text.optional(),
  operationId: z.uuidv7(),
  generatedAt: z.iso.datetime(),
  secretAllow: z.array(z.string()),
});
export type ExecuteDatabaseReviewData = z.infer<typeof requestSchema>;

export interface DatabaseReviewDataResult {
  ok: true;
  schema_version: 1;
  operation_id: string;
  review_id: string;
  membership_revision_id: string;
  membership_outcome: 'created' | 'refreshed' | 'retained';
  publication_id: string;
  /** `retained` reuses the selected floor because its input hash is unchanged. */
  floor_outcome: 'published' | 'retained';
  /** The result came from the original operation receipt rather than a new publication. */
  replayed: boolean;
  floor: Floor;
}

/** The label the review resolution's derived child operation identity carries. */
const RESOLUTION_OPERATION = 'review.resolution';

/**
 * Replay a committed `review data`: the receipt names the review and the floor
 * publication it settled, and the floor is read back from that publication
 * rather than rebuilt. The caller's declared branch and base policy must be the
 * ones the original operation carried, or this identity names different work.
 */
async function replayPublishedFloor(
  authority: ProjectDatabaseAuthority,
  input: ExecuteDatabaseReviewData,
  original: { target: Record<string, unknown>; payload: Record<string, unknown> }
): Promise<DatabaseReviewDataResult> {
  const reviewId = original.target.reviewId;
  const publicationId = original.payload.publicationId;
  if (typeof reviewId !== 'string' || typeof publicationId !== 'string')
    integrity('The original floor receipt lost its retained identities; preserve it for repair');
  const retainedBase = original.payload.base as { baseBytes?: unknown } | undefined;
  const requested =
    input.base === undefined
      ? null
      : input.base === REVIEW_BASE_AUTO
        ? { kind: 'auto' as const, ref: null }
        : { kind: 'explicit' as const, ref: input.base };
  if ((retainedBase === undefined) !== (requested === null)) reviewOperationConflict();
  if (retainedBase !== undefined) {
    if (typeof retainedBase.baseBytes !== 'string')
      integrity('The original floor receipt lost its base policy; preserve it for repair');
    let policy: { kind?: unknown; ref?: unknown };
    try {
      policy = JSON.parse(Buffer.from(retainedBase.baseBytes, 'base64').toString('utf8')) as {
        kind?: unknown;
        ref?: unknown;
      };
    } catch {
      integrity('The original floor receipt has an unreadable base policy; preserve it for repair');
    }
    if (policy.kind !== requested!.kind || (policy.ref ?? null) !== requested!.ref)
      reviewOperationConflict();
  }
  const retained = await readDatabaseReviewFloor({ authority, reviewId, publicationId });
  if (!retained.value)
    integrity('The original floor publication is missing; preserve history for explicit repair');
  const floor = retained.value.floor as Floor;
  if (floor.scope.branch !== input.branch) reviewOperationConflict();
  const resolution = await readDatabaseReviewResolution({
    authority,
    operationId: deriveReviewOperationId(input.operationId, RESOLUTION_OPERATION),
  });
  return {
    ok: true,
    schema_version: 1,
    operation_id: input.operationId,
    review_id: reviewId,
    membership_revision_id:
      resolution.value?.membershipRevisionId ?? retained.value.membershipRevisionId,
    membership_outcome:
      resolution.value === null
        ? 'retained'
        : resolution.value.kind === 'review.create'
          ? 'created'
          : 'refreshed',
    publication_id: retained.value.publicationId,
    floor_outcome: 'published',
    replayed: true,
    floor,
  };
}

async function currentFloorState(authority: ProjectDatabaseAuthority, reviewId: string) {
  return withReviewDatabase(authority, 'reader', async (database) => {
    const snapshot = database.read((view) => ({
      selection: selection(view, reviewId),
      floor: snapshotDatabaseReviewFloor(view, { authority, reviewId }),
    }));
    const floor = await hydrateDatabaseReviewFloor(
      database,
      { authority, reviewId },
      { value: snapshot.value.floor, counters: snapshot.counters }
    );
    return { selection: snapshot.value.selection, floor: floor.value };
  });
}

/**
 * The base policy retained on the review's selected base revision, or null when
 * none is retained. `review data` reuses a retained EXPLICIT base when the
 * caller supplies no `--base`, so the automatically-derived base does not later
 * diverge from the pinned policy.
 */
async function readRetainedReviewBasePolicy(
  authority: ProjectDatabaseAuthority,
  reviewId: string
): Promise<z.infer<typeof baseSchema> | null> {
  return withReviewDatabase(
    authority,
    'reader',
    (database) =>
      database.read((view) => {
        const current = selection(view, reviewId);
        if (current.base_revision_id === null) return null;
        const row = view.get<{ bytes: string; hash: string }>(
          'SELECT hex(record_bytes) AS bytes, record_hash AS hash FROM review_base_revisions WHERE review_id = ? AND revision_id = ?',
          reviewId,
          current.base_revision_id
        );
        if (!row) integrity('Selected review base is missing; preserve history for repair');
        const base = decodeRetainedReviewJson(baseSchema, Buffer.from(row.bytes, 'hex'));
        if (base.sha256 !== row.hash)
          integrity('Retained review base hash differs; preserve history for repair');
        return base.value;
      }).value
  );
}

/**
 * `review data` over the canonical store: keep the branch's review and
 * membership current, resolve its base and target, then publish the floor
 * unless the retained one already carries the same input hash.
 *
 * The floor's whole content is derived inside preparation from the retained
 * membership, so this composes rather than assembling anything itself. An
 * explicit `--base` is recorded as the review's base policy, which is what the
 * retained base revision is for — there is no separate sticky-base file.
 */
export async function executeDatabaseReviewData(
  raw: ExecuteDatabaseReviewData,
  options: ProjectOperationOptions = {}
): Promise<DatabaseReviewDataResult> {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(requestSchema, raw);
  const root = path.resolve(input.root);
  cancelled(options.signal);

  // Receipt first: before the base is resolved against Git, before the branch
  // members are selected and before anything opens a writer. An interrupted
  // publication is retried under its original identity and replays; a different
  // branch or base policy under that identity is a conflict, not a second floor.
  const authority = await resolveDatabaseReviewAuthority({
    cwd: root,
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });
  cancelled(options.signal);
  const committed = await readRetainedReviewOperation({
    authority,
    operationId: input.operationId,
    kinds: ['review.floor'],
  });
  if (committed.value) return replayPublishedFloor(authority, input, committed.value);
  cancelled(options.signal);

  // Refuse an unresolvable explicit base before anything opens a writer: a typo
  // must not fall through to a different base and a plausible-but-wrong review.
  let overrideTree: string | null = null;
  let overrideRef: string | null = null;
  const explicitBase = input.base !== undefined && input.base !== REVIEW_BASE_AUTO;
  if (explicitBase) {
    overrideTree = await revParseTree(root, input.base!);
    validateOverrideBase(input.base, overrideTree);
    const resolved = await runGit(root, ['rev-parse', '--verify', `${input.base!}^{commit}`]);
    if (resolved.code !== 0)
      invalid(`invalid --base '${input.base!}': not a resolvable git commit`);
    overrideRef = resolved.stdout.toString('utf8').trim();
  }

  const selected = await readDatabaseReviewBranchMembers({
    branch: input.branch,
    cwd: root,
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });
  cancelled(options.signal);

  const resolved = await resolveDatabaseReviewForBranch(
    {
      authority,
      operationId: deriveReviewOperationId(input.operationId, RESOLUTION_OPERATION),
      branch: input.branch,
      members: selected.members,
      initialContext: { worktreeId: null, baseSha: null, headSha: null },
      secretAllow: input.secretAllow,
    },
    options
  );
  const reviewId = resolved.reviewId;
  cancelled(options.signal);

  // A saved explicit base outlives the run that set it: a later `review data`
  // with no --base reuses it, so the automatically-derived base cannot diverge
  // from the retained policy and reject the refresh as stale
  // (floor-preparation refuses an explicit base whose oid the resolved base
  // does not match). `--base auto` re-opts into automatic derivation and is
  // deliberately not reused here.
  if (input.base === undefined) {
    const savedBase = await readRetainedReviewBasePolicy(authority, reviewId);
    if (savedBase?.kind === 'explicit') {
      overrideRef = savedBase.oid;
      overrideTree = await revParseTree(root, savedBase.oid);
      if (overrideTree === null)
        invalid(
          `the saved review base '${savedBase.ref}' is no longer a resolvable git object; ` +
            'restore it or pass an explicit --base'
        );
    }
    cancelled(options.signal);
  }

  const config = await loadReadOnlyProjectConfig(root);
  const artifacts = await withReviewDatabase(authority, 'reader', (database) =>
    readDatabaseReviewArtifacts(database, selected.members, { signal: options.signal })
  );
  const basis = await resolveReviewBasis({
    root,
    repo: new Repo(root),
    branch: input.branch,
    config,
    artifacts,
    overrideTree,
    overrideRef,
    durableObjects: true,
  });
  cancelled(options.signal);

  const state = await currentFloorState(authority, reviewId);
  const current = state.selection;
  const basePolicy = explicitBase
    ? {
        revisionId: uuidv7(),
        bytes: Uint8Array.from(
          Buffer.from(
            `${JSON.stringify(
              {
                kind: 'explicit',
                ref: input.base,
                oid: overrideRef,
                recordedAt: input.generatedAt,
                source: null,
              },
              null,
              2
            )}\n`
          )
        ),
      }
    : input.base === REVIEW_BASE_AUTO
      ? {
          revisionId: uuidv7(),
          bytes: Uint8Array.from(
            Buffer.from(
              `${JSON.stringify(
                { kind: 'auto', recordedAt: input.generatedAt, source: null },
                null,
                2
              )}\n`
            )
          ),
        }
      : undefined;

  const prepared = await prepareDatabaseReviewFloor(
    {
      authority,
      reviewId,
      expected: {
        membershipRevisionId: current.membership_revision_id,
        membershipVersion: current.membership_version,
        baseRevisionId: current.base_revision_id,
        baseVersion: current.base_version,
        floorVersion: current.floor_version,
      },
      basis: {
        gitRoot: root,
        baseSha: basis.baseSha,
        pinnedTreeSha: basis.pinnedTreeSha,
        worktreeHead: basis.worktreeHead,
        defaultBranch: basis.defaultBranch,
        fingerprintMaxDiffBytes: config.diff_fingerprint.max_diff_bytes,
        reviewMaxDiffBytes: config.review.max_diff_bytes,
        reviewIncludedUntracked: basis.reviewIncludedUntracked,
      },
      disclosures: basis.disclosures,
      generatedAt: input.generatedAt,
      secretAllow: input.secretAllow,
      ...(basePolicy ? { base: basePolicy } : {}),
    },
    { signal: options.signal }
  );
  cancelled(options.signal);

  const floor = JSON.parse(prepared.floorBytes.toString('utf8')) as Floor;
  // A retained floor with the same input hash is the canonical cache hit: the
  // publication would repeat identical evidence under a new identity.
  if (
    basePolicy === undefined &&
    state.floor !== null &&
    state.floor.floor.input_hash === floor.input_hash &&
    state.floor.membershipRevisionId === current.membership_revision_id
  )
    return {
      ok: true,
      schema_version: 1,
      operation_id: input.operationId,
      review_id: reviewId,
      membership_revision_id: resolved.membershipRevisionId,
      membership_outcome: resolved.outcome,
      publication_id: state.floor.publicationId,
      floor_outcome: 'retained',
      replayed: false,
      floor: state.floor.floor as Floor,
    };

  const publicationId = uuidv7();
  const published = await publishDatabaseReviewFloor(
    {
      authority,
      reviewId,
      operationId: input.operationId,
      publicationId,
      secretAllow: input.secretAllow,
      basis: prepared.basis,
      expected: prepared.expected,
      floorBytes: prepared.floorBytes,
      diffBytes: prepared.diffBytes,
      disclosures: basis.disclosures,
      ...(prepared.base ? { base: prepared.base } : {}),
    },
    options
  );
  return {
    ok: true,
    schema_version: 1,
    operation_id: input.operationId,
    review_id: reviewId,
    membership_revision_id: resolved.membershipRevisionId,
    membership_outcome: resolved.outcome,
    publication_id: published.value.publicationId ?? publicationId,
    floor_outcome: 'published',
    replayed: published.replayed,
    floor,
  };
}

export function databaseReviewDataFailure(error: unknown) {
  if (
    error instanceof ProjectDatabaseError ||
    error instanceof HistoryScopeError ||
    error instanceof HistoryError
  )
    return {
      code: error.code,
      message: error.message,
      ...(error instanceof HistoryScopeError && error.context?.candidates
        ? { candidates: error.context.candidates, truncated: error.context.truncated }
        : {}),
    };
  return {
    code: 'HISTORY_INACCESSIBLE',
    message:
      error instanceof Error
        ? error.message
        : 'Review data could not access its required history; preserve the original operation and inspect storage before retrying',
  };
}

/**
 * The public `review data` verb. One SIGINT listener is bridged to the
 * operation's AbortController and removed in `finally`, so a cancelled run
 * refuses before settlement and its original operation ID stays retryable.
 */
export async function runDatabaseReviewData(
  args: {
    branch?: string;
    projectId?: string;
    base?: string;
    operationId?: string;
    json: boolean;
  },
  root: string,
  now: () => string = () => new Date().toISOString()
): Promise<number> {
  if (!args.branch) {
    writeReviewError('review data: --branch <branch> is required\n');
    return 1;
  }
  const operationId = args.operationId ?? uuidv7();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  try {
    const result = await executeDatabaseReviewData(
      {
        branch: args.branch,
        root,
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        ...(args.base === undefined ? {} : { base: args.base }),
        operationId,
        generatedAt: now(),
        secretAllow: [],
      },
      { signal: controller.signal }
    );
    if (args.json) writeReviewOutput(`${JSON.stringify(result.floor)}\n`);
    else {
      const s = result.floor.coverage.summary;
      writeReviewOutput(
        `floor: ${result.floor.scope.branch} · ${result.floor.scope.artifact_ids.length} artifact(s) · ` +
          `${s.matched_rows}/${s.reviewable_rows} rows matched · ${s.ambiguous_rows} ambiguous · ` +
          `${s.excluded} excluded / ${s.unreviewable} unreviewable hunk(s) · ` +
          `rung ${result.floor.attribution.active_rung}\n`
      );
    }
    return 0;
  } catch (cause) {
    const error = {
      ok: false,
      schema_version: 1,
      operation_id: operationId,
      ...databaseReviewDataFailure(cause),
    };
    if (args.json) writeReviewOutput(`${JSON.stringify(error)}\n`);
    else
      writeReviewError(`review data (operation ${operationId}): ${error.code}: ${error.message}\n`);
    return error.code === 'INVALID_INPUT' ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}
