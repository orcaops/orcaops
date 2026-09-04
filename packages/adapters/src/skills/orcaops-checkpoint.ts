import { ATTRIBUTION_INSTRUCTION } from '../attribution.js';
import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';
import { SECRET_IN_PAYLOAD_ERROR_ROW } from './shared-errors.js';

export const orcaopsCheckpointSkill: SkillTemplate = {
  id: 'checkpoint',
  name: 'Orcaops: capture checkpoint',
  description: 'Open, close, or abandon a work checkpoint with scope, evidence, and verification.',
  tags: ['orcaops', 'capture'],
  body: (prefix: string) => `# Cadence rule

One checkpoint per coherent unit of work is the default — often one
plan step. **Open the checkpoint BEFORE you make any worktree change**
— an edit, a new or deleted file, a rename, generated output, a
formatter run — do the work, then close it with what actually finished.
\`open\` marks the START of the attribution window: Orcaops attributes
review evidence ONLY from the diff between the worktree at open and at
close. Opening first is the only reliable way to get clean per-line
attribution — anything changed before open is outside that window.

**IF A COMMIT IS AUTHORIZED AND INTENDED, COMMIT BEFORE YOU CLOSE.** The full
ordering is: open → make changes → run formatters and tests → stage only this
checkpoint's files → commit → close. A commit belongs inside the window because
a pre-commit hook can rewrite files; a rewrite after close is attributed to
nothing. Do not create a commit merely because you opened a checkpoint, and do
not stage unrelated dirty-worktree or sibling-agent changes. If you
slip and change the worktree before opening, still open and close a
narrowly scoped checkpoint to claim the completed work; never leave real
work uncovered. The two-phase shape also keeps resume granularity and
drift signal sharp — so don't sweep a large fraction of the plan into one
checkpoint.

Concretely:

- \`open\` declares which plan step(s) the cp will cover. The
  \`checkpoint-scope-density\` evaluator blocks opens that grab a
  large fraction of the plan in one beat — that's the cadence guard.
- \`close\` finalizes with summary, decisions, uncertainty, and
  \`completed_step_ids\` (must be a subset of the steps you
  declared at open).
- \`abandon\` cancels an open cp without claiming work. The declared
  steps go back to "uncovered" and can be opened on a fresh cp.

Subagents working in parallel each open their own small-scope cp;
the disjointness rule (declared steps cannot overlap another open
or closed cp) keeps coordination explicit.

# Prerequisites

You need an \`artifact_id\` from a prior \`orcaops capture plan\`. Run
\`orcaops status --json\` to find it if you've lost track.

${ATTRIBUTION_INSTRUCTION}

# 1. \`open\` — declare scope

\`\`\`bash
orcaops capture checkpoint open --input - --invoked-by-agent <your-agent-id> <<'EOF'
artifact_id: a3b1f0c2
declared_step_ids: [01HX0K8N6ZQF8M5R2V8DZ7T3KX]
agent_session_id: subagent-b
plan_revision_id: <latest plan_event_id from resume / status>
EOF
\`\`\`

The response carries the server-assigned \`n\` and echoes the
declared step_ids back:

\`\`\`json
{ "ok": true, "artifact_id": "a3b1f0c2", "n": 1, "status": "open",
  "declared_step_ids": ["01HX0K8N6ZQF8M5R2V8DZ7T3KX"] }
\`\`\`

\`close\` accepts that \`n\` — or **omit \`n\`** to close the single open
checkpoint. With more than one open (concurrent subagents), omitting \`n\`
returns \`AMBIGUOUS_CHECKPOINT\` listing the open \`n\`s so you pick one.

## Required fields on open

| Field | Notes |
|---|---|
| \`idempotency_key\` | **Optional — auto-minted when omitted.** Retrying with \`policy_exceptions[]\` after a block: just omit it and a fresh key is minted (passing the *same* key with a different payload would be a hard \`IDEMPOTENCY_CONFLICT\`). |
| \`artifact_id\` | **Optional — omit to autodetect the single active artifact on the branch** (returns \`AMBIGUOUS_ARTIFACT\` with a \`candidates[]\` list if more than one is active). Pass it from the \`capture plan\` response to be explicit. |
| \`declared_step_ids\` | UUIDv7 step_ids the cp will cover (read from \`resume\` / \`status\` / the original \`capture plan\` response). Non-empty. Must reference step_ids in the latest plan revision; cannot overlap another open cp's declared scope or a closed cp's \`completed_step_ids\` — \`OPEN_CP_OVERLAP\` rejects on conflict. Stable across plan revisions: a revision that drops, inserts, or reorders steps does NOT renumber the IDs you've already declared. |

## Optional fields on open

| Field | Notes |
|---|---|
| \`agent_session_id\` | Subagent attribution. Surfaces in \`status --json\`, \`resume\`, and the digest. |
| \`policy_exceptions[]\` | Inline pre-write block resolution. Each entry names a checkpoint-open evaluator whose spec sets \`resolution.policy_exception.enabled: true\` and gives a reason. The exception is recorded on the open cp; doctor surfaces persistent dismissals. |
| \`plan_revision_id\` | Optimistic-concurrency token: the latest \`plan_event_id\` you observed (in \`resume\` / \`status\`). Pass null to skip the freshness check (lower-friction race-tolerance opt-out). With a non-null token, \`STALE_PLAN_REVISION\` rejects if a newer plan event has been committed since you read. |

## When the open is blocked

The \`checkpoint-scope-density\` evaluator runs pre-append. If it blocks:

1. **Re-issue with smaller scope** (preferred). Pick one or two
   plan steps to cover; the rest land on follow-up cps.
2. **Retry with \`policy_exceptions[]\`** if the batching is genuinely
   intentional. Just **omit \`idempotency_key\`** — each call auto-mints a
   fresh one, so the retry (a different payload) won't collide with the
   blocked attempt.
   \`\`\`bash
   orcaops capture checkpoint open --input - --invoked-by-agent <your-agent-id> <<'EOF'
   artifact_id: a3b1f0c2
   declared_step_ids:
     - 01HX0K8N6ZQF8M5R2V8DZ7T3KX
     - 01HX0K8N6ZQF8M5R2V8DZ7T3LY
     - 01HX0K8N6ZQF8M5R2V8DZ7T3MZ
     - 01HX0K8N6ZQF8M5R2V8DZ7T3N0
   policy_exceptions:
     - evaluator: core/checkpoint-scope-density
       reason: |-
         trivial mechanical rename across 4 steps; one beat
   EOF
   \`\`\`

# 2. \`close\` — finalize

\`\`\`bash
orcaops capture checkpoint close --input - --invoked-by-agent <your-agent-id> <<'EOF'
artifact_id: a3b1f0c2
summary: |-
  Wired Redis sliding-window middleware. Token-bucket; reused the
  existing redis client. Newlines, "quotes", and colons: literal in here.
files_changed: ["src/middleware/rateLimiter.ts"]
completed_step_ids: [01HX0K8N6ZQF8M5R2V8DZ7T3KX]
decisions:
  - decision: |-
      token bucket over fixed window
    reason: |-
      Fixed window allows burst-at-boundary; the bucket smooths it.
    alternatives_considered:
      - option: |-
          fixed-window counter
        rejected_because: |-
          allows a 2x burst across the window boundary
uncertainty:
  - "TTL strategy if multi-region Redis is added later"
done_criteria:
  - criterion_id: 01HX0K8N6ZQF8M5R2V8DZ7T4AA
    evidence: |-
      The limit-exceeded integration test passes and asserts HTTP 429.
verification:
  - command: "pnpm test rateLimiter"
    exit_code: 0
    output_digest: "9 tests passed"
EOF
\`\`\`

(\`summary\` / \`reason\` / \`decision\` are free text → \`|-\` block scalars;
\`files_changed\` / \`uncertainty\` items are quoted because a path or note may
contain a colon-space or look numeric; \`completed_step_ids\` are UUIDs → plain.
YAML would otherwise coerce \`0123\` to a number or read a colon-space as a map.)

**Read \`warnings[]\` on EVERY response — open, close, and abandon.** All three
can return a non-blocking \`warnings[]\` array (separate from
\`evaluator_results\`; the call still succeeds). Three codes matter:

- \`empty-diff-window\` (close): the cp closed with an empty open-to-close diff
  even though it reported changed files — the work landed *before* this cp was
  opened, so it falls outside the attribution window. Act on it: claim what's
  done, then open the next checkpoint BEFORE your next worktree change.
- \`snapshot-capture-failed\` (open, close, or abandon): the git snapshot behind
  this boundary did NOT capture, and the message carries the raw git error.
  Capture is fail-open, so the checkpoint itself committed — but the work in
  this window will get NO per-line attribution, and a failed OPEN also leaves
  the close with nothing to diff against. Do not ignore it: report the git
  error to the user — a silent snapshot failure quietly forfeits attribution
  for the entire window and stays invisible until someone needs the history.
- \`unmerged-paths-degraded\` (open, close, or abandon): the git index had
  unresolved merge conflicts at this boundary. The snapshot still captured —
  attribution is PARTIAL, not lost: the named paths are excluded from exact
  per-line attribution and every other file attributes normally. Tell the
  user which paths are affected and resolve the conflicts (\`git add <path>\`
  after editing, or \`git merge --abort\`) before the next boundary so the
  exclusion set stops growing. (A rare sibling, \`unmerged-probe-failed\`,
  means conflict detection itself was unavailable at a boundary — the window
  is durably marked unverified via \`attribution_degraded.probe_failed\` and
  must be treated as unverified, not clean.)

## Required fields on close

| Field | Notes |
|---|---|
| \`idempotency_key\` | **Optional — auto-minted when omitted.** |
| \`artifact_id\` | **Optional — autodetected** (same as open: the single active artifact on the branch); pass it to be explicit. |
| \`n\` | **Optional — omit to close the single open checkpoint.** Pass the \`n\` from \`open\` to be explicit; required only when more than one cp is open (else \`AMBIGUOUS_CHECKPOINT\`). |
| \`summary\` | 1-3 sentences describing what changed and why. |
| \`completed_step_ids\` | Must be a **subset** of the open's \`declared_step_ids\` (subset, not equality — agents discover scope mid-step). Steps that were declared but not completed silently fall through and can be claimed by a follow-up cp. |
| \`done_criteria[]\` | Required when a completed step has acceptance criteria. Include one \`{ criterion_id, evidence }\` entry for every criterion on each completed step. A completed step with no criteria needs no entries. |
| \`verification[]\` | Required whenever a non-imported close claims a completed step. Cite at least one command run fresh at close with its exit code. Git-import artifacts are exempt because inventing fresh verification for historical work would be false. |

## Uncertainty section

Promote uncertainty out of "optional" — every non-trivial cp should
populate at least one entry. Concrete prompts:

- An interface choice you weren't sure about.
- A data shape you guessed at.
- A behavior you couldn't verify without running it.

\`uncertainty[]\` flows into the digest; reviewers read it. Empty
\`uncertainty\` on a 35-file cross-package cp is not credible.

**Uncertainty → test.** Before closing, ask of each entry: can this be
turned into a test RIGHT NOW? An uncertainty that is mechanically
checkable ("does X handle empty input?") is cheaper as a test in this
same checkpoint than as a recorded worry — write it, cite it in
\`verification\`, and drop the entry. Record only what genuinely cannot
be verified yet.

## Decisions section

Decisions are as load-bearing as uncertainty — promote them out of "optional".
A reviewer (and the next agent, via \`orcaops resume\` / \`orcaops why\`) inherits
the WHY from here. Record a \`{decision, reason}\` whenever:

- you made a **choice where you rejected a viable alternative** — capture the
  rejected option(s) in \`alternatives_considered: [{option, rejected_because}]\`
  (the rejected path often tells a reviewer more than the chosen one);
- you **diverged from the plan**, and why;
- you **adopted an existing pattern over building new** — that still counts as a
  decision, even though it feels like the default.

\`decisions[]\` flows into the digest, resume, and \`why\`. Architectural choices
are usually made in *plan mode* — capture those up front via the \`decisions\`
field on \`orcaops capture plan\` (see the ${skillRef('capture', prefix)} skill); use this
checkpoint field for choices made while doing the work. Shape:
\`{decision, reason, alternatives_considered?: [{option, rejected_because}]}\`.

## Other optional fields

| Field | Notes |
|---|---|
| \`files_changed\` | Files modified at THIS cp (not cumulative). **When checkpoint windows overlap** (parallel agents or a human editing alongside), this list is the ATTRIBUTION CLAIM: boundary snapshots attribute exclusive-interval changes conclusively, but genuinely concurrent changes are arbitrated by each checkpoint's \`files_changed\` — report it accurately and completely (an omission can cost the claim; an over-claim is rejected and flagged when evidence contradicts it). |

## Verified close

Transcript evidence evaporates; the \`verification[]\` field persists it.
When a close claims completion (\`completed_step_ids\` or \`done_criteria\`
non-empty), run the proving command FRESH and cite it:

\`\`\`yaml
verification:
  - command: "pnpm test"
    exit_code: 0
    output_digest: "turbo 23/23 tasks successful"
\`\`\`

The rule: cite what you actually ran, exit code included. A FAILING
command is honest evidence — record the non-zero exit and say where the
failure stands in \`summary\`/\`uncertainty\` rather than omitting the run.
The store rejects completion claims with no cited evidence and deliberately
accepts non-zero exits so failure is never punished into silence.

For a partial close that claims no completed steps, omit both
\`done_criteria\` and \`verification\`. For a completed step with no acceptance
criteria, omit \`done_criteria\` but still include \`verification\`. Only a
\`git-import\` artifact may claim a completed step without fresh verification.

# 3. \`abandon\` — cancel without claiming work

When to use:

- A subagent dispatch failed before meaningful work happened.
- The work span was cancelled (parent decided to re-scope).
- You opened too eagerly and want to release the declared steps.

\`\`\`bash
orcaops capture checkpoint abandon --input - --invoked-by-agent <your-agent-id> <<'EOF'
artifact_id: a3b1f0c2
n: 3
reason: |-
  subagent-c timed out before starting work
EOF
\`\`\`

\`reason\` is required and surfaces in the digest. Abandon does not
fire any evaluators — it's bookkeeping.

# Dispatching subagents

Pattern: parent does \`capture plan\` → dispatches subagents each with
the artifact_id and a disjoint subset of step_ids. Step_ids are
revision-stable, so a parent revising the plan mid-flight does not
re-shuffle in-flight cps' declared scopes.

1. Parent: \`capture plan\` returns artifact_id \`abc\` and the
   \`plan_steps\` array (each with \`step_id\` + \`idx\` + \`text\` + \`label\`).
2. Parent dispatches subagent-a on step_ids [\`STEP1_ID\`, \`STEP2_ID\`]
   and subagent-b on step_id [\`STEP3_ID\`].
3. subagent-a: pipe \`declared_step_ids: [STEP1_ID, STEP2_ID]\` and
   \`agent_session_id: subagent-a\` through the supported \`--input -\` heredoc →
   work → close with \`completed_step_ids\` contained in that set.
4. subagent-b in parallel: pipe \`declared_step_ids: [STEP3_ID]\` and
   \`agent_session_id: subagent-b\` through its own \`--input -\` heredoc → work
   → close.

If a subagent's \`open\` returns \`OPEN_CP_OVERLAP\`, retry with
non-overlapping scope or signal back to the parent. If two subagents
must touch the same plan step, the parent revises the plan (\`orcaops
capture plan revise\`) to split that step before re-dispatch — overlap
is a coordination bug, not a soft policy.

# Counter-examples

- **Don't change the worktree before opening the checkpoint.** That is
  the failure mode: open and close see the same worktree, the diff is
  empty, and you don't get clean per-line attribution for the work. If
  you've already made this mistake, don't abandon the step or leave it
  uncovered; open and close a narrowly scoped checkpoint to claim the
  completed step, then open the next checkpoint before any further worktree
  changes. This cleanup is not the normal cadence: open first, change the
  worktree, then close.
- **Don't open declaring all 9 plan step_ids.** That's the cadence
  anti-pattern \`checkpoint-scope-density\` exists to catch.
- **Don't open without intending to close** before context-switching.
  An orphan open blocks \`finish\`, and any
  \`plan revise\` that would drop the declared step_ids. (Opening before
  the work is still correct — if you must context-switch, \`abandon\`
  rather than delay the next open.)
- **Don't \`close\` with empty \`completed_step_ids\`.** Abandon
  instead; the work didn't materialize.
- **Abandon only when no work happened, or the declared work no longer
  applies.** If work happened before the checkpoint was opened, close to
  claim the completed step — don't abandon merely because the diff window
  is empty.

# Errors

| Code | Meaning |
|---|---|
| \`UNKNOWN_ARTIFACT\` | Wrong \`artifact_id\`. Check \`orcaops status --json\`. |
${SECRET_IN_PAYLOAD_ERROR_ROW}
| \`OPEN_CP_OVERLAP\` | A declared step_id is already covered by another open or a closed cp. Re-issue with smaller scope or revise the plan to split the step. |
| \`STALE_PLAN_REVISION\` | The \`plan_revision_id\` you passed is no longer the latest plan event for the artifact. Re-read \`resume\` / \`status\`, retry with the fresh token. (Skip by passing \`null\` if you accept the race.) |
| \`INVALID_INPUT\` (path: \`declared_step_ids\`) | Step_id not present in the latest plan revision, duplicate within the array, or empty array. |
| \`INVALID_INPUT\` (path: \`completed_step_ids\`) | Step_id duplicate within the array, or not a subset of the open's \`declared_step_ids\`. |
| \`INVALID_INPUT\` (path: \`policy_exceptions\`) | Named evaluator is not a checkpoint-open evaluator or its spec has \`resolution.policy_exception.enabled: false\`. Re-scope the open or use \`block dismiss\` after-the-fact. |
| \`IDEMPOTENCY_CONFLICT\` | Same key, different payload. Mint a fresh key. |
`,
};
