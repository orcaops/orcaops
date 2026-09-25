import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { knowledgeBlock } from '@orcaops/core';
import { ATTRIBUTION_RUNG, coverageItemSchema, coverageSummarySchema } from '@orcaops/review-core';
import { canonicalJson, type EventWithPayload } from '@orcaops/storage';
import {
  type ArtifactRevision,
  type KnowledgeBoundary,
  type ProjectDatabase,
  projectTaskKnowledgeContext,
  readProjectArtifact,
  writeSequencesOf,
} from '@orcaops/storage/history/database';

import { buildClaimLedger, type CheckpointClaims } from '../claimLedger.js';
import {
  ACCOUNT_CORPUS_CEILING_BYTES,
  buildDossier,
  DOSSIER_BUDGET_V1,
  DOSSIER_KNOWLEDGE_BOUNDS,
  dossierKnowledge,
  type DossierTaskKnowledge,
  FORENSIC_TRANSPORT_CEILING_BYTES,
} from '../dossier.js';
import { floorSelectionSchema, requireFloorSelection } from './floor-preparation.js';
import { readDatabaseReviewFloor } from './floors.js';
import {
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
  validate,
  withReviewDatabase,
} from './request.js';
import { readDatabaseReview, selection } from './reviews.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ceiling = count.refine((value) => value > 0);
export const runInputPolicySchema = z.strictObject({
  budget: z.strictObject({
    ledgerReduction: count,
    implicatedHunks: count,
    riskRemainder: count,
    accountProjectionTotal: count,
    forensicInputTotal: count,
    ledgerCitedTextClip: count,
  }),
  forensicTransportCeilingBytes: ceiling,
  accountCorpusCeilingBytes: ceiling,
  stubPaths: z.array(z.string().min(1)),
  excludePaths: z.array(z.string().min(1)),
});
export function defaultRunInputPolicy(): z.infer<typeof runInputPolicySchema> {
  return {
    budget: { ...DOSSIER_BUDGET_V1 },
    forensicTransportCeilingBytes: FORENSIC_TRANSPORT_CEILING_BYTES,
    accountCorpusCeilingBytes: ACCOUNT_CORPUS_CEILING_BYTES,
    stubPaths: [],
    excludePaths: [],
  };
}
export const runInputSelectionSchema = floorSelectionSchema.extend({
  floorPublicationId: revisionId,
});
const prepareSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  expected: runInputSelectionSchema,
  policy: runInputPolicySchema,
  generatedAt: z.iso.datetime(),
  secretAllow: z.array(z.string()),
});
export type PrepareDatabaseReviewRunInputs = z.infer<typeof prepareSchema>;
export const runInputNames = [
  'dossier-v1.json',
  'account-projection-v1.json',
  'forensic-input-v1.json',
  'coverage-v1.json',
  'diff.patch',
] as const;
export type RunInputName = (typeof runInputNames)[number];
export interface RunInputMember {
  name: RunInputName;
  bytes: Uint8Array;
}
export const runInputKeys = {
  'dossier-v1.json': 'dossier',
  'account-projection-v1.json': 'projection',
  'forensic-input-v1.json': 'forensic_input',
  'coverage-v1.json': 'coverage',
  'diff.patch': 'diff',
} as const;
export const runCoverageSchema = z.strictObject({
  schema_version: z.literal(1),
  attribution_rung: z.enum(ATTRIBUTION_RUNG),
  items: z.array(coverageItemSchema),
  summary: coverageSummarySchema,
});
export function sha16(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}
export function prepareRunInputMembers(
  raw: readonly RunInputMember[],
  secretAllow: readonly string[]
) {
  if (!Array.isArray(raw)) invalid('Provide the complete original run input member list');
  const seen = new Set<string>();
  const members = Array.from<RunInputMember, { name: RunInputName; bytes: Buffer; text: string }>(
    raw,
    (member) => {
      if (!member || !runInputNames.includes(member.name) || seen.has(member.name))
        invalid('Run input names must be recognized and unique');
      seen.add(member.name);
      return { name: member.name, ...prepareReviewText({ bytes: member.bytes, secretAllow }) };
    }
  );
  for (const required of runInputNames.slice(0, 3))
    if (!seen.has(required)) invalid('Retain every required run input member');
  const values: Record<string, unknown> = {};
  const inputShas: Record<string, string> = {};
  for (const member of members) {
    inputShas[runInputKeys[member.name]] = sha16(member.bytes);
    switch (member.name) {
      case 'dossier-v1.json':
        values[member.name] = decodeRetainedReviewRecord({
          kind: 'dossier',
          bytes: prepareReviewRecords({
            records: [{ kind: 'dossier', bytes: member.bytes }],
            secretAllow,
          })[0]!.bytes,
        }).value;
        break;
      case 'account-projection-v1.json':
        values[member.name] = decodeRetainedReviewRecord({
          kind: 'account-projection',
          bytes: prepareReviewRecords({
            records: [{ kind: 'account-projection', bytes: member.bytes }],
            secretAllow,
          })[0]!.bytes,
        }).value;
        break;
      case 'forensic-input-v1.json':
        values[member.name] = decodeRetainedReviewRecord({
          kind: 'forensic-input',
          bytes: prepareReviewRecords({
            records: [{ kind: 'forensic-input', bytes: member.bytes }],
            secretAllow,
          })[0]!.bytes,
        }).value;
        break;
      case 'coverage-v1.json':
        values[member.name] = prepareReviewJson(runCoverageSchema, {
          bytes: member.bytes,
          secretAllow,
        }).value;
        break;
      case 'diff.patch':
        values[member.name] = member.text;
        break;
    }
  }
  return { members: members.map(({ name, bytes }) => ({ name, bytes })), inputShas, values };
}
export async function prepareDatabaseReviewRunInputs(
  raw: PrepareDatabaseReviewRunInputs,
  options: { signal?: AbortSignal } = {}
) {
  options = { signal: options.signal };
  const input = validate(prepareSchema, raw);
  scanMetadata(input, input.secretAllow);
  cancelled(options.signal);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    prepareRunInputsWithDatabase(database, input, options)
  );
}
function lastPlanEventId(events: readonly EventWithPayload[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const { record } = events[i]!;
    if (record.type === 'plan_captured' || record.type === 'plan_revised') return record.event_id;
  }
  return null;
}

/** A review member as the run retains it: its thread at the exact revision the floor pinned. */
export interface ReviewKnowledgeMember {
  readonly artifactId: string;
  readonly events: readonly EventWithPayload[];
}

export interface ReviewKnowledgeAt {
  readonly members: readonly ReviewKnowledgeMember[];
  /**
   * The write sequence the floor publication committed at, or `'now'` for a read no floor pins.
   * A run's inputs are compared byte for byte against a re-preparation from its retained floor,
   * so the knowledge they carry has to be a function of that floor: the current boundary moves
   * with every write, the floor's does not.
   */
  readonly boundary: KnowledgeBoundary;
}

/**
 * What continuing knowledge the reviewed work is answerable to, for the account lane.
 *
 * Each member is resolved independently in artifact scope, against the plan retained in that
 * member revision. Combining them into one project-scoped answer would let one task's local rule
 * govern another and could compare every rule against only one member's plan.
 *
 * The processing coverage is null: this path resolves no provider and evaluates no consent grant,
 * so it claims no completeness and the block's coverage statement says exactly that.
 */
export function reviewKnowledge(
  database: ProjectDatabase,
  at: ReviewKnowledgeAt
): DossierTaskKnowledge {
  const projectId = database.authority.projectId;
  const tasks = database.read((view) =>
    at.members.map((member) => {
      const retainedPlanEventId = lastPlanEventId(member.events);
      const task = projectTaskKnowledgeContext(view, {
        projectId,
        artifactId: member.artifactId,
        boundary: at.boundary,
        plan:
          retainedPlanEventId === null
            ? { kind: 'latest_visible' }
            : { kind: 'exact', planEventId: retainedPlanEventId },
      });
      const planEventId = task.selectedPlan?.planEventId ?? null;
      return {
        artifactId: member.artifactId,
        planEventId,
        knowledge: dossierKnowledge(
          knowledgeBlock(task.knowledge, {
            plan: planEventId === null ? null : { artifactId: member.artifactId, planEventId },
            bounds: DOSSIER_KNOWLEDGE_BOUNDS,
          })
        ),
      };
    })
  ).value;
  return { schema_version: 1, tasks };
}

/** The write sequence the floor publication committed at: the boundary every run on it reads at. */
function floorBoundary(database: ProjectDatabase, publicationOperationId: string): number {
  const sequence = database.read(
    (view) => writeSequencesOf(view, [publicationOperationId]).get(publicationOperationId) ?? null
  ).value;
  if (sequence === null)
    integrity('The floor publication operation is missing; preserve history for explicit repair');
  return sequence;
}

export async function prepareRunInputsWithDatabase(
  database: ProjectDatabase,
  input: PrepareDatabaseReviewRunInputs,
  options: { signal?: AbortSignal }
) {
  options = { signal: options.signal };
  const snapshot = database.read((view) => {
    requireFloorSelection(view, input.reviewId, input.expected);
    if (selection(view, input.reviewId).floor_publication_id !== input.expected.floorPublicationId)
      stale('The selected floor changed; prepare the intended exact run inputs in a new operation');
    return null;
  });
  const review = await readDatabaseReview({ authority: input.authority, reviewId: input.reviewId });
  if (
    !review.value ||
    review.value.selection.membership_revision_id !== input.expected.membershipRevisionId
  )
    stale('Review membership changed while preparing run inputs; retain the intended exact target');
  const retained = await readDatabaseReviewFloor({
    authority: input.authority,
    reviewId: input.reviewId,
    publicationId: input.expected.floorPublicationId,
  });
  if (
    !retained.value ||
    retained.value.membershipRevisionId !== input.expected.membershipRevisionId
  )
    stale('The floor does not retain this exact membership; prepare a new floor before the run');
  const claims: CheckpointClaims[] = [];
  const threads: ReviewKnowledgeMember[] = [];
  for (const member of review.value.membership.members) {
    cancelled(options.signal);
    const revision = database.read((view) =>
      view.get<ArtifactRevision>(
        'SELECT generation, ordered_hash AS orderedHash, event_count AS eventCount, byte_length AS byteLength, tail_event_id AS tailEventId FROM artifact_revisions WHERE artifact_id = ? AND generation = ?',
        member.artifactId,
        member.generation
      )
    ).value;
    if (!revision || revision.orderedHash !== member.orderedHash)
      integrity('Retained run member revision is missing; preserve history for repair');
    const artifact = readProjectArtifact(database, member.artifactId, revision);
    if (!artifact) integrity('Retained run member history is missing; preserve history for repair');
    threads.push({ artifactId: member.artifactId, events: artifact.thread.events });
    for (const checkpoint of artifact.thread.checkpoints)
      claims.push({
        artifact: member.artifactId,
        cp: checkpoint.n,
        status: checkpoint.status,
        completedStepIds: checkpoint.status === 'closed' ? [...checkpoint.completed_step_ids] : [],
        filesChanged: checkpoint.status === 'closed' ? [...checkpoint.files_changed] : [],
        verificationCommands:
          checkpoint.status === 'closed'
            ? (checkpoint.verification ?? []).map((entry) => entry.command)
            : [],
      });
  }
  const floor = retained.value.floor;
  const diff = prepareReviewText({
    bytes: retained.value.diffBytes,
    secretAllow: input.secretAllow,
  });
  prepareReviewText({
    bytes: Buffer.from(canonicalJson({ floor, claims })),
    secretAllow: input.secretAllow,
  });
  const ledger = buildClaimLedger({ floor, checkpoints: claims, generatedAt: input.generatedAt });
  const dossier = buildDossier({
    floor,
    retainedDiff: diff.text,
    ledgerEntries: ledger.entries,
    branch: floor.scope.branch,
    baseSha: floor.scope.base_sha,
    generatedAt: input.generatedAt,
    taskKnowledge: reviewKnowledge(database, {
      members: threads,
      boundary: floorBoundary(database, retained.value.publicationOperationId),
    }),
    ...input.policy,
  });
  cancelled(options.signal);
  const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const prepared = prepareRunInputMembers(
    [
      { name: 'dossier-v1.json', bytes: jsonBytes(dossier.dossier) },
      { name: 'account-projection-v1.json', bytes: jsonBytes(dossier.accountProjection) },
      { name: 'forensic-input-v1.json', bytes: jsonBytes(dossier.forensicInput) },
      {
        name: 'coverage-v1.json',
        bytes: jsonBytes({
          schema_version: 1,
          attribution_rung: floor.attribution.active_rung,
          items: floor.coverage.items,
          summary: floor.coverage.summary,
        }),
      },
      { name: 'diff.patch', bytes: diff.bytes },
    ],
    input.secretAllow
  );
  return {
    ...prepared,
    floorInputHash: floor.input_hash,
    branch: floor.scope.branch,
    policy: input.policy,
    expected: input.expected,
    counters: snapshot.counters,
    ledger,
  };
}
export function requirePreparedRunInputs(
  actual: ReturnType<typeof prepareRunInputMembers>,
  expected: ReturnType<typeof prepareRunInputMembers>
): void {
  for (const [name, value] of Object.entries(actual.values))
    if (!isDeepStrictEqual(value, expected.values[name]))
      invalid(
        'Pinned run input differs from its exact retained floor, claims or declared policy; use the prepared bytes'
      );
}
