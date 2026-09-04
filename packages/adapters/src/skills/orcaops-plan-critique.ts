import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * plan-critique — proactive plan review against captured history. Two paths:
 * the pre-plan prior-art sweep (cross-project when the archive is enabled,
 * current-repo otherwise — degradation is IN-BODY, this skill carries NO
 * `requires` and is present in the enabled set under EMPTY capabilities),
 * and critiquing a DRAFT plan against past decisions, fragility signals,
 * non-goals, abandoned attempts, and weak acceptance criteria. Drives ONLY
 * existing read commands — search, decisions, loose-ends, list --touching,
 * show.
 */
export const orcaopsPlanCritiqueSkill: SkillTemplate = {
  id: 'plan-critique',
  name: 'Orcaops: plan critique',
  description:
    'Before drafting or capturing a non-trivial coding plan, check prior Orcaops work for relevant decisions and risks. Also critique a plan draft against that history. Use for "critique this plan", "review this plan against earlier decisions", or "poke holes in this plan before I start". For history questions not tied to a plan, use captured-history lookup instead.',
  tags: ['orcaops', 'insight'],
  group: 'insight',
  defaultEnabled: true,
  blockTriggerLine: (prefix: string) =>
    `prior-art check before drafting or capturing a non-trivial plan, or critique of an existing plan ("critique this plan", "review this plan against earlier decisions", "poke holes in this plan before I start") → \`${skillRef('plan-critique', prefix)}\``,
  body: (prefix: string) => `# When to use

Triggers:

- As a PRE-STEP before \`orcaops capture plan\` on any non-trivial task
  (the capture skill references this sweep).
- "critique this plan", "review my plan draft", "poke holes in this
  plan before I start".

Skip when:

- The user is continuing an in-flight task → \`${skillRef('resume', prefix)}\`.
- Reviewing SHIPPED work rather than a plan → \`${skillRef('adversarial-review', prefix)}\`.
- The user only asks whether earlier work or decisions exist, without a plan to
  critique → \`${skillRef('search', prefix)}\`.

Both paths drive ONLY existing read commands — \`search\`, \`decisions\`,
\`loose-ends\`, \`list --touching\`, \`show\`. Nothing here writes.

Artifacts with \`origin.kind: git-import\` are synthesized prior art. Label every
one \`[imported]\`; use imported decisions only as evidence-cited paraphrases
and include the citation. Never imply that synthesized prose was captured live,
and attribute imported work to its commit authors rather than the current user
or agent.

# Path 1 — prior-art sweep (feeds a new capture)

Pick 2-4 content terms from the task (feature nouns, subsystem names,
error strings) and sweep captured history:

\`\`\`bash
orcaops search "<term>" --json
orcaops decisions --all-branches --json     # decision records with rationale
\`\`\`

**Cross-project mode:** when the archive is enabled
(\`archive.enabled: true\`), add \`--all-projects\` to BOTH commands to
sweep every archived project on this machine, not just this repo —
each hit carries a \`project\` field; cite it. From inside a repo or linked
worktree, the current project includes hot and retained archive history,
deduplicated by artifact ID with archive selected only when strictly newer
(ties use hot). Without the archive the same sweep runs current-repo-only —
say so and proceed; never block planning on missing history. \`orcaops show\`
remains current-repository-only, so use cross-project \`decisions\` and
\`loose-ends\` for detail from other projects.

What to inject into the new plan, from matching artifacts:

1. **Decisions with rejected alternatives** — the strongest signal: if a
   prior artifact rejected an approach with a reason, carry that into the
   new plan's \`decisions[]\` (as prior art) instead of re-litigating.
2. **Non-goals** — recurring exclusions usually still apply; propose them
   for the new plan's \`non_goals\`.
3. **Unresolved uncertainty** — a prior artifact's open uncertainty on the
   same scope is a risk the new plan should address or explicitly inherit.

Keep it to the 3-5 most relevant precedents; link each as
\`<artifact_id>\` (\`<project>/<artifact_id>\` cross-project). Then proceed
to \`${skillRef('capture', prefix)}\`.

# Path 2 — draft critique (a plan already exists)

Read the draft, then interrogate it against captured history — one pass
per lens, citations required:

1. **Contradicted decisions.** \`orcaops decisions --all-branches --json\` (replace with
   \`--all-projects\` when the archive is enabled): does any step reverse
   a recorded decision without saying why it no longer holds? Flag it —
   the fix is a new decision acknowledging the reversal, not silence.
2. **Fragile files.** For each file/subsystem the draft touches:
   \`orcaops list --touching <path> --json\` → artifacts that repeatedly
   touched it; \`orcaops show <id> --json\` for their uncertainty and
   evaluator violations. A file with recurring uncertainty or violations
   deserves an explicit risk line in the plan.
3. **Prior attempts.** Use \`orcaops search "<term>" --json\` and \`show\` to
   distinguish active, interrupted, abandoned, and unsummarized work. Only an
   explicitly abandoned checkpoint is a dead attempt; unsummarized work may
   still be in flight. Ask what stopped an abandoned attempt and whether the
   new plan addresses it.
4. **Non-goal drift.** Compare the draft against recurring \`non_goals\`
   in prior artifacts; a plan quietly re-including a recurring exclusion
   needs the exclusion's rationale addressed.
5. **Weak acceptance criteria.** \`orcaops loose-ends --all-branches --json\` shows what
   past plans left dangling. Steps whose criteria are vague ("works",
   "is clean") or missing produce exactly those dangles — propose
   concrete, checkable criteria.

Deliver each historical finding with an artifact and checkpoint or decision
citation. A defect visible directly in the draft may cite the draft section
instead. Give every finding a proposed plan edit; do not present unsupported
historical claims.`,
};
