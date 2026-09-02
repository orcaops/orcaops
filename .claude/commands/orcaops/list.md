---
name: "orcaops:list"
description: "List captured artifacts in the repo (optionally filtered by branch)."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "f16bb5ba92a7"
tags: ["orcaops", "read-only"]
---

List every artifact orcaops has captured in this repo:

```bash
orcaops list                  # all branches
orcaops list --branch main    # one branch
orcaops list --json           # machine-readable
```

Each row shows the artifact id, lifecycle state, checkpoint count, branch, and the
plan task. Useful for finding old artifacts to inspect or resume.
