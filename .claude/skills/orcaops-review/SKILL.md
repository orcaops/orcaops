---
name: "Orcaops: review feedback loop (PR review collaboration)"
description: "Handle human feedback on a cloud PR review: check comments, reply to reviewer threads, push fixes, or wait for the reviewer. Use for \"address the review feedback on my PR\"."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "0cb369da373b"
tags: ["orcaops", "capture"]
---

# When to use

A human left review feedback on your PR (or you are waiting for some). This
skill is the AGENT side of the loop; the reviewer works on the web surface.

# The loop

1. **Status** — `orcaops review status`. Each open PR shows an explicit
   "NEW human activity" flag. Nothing new → nothing to do.
2. **Pull** — `orcaops review pull --task <n>` (or `--pr <id>`). Read the FULL
   transcript: every open thread with its anchor context, submissions with
   snapshot currency, dispositions. Note the printed **activity cursor** — echo
   it on every reply in this pass.
3. **Reply to every thread you act on** — `orcaops review reply <comment_id>
   --message "<what you did / why not>" --pass-token <cursor>`. If you choose
   NOT to act on a thread, still reply saying why. The pass token makes ten
   replies one notification — never omit it when the pull printed one.
4. **Work as checkpoints** — the actual fixes go through the normal capture
   loop (orcaops-checkpoint: open before the change, close after).
5. **Push** the branch so the reviewer sees the new code.
6. **Watch** — `orcaops review watch --pr <id> --timeout 600`.
   - **exit 0**: new human activity — go to step 2.
   - **exit 2**: timeout, NOT a failure. Run `orcaops review status` ONCE and
     check `has_new_human_activity` (a second machine / earlier pass may have
     moved the cursor). Flag set → step 2. Not set → you may re-arm the watch,
     but cap yourself at **2–3 dry cycles**, then stop and hand back to the
     user ("no reviewer activity; re-run when they've looked").

# Hard rules

- **reply-don't-resolve.** "Addressed" is YOUR claim; "resolved" is the
  reviewer's judgment. The open-thread count is a reviewer trust signal —
  never run `orcaops review resolve` as an agent; a human at the terminal
  may. Replying to a RESOLVED thread is fine (a follow-up note); it does not
  reopen anything.
- **Second-session stand-down.** If the pulled transcript shows fresh AGENT
  replies you did not write, another session is already working this PR —
  stand down and tell the user instead of double-replying.
- **Never fabricate a pass token.** Echo the cursor the pull printed; if there
  is none (no human activity yet), omit --pass-token and let it default.


## Cloud sync signal — do not ignore

Every capture command returns a `cloud_sync` field telling you whether THIS artifact reached the cloud. Branch on `cloud_sync.status`:

- `"ok"` — uploaded (or already on the cloud). Continue normally.
- `"paused"` — NOT uploaded and you must act. STOP and tell the user; `cloud_sync.pending` is how many artifacts are waiting locally, and `cloud_sync.reason` says how to heal it:
  - `not_authenticated` → run `orcaops resync` (an expired session refreshes automatically), or `orcaops login` if it reports your session ended.
  - `push_failed` → run `orcaops resync --force` to retry.
  - `content_invalid` → NOT retryable: this artifact contains a disallowed control byte and will not sync until it is scrubbed and rebuilt (`resync --force` re-trips the same check and will NOT fix it). Run `orcaops doctor` to see the offending field, then scrub the event log + plan.json (recompute its checksum), `orcaops rebuild`, and `orcaops resync`.
  - `upgrade_required` → NOT retryable on this binary: the cloud rejected this CLI as below its minimum supported version. STOP and tell the user to upgrade their orcaops install, then `orcaops resync`.
- `"skipped"` — NOT uploaded, but benign and expected (`reason: "missing_remote"` = a local-only repo with no git remote; `reason: "drain_disabled"` = `ORCAOPS_DISABLE_DRAIN=1`; `reason: "no_cloud_configured"` = this machine holds no cloud credentials at all). No action needed; continue.

> ⚠ When status is `"paused"`: Cloud sync paused — your captured artifacts aren't uploading. Follow the `cloud_sync.reason` remediation above.
