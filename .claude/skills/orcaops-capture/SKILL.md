---
name: "Orcaops: capture plan"
description: "Capture or revise a coding-task plan, minting stable step IDs and running plan checks."
metadata:
  generatedBy: "orcaops@0.1.1"
  contentHash: "4bb90a5a0abc"
tags: ["orcaops", "capture"]
---

# When to use

Use this skill at the **start** of any non-trivial coding task — and any
time the plan needs to evolve mid-flight
(`orcaops capture plan revise`).

Skip for: typo fixes, single-line edits, or follow-up work where an
active plan already exists for the current branch and no revision is
warranted.

# Attribution: declare your agent id

Every artifact-writing command accepts `--invoked-by-agent <your-agent-id>`.
Pass YOUR OWN id — one of: claude-code, cursor, codex, opencode, aider, github-copilot, antigravity-cli, other — so each
plan / checkpoint / summary event records which agent actually produced
it (this is how multi-agent repos keep provenance trustworthy). Never
copy another agent's id from an example. When the flag is omitted,
orcaops falls back to `ORCAOPS_INVOKED_BY_AGENT`, then best-effort
environment detection, then `other`.

# How to know whether a plan already exists

Always run `orcaops status --json` first. If `artifacts[]` is non-empty
and one has `thread.plan.status === "done"` with no `thread.summary.status`
of "done" yet, the branch has an active artifact — load it via
`orcaops resume`, then EITHER continue with **orcaops-checkpoint**:
open a checkpoint before you change the worktree for each chunk, then
close it after with what actually finished (optionally dispatching
subagents on disjoint scopes)
OR revise the plan via the `revise` subverb below if the work has
uncovered new steps. Don't capture a fresh plan on a branch that
already has an active artifact.

# Pre-step: prior-art sweep (plan-critique)

If the `orcaops-plan-critique` skill is installed, invoke
it BEFORE drafting a non-trivial plan. With the archive enabled it mines
every archived project; otherwise it searches the current repository.
Relevant decisions, rejected alternatives, non-goals, and unresolved
uncertainty slot directly into the fields below. Skip it for trivial tasks
or when the skill is not installed.

# Initial capture (`orcaops capture plan`)

1. Draft your plan internally (task description, ordered steps, scope tags).
2. Pipe the plan as **YAML** to `orcaops capture plan` on stdin. YAML coerces
   unquoted scalars (`0123` parses as the number 123, `true` as a boolean) and
   reads a colon-space as a nested mapping — both make a strict string field
   reject your input. So make every **human-authored string** safe: use a `|-`
   block scalar for any free-text value (`task`, `label`, step `text`,
   `rationale`, and likewise `reason` / `summary` / `outcome` / `decision` /
   `evidence` in the other capture commands), and **quote** every string **list
   item** that could contain a colon-space or look numeric/boolean
   (`touched_scope`, `files_changed`, `tests_run`, `source_refs`, …). Only
   machine IDs (UUID `step_id`s) and enum values are safe to leave plain:

   ```bash
   orcaops capture plan --input - --invoked-by-agent <your-agent-id> --source-plan docs/slice-plan.md <<'EOF'
   task: |-
     add rate limiting to /api/charge
   label: |-
     rate limit /api/charge
   plan_steps:
     - text: |-
         implement Redis sliding-window middleware in Express
       label: |-
         Redis sliding-window middleware
       acceptance_criteria:
         - text: |-
             the middleware returns HTTP 429 when the configured limit is exceeded
     - text: |-
         mount the new middleware on /api/charge
       label: |-
         Mount on /api/charge
     - text: |-
         add tests for the limit-exceeded path
       label: |-
         Tests for limit-exceeded path
   touched_scope: ["payments", "infra"]
   non_goals:
     - text: |-
         do not change the existing auth middleware
       rationale: |-
         auth is a separate slice
     - text: |-
         no schema migration on the charges table
       rationale: |-
         schema is frozen this slice
       source_refs: ["section 2.3"]
   decisions:
     - decision: |-
         use a Redis sliding-window over a fixed-window counter
       reason: |-
         fixed windows allow a 2x burst at the boundary; sliding-window is smooth
       alternatives_considered:
         - option: |-
             in-memory token bucket
           rejected_because: |-
             not shared across instances; breaks under horizontal scaling
   EOF
   ```

The `--source-plan <path>` flag: **if a plan document exists anywhere, pass
it.** It reads and hashes the file at capture time and pins it immutably on
the artifact, so the plan-conformance evaluators can grade the captured plan
against what the slice actually asked for.

- **Out-of-repo paths are fully supported.** A plan in your agent's planning
  directory (e.g. `~/.claude/plans/my-plan.md`) or any absolute path works.
  The file does NOT need to be inside the repo, committed to git, or kept
  after capture — the pinned content hash is what persists. "The plan file is
  outside the repo" is never a reason to skip the pin.
- Relative paths resolve against your cwd first, then the repo root; `~` expands.
- **A bad path cannot damage anything.** The capture aborts loudly BEFORE any
  artifact state exists, with did-you-mean suggestions on a near miss. Fix the
  path and retry WITH the flag — never respond to a path error by re-running
  without it: that silently downgrades the artifact to unpinned, and the digest
  flags the absence.
- **If the plan lives only in conversation, write it — verbatim, not a
  restatement — to a temp file and pin that.** The file only needs to exist at
  capture time; the pinned content hash is what persists. If your planning tool
  already produced a plan file, pin that file directly instead of transcribing
  it. The pin happens at initial capture only — there is no adding it later.

The runtime mints a stable UUIDv7 `step_id` for each entry and
returns them in the response `plan_steps` array along with the
display ordinal `idx` and the agent-supplied `label`. **Save the
response** — every subsequent `capture` / `revise` / `checkpoint`
call references step_ids, not labels or ordinals. The response also
carries `revision_n: 0` and a `plan_event_id` you can pass forward
as the `plan_revision_id` optimistic-concurrency token on cp-open.

## Required fields (initial capture)

| Field | Notes |
|---|---|
| `idempotency_key` | **Optional — auto-minted (UUIDv7) when omitted**, so you normally don't pass it. Supply one explicitly only for replay-safe retries: reusing the same key makes a retried call dedup as a replay instead of minting a new artifact. **On initial capture the match is key-only**: a reused key replays the FIRST artifact and silently ignores the plan you just sent, even if it is completely different. It never raises `IDEMPOTENCY_CONFLICT`. If you are retrying with an EDITED plan, mint a fresh key, or capture once and use `plan revise`. |
| `task` | One-sentence description of the work |
| `label` | **Plan-level short headline** — 1-line human-readable name for the whole capture thread (1–70 chars, no newlines/tabs, trimmed). Distinct from the longer `task`. Surfaces in lists, digests, and downstream PR titles. The `plan-label-quality` evaluator (severity: warn) flags labels that are too short, generic ("fix", "wip", "cleanup", etc.), or just the leading slice of `task`. |
| `plan_steps` | Ordered list of step objects (~3-7 entries), each `{ text, label, acceptance_criteria? }`. The runtime mints stable UUIDv7 step_ids per entry. `label` is a short-form description (1-line TL;DR per step); see the `label` notes below. **`acceptance_criteria`** (optional) is a list of `{ text }` rubric items whose evidence the store requires when the step is claimed complete; the runtime mints a stable `criterion_id` per entry and returns them in the response (key `done_criteria` to them at checkpoint-close). A step with no criteria has no criterion-evidence requirement. |
| `touched_scope` | Tags like `auth`, `payments`, `pii`, `refactor`, `docs`. Used to filter evaluators. Empty array is fine. |
| `non_goals` | Things this plan is intentionally **not** going to do — **structured** `{ text, rationale, source_refs? }`. `text` (the exclusion) and `rationale` (the *why*) are both required and non-blank; `source_refs` is optional (free-form strings naming the source-plan item(s) you're excluding, e.g. `"section 2.3"`). Surfaces in plan / resume / digest; checked at checkpoint-close by `non-goals-violated`. |
| `decisions` | **Optional** plan-time decisions — the load-bearing architectural choices made up front, **structured** `{ decision, reason, alternatives_considered? }` (where `alternatives_considered` is a list of `{ option, rejected_because }`). Capture **a choice where you rejected a viable alternative**, **a divergence from the source plan**, or **adopting an existing pattern over building new** (that still counts). The runtime stamps each with the plan `revision_n`; surfaces in plan.md / digest / resume / `why`. Append-only across revisions — a `revise` supplies only the NEW decisions. |

Optional: `branch` (defaults to current git branch), `agent_session_id`,
and the `--source-plan <path>` **flag** (not a JSON field) — see above.

### About `label`

The `label` is a **short-form description** of the step — a 1-line
human-readable TL;DR of `text`. Think of it as the headline you'd
write next to a checkbox in a checklist. Display surfaces (resume,
show, digest) render it alongside `text` so a reader can scan
labels in a long plan without parsing every `text` body.

`step_id` is the immutable canonical identifier used by every
machine reference (checkpoint `declared_step_ids` /
`completed_step_ids`); `label` is for human display only and is
freely renamable across revisions.

Format:

- Prose. Letters, digits, spaces, and common punctuation are all fine.
- 1–70 chars.
- No newlines or tabs; no leading or trailing whitespace.
- **Unique within a plan revision.** Two steps cannot share a label;
  duplicates are rejected with `INVALID_INPUT` (`path: plan_steps[i].label`).

Aim for ~3-8 words. If `label` and `text` are identical the
display surfaces collapse to a single rendering, but a meaningfully
shorter label is the point — write `text` as the full intent
statement and `label` as the headline.

# Revising the plan (`orcaops capture plan revise`)

When work uncovers new steps, the plan needs to change to add /
drop / reorder / rewrite. **Don't start a fresh artifact** for
this — chain a `plan revise` onto the existing one. The revision
is an append-only event; checkpoints' completion claims survive
because they reference stable step_ids, not ordinals.

```bash
orcaops capture plan revise --input - --invoked-by-agent <your-agent-id> <<'EOF'
artifact_id: a3b1f0c2
label: |-
  rate limit /api/charge (with config)
rationale: |-
  Discovered we need a config-loader pass before mounting the middleware.
prior_plan_event_id: <plan_event_id from resume / status>
plan_steps:
  - step_id: <existing step_id>
    text: |-
      implement Redis sliding-window middleware in Express
    label: |-
      Redis sliding-window middleware
  - text: |-
      load rate-limit config from env
    label: |-
      Load rate-limit config
  - step_id: <existing step_id>
    text: |-
      mount the new middleware on /api/charge
    label: |-
      Mount on /api/charge
  - step_id: <existing step_id>
    text: |-
      add tests for the limit-exceeded path
    label: |-
      Tests for limit-exceeded path
touched_scope: ["payments", "infra"]
non_goals:
  - text: |-
      do not change the existing auth middleware
    rationale: |-
      auth is a separate slice
  - text: |-
      no schema migration on the charges table
    rationale: |-
      schema is frozen this slice
    source_refs: ["section 2.3"]
decisions:
  - decision: |-
      load rate-limit config from env before mounting
    reason: |-
      discovered the middleware needs configurable thresholds per route
EOF
```

(`--source-plan` is **not** accepted on revise — the pin is frozen at
initial capture and immutable thereafter.)

## Required fields (revise)

| Field | Notes |
|---|---|
| `idempotency_key` | **Optional — auto-minted when omitted.** If you do pass one: same key + same payload replays; same key + different payload is `IDEMPOTENCY_CONFLICT`. |
| `artifact_id` | From the prior `capture plan` response. |
| `label` | **Plan-level short headline for the new revision.** Required on every revise (no implicit carryover from the prior revision) — relabeling is the supported way to update the thread headline as scope evolves. Same constraints as the initial-capture `label`. The `plan-label-quality` evaluator re-runs on revise. |
| `plan_steps` | Full new plan in display order. Each entry: `{ step_id?, text, label, acceptance_criteria? }`. **Include `step_id`** for steps you're carrying forward (with the original or rewritten text); **omit `step_id`** to mint a new one for steps being added. `label` (per-step short-form description, 1-line TL;DR) is always required (caller supplies it on every entry, including carryovers — relabeling is a normal revise action). Order is the new display order — reordering is just a position change. **`acceptance_criteria`** is full-supersede like the steps: each entry `{ criterion_id?, text }` — carry a `criterion_id` to preserve a criterion explicitly (it must have existed on the **same** step in the prior revision, else `INVALID_INPUT`), or **omit it** — an omitted criterion whose `text` is byte-identical to an unchanged prior criterion on the same step auto-carries that prior id (so restating unchanged criteria never churns their identity, and recorded `done_criteria` evidence stays bound), and only an omitted criterion whose text has no prior match mints a new id. Omitting the array drops that step's criteria. |
| `rationale` | Required, non-empty. Why the plan changed. The `revision-rationale-required` evaluator (severity: block) rejects empty / near-empty rationales. |
| `prior_plan_event_id` | Optimistic-concurrency token: the latest `plan_event_id` you observed. Read it from the **top-level** `plan_event_id` field on `orcaops resume --json` (also returned at the top level of the previous capture / revise response). Pass `null` to skip the freshness check. |
| `touched_scope` | New touched_scope set. Adding a sensitive tag triggers `revision-touched-scope-stable` warn. |
| `non_goals` | New non-goals set — **structured** `{ text, rationale, source_refs? }` (same shape as initial capture; `text` + `rationale` required non-blank). Removing a non-goal triggers `revision-non-goals-stable` warn. |
| `decisions` | **Append-only**: supply only the NEW plan-time decisions this revision adds (base shape `{ decision, reason, alternatives_considered? }`, no `revision_n` — the write path stamps it and cumulates onto the prior set, so the latest plan holds the full history). Unlike `plan_steps` / `non_goals` (full-supersede), a decision is never erased by a later revision — a reversal is a NEW decision that references the change. |

## Optional fields (revise)

| Field | Notes |
|---|---|
| `acknowledge_drops_completed_steps` | Required to drop a step_id that a closed cp claimed in `completed_step_ids`. List the dropped step_ids explicitly; otherwise the call is rejected with `PLAN_REVISION_UNACKNOWLEDGED_DROPS`. The historic completion record stays in the audit trail. |
| `acknowledge_criteria_changes` | Required to remove an acceptance criterion from a step with an open checkpoint or a completed claim; list each removed `criterion_id` or the revision is rejected. Adding or rewriting criteria, or rewriting step text, is rejected on open or completed steps because it would change the obligation under active or historical evidence. Close without claiming the affected open step, or abandon it, before revising and reopening; for completed work, create a new step for the new obligation. Label-only edits remain allowed. |

## Decision rubric: revise vs. fresh artifact

- **Revise** when the *task* and *non_goals* are unchanged but the
  *steps* drift. Discovered work, scope clarification, refined
  approach — these are all revisions.
- **Start a fresh artifact** when the *task* itself changes (you're
  pivoting to different work) or the branch is being repurposed.

# Cross-step criterion moves (advisory)

A revise that REMOVES a criterion's text from one surviving step and mints
the identical text on a different step returns a non-blocking
`criterion_move_warnings` entry (`kind: "cross-step-criterion-move"`,
with the source step, destination step, text, and the minted
`criterion_id`). Nothing is wrong if the move was deliberate — but the
minted criterion has a NEW id: cross-step `criterion_id` reuse is
forbidden by the revise API, so `done_criteria` evidence recorded against
the removed criterion stays with the old step's history and does not
transfer. The advisory is deliberately narrow: ambiguous pairings
(duplicate texts), dropped source steps, and boilerplate texts carried on
other steps never warn.

# How to interpret the response

Both `capture plan` and `capture plan revise` return the same
envelope shape:

```json
{
  "ok": true,
  "artifact_id": "a3b1f0c2",
  "revision_n": 0,
  "label": "rate limit /api/charge",
  "plan_steps": [
    { "step_id": "01HX...", "idx": 1, "text": "implement Redis sliding-window middleware in Express", "label": "Redis sliding-window middleware" },
    ...
  ],
  "evaluator_results": [
    { "evaluator_ref": "core/plan-mentions-tests", "severity": "warn",
      "run_status": "completed", "verdict": "pass", ... },
    { "evaluator_ref": "core/revision-rationale-required", "severity": "block",
      "run_status": "completed", "verdict": "pass", ... }
  ],
  "blocking": false
}
```

`revision_n` is the new revision counter (0 on initial; 1+ on
revisions). The top-level `plan_event_id` is the latest plan event_id, suitable
for passing forward as `plan_revision_id` on the next cp-open.

For each completed `evaluator_result` with `verdict: "violation"`:
- **severity: warn** — address the concern, then either retry or
  acknowledge in a follow-up. The capture itself succeeded.
- **severity: block** — the call already failed (the evaluator's
  pre-write block triggered). Read `body` and the evaluator's
  `## on_block` section. Either rewrite, or resolve via
  `orcaops block acknowledge` / `orcaops block dismiss`.

When `blocking: true` is set, do **not** start the work until resolved.

# Errors

```json
{ "ok": false, "error": { "code": "INVALID_INPUT", "message": "...", "path": "plan_steps" } }
```

| Code | Meaning |
|---|---|
| `INVALID_INPUT` | Fix the JSON shape and retry. |
| `SECRET_IN_PAYLOAD` | A field carries a recognizable credential. The payload shape is fine — rewrite the narrative to DESCRIBE the credential instead of quoting it (`the deploy token from the env`), then retry. `secret_findings` names every offending field and its key prefix; nothing was written, pushed, or snapshotted. |
| `UNINITIALIZED` | Repo isn't set up; the user needs to run `orcaops init`. |
| `NOT_A_REPO` | Cwd isn't a git repo. |
| `UNKNOWN_ARTIFACT` | (revise only) wrong `artifact_id`. Check `orcaops status --json`. |
| `IDEMPOTENCY_CONFLICT` | Same `idempotency_key` was used by a prior call with a different payload. Mint a fresh key. Raised by `plan revise` and by the artifact-scoped writes (checkpoint, summary, evaluator-run, block) — **not** by initial `capture plan`, which matches on the key alone and replays instead (see `idempotency_key` above). |
| `ARTIFACT_FINALIZED` | (revise only) `summary_captured` already fired — the PLAN is frozen post-summary. Running pre-pr-check does NOT finalize; revise freely before summary. Start a fresh artifact. (The summary itself is not frozen — amend it via `capture summary` with a `prior_summary_event_id` token; see the summary skill.) |
| `STALE_PLAN_REVISION` | (revise only) `prior_plan_event_id` is no longer the latest plan event. Re-read resume/status, retry with the fresh token. |
| `PLAN_REVISION_OPEN_CP_CONFLICT` | (revise only) you're dropping a step_id an open cp declares. Abandon the cp first, or revise without dropping that step_id (text-only rewrites are fine). |
| `PLAN_REVISION_UNACKNOWLEDGED_DROPS` | (revise only) you're dropping a step_id that a closed cp claimed without listing it in `acknowledge_drops_completed_steps`. Add the explicit acknowledgement and retry. |
| `PLAN_REVISION_UNACKNOWLEDGED_CRITERIA_CHANGES` | (revise only) you're removing or rewriting an acceptance criterion on a step with an OPEN checkpoint without listing its `criterion_id` in `acknowledge_criteria_changes`. Add the acknowledgement (you're changing the rubric under active work) and retry. |
| `PLAN_REVISION_INPUT_INVALID` | (revise only) duplicate step_ids or duplicate labels in input, or step_id absent from prior plan. Fix the JSON. |
| `INTERNAL` | Log it to the user; don't retry blindly. |


## Capture sync signal

Every capture command returns a `cloud_sync` object. Branch on `cloud_sync.status`:

- `"ok"` or `"skipped"` — nothing to do. Continue.
- `"paused"` — this artifact was NOT recorded and it will not fix itself. **STOP and tell the user.** Quote `cloud_sync.message` and `cloud_sync.action` verbatim; `cloud_sync.pending` is how many artifacts are waiting locally. Do NOT re-run the capture hoping it clears: a replay writes nothing new, and the fault needs the remediation in `cloud_sync.action`.
