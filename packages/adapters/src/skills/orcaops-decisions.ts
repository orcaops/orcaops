import { commandRef, skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * Opt-in insight skill: a thin wrapper on `orcaops decisions`
 * with an FTS fallback via `orcaops search`. Enable with
 * `orcaops skills enable decisions` + `orcaops update`.
 */
export const orcaopsDecisionsSkill: SkillTemplate = {
  id: 'decisions',
  name: 'Orcaops: decision log',
  description:
    'Recall recorded decisions — "what did we decide about X?", "why did we choose Y?", ' +
    '"what alternatives lost and why?", or promoting decisions into ADRs. Merges plan-time ' +
    'decisions, checkpoint decisions, and summary-deferred decisions, each timestamped. Skip ' +
    'for: file/line provenance (why skill) or full-text recall of arbitrary prose (search skill).',
  tags: ['orcaops', 'insight'],
  group: 'insight',
  defaultEnabled: false,
  blockTriggerLine: (prefix: string) =>
    `decision recall ("what did we decide about X and why?") → \`${skillRef('decisions', prefix)}\``,
  body: (prefix: string) => `# When to use

Triggers (user phrasing):

- "what did we decide about X?", "why did we choose Y over Z?"
- "what alternatives did we consider / reject?"
- "turn our decisions into ADRs", "decision log for this branch"

Skip when:

- The user points at a FILE or LINE → \`${skillRef('why', prefix)}\` (provenance).
- The user wants arbitrary prose recall → \`${skillRef('search', prefix)}\`.

# How to invoke

\`\`\`bash
orcaops decisions --json                          # current branch
orcaops decisions --all-branches --json           # repo-wide
orcaops decisions --artifact <id> --json          # exact scope (repeatable)
orcaops decisions --active-since 2026-06-01 --json  # windowed
\`\`\`

Window semantics (the OPPOSITE of loose-ends): window flags select artifacts
AND filter decision RECORDS by their \`ts\` — plan decisions carry their
revision's \`captured_at\`, checkpoint decisions their \`closed_at\`,
deferred decisions the summary \`ts\`. With \`--artifact\` the flags stop
selecting artifacts but still filter records ("decisions made yesterday on
this artifact"). An artifact is listed only if ≥1 record survives.

# Answering "what did we decide about X?"

1. Run the scoped \`decisions --json\` and keyword-match X against
   \`decision\` / \`reason\` / \`alternatives_considered\` text.
2. **FTS fallback:** if nothing matches, run
   \`orcaops search "<topic>" --json\` (FTS5 over plan / checkpoint /
   summary prose — a decision discussed in a checkpoint summary but never
   recorded as a structured decision still surfaces there; cite it as
   prose, not as a recorded decision).
3. Answer with the decision, the reason, the rejected alternatives, the
   source (\`plan r<revision_n>\` / \`cp #<n>\` / summary-deferred), and the
   timestamp. For ADR promotion, group records per artifact and emit one
   ADR per load-bearing decision (status: accepted; context from \`reason\`;
   alternatives from \`alternatives_considered\`; date from \`ts\`); link the
   artifact id and render via ${commandRef('show', prefix)} for reviewers who
   want the full thread.`,
};
