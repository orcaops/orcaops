---
name: "orcaops:search"
description: "FTS5 search over plan / checkpoint / summary content across all captured artifacts."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "3367bf4f5080"
tags: ["orcaops", "read-only"]
---

Full-text search over everything orcaops has captured: plan tasks,
checkpoint summaries, uncertainties, summary outcomes, and open items.
Backed by SQLite FTS5 with snippet extraction.

The user passes the query after the slash:

```bash
orcaops search "rate limit"             # ranked results across all branches
orcaops search redis --branch feat/x    # restrict to one branch
orcaops search redis --type checkpoint  # plan | checkpoint | summary | evaluator
orcaops search redis --limit 5          # cap result count (default 25)
orcaops search redis --json             # machine-readable
```

Each row shows the artifact id, source (`plan` / `checkpoint:N` /
`summary`), branch, timestamp, and a snippet with the matched terms
wrapped in `<<term>>` markers. Multi-item content (plan steps, file
lists) renders with ` · ` separators inside snippets.

Hyphenated queries like `rate-limit` are handled — they don't trigger
FTS5's syntax errors. Use `/orcaops:show <id>` to read the full
artifact for any hit.
