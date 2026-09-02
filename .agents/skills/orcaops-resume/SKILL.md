---
name: "Orcaops: resume an artifact"
description: "Show progress on an in-flight artifact + a paste-ready prompt for picking work back up. Use ONLY when the user signals continuation intent — \"pick up where we left off\", \"continue the work in progress\", \"resume from where I stopped\", \"where was I?\" — including cold-starting captured work in a FRESH worktree or clone: \"pick up the work from the deleted worktree\", \"continue artifact <id> here\", \"hand this thread to another checkout\" (restores from the home-dir archive when enabled). For broader survey questions (\"what's the state of this branch?\", \"show me what's going on\") prefer `orcaops status` instead. Skip for: archive mirror health (`orcaops archive status`)."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "dfc8b1fcc0c9"
---

# When to use

Invoke at the **start** of a session that's continuing prior work. The
trigger is **continuation intent** — the user wants to pick a thread
back up, not just survey state.

Match these phrasings:

- "where was I?", "where did I leave off?"
- "pick up where we left off", "continue the work in progress"
- "resume", "continue from where I stopped"
- Cold-start (fresh worktree/clone/machine): "continue artifact <id> in
  this worktree", "pick up the work from the deleted worktree", "hand
  this work off to another checkout"

Do **not** match (use `orcaops status` instead):

- "what's the status of <branch>?", "what's going on?"
- "show me what's in flight", "what's the state of work?"

These are survey questions — `orcaops status` returns the full thread
state across all artifacts, which is the right answer. `resume` is
narrower: it picks one in-flight artifact and produces a paste-ready
continuation prompt.

# How to invoke

```bash
orcaops resume                          # latest active artifact on current branch
orcaops resume --branch feat/x          # specific branch
orcaops resume --artifact <id>          # specific artifact
orcaops resume --json                   # machine-readable
orcaops resume --copy                   # also copy the suggested prompt to clipboard
```

# Interpreting the output

Output sections:

- **Plan steps** — each marked ☑ (done) or ☐ (remaining). Step
  completion is **agent-declared** via each checkpoint's
  `completed_step_ids` field (UUIDv7s, stable across plan
  revisions). The runtime never infers — if a step was completed but
  no checkpoint claimed its step_id, it'll still show as ☐.
- **Plan revisions** — `revision_n` shows how many times the plan
  has been revised; closed-cp completions whose step_ids no longer
  appear in the latest plan surface under "Historic completions"
  (audit-only — the steps themselves were dropped via
  `orcaops capture plan revise`).
- **Top-level `plan_event_id`** (in `--json` mode) — the latest
  plan event_id, suitable for passing forward as
  `plan_revision_id` on the next `orcaops capture checkpoint open`
  to opt into the optimistic-concurrency check.
- **Decisions** — the non-trivial choices and their rationale captured
  across all closed checkpoints, each tagged with its source cp. This is
  the **WHY** a resuming agent inherits: read it before continuing so you
  don't re-derive or silently contradict a decision the prior session
  already made. Also embedded in the suggested prompt ("Decisions made so
  far").
- **Open uncertainty** — unresolved questions raised at checkpoint close
  (deduped across cps, attributed to the cp that raised them). Treat these
  as the first things to resolve or confirm on pickup.
- **Open checkpoints** — any cps that were opened but not yet closed.
  Each shows its declared scope, `agent_session_id` (if any subagent
  attribution), and how long it's been idle. A fresh agent can either:
  (1) close in-flight work that the prior session left open,
  (2) abandon a stale open with a reason, or
  (3) open a new cp on the **uncovered plan steps** (also surfaced in
  the resume output).
- **Suggested prompt** — paste-ready text the user can hand back to you
  ("continue from step N: do X, Y") to re-anchor.

If the branch HEAD is ahead of the last captured checkpoint, you'll see
a "branch is N commits ahead — resume context may be stale" warning.
Surface that to the user; consider asking whether to re-capture before
continuing.

# Cold-start in a fresh worktree (the handoff mechanic)

`orcaops resume --artifact <id>` also cold-starts work this worktree
has never seen — **if the archive is enabled** (`archive.enabled:
true`; without it this path simply doesn't exist and resume reads the
local hot store only). When the hot store lacks the artifact, resume
restores it from the home-dir archive first — the response carries
`restored_from_archive: true` — then the thread continues normally
(checkpoint open → work → close) and new events mirror back to the same
archive automatically.

1. Find the artifact id if unknown — search the archive from anywhere
   (archive-enabled installs only). From inside a repo or linked worktree,
   these commands include both hot and retained archive history for the
   current project; duplicate artifact IDs use the freshest projection
   (archive only when strictly newer, tie to hot):

   ```bash
   orcaops list --all-projects --json
   orcaops search "<task terms>" --all-projects --json
   ```

2. In the TARGET worktree (init'd, `archive.enabled: true`, same
   project identity — worktrees share it automatically via git config):

   ```bash
   orcaops resume --artifact <id> --json
   ```

Failure modes:

- `INVALID_INPUT` mentioning divergence: this worktree holds LOCAL
  events the archive lacks — run `orcaops archive repair` here first
  (mirror the local work), then retry. Handoff is a move, not a fork.
- `UNKNOWN_ARTIFACT`: not in this project's archive — check
  `orcaops list --all-projects --json` for the right project, and that
  this repo shares the source project's identity
  (`git config --local orcaops.projectid`).

# When there are no in-flight artifacts

`orcaops resume` will report "No in-flight artifacts on branch <name>"
(or equivalent) when every artifact on the branch has either a captured
summary or no plan at all.

**Stop. Do NOT re-run the same command, do NOT loop through
`orcaops status` / `show` / `git log` looking for hidden state.**
The runtime is authoritative — there genuinely is no thread to resume.

Instead, present 2-3 options to the user and ask which they want:

1. **Open the PR** for the most recently summarized artifact
   (run `orcaops digest --artifact <id>` first if missing).
2. **Start a new task** — capture a new plan via `orcaops-capture`.
3. **Re-summarize / amend** the most recent closed artifact if the work
   is actually still in flight and the close was premature.

Pick one based on the user's response. The runtime can't infer their
intent here — only the user knows whether the closed artifact is "done"
or "I forgot to checkpoint."
