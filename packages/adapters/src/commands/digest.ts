import { commandRef } from '../refs.js';
import type { CommandTemplate } from '../types.js';

export const digestCommand: CommandTemplate = {
  id: 'digest',
  description: 'Render a reviewer-facing digest for one artifact or a whole branch.',
  tags: ['orcaops', 'read-only'],
  body: (prefix: string) => `Render reviewer-ready captured work. Use branch-wide mode for a pull
request or branch summary, and the default mode when one artifact is named.

\`\`\`bash
orcaops digest                          # latest artifact on current branch (markdown)
orcaops digest --branch feat/x          # latest on another branch
orcaops digest --artifact <id>          # one specific artifact
orcaops digest --branch-wide            # all captured work in the current PR range
orcaops digest --branch-wide --base origin/main
orcaops digest --out PR-DESCRIPTION.md  # write to file in addition to stdout
orcaops digest --json                   # machine-readable
\`\`\`

If the thread is incomplete (no \`capture summary\` yet), the digest still
renders but with an "incomplete" warning and missing the \`outcome\`
headline. Run \`/${commandRef('status', prefix)}\` to see what stage the thread is at;
ask the agent to run the Orcaops finish workflow if the task is ready to close.

Pair with \`/${commandRef('why', prefix)}\` to drill into a specific file:line; pair with
\`/${commandRef('show', prefix)}\` to read the raw thread.
`,
};
