---
name: "orcaops:show"
description: "Render a single artifact thread — plan, checkpoints, summary, evaluator runs."
metadata:
  generatedBy: "orcaops@0.2.0-rc.2"
  contentHash: "41737b961e3a"
tags: ["orcaops", "read-only"]
---

Render the full artifact thread for one captured task. You typically pass
the id from `/orcaops:list` or `/orcaops:status`:

```bash
orcaops show <artifact-id>             # human-friendly markdown
orcaops show <artifact-id> --json      # machine-readable; includes evaluator log
```

Useful for spot-checking what was captured, reading prior decisions, or
debugging an evaluator that fired unexpectedly.
