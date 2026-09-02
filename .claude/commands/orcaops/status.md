---
name: "orcaops:status"
description: "Show the artifact thread state for the current branch (machine-readable JSON)."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "0913d166c9a0"
tags: ["orcaops", "read-only"]
---

Show what orcaops has captured for the current branch — which artifacts
exist, where they are in the lifecycle (plan / checkpoint / eval-pr /
summary), and whether anything is blocking.

Run:

```bash
orcaops status --json
```

The JSON is the agent-readable contract. Use it before `orcaops capture`
calls to know whether a plan already exists, what checkpoint number to
use next, and whether `pre-pr-check` has run.

Drop `--json` for a pretty human-readable summary in the terminal.
