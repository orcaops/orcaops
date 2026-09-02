import type { CommandTemplate } from '../types.js';

export const listCommand: CommandTemplate = {
  id: 'list',
  description: 'List captured artifacts in the repo (optionally filtered by branch).',
  tags: ['orcaops', 'read-only'],
  body: `List every artifact orcaops has captured in this repo:

\`\`\`bash
orcaops list                  # all branches
orcaops list --branch main    # one branch
orcaops list --json           # machine-readable
\`\`\`

Each row shows the artifact id, lifecycle state, checkpoint count, branch, and the
plan task. Useful for finding old artifacts to inspect or resume.
`,
};
