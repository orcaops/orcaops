---
name: "Orcaops: pre-PR check"
description: "Run the final pre-PR evaluator pass before summary. Recommended, not a hard gate; a block-severity violation keeps `capture summary` BLOCKED until resolved."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "e251ab3ac845"
---

# When to use

After the work is complete and you're about to call `capture summary`.
Pre-PR runs the enabled `fires_at: pre-pr` evaluators across the whole
artifact thread one more time.

Skipping this means `capture summary` runs without the final pass; the
digest will be poorer.

# Attribution: declare your agent id

Every artifact-writing command accepts `--invoked-by-agent <your-agent-id>`.
Pass YOUR OWN id — one of: claude-code, cursor, codex, opencode, aider, github-copilot, antigravity-cli, other — so each
plan / checkpoint / summary event records which agent actually produced
it (this is how multi-agent repos keep provenance trustworthy). Never
copy another agent's id from an example. When the flag is omitted,
orcaops falls back to `ORCAOPS_INVOKED_BY_AGENT`, then best-effort
environment detection, then `other`.

# How to run

```bash
orcaops capture pre-pr-check --input - --invoked-by-agent <your-agent-id> <<'EOF'
artifact_id: a3b1f0c2
EOF
```

`artifact_id` is **optional** — omit it to target the single active
artifact on the branch (it's autodetected). Pass it explicitly only when
more than one artifact is active; omitting it then returns
`AMBIGUOUS_ARTIFACT` with a `candidates[]` list so you can pick one. The
id comes from `orcaops status --json`.

# Interpreting the response

```json
{
  "ok": true,
  "artifact_id": "a3b1f0c2",
  "evaluator_results": [
    { "evaluator": "plan-conformance-pre-pr", "severity": "warn", "status": "violation",
      "body": "VIOLATION\n\nThe delivered scope differs from the approved plan..." }
  ],
  "blocking": false
}
```

Severity `info` findings are advisory. Severity `warn` findings are also
returned from a successful standalone pre-PR capture; the primitive command
does not turn them into blocks. When the normal closing path uses `finish`,
warnings pause before summary so the agent can fix the concern or explicitly
accept the exact reviewed finding. Severity `block` prevents summary until
it is resolved through `orcaops-checkpoint`'s block workflow.

# After pre-PR passes

Proceed to **orcaops-summary** to close out the artifact thread.

# Re-running

You can re-run pre-PR any number of times. Each passing run appends a
fresh `pre_pr_checked` marker event (it is NOT idempotency-keyed against
your input), so the latest pass always reflects the current event-log
state. A new commit — or any new orcaops event — makes the prior pass
stale, and the next-step hint re-suggests pre-PR. Re-running never
finalizes anything (only `capture summary` finalizes).


## Capture sync signal

Every capture command returns a `cloud_sync` object. Branch on `cloud_sync.status`:

- `"ok"` or `"skipped"` — nothing to do. Continue.
- `"paused"` — this artifact was NOT recorded and it will not fix itself. **STOP and tell the user.** Quote `cloud_sync.message` and `cloud_sync.action` verbatim; `cloud_sync.pending` is how many artifacts are waiting locally. Do NOT re-run the capture hoping it clears: a replay writes nothing new, and the fault needs the remediation in `cloud_sync.action`.
