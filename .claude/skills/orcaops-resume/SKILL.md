---
name: "Orcaops: resume an artifact"
description: "Resume one in-flight artifact with a paste-ready continuation prompt, or cold-start it in a fresh worktree or clone. Use for \"where was I?\", \"pick up where we left off\", or \"continue artifact <id> here\"; a broad branch-status survey is `orcaops status`."
metadata:
  generatedBy: "orcaops@0.3.0"
  contentHash: "e738fbe9de75"
tags: ["orcaops", "read"]
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
orcaops resume                          # contextual focus or the single eligible task
orcaops resume --branch feat/x          # specific branch
orcaops resume --artifact <id>          # specific artifact
orcaops resume --json                   # machine-readable
orcaops resume --copy                   # also copy the suggested prompt to clipboard
```

Resume is passive: it never changes focus, restores files, or binds a task.
When selection is ambiguous, inspect the returned `reason`, labelled
`candidates`, and their eligibility. Use `orcaops resume --artifact <id>`
to read one exact artifact, or `orcaops checkout <id>` to explicitly change
focus. Resume never chooses the newest candidate merely because it is newest.

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

A resumed plan also carries what it was drafted against, in `--json`:
`artifact.knowledge_uses` for the plan events, and
`artifact.open_checkpoints[].knowledge_uses` for what each open checkpoint
opened against. `selected_with_plan` is what the plan itself selected;
`connected_later` is what somebody connected afterwards, and the two stay
apart.

**Check what the plan did not select.** `orcaops status --json` carries a
top-level `applicable_not_selected`: the adopted revisions that apply here
minus the ones the plan in view recorded a use of, each with its `reason` and,
where the plan selected a different revision of the same identity,
`selected_revision_ids` beside it. Read it before continuing — it exists so a
known rule cannot disappear from your view merely because the prior session did
not select it. Its `statement` always says why the list is the length it is;
an empty `entries` with no plan in view means something different from an
empty one with a plan. It is `null` when no single active plan is in view or
history is incomplete, which is not the same as nothing being missed. The field
asks nothing and writes nothing; `orcaops knowledge lookup` is where to read
the rules themselves.

Surface any `repo_state` note before continuing. The current renderer may say
that the working tree is dirty, that commits since `artifact_head_sha` touch
the artifact's files and work may already be partly done, that HEAD moved with
no overlap, or that open items may already be addressed. Use the accompanying
`repo_state` fields to decide what needs rechecking; do not substitute an
older quoted warning.

# Cold-start in a fresh worktree (the handoff mechanic)

`orcaops resume --artifact <id>` can continue work in a fresh worktree from
the canonical project history database. It reads the retained artifact
passively. Follow the returned execution-context guidance before opening a new
checkpoint; reading a resume does not move a task between worktrees.

1. Find the artifact id if unknown by searching canonical history:

   ```bash
   orcaops list --scope all-projects --json
   orcaops search "<task terms>" --scope all-projects --json
   ```

2. In the TARGET worktree (initialized with the same project identity):

   ```bash
   orcaops resume --artifact <id> --json
   ```

If the artifact is unknown, check `orcaops list --scope all-projects --json` for
the right project and verify that this worktree resolves to that project.

# When implicit selection has no eligible artifact

A `NO_ELIGIBLE_ARTIFACT` result means no task is eligible for implicit
selection in this context. It does not mean the project has no retained history;
an exact artifact can still be read with `--artifact`. Read the returned reason
and execution guidance before deciding whether new work is needed.

Do not repeatedly run the same selection looking for a different result.
If the requested task is complete and the user has not already specified what
comes next, ask which outcome they want.

Only after confirming the requested task is complete, present these options if
the user has not already chosen what comes next:

1. **Open the PR** for the most recently summarized artifact
   (run `orcaops digest --artifact <id>` first if missing).
2. **Start a new task** — capture a new plan via `orcaops-capture`.
3. **Start a follow-up artifact** if later or forgotten work remains. A
   summary amendment only corrects the existing summary's wording; it does
   not reopen the plan or make the closed artifact cover new work.

Pick one based on the user's response. The runtime can't infer their
intent here — only the user knows whether the closed artifact is "done"
or "I forgot to checkpoint."
