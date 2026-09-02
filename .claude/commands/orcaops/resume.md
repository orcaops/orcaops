---
name: "orcaops:resume"
description: "Show progress on the active artifact + a paste-ready prompt for picking work back up."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "0a85b04844ba"
tags: ["orcaops", "read-only"]
---

Show "where was I?" for the most recent active artifact on the current
branch — which plan steps are done (☑), which remain (☐), the last
checkpoint's summary, and a paste-ready prompt block to hand back to the
agent.

```bash
orcaops resume                          # latest active artifact on current branch
orcaops resume --branch feat/x          # specific branch
orcaops resume --artifact <id>          # specific artifact
orcaops resume --copy                   # also copy the suggested prompt to clipboard
orcaops resume --json                   # machine-readable
```

Step completion is **agent-declared** via each checkpoint's
`completed_step_ids` field (UUIDv7s, stable across plan revisions).
Steps without an explicit claim show as ☐ remaining even if the work
was done — that's intentional (the agent is canonical, the runtime
never infers).

If the branch HEAD is ahead of the last captured checkpoint, you'll see
a "branch is N commits ahead — resume context may be stale" warning.
