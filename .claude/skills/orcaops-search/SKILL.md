---
name: "Orcaops: search captured artifacts"
description: "Search captured plans, checkpoints, and summaries. Use for \"have we worked on X before?\", \"find earlier work about X\", or \"what did we decide last time?\""
metadata:
  generatedBy: "orcaops@0.2.0-rc.2"
  contentHash: "1b9dabe6e449"
tags: ["orcaops", "read"]
---

# When to use

Use captured-history search to find prior decisions, implementation and evidence
before suggesting an approach or investigating earlier work.

# Search scope

```bash
orcaops search "rate limit" --json
orcaops search redis --branch feat/x --type checkpoint --json
orcaops search redis --touching 'src/**' --limit 5 --json
orcaops search redis --scope worktree --json
orcaops search redis --scope all-projects --json
orcaops search redis --project <project-id> --origin captured --json
```

The default searches the current project across branches. Branch names are literal;
`--touching` filters actual touched paths before the result limit. Use explicit project
or all-projects scope outside Git. All-projects search merges each project database's
ranked results; it does not read another project's local checkout.

# Read the result

Cite `project_id`, `artifact_id` and the exact `source_id`. Each hit includes
its source kind, match class, evidence time and snippet. An unknown evidence time
stays unknown. Matching totals are null when unavailable; returned totals describe
only the current page. If completeness is false, disclose the reported issues and
do not present the available matches as exhaustive.

For the next page, use the returned `page.next_offset` with `--offset`. Pages are
fresh queries; intervening captures may change their order. No cursor freezes history
across projects.

Open an exact hit with `orcaops:show <artifact-id> --project <project-id>`.
Use `orcaops-digest` for a reviewer-facing digest.

Search reads existing databases without changing application history, rebuilding
indexes or initializing missing history. If a project is unavailable, preserve its
existing data and follow the reported recovery action. A missing expected database
is never permission to create an empty replacement.
