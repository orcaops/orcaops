import { z } from 'zod';

import { ArtifactOriginSchema } from './origin.js';
import { SourcePlanPinSchema } from './source-plan.js';

/**
 * Lifecycle state machine on artifacts.
 *
 *   planned ──capture-checkpoint──▶ active ──capture-summary──▶ summarized
 *      │                              │  ▲
 *      │                              │  │ block-cleared
 *      │                              ▼  │
 *      └─pre-pr-blocking──────────▶ blocked
 */
export const ArtifactStateSchema = z.enum(['planned', 'active', 'blocked', 'summarized']);
export type ArtifactState = z.infer<typeof ArtifactStateSchema>;

/**
 * Branch-lineage event kinds. `created` is stamped when capture-plan
 * first writes the artifact; `rebased` / `merged` are fired by
 * `orcaops lineage` after rebase / merge / squash.
 */
export const BranchLineageEventSchema = z.enum(['created', 'rebased', 'merged']);
export type BranchLineageEvent = z.infer<typeof BranchLineageEventSchema>;

export const BranchLineageEntrySchema = z.object({
  branch: z.string().min(1),
  head_sha: z.string().min(1),
  ts: z.string().datetime(),
  event: BranchLineageEventSchema,
});
export type BranchLineageEntry = z.infer<typeof BranchLineageEntrySchema>;

/**
 * Projection: the single source of truth for artifact-level metadata.
 * It is derived from the event log (`events.ndjson`) and rewritten on
 * every metadata-affecting event.
 *
 * `source_event_id` names the latest event applied to produce this
 * projection; readers compare it against the live event log to detect
 * stale projections (deterministic, never mtimes — see
 * `events/recovery.ts`).
 *
 * Every persisted projection is derived from at least the plan event.
 */
export const ArtifactJsonSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  state: ArtifactStateSchema,
  /**
   * Append-only history of branches the artifact has lived on. A single
   * `created` entry is stamped on capture-plan; `rebased` / `merged`
   * entries are added via `orcaops lineage`.
   */
  branch_lineage: z.array(BranchLineageEntrySchema).min(1),
  /**
   * Stamped from the agent CLI's session env var (e.g.,
   * `$CLAUDE_SESSION_ID`). Audit metadata only — never used to route
   * lookups (multi-session intent is the pin model's job).
   * Null when no session id is available (e.g., headless run).
   */
  created_by_session_id: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  checkpoint_count: z.number().int().min(0),
  /**
   * Number of plan revisions after the initial capture (i.e.,
   * `MAX(revision_n)` across all plan_captured / plan_revised events
   * for this artifact). 0 when only the initial plan_captured exists.
   */
  plan_revision_count: z.number().int().min(0),
  /**
   * ISO timestamp of the latest plan_revised event, or null when only
   * the initial plan_captured exists.
   */
  plan_last_revised_at: z.string().datetime().nullable(),
  /**
   * Latest event ID this projection was rebuilt from. Recovery-on-read
   * compares this to the latest metadata-affecting event in the event
   * log; mismatch → rebuild from events.
   */
  source_event_id: z.string().min(1),
  /**
   * Immutable pinned source plan, frozen from the
   * `--source-plan` ref at initial `capture plan` and projected here
   * set-once off the `plan_captured` event — a `plan_revised` never
   * touches it (freeze-at-capture). Null when the capture did not opt
   * in (the whole feature is opt-in). The conformance evaluator grades
   * the artifact's plan against this.
   */
  source_plan: SourcePlanPinSchema.nullable(),
  /**
   * HEAD sha recorded by the latest PASSING `pre_pr_checked` event, or
   * null if pre-pr has never passed. Paired with
   * `pre_pr_checked_source_event_id` to drive the advisory "pre-pr is
   * current" next-step hint: pre-pr is current only when BOTH match the
   * live HEAD and `source_event_id` (so a new commit OR any new event
   * re-opens the pre-pr suggestion). NOT a finalization signal —
   * `revisePlan` finalizes on `summary_captured` only.
   */
  pre_pr_checked_head_sha: z.string().nullable(),
  /**
   * `source_event_id` at the latest passing `pre_pr_checked` — set to
   * the event's own id, so it equals the projection's `source_event_id`
   * immediately after the pass and goes stale on the next event.
   * Null if pre-pr has never passed.
   */
  pre_pr_checked_source_event_id: z.string().min(1).nullable(),
  /**
   * Plan-time baseline tree — the pre-work worktree tree this artifact's
   * empty-fence recovery diffs from when there is no prior finalized
   * checkpoint to anchor on. Populated at `capture plan`; null when no seed
   * was captured.
   */
  baseline_seed_tree_sha: z.string().nullable(),
  /**
   * The artifact a confirmed `--source-plan` re-capture superseded: its
   * pre-work tree OVERRODE this artifact's plan-time
   * `baseline_seed_tree_sha`. Auditability of the supersession override.
   */
  superseded_artifact_id: z.string().nullable(),
  /** Optional-absent provenance for artifacts synthesized from git history. */
  origin: ArtifactOriginSchema.optional(),
});
export type ArtifactJson = z.infer<typeof ArtifactJsonSchema>;
