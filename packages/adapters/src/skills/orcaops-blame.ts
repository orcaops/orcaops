import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * Insight skill wrapping `orcaops export agent-trace`.
 * OPT-IN (`defaultEnabled: false`): its export writes files and git notes —
 * side-effectful surfaces stay explicit. `requires: ['matcher']`.
 */
export const orcaopsBlameSkill: SkillTemplate = {
  id: 'blame',
  name: 'Orcaops: blame (agent-trace export)',
  description:
    'Export which lines an AI agent wrote in a commit as agent-trace records and git notes.',
  tags: ['orcaops', 'insight', 'provenance'],
  group: 'insight',
  defaultEnabled: false,
  requires: ['matcher'],
  blockTriggerLine: (prefix: string) =>
    `per-line provenance export ("which lines did the agent write?", agent-trace records) → \`${skillRef('blame', prefix)}\``,
  body: (prefix: string) => `# When to use

Triggers:

- "which lines of this commit did the agent write?"
- "export agent provenance" / "emit an agent-trace record"
- "attach provenance notes to this commit"

Skip when:

- The question is WHY a line exists → \`${skillRef('why', prefix)}\`.
- Hunting for UNACCOUNTED work → \`${skillRef('adversarial-review', prefix)}\`
  (fifth signal).

# How

\`\`\`bash
orcaops export agent-trace --json                 # HEAD, record to stdout
orcaops export agent-trace --commit <sha> --json  # any commit
orcaops export agent-trace --notes                # + git note at refs/notes/orcaops/agent-trace
orcaops export agent-trace --out .agent-trace/traces.jsonl   # reference-impl file convention
\`\`\`

The record is Cursor agent-trace v0.1.0: \`files[].conversations[]\` group
line RANGES per (artifact, checkpoint) with \`contributor.model_id\` where
usage snapshots recorded a model; \`metadata["ai.orcaops"].coverage\`
discloses attribution sparsity — RELAY it. Matching is exact line-content
only: unattributed lines may be human-authored, rebased, or outside
checkpoint windows — never present absence as authorship evidence.

# Notes hygiene (non-negotiable)

- Notes land at \`refs/notes/orcaops/agent-trace\` — orcaops' OWN
  namespace. NEVER write git-ai's \`refs/notes/ai\` (another tool actively
  rewrites it).
- Notes are LOCAL. Nothing here pushes them; if the user wants them
  shared, that is a deliberate
  \`git push origin refs/notes/orcaops/agent-trace\`.
- In-repo \`--out\` files belong under \`.agent-trace/\` (excluded from
  snapshot trees) or in .gitignore — the command warns otherwise.

# Optional pre-PR step

If the user wants provenance on every PR: run the export with \`--notes\`
after \`${skillRef('pre-pr', prefix)}\` passes, as a MANUAL step. Do not
wire it into hooks for them — installing hooks is their call.`,
};
