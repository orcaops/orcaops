import { commandRef } from '../refs.js';
import type { CommandTemplate } from '../types.js';

export const whyCommand: CommandTemplate = {
  id: 'why',
  description: 'Show a file history or trace a file:line to the checkpoint that touched it.',
  tags: ['orcaops', 'read-only'],
  body: (prefix: string) => `Answer "how did this file evolve?" with its complete captured history,
or answer "why does this line exist?" by linking a file + line to the
captured artifact and checkpoint that produced it.

Pass either a bare \`<file>\` or \`<file>:<line>\` after the slash:

\`\`\`bash
orcaops why src/middleware/rateLimiter.ts          # complete history, newest first
orcaops why src/middleware/rateLimiter.ts --all    # same history with expanded detail
orcaops why src/middleware/rateLimiter.ts:42       # best line match (highest confidence)
orcaops why src/middleware/rateLimiter.ts:42 --all # every line candidate
orcaops why <target> --branch feat/x               # restrict to one branch
orcaops why <target> --json                        # machine-readable
\`\`\`

Whole-file mode is an ordered aggregate, not a ranking. Its JSON always
includes every matching checkpoint in \`all\`; \`best\` is only the newest-entry
compatibility alias. Human output is compact by default, while \`--all\` expands
the same checkpoint identities with their captured detail.

Line results include a **confidence label**:

- \`exact\` — the line was added by exactly one checkpoint's diff.
- \`likely\` — the line existed in the file when the checkpoint was
  captured (forward or retroactive ancestry holds).
- \`weak\` — the artifact touched the file but the specific line's
  attribution is uncertain (parallel branches, multiple touches).
- \`none\` — no captured artifact touched this file.

Pair with \`/${commandRef('show', prefix)} <id>\` to read the full artifact for the match;
pair with \`/${commandRef('digest', prefix)}\` for the broader PR picture.
`,
};
