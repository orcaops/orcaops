import { commandRef } from '../refs.js';
import type { CommandTemplate } from '../types.js';

export const whyCommand: CommandTemplate = {
  id: 'why',
  description: 'Show a file history or trace a file:line to the checkpoint that touched it.',
  tags: ['orcaops', 'read-only'],
  body: (prefix: string) => `Answer "how did this file evolve?" with its evaluated recorded history,
or answer "why does this line exist?" by linking a file + line to the
captured artifact and checkpoint that produced it.

Pass either a bare \`<file>\` or \`<file>:<line>\` after the slash:

\`\`\`bash
orcaops why src/middleware/rateLimiter.ts          # ranked recorded history
orcaops why src/middleware/rateLimiter.ts --all    # up to 1,000 results; budgets apply
orcaops why src/middleware/rateLimiter.ts:42       # best line match (highest confidence)
orcaops why src/middleware/rateLimiter.ts:42 --all # up to 1,000 line candidates
orcaops why <target> --branch feat/x               # restrict to one branch
orcaops why <target> --json                        # compact JSON; --details expands evidence
\`\`\`

JSON schema v4 returns compact candidates by default. For a line explanation,
use \`--json --details --limit 1\` and read rich \`best\` when present, even
when it is outside the result page. With null best, inspect conclusion,
completeness, candidate_selection, and uncertainty. One returned row does not
resolve an ambiguous attribution; expand more rows to inspect competing claims.

Compact historical labels and source-specific evidence counts help identify
work to expand. Missing historical labels are null. Compact source_versions
contains a count and canonical digest; details retain the full source list.
The digest detects source-state changes, not historical snapshot availability.

Human output retains captured rationale; \`--details\` without \`--json\`
adds nothing. \`--limit 1\` limits result rows, not narrative bytes or shared
diagnostics. \`--all\` changes the default limit from 25 to 1,000, with
separate 500-artifact candidate and overlap-support budgets; it does not
promise complete history.

Read pagination, candidate_selection, completeness, and detail_omissions
separately. Follow pagination.next_offset for more evaluated matches and
preserve the target plus \`--project\`, \`--scope\`, \`--branch\`, \`--origin\`,
\`--touching\`, and \`--at\` selections when expanding. \`--at\` fixes code,
not artifact history. Inspect a specific artifact using \`orcaops show
<artifact_id> --project <project_id> --json\`; why has no artifact-ID filter.
show includes later revisions, so use detail best or result rows for the
candidate's historical rationale.

Line results include a **confidence label**:

- \`exact\` — meaningful fingerprint or verified blame evidence supports the attribution.
- \`likely\` — verified blame lies inside the checkpoint work interval.
- \`weak\` — the artifact touched the file but the specific line's
  attribution is uncertain (parallel branches, multiple touches).
A \`none\` conclusion means no candidate matched in the evaluated set.

Pair with \`/${commandRef('show', prefix)} <id>\` to read the full artifact for the match;
pair with \`/${commandRef('digest', prefix)}\` for the broader PR picture.
`,
};
