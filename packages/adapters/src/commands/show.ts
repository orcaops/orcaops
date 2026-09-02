import { commandRef } from '../refs.js';
import type { CommandTemplate } from '../types.js';

export const showCommand: CommandTemplate = {
  id: 'show',
  description: 'Render a single artifact thread — plan, checkpoints, summary, evaluator runs.',
  tags: ['orcaops', 'read-only'],
  body: (
    prefix: string
  ) => `Render the full artifact thread for one captured task. You typically pass
the id from \`/${commandRef('list', prefix)}\` or \`/${commandRef('status', prefix)}\`:

\`\`\`bash
orcaops show <artifact-id>             # human-friendly markdown
orcaops show <artifact-id> --json      # machine-readable; includes evaluator log
\`\`\`

Useful for spot-checking what was captured, reading prior decisions, or
debugging an evaluator that fired unexpectedly.
`,
};
