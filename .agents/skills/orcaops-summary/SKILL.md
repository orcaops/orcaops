---
name: "Orcaops: capture summary"
description: "Manually save or repair the final outcome of completed work. Use the finish workflow for normal finalization."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "c51563ff130a"
---

# Attribution: declare your agent id

Every artifact-writing command accepts `--invoked-by-agent <your-agent-id>`.
Pass YOUR OWN id — one of: claude-code, cursor, codex, opencode, aider, github-copilot, antigravity-cli, other — so each
plan / checkpoint / summary event records which agent actually produced
it (this is how multi-agent repos keep provenance trustworthy). Never
copy another agent's id from an example. When the flag is omitted,
orcaops falls back to `ORCAOPS_INVOKED_BY_AGENT`, then best-effort
environment detection, then `other`.

# When to use

Use this when the task is complete and the artifact is ready to finalize.
For normal finalization, use `orcaops finish`: it runs the pre-PR checks,
saves the summary, syncs, and renders the digest in one flow. Use this
standalone command when the user explicitly asks to save or repair a summary.

Do not capture a summary merely because a session is ending. If work will
continue later, leave the artifact active so it remains resumable.

Without a final summary:

- The artifact stays `active`. `orcaops doctor` flags it as stale
  after 24h.
- `orcaops digest` still renders, but with a "Thread is incomplete —
  no summary captured yet" warning and missing the `outcome` headline
  that reviewers read first.
- `orcaops status` reports the thread as half-captured.

What `capture summary` actually requires:

1. No open checkpoints — close or abandon each first (else
   `INVALID_INPUT`).
2. No unresolved block-severity violation (else `BLOCKED`).

When using this manual path, strongly consider running
`orcaops capture pre-pr-check` first. It is not a hard prerequisite, but
skipping it means no final evaluator pass happened. Also complete the planned
steps so the digest reads as fully covered.

If a block is unresolved (from pre-pr-check or a checkpoint-close),
summary stays `BLOCKED` until you resolve it via
`orcaops block acknowledge` (for evaluators whose spec sets
`resolution.acknowledge.enabled: true`)
or `orcaops block dismiss` (always available).

# How to capture

```bash
orcaops capture summary --input - --invoked-by-agent <your-agent-id> <<'EOF'
artifact_id: a3b1f0c2
outcome: |-
  Rate limiter shipped to /api/charge with 9 passing tests; cumulative
  cost ~$0.12 in evaluator runs.
tests_written:
  - "tests/middleware/rateLimiter.test.ts"
  - "tests/api/charge.integration.test.ts"
tests_run: ["pnpm test rateLimiter"]
open_items:
  - "TTL strategy if multi-region Redis is added later"
deferred_decisions:
  - "429 response shape (deferred to product review)"
EOF
```

Use `|-` block scalars for `outcome` (free-text prose). For the string
lists (`tests_written`, `tests_run`, `open_items`, `deferred_decisions`)
**quote every item** — YAML otherwise coerces a numeric-looking entry to a
number or reads a colon-space (e.g. `pnpm test: unit`) as a mapping, and the
strict string schema rejects it.

# Required fields

| Field | Notes |
|---|---|
| `idempotency_key` | **Optional — auto-minted (UUIDv7) when omitted.** Supply one explicitly only for replay-safe retries (reusing a key dedups a retry as a replay instead of a new event). |
| `artifact_id` | **Optional — omit to autodetect the single active artifact on the branch** (returns `AMBIGUOUS_ARTIFACT` with a `candidates[]` list if more than one is active). |
| `outcome` | 1-3 sentences. The headline a reviewer reads first in the digest. |

# Optional but valuable

| Field | Notes |
|---|---|
| `tests_written` | Files you added test cases to. |
| `tests_run` | Commands you executed (e.g., `pnpm test`). |
| `open_items` | Loose ends a reviewer or follow-up should address. |
| `deferred_decisions` | Choices intentionally punted, each a **plain string** with the reason inline (e.g. `"429 shape (deferred: product review)"`) — NOT the structured `{decision, reason}` shape used by plan/checkpoint `decisions`. Surfaced in digest. |

# Interpreting the response

```json
{ "ok": true, "artifact_id": "a3b1f0c2", "completed_at": "2026-04-25T13:30:00.000Z", "summary_event_id": "01HX..." }
```

A successful summary moves the artifact to `state: summarized`. `orcaops status --json`
will show `thread.summary.status === "done"` and `capture_health: "ok"`.

- `finalization_status: finalized` means the summary is saved and its digest is current.
- `finalization_status: finalized_without_digest` means the summary is saved but digest
  generation failed. Run the returned repair command; do not rewrite the summary.
- A replay can return `idempotency_status: replay` alongside `finalization_status:
  finalized`. It wrote no second summary and generated or repaired the digest.

**Amending a summary.** The summary is the reviewer-facing record, so a bare
re-capture is REFUSED (`SUMMARY_ALREADY_CAPTURED`) — a second agent can't
silently clobber it. To replace it deliberately, re-run `capture summary` with
`prior_summary_event_id` set to the latest summary event id (the
`summary_event_id` from the prior response, or the id named in the
`SUMMARY_ALREADY_CAPTURED` error). If another amend landed since you read it you
get `STALE_SUMMARY` — re-read and retry with the fresh token. (Plan *revision*
stays hard-frozen post-summary via `ARTIFACT_FINALIZED`; only the summary itself
is amendable, explicitly.) An amendment corrects the existing summary wording;
it does not make the artifact cover later or forgotten work. Capture that work
in a new artifact.

# Errors

- `UNKNOWN_ARTIFACT` — bad `artifact_id`.
- `INVALID_INPUT` — Zod found a missing/invalid field; the path will tell
  you which.
- `SECRET_IN_PAYLOAD` — a field carries a recognizable credential. The shape
  is fine; rewrite the narrative to DESCRIBE the credential rather than quote
  it, then retry. `secret_findings` names every offending field and its key
  prefix. Nothing was written or pushed.
- `SUMMARY_ALREADY_CAPTURED` — a summary already exists and you didn't pass
  `prior_summary_event_id`. The message names the event id to supersede with.
- `STALE_SUMMARY` — the `prior_summary_event_id` you passed is no longer the
  latest summary event. Re-read resume/status and retry with the fresh token.

# Automatic digest after summary

A successful summary automatically materializes the reviewer-facing digest,
caches it, and writes its search entry. Only run `orcaops digest --artifact
<artifact_id>` yourself when the response reports
`finalized_without_digest` and returns that repair command.

For inspection, `orcaops show <artifact_id>` displays the full thread
(plan + checkpoints + summary + evaluator runs).


## Capture sync signal

Every capture command returns a `cloud_sync` object. Branch on `cloud_sync.status`:

- `"ok"` or `"skipped"` — nothing to do. Continue.
- `"paused"` — this artifact was NOT recorded and it will not fix itself. **STOP and tell the user.** Quote `cloud_sync.message` and `cloud_sync.action` verbatim; `cloud_sync.pending` is how many artifacts are waiting locally. Do NOT re-run the capture hoping it clears: a replay writes nothing new, and the fault needs the remediation in `cloud_sync.action`.
