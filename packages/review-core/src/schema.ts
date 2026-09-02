// Zod contracts for the on-disk review files.
//
//   floor.json      deterministic, machine-produced+consumed  → strict current schema
//   journal.ndjson  append-only reviewer events (dispositions + section states)
//   comments.ndjson append-only comment events (add / reply / status)
//
// Every file carries `schema_version`; the re-derivable files also carry
// `input_hash` so consumers can detect staleness.

import { z } from 'zod';

import {
  CITATION_KIND,
  COMMENT_AUTHOR,
  COMMENT_STATUS,
  COVERAGE_VERDICT,
  DIFF_SIDE,
  FINDING_DISPOSITION,
  LANDMARK,
  PROMPT_DISPOSITION,
  REVIEW_BASIS,
  REVIEW_COVERAGE_ACTION,
  THREAD_DISPOSITION,
  UNASSIGNED_INSPECTION_ACTION,
  UNCERTAINTY_DISPOSITION,
} from './enums.js';
import { isCitationId, parseCitationId } from './keys.js';

/**
 * On-disk schema version of `floor.json`. Bump on any breaking floor shape
 * change.
 *
 * Floor data is a regenerable cache, but reviewer state (journal and comments)
 * is not. Bump REVIEW_STATE_VERSION separately only when durable reviewer keys
 * move. Version 4 makes the current floor contract exact without changing any
 * key recipe, so v3 floors simply miss and rebuild while reviewer state stays.
 */
export const FLOOR_SCHEMA_VERSION = 4;
// ---------------------------------------------------------------------------
// Shared leaves
// ---------------------------------------------------------------------------

const nonEmptyString = z.string().min(1);
const isoDatetime = z.iso.datetime();

/** A `cite:` id validated against the grammar in `keys.ts`. */
export const citationIdSchema = nonEmptyString.refine(isCitationId, {
  message: 'malformed citation id',
});

/** A checkpoint member ref `{artifact, cp}` — the unit sections/owners key on. */
export const memberRefSchema = z.strictObject({
  artifact: nonEmptyString,
  cp: z.number().int().positive(),
});
export type MemberRef = z.infer<typeof memberRefSchema>;

/** A checkpoint owner ref — the asserted-ownership member of `ownerRefSchema`. */
export const checkpointOwnerRefSchema = z.strictObject({
  kind: z.literal('checkpoint'),
  artifact: nonEmptyString,
  cp: z.number().int().positive(),
});
/** A gap owner ref — an uncaptured window between checkpoint boundaries. */
export const gapOwnerRefSchema = z.strictObject({
  kind: z.literal('gap'),
  /** Human-readable gap identifier, e.g. `base->cp1.open` or `cp3.close->cp4.open`. */
  segment: nonEmptyString,
});

/** Attribution owner — a checkpoint, or an uncaptured gap segment. */
export const ownerRefSchema = z.discriminatedUnion('kind', [
  checkpointOwnerRefSchema,
  gapOwnerRefSchema,
]);
export type OwnerRef = z.infer<typeof ownerRefSchema>;

// Floor-mechanism enums (the attribution ladder + disclosure codes). These are
// implementation vocabulary for the deterministic floor, NOT part of the shared
// vocabulary contract, so they live here rather than in the verbatim `enums.ts`.

/** Active attribution rung — the degradation ladder, surfaced in the Trust band. */
export const ATTRIBUTION_RUNG = {
  SNAPSHOT_CHAIN: 'snapshot_chain',
  HASH_MATCH: 'hash_match',
  FILE_LEVEL: 'file_level',
  UNATTRIBUTED: 'unattributed',
} as const;
export type AttributionRung = (typeof ATTRIBUTION_RUNG)[keyof typeof ATTRIBUTION_RUNG];

/** Disclosure codes — seams surfaced loudly rather than hidden. */
export const DISCLOSURE_CODE = {
  MANIFESTLESS_CHECKPOINT: 'manifestless_checkpoint',
  TRUNCATED_MANIFEST: 'truncated_manifest',
  LIVE_DIFF_TRUNCATED: 'live_diff_truncated',
  /** Non-ignored untracked files omitted from the review tree by default. */
  UNTRACKED_EVIDENCE_EXCLUDED: 'untracked_evidence_excluded',
  /** Explicitly opted-in untracked files included in the review tree. */
  UNTRACKED_EVIDENCE_INCLUDED: 'untracked_evidence_included',
  /** Configured opt-ins rejected because they were ignored/generated or absent. */
  UNTRACKED_EVIDENCE_REJECTED: 'untracked_evidence_rejected',
  /** Opted-in untracked files the capture exclude set withheld from the review tree. */
  UNTRACKED_EVIDENCE_WITHHELD: 'untracked_evidence_withheld',
  INTEGRITY_MISMATCH: 'integrity_mismatch',
  /**
   * A manifest_hash IS recorded but the manifest could not be loaded or its
   * capture inputs cannot be reproduced — so integrity could not be CHECKED.
   * Deliberately distinct from INTEGRITY_MISMATCH (which asserts drift, i.e.
   * accuses the tree of having changed) and from MANIFESTLESS_CHECKPOINT (which
   * means none was ever captured). "I cannot tell" is its own answer.
   */
  INTEGRITY_UNAVAILABLE: 'integrity_unavailable',
  ATTRIBUTION_RUNG_DOWNGRADE: 'attribution_rung_downgrade',
  OVERLAP_DOWNGRADE: 'overlap_downgrade',
  ABANDONED_CHECKPOINT_EXCLUDED: 'abandoned_checkpoint_excluded',
  /** The reviewed branch appears already merged (merge-base tree == target tree); scope fell back. */
  DEGENERATE_SCOPE: 'degenerate_scope',
  /** A previously chosen explicit --base was reused (or found stale) on a bare rebuild. */
  STICKY_BASE_REUSED: 'sticky_base_reused',
  /** A single gap segment owns a large span outside the checkpoints' files — a likely branch import/rebase. */
  LARGE_UNCAPTURED_GAP: 'large_uncaptured_gap',
} as const;
export type DisclosureCode = (typeof DISCLOSURE_CODE)[keyof typeof DISCLOSURE_CODE];

// ---------------------------------------------------------------------------
// floor.json
// ---------------------------------------------------------------------------

export const floorScopeSchema = z.strictObject({
  branch: nonEmptyString,
  branch_slug: nonEmptyString,
  base_sha: nonEmptyString,
  pinned_tree_sha: nonEmptyString,
  /**
   * The worktree HEAD commit the floor was built against. The current producer
   * always writes it (nullable when unavailable). NOT part of the input hash —
   * it is a passive staleness probe: the TUI compares it against the live `git
   * rev-parse HEAD` to flag "the worktree moved since this review was built"
   * without minting a fresh tree object per tick.
   */
  head_sha: nonEmptyString.nullable(),
  default_branch: nonEmptyString.nullable(),
  artifact_ids: z.array(nonEmptyString),
  threads: z.array(
    z.strictObject({
      artifact: nonEmptyString,
      branch: nonEmptyString,
      label: nonEmptyString.nullable(),
      first_activity_at: isoDatetime.nullable(),
    })
  ),
});

/**
 * A reference to one slice of a parent hunk: the durable `hunkKey` plus the
 * NON-durable integer ordinal of the unit within that hunk's `units` array.
 * The derived display id is `sliceKey(hunkKey, slice)` (keys.ts) — never
 * persisted in durable reviewer records or installed Story models.
 */
export const sliceRefSchema = z.strictObject({
  hunkKey: nonEmptyString,
  slice: z.number().int().nonnegative(),
});
export type SliceRef = z.infer<typeof sliceRefSchema>;

/** A contiguous own-side line range covered by one slice (inclusive). */
const sliceRangeSchema = z.strictObject({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});
export type SliceRange = z.infer<typeof sliceRangeSchema>;

// Shared coordinate fields of an owned/gap slice: one maximal run of
// CONSECUTIVE changed patchRows sharing one owner. Context rows break the
// logical run (they are display-only padding), so a slice carries at most one
// delete range and one add range — a plain `-old/+new` modify block by one
// owner is ONE slice.
const sliceCoordFields = {
  /** Deterministic ordinal within the parent hunk, by first patchRow ascending. */
  slice: z.number().int().nonnegative(),
  /** 0-based row ordinals within the hunk body (context rows advance them). */
  patch_row_start: z.number().int().nonnegative(),
  patch_row_end: z.number().int().nonnegative(),
  /** Old-file line range of the run's delete rows (null when the run has none). */
  del_range: sliceRangeSchema.nullable(),
  /** New-file line range of the run's add rows (null when the run has none). */
  add_range: sliceRangeSchema.nullable(),
  /** Changed-row count of the run — context is never counted. */
  lines: z.number().int().positive(),
};

/**
 * The unit partition of a reviewable hunk's changed rows. Every reviewable
 * changed row belongs to exactly one unit:
 *   owned_slice     — a run owned by one checkpoint (asserted ownership)
 *   gap_slice       — a run owned by one uncaptured gap segment, or by nothing
 *                     (`owner: null` = blame could not resolve the row)
 *   ambiguous_hunk  — a whole hunk in a concurrent-overlap file: per-line
 *                     owners were downgraded, so candidates are EVIDENCE, not
 *                     asserted ownership, and the hunk is never owner-sliced
 */
export const reviewUnitSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('owned_slice'),
    ...sliceCoordFields,
    owner: checkpointOwnerRefSchema,
  }),
  z.strictObject({
    kind: z.literal('gap_slice'),
    ...sliceCoordFields,
    owner: gapOwnerRefSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('ambiguous_hunk'),
    /** Total changed rows of the hunk. */
    lines: z.number().int().nonnegative(),
    /** Unique owners observed within THIS hunk, sorted — evidence only. */
    candidates: z.array(ownerRefSchema),
  }),
]);
export type ReviewUnit = z.infer<typeof reviewUnitSchema>;

export const coverageItemSchema = z.strictObject({
  hunkKey: nonEmptyString,
  file: nonEmptyString,
  verdict: z.enum(COVERAGE_VERDICT),
  old_start: z.number().int().nonnegative().nullable(),
  new_start: z.number().int().nonnegative().nullable(),
  added_lines: z.number().int().nonnegative(),
  removed_lines: z.number().int().nonnegative(),
  /** The slice partition of this hunk's changed rows (empty for EXCLUDED/UNREVIEWABLE). */
  units: z.array(reviewUnitSchema),
});
export type CoverageItem = z.infer<typeof coverageItemSchema>;

export const coverageSummarySchema = z.strictObject({
  /** Hunk classifications: non-reviewable paths and binary/empty/misparsed hunks. */
  excluded: z.number().int().nonnegative(),
  unreviewable: z.number().int().nonnegative(),
  /** Row-grain counts over the unit partition: checkpoint-owned changed rows… */
  matched_rows: z.number().int().nonnegative(),
  /** …gap/unowned changed rows… */
  unexplained_rows: z.number().int().nonnegative(),
  /** …rows of concurrent-overlap ambiguous hunks (never a checkpoint's)… */
  ambiguous_rows: z.number().int().nonnegative(),
  /** …and their sum: every reviewable changed row, counted exactly once. */
  reviewable_rows: z.number().int().nonnegative(),
});
export type CoverageSummary = z.infer<typeof coverageSummarySchema>;

export const attributionLineSchema = z.strictObject({
  file: nonEmptyString,
  side: z.enum(DIFF_SIDE),
  line: z.number().int().positive(),
  owner: ownerRefSchema,
});
export type AttributionLine = z.infer<typeof attributionLineSchema>;

export const floorCheckpointSchema = z.strictObject({
  checkpointKey: nonEmptyString,
  order: z.number().int().positive(),
  checkpoint: z.strictObject({
    artifact: nonEmptyString,
    cp: z.number().int().positive(),
    label: nonEmptyString.nullable(),
  }),
  /** Verbatim checkpoint-close outcome; the label above is only its truncated first line. */
  summary: z.string().nullable(),
  members: z.array(memberRefSchema),
  /** The slices this checkpoint owns — a parent hunk may contribute slices to several checkpoints. */
  sliceRefs: z.array(sliceRefSchema),
  citationIds: z.array(citationIdSchema),
});

/**
 * A thread — one artifact's execution, and the unit reviewer coverage is keyed
 * by. `artifact` is carried explicitly: it makes the thread's identity
 * self-describing, since `threadKey` is derivable from it and from nothing
 * else.
 */
export const floorThreadSchema = z.strictObject({
  threadKey: nonEmptyString,
  order: z.number().int().positive(),
  title: nonEmptyString,
  artifact: nonEmptyString,
  checkpoints: z.array(floorCheckpointSchema),
});

/**
 * Unassigned work — everything without asserted single-checkpoint ownership,
 * in two bands: off-plan / gap-owned slices (incl. genuinely unowned rows),
 * and concurrent-window ambiguous hunks (rendered once, candidates as
 * evidence, never counted toward any checkpoint).
 */
export const unassignedWorkSchema = z.strictObject({
  gap: z.strictObject({
    sliceRefs: z.array(sliceRefSchema),
    files: z.array(
      z.strictObject({
        file: nonEmptyString,
        slice_count: z.number().int().nonnegative(),
        added_rows: z.number().int().nonnegative(),
        removed_rows: z.number().int().nonnegative(),
      })
    ),
  }),
  ambiguous: z.strictObject({
    hunkKeys: z.array(nonEmptyString),
    files: z.array(
      z.strictObject({
        file: nonEmptyString,
        hunk_count: z.number().int().nonnegative(),
        added: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
      })
    ),
  }),
});
export type UnassignedWork = z.infer<typeof unassignedWorkSchema>;

export const planCoverageEntrySchema = z.strictObject({
  artifact: nonEmptyString,
  step_id: nonEmptyString,
  label: z.string(),
  text: z.string(),
  order: z.number().int().nonnegative(),
  claimed_by: z.array(memberRefSchema),
  declared_by: z.array(memberRefSchema),
  unclaimed: z.boolean(),
});

const citationBase = {
  id: citationIdSchema,
  artifact: nonEmptyString,
  /** Verbatim text of the cited record. May be empty when the source field is. */
  text: z.string(),
};
const checkpointCitationBase = {
  ...citationBase,
  cp: z.number().int().positive(),
};

/**
 * Exact current citation variants. Checkpoint-scoped kinds require `cp`;
 * artifact-scoped kinds forbid it. Only structurally related kinds carry
 * `parent`, and evaluator provenance is present only on EVALUATOR_RUN.
 */
export const citationSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...checkpointCitationBase,
      kind: z.literal(CITATION_KIND.CHECKPOINT_DECISION),
    }),
    z.strictObject({
      ...checkpointCitationBase,
      kind: z.literal(CITATION_KIND.CHECKPOINT_UNCERTAINTY),
    }),
    z.strictObject({
      ...checkpointCitationBase,
      kind: z.literal(CITATION_KIND.CHECKPOINT_ALTERNATIVE),
      parent: citationIdSchema,
    }),
    z.strictObject({
      ...checkpointCitationBase,
      kind: z.literal(CITATION_KIND.CRITERION_EVIDENCE),
      // Evidence for a criterion dropped by a later plan revision still rides.
      parent: citationIdSchema.optional(),
    }),
    z.strictObject({
      ...checkpointCitationBase,
      kind: z.literal(CITATION_KIND.CHECKPOINT_VERIFICATION),
    }),
    z.strictObject({ ...citationBase, kind: z.literal(CITATION_KIND.PLAN_STEP) }),
    z.strictObject({ ...citationBase, kind: z.literal(CITATION_KIND.PLAN_NON_GOAL) }),
    z.strictObject({ ...citationBase, kind: z.literal(CITATION_KIND.PLAN_DECISION) }),
    z.strictObject({
      ...citationBase,
      kind: z.literal(CITATION_KIND.PLAN_ALTERNATIVE),
      parent: citationIdSchema,
    }),
    z.strictObject({
      ...citationBase,
      kind: z.literal(CITATION_KIND.ACCEPTANCE_CRITERION),
      parent: citationIdSchema,
    }),
    z.strictObject({ ...citationBase, kind: z.literal(CITATION_KIND.SUMMARY) }),
    z.strictObject({
      ...citationBase,
      kind: z.literal(CITATION_KIND.EVALUATOR_RUN),
      evaluator: z.strictObject({
        evaluator_ref: nonEmptyString,
        severity: z.enum(['info', 'warn', 'block']),
        run_status: z.enum(['completed', 'error', 'skipped']),
        verdict: z.enum(['pass', 'violation', 'info']).nullable(),
        disposition: z
          .enum(['unresolved', 'acknowledged', 'dismissed', 'policy-excepted'])
          .nullable(),
        summary: z.string(),
      }),
    }),
  ])
  .superRefine((citation, ctx) => {
    const id = parseCitationId(citation.id);
    if (
      id === null ||
      id.kind !== citation.kind ||
      id.artifact !== citation.artifact ||
      id.checkpointN !== ('cp' in citation ? citation.cp : null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'citation id must match kind, artifact, and checkpoint fields',
      });
    }

    if (!('parent' in citation) || citation.parent === undefined) return;
    const parent = parseCitationId(citation.parent);
    const expectedParent =
      citation.kind === CITATION_KIND.CHECKPOINT_ALTERNATIVE
        ? CITATION_KIND.CHECKPOINT_DECISION
        : citation.kind === CITATION_KIND.PLAN_ALTERNATIVE
          ? CITATION_KIND.PLAN_DECISION
          : citation.kind === CITATION_KIND.ACCEPTANCE_CRITERION
            ? CITATION_KIND.PLAN_STEP
            : CITATION_KIND.ACCEPTANCE_CRITERION;
    const expectedParentCheckpoint =
      citation.kind === CITATION_KIND.CRITERION_EVIDENCE
        ? null
        : 'cp' in citation
          ? citation.cp
          : null;
    if (
      parent === null ||
      parent.kind !== expectedParent ||
      parent.artifact !== citation.artifact ||
      parent.checkpointN !== expectedParentCheckpoint
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['parent'],
        message: `parent must be a same-scope ${expectedParent} citation`,
      });
    }
  });
type ExactCitation = z.infer<typeof citationSchema>;
type CitationEvaluator = Extract<
  ExactCitation,
  { kind: typeof CITATION_KIND.EVALUATOR_RUN }
>['evaluator'];

/**
 * Consumer-friendly view of the exact union. The optional common fields keep
 * generic citation traversals ergonomic; `citationSchema` still rejects them
 * on variants that do not own them.
 */
export type Citation = ExactCitation & {
  cp?: number | null;
  parent?: string;
  evaluator?: CitationEvaluator;
};

export const landmarkSchema = z.strictObject({
  kind: z.enum(LANDMARK),
  text: z.string(),
  ref: z
    .strictObject({
      artifact: nonEmptyString.optional(),
      cp: z.number().int().positive().optional(),
      file: nonEmptyString.optional(),
    })
    .optional(),
});

export const disclosureSchema = z.strictObject({
  code: z.enum(DISCLOSURE_CODE),
  message: z.string(),
  artifact: nonEmptyString.optional(),
  cp: z.number().int().positive().optional(),
});
export type Disclosure = z.infer<typeof disclosureSchema>;

export const floorSchema = z.strictObject({
  schema_version: z.literal(FLOOR_SCHEMA_VERSION),
  input_hash: nonEmptyString,
  generated_at: isoDatetime,
  scope: floorScopeSchema,
  coverage: z.strictObject({
    items: z.array(coverageItemSchema),
    summary: coverageSummarySchema,
  }),
  attribution: z.strictObject({
    active_rung: z.enum(ATTRIBUTION_RUNG),
  }),
  /**
   * Manifest integrity cross-check results, one per closed checkpoint the
   * sidecar could re-derive: verified true (reproduced) / false (drift — also
   * surfaced as an INTEGRITY_MISMATCH disclosure) / null (nothing captured to
   * compare).
   */
  integrity: z.array(
    z.strictObject({
      artifact: nonEmptyString,
      cp: z.number().int().positive(),
      verified: z.boolean().nullable(),
    })
  ),
  outline: z.strictObject({
    // NB: distinct from `scope.threads`, which is the artifact roster. These are
    // the reviewable threads, each with its checkpoints.
    threads: z.array(floorThreadSchema),
    unassigned: unassignedWorkSchema,
  }),
  plan_coverage: z.array(planCoverageEntrySchema),
  citations: z.array(citationSchema),
  landmarks: z.array(landmarkSchema),
  disclosure: z.array(disclosureSchema),
});
type ExactFloor = z.infer<typeof floorSchema>;
export type Floor = Omit<ExactFloor, 'citations'> & { citations: Citation[] };
export type FloorScope = z.infer<typeof floorScopeSchema>;
export type FloorThread = z.infer<typeof floorThreadSchema>;
export type FloorCheckpoint = z.infer<typeof floorCheckpointSchema>;
export type PlanCoverageEntry = z.infer<typeof planCoverageEntrySchema>;
export type LandmarkEntry = z.infer<typeof landmarkSchema>;

// ---------------------------------------------------------------------------
// journal.ndjson — append-only reviewer events
// ---------------------------------------------------------------------------

/**
 * One row of a mark-reviewed manifest — a RE-ANCHORABLE record of a changed
 * row the reviewer saw. Identity is content (`file`/`side`/`lineHash`);
 * `line` is a positional hint and `hunkKey` a disambiguation hint, both
 * unstable across re-floors and never part of identity.
 */
export const reviewedRowSchema = z.strictObject({
  file: nonEmptyString,
  side: z.enum(DIFF_SIDE),
  lineHash: nonEmptyString,
  line: z.number().int().positive(),
  hunkKey: nonEmptyString.optional(),
});
export type ReviewedRow = z.infer<typeof reviewedRowSchema>;

/** Engine-minted deterministic target admitted to the current review reader. */
export interface EligibleNarrativeTarget {
  targetKey: string;
  threadKey: string;
  anchor: {
    file: string;
    hunkKey: string;
    ranges: Array<{
      side: 'add' | 'delete';
      startLine: number;
      endLine: number;
      lineHashes: string[];
    }>;
  };
  checkpointRefs: MemberRef[];
}

/** Durable Unassigned identity: row content for gaps, parent hunk for ambiguity. */
export const unassignedInspectionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('GAP_ROWS'),
    coveredRows: z.array(reviewedRowSchema).min(1),
    coveredRowsDigest: nonEmptyString,
  }),
  z.strictObject({ kind: z.literal('AMBIGUOUS_HUNK'), hunkKey: nonEmptyString }),
]);
export type UnassignedInspectionTarget = z.infer<typeof unassignedInspectionTargetSchema>;

const threadJournalSchema = z.strictObject({
  type: z.literal('section'),
  ts: isoDatetime,
  threadKey: nonEmptyString,
  action: z.enum(THREAD_DISPOSITION),
  reason: nonEmptyString.optional(),
});

const findingJournalSchema = z.strictObject({
  type: z.literal('finding'),
  ts: isoDatetime,
  findingKey: nonEmptyString,
  action: z.enum(FINDING_DISPOSITION),
  reason: nonEmptyString.optional(),
});

const uncertaintyJournalSchema = z.strictObject({
  type: z.literal('uncertainty'),
  ts: isoDatetime,
  /** The uncertainty's citation id (`CHECKPOINT_UNCERTAINTY`). */
  citationId: citationIdSchema,
  action: z.enum(UNCERTAINTY_DISPOSITION),
  reason: nonEmptyString.optional(),
});

const promptJournalSchema = z.strictObject({
  type: z.literal('prompt'),
  ts: isoDatetime,
  promptKey: nonEmptyString,
  action: z.enum(PROMPT_DISPOSITION),
  reason: nonEmptyString.optional(),
});

const unassignedJournalSchema = z.strictObject({
  type: z.literal('unassigned'),
  ts: isoDatetime,
  action: z.literal(UNASSIGNED_INSPECTION_ACTION.MARK_INSPECTED),
  target: unassignedInspectionTargetSchema,
});

export const reviewCoverageThreadSchema = z
  .strictObject({
    threadKey: nonEmptyString,
    /** Cumulative, current content identities covered in this floor section. */
    coveredRows: z.array(reviewedRowSchema).min(1),
    coveredRowsDigest: nonEmptyString,
    /** Present only when this batch reaches full current-section coverage. */
    completedRows: z.array(reviewedRowSchema).min(1).optional(),
    completedRowsDigest: nonEmptyString.optional(),
  })
  .superRefine((entry, ctx) => {
    const hasRows = entry.completedRows !== undefined;
    const hasDigest = entry.completedRowsDigest !== undefined;
    if (hasRows !== hasDigest) {
      ctx.addIssue({
        code: 'custom',
        path: [hasRows ? 'completedRowsDigest' : 'completedRows'],
        message: 'completedRows and completedRowsDigest must appear together',
      });
    }
    if (
      entry.completedRowsDigest !== undefined &&
      entry.completedRowsDigest !== entry.coveredRowsDigest
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedRowsDigest'],
        message: 'a full-coverage milestone must snapshot the cumulative covered rows',
      });
    }
  });
export type ReviewCoverageThread = z.infer<typeof reviewCoverageThreadSchema>;

/** One durable, all-sections-or-none Part review action. */
export const reviewCoverageJournalSchema = z
  .strictObject({
    type: z.literal('review_coverage'),
    ts: isoDatetime,
    action: z.literal(REVIEW_COVERAGE_ACTION.RECORD_REVIEW_COVERAGE),
    floor_input_hash: nonEmptyString,
    /** Optimistic concurrency token for the journal state used to prepare this batch. */
    ledger_generation: nonEmptyString,
    threads: z.array(reviewCoverageThreadSchema).min(1),
  })
  .superRefine((event, ctx) => {
    const seen = new Set<string>();
    event.threads.forEach((entry, index) => {
      if (seen.has(entry.threadKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['threads', index, 'threadKey'],
          message: `threadKey ${entry.threadKey} appears more than once in one atomic batch`,
        });
      }
      seen.add(entry.threadKey);
    });
  });
export type ReviewCoverageJournalEvent = z.infer<typeof reviewCoverageJournalSchema>;

/**
 * The reviewer finishing (or reopening) the review.
 *
 * `review_basis` says which lens they actually read, and it is REQUIRED. The
 * floor-only basis is valid only when no current Story exists over the floor.
 *
 * The two fields are bound in BOTH directions (below). A `FLOOR_ONLY` event
 * carrying a generation is claiming a lens it did not read; a `STORY` event
 * without one is claiming a lens that cannot be checked for staleness. Neither
 * is a shape any honest writer produces, so neither is a shape we accept.
 */
export const reviewLifecycleJournalSchema = z
  .strictObject({
    type: z.literal('review_lifecycle'),
    ts: isoDatetime,
    action: z.enum({ COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', REOPEN: 'REOPEN' }),
    review_basis: z.enum(REVIEW_BASIS),
    floor_input_hash: nonEmptyString,
    /** The routine Story reviewed against. Null exactly under FLOOR_ONLY. */
    story_generation: nonEmptyString.nullable(),
    /** Optimistic concurrency token over every prior valid journal event. */
    ledger_generation: nonEmptyString,
    actor: z.literal('REVIEWER'),
    source: z.literal('WATCH'),
    remaining_work: nonEmptyString.optional(),
  })
  .superRefine((event, ctx) => {
    if (event.action === 'PARTIAL' && event.remaining_work === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['remaining_work'],
        message: 'PARTIAL requires a remaining-work note',
      });
    }
    if (event.action !== 'PARTIAL' && event.remaining_work !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['remaining_work'],
        message: 'remaining_work is valid only for PARTIAL',
      });
    }
    if (event.review_basis === REVIEW_BASIS.FLOOR_ONLY && event.story_generation !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['story_generation'],
        message: 'FLOOR_ONLY pins no Story generation — it read the floor',
      });
    }
    if (event.review_basis === REVIEW_BASIS.STORY && event.story_generation === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['story_generation'],
        message: 'STORY requires the Story generation it was reviewed against',
      });
    }
  });
export type ReviewLifecycleJournalEvent = z.infer<typeof reviewLifecycleJournalSchema>;

/**
 * A journal event. `SKIP`/`PARTIAL` (section) and `DISMISS` (finding) require a
 * reason in the reviewer's own words — enforced here so the gate is a schema
 * fact, not just UI logic.
 */
export const journalEventSchema = z
  .discriminatedUnion('type', [
    threadJournalSchema,
    findingJournalSchema,
    uncertaintyJournalSchema,
    promptJournalSchema,
    unassignedJournalSchema,
    reviewCoverageJournalSchema,
    reviewLifecycleJournalSchema,
  ])
  .superRefine((ev, ctx) => {
    const needsReason =
      (ev.type === 'section' &&
        (ev.action === THREAD_DISPOSITION.SKIP || ev.action === THREAD_DISPOSITION.PARTIAL)) ||
      (ev.type === 'finding' && ev.action === FINDING_DISPOSITION.DISMISS);
    const promptNeedsReason = ev.type === 'prompt' && ev.action === PROMPT_DISPOSITION.DISMISS;
    if ((needsReason || promptNeedsReason) && !ev.reason) {
      ctx.addIssue({ code: 'custom', message: `${ev.action} requires a reason`, path: ['reason'] });
    }
  });
export type JournalEvent = z.infer<typeof journalEventSchema>;

// ---------------------------------------------------------------------------
// comments.ndjson — append-only comment events + the replayed aggregate record
// ---------------------------------------------------------------------------

export const diffLineCommentAnchorSchema = z.strictObject({
  kind: z.literal('DIFF_LINE'),
  file: nonEmptyString,
  side: z.enum(DIFF_SIDE),
  line: z.number().int().positive(),
  lineHash: nonEmptyString,
  hunkKey: nonEmptyString.optional(),
  threadKey: nonEmptyString.optional(),
});

export const diffRangeCommentAnchorSchema = z
  .strictObject({
    kind: z.literal('DIFF_RANGE'),
    file: nonEmptyString,
    side: z.enum(DIFF_SIDE),
    line: z.number().int().positive(),
    endLine: z.number().int().positive(),
    lineHash: nonEmptyString,
    lineHashes: z.array(nonEmptyString).min(1),
    hunkKey: nonEmptyString.optional(),
    threadKey: nonEmptyString.optional(),
  })
  .superRefine((anchor, ctx) => {
    if (anchor.endLine < anchor.line) {
      ctx.addIssue({ code: 'custom', message: 'endLine must be >= line', path: ['endLine'] });
    }
    if (anchor.lineHashes[0] !== anchor.lineHash) {
      ctx.addIssue({
        code: 'custom',
        message: 'lineHashes[0] must equal lineHash',
        path: ['lineHashes'],
      });
    }
  });

export const unchangedContextLineCommentAnchorSchema = z.strictObject({
  kind: z.literal('UNCHANGED_CONTEXT_LINE'),
  file: nonEmptyString,
  headBlobOid: nonEmptyString,
  line: z.number().int().positive(),
  lineHash: nonEmptyString,
  symbol: nonEmptyString.optional(),
  threadKey: nonEmptyString.optional(),
});

/** Final authoring contract. No anchor kind is silently coerced into a diff line. */
export const commentAnchorSchema = z.discriminatedUnion('kind', [
  diffLineCommentAnchorSchema,
  diffRangeCommentAnchorSchema,
  unchangedContextLineCommentAnchorSchema,
]);
export type AuthorableCommentAnchor = z.infer<typeof commentAnchorSchema>;

/** Persisted and authorable comments use the same current anchor contract. */
export const persistedCommentAnchorSchema = commentAnchorSchema;
export type PersistedCommentAnchor = z.infer<typeof persistedCommentAnchorSchema>;
export type CommentAnchor = PersistedCommentAnchor;

const commentAddSchema = z.strictObject({
  type: z.literal('add'),
  comment_id: nonEmptyString,
  ts: isoDatetime,
  author: z.enum(COMMENT_AUTHOR),
  body: nonEmptyString,
  anchor: persistedCommentAnchorSchema,
});

const commentReplyEventSchema = z.strictObject({
  type: z.literal('reply'),
  comment_id: nonEmptyString,
  ts: isoDatetime,
  author: z.enum(COMMENT_AUTHOR),
  body: nonEmptyString,
  /** The checkpoint that answered the comment (agent replies under capture). */
  checkpoint_ref: memberRefSchema.optional(),
});

const commentStatusEventSchema = z.strictObject({
  type: z.literal('status'),
  comment_id: nonEmptyString,
  ts: isoDatetime,
  author: z.enum(COMMENT_AUTHOR),
  status: z.enum(COMMENT_STATUS),
});

export const commentEventSchema = z.discriminatedUnion('type', [
  commentAddSchema,
  commentReplyEventSchema,
  commentStatusEventSchema,
]);
export type CommentEvent = z.infer<typeof commentEventSchema>;

const commentReplySchema = z.object({
  ts: isoDatetime,
  author: z.enum(COMMENT_AUTHOR),
  body: nonEmptyString,
  checkpoint_ref: memberRefSchema.nullable().optional(),
});

/** The replayed comment record — what `review comments --json` emits. */
export const commentRecordSchema = z.object({
  comment_id: nonEmptyString,
  ts: isoDatetime,
  author: z.enum(COMMENT_AUTHOR),
  body: nonEmptyString,
  status: z.enum(COMMENT_STATUS),
  anchor: persistedCommentAnchorSchema,
  replies: z.array(commentReplySchema).default([]),
});
export type CommentRecord = z.infer<typeof commentRecordSchema>;
