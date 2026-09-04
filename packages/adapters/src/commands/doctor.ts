import type { CommandTemplate } from '../types.js';

export const doctorCommand: CommandTemplate = {
  id: 'doctor',
  description: 'Diagnose adapter health, env, evaluator validity, cache, and watchdog signals.',
  tags: ['orcaops', 'read-only'],
  body: `Health check for the local orcaops install. Run when something seems off
or before sharing the repo with someone else.

\`\`\`bash
orcaops doctor          # human-readable, with ✓/⚠/✗ markers
orcaops doctor --json   # machine-readable; same checks
\`\`\`

Checks performed:

| Check | What it verifies |
|---|---|
| \`git-repo\` | Current branch + HEAD resolvable. |
| \`init\` | A configuration governs the worktree — its own, or the shared personal one in the git common dir. |
| \`config\` | The governing configuration parses; agent + llm.tool resolvable. |
| \`cache\` | SQLite cache opens; schema at \`CURRENT_VERSION\`; row counts. |
| \`evaluators\` | Every pack declared in the evaluator registration resolves + validates (manifest, specs, command runtimes, prompt files). |
| \`llm-tool\` | Configured CLI (claude / codex) is on PATH. |
| \`agent-skills\` | Configured adapter's skills + commands present and stamped at the current orcaops version. |
| \`stale-artifacts\` | No active artifact has been idle >24h (suggests a forgotten summary). |
| \`unresolved-blocks\` | No evaluator's latest run is \`severity:block + status:violation\`. |

Exit code: \`0\` on pass or warn (warnings don't fail CI); \`1\` only when
something is genuinely broken (missing init, corrupt cache, not-a-repo).

If \`agent-skills\` warns about stale or missing files, run
\`orcaops update\` to refresh.
`,
};
