import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * Task Review: the ROUTINE two-lens review PROGRAM plus the reviewer-comment
 * loop.
 *
 * THE SKILL IS THE REVIEW PROGRAM. Every model-facing instruction — the two
 * passes, their bounds, sequencing, repair behavior, effort level, and the
 * causal-Story curation language — lives in this file. The host LLM follows it
 * and authors every model-generated output; the Orcaops CLI is deterministic
 * infrastructure (dossier, lane inputs, ordering, validation caps, ownership
 * derivation, merge, render) and never invokes a model directly or by proxy.
 */
export const orcaopsTaskReviewSkill: SkillTemplate = {
  id: 'task-review',
  name: 'Orcaops: task review',
  description:
    'Generate the Orcaops Task Review for a branch, anchor its reasoning to changed code, or address its comments. Select it only for an Orcaops or Task Review request, or the explicit reasoning-anchor action: "generate the Orcaops Task Review", "anchor the review reasoning to code", or "address the open Task Review comments".',
  tags: ['orcaops', 'review'],
  group: 'review',
  defaultEnabled: true,
  blockTriggerLine: (prefix: string) =>
    `Orcaops Task Review ("generate the Orcaops Task Review", "anchor the review reasoning to code", "address the open Task Review comments") → \`${skillRef('task-review', prefix)}\``,
  body: (prefix: string) => `# When to use

Use this skill to generate the routine two-lens Task Review for a branch,
or to address open reviewer comments. For an adversarial claims audit use
${skillRef('adversarial-review', prefix)}; for a shareable PR summary use
${skillRef('digest', prefix)}.

# The contract

This is a BOUNDED ROUTINE REVIEW, not an exhaustive audit. You are the
review program's executor: you author both passes yourself, in your normal
execution mode — never request deep-research, high-effort, or extended
reasoning modes for a routine review, and do not spawn subagents for it.
The CLI builds inputs, enforces pass order and output caps, validates,
derives code ownership, merges, and renders — it never calls a model, and
you never call one through any other CLI. Never edit files under
.orcaops/reviews/ by hand.

Reading discipline for both passes: a SINGLE ORDERED PASS over the served
payload file. Read every chunk once, in order — multiple Read calls over
that one file are expected for a long payload, but read each region exactly
once: no re-reads, no skipping, no second linear scan.
Do not write analysis scripts, grep or unpack the payload, recursively
inspect embedded diffs, or
browse the repository, and never attempt complete file or checkpoint
coverage in the forensic lane. Caps are ceilings, never targets: make one
linear pass, report the obvious high-confidence issues you saw, and stop —
returning zero or one finding is preferred to further deliberation, and you
never compare every hunk to optimize a ranking. Done is a feature.

Current routine contract versions are run schema 2, slice state schema 5,
Story review model schema 4, current Story pointer schema 1, durable
review-state version 4, and floor producer version 11.

# Mode A — routine review (forensic-first, two lenses, one reviewer)

## 1. Start — one deterministic turn

    orcaops review routine-start --branch <b> [--execution-profile-json '<json>'] --json

This checks/builds the floor, builds the routine dossier, mints an
immutable run, and returns the forensic payload path + contract in one
envelope. Retain its run_id. Stop if it reports an unhealthy floor;
never bypass the floor-health marker. Zero model calls have happened.

The execution profile is optional, field-level metadata. Supply it only when
the value and provenance are actually known, using nullable fields named
\`host\`, \`host_version\`, \`model\`, \`effort\`, \`launcher_mode\`, and
\`instruction_hash\`. Each known field is
\`{"value":"...","provenance":"CALLER_DECLARED|HOST_REPORTED|EVALUATION_REGISTERED"}\`.
An agent declaration is CALLER_DECLARED; HOST_REPORTED is reserved for metadata
the host actually supplies, and EVALUATION_REGISTERED is reserved for a frozen
human-approved protocol. Leave unknown fields null. Never infer profile facts
from prompts, transcripts, model behavior, or provider branding.

If start returns a size-degradation refusal instead of a payload — code
FORENSIC_TRANSPORT_CEILING (the eligible diff is over the transport
ceiling), ACCOUNT_CORPUS_CEILING (the captured account corpus is over its
own ceiling — it is served whole or not at all, never clipped), or
REVIEW_DIFF_TRUNCATED (the floor already covers only a partial diff) — NO
payload was minted and there is nothing to review. Report the refusal and
its remedy (narrow the review scope, or raise review.max_diff_bytes) and
stop; never fabricate a review over a diff or an account you were not
served.

## 2. Forensic pass — the code alone, before you see the account

Read the file at the served payload_path in one ordered pass: a header
(coverage and degradation status), the changed-file inventory, then the
literal diff — the FULL eligible diff, chunk by chunk in order. That file
is your only input for this pass, and it is capture-blind by construction:
no plan, no checkpoints, no account. Report the obvious high-confidence
concrete behavior-level defects and risks the change itself shows —
at most 3 findings (each claim at most 60 words, severity CRITICAL,
CAUTION, or REVIEW — never INFO) and at most 1 question, each anchored to a changed
file path from the payload. Keep a provisional shortlist while reading; do
not rescan. Rank concrete correctness failures with an observable bad outcome
or reproducible execution path first (including security or data loss), then
specific contract violations and regression paths, then weaker verification
or maintainability observations. When the shortlist is full, replace an item
only with a clearly stronger issue encountered later — never revisit earlier
hunks or compare every hunk.

Use \`file\` for the primary changed path where the defect manifests most
directly. A finding may add \`related_files\` only when its causal chain crosses
other served changed paths: at most 4 unique exact paths from the payload,
each distinct from \`file\`. Omit it (the engine normalizes it to \`[]\`) or use
\`[]\` when the primary path is sufficient; related paths do not permit extra
findings. If the payload carries no implementation code to review,
report that single input-quality finding and move on. Author strictly:

    {"findings": [{"claim": "...", "file": "src/x.ts", "related_files": [],
                   "severity": "CAUTION", "confidence": "HIGH"}, ...],
     "questions": [string | {"text", "file"?}, ...]}

Submit the authored JSON directly on stdin in ONE command — never write
payload files:

    orcaops review routine-submit --branch <b> --run <run-id> --lane forensic --isolation sequential --input - --json <<'EOF'
    {"findings": [...], "questions": [...]}
    EOF

If rejected, fix exactly what the diagnostics name and resubmit ONCE with
the same command — that consumes the forensic lane's independent repair credit. Once the
forensic lane is terminal (accepted, or its repair exhausted) the
response carries the ACCOUNT payload path + contract — follow the
response; never invent commands. The engine refuses account context
before forensic terminality (TWOLANE_ROUTINE_ORDER), which is what keeps
this pass honest.

## 3. Story pass — curate a causal Story from the captured account

Read the file at the account payload_path in one ordered pass. It opens
with a THIS RUN block — facts about the review you are authoring right
now — then the captured account:
ALL in-scope completed checkpoints across ALL floor
artifact threads, each with its decisions, alternatives, and uncertainty,
the plan-step and non-goal index, acceptance criteria with their close
evidence, checkpoint-local verification, evaluator outcome summaries with
expanded exceptions, the claim ledger, and globally unique prompt aliases.
Every completed checkpoint heading carries its \`k#\` alias and every citable
captured record carries its inline \`[c#]\` alias. Use those aliases exactly;
canonical artifact/checkpoint and citation ids are context only. Evaluator
summary counts are context, not citation coordinates.

Everything after the THIS RUN block is a HISTORICAL claim: true when it
was captured, not necessarily true now. Before repeating that something
is untested, unrun, unresolved, or future work, check it against the THIS
RUN facts. A captured question asking whether a review run should happen
is answered by the run you are executing; a captured note that a size
tier is unexercised is answered by the tier in force for this run. This
is narrowly about historical-versus-current-run contradictions — it does
NOT ask you to verify captured claims against the code, which the served
input cannot support. From it, curate exactly one cohesive causal
Story and submit its topology. You author structure and meaning only —
never code ownership; the engine derives which changed rows each Part owns
mechanically and renders them, so the Story payload has no placements, file
anchors, or member target keys.

Curation (this is the review's meaning-making):

- Name and order Acts around the captured problems, decisions,
  alternatives, and uncertainties — the causal shape of the work, NOT its
  filenames or checkpoint names.
- Chronology is provenance and an ordering tie-breaker, NEVER a dependency
  and NEVER the default structure. Put genuine prerequisites before their
  consumers; keep implementation, guards, tests, and later corrections
  together; minimize reviewer context switches.
- A Part may combine checkpoints from different artifacts, plans, and
  times when they are one coherent unit of work. NEVER one Act per plan
  step, and NEVER one Part per checkpoint by default — collapse related
  checkpoints into a Part that carries their shared intent.
- Preserve causal continuity without forcing one topology. Keep prerequisites,
  implementation, validation, and corrections adjacent and explicitly linked:
  one Part when they are inseparable, adjacent Parts when stages are independently
  reviewable, or adjacent Acts only at a genuine conceptual phase boundary.
  State the relationship in the relevant Part or Act interpretations; never
  scatter one causal move into distant, unlinked Story sections.
- Every in-scope COMPLETED checkpoint alias appears in exactly one Part.
  Open or abandoned checkpoint aliases are context only and must
  NOT be Part members — they own no code.
- Each Act and Part has a concise title of at most 8 words. Each Part carries
  the shortest self-contained causal interpretation that states the essential
  behavior and why it matters, grounded in citations, with an 80-word hard
  ceiling. Acts may carry an optional interpretation under the same ceiling.
  Word limits are ceilings, never targets. Avoid incidental hunk narration and
  unnecessary repetition across Story levels, but retain mechanics material to
  behavior or risk. Preserve causal topology; never split or merge Parts merely
  to satisfy a word budget.
- Add at most 3 judgment-call questions (at most 60 words each): the
  genuine decisions a reviewer must adjudicate — not restatements of the
  account. Zero questions is the honest answer when the Story raises none;
  never manufacture one to fill the slot.
- COPY engine-issued \`c#\` aliases VERBATIM from the inline bracketed records
  in the payload, and \`k#\` aliases from checkpoint headings — never construct,
  abbreviate, or edit an alias.
  Every Part needs at least one citation alias.

Final Story self-check — perform all five checks before submitting:

1. Cross-artifact causality. Compare every proposed Part boundary across
   ALL artifact threads. When checkpoints in different artifacts continue,
   validate, correct, or reverse the same causal move, keep the relationship
   explicit and contiguous. Choose the smallest honest topology: one Part for
   an inseparable move, adjacent Parts for independently reviewable stages, or
   adjacent Acts for a real conceptual phase boundary. Keep unrelated work
   separate. Mixed-artifact Parts are permitted,
   not a quota: never merge checkpoints merely to demonstrate cross-thread
   coverage.
2. Final-state reconciliation. Before you surface ANY uncertainty as still
   open — in a Part interpretation or a judgment question — determine its
   FINAL STATE across the ENTIRE floor: all threads and all later
   checkpoints, not merely later checkpoints on the same thread. Reconcile
   it against later decisions, criteria and criterion evidence, verified
   close records, expanded evaluator exceptions or dispositions, and THIS RUN
   facts. Evaluator summary counts are capture-hygiene context, not proof that
   the work passed. A dismissed evaluator violation is historical rather than
   a current block. A concern recorded in one checkpoint and resolved in
   another — even a different artifact thread — is RESOLVED and must NOT be
   re-raised as open. Only genuinely unresolved-at-head uncertainties belong
   in an open interpretation or a judgment question.
3. Historical-claim discipline. Describe the final state, not a replay of
   the journal. If later evidence corrects or supersedes an earlier claim,
   preserve the causal correction and do not repeat the stale claim as the
   current result.
4. Grounding. Make sure every important problem, decision, reversal, and
   unresolved judgment in the Story is supported by the cited captured
   records. Do not force every captured category into prose.
5. Overview. After completing the Story, write the overview from that finished
   topology, then read it against every Act and Part. It should accurately
   represent the whole branch without stale intermediate claims, chronological
   cataloguing, or repetition. Treat decisions and criteria as evidence of
   intent, not proof of completion. Claims such as "green", "passed", "proven",
   "complete", or "intact" require criterion evidence, verified-close records,
   or THIS RUN facts; an evaluator PASS count is not completion evidence.
   Otherwise state the narrower captured result and its limit. When the current
   review is itself the named live
   confirmation, do not claim that confirmation is absent: state conditionally
   what successful account acceptance establishes and leave only genuinely
   untested hosts or conditions open.

Examples that define the boundary:

- ONE PART: one artifact chooses a cache strategy and a later artifact tests it,
  finds an invalidation defect, and corrects that same inseparable strategy.
- ADJACENT PARTS: an API contract is implemented in one independently reviewable
  stage and a later artifact adds the consumer migration that depends on it.
  Keep both Parts adjacent and name that dependency in their interpretations.
- ADJACENT ACTS: implementation completes, then a distinct hardening phase
  stress-tests and revises it. Keep the Acts adjacent and state the transition.
- KEEP SEPARATE: one artifact changes cache behavior while another updates
  unrelated release documentation. Chronological adjacency is not causality.
- RESOLVED: an early checkpoint questions whether the fallback is exercised,
  and a later verified-close record demonstrates the fallback test. Preserve
  the validation in the Story, but do not ask the reviewer whether it was run.
- OPEN: a checkpoint records a compatibility judgment and no later decision,
  evidence, verification, expanded evaluator exception or disposition, or
  THIS RUN fact resolves it. It may remain a cited judgment question.

First curate the complete causal Story—including Acts, Parts, citations, and
final-state reconciliation. Then write the branch-level overview from that
finished Story. In at most 150 words, explain what the branch changes, why the
work was undertaken, its central causal arc across artifacts, and the final
state at branch head. Synthesize rather than list checkpoints or repeat every
Act. Prefer product and behavioral outcomes over implementation inventory. Do
not include forensic findings, a merge verdict, or a list of open questions.
Ground the overview in a small number of the strongest citation aliases by
placing them only in \`overview.citations\`. Never paste a bracketed engine-issued
alias such as \`[c18]\` into \`overview.text\`; those coordinates are prompt-local
and readers cannot resolve them. Ordinary product identifiers that merely look
like c followed by digits are prose, not aliases.

Author the nested Story contract strictly. You choose semantic grouping; the
engine assigns Act/Part ids and derives membership from nesting:

    {"schema_version": 1,
     "overview": {"text": "...", "citations": ["c3", "c18"]},
     "acts": [
       {"title": "...", "interpretation": "...",
        "parts": [
          {"title": "...", "checkpoints": ["k1", "k7"],
           "interpretation": "...", "citations": ["c3", "c11"]}
        ]}
     ],
     "questions": [string | {"text": "...", "citations": ["c#", ...]}, ...]}

Author clean JSON in this shape. As a bounded safety net, the engine can unwrap
exactly one accidentally stringified outer JSON object and records that
normalization separately from a clean first pass. It does not remove bracketed
aliases, rename a \`question\` key to \`text\`, recursively unwrap, or guess an
unknown alias; submit the documented shape directly.

Submit on stdin in ONE command — never write payload files:

    orcaops review routine-submit --branch <b> --run <run-id> --lane account --isolation sequential --input - --json <<'EOF'
    {"schema_version":1,"overview":{"text":"...","citations":["c3","c18"]},"acts":[...],"questions":[...]}
    EOF

If rejected and the account lane's independent repair credit remains, fix exactly what the
diagnostics name and resubmit once. Once the account lane is terminal
(accepted, or its repair exhausted) the same response finalizes the run
and carries the outcome, the run record, and the review path — a
degraded outcome is finalized for you; never invent commands and never
back-fill a missing lane. It also carries a semantic_anchor preparation
receipt. This receipt is deterministic metadata, not a model result, and
its preparation never changes or blocks the core review.

## 4. Optional semantic anchoring — only when explicitly requested

Do NOT generate semantic anchors during every routine review. Perform this
step only when the user explicitly asks to associate captured reasoning with
changed code for a completed run. The core Story remains complete and valid
without anchors; anchor failure never changes its outcome.

Use the semantic_anchor object returned by the final account submission:

- READY: read exactly the returned payload_path.
- TOO_LARGE: stop and report its reason. Complete evidence refuses; never
  truncate, sample, or select around the registered profile.
- NOT_ELIGIBLE: report that this review has no eligible Story, citations,
  or changed rows, as named by the reason.
- UNAVAILABLE: report the preparation failure. Do not reconstruct or edit
  files under .orcaops/reviews/.

In a later session given only a run id, locate exactly one canonical
.orcaops/reviews/<branch-slug>/twolane/<run-id>/semantic-anchor-input-v4.md
file. Stop on zero or multiple matches. Do not substitute another run,
reconstruct the payload, or read unrelated run artifacts.

The READY payload contains the accepted Story, every eligible account item,
the complete policy-eligible diff annotated with deterministic change blocks,
and a per-file
inventory of paths excluded by explicit review policy. The inventory discloses
the target-space boundary; it never implies that a citation refers to excluded
code. Read that ONE file in a
single ordered pass, in full: no re-read, grep, selective search, truncation,
repository browsing, or inference from checkpoint ownership. The only eligible
citation kinds are exactly PLAN_DECISION, PLAN_ALTERNATIVE,
CHECKPOINT_DECISION, CHECKPOINT_ALTERNATIVE, and
CHECKPOINT_UNCERTAINTY.

Author a sparse set of dispositions:

- ANCHORED only when a changed block directly implements, enforces, embodies,
  or creates the condition described by the item. One item may name multiple
  targets (at most 8),
  and targets may cross checkpoint-owner boundaries.
- ASSESSED_UNANCHORED only when you deliberately assessed the item against the
  complete target space and report that no trustworthy direct association
  exists.
- Omit an item when you make neither proposal nor negative assessment. The
  engine retains it as NO_ANCHOR_PROPOSED with ENGINE_RECORDED_OMISSION origin.

ANCHORED is REVIEW_MODEL_PROPOSED, ASSESSED_UNANCHORED is
REVIEW_MODEL_REPORTED, and NO_ANCHOR_PROPOSED is an engine-recorded neutral
omission. None of the three adjudicates whether a true association exists.
Never author NO_ANCHOR_PROPOSED yourself; it is an engine compilation state.
The installed generation still contains every eligible item exactly once.

Target complete change blocks by their prompt-local \`h#.b#\` aliases. A block
is a maximal changed region inside one Git hunk, terminated by unchanged
context; an immediately adjacent delete run plus add run is one replacement
block. Hunk and block aliases are routing coordinates only. Every target must
declare one scope:

- WHOLE_BLOCK when the complete deterministic block is the honest association;
  author only \`{"block":"h#.b#","scope":"WHOLE_BLOCK"}\`.
- FOCUS when you can name a narrower changed-row highlight; author
  \`{"block":"h#.b#","scope":"FOCUS","focus":{...}}\`. Focus has nullable
  delete/add ranges but at least one side must be present. Additions use only
  that block's A<n> refs and deletions use only its D<n> refs.

Never omit scope, attach focus to WHOLE_BLOCK, or submit FOCUS with both sides
null. Never author hashes: the engine resolves aliases
to durable block identities and code geometry. Never attach an item to every block merely because its checkpoint
owns those rows. ANCHORED associations are REVIEW_MODEL_PROPOSED and no
disposition ever alters Story topology, checkpoint ownership, findings,
uncertainty state, or any engine-adjudicated result.

Decide direct association from the statement itself, not its category or
checkpoint owner. A decision may point to the implementation or test blocks that
embody it. An uncertainty may point broadly to the implementation or test block
that creates the described risk; use WHOLE_BLOCK when no narrower highlight is
honest. Rejected alternatives, future work, absence claims, evaluation
limitations, and decisions not to implement something normally receive no
anchor. Anchor one only when a changed block itself directly encodes the stated
constraint. The implemented approach alone is not proof that an alternative was
rejected. A pure rename has no changed-row block and is not targetable.

Author strictly, with no title, confidence, rationale, or extra fields:

    {"schema_version": 3,
     "dispositions": [
       {"item": "i1",
        "disposition": "ANCHORED",
        "targets": [{"block": "h1.b1",
                     "scope": "FOCUS",
                     "focus": {"delete": null,
                               "add": {"start": "A1", "end": "A2"}}}]},
       {"item": "i2",
        "disposition": "ANCHORED",
        "targets": [{"block": "h2.b1", "scope": "WHOLE_BLOCK"}]},
       {"item": "i3",
        "disposition": "ASSESSED_UNANCHORED", "targets": []}
     ]}

Author clean JSON. The semantic boundary accepts and records exactly one
accidentally stringified outer object, but recursive stringification is a shape
error and consumes an attempt.

Submit the authored JSON directly on stdin in ONE command:

    orcaops review semantic-anchor-submit --run <run-id> --profile semantic-anchor-profile-v1 --input - --json <<'EOF'
    {"schema_version":3,"dispositions":[...]}
    EOF

If accepted, the response installs an immutable generation and atomically
switches the current pointer. Report the generation id, counts for ANCHORED,
ASSESSED_UNANCHORED, and NO_ANCHOR_PROPOSED, any focus warnings, and the
attempt/generation elapsed values from the response or manifest. If it returns PENDING, fix exactly the named
diagnostics and submit once more with the returned generation id:

    orcaops review semantic-anchor-submit --run <run-id> --generation <generation-id> --profile semantic-anchor-profile-v1 --input - --json <<'EOF'
    {"schema_version":3,"dispositions":[...]}
    EOF

There is one initial submission and at most one repair. A well-shaped FOCUS
whose geometry is invalid is dropped atomically with a structured warning while
its valid block association installs; that does not spend a repair. Unknown blocks,
duplicate/unknown item dispositions, authored neutral omissions, malformed focus syntax, and other invalid
associations reject normally. Never mint another
generation to evade exhausted attempts. A rejected or corrupt generation does
not replace the prior current generation, and consumers must surface corruption
rather than silently load an older one. Consumers may derive a deterministic
display title from the first sentence; titles are not anchor-model output.
The existing review anchor verb remains a separate stateless helper for manual
line anchors and finding keys; do not use it for semantic generations.

## 5. Deliver concisely

Report a short completion from the final response: the outcome (FULL,
DEGRADED, or FAILED), the ownership label (DERIVED, DEGRADED_ATTRIBUTION,
or CODE_ONLY), which lane is missing and its final diagnostics if degraded,
repairs_used, elapsed_ms, and the review.md path. The run's PRIMARY output
is the installed story-review-model (story-review-model-v4.json): the Story
with its engine-derived owned diffs, which the reviewer reads in the TUI.
When ownership_summary is non-null, report attributed_rows/reviewable_rows
and round attributed_pct only for display. Report ambiguous_rows,
contested_rows, and unattributed_rows whenever they are nonzero, and verify
that those partitions plus attributed_rows equal reviewable_rows. Describe
unattributed_rows as residue
and missing_boundary_checkpoints as a separate missing-boundary count; never
claim that missing boundaries caused some or all residue. When it is null, say
ownership metrics are unavailable rather than inventing zeroes. Read these
values from the final response, not by rereading review.md.
Also report the immutable latency_status with elapsed_ms,
latency_input_bytes, latency_tier, and latency_budget_ms. The byte denominator
is the exact policy-eligible forensic diff; 1,000,000 and 2,000,000 are decimal
byte boundaries, with 2,000,000 included in the largest supported tier. Report
execution-profile fields with their individual provenance when present and
UNKNOWN when absent. The engine-observed runtime identity is separate from
caller/host profile claims; paths are diagnostic, while the runtime fingerprint
is the build comparison identity.
The concise artifacts are review.md and brief.json. Do NOT reread or
reproduce the rendered review — the file is the deliverable;
quote it only if the user asks for the full text. Never soften a degraded outcome and
never fill a missing lane with your own findings.

(The granular start / lane-input / lane-submit / run-show / finalize
verbs remain available for manual stepping; the routine program uses the
composite verbs above. An independent-lanes deep-review mode is deferred
and not part of this skill today.)

# Degraded-mode reporting — two states, never conflated

The engine labels code ownership, and the two degraded labels mean
different things. Report them plainly and distinctly; never conflate them.

- CODE_ONLY (no captured threads on the floor): no Story is possible.
  Deliver a labeled code-only review — the forensic findings plus the FULL
  unattributed residue over the entire diff — and say so plainly: there was
  no captured account to curate, so there is no topology and no ownership.
- DEGRADED_ATTRIBUTION (capture present, attribution failed): the Story is
  retained, but code ownership could not be derived. Deliver the Story, and
  state that code ownership is degraded and ALL code sits in unattributed
  residue — the Acts/Parts stand, the per-Part owned diffs do not.

# Failure diagnostics — bounded per-stage repairs

You get one independent repair for the forensic lane, one for the account
lane, and one for a requested semantic-anchor generation. Spend each only
fixing exactly what its diagnostics name; never mint a fresh run or generation
to buy more attempts. A clean first-pass, normalized first-pass, nonfatal focus
warning, repaired acceptance, and terminal rejection are recorded separately.
Map each named signal to its repair:

- FORENSIC_TRANSPORT_CEILING / REVIEW_DIFF_TRUNCATED (routine-start
  refusal): no payload was minted — NOT a repair. Stop and report the
  refusal; narrow the review scope or raise review.max_diff_bytes.
- ACCOUNT_CORPUS_CEILING (routine-start refusal): the captured account
  corpus exceeds its ceiling, so no payload was minted — NOT a repair. The
  captured account is never clipped to fit; stop and report the refusal,
  and narrow the review scope to fewer checkpoints (or raise the ceiling).
  When the message also names a forensic overage, BOTH must be resolved —
  the envelope carries one code per refusal, not one per problem.
- TWOLANE_ROUTINE_ORDER: you asked for account context before the forensic
  lane was terminal — finish and submit the forensic pass first. Not a
  repair-credit spend.
- SLICE_PAYLOAD_SHAPE: the payload violated the served contract; the
  diagnostics name the exact paths — fix the shape and resubmit.
- SLICE_ROUTINE_LIMITS: the payload exceeds a routine cap (finding/question
  count, claim or interpretation word count, or a banned INFO severity) —
  trim to the highest-confidence items; never negotiate with the validator.
- SLICE_UNKNOWN_FILE: a forensic finding or question anchored a file that
  is not a changed file in the payload — anchor only served paths.
- SLICE_UNKNOWN_CITATION: a Part or question used a value that is not an
  engine-issued \`c#\` alias — copy the exact served alias.
- SLICE_OVERVIEW_ALIAS_LEAK: overview prose contains an exact bracketed known
  citation alias such as \`[c18]\` — remove it from the prose and keep the alias
  only in \`overview.citations\`.
- STORY_CHECKPOINT_UNCLAIMED: a completed checkpoint appears in no Part —
  place every in-scope completed checkpoint in exactly one Part.
- STORY_CHECKPOINT_DUPLICATED: a completed checkpoint appears in more than
  one Part — keep it in exactly one.
- STORY_UNKNOWN_CHECKPOINT_REF: a \`checkpoints\` alias does not resolve to an
  in-scope completed checkpoint — reference only served \`k#\` aliases.
- SLICE_SUBMIT_AFTER_ACCEPT / TWOLANE_ATTEMPT_BUDGET: the state machine
  refused the submission (already accepted, or that lane's repair credit is
  spent); never work around it by minting a fresh run.
- Finalize classification codes (a \`finalize_error\` field on an
  otherwise-ok submit envelope, or a finalize failure): the ENGINE failed
  after accepting your submission — the lane stays accepted. Do NOT resubmit
  and do NOT mint a fresh run.
  - TWOLANE_EXECUTABLE_IDENTITY_DRIFT: the finalizing executable is not the
    one that started the run — rerun \`review finalize\` with the original
    build.
  - PINNED_DIFF_UNREADABLE: the run's pinned \`diff.patch\` is recorded but
    unreadable — restore the run directory before finalizing again.
  - STORY_MODEL_CATALOG_INVALID, STORY_MODEL_PROJECTION_INVALID,
    STORY_MODEL_RANGES_UNRESOLVED, STORY_MODEL_INVARIANT,
    PART_OWNERSHIP_INVARIANT, STORY_MODEL_SCHEMA_INVALID: deterministic
    engine-side model defects — retrying reproduces them; stop and report
    the envelope verbatim as an engine defect.
  - STORY_COMPOSE_FAILED: unclassified fallback — retry \`review finalize\`
    once; if it fails again, stop and report the envelope verbatim as an
    engine defect — that is the deliverable for this run.
- finalize reports "already finalized": the run record is immutable; the
  existing review.md is the deliverable.
# Mode B — address comments

Read open comments with:

    orcaops review comments --branch <b> --json

Treat each open root comment as a work order. Make code changes through the
active capture/checkpoint lifecycle, verify them, then reply with the responding
checkpoint reference and resolve only when the request is actually satisfied:

    orcaops review comment reply --branch <b> --id <id> \\
      --input '{"body":"<answer>","author":"agent","checkpoint_ref":{"artifact":"<artifact>","cp":<checkpoint>}}' \\
      --resolve

After the batch, rerun review data. A changed floor can stale only the
affected components; reviewer dispositions and valid corrections continue
through stable content/floor identities. If no valid candidate remains,
surface the conflict rather than silently relocating the correction.

# What the review is

The rendered review.md is a standalone two-lens slice: a causal Story
reading led with the account's Acts/Parts and their engine-derived owned
diffs, a capture-blind forensic reading, their deterministic merge, and
the claim-ledger dispositions (ACKNOWLEDGED_BY_* rows mark attention,
not adjudication; OUTSTANDING rows remain open). NOTHING in the review is
adjudicated by the engine: captured uncertainties are reported
UNADJUDICATED, and ledger rows named CANDIDATE or POSSIBLE are leads a
human confirms. Findings are unadjudicated leads for a human reviewer; the
review is never a merge verdict or a claim that the branch is safe.
`,
};
