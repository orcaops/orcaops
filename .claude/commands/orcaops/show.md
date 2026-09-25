---
name: "orcaops:show"
description: "Inspect a bounded artifact digest, checkpoint, or section; export complete evidence explicitly."
metadata:
  generatedBy: "orcaops@0.3.0"
  contentHash: "6e4803b055ab"
tags: ["orcaops", "read-only"]
---

Inspect a captured task without dumping its full history. You typically pass
the id from `/orcaops:list` or `/orcaops:status`:

```bash
orcaops show <artifact-id> --json
orcaops show <artifact-id> --checkpoint 2 --json
orcaops show <artifact-id> --section knowledge --json
```

The digest contains a bounded checkpoint index. Follow its next-page command to
discover omitted checkpoints; use its anchor when inspecting a selected checkpoint
or decision. A changed observation requires a fresh selection.

Ordinary output is limited to 16 KiB. An oversized complete unit is marked omitted,
not clipped. Use `--output <new-file>` only when complete selected evidence is needed;
stdout then contains a small export receipt, not the file's contents. Read only the
needed part of an export. Full artifact exports omit the old duplicated results body.
See https://docs.orcaops.ai/provenance-json for schema-4 migration details.
