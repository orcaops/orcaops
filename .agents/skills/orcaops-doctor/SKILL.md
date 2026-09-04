---
name: "Orcaops: diagnose install"
description: "Diagnose or repair Orcaops setup. Use for \"is Orcaops set up correctly?\", \"diagnose Orcaops\", or when an orcaops command fails unexpectedly."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "736cc4694625"
---

# When to use

Invoke when something seems off with the orcaops install — a command
errored, the SQLite cache might be stale, or the user is preparing to
share the repo with someone else and wants a clean health check.

Triggers:

- "is orcaops set up correctly?", "diagnose orcaops"
- "why is orcaops failing?", "what's broken?"
- "run a health check", "are skills installed?"

Also reasonable to invoke proactively when an `orcaops capture` /
`orcaops digest` / etc. fails with an unfamiliar error — doctor often
surfaces the root cause.

# How to invoke

```bash
orcaops doctor          # human-readable, with ✓/⚠/✗ markers
orcaops doctor --json   # machine-readable; same checks
orcaops doctor --fix    # repair install drift and resume a missing/partial seed
```

Run `--fix` only when the user explicitly asks for repair. A diagnosis alone
does not authorize changing installed files or resuming an import.

# Interpreting the output

Checks are reported as `pass` / `warn` / `fail`:

| Check | What it verifies |
|---|---|
| `git-repo` | Current branch + HEAD resolvable. |
| `init` | A configuration governs the worktree — its own, or the shared personal one in the git common dir. |
| `config` | The governing configuration parses; agent + llm.tool resolvable. |
| `cache` | SQLite cache opens; schema at `CURRENT_VERSION`; row counts. |
| `evaluators` | Every pack declared in the evaluator registration resolves + validates (manifest, specs, command runtimes, prompt files). |
| `llm-tool` | Configured CLI (claude / codex) is on PATH. |
| `agent-skills` | Configured adapter's skills + commands present and stamped at the current orcaops version. |
| `seed` | Existing git history has live or imported artifact coverage; partial imports are resumable. |
| `stale-artifacts` | No active artifact has been idle >24h (suggests a forgotten summary). |
| `unresolved-blocks` | No evaluator's latest run is `severity: block`, `run_status: completed`, and `verdict: violation`. |

Exit code is `0` on pass or warn (warnings don't fail CI); `1` only
when something is genuinely broken (missing init, corrupt cache,
not-a-repo).

# Common follow-up actions

- `agent-skills` warns about stale/missing files → suggest
  `orcaops update` (or `orcaops update --force` if user-edited).
- `seed` warns → preview with `orcaops seed --dry-run`, resume explicitly
  with `orcaops seed --yes`, or use `orcaops doctor --fix`.
- `cache` fails → suggest `orcaops rebuild` (rebuilds SQLite from JSON).
- `stale-artifacts` warns → if the work is complete, suggest the
  orcaops-finish skill; otherwise resume or amend the artifact.
- `unresolved-blocks` warns → resolve via `orcaops block acknowledge`
  (only for evaluators whose spec sets
  `resolution.acknowledge.enabled: true`) or `orcaops block dismiss` (always
  available). Otherwise amend the offending artifact.
