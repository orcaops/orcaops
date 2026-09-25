// The continuing knowledge one surface puts beside the plan state it already shows.
//
// `show`, `digest`, `why`, Watch's detail pane and the review account lane each render a thread's
// own captures — steps, decisions, non-goals, criteria — and each used to say nothing at all about
// the rules that thread is answerable to. This is the block they put beside them, and it is the
// same block: one composer read, shaped once here, so four surfaces cannot print four different
// answers about one identity.
//
// Nothing here resolves anything. Standing, applicability and which correction is current are
// already decided in the composer's answer; this reduces that answer to what a surface renders and
// drops nothing a reader needs to see it is incomplete — the boundary, the coverage claim, the
// bounds that were spent, and the corrections dated after the boundary, kept apart from the body.
import type { Applicability, KnowledgeTarget, LaterKnowledgeRecord } from '@orcaops/storage';
import type {
  ProjectKnowledgeContext,
  ProjectKnowledgeInterpretation,
  RevisionGoverningStanding,
} from '@orcaops/storage/history/database';

import {
  type KnowledgeContextAnswer,
  knowledgeContextAnswer,
  type KnowledgeContextBasis,
  type KnowledgeContextBounds,
  type KnowledgeContextEntry,
  type KnowledgeContextLimit,
  type KnowledgeContextPlacement,
  type KnowledgeContextUse,
  revisionGoverns,
} from './answer.js';
import type { KnowledgeProcessingCoverage } from './coverage.js';
import {
  type ApplicableNotSelected,
  applicableNotSelected,
  type ApplicableNotSelectedPlan,
} from './selection.js';

export interface KnowledgeBlockRevision {
  revision_id: string;
  standing: RevisionGoverningStanding;
  /** Three-valued: an input nobody supplied leaves it unresolved, never waived. */
  applicability: Applicability;
  statement: string | null;
  rationale?: string | null;
  /** A revision no visible revision continues. A tip is not an adoption. */
  is_tip: boolean;
}

export interface KnowledgeBlockUse {
  artifact_id: string;
  plan_event_id: string;
  revision_id: string;
  role: string;
  step_id: string | null;
  criterion_id: string | null;
  /** Null for a use selected with its plan; set for one connected later. */
  discovered_at: string | null;
}

export interface KnowledgeBlockEntry {
  /** `<kind>:<entity id>` — how the reading orders below name an entry without repeating it. */
  key: string;
  target: KnowledgeTarget;
  placement: KnowledgeContextPlacement;
  /** Why it is placed there: the scope, the selector and the adoption, in one line. */
  reason: string;
  /** The revisions adopted at this boundary whose applicability this read does not rule out. */
  governing_revision_ids: readonly string[];
  /** The governing wording, or the newest this store holds when nothing governs. */
  statement: string | null;
  rationale?: string | null;
  /** Every revision visible at the boundary, superseded and withdrawn ones included. */
  revisions: readonly KnowledgeBlockRevision[];
  selected_with_plan: readonly KnowledgeBlockUse[];
  connected_later: readonly KnowledgeBlockUse[];
}

export interface KnowledgeBlockCoverage {
  /** Null where nothing read the processing state — never a shorthand for "fine". */
  processing: KnowledgeProcessingCoverage | null;
  /** What the surface prints. Present whatever the coverage is, so nothing prints silence. */
  statement: string;
}

export interface KnowledgeBlock {
  /** The question answered: the scope, the mode and the write sequence read at. */
  basis: KnowledgeContextBasis;
  entries: readonly KnowledgeBlockEntry[];
  interpretations?: readonly ProjectKnowledgeInterpretation[];
  /** Entry keys, adopted and applying at this boundary. */
  applicable: readonly string[];
  background: readonly string[];
  /** What applies here that the plan in view records no use of; never an unexplained empty list. */
  applicable_not_selected: ApplicableNotSelected;
  /** Records published after the boundary. Separately dated; never part of the body above. */
  later_annotations: readonly LaterKnowledgeRecord[];
  coverage: KnowledgeBlockCoverage;
  limits: readonly KnowledgeContextLimit[];
}

/**
 * What a read surface carries. A surface prints beside a thread, not instead of a lookup, so the
 * allowance is a page of statements over a handful of identities; `orcaops knowledge lookup
 * --limit` is where a reader asks for more. The bounds are spent in core, after placement, so an
 * adopted rule that applies here is never dropped while a background entry remains.
 */
export const SURFACE_KNOWLEDGE_BOUNDS: KnowledgeContextBounds = {
  maxEntries: 50,
  maxStatementBytes: 65_536,
};

const NO_PROCESSING_READ =
  'The processing state was not read here, so this answer claims no completeness. ' +
  '`orcaops knowledge status` is where that claim is made.';

const blockUse = (use: KnowledgeContextUse): KnowledgeBlockUse => ({
  artifact_id: use.artifact_id,
  plan_event_id: use.plan_event_id,
  revision_id: use.revision_id,
  role: use.role,
  step_id: use.step_id,
  criterion_id: use.criterion_id,
  discovered_at: use.discovered_at,
});

const governingOf = (entry: KnowledgeContextEntry) => entry.revisions.filter(revisionGoverns);

function blockEntry(entry: KnowledgeContextEntry): KnowledgeBlockEntry {
  const governing = governingOf(entry);
  // The governing wording first; failing that the newest this store holds, so an identity whose
  // adoption was withdrawn still reads as words rather than as an id with nothing behind it.
  const representative =
    governing.find((revision) => revision.statement !== null) ??
    [...entry.revisions].reverse().find((revision) => revision.statement !== null);
  return {
    key: entry.key,
    target: entry.target,
    placement: entry.placement,
    reason: entry.reason,
    governing_revision_ids: governing.map((revision) => revision.revision.revision_id),
    statement: representative?.statement ?? null,
    ...(representative?.rationale === undefined ? {} : { rationale: representative.rationale }),
    revisions: entry.revisions.map((revision) => ({
      revision_id: revision.revision.revision_id,
      standing: revision.standing,
      applicability: revision.applicability,
      statement: revision.statement,
      ...(revision.rationale === undefined ? {} : { rationale: revision.rationale }),
      is_tip: revision.is_tip,
    })),
    selected_with_plan: entry.selected_with_plan.map(blockUse),
    connected_later: entry.connected_later.map(blockUse),
  };
}

export interface KnowledgeBlockInput {
  /**
   * The processing coverage, from the one CLI function that derives the claim. Null for a surface
   * that read no processing state: a claim it has not earned is worse than none.
   */
  processing?: KnowledgeProcessingCoverage | null;
  /** The plan the not-selected diff is against. Null says so in words rather than in an empty list. */
  plan?: ApplicableNotSelectedPlan | null;
  bounds?: KnowledgeContextBounds;
}

/** The block from an answer a surface already holds, for a caller that composed its own. */
export function knowledgeBlockOf(
  answer: KnowledgeContextAnswer,
  input: KnowledgeBlockInput = {}
): KnowledgeBlock {
  const processing = input.processing ?? null;
  return {
    basis: answer.basis,
    entries: answer.entries.map(blockEntry),
    interpretations: answer.interpretations ?? [],
    applicable: answer.applicable,
    background: answer.background,
    applicable_not_selected: applicableNotSelected(answer, input.plan ?? null),
    later_annotations: answer.later_annotations,
    coverage: {
      processing,
      statement: processing === null ? NO_PROCESSING_READ : processing.statement,
    },
    limits: answer.limits,
  };
}

/**
 * The composer's parts as the block every read surface renders. One function, so `show`, `digest`,
 * `why`, Watch and the review account lane report one governing revision and one boundary for one
 * identity — and a surface that reduced the answer itself would be the second wording this exists
 * to prevent.
 */
export function knowledgeBlock(
  context: ProjectKnowledgeContext,
  input: KnowledgeBlockInput = {}
): KnowledgeBlock {
  return knowledgeBlockOf(
    knowledgeContextAnswer(
      context,
      input.processing ?? null,
      input.bounds ?? SURFACE_KNOWLEDGE_BOUNDS
    ),
    input
  );
}
