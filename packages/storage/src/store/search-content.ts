/**
 * Build the FTS search content for a plan revision.
 *
 * Shared by the live write paths (initial capture + revise in
 * `artifacts/store.ts`) and the disk rebuild path (`rebuild.ts`) so the three
 * stay in lockstep. The content leads `label · task · step-texts`; the label
 * must be indexed because it is the one field enrichment and revisions aim
 * intent-level wording at — without it an enriched imported artifact is
 * unfindable by its enriched name. `non-goals:` and `decisions:` segments are
 * appended only when present, so a plan with neither indexes byte-identically
 * to a plan with no non-goals and no decisions.
 *
 * Plan-time decisions are indexed (decision + reason + each rejected
 * alternative) so a reviewer can recall an artifact by a decision's wording or
 * the option it rejected — the cumulative set lives on the latest plan revision.
 */
export function buildPlanSearchContent(plan: {
  label: string;
  task: string;
  plan_steps: ReadonlyArray<{ text: string }>;
  non_goals: ReadonlyArray<{ text: string }>;
  decisions: ReadonlyArray<{
    decision: string;
    reason: string;
    alternatives_considered?: ReadonlyArray<{ option: string; rejected_because: string }>;
    evidence?: { kind: 'git-commit'; commit_sha: string; quote: string };
  }>;
}): string {
  const parts: string[] = [plan.label, plan.task, ...plan.plan_steps.map((s) => s.text)];
  if (plan.non_goals.length > 0) {
    parts.push(`non-goals: ${plan.non_goals.map((ng) => ng.text).join(' · ')}`);
  }
  if (plan.decisions.length > 0) {
    const decisionsText = plan.decisions
      .map((d) => {
        const alts = (d.alternatives_considered ?? [])
          .map((a) => `${a.option}: ${a.rejected_because}`)
          .join(' · ');
        const evidence = d.evidence
          ? `evidence: commit ${d.evidence.commit_sha} — ${d.evidence.quote}`
          : '';
        return [`${d.decision} — ${d.reason}`, alts, evidence].filter(Boolean).join(' · ');
      })
      .join(' · ');
    parts.push(`decisions: ${decisionsText}`);
  }
  return parts.join(' · ');
}
