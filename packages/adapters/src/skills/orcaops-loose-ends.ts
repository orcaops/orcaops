import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * Opt-in insight skill: a thin wrapper on `orcaops loose-ends`.
 * Enable with `orcaops skills enable loose-ends` + `orcaops update`.
 */
export const orcaopsLooseEndsSkill: SkillTemplate = {
  id: 'loose-ends',
  name: 'Orcaops: loose ends',
  description:
    'Surface everything captured work still owes — "what did I say I\'d come back to?", ' +
    '"what\'s still open?", "any loose ends?". Reads open items, deferred decisions, recorded ' +
    'uncertainty, uncovered plan steps, and stale open checkpoints. Skip for: resuming one ' +
    'task (resume skill) or a PR summary (digest skill).',
  tags: ['orcaops', 'insight'],
  group: 'insight',
  defaultEnabled: false,
  blockTriggerLine: (prefix: string) =>
    `loose ends ("what did I say I'd come back to?") → \`${skillRef('loose-ends', prefix)}\``,
  body: (prefix: string) => `# When to use

Triggers (user phrasing):

- "what did I say I'd come back to?", "what's still open?"
- "any loose ends?", "what's unfinished?", "what did we defer?"

Skip when:

- The user wants to CONTINUE one task → \`${skillRef('resume', prefix)}\`.
- The user wants the reviewer-facing summary → \`${skillRef('digest', prefix)}\`.

# How to invoke

\`\`\`bash
orcaops loose-ends --json                     # current branch
orcaops loose-ends --all-branches --json      # repo-wide sweep
orcaops loose-ends --artifact <id> --json     # exact scope (repeatable)
\`\`\`

Window flags (\`--since/--until/--active-since/--active-until\`) SELECT
ARTIFACTS ONLY — findings are always the artifact's CURRENT loose ends (a
month-old open item is still a loose end today). Never combine window flags
with \`--artifact\`: the combination is rejected (\`INVALID_INPUT\`), because
the flags would do nothing in exact-scope mode.

# Interpreting the output

Per artifact (only artifacts with ≥1 finding appear): \`open_items\` +
\`deferred_decisions\` (from the summary, with its \`ts\`), \`uncertainty\`
(raw entries with \`{checkpoint_n, closed_at}\` provenance — no resolution
tracking in v1), \`uncovered_steps\` (plan steps no checkpoint claimed or
declared), \`open_checkpoints\` (with \`age_seconds\`), and a \`no_summary\`
flag (a plan with no summary is itself a loose end). Finding timestamps are
display context, never filters. Render one artifact per section, findings as
one-liners, oldest first.`,
};
