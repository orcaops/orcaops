import { z } from 'zod';

import { CAPTURE_AGENT_IDS } from './config.js';
import { DecisionBaseSchema } from './decision.js';
import {
  CheckpointSnapshotBoundarySchema,
  DiffFingerprintSummarySchema,
} from './diff-fingerprint.js';
import { identifierText, proseText } from '../text/control-chars.js';

/**
 * A single done-criterion evidence entry. At checkpoint-close the agent
 * maps each plan-time `criterion_id` to free-text `evidence` of what was
 * delivered for it; `step-coverage` reads these as hints when grading the
 * diff. `evidence`
 * must be non-blank; `.strict()` rejects stray keys. Shared by the close
 * input (`capture-input.ts`) and the persisted closed checkpoint.
 */
export const DoneCriterionSchema = z
  .object({
    criterion_id: identifierText(),
    evidence: proseText(),
  })
  .strict();
export type DoneCriterion = z.infer<typeof DoneCriterionSchema>;

/**
 * One verified-close evidence entry: a command the agent ran
 * fresh at close time and its exit code — checkpoint-grain proof that
 * completion claims were exercised, persisted where transcript evidence
 * evaporates. Deliberately a SIBLING of `done_criteria`, never nested in
 * it: `DoneCriterionSchema` (and its wire/context mirrors) are strict,
 * and verification is per-checkpoint, not per-criterion. A non-zero
 * `exit_code` is valid — a cited failure is still honest evidence.
 */
export const VerificationEntrySchema = z
  .object({
    command: proseText(),
    exit_code: z.number().int(),
    /** Optional digest/tail of the command output (e.g. a test-count line). */
    output_digest: proseText(z.string().min(1)).optional(),
    /** What the run proves, when the command alone doesn't say. */
    note: proseText(z.string().min(1)).optional(),
  })
  .strict();
export type VerificationEntry = z.infer<typeof VerificationEntrySchema>;

/**
 * Two-phase checkpoint lifecycle (open → close | abandon). The schema is
 * a discriminated union on `status`. There is no legacy v1/v2 reader.
 * `schema_version: 4` is a clean break from v3 (no migration, no
 * forward-defaulting of missing v4 fields at rebuild time); v4 adds the checkpoint-fingerprint feature's snapshot
 * boundaries on every variant plus a fingerprint summary on closed.
 *
 * - open      — declared scope, work in flight. Carries `open_snapshot`.
 * - closed    — the open cp was finalized with summary, files_changed,
 *               decisions, uncertainty, completed_step_ids. Also carries
 *               `close_snapshot` (the worktree at close time) and
 *               `diff_fingerprint_summary` (hash-only projection of the
 *               open→close diff; the full manifest, when captured, lives
 *               in the close event payload's sidecar — see
 *               `packages/storage/src/events/rebuilders.ts`).
 * - abandoned — the open cp was cancelled before meaningful work.
 *               Carries `abandon_snapshot`.
 *
 * Step references are by stable UUIDv7 `step_id` (not ordinal index).
 * This makes checkpoints revision-stable: a plan revision that drops,
 * inserts, or reorders steps does NOT renumber the IDs already declared
 * or completed by an existing cp.
 *
 * `declared_step_ids` and `open_snapshot` are set at open and carried
 * forward into close and abandon projections by the rebuilders. Step
 * claims (used by resume's ☑/☐ and the post-close evaluator that fires
 * on `completed_step_ids`) only count `status === 'closed'` cps.
 */

/**
 * Checkpoint-close decision — the shared decision shape verbatim
 * (`{ decision, reason, alternatives_considered? }`). A LOCAL binding
 * (not a bare `export … from`) is required: this module references
 * `CheckpointDecisionSchema` below (the closed-cp `decisions` array and
 * its `z.infer`), and `capture-input.ts` imports it from here. Plan
 * decisions extend the same base with `revision_n` (see
 * `PlanDecisionSchema` in `decision.ts`).
 */
export const CheckpointDecisionSchema = DecisionBaseSchema;

export type CheckpointDecision = z.infer<typeof CheckpointDecisionSchema>;

/**
 * Inline policy-exception entry on `checkpoint open` payloads. Names an
 * evaluator and gives a free-form reason. The evaluator must set
 * `resolution.policy_exception.enabled: true`, otherwise the open is
 * rejected with `INVALID_INPUT` (the
 * "loud rejection" semantic — silent ignore would let agents think
 * they bypassed a block when they didn't).
 */
export const PolicyExceptionSchema = z.object({
  evaluator: identifierText(),
  reason: proseText(),
});

export type PolicyException = z.infer<typeof PolicyExceptionSchema>;

const CommonCheckpointFields = {
  schema_version: z.literal(4),
  artifact_id: z.string().min(1),
  n: z.number().int().positive(),
  /**
   * UUIDv7 step_ids (not ordinals) that this checkpoint declares it
   * will cover. Cannot overlap any other open cp's declared scope or
   * any closed cp's `completed_step_ids` (`OPEN_CP_OVERLAP`). Must
   * reference step_ids present in the plan revision active at open
   * time (validated against the plan_revision_id token).
   */
  declared_step_ids: z.array(z.string().min(1)).min(1),
  /**
   * Optional for the same hash-stability reason as `agent` below: the
   * open writer omits the key entirely when no session id was supplied,
   * and requiring it would change canonicalized bytes for every
   * existing sessionless checkpoint.
   */
  agent_session_id: z.string().min(1).optional(),
  /** Runtime-resolved invoking agent; headless writers persist `other`. */
  agent: z.enum(CAPTURE_AGENT_IDS),
  policy_exceptions: z.array(PolicyExceptionSchema),
  /**
   * Optimistic-concurrency token: the event_id of the latest plan
   * event (`plan_captured` or `plan_revised`) the agent saw when
   * opening. The runtime rejects with `STALE_PLAN_REVISION` if the
   * artifact has had a newer plan event committed since.
   *
   * Null permits the open to skip the freshness check (lower-friction
   * path for cold opens; the agent accepts any race).
   */
  plan_revision_id: z.string().min(1).nullable(),
  /**
   * Server-derived plan revision the checkpoint actually opened against —
   * the `source_event_id` of the latest plan event at open time, resolved
   * by the store from the event log. Unlike the
   * nullable caller-supplied `plan_revision_id` above (an optimistic
   * token the agent MAY pass), this is authoritative. Close-time
   * `done_criteria` are validated against THIS revision's acceptance
   * criteria, not the latest — so a later revise that removes/rewrites a
   * criterion can't retroactively invalidate honest evidence recorded
   * against the open-time rubric. REQUIRED non-null: a plan is mandatory
   * at open (the write path throws without one), so every launch-written
   * checkpoint carries a real revision id; absence is corruption.
   */
  open_plan_revision_event_id: z.string().min(1),
  opened_at: z.string().datetime(),
  head_sha: z.string().min(1),
  /**
   * Snapshot boundary captured at OPEN time — the worktree's tree SHA
   * pinned under `refs/orcaops/snap/<artifact>/<n>/open` by the
   * `captureCheckpointSnapshot` helper. Stored at every variant
   * (open / closed / abandoned) so the projection can answer "where
   * did this checkpoint start?" without re-walking the event log.
   *
   * All four fields are nullable to represent the deliberate-skip
   * case (caller did not opt into snapshot capture, all-null with
   * `snapshot_error_reason: null`) AND the captured-but-failed case
   * (caller did opt in but the helper returned a specific failure
   * reason like 'merge_conflict' or 'index_locked', which lands in
   * `snapshot_error_reason`). Fail-open: the cp lifecycle commits
   * either way.
   */
  open_snapshot: CheckpointSnapshotBoundarySchema,
};

export const OpenCheckpointSchema = z.object({
  ...CommonCheckpointFields,
  status: z.literal('open'),
  /** Event ID this projection was last rebuilt from; the writer always sets it. */
  source_event_id: z.string().min(1),
});

export type OpenCheckpoint = z.infer<typeof OpenCheckpointSchema>;

/**
 * A file identity under the claims partition. Dispositions are DUAL-PATH:
 * manifest hunks carry two path identities under
 * rename/delete (`file_before`/`file_after`), and every partition
 * record preserves both sides so the `fingerprint derive` replay
 * filters the same hunks under either path. At least one side is
 * non-null.
 */
export const WindowOverlapFileSchema = z.object({
  file_before: z.string().nullable(),
  file_after: z.string().nullable(),
});

export type WindowOverlapFile = z.infer<typeof WindowOverlapFileSchema>;

export const WindowOverlapDroppedFileSchema = z.object({
  file_before: z.string().nullable(),
  file_after: z.string().nullable(),
  /**
   * Why the file was removed from the persisted manifest:
   *  - 'sibling-claimed': a closed sibling's files_changed claims it and
   *    this cp has no positive ownership evidence for it.
   *  - 'sibling_pending': a potential owner was still open at close;
   *    resolves to sibling-claimed or unclaimed in the read model.
   *  - 'unclaimed': all siblings closed, nobody claimed it — surfaced
   *    loudly (an unclaimed hunk must never sit in any manifest).
   */
  status: z.enum(['sibling-claimed', 'sibling_pending', 'unclaimed']),
});

export type WindowOverlapDroppedFile = z.infer<typeof WindowOverlapDroppedFileSchema>;

/**
 * Segment-refined claims partition record, stamped on `checkpoint_closed`
 * when the cp's window overlapped a sibling's. OPTIONAL-ABSENT end-to-end
 * (the `verification` precedent above): the key is omitted from the event payload, rebuilder fold,
 * markdown, and this projection whenever no overlap was detected, so
 * `computeArtifactHash` stays byte-identical for every pre-existing
 * artifact and every non-overlapping close — zero spurious cloud
 * re-pushes. `schema_version` stays 4 (non-strict schemas, additive
 * optional key).
 *
 * The contract, structurally: close REMOVES a set (`dropped_files`,
 * replayed exactly by `fingerprint derive`) and KEEPS a set. The
 * kept-but-flagged sets (`ambiguous_files`, `mixed_segment`,
 * `own_claim_pending`) REMAIN in the hashable manifest; their downgrade
 * lives exclusively in the adjudication read model.
 */
export const WindowOverlapSchema = z.object({
  /** Within-artifact overlapping sibling checkpoint numbers, ascending. */
  siblings: z.array(z.number().int()),
  /**
   * Cross-artifact wall-clock overlap (best-effort by design —
   * timestamp ordering across logs is weaker than index order, which is
   * why cross-artifact gets claims-only, never segments).
   */
  cross_artifact_siblings: z.array(
    z.object({ artifact_id: z.string().min(1), n: z.number().int() })
  ),
  /**
   * True while any group member was still open at this close (or any
   * cross-artifact overlap exists — simultaneous closes can each see
   * the other as open-with-no-claims, so cross-artifact NEVER finalizes
   * at close). Final classification folds in the adjudication read
   * model once every member's close has landed.
   */
  pending: z.boolean(),
  /** REMOVED from the persisted manifest; the derive replay's exact filter set. */
  dropped_files: z.array(WindowOverlapDroppedFileSchema),
  /**
   * Own files_changed entries contradicted by segment evidence (the
   * file changed only while this cp wasn't open) — never honored as
   * attribution claims.
   */
  rejected_claims: z.array(z.string()),
  /** Claimed by this cp AND a sibling in a concurrent segment — kept in BOTH manifests, flagged. */
  ambiguous_files: z.array(WindowOverlapFileSchema),
  /**
   * Changed in BOTH an exclusive-this-cp segment AND a concurrent
   * segment — kept on EVIDENCE (segment proof outranks self-report),
   * downgraded in the read model: file-level segment evidence cannot
   * split the whole-window hunk set between the exclusive and
   * concurrent portions.
   */
  mixed_segment: z.array(WindowOverlapFileSchema),
  /**
   * In this cp's claim while an overlapping cp was still open — KEPT
   * (removing an own-claimed file under uncertainty would permanently
   * destroy hunk evidence the append-only log can never restore),
   * provisional until siblings close: no sibling claim → lifts to
   * clean; a later sibling claim → ambiguity recorded on that later
   * close, no rewrites here.
   */
  own_claim_pending: z.array(WindowOverlapFileSchema),
  /**
   * Files kept purely on exclusive-segment evidence with NO
   * self-report — the agent forgot to claim them, the boundary trees
   * prove them.
   */
  segment_attributed: z.array(z.string()),
  /**
   * Finalized at the LAST close of the group (empty otherwise): files
   * changed in the overlap window that no member claimed or
   * segment-attributed — the same class of finding as
   * `diff --reconcile` uncovered commits. Surfaced loudly.
   */
  unattributed_in_window: z.array(z.string()),
  /** Disclosed degradations (never silent): e.g. 'missing_boundary_tree:2-3', 'cross_artifact_claims_only'. */
  degradations: z.array(z.string()),
});

export type WindowOverlap = z.infer<typeof WindowOverlapSchema>;

/**
 * Degraded-attribution disclosure for a close whose window touched an
 * unmerged git index. `unmerged_paths` is the sorted unique UNION of paths
 * unmerged at the open or close boundary; their hunks are physically
 * removed from the persisted manifest at close (`applyUnmergedExclusion`),
 * and derive consumers replay the removal via
 * `replayAttributionDegradedRemovals`. `probe_failed` marks a window where
 * the `ls-files -u` probe itself failed at either boundary: the exclusion
 * set is empty-by-default, NOT verified-clean, so the window's attribution
 * is unverified (read surfaces downgrade window-wide). The refinement keeps
 * the record meaningful — a non-empty union, a failed probe, or both;
 * never neither. LOCALLY OWNED — the vendored boundary schema cannot
 * represent "succeeded but degraded" (a non-null snapshot_error_reason
 * forces all sha fields null), so the boundary stays a plain success and
 * this record carries the degradation.
 *
 * FORWARD-ONLY READ. `unmerged_paths` used to be `.min(1)`, so a
 * `probe_failed`-only record (empty paths) is REJECTED by any orcaops
 * predating that field — and because this schema is embedded in
 * `ClosedCheckpointSchema`, the rejection drops the WHOLE artifact from an
 * older reader's cache (`show` errors, `why` loses provenance). Deliberate:
 * widening the existing record keeps one canonical degradation channel and
 * one conditional-spread path, instead of a second optional-absent key
 * mirrored across the rebuilder / markdown / digest / review sites. The
 * trade lands only on a rare failed probe read by an OLDER binary; same-or-
 * newer readers are unaffected, and the newer binary re-reads the event log
 * fine. Anything added here later must weigh that same
 * old-reader-compatibility cost.
 */
export const AttributionDegradedSchema = z
  .object({
    unmerged_paths: z.array(z.string().min(1)),
    probe_failed: z.literal(true).optional(),
  })
  .refine((r) => r.unmerged_paths.length > 0 || r.probe_failed === true, {
    message: 'attribution_degraded requires a non-empty unmerged_paths or probe_failed: true',
  });

export type AttributionDegraded = z.infer<typeof AttributionDegradedSchema>;

export const ClosedCheckpointSchema = z.object({
  ...CommonCheckpointFields,
  status: z.literal('closed'),
  /** Repo HEAD recorded by the matching checkpoint_opened event. Optional for legacy projections. */
  open_head_sha: z.string().min(1).optional(),
  closed_at: z.string().datetime(),
  /** The invoking agent at close; may differ from the open-time agent. */
  closed_by_agent: z.enum(CAPTURE_AGENT_IDS),
  summary: z.string().min(1),
  files_changed: z.array(z.string()),
  decisions: z.array(CheckpointDecisionSchema),
  uncertainty: z.array(z.string()),
  done_criteria: z.array(DoneCriterionSchema),
  /**
   * Verified-close evidence. OPTIONAL-ABSENT, not `.default([])`: the key
   * is omitted end-to-end (event payload, both
   * replay shapes, rebuilder fold, markdown, this projection) when no
   * verification was cited, so `computeArtifactHash` stays byte-identical
   * for every pre-existing artifact and every verification-less close —
   * zero spurious cloud re-pushes. Mirrors the hash.ts conditional-spread
   * precedent, NOT the `?? []` pattern used for pre-defaulted fields.
   */
  verification: z.array(VerificationEntrySchema).optional(),
  /**
   * Segment-refined claims partition record. OPTIONAL-ABSENT with
   * conditional spread end-to-end — same hash-stability contract as
   * `verification` above: present ONLY when this close detected a window
   * overlap; a defaulted key would churn every existing artifact's
   * `computeArtifactHash` and trigger spurious cloud re-pushes.
   */
  window_overlap: WindowOverlapSchema.optional(),
  /**
   * Unmerged-index degradation record. OPTIONAL-ABSENT with conditional
   * spread end-to-end — same hash-stability contract as `verification` /
   * `window_overlap` above: present when the open∪close unmerged union was
   * non-empty OR the `ls-files -u` probe failed at a boundary; a defaulted
   * key would churn every existing artifact's `computeArtifactHash`.
   */
  attribution_degraded: AttributionDegradedSchema.optional(),
  /**
   * UUIDv7 step_ids (subset of `declared_step_ids`) claimed by this
   * checkpoint. Agents may discover scope mid-step; declared-but-not-
   * completed step_ids silently fall through and may be claimed by a
   * follow-up cp.
   */
  completed_step_ids: z.array(z.string().min(1)),
  /**
   * Snapshot boundary captured at CLOSE time — the worktree's tree SHA
   * pinned under `refs/orcaops/snap/<artifact>/<n>/close`. Together
   * with `open_snapshot`, this forms the pair of tree SHAs that the
   * close-time diff is computed against by `diffSnapshotTrees`. Fail-open
   * semantics identical to `open_snapshot`.
   */
  close_snapshot: CheckpointSnapshotBoundarySchema,
  /**
   * Hash-only projection of the open→close diff (status + counts +
   * algorithm identifiers + manifest_hash). The full
   * `DiffFingerprintManifest` (when captured) lives in the
   * `checkpoint_closed` event payload's `diff_fingerprint_manifest`
   * field, which spills to a sidecar past the 8 KB inline budget. The
   * projection summary alone is the source of truth for cloud sync's
   * `computeArtifactHash` and for downstream digest rendering.
   *
   * The `status` field distinguishes captured / empty / truncated /
   * skipped; `error_reason` distinguishes the deliberate-skip case
   * (null) from real failures (a concrete `DiffFingerprintFailureReason`).
   */
  diff_fingerprint_summary: DiffFingerprintSummarySchema,
  /**
   * Pointer back to the matching `checkpoint_opened` and the
   * `checkpoint_closed` event_ids. Lets readers reconstruct the
   * lifecycle without re-walking the log.
   */
  source_event_ids: z.object({
    opened: z.string().min(1),
    closed: z.string().min(1),
  }),
  /** Latest event_id this projection was rebuilt from (the close). */
  source_event_id: z.string().min(1),
});

export type ClosedCheckpoint = z.infer<typeof ClosedCheckpointSchema>;

export const AbandonedCheckpointSchema = z.object({
  ...CommonCheckpointFields,
  status: z.literal('abandoned'),
  abandoned_at: z.string().datetime(),
  /** The invoking agent at abandon. */
  abandoned_by_agent: z.enum(CAPTURE_AGENT_IDS),
  reason: z.string().min(1),
  /**
   * Snapshot boundary captured at ABANDON time. No fingerprint manifest
   * is built for abandoned cps in v1 — the tree boundary is captured for
   * parity with open/close, but the cloud-side matcher does not yet model
   * abandoned hunks. Fail-open semantics identical to `open_snapshot`.
   */
  abandon_snapshot: CheckpointSnapshotBoundarySchema,
  source_event_ids: z.object({
    opened: z.string().min(1),
    abandoned: z.string().min(1),
  }),
  source_event_id: z.string().min(1),
});

export type AbandonedCheckpoint = z.infer<typeof AbandonedCheckpointSchema>;

export const CheckpointSchema = z.discriminatedUnion('status', [
  OpenCheckpointSchema,
  ClosedCheckpointSchema,
  AbandonedCheckpointSchema,
]);

export type Checkpoint = z.infer<typeof CheckpointSchema>;
