// The canonical Story review model — the routine two-lane run's PRIMARY output
// and the model the TUI review experience renders. It is a thin, self-contained
// projection of `ComposedStory` (twolaneSlice.ts) into a versioned, schema-pinned
// shape that JOINS the authored Story (Acts/Parts, interpretation, judgment
// questions) with the engine-DERIVED row ownership (per-Part changed-row
// segments + in-Part ambiguity), exposes the contested + unattributed residues
// explicitly (never silently absent), and carries the findings/ledger
// attachments, capture-quality metrics, and the degraded-attribution label.
//
// Design decisions (and why):
//   · CONTEXT-ONLY Parts are legal. A Part whose member checkpoints own no
//     surviving code has zero segments and still validates + renders. This is the
//     one constraint narrative-v2 gets wrong (every Part must carry non-empty
//     memberTargetKeys); this model deliberately does NOT inherit it.
//   · The residue is a first-class section of the model. Unattributed/contested
//     code appears in `residue`, so degraded-attribution (Story retained, ALL
//     code in unattributed residue) renders coherently rather than vanishing.
//   · Every Part's ranges must round-trip against the run's diff.patch —
//     `resolvePartRangesAgainstDiff` is the check, run at install time (fail
//     closed) and asserted by the acceptance tests.
//   · It lives in the run dir as story-review-model-v4.json because the model is
//     a per-run artifact.
//   · Install is atomic + validated: the model is schema-parsed (fail closed)
//     and round-tripped before an atomic write, so no partial states are visible.

import path from 'node:path';
import { z } from 'zod';

import {
  type Citation,
  CITATION_KIND,
  citationIdSchema,
  parseCitationId,
  stableHash64,
} from '@orcaops/review-core';
import { atomicWriteFile } from '@orcaops/storage';

import { parsePatchHunks } from './comments.js';
import type { AccountProjection } from './dossier.js';
import { collectEligibleSemanticAnchorCitations } from './semanticAnchors.js';
import type {
  CaptureQualityMetrics,
  ChangedRowSegment,
  ContestedEntry,
  InPartAmbiguity,
  UnattributedEntry,
} from './storyOwnership.js';
import { storyTitleSchema } from './storyTitle.js';
import type {
  ComposedStory,
  LedgerAttachment,
  MergedItem,
  OwnershipLabel,
  UncertaintyState,
} from './twolaneSlice.js';

export const STORY_REVIEW_MODEL_SCHEMA_VERSION = 4;
export const STORY_REVIEW_MODEL_FILE = 'story-review-model-v4.json';

// Re-export the ownership sub-types the model embeds, so a consumer names the
// whole model through this one module rather than reaching into storyOwnership.
export type {
  CaptureQualityMetrics,
  ChangedRowSegment,
  ContestedEntry,
  InPartAmbiguity,
  UnattributedEntry,
} from './storyOwnership.js';
export type { LedgerAttachment, OwnershipLabel, UncertaintyState } from './twolaneSlice.js';

// ---------------------------------------------------------------------------
// Model types — a self-contained projection. Ownership sub-types are ADOPTED
// structurally from storyOwnership.ts so the schema is the single validator.
// ---------------------------------------------------------------------------

/** One Act grouping (authored). `partIds` are the model Parts under it, in order. */
export interface StoryReviewAct {
  id: string;
  title: string;
  interpretation: string | null;
  partIds: string[];
}

export interface StoryReviewOverview {
  text: string;
  citations: string[];
}

/**
 * One Part: the authored surface (interpretation, membership, citations) JOINED
 * with the engine-derived ownership (segments + in-Part ambiguity). `contextOnly`
 * is true iff the Part owns zero surviving changed-row segments — a legal,
 * renderable state, never an error.
 */
export interface StoryReviewPart {
  id: string;
  /** Bounded authored heading; payload normalization substitutes `id` when the author omits it. */
  title: string;
  act: string | null;
  checkpointRefs: string[];
  interpretation: string;
  citations: string[];
  segments: ChangedRowSegment[];
  ambiguous: InPartAmbiguity[];
  changedRows: number;
  ambiguousRows: number;
  contextOnly: boolean;
}

/** The explicit residue: cross-Part contested + genuinely unattributed code. */
export interface StoryReviewResidue {
  contested: ContestedEntry[];
  unattributed: UnattributedEntry[];
  /** Reviewable changed rows sitting in unattributed residue. */
  reviewableRows: number;
  /** Files contributing residue rows, code-point sorted. */
  files: string[];
}

export interface StoryReviewFinding {
  id: string;
  lane: 'account' | 'forensic';
  text: string;
  file: string | null;
  relatedFiles: string[];
  severity: 'CRITICAL' | 'CAUTION' | 'REVIEW' | 'INFO';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  citationsByLane: StoryReviewCitationProvenance;
  required: boolean;
}

export interface StoryReviewCitationProvenance {
  account: string[];
  forensic: string[];
}

export interface StoryReviewCitation {
  id: string;
  kind: Citation['kind'];
  artifact: string;
  cp: number | null;
  text: string;
  parent?: string;
  evaluator?: NonNullable<Citation['evaluator']>;
}

export interface StoryReviewQuestion {
  id: string;
  lane: 'account' | 'forensic';
  text: string;
  file: string | null;
  citationsByLane: StoryReviewCitationProvenance;
  required: boolean;
}

export interface StoryReviewModel {
  schema_version: typeof STORY_REVIEW_MODEL_SCHEMA_VERSION;
  branch: string;
  floor_input_hash: string;
  /** The never-conflated ownership state: DERIVED, DEGRADED_ATTRIBUTION, CODE_ONLY. */
  label: OwnershipLabel;
  banner: string;
  /** Required for an authored Story; null only when no account Story exists. */
  overview: StoryReviewOverview | null;
  acts: StoryReviewAct[];
  /** Parts in causal (authored) order. Empty on a code-only review. */
  parts: StoryReviewPart[];
  residue: StoryReviewResidue;
  metrics: CaptureQualityMetrics;
  ledger: LedgerAttachment[];
  uncertainties: UncertaintyState[];
  findings: StoryReviewFinding[];
  questions: StoryReviewQuestion[];
  /** Complete prose/provenance for every Story or semantic-anchor citation. */
  citations: Record<string, StoryReviewCitation>;
  /** Prompt-local artifact alias -> durable artifact id. */
  artifactAliases: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Schema — the installed reader/writer boundary. Strict where the writer owns
// the shape; this same schema validates on read.
// ---------------------------------------------------------------------------

const intNonNeg = z.number().int().nonnegative();
const intPos = z.number().int().positive();

const sliceRangeSchema = z.strictObject({ start: intPos, end: intPos });
const checkpointOwnerRefSchema = z.strictObject({
  kind: z.literal('checkpoint'),
  artifact: z.string().min(1),
  cp: intPos,
});
const gapOwnerRefSchema = z.strictObject({ kind: z.literal('gap'), segment: z.string().min(1) });
const ownerRefSchema = z.discriminatedUnion('kind', [checkpointOwnerRefSchema, gapOwnerRefSchema]);

const segmentSchema = z.strictObject({
  file: z.string().min(1),
  hunkKey: z.string().min(1),
  slice: intNonNeg,
  owner: z.strictObject({ artifact: z.string().min(1), cp: intPos }),
  del_range: sliceRangeSchema.nullable(),
  add_range: sliceRangeSchema.nullable(),
  lines: intPos,
});

const inPartAmbiguitySchema = z.strictObject({
  file: z.string().min(1),
  hunkKey: z.string().min(1),
  lines: intNonNeg,
  candidates: z.array(ownerRefSchema),
});

const contestedSchema = z.strictObject({
  file: z.string().min(1),
  hunkKey: z.string().min(1),
  lines: intNonNeg,
  candidates: z.array(ownerRefSchema),
  partIds: z.array(z.string().min(1)),
});

const unattributedSchema = z.strictObject({
  file: z.string().min(1),
  hunkKey: z.string().min(1),
  slice: intNonNeg.optional(),
  kind: z.enum(['gap', 'unowned', 'ambiguous_no_part']),
  owner: gapOwnerRefSchema.nullable(),
  lines: intNonNeg,
  candidates: z.array(ownerRefSchema).optional(),
});

const metricsSchema = z.strictObject({
  reviewableRows: intNonNeg,
  attributedRows: intNonNeg,
  attributedPct: z.number(),
  ambiguousRows: intNonNeg,
  contestedRows: intNonNeg,
  unattributedRows: intNonNeg,
  contributingThreads: intNonNeg,
  contributingCheckpoints: intNonNeg,
});

const ledgerAttachmentSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  status: z.string(),
  message: z.string(),
  flagOnly: z.boolean(),
  attachment: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('part'), partId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('residue'), residue: z.enum(['unattributed', 'floor']) }),
  ]),
  disposition: z.enum([
    'RECONCILED',
    'ACKNOWLEDGED_BY_ACCOUNT',
    'ACKNOWLEDGED_BY_FORENSIC',
    'ACKNOWLEDGED_BY_BOTH',
    'OUTSTANDING',
  ]),
});

const uncertaintySchema = z.strictObject({
  citationId: z.string().min(1),
  artifact: z.string().min(1),
  cp: intPos,
  text: z.string(),
  partId: z.string().min(1).nullable(),
  // A single-member enum: nothing mechanical adjudicates a captured
  // uncertainty, so there is no other state to record.
  state: z.literal('UNADJUDICATED'),
});

const storyReviewActV4Schema = z.strictObject({
  id: z.string().min(1),
  title: storyTitleSchema,
  interpretation: z.string().min(1).nullable(),
  partIds: z.array(z.string().min(1)),
});

const storyReviewPartV4Schema = z.strictObject({
  id: z.string().min(1),
  title: storyTitleSchema,
  act: z.string().min(1).nullable(),
  // Context-only Parts are legal: checkpoint_refs is required non-empty (a Part
  // always groups at least one checkpoint) but segments MAY be empty.
  checkpointRefs: z.array(z.string().min(1)).min(1),
  interpretation: z.string().min(1),
  citations: z.array(z.string().min(1)),
  segments: z.array(segmentSchema),
  ambiguous: z.array(inPartAmbiguitySchema),
  changedRows: intNonNeg,
  ambiguousRows: intNonNeg,
  contextOnly: z.boolean(),
});

const findingSchema = z.strictObject({
  id: z.string().min(1),
  lane: z.enum(['account', 'forensic']),
  text: z.string(),
  file: z.string().min(1).nullable(),
  relatedFiles: z.array(z.string().min(1)).max(4),
  severity: z.enum(['CRITICAL', 'CAUTION', 'REVIEW', 'INFO']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']).nullable(),
  citationsByLane: z.strictObject({
    account: z.array(z.string().min(1)),
    forensic: z.array(z.string().min(1)),
  }),
  required: z.boolean(),
});

const questionSchema = z.strictObject({
  id: z.string().min(1),
  lane: z.enum(['account', 'forensic']),
  text: z.string().min(1),
  file: z.string().min(1).nullable(),
  citationsByLane: z.strictObject({
    account: z.array(z.string().min(1)),
    forensic: z.array(z.string().min(1)),
  }),
  required: z.boolean(),
});

const storyReviewCitationSchema = z.strictObject({
  id: citationIdSchema,
  kind: z.enum(CITATION_KIND),
  artifact: z.string().min(1),
  cp: z.number().int().positive().nullable(),
  text: z.string(),
  parent: citationIdSchema.optional(),
  evaluator: z
    .strictObject({
      evaluator_ref: z.string().min(1),
      severity: z.enum(['info', 'warn', 'block']),
      run_status: z.enum(['completed', 'error', 'skipped']),
      verdict: z.enum(['pass', 'violation', 'info']).nullable(),
      disposition: z
        .enum(['unresolved', 'acknowledged', 'dismissed', 'policy-excepted'])
        .nullable(),
      summary: z.string(),
    })
    .optional(),
});

const overviewSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .refine((text) => text.split(/\s+/).filter(Boolean).length <= 150, {
      message: 'overview text must be at most 150 words',
    }),
  citations: z
    .array(z.string().min(1))
    .min(1)
    .refine((citations) => new Set(citations).size === citations.length, {
      message: 'overview citations must be unique',
    }),
});

const storyReviewModelObjectSchema = z.strictObject({
  schema_version: z.literal(STORY_REVIEW_MODEL_SCHEMA_VERSION),
  branch: z.string(),
  floor_input_hash: z.string().min(1),
  label: z.enum(['DERIVED', 'DEGRADED_ATTRIBUTION', 'CODE_ONLY']),
  banner: z.string(),
  overview: overviewSchema.nullable(),
  acts: z.array(storyReviewActV4Schema),
  parts: z.array(storyReviewPartV4Schema),
  residue: z.strictObject({
    contested: z.array(contestedSchema),
    unattributed: z.array(unattributedSchema),
    reviewableRows: intNonNeg,
    files: z.array(z.string().min(1)),
  }),
  metrics: metricsSchema,
  ledger: z.array(ledgerAttachmentSchema),
  uncertainties: z.array(uncertaintySchema),
  findings: z.array(findingSchema),
  questions: z.array(questionSchema),
  citations: z.record(z.string().min(1), storyReviewCitationSchema),
  artifactAliases: z.record(z.string().min(1), z.string().min(1)),
});

export const storyReviewModelSchema = storyReviewModelObjectSchema.superRefine((model, ctx) => {
  if (model.parts.length > 0 && model.overview === null)
    ctx.addIssue({
      code: 'custom',
      path: ['overview'],
      message: 'an authored Story requires an overview',
    });
  const aliases = model.artifactAliases;
  const hasAlias = (alias: string): boolean => Object.hasOwn(aliases, alias);
  const validateOwner = (
    owner: { kind: 'checkpoint'; artifact: string; cp: number } | { kind: 'gap' },
    issuePath: (string | number)[]
  ): void => {
    if (owner.kind === 'checkpoint' && !hasAlias(owner.artifact))
      ctx.addIssue({
        code: 'custom',
        path: issuePath,
        message: `checkpoint artifact alias ${owner.artifact} is not installed`,
      });
  };
  const seenItems = new Set<string>();
  for (const [collection, items] of [
    ['findings', model.findings],
    ['questions', model.questions],
  ] as const) {
    for (const [index, item] of items.entries()) {
      if (seenItems.has(item.id))
        ctx.addIssue({
          code: 'custom',
          path: [collection, index, 'id'],
          message: `duplicate projected item id ${item.id}`,
        });
      seenItems.add(item.id);
    }
  }
  for (const [partIndex, part] of model.parts.entries()) {
    for (const [segmentIndex, segment] of part.segments.entries()) {
      if (!hasAlias(segment.owner.artifact))
        ctx.addIssue({
          code: 'custom',
          path: ['parts', partIndex, 'segments', segmentIndex, 'owner', 'artifact'],
          message: `segment artifact alias ${segment.owner.artifact} is not installed`,
        });
    }
    for (const [checkpointIndex, checkpointRef] of part.checkpointRefs.entries()) {
      const artifact = checkpointRef.split(':cp')[0] ?? checkpointRef;
      if (!hasAlias(artifact))
        ctx.addIssue({
          code: 'custom',
          path: ['parts', partIndex, 'checkpointRefs', checkpointIndex],
          message: `checkpoint reference artifact alias ${artifact} is not installed`,
        });
    }
    for (const [ambiguityIndex, ambiguity] of part.ambiguous.entries())
      for (const [candidateIndex, candidate] of ambiguity.candidates.entries())
        validateOwner(candidate, [
          'parts',
          partIndex,
          'ambiguous',
          ambiguityIndex,
          'candidates',
          candidateIndex,
        ]);
  }
  for (const [entryIndex, entry] of model.residue.contested.entries())
    for (const [candidateIndex, candidate] of entry.candidates.entries())
      validateOwner(candidate, ['residue', 'contested', entryIndex, 'candidates', candidateIndex]);
  for (const [entryIndex, entry] of model.residue.unattributed.entries()) {
    if (entry.owner !== null)
      validateOwner(entry.owner, ['residue', 'unattributed', entryIndex, 'owner']);
    for (const [candidateIndex, candidate] of (entry.candidates ?? []).entries())
      validateOwner(candidate, [
        'residue',
        'unattributed',
        entryIndex,
        'candidates',
        candidateIndex,
      ]);
  }
  for (const [uncertaintyIndex, uncertainty] of model.uncertainties.entries())
    if (!hasAlias(uncertainty.artifact))
      ctx.addIssue({
        code: 'custom',
        path: ['uncertainties', uncertaintyIndex, 'artifact'],
        message: `uncertainty artifact alias ${uncertainty.artifact} is not installed`,
      });
  for (const [id, citation] of Object.entries(model.citations)) {
    if (citation.id !== id)
      ctx.addIssue({
        code: 'custom',
        path: ['citations', id, 'id'],
        message: `catalog key ${id} does not match citation id ${citation.id}`,
      });
    const parsed = parseCitationId(id);
    if (
      parsed === null ||
      parsed.artifact !== citation.artifact ||
      parsed.checkpointN !== (citation.cp ?? null) ||
      parsed.kind !== citation.kind
    )
      ctx.addIssue({
        code: 'custom',
        path: ['citations', id],
        message: `citation ${id} disagrees with its structured identity`,
      });
    if (!hasAlias(citation.artifact))
      ctx.addIssue({
        code: 'custom',
        path: ['citations', id, 'artifact'],
        message: `citation artifact alias ${citation.artifact} is not installed`,
      });
    if (citation.parent !== undefined && !Object.hasOwn(model.citations, citation.parent))
      ctx.addIssue({
        code: 'custom',
        path: ['citations', id, 'parent'],
        message: `citation ${id} names catalog parent ${citation.parent}, but it is absent`,
      });
  }
  const referenced = [
    ...(model.overview?.citations ?? []),
    ...model.parts.flatMap((part) => part.citations),
    ...model.uncertainties.map((uncertainty) => uncertainty.citationId),
    ...model.findings.flatMap((item) => [
      ...item.citationsByLane.account,
      ...item.citationsByLane.forensic,
    ]),
    ...model.questions.flatMap((item) => [
      ...item.citationsByLane.account,
      ...item.citationsByLane.forensic,
    ]),
  ];
  const ledgerIds = new Set(model.ledger.map((entry) => entry.id));
  for (const id of referenced)
    if (!Object.hasOwn(model.citations, id) && !ledgerIds.has(id))
      ctx.addIssue({
        code: 'custom',
        path: ['citations'],
        message: `referenced Story identity ${id} is absent from both citation and ledger catalogs`,
      });
});

export type StoryReviewModelParsed = z.infer<typeof storyReviewModelSchema>;

export class StoryReviewModelInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryReviewModelInvariantError';
  }
}

export class StoryReviewModelCatalogError extends StoryReviewModelInvariantError {
  constructor(message: string) {
    super(message);
    this.name = 'StoryReviewModelCatalogError';
  }
}

export class StoryReviewModelProjectionError extends StoryReviewModelInvariantError {
  constructor(message: string) {
    super(message);
    this.name = 'StoryReviewModelProjectionError';
  }
}

export class StoryReviewModelRangeError extends StoryReviewModelInvariantError {
  constructor(message: string) {
    super(message);
    this.name = 'StoryReviewModelRangeError';
  }
}

// ---------------------------------------------------------------------------
// Projection — ComposedStory -> StoryReviewModel (pure, model-free)
// ---------------------------------------------------------------------------

const codePointCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const itemProvenance = (item: MergedItem): StoryReviewCitationProvenance => ({
  account: [...item.citationsByLane.account],
  forensic: [...item.citationsByLane.forensic],
});

function findingsFromMerge(
  items: readonly MergedItem[],
  requiredIds: ReadonlySet<string>
): StoryReviewFinding[] {
  return items
    .filter((x) => x.kind === 'finding')
    .map((x) => ({
      id: x.id,
      lane: x.lane,
      text: x.text,
      file: x.file,
      relatedFiles: [...x.relatedFiles],
      severity: x.severity,
      confidence: x.confidence,
      citationsByLane: itemProvenance(x),
      required: requiredIds.has(x.id),
    }));
}

function questionsFromMerge(
  items: readonly MergedItem[],
  requiredIds: ReadonlySet<string>
): StoryReviewQuestion[] {
  return items
    .filter((x) => x.kind === 'question')
    .map((x) => ({
      id: x.id,
      lane: x.lane,
      text: x.text,
      file: x.file,
      citationsByLane: itemProvenance(x),
      required: requiredIds.has(x.id),
    }));
}

const citationIdentity = (citation: StoryReviewCitation): string =>
  JSON.stringify({
    id: citation.id,
    kind: citation.kind,
    artifact: citation.artifact,
    cp: citation.cp ?? null,
    text: citation.text,
    parent: citation.parent ?? null,
    evaluator: citation.evaluator ?? null,
  });

function citationFromProjectionRecord(input: {
  id: string;
  text: string;
  parent?: string;
  evaluator?: Citation['evaluator'];
}): StoryReviewCitation {
  const parsed = parseCitationId(input.id);
  if (parsed === null)
    throw new StoryReviewModelCatalogError(
      `Story citation ${input.id} is not a valid citation identity`
    );
  return storyReviewCitationSchema.parse({
    id: input.id,
    kind: parsed.kind,
    artifact: parsed.artifact,
    cp: parsed.checkpointN,
    text: input.text,
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    ...(input.evaluator !== undefined ? { evaluator: input.evaluator } : {}),
  });
}

/**
 * Flatten the complete account projection into citation records. The projection
 * intentionally nests decisions and alternatives for prompt readability; v4
 * installs a flat catalog because semantic anchor generations address each
 * alternative by its own durable citation id.
 */
function projectionCitationPool(projection: AccountProjection): Map<string, StoryReviewCitation> {
  const pool = new Map<string, StoryReviewCitation>();
  const add = (candidate: StoryReviewCitation): void => {
    const prior = pool.get(candidate.id);
    if (prior === undefined) {
      pool.set(candidate.id, candidate);
      return;
    }
    if (citationIdentity(prior) === citationIdentity(candidate)) return;
    const compatible =
      prior.kind === candidate.kind &&
      prior.artifact === candidate.artifact &&
      (prior.cp ?? null) === (candidate.cp ?? null) &&
      prior.text === candidate.text &&
      (prior.parent === undefined ||
        candidate.parent === undefined ||
        prior.parent === candidate.parent) &&
      (prior.evaluator === undefined ||
        candidate.evaluator === undefined ||
        JSON.stringify(prior.evaluator) === JSON.stringify(candidate.evaluator));
    if (!compatible)
      throw new StoryReviewModelCatalogError(
        `conflicting citation identity ${candidate.id}: ${citationIdentity(prior)} != ${citationIdentity(candidate)}`
      );
    pool.set(candidate.id, {
      ...prior,
      ...(prior.parent === undefined && candidate.parent !== undefined
        ? { parent: candidate.parent }
        : {}),
      ...(prior.evaluator === undefined && candidate.evaluator !== undefined
        ? { evaluator: candidate.evaluator }
        : {}),
    });
  };
  const addRecord = (record: {
    citationId: string;
    text: string;
    parent?: string;
    evaluator?: Citation['evaluator'];
  }): void =>
    add(
      citationFromProjectionRecord({
        id: record.citationId,
        text: record.text,
        ...(record.parent !== undefined ? { parent: record.parent } : {}),
        ...(record.evaluator !== undefined ? { evaluator: record.evaluator } : {}),
      })
    );

  const core = projection.accountCore;
  for (const checkpoint of core.checkpoints) {
    for (const decision of checkpoint.decisions) {
      addRecord(decision);
      for (const alternative of decision.alternatives)
        addRecord({ ...alternative, parent: decision.citationId });
    }
    for (const uncertainty of checkpoint.uncertainty) addRecord(uncertainty);
  }
  for (const decision of core.planDecisions) {
    addRecord(decision);
    for (const alternative of decision.alternatives)
      addRecord({ ...alternative, parent: decision.citationId });
  }
  for (const record of core.planSteps) addRecord(record);
  for (const record of core.nonGoals) addRecord(record);
  for (const record of core.acceptanceCriteria) addRecord(record);
  for (const record of core.criterionEvidence) addRecord(record);
  for (const record of core.verification) addRecord(record);
  for (const record of core.evaluatorRuns) addRecord(record);
  for (const ledger of core.ledger)
    for (const [id, text] of Object.entries(ledger.citedFallback))
      add(citationFromProjectionRecord({ id, text }));

  // This is a second independently-maintained enumeration and therefore an
  // intentional cross-check. A conflict between the semantic-anchor contract
  // and the account projection fails before JSON object construction.
  for (const eligible of collectEligibleSemanticAnchorCitations(projection))
    add(
      citationFromProjectionRecord({
        id: eligible.id,
        text: eligible.text,
        ...(eligible.parent !== undefined ? { parent: eligible.parent } : {}),
      })
    );
  return pool;
}

function buildCitationCatalog(
  composed: ComposedStory,
  projection: AccountProjection
): Record<string, StoryReviewCitation> {
  const pool = projectionCitationPool(projection);
  const storyReferences = [
    ...(composed.story?.overview.citations ?? []),
    ...(composed.story?.parts.flatMap((part) => part.citations) ?? []),
    ...composed.uncertainties.map((uncertainty) => uncertainty.citationId),
    ...composed.merge.items.flatMap((item) => [
      ...item.citationsByLane.account,
      ...item.citationsByLane.forensic,
    ]),
  ];
  const ledgerIds = new Set(composed.ledger.map((entry) => entry.id));
  for (const id of storyReferences)
    if (parseCitationId(id) === null && !ledgerIds.has(id))
      throw new StoryReviewModelCatalogError(
        `Story reference ${id} is neither a capture citation nor an attached ledger row`
      );
  // `parts[].citations` is the historical field name, but the authoring
  // contract also permits `ldg:*` acknowledgement ids. Those resolve through
  // the already-installed `ledger` catalog; only actual `cite:*` identities
  // enter the citationSchema-backed map.
  const ids = new Set<string>([
    ...storyReferences.filter((id) => parseCitationId(id) !== null),
    ...collectEligibleSemanticAnchorCitations(projection).map((citation) => citation.id),
  ]);
  const pending = [...ids];
  while (pending.length > 0) {
    const id = pending.pop()!;
    const parent = pool.get(id)?.parent;
    if (parent === undefined || ids.has(parent)) continue;
    if (!pool.has(parent))
      throw new StoryReviewModelCatalogError(
        `citation ${id} names parent ${parent}, but the account projection carries no parent record`
      );
    ids.add(parent);
    pending.push(parent);
  }
  const entries = [...ids].sort(codePointCompare).map((id): [string, StoryReviewCitation] => {
    const citation = pool.get(id);
    if (citation === undefined)
      throw new StoryReviewModelCatalogError(
        `Story references citation ${id}, but the account projection carries no record`
      );
    return [id, citation];
  });
  return Object.fromEntries(entries);
}

function sortedRecord(input: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => codePointCompare(left, right))
  );
}

/**
 * Project the finalization composition into the canonical, TUI-facing model.
 * The join is by Part id: the authored Story supplies interpretation/act/
 * citations, the ownership fold supplies segments/ambiguity. When ownership is
 * degraded (parts === []) the authored Parts still render, context-only, and all
 * code lands in `residue` — the degraded case renders coherently by construction.
 */
export function projectStoryReviewModel(
  composed: ComposedStory,
  projection: AccountProjection
): StoryReviewModel {
  const ownershipByPart = new Map(composed.ownership.parts.map((p) => [p.partId, p]));
  const story = composed.story;
  if (
    projection.branch !== composed.branch ||
    projection.floor_input_hash !== composed.floor_input_hash
  )
    throw new StoryReviewModelProjectionError(
      'Story composition and account projection do not share branch/floor identity'
    );
  const projectedById = new Map(composed.merge.items.map((item) => [item.id, item]));
  const projectedIds = new Set(projectedById.keys());
  if (projectedIds.size !== composed.merge.items.length)
    throw new StoryReviewModelProjectionError('merged Story items contain duplicate identities');
  const requiredIds = new Set(composed.merge.mustDecide.map((item) => item.id));
  if (requiredIds.size !== composed.merge.mustDecide.length)
    throw new StoryReviewModelProjectionError(
      'must-decide Story items contain duplicate identities'
    );
  for (const required of composed.merge.mustDecide)
    if (!projectedIds.has(required.id))
      throw new StoryReviewModelProjectionError(
        `must-decide item ${required.id} has no projected finding or question`
      );
    else if (JSON.stringify(projectedById.get(required.id)) !== JSON.stringify(required))
      throw new StoryReviewModelProjectionError(
        `must-decide item ${required.id} changed identity during Story projection`
      );

  const parts: StoryReviewPart[] = (story?.parts ?? []).map((p): StoryReviewPart => {
    const own = ownershipByPart.get(p.id);
    const segments = own?.segments ?? [];
    return {
      id: p.id,
      title: p.title,
      act: p.act ?? null,
      checkpointRefs: [...p.checkpoint_refs],
      interpretation: p.interpretation,
      citations: [...p.citations],
      segments,
      ambiguous: own?.ambiguous ?? [],
      changedRows: own?.changedRows ?? 0,
      ambiguousRows: own?.ambiguousRows ?? 0,
      contextOnly: segments.length === 0,
    };
  });

  const acts: StoryReviewAct[] = (story?.acts ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    interpretation: a.interpretation ?? null,
    partIds: parts.filter((p) => p.act === a.id).map((p) => p.id),
  }));

  return {
    schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
    branch: composed.branch,
    floor_input_hash: composed.floor_input_hash,
    label: composed.ownership.label,
    banner: composed.ownership.banner,
    overview:
      story === null
        ? null
        : { text: story.overview.text, citations: [...story.overview.citations] },
    acts,
    parts,
    residue: {
      contested: composed.ownership.contested,
      unattributed: composed.ownership.unattributed,
      reviewableRows: composed.ownership.residue.reviewableRows,
      files: composed.ownership.residue.files,
    },
    metrics: composed.ownership.metrics,
    ledger: composed.ledger,
    uncertainties: composed.uncertainties,
    findings: findingsFromMerge(composed.merge.items, requiredIds),
    questions: questionsFromMerge(composed.merge.items, requiredIds),
    citations: buildCitationCatalog(composed, projection),
    artifactAliases: sortedRecord(projection.artifactAliases),
  };
}

// ---------------------------------------------------------------------------
// Round-trip — every Part's ranges must resolve against the run's diff.patch
// ---------------------------------------------------------------------------

export interface RangeResolution {
  ok: boolean;
  errors: string[];
}

/**
 * Prove every Part segment's add/del ranges land on real changed rows in the
 * unified diff. `add_range` is a new-file line range of ADD rows; `del_range` an
 * old-file line range of DELETE rows. Each line in the range must appear on the
 * matching side of the file's hunks. Any drift is reported (fail closed at
 * install; asserted by the round-trip test).
 */
export function resolvePartRangesAgainstDiff(
  model: Pick<StoryReviewModel, 'parts'>,
  diffText: string
): RangeResolution {
  const files = new Set<string>();
  for (const part of model.parts) for (const seg of part.segments) files.add(seg.file);
  const hunks = parsePatchHunks(diffText, files);

  const addByFile = new Map<string, Set<number>>();
  const delByFile = new Map<string, Set<number>>();
  const push = (map: Map<string, Set<number>>, file: string, line: number): void => {
    const set = map.get(file) ?? new Set<number>();
    set.add(line);
    map.set(file, set);
  };
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.side === 'add' && line.new !== null) push(addByFile, hunk.file, line.new);
      else if (line.side === 'delete' && line.old !== null) push(delByFile, hunk.file, line.old);
    }
  }

  const errors: string[] = [];
  const checkRange = (
    map: Map<string, Set<number>>,
    file: string,
    range: { start: number; end: number },
    side: 'add' | 'delete',
    partId: string,
    hunkKey: string
  ): void => {
    const set = map.get(file);
    for (let line = range.start; line <= range.end; line += 1) {
      if (set === undefined || !set.has(line)) {
        errors.push(
          `part ${partId} segment ${file}#${hunkKey}: ${side} line ${line} does not resolve to a changed row in diff.patch`
        );
      }
    }
  };

  for (const part of model.parts) {
    for (const seg of part.segments) {
      if (seg.add_range === null && seg.del_range === null) {
        errors.push(`part ${part.id} segment ${seg.file}#${seg.hunkKey}: no add or del range`);
        continue;
      }
      if (seg.add_range !== null)
        checkRange(addByFile, seg.file, seg.add_range, 'add', part.id, seg.hunkKey);
      if (seg.del_range !== null)
        checkRange(delByFile, seg.file, seg.del_range, 'delete', part.id, seg.hunkKey);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Install — validated, atomic, no partial states. NEXT TO the run dir.
// ---------------------------------------------------------------------------

export function serializeStoryReviewModel(model: StoryReviewModel): string {
  // Parse (fail closed) THEN serialize the validated value — the installed bytes
  // are always schema-valid by construction.
  const parsed = storyReviewModelSchema.parse(model);
  const canonical = {
    ...parsed,
    citations: Object.fromEntries(
      Object.entries(parsed.citations).sort(([left], [right]) => codePointCompare(left, right))
    ),
    artifactAliases: sortedRecord(parsed.artifactAliases),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** Domain-separated lifecycle content identity over canonical validated bytes. */
export async function storyReviewGeneration(model: StoryReviewModel): Promise<string> {
  return stableHash64('orcaops.review.story_generation.v1', [serializeStoryReviewModel(model)]);
}

/**
 * Validate + round-trip against the pinned diff, returning the BYTES to write.
 * Deliberately separate from the write: `performFinalize` produces four files,
 * and validating this one only at write time would leave the earlier three on
 * disk when it throws — a run that reports "not finalized" beside a
 * usable-looking review.md. Callers validate everything first, then write.
 */
export function serializeStoryReviewModelForInstall(input: {
  model: StoryReviewModel;
  diffText?: string;
}): string {
  const parsed = storyReviewModelSchema.parse(input.model) as StoryReviewModel;
  if (input.diffText !== undefined) {
    const resolution = resolvePartRangesAgainstDiff(parsed, input.diffText);
    if (!resolution.ok) {
      throw new StoryReviewModelRangeError(
        `story review model ranges do not resolve against diff.patch:\n${resolution.errors
          .slice(0, 8)
          .join('\n')}`
      );
    }
  }
  return serializeStoryReviewModel(parsed);
}

export async function installStoryReviewModel(input: {
  runDir: string;
  model: StoryReviewModel;
  diffText?: string;
}): Promise<void> {
  const bytes = serializeStoryReviewModelForInstall(input);
  await atomicWriteFile(path.join(input.runDir, STORY_REVIEW_MODEL_FILE), bytes);
}

/** Parse installed bytes strictly. Historical models are unsupported, never upgraded. */
export function parseStoryReviewModel(raw: unknown): StoryReviewModel {
  return storyReviewModelSchema.parse(raw) as StoryReviewModel;
}

export const sortedFiles = (files: Iterable<string>): string[] =>
  [...new Set(files)].sort(codePointCompare);
