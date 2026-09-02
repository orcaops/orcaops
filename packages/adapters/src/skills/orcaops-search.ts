import { commandRef, skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

export const orcaopsSearchSkill: SkillTemplate = {
  id: 'search',
  name: 'Orcaops: search captured artifacts',
  description:
    'FTS5 search over plan / checkpoint / summary content across all captured artifacts. Use when the user asks "did we already work on X?", "search prior artifacts for Y", "have I touched Z before?", "have we worked on X before in ANY project?", or you need historical context before suggesting an approach.',
  tags: ['orcaops', 'read'],
  body: (prefix: string) => `# When to use

Invoke when the user (or you, while reasoning) need to find prior work
on a topic across **all captured artifacts** — not just the current
branch. Useful before suggesting an approach ("did we already try
this?"), when investigating a bug ("when was this last touched?"), or
when picking up a long-running thread.

Triggers:

- "search orcaops for X", "have we worked on X before?"
- "did I already do Y?", "look up prior context on Z"
- "find every artifact that mentioned <term>"

# How to invoke

The user typically gives you the query. If not, pick one from context:

\`\`\`bash
orcaops search "rate limit"             # ranked across all branches
orcaops search redis --branch feat/x    # restrict to one branch
orcaops search redis --type checkpoint  # plan | checkpoint | summary | evaluator
orcaops search redis --limit 5          # cap result count (default 25)
orcaops search redis --json             # machine-readable
\`\`\`

# Cross-project curiosity (archive)

When the question spans EVERY project on this machine — "have we solved
this before anywhere?", "did any repo touch this pattern?" — and the
archive is enabled (\`archive.enabled: true\`), add \`--all-projects\`:

\`\`\`bash
orcaops search "<term>" --all-projects --json
\`\`\`

It works from inside any repo or linked worktree and from outside one.
The current project includes both hot and retained archive history;
duplicate artifact IDs use the freshest projection (archive only when
strictly newer, tie to hot). Each hit carries a \`project\` field — cite
it. Without the archive this flag has nothing to read: run the
current-repo search and say the sweep was repo-local.

# Interpreting the output

Each row shows: artifact id, source (\`plan\` / \`checkpoint:N\` /
\`summary\`), branch, timestamp, and a snippet with matched terms wrapped
in \`<<term>>\` markers. Multi-item content (plan steps, file lists)
renders with \` · \` separators inside snippets — that's intentional, not
a parsing artifact.

For a deeper read on a current-repository hit, invoke the
\`${commandRef('show', prefix)}\` command with the artifact id. \`show\` is
current-repository-only; use cross-project \`decisions\` or \`loose-ends\`
for archived detail from other projects. For a polished version, invoke
\`${skillRef('digest', prefix)}\`.

# Notes

- Hyphenated queries like \`rate-limit\` are handled (no FTS5 syntax error).
- Indexed content is the SQLite cache, which mirrors \`.orcaops/artifacts/\`.
  If the cache is suspected stale, the user can run \`orcaops rebuild\`.
`,
};
