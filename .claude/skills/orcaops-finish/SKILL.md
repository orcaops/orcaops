---
name: "Orcaops: finish workflow"
description: "Finalize completed work by running checks, handling warnings, saving the summary, syncing, and rendering the digest. Use for \"finish this work\", \"wrap this up\", or \"get this ready for a PR\"."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "49e31d3385a9"
tags: ["orcaops", "capture"]
---

# When to use

Use this after all checkpoints are closed and the work is ready to finalize.
It is the normal closing path. The standalone pre-PR, summary, and digest
commands remain available for inspection and repair.

# Attribution: declare your agent id

Every artifact-writing command accepts `--invoked-by-agent <your-agent-id>`.
Pass YOUR OWN id — one of: claude-code, cursor, codex, opencode, aider, github-copilot, antigravity-cli, other — so each
plan / checkpoint / summary event records which agent actually produced
it (this is how multi-agent repos keep provenance trustworthy). Never
copy another agent's id from an example. When the flag is omitted,
orcaops falls back to `ORCAOPS_INVOKED_BY_AGENT`, then best-effort
environment detection, then `other`.

# Run finish

```bash
orcaops finish --invoked-by-agent <your-agent-id> --input - <<'EOF'
artifact_id: <id>
outcome: <what shipped>
tests_written: []
tests_run: []
open_items: []
deferred_decisions: []
EOF
```

The `artifact_id` line is optional when exactly one active artifact exists.
Include it at the top level of the input when more than one is active.

# Respond to the result

- `finalization_status: finalized`: the summary, usage, sync, and digest completed.
- `finalization_status: finalized_without_digest`: the summary is saved. Run the
  returned repair command.
- `status: needs_attention` with `acceptance_allowed: true`: fix the findings and rerun,
  or copy the returned `accepted_warnings` into the same finish input and replace
  every empty reason. Acceptance is bound to that exact review and exact run set.
- `status: needs_attention` with `acceptance_allowed: false`: an evaluator failed.
  Rerun finish; errors cannot be accepted.
- `status: blocked`: resolve or rerun the named block-severity checks before retrying.

`finalization_status` is absent when finish pauses. Do not call summary after a
warning pause: finish has not persisted it or rendered its final digest yet.
If the work, evaluator set, plan, checkpoints, index, or relevant worktree input
changes, the prior warning review is stale and finish will require a fresh pass.

A replay can return both `idempotency_status: replay` and
`finalization_status: finalized`. No new summary was written; finish verified the
prior result and generated or repaired its digest.

# Amending a completed summary

An amendment corrects the wording of the existing summary. It does not reopen
the review or make the artifact cover later work. Pass the latest
`prior_summary_event_id` and repeat every previously accepted warning exactly,
including its reason. Order does not matter. Adding, removing, or changing an
acceptance is refused. Capture later work in a new artifact.


## Capture sync signal

Every capture command returns a `cloud_sync` object. Branch on `cloud_sync.status`:

- `"ok"` or `"skipped"` — nothing to do. Continue.
- `"paused"` — this artifact was NOT recorded and it will not fix itself. **STOP and tell the user.** Quote `cloud_sync.message` and `cloud_sync.action` verbatim; `cloud_sync.pending` is how many artifacts are waiting locally. Do NOT re-run the capture hoping it clears: a replay writes nothing new, and the fault needs the remediation in `cloud_sync.action`.
