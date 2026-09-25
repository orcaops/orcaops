---
name: "Orcaops: plan critique"
description: "Before drafting or capturing a non-trivial coding plan, look up the continuing requirements and decisions that bear on it, then check prior Orcaops work for relevant risks. Also critique a plan draft against that history. Use for \"critique this plan\", \"review this plan against earlier decisions\", \"what rules apply to this work?\", or \"poke holes in this plan before I start\". For history questions not tied to a plan, use captured-history lookup instead."
metadata:
  generatedBy: "orcaops@0.3.0"
  contentHash: "089dda870455"
tags: ["orcaops", "insight"]
---

# When to use

Triggers:

- As a PRE-STEP before `orcaops capture plan` on any non-trivial task
  (the capture skill references this sweep).
- "critique this plan", "review my plan draft", "poke holes in this
  plan before I start".

Skip when:

- The user is continuing an in-flight task → `orcaops-resume`.
- Reviewing SHIPPED work rather than a plan → `orcaops-adversarial-review`.
- The user only asks whether earlier work or decisions exist, without a plan to
  critique → `orcaops-search`.

Both paths drive ONLY existing read commands — `knowledge lookup`, `search`,
`decisions`, `loose-ends`, `list --touching`, `show`. Every one of them is a
**passive read**: it asks nothing, writes nothing, initializes or repairs
nothing, and starts no worker. Your job here is to read the record and carry it
into the plan. It is never to create a relationship between records, review or
retry an extraction job, or repair the knowledge store — none of that is an
agent's responsibility, and no command below offers it.

Artifacts with `origin.kind: git-import` are synthesized prior art. Label every
one `[imported]`; use imported decisions only as evidence-cited paraphrases
and include the citation. Never imply that synthesized prose was captured live,
and attribute imported work to its commit authors rather than the current user
or agent.

# Path 1 — prior-art sweep (feeds a new capture)

Four steps, in this order. The first asks what the record already **requires**
of this work; only then does it matter what anyone did before.

## 1. Look the record up — before any search

```bash
orcaops knowledge lookup --adopted --limit 100 --json
orcaops knowledge lookup "<words from the task>" --json
orcaops knowledge lookup --subject <subject-id> --json
orcaops knowledge lookup --identity requirement:<id> --json
```

**Run `--adopted` first, always.** It is the one question that finds rules
without wording to match them against: every adopted requirement and decision
this project holds, whatever the task happens to say. A rule whose wording your
task never uses, and whose ids nobody handed you, reaches you through this
question and no other — and that is exactly the rule a plan is most likely to
break. This query already uses the maximum `--limit 100`. If `limits` still
contains `identity_count`, retain that unresolved omission. Use the narrower
queries below to investigate relevant records; they do not establish an
exhaustive adopted-rule sweep or prove that omitted rules do not apply.

Then narrow. Start with text taken from the task itself. Use
`--subject <subject-id>` when the task names a capability, service, API or
workflow the record already has a subject for, and `--identity <kind>:<id>`
(repeatable; `requirement`, `decision`, `claim` or `relationship`) when the
user, a source plan or an earlier answer already handed you exact ids. Ask about
one of the four at a time. `--limit <n>` bounds how many continuing identities
the answer carries (default 10, max 100), `--at-boundary <n>` reads what the
record said at a past write sequence, and every answer names the boundary it
read at.

A text question reaches records **through the captures that cite them** — there
is no index over a record's own wording, and the answer says so under
`limits`. So an empty text answer is a statement about this project's captures,
not about its rules: `--adopted` reports what stands within its disclosed
bounds, and an empty text answer is never upgraded into "nothing applies".

There is no `--touching <path>` question here: this history records no
attributed link between code and a continuing record. Use
`orcaops list --touching <glob> --json` to find the artifacts, then ask about
the records.

**Read the lists apart. They are not the same kind of thing.**
`applicable` and `background` hold entry **keys** (`<kind>:<entity-id>`); the
entry itself — its revisions, their wording and the one line saying why — is in
`entries[]`, matched by `key`.

| List | What it is |
|---|---|
| `applicable` | The adopted rules this work has to meet, placed first. The matching entry names each revision, its `standing`, its `statement`, and whether its `applicability` **applies** or is merely **unresolved**. Unresolved is not a waiver: the condition's inputs are missing, not met. |
| `background` | Useful context that is *not* a rule this work must meet. Never promote it into `applicable` or cite it as an obligation. |
| `proposals` | Labelled candidates, including extracted ones. A candidate is not adopted and does not bind the plan. |
| `conflicts` | Overlapping adopted revisions with no recorded disposition. Surface them; neither the newest nor the last-synced one wins. |
| `unresolved` | Points left undecided, each with the records to drill into. |
| `limits` | What the answer did not carry, named by key — including identities `--limit` cut and identities this history holds no record of at the boundary. A smaller limit may be raised only up to 100. At the cap, use supported text, subject or identity queries for relevant detail and carry the unresolved omission; narrowing does not prove completeness. |

When `conflicts` or `unresolved` expose consequential ambiguity about the
requested product scope, ask one useful planning clarification before choosing
that behavior. Name the competing interpretations and the exact records behind
them; continue independent work while the answer is pending. Carry the answer
into the plan once, not repeated test-by-test prompts. Routine implementation
choices within agreed scope need no new question. A clarification is not a
waiver of an adopted requirement or authority to change it.

## 2. Carry the exact revisions into the plan

Every `applicable` entry the new plan will act on becomes an entry of its
`knowledge_uses`: `kind` and `entity_id` from the entry's `target`, and
`revision_id` from `entries[].revisions[].revision.revision_id` — **the exact
revision the lookup returned**, not the identity and not the wording. A plan
that names a predecessor of the revision that now governs reads as drift, which
is the point. Only a `requirement` or a `decision` can be a use — a `claim`
or a `relationship` you looked up is read, not selected. Roles: `implement`,
`preserve`, `assess`, `background`, `propose_change`. See the
`orcaops-capture` skill for the field.

Deliberately leaving an applicable rule unselected is allowed and stays
visible: `orcaops knowledge lookup` and `orcaops status --json` both list it
under `applicable_not_selected`, with the revision the plan did select named
beside it. Say in the plan why you left it, rather than hoping it disappears.

## 3. Read the coverage claim before you conclude anything

Every answer ends with one `coverage.processing` field. Read
`coverage.processing.claim`:

- `complete` — the eligible sources selected through the answer's boundary
  are currently processed. Interpretation results written after that boundary
  may still be absent from a historical answer. This is not proof that every
  requirement in those sources was found.
- `partial` — a job is unfinished or gave up, an eligible source has no
  admitted job, or the project is paused.
- `not_processed` — processing is off, or no eligible source was selected.
- `unknown` — the history could not be read.

**Never state that no requirement applies unless the claim is `complete`.**
Under any other claim, an empty `applicable` means the answer found none, not
that none exists — say which it is. Previously established requirements still
apply while processing is behind, and raw captures stay searchable throughout;
that a claim is not `complete` is never a reason to stop, ask the user to
enable anything, or do the interpretation yourself.

## 4. Then sweep what was done before

Pick 2-4 content terms from the task (feature nouns, subsystem names,
error strings):

```bash
orcaops search "<term>" --json
orcaops decisions --scope project --json     # decision records with rationale
orcaops loose-ends --scope project --json    # what past plans left dangling
```

A search hit now carries the standing of what it cites — see the
`orcaops-search` skill before quoting one back.

**Cross-project mode:** add `--scope all-projects` to these commands to sweep every
catalogued project, not just this repository. Cite the project identity with each
hit. For exact detail, use `orcaops show <artifact-id> --project <project-id> --json`.
`knowledge lookup` has no cross-project mode: continuing records are this
project's.

What to inject into the new plan, from matching artifacts:

1. **Decisions with rejected alternatives** — the strongest signal: if a
   prior artifact rejected an approach with a reason, carry that into the
   new plan's `decisions[]` (as prior art) instead of re-litigating.
2. **Non-goals** — recurring exclusions usually still apply; propose them
   for the new plan's `non_goals`.
3. **Unresolved uncertainty** — a prior artifact's open uncertainty on the
   same scope is a risk the new plan should address or explicitly inherit.

Keep it to the 3-5 most relevant precedents; link each as
`<artifact_id>` (`<project>/<artifact_id>` cross-project). Then proceed
to `orcaops-capture`.

**Re-prepare when the scope changes.** If the work turns out to govern behavior
the first lookup never asked about, run step 1 again for the new scope and
revise the plan's `knowledge_uses` — a plan revision supersedes them whole.

# Path 2 — draft critique (a plan already exists)

Read the draft, then interrogate it against captured history — one pass
per lens, citations required:

1. **Contradicted decisions.** `orcaops decisions --scope project --json` (replace with
   `--scope all-projects` for a cross-project review): does any step reverse
   a recorded decision without saying why it no longer holds? Flag it —
   the fix is a new decision acknowledging the reversal, not silence.
2. **Fragile files.** For each file/subsystem the draft touches:
   `orcaops list --touching <path> --json` → artifacts that repeatedly
   touched it; `orcaops show <id> --json` for their uncertainty and
   evaluator violations. A file with recurring uncertainty or violations
   deserves an explicit risk line in the plan.
3. **Prior attempts.** Use `orcaops search "<term>" --json` and `show` to
   distinguish active, interrupted, abandoned, and unsummarized work. Only an
   explicitly abandoned checkpoint is a dead attempt; unsummarized work may
   still be in flight. Ask what stopped an abandoned attempt and whether the
   new plan addresses it.
4. **Non-goal drift.** Compare the draft against recurring `non_goals`
   in prior artifacts; a plan quietly re-including a recurring exclusion
   needs the exclusion's rationale addressed.
5. **Weak acceptance criteria.** `orcaops loose-ends --scope project --json` shows what
   past plans left dangling. Steps whose criteria are vague ("works",
   "is clean") or missing produce exactly those dangles — propose
   concrete, checkable criteria.

Deliver each historical finding with an artifact and checkpoint or decision
citation. A defect visible directly in the draft may cite the draft section
instead. Give every finding a proposed plan edit; do not present unsupported
historical claims.
