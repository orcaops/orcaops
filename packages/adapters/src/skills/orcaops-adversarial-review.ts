import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * Review skill with two named dimensions.
 * CLAIMS AUDIT — the five signals (refute evidence, attack recorded
 * uncertainty, audit rubric lineage, check non-goal violations, sweep
 * for unaccounted work), with the sweep running BOTH
 * `diff --attribution --unattributed` (uncommitted work) AND
 * `diff --reconcile` (in-window commits). UNCERTAINTY-LED
 * CODE REVIEW — start where the agent said it was unsure, don't
 * re-flag documented decisions, DO flag silent divergence from them.
 * Default-enabled.
 */
export const orcaopsAdversarialReviewSkill: SkillTemplate = {
  id: 'adversarial-review',
  name: 'Orcaops: adversarial review',
  description:
    'Red-team completed work and its evidence. Use for "poke holes in this", "verify the done criteria", or "review the agent\'s code".',
  tags: ['orcaops', 'review'],
  group: 'review',
  defaultEnabled: true,
  blockTriggerLine: (prefix: string) =>
    `adversarial review ("red-team this PR", "poke holes in what the agent did") → \`${skillRef('adversarial-review', prefix)}\``,
  body: (prefix: string) => `# When to use

Triggers (user phrasing):

- "red-team this", "poke holes in this", "adversarial review"
- "verify the done criteria", "cross-examine what the agent did"
- "did the agent actually do what it claims?"

Skip when:

- The user wants the evaluator gate before a PR →
  \`${skillRef('pre-pr', prefix)}\` (deterministic policy checks, not cross-examination).
- The user wants a shareable summary → \`${skillRef('digest', prefix)}\`.

# Protocol

Read the full record first: \`orcaops show <artifact_id> --json\` (plan with
\`criterion_lineage\` + \`non_goals\`, closed checkpoints with
\`done_criteria\` / \`uncertainty\` / \`files_changed\` / \`decisions\`,
evaluator log). Then work the two dimensions ADVERSARIALLY — your job is
to refute, not to summarize.

# Dimension 1 — claims audit (five signals)

1. **Refute each \`done_criteria\` evidence entry.** Evidence is a CLAIM.
   For each criterion, try to disprove it against the working tree: run the
   cited test, open the cited file, re-derive the cited number. Verdict per
   criterion: **CONFIRMED** (you reproduced it), **UNVERIFIED** (cannot be
   checked from what was recorded — say what is missing), **REFUTED** (the
   evidence does not hold). A criterion with no evidence at all is UNVERIFIED.
2. **Attack each \`uncertainty[]\` entry first.** The agent itself flagged
   these as weak points — they are your highest-yield targets. For each one,
   determine whether the risk materialized, was mitigated, or is still open.
3. **Audit \`criterion_lineage\` for goalpost moves.** A criterion REWRITTEN
   or REMOVED after work started (compare revision timestamps to the first
   checkpoint open), without a rationale in the revision, is a goalpost
   move — flag it even when the shipped work satisfies the weakened rubric.
4. **Investigate possible non-goal violations.** Compare the latest plan's
   \`non_goals\` with every closed checkpoint's \`files_changed\`. Touching a
   related file is a reason to inspect the actual change, not proof that the
   excluded behavior was delivered. Flag a violation only when the diff shows
   that the non-goal itself was crossed.
5. **Sweep for unaccounted work — BOTH surfaces.** Uncommitted work:
   \`orcaops diff --attribution --unattributed --json\` (add
   \`--artifact <id>\` to scope). In-window COMMITS — invisible to the
   base→worktree sweep because their changes sit in both trees:
   \`orcaops diff --reconcile --json\` reports every commit inside the
   artifact window whose files no checkpoint claim or manifest covers
   (\`window.uncovered_commits\`), plus commits covered only by
   weak/ambiguous evidence (\`window.ambiguous_coverage_commits\`), and — for a
   SUMMARIZED artifact — commits after the last checkpoint close but before
   the summary as their own LOUD finding (\`pre_summary.uncovered_commits\`),
   distinct from genuinely-post-summary commits (the soft
   \`post_window_commits\` disclosure). Every unaccounted hunk or commit is
   potentially smuggled work — cross-examine each against the plan's declared
   scope. Ignore uncommitted \`.orcaops/\` config noise. Read each command's
   \`disclosure\` block BEFORE concluding: manifestless or truncated
   checkpoints mean absence of attribution is NOT proof of smuggling
   (verdict UNVERIFIED, not REFUTED), matching is exact-only — a rebase
   can orphan hunks — and reconcile's window runs base→last-close, extended
   to summary time for a summarized artifact: pre-summary commits are a
   finding, only the post-summary list is disclosure.

# Dimension 2 — uncertainty-led code review

Review the CODE the way the record says to — highest-yield spots first,
recorded intent respected. Depth scales with the ask: a quick pass reads
only the flagged spots; a deep review works every checkpoint's diff.

1. **Start from recorded uncertainty.** Each \`uncertainty[]\` entry names
   where the agent KNEW it was unsure — read that code first, looking for
   the concrete failure the worry implies (write the test that settles it
   when cheap).
2. **Don't re-flag documented decisions.** A recorded decision (plan or
   checkpoint) with its rationale is settled context — reviewing it again
   as if undecided wastes the record. Disagree? Say the decision no longer
   holds and why; route it as a NEW decision or plan revision, not a nit.
3. **DO flag silent divergence.** Code that contradicts a recorded
   decision without any new decision acknowledging the reversal is a
   finding even when the code is better — the record is now lying.
4. **Criteria-checked.** For each completed step, read its
   \`acceptance_criteria\` against the shipped diff — not just "does it
   work" but "does it do what the rubric says".

# Output

A findings table — one row per finding:
\`| # | target (criterion / uncertainty / lineage / non-goal / unattributed) | verdict | evidence |\`
— followed by remediation routing. For an active artifact, add a new obligation
through a valid plan revision and cover it with a new checkpoint. Never claim a
completed step again or rewrite criteria attached to completed work. For a
summarized artifact, capture remediation in a follow-up artifact. A goalpost
move needs a valid plan revision or restoration before completion; a confirmed
non-goal violation needs an acknowledged scope change or a revert. Record an
open uncertainty's resolution before finalization. Put unattributed work in a
new valid checkpoint when the active plan allows it, or revert it. Cite the attribution
\`disclosure\` block verbatim wherever it capped a verdict.`,
};
