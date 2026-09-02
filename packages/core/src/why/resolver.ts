import { z } from 'zod';

import {
  type CheckpointDecision,
  CheckpointDecisionSchema,
  type PlanDecision,
  PlanDecisionSchema,
  Store,
} from '@orcaops/storage';

import { Repo } from '../git/repo.js';

export type WhyConfidence = 'exact' | 'likely' | 'weak' | 'none';

export interface WhyMatch {
  artifact_id: string;
  branch: string;
  task: string;
  checkpoint_n: number;
  checkpoint_summary: string;
  checkpoint_head_sha: string;
  /** ISO timestamp of the checkpoint. */
  ts: string;
  confidence: WhyConfidence;
  /** Human-readable explanation of how the confidence was reached. */
  reason: string;
  /**
   * True when this match's line-hash evidence
   * came from a DIFFERENT file's hunks than the queried file — the same
   * content moved/copied across files. Labeling, not filtering:
   * cross-file evidence stays visible, explicitly, and never outranks a
   * same-file match within the same confidence tier (sort: tier →
   * same-file → recency).
   */
  cross_file: boolean;
  /**
   * The `source_event_id` of the plan revision this checkpoint opened against
   * (its as-of anchor). On the line path (`resolveWhy`) this is always a real
   * event id — a missing or unresolvable recorded revision fails the resolve
   * loudly with rebuild guidance. `plan_decisions` is
   * sliced to this revision.
   */
  open_plan_revision_event_id: string;
  /**
   * Plan-time decisions on the matched artifact, sliced AS-OF the revision this
   * checkpoint opened against (`open_plan_revision_event_id`) — each tagged with
   * the revision it was made at. A later `plan revise` does not leak a postdating
   * decision onto an earlier checkpoint. STRICT: a checkpoint whose recorded
   * open revision is missing or resolves to no cached plan revision fails the
   * whole resolve — never a silent fallback to the latest cumulative set.
   * Empty in whole-file mode (no line anchor, no slicing).
   */
  plan_decisions: PlanDecision[];
  /** Decisions recorded at the matched checkpoint's close. */
  checkpoint_decisions: CheckpointDecision[];
  /**
   * Window-overlap adjudication status for the queried file on
   * this checkpoint, when it sits in a concurrent window. Absent = clean (or no
   * overlap). Read-model only — never persisted, so hash-neutral. On the line
   * path the status also downgrades `confidence`; on the whole-file path
   * (already `weak`) it is annotation-only.
   */
  overlap?: 'ambiguous' | 'mixed_segment' | 'own_claim_pending';
  /** Present only for synthesized git-history artifacts. */
  origin?: { kind: 'git-import' };
  /**
   * `'unmerged_paths'`: the queried file was unmerged at one of this
   * checkpoint's boundaries — its hunks were excluded from the diff
   * fingerprint (`attribution_degraded`), so any attribution to this
   * checkpoint is degraded. `'probe_failed'`: the unmerged-index probe
   * failed at a boundary, so the exclusion set is unverified WINDOW-WIDE —
   * every file of this checkpoint may silently include conflicted paths.
   * On the line path the confidence also drops one tier; on the whole-file
   * path (already `weak`) it is annotation-only.
   */
  degraded?: 'unmerged_paths' | 'probe_failed';
}

export interface ResolveWhyOptions {
  repo: Repo;
  store: Store;
  /** Path relative to repo root, as it would appear in checkpoint.files_changed. */
  file: string;
  line: number;
  /** Optional branch filter — restrict to checkpoints on this branch. */
  branch?: string;
  /**
   * Optional line-membership probe: does this checkpoint's
   * fingerprint manifest contain the blamed line's exact content in its
   * `added_line_hashes`? `true` promotes the match to the top `exact`
   * tier with a distinct reason — authorship-grade, stronger than git
   * ancestry. `false`/`null` (no manifest, trivial line, probe error)
   * leaves the ancestry confidence untouched: absence of membership is
   * NOT disproof (the line may predate the manifest window or the
   * capture may have been truncated). The CLI supplies the probe from
   * `lineContentMatch` over stored/derive-cached manifests.
   *
   * The probe returns WHICH manifest files contained the
   * hash (`manifest_files`), not a bare boolean — the resolver needs to
   * distinguish same-file membership (authorship-grade promotion) from
   * cross-file membership (labeled `cross_file`, distinct reason).
   */
  lineContentProbe?: (
    artifactId: string,
    checkpointN: number
  ) => Promise<{ matched: boolean; manifest_files: string[] } | null>;
  /**
   * Window-overlap adjudication probe for the queried file.
   * 'ambiguous' / 'mixed_segment' → the checkpoint's evidence for this
   * file is WEAK (concurrent window): confidence downgrades one tier
   * with a distinct reason. 'own_claim_pending' → PROVISIONAL: the
   * attribution is likely right but the overlap group has not fully
   * closed; the tier stands, the pending state is reported in the
   * reason. Null = clean (or no overlap). The CLI supplies this from
   * the store's adjudication read model.
   */
  overlapStatusProbe?: (
    artifactId: string,
    checkpointN: number
  ) => Promise<'ambiguous' | 'mixed_segment' | 'own_claim_pending' | null>;
  /**
   * Unmerged-degradation probe for the queried file. `'unmerged'`: the
   * checkpoint's `attribution_degraded.unmerged_paths` names the file —
   * its hunks were excluded from the manifest at close, so a match can
   * rest only on ancestry/claims. `'probe_failed'`: the checkpoint's
   * record carries `probe_failed` and the file is NOT in the (possibly
   * empty) path list — the whole window is unverified, which taints every
   * file. Both downgrade one tier on the line path; whole-file annotates.
   * `'unmerged'` wins when both hold (file-specific beats window-wide).
   * The CLI supplies this from the checkpoint projection.
   */
  degradedStatusProbe?: (
    artifactId: string,
    checkpointN: number
  ) => Promise<'unmerged' | 'probe_failed' | null>;
}

export interface ResolveWhyResult {
  /** The single best match, or null when none. Highest-confidence wins; ties broken by recency. */
  best: WhyMatch | null;
  /** All candidate matches, sorted best-first. */
  all: WhyMatch[];
  /**
   * The blame commit SHA. Null when blame failed (file outside repo,
   * uncommitted line, etc.).
   */
  blame_sha: string | null;
}

/**
 * Resolve "who changed `<file>:<line>` and why" by walking
 *   git blame → checkpoints touching the file → ancestor relationship.
 *
 * Confidence:
 *   - `exact`  — the checkpoint's head_sha === blame_sha.
 *   - `likely` — the checkpoint's head_sha is an ancestor of blame_sha
 *                (the change landed under or before this checkpoint),
 *                OR the blame is a descendant of the artifact's
 *                base_sha and an ancestor of the checkpoint head
 *                (line authored within the artifact's working window).
 *   - `weak`   — the file appears in a checkpoint but no ancestor
 *                relationship can be established (blame failed, or the
 *                checkpoint head_sha isn't reachable), or the blame
 *                commit predates the artifact's base_sha (line
 *                existed before the artifact began work — the
 *                checkpoint touched the file but didn't author the
 *                line). Returned when no `exact`/`likely` match exists.
 *   - `none`   — no checkpoint touched the file at all.
 *
 * The `predates base_sha` guard closes a false-positive class: without
 * it, any line whose blame is an ancestor of cp.head_sha rates
 * `likely`, even when the line was authored *before* the artifact's
 * `plan.base_sha`. The artifact never modified the line — it just
 * touched the file later — so the attribution would be misleading.
 *
 * Pure read — never mutates the repo or store. Caller owns lifecycle.
 */
export async function resolveWhy(opts: ResolveWhyOptions): Promise<ResolveWhyResult> {
  const blameSha = await opts.repo.blameLine(opts.file, opts.line);
  const candidates = opts.store.findCheckpointsTouchingFile({
    file: opts.file,
    branch: opts.branch,
  });

  // Plan-time decisions, attributed AS-OF the revision each checkpoint opened
  // against (its `open_plan_revision_event_id`, projected to the
  // checkpoints row by the launch baseline schema). The per-revision plan row
  // already holds the cumulative decision set as it read at that revision, so
  // a later `plan revise` never leaks a postdating decision onto an earlier
  // checkpoint. STRICT: the recorded open revision resolves or the command
  // fails loudly — the same rule close-time validation and the cloud push
  // apply, so provenance can never silently misattribute decisions.
  // Memoized by (artifact, open-revision token); different cps of one
  // artifact can want different slices. resolveWhy gets the low-level Store
  // (the CLI passes ctx.store.store), so it reads plan revision rows directly.
  const planDecisionsCache = new Map<string, PlanDecision[]>();
  const planDecisionsFor = (
    artifactId: string,
    openPlanRevisionEventId: string
  ): PlanDecision[] => {
    const key = `${artifactId}\u0000${openPlanRevisionEventId}`;
    const cached = planDecisionsCache.get(key);
    if (cached) return cached;
    const match = opts.store
      .listPlanRevisions(artifactId)
      .find((r) => r.plan.source_event_id === openPlanRevisionEventId);
    if (!match) {
      throw new Error(
        `Checkpoint of artifact "${artifactId}" opened against plan revision ` +
          `event "${openPlanRevisionEventId}", which is missing from the ` +
          `cache — run \`orcaops rebuild\` and retry.`
      );
    }
    // Strict parse with rebuild guidance, matching the lineage columns:
    // a damaged cache row must fail actionably, not as a downstream
    // TypeError from an unchecked cast.
    let decisions: PlanDecision[];
    try {
      decisions = z.array(PlanDecisionSchema).parse(JSON.parse(match.plan.decisions));
    } catch (err) {
      throw new Error(
        `stored plan decisions for artifact "${artifactId}" fail the strict schema ` +
          `(${err instanceof Error ? err.message : String(err)}) — the SQLite cache is ` +
          `stale or damaged; run \`orcaops rebuild\` and retry.`
      );
    }
    planDecisionsCache.set(key, decisions);
    return decisions;
  };

  const matches: WhyMatch[] = [];
  for (const cp of candidates) {
    const openPlanRevisionEventId = requireOpenPlanRevisionEventId(cp);
    let confidence: WhyConfidence;
    let reason: string;

    if (blameSha === null) {
      confidence = 'weak';
      reason = `file overlap only (blame returned no commit for ${opts.file}:${opts.line})`;
    } else if (cp.head_sha === blameSha) {
      confidence = 'exact';
      reason = `checkpoint head_sha matches blame commit ${shortSha(blameSha)}`;
    } else if (await opts.repo.isAncestor(cp.head_sha, blameSha)) {
      // cp captured at HEAD A; the line was authored later at HEAD B (a
      // descendant of A). cp preceded the line; its files_changed
      // suggests this is the work-in-progress that culminated in the
      // line.
      confidence = 'likely';
      reason = `checkpoint head_sha ${shortSha(cp.head_sha)} is an ancestor of blame commit ${shortSha(blameSha)}`;
    } else if (await opts.repo.isAncestor(blameSha, cp.head_sha)) {
      // The reverse: line authored at HEAD B; cp captured later at HEAD
      // A (a descendant of B). The line existed when cp captured, and
      // cp's files_changed claims this file. Strong signal — UNLESS
      // the line predates the artifact's working window.
      //
      // The base_sha precondition: if blame is also an ancestor
      // of `plan.base_sha`, the line was committed before the artifact
      // even started. cp's files_changed only proves the file was
      // *touched* later, not that the artifact authored this line.
      // Demote to `weak` so the digest doesn't claim authorship of
      // pre-existing context.
      const predatesArtifact =
        cp.base_sha.length > 0 && (await opts.repo.isAncestor(blameSha, cp.base_sha));
      if (predatesArtifact) {
        confidence = 'weak';
        reason = `blame commit ${shortSha(blameSha)} predates the artifact's base_sha ${shortSha(cp.base_sha)}; checkpoint touched the file but the line is unchanged pre-existing context`;
      } else {
        confidence = 'likely';
        reason = `blame commit ${shortSha(blameSha)} is an ancestor of checkpoint head_sha ${shortSha(cp.head_sha)} (line existed when checkpoint captured this file)`;
      }
    } else {
      // No ancestor either way → parallel branches, unrelated history.
      confidence = 'weak';
      reason = `file changed in checkpoint but no ancestor relationship to blame commit ${shortSha(blameSha)} in either direction`;
    }

    // Line-hash tier: manifest membership of the line's exact
    // content outranks every ancestry signal — it is authorship of the
    // CONTENT, not proximity in history. Only a positive probe promotes;
    // false/null never demotes (see the option's docblock).
    //
    // Membership under a DIFFERENT file's hunks
    // is labeled `cross_file` with a distinct reason — same content
    // moved/copied across files is real evidence, kept visible, but the
    // final sort (tier → same-file → recency) keeps it from outranking
    // a same-file match in the same tier.
    let crossFile = false;
    if (opts.lineContentProbe !== undefined && confidence !== 'exact') {
      const member = await opts.lineContentProbe(cp.artifact_id, cp.n);
      if (member !== null && member.matched) {
        if (member.manifest_files.includes(opts.file)) {
          confidence = 'exact';
          reason =
            `line content hash matches this checkpoint's fingerprint manifest ` +
            `(added-line membership — authorship-grade, independent of git ancestry)`;
        } else {
          crossFile = true;
          confidence = 'exact';
          reason =
            `line content hash matches this checkpoint's fingerprint manifest under ` +
            `DIFFERENT file(s): ${member.manifest_files.join(', ')} — same content ` +
            `moved/copied across files (cross-file evidence, not same-file authorship)`;
        }
      }
    }

    // Overlap adjudication — applied AFTER every promotion,
    // because a concurrent window taints even a line-hash match (the
    // sibling's identical claim would produce the same membership).
    if (opts.overlapStatusProbe !== undefined) {
      const overlapStatus = await opts.overlapStatusProbe(cp.artifact_id, cp.n);
      if (overlapStatus === 'ambiguous' || overlapStatus === 'mixed_segment') {
        confidence = downgradeOneTier(confidence);
        reason = `${reason}; downgraded one tier: the file is ${overlapStatus === 'ambiguous' ? 'claimed by concurrent checkpoints (ambiguous)' : 'mixed exclusive/concurrent segment evidence (mixed_segment)'} under a window overlap`;
      } else if (overlapStatus === 'own_claim_pending') {
        reason =
          `${reason}; provisional: own-claim pending — an overlapping checkpoint window ` +
          `has not fully closed, attribution unconfirmed`;
      }
    }

    // Applied after every promotion, like the overlap downgrade: excluded
    // hunks (file-specific) or a failed probe (window-wide) mean whatever
    // supports this match, it is not exact-attribution-grade.
    let degraded: WhyMatch['degraded'];
    if (opts.degradedStatusProbe !== undefined) {
      const status = await opts.degradedStatusProbe(cp.artifact_id, cp.n);
      if (status === 'unmerged') {
        degraded = 'unmerged_paths';
        confidence = downgradeOneTier(confidence);
        reason =
          `${reason}; downgraded one tier: the file was unmerged at a boundary of this ` +
          `checkpoint — its hunks were excluded from the diff fingerprint (degraded attribution)`;
      } else if (status === 'probe_failed') {
        degraded = 'probe_failed';
        confidence = downgradeOneTier(confidence);
        reason =
          `${reason}; downgraded one tier: the unmerged-index probe failed at a boundary of ` +
          `this checkpoint — exclusion of conflicted paths could not be verified, window-wide`;
      }
    }

    matches.push({
      artifact_id: cp.artifact_id,
      branch: cp.branch,
      task: cp.task,
      checkpoint_n: cp.n,
      checkpoint_summary: cp.summary,
      checkpoint_head_sha: cp.head_sha,
      ts: cp.closed_at,
      confidence,
      reason,
      cross_file: crossFile,
      ...(degraded !== undefined ? { degraded } : {}),
      open_plan_revision_event_id: openPlanRevisionEventId,
      plan_decisions: planDecisionsFor(cp.artifact_id, openPlanRevisionEventId),
      checkpoint_decisions: parseCheckpointDecisions(cp.artifact_id, cp.decisions),
      ...(cp.origin_kind === 'git-import' ? { origin: { kind: 'git-import' as const } } : {}),
    });
  }

  // Sort: tier → same-file → recency. Cross-file evidence
  // never outranks a same-file match within the same confidence tier.
  const tier: Record<WhyConfidence, number> = { exact: 0, likely: 1, weak: 2, none: 3 };
  matches.sort((a, b) => {
    const t = tier[a.confidence] - tier[b.confidence];
    if (t !== 0) return t;
    const c = Number(a.cross_file) - Number(b.cross_file);
    if (c !== 0) return c;
    return b.ts.localeCompare(a.ts);
  });

  return {
    best: matches[0] ?? null,
    all: matches,
    blame_sha: blameSha,
  };
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** One-tier confidence downgrade for overlap-tainted files. */
function downgradeOneTier(confidence: WhyConfidence): WhyConfidence {
  if (confidence === 'exact') return 'likely';
  if (confidence === 'likely') return 'weak';
  return confidence;
}

/**
 * Whole-file mode (`orcaops why <file>` without a line):
 * aggregate every checkpoint that claimed the file, newest first. No
 * blame and no ancestry walk — there is no line to anchor them — so
 * every match is `weak` with an explicit whole-file reason; the caller
 * renders the aggregate, not an authorship claim. Pure read.
 */
export async function resolveWhyFile(
  opts: Omit<ResolveWhyOptions, 'line' | 'lineContentProbe'>
): Promise<ResolveWhyResult> {
  const candidates = opts.store.findCheckpointsTouchingFile({
    file: opts.file,
    branch: opts.branch,
  });

  const matches: WhyMatch[] = [];
  for (const cp of candidates) {
    const openPlanRevisionEventId = requireOpenPlanRevisionEventId(cp);
    let reason = 'whole-file mode: checkpoint claims this file in files_changed (no line anchor)';
    // Annotate (never downgrade — whole-file is already `weak`, so a tier
    // drop is a no-op) when the file sits in a concurrent window. Reuses the
    // same probe the line path is given.
    let overlap: WhyMatch['overlap'];
    if (opts.overlapStatusProbe !== undefined) {
      const status = await opts.overlapStatusProbe(cp.artifact_id, cp.n);
      if (status === 'ambiguous' || status === 'mixed_segment') {
        overlap = status;
        reason +=
          status === 'ambiguous'
            ? '; the file is claimed by concurrent checkpoints (ambiguous) under a window overlap — attribution unresolved'
            : '; mixed exclusive/concurrent segment evidence (mixed_segment) under a window overlap';
      } else if (status === 'own_claim_pending') {
        overlap = status;
        reason +=
          '; provisional: own-claim pending — an overlapping checkpoint window has not fully closed';
      }
    }
    // Whole-file claims SURVIVE the manifest filtering (files_changed is
    // self-report, not hunks), so a degraded path's claim would otherwise
    // render as normal attribution. Annotation-only — already `weak`.
    let degraded: WhyMatch['degraded'];
    if (opts.degradedStatusProbe !== undefined) {
      const status = await opts.degradedStatusProbe(cp.artifact_id, cp.n);
      if (status === 'unmerged') {
        degraded = 'unmerged_paths';
        reason +=
          '; the file was unmerged at a boundary of this checkpoint — its hunks were ' +
          'excluded from the diff fingerprint (degraded attribution)';
      } else if (status === 'probe_failed') {
        degraded = 'probe_failed';
        reason +=
          '; the unmerged-index probe failed at a boundary of this checkpoint — ' +
          'exclusion of conflicted paths could not be verified, window-wide';
      }
    }
    matches.push({
      artifact_id: cp.artifact_id,
      branch: cp.branch,
      task: cp.task,
      checkpoint_n: cp.n,
      checkpoint_summary: cp.summary,
      checkpoint_head_sha: cp.head_sha,
      ts: cp.closed_at,
      confidence: 'weak' as const,
      reason,
      cross_file: false,
      ...(degraded !== undefined ? { degraded } : {}),
      open_plan_revision_event_id: openPlanRevisionEventId,
      plan_decisions: [],
      checkpoint_decisions: parseCheckpointDecisions(cp.artifact_id, cp.decisions),
      ...(overlap ? { overlap } : {}),
      ...(cp.origin_kind === 'git-import' ? { origin: { kind: 'git-import' as const } } : {}),
    });
  }

  matches.sort((a, b) => b.ts.localeCompare(a.ts));
  return { best: matches[0] ?? null, all: matches, blame_sha: null };
}

function requireOpenPlanRevisionEventId(cp: {
  artifact_id: string;
  n: number;
  open_plan_revision_event_id: string | null;
}): string {
  if (cp.open_plan_revision_event_id === null) {
    throw new Error(
      `Checkpoint #${cp.n} of artifact "${cp.artifact_id}" has no recorded open-time ` +
        `plan revision. The cache is damaged; run \`orcaops rebuild\` and retry.`
    );
  }
  return cp.open_plan_revision_event_id;
}

/**
 * Strict parse for the SQLite checkpoint `decisions` column, with the
 * same stale-or-damaged-cache rebuild guidance as the plan columns — a
 * damaged row must fail actionably, never as a downstream TypeError.
 */
function parseCheckpointDecisions(artifactId: string, raw: unknown): CheckpointDecision[] {
  try {
    return z.array(CheckpointDecisionSchema).parse(raw);
  } catch (err) {
    throw new Error(
      `stored checkpoint decisions for artifact "${artifactId}" fail the strict schema ` +
        `(${err instanceof Error ? err.message : String(err)}) — the SQLite cache is ` +
        `stale or damaged; run \`orcaops rebuild\` and retry.`
    );
  }
}
