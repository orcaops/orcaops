import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * Opt-in insight skill: mine captured uncertainty +
 * evaluator verdicts into growth-log lessons and candidate evaluator
 * ideas. Enable with `orcaops skills enable lessons` +
 * `orcaops update`.
 */
export const orcaopsLessonsSkill: SkillTemplate = {
  id: 'lessons',
  name: 'Orcaops: lessons',
  description:
    'Turn captured uncertainty, failures, and open items into lessons and possible new checks. Use for "what should I do differently?", "what keeps going wrong?", or "lessons learned from this work".',
  tags: ['orcaops', 'insight'],
  group: 'insight',
  defaultEnabled: false,
  blockTriggerLine: (prefix: string) =>
    `lessons learned ("what should I do differently next time?") → \`${skillRef('lessons', prefix)}\``,
  body: (prefix: string) => `# When to use

Triggers (user phrasing):

- "lessons learned from this sprint / artifact"
- "what should I do differently?", "what keeps going wrong?"

Skip when:

- The user wants raw numbers only → \`orcaops stats --json\` /
  \`orcaops usage --json\` directly (quote them verbatim, never recompute).
- The user wants the open-items sweep → \`${skillRef('loose-ends', prefix)}\`.

# How to invoke

\`\`\`bash
orcaops stats --json                 # evaluators.by_evaluator: where violations cluster
orcaops show <id> --json             # per artifact: uncertainty[] + evaluator log side by side
orcaops search "<recurring theme>" --json   # find the same worry across artifacts
\`\`\`

# Mining the lessons

1. **Uncertainty → outcome:** for each recorded \`uncertainty[]\` entry, ask
   what happened to it — did a later checkpoint, evaluator violation, or
   summary open_item land on the SAME surface? A worry that came true is a
   lesson; a worry that never materialized calibrates future uncertainty.
2. **Violation clusters and aggregate pass rates:** read
   \`stats.evaluators.by_evaluator[]\` — the whole array is \`null\` when
   any artifact is unreadable (\`degraded_artifacts\` names them; run
   \`orcaops doctor\`), and a row's \`pass_rate\` is
   pass/(pass+violation) with null meaning nothing was graded (don't
   render null as 0%). This is one aggregate sample, so it does not prove a
   rising or falling trend. Use it to find evaluators with repeated violations,
   then read 2-3 violation bodies via \`show --json\` for the concrete pattern.
3. Emit each lesson in the growth-log format — one line, actionable:

   \`Next time [concrete situation], I will [concrete action].\`

   Ground every lesson in a citation (artifact id + checkpoint n or
   evaluator ref). Uncited lessons are vibes; drop them.
4. **Candidate evaluators:** a lesson that repeats across ≥2 artifacts and is
   mechanically checkable is an evaluator idea — describe its trigger phase,
   the deterministic check, and a severity, so a follow-up can ship it.`,
};
