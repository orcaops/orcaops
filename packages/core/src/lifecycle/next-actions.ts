/**
 * Lifecycle next-step hints — the pure decision core.
 *
 * `nextActions(snapshot)` maps the current state of a capture artifact to
 * the *semantic* next steps an agent should consider. It is a pure function:
 * no I/O, no CLI syntax. The CLI renders these semantic actions into concrete
 * `orcaops …` command strings (see `apps/orcaops-cli/src/lib/next-actions-render.ts`).
 *
 * Foundational principle: **hints are advisory, not gates.** This function
 * expresses the recommended path through the lifecycle
 * (plan → checkpoint(s) → finish); it adds no enforcement.
 * The hard gates stay in storage (finalization on summary_captured, the
 * no-open-checkpoints gate, evaluator BLOCKED gates).
 */

/** Lifecycle verbs a hint can recommend. Mirrors the capture/block CLI surface. */
export type SemanticVerb =
  | 'checkpoint-open'
  | 'checkpoint-close'
  | 'checkpoint-abandon'
  | 'finish'
  | 'digest'
  | 'evaluator-rerun'
  | 'block-acknowledge'
  | 'block-dismiss';

/**
 * Phases that can produce a persisted lifecycle blocker. Policy violations
 * carry a disposition; evaluator errors require a successful phase rerun.
 * `checkpoint-open` is intentionally absent because open-phase failures are
 * pre-append rejections, handled from the command envelope rather than the
 * artifact snapshot.
 */
export type BlockPhase = 'checkpoint-close' | 'pre-pr' | 'post-plan' | 'post-plan-revision';

/**
 * A recommended next step in semantic form. The CLI renderer fills these into
 * command strings; `effect` is human-facing rationale rendered verbatim.
 */
export interface SemanticAction {
  verb: SemanticVerb;
  artifact_id: string;
  /** checkpoint-close/abandon target. */
  checkpoint_n?: number;
  /** checkpoint-open declared scope (uncovered steps); also the rejected scope on an open-retry. */
  step_ids?: string[];
  /** block-acknowledge / block-dismiss target. */
  evaluator_ref?: string;
  run_id?: string;
  evaluator_phase?: BlockPhase;
  /** Marks the pre-append checkpoint-open rejection remediation action. */
  retry_reason?: 'open-rejected';
  /** Blocked evaluator refs to seed a policy_exceptions[] skeleton on an open-retry. */
  policy_exception_refs?: string[];
  effect: string;
}

/** A persisted lifecycle blocker surfaced for remediation. */
export interface UnresolvedBlock {
  kind: 'violation' | 'error';
  evaluator_ref: string;
  run_id: string;
  phase: BlockPhase;
  checkpoint_n?: number;
  /**
   * Whether the evaluator opts into `acknowledge` resolution. Populated via an
   * injected lookup at snapshot-derivation/enrichment time; defaults to false
   * (dismiss-only) when discovery has not run.
   */
  acknowledge_enabled: boolean;
}

/** An in-flight (opened, not closed/abandoned) checkpoint. */
export interface OpenCheckpoint {
  n: number;
  declared_step_ids: string[];
}

/**
 * The minimal lifecycle state `nextActions` reasons over. Derived from the
 * store + repo by `deriveLifecycleSnapshot`; kept dependency-free here so the
 * decision logic is unit-testable in isolation.
 */
export interface LifecycleSnapshot {
  artifact_id: string;
  state: 'planned' | 'active' | 'blocked' | 'summarized';
  /** Current git HEAD sha. */
  current_head_sha: string;
  /** artifact.json `source_event_id` — the latest event applied to the projection. */
  artifact_source_event_id: string | null;
  /** HEAD sha recorded by the latest passing pre-pr (null if never passed). */
  pre_pr_checked_head_sha: string | null;
  /** source_event_id at the latest passing pre-pr (null if never passed). */
  pre_pr_checked_source_event_id: string | null;
  /** Whether a digest has been materialized. */
  digest_present: boolean;
  /** source_event_id the materialized digest was built from (null if absent). */
  digest_source_event_id: string | null;
  /** In-flight checkpoints (multiple allowed — subagent parallelism). */
  open_checkpoints: OpenCheckpoint[];
  /** Plan step_ids claimed by no closed cp and declared by no open cp. */
  uncovered_step_ids: string[];
  /** Every plan step is claimed by a closed cp (false when the plan has zero steps). */
  plan_coverage_complete: boolean;
  /** Persisted lifecycle blockers (checkpoint-open rejections excluded). */
  unresolved_blocks: UnresolvedBlock[];
  /**
   * True when the artifact has no checkpoints yet (none open, closed, or
   * abandoned) — the next open is the FIRST checkpoint. Lets the open hint
   * render the cadence-setting first-cp wording distinctly from the recurring
   * next-open string. Optional: only the production `deriveLifecycleSnapshot`
   * sets it; absent ⇒ treated as false (the recurring wording), so existing
   * snapshot fixtures need no change.
   */
  no_checkpoints_yet?: boolean;
  /** Usage fingerprint from the digest sidecar; null when absent or invalid. */
  digest_usage_fingerprint: string | null;
  /** Live usage fingerprint at snapshot time, compared to the cached one. */
  live_usage_fingerprint: string;
}

/**
 * pre-pr is "current" only if it passed against BOTH the current HEAD and the
 * current event-log state — so a new commit OR any new orcaops event makes it
 * stale and re-suggestable. (Full event-id staleness.)
 */
export function isPrePrCurrent(s: LifecycleSnapshot): boolean {
  return (
    s.pre_pr_checked_head_sha !== null &&
    s.pre_pr_checked_head_sha === s.current_head_sha &&
    s.pre_pr_checked_source_event_id !== null &&
    s.pre_pr_checked_source_event_id === s.artifact_source_event_id
  );
}

/**
 * A digest is "current" iff present and built from the latest event-log state.
 *
 * Staleness keys on the whole-log `source_event_id` (the coarse "any new event
 * ⇒ stale" rule, same as isPrePrCurrent). This is intentionally conservative: a
 * content-NEUTRAL event (branch_lineage_updated from sync, a repeated
 * pre_pr_checked, a superseded disposition) advances artifact_source_event_id
 * and flips this false, re-suggesting a regenerate of a byte-identical digest.
 * That cost is acceptable — the digest is regenerable and the hint is advisory.
 * The dangerous direction (a genuinely-stale digest reading as current) is
 * prevented at write time: writeDigest records the id from the SAME read that
 * built the content. A content-fingerprint staleness model would remove the
 * false re-nags, at the cost of a larger redesign.
 */
export function isDigestCurrent(s: LifecycleSnapshot): boolean {
  return (
    s.digest_present &&
    s.digest_source_event_id !== null &&
    s.digest_source_event_id === s.artifact_source_event_id &&
    typeof s.digest_usage_fingerprint === 'string' &&
    typeof s.live_usage_fingerprint === 'string' &&
    s.digest_usage_fingerprint === s.live_usage_fingerprint
  );
}

/**
 * Compute the recommended next steps for an artifact. Pure; order matters.
 *
 *   1. Blocked → per-block ack (if enabled) + dismiss. Short-circuits — a
 *      blocked artifact has no forward progress to suggest.
 *   2. Summarized → digest (if not current). Terminal otherwise.
 *   3. Open checkpoints → close each (never serialized — parallelism is fine).
 *   4. Uncovered steps → open a checkpoint (additive to step 3).
 *   5. Coverage complete, nothing open → finish.
 */
export function nextActions(s: LifecycleSnapshot): SemanticAction[] {
  const out: SemanticAction[] = [];

  // 1. Blocked dominates. Violations offer dispositions; evaluator errors can
  // only be cleared by rerunning the phase successfully.
  if (s.unresolved_blocks.length > 0) {
    for (const b of s.unresolved_blocks) {
      if (b.kind === 'error') {
        out.push({
          verb: 'evaluator-rerun',
          artifact_id: s.artifact_id,
          evaluator_ref: b.evaluator_ref,
          run_id: b.run_id,
          evaluator_phase: b.phase,
          checkpoint_n: b.checkpoint_n,
          effect:
            `${b.evaluator_ref} failed during ${b.phase} (run ${b.run_id}). ` +
            'Fix the evaluator or its environment and rerun the phase; infrastructure errors cannot be acknowledged or dismissed.',
        });
        continue;
      }
      if (b.acknowledge_enabled) {
        out.push({
          verb: 'block-acknowledge',
          artifact_id: s.artifact_id,
          evaluator_ref: b.evaluator_ref,
          run_id: b.run_id,
          effect: `Acknowledge the ${b.evaluator_ref} block (run ${b.run_id}) — accept the flagged finding with a reason.`,
        });
      }
      out.push({
        verb: 'block-dismiss',
        artifact_id: s.artifact_id,
        evaluator_ref: b.evaluator_ref,
        run_id: b.run_id,
        effect:
          `Dismiss the ${b.evaluator_ref} block (run ${b.run_id}) only if you disagree with the evaluator; ` +
          `otherwise fix the issue and re-run its ${b.phase} evaluators, then re-check.`,
      });
    }
    return out;
  }

  // 2. Summarized → digest (if stale/absent), else terminal.
  if (s.state === 'summarized') {
    if (!isDigestCurrent(s)) {
      out.push({
        verb: 'digest',
        artifact_id: s.artifact_id,
        effect: 'Summary captured — generate (or regenerate) the reviewer-facing digest.',
      });
    }
    return out;
  }

  // 3. Close in-flight checkpoints (one action per open cp; never serialized).
  for (const cp of s.open_checkpoints) {
    out.push({
      verb: 'checkpoint-close',
      artifact_id: s.artifact_id,
      checkpoint_n: cp.n,
      step_ids: cp.declared_step_ids,
      effect: `Close in-flight checkpoint ${cp.n} once its declared work is done — then open the next checkpoint before you change the worktree.`,
    });
  }

  // 4. Open a checkpoint on uncovered steps — additive to (3): a subagent can
  //    open new work while another cp is still closing.
  if (s.uncovered_step_ids.length > 0) {
    const ids = s.uncovered_step_ids;
    out.push({
      verb: 'checkpoint-open',
      artifact_id: s.artifact_id,
      // Unchanged semantic truth: the full uncovered set. The renderer decides
      // whether to pre-fill it (single step) or emit a choose-a-subset template
      // (multiple) — see next-actions-render.ts.
      step_ids: ids,
      // Every variant installs "open before you change the worktree": the
      // attribution window opens at `open`. The first-checkpoint case
      // (no_checkpoints_yet) carries the full cadence-setting consequence; the
      // recurring single/multi cases get the imperative + a compact window
      // reminder so the most-repeated strings don't become wallpaper. Multi
      // still tells the agent to declare a coherent subset, not the whole set.
      effect: s.no_checkpoints_yet
        ? `Open your FIRST checkpoint before you change the worktree. Declare the ` +
          `step(s) for your first coherent unit of work — opening first is the ` +
          `only reliable way to get clean per-line attribution; anything changed ` +
          `before open is outside that window.`
        : ids.length === 1
          ? `Open a checkpoint for the last uncovered step (${ids[0]}) before you ` +
            `change the worktree. (Changes before open fall outside the window.)`
          : `Open the next checkpoint before you change the worktree, over a ` +
            `COHERENT SUBSET of the ${ids.length} uncovered steps ` +
            `[${ids.join(', ')}] — declare only the steps that form one unit of ` +
            `work, not all of them. (Changes before open fall outside the window.)`,
    });
  }

  // Still mid-build → return the close/open suggestions.
  if (out.length > 0) return out;

  // 5. Everything covered and nothing open → the composite closing path.
  if (s.plan_coverage_complete) {
    out.push({
      verb: 'finish',
      artifact_id: s.artifact_id,
      effect: 'All plan steps are covered — run final checks and close the artifact.',
    });
    return out;
  }

  return out;
}
