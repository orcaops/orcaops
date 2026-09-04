import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * Opt-in insight skill: plan-time priors + post-hoc
 * calibration from captured plan shapes and the usage ledger. Enable
 * with `orcaops skills enable estimate` + `orcaops update`.
 */
export const orcaopsEstimateSkill: SkillTemplate = {
  id: 'estimate',
  name: 'Orcaops: estimate',
  description:
    'Estimate a task from similar captured work, step counts, checkpoints, and token use. Use for "how big is this task?", "what did similar work cost?", or "how did the estimate hold up?".',
  tags: ['orcaops', 'insight'],
  group: 'insight',
  defaultEnabled: false,
  blockTriggerLine: (prefix: string) =>
    `estimate from history ("what did similar work cost?") → \`${skillRef('estimate', prefix)}\``,
  body: (prefix: string) => `# When to use

Triggers (user phrasing):

- "estimate this", "how big is this task really?"
- "what did similar work take / cost last time?"
- after a plan lands: "how did the estimate hold up?" (calibration)

Skip when:

- The user wants period spend totals → \`orcaops usage --json\` directly.
- The user is still WRITING the plan → \`${skillRef('capture', prefix)}\`.

# How to invoke

\`\`\`bash
orcaops list --all-branches --json          # candidate priors (state, checkpoint_count)
orcaops show <id> --json                    # a prior's plan shape: steps, revisions, checkpoints
orcaops usage --artifact <id> --json        # that prior's attributed cost (ESTIMATE)
orcaops stats --json                        # repo-wide revision churn + duration percentiles
\`\`\`

# Building the estimate

1. Pick 2-4 PRIOR artifacts whose plan shape resembles the new task (similar
   step count, similar touched_scope). \`${skillRef('search', prefix)}\` helps find them by topic.
2. For each prior, report the observed shape: plan steps → checkpoints
   actually closed → plan revisions → attributed tokens (label the token
   number an ESTIMATE and quote the usage envelope's \`note\`; session totals
   are the exact figures).
3. Frame the estimate as a RANGE anchored to those priors ("plans of this
   shape ran 6-9 checkpoints and 1-2 revisions"), never a promise. Cite each
   anchor artifact id so the reader can audit.
4. Calibration pass (after delivery): compare the actual checkpoint count /
   revisions / tokens against what you predicted, and say which prior turned
   out to be the best analog — that sentence is the input to the NEXT
   estimate.

Uncertainty belongs in the output: if the priors disagree wildly, say so and
widen the range rather than averaging the disagreement away.`,
};
