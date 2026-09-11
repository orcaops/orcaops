---
name: "Orcaops: why code is the way it is"
description: "Trace why code is the way it is — a line, a symbol, a file, or a whole subsystem — back to the captured artifact + checkpoint behind it. Invoke before reading the code. Use when the user asks \"why does X exist?\" (any symbol/file/concept), \"why is this built this way?\", \"where did this come from?\", \"who/what added this line?\", \"who owns this code?\", \"what is the history behind this file?\", \"how did this evolve?\", \"what was the rationale for this validator/handler/middleware?\", or wants captured context on a specific change — including debugging a regression through its captured provenance: \"why is this line here?\", \"what was the agent worried about when it wrote this?\", \"which change broke this and what was the rationale?\""
metadata:
  generatedBy: "orcaops@0.2.0-rc.2"
  contentHash: "88e3147cec78"
---

# When to use

Use captured provenance when the user asks why code exists, who changed it,
or how it evolved. `why` locates recorded work; read its evidence and
corroborate against code, tests, or commits before explaining the rationale.

Choose the target from the question:

- **File and line:** query `<file>:<line>` for line attribution.
- **Named symbol:** locate its definition with `rg` or symbol search, then
  query that line before inferring intent from the implementation.
- **Whole file:** query `<file>` for ranked recorded history within the
  evaluated candidate set. This does not assert line authorship.
- **Subsystem:** pick two or three entry-point files, discover candidates,
  and expand relevant work using historical labels and source identities.
  Results are ranked by applicability, not newest-first. Inspect timestamps
  and detailed evidence before constructing a chronology; no entry is
  guaranteed to be the subsystem's founding decision.

# Discover candidates

```bash
orcaops why src/auth.ts --json
orcaops why src/auth.ts --json --all
orcaops why src/auth.ts:42 --json --branch feat/auth
```

JSON schema v4 uses `representation: "compact"` by default. Read `target.line`,
`conclusion`, and each candidate's `reasons`. Candidates are in `results`;
`best` is a selected candidate or null. There is no top-level candidate
`reasons` array. A null target line means whole-file history.

Compact candidates retain identity, confidence, reachability, provisional
state, historical `label`, checkpoint number, and evidence availability.
`label` comes only from `plan_support.plan` at the candidate's historical
anchor. If it is null, display kind, checkpoint number when present, and
artifact identity; do not invent a title from current code or a later plan.

`evidence_counts.plan_decisions`, `.checkpoint_decisions`, and
`.checkpoint_uncertainty` count entries in the corresponding historical
body, without deduplication or supplemental enrichment. Null means the
body is unavailable; zero means available but empty. They help choose what
to expand, and do not supply the rationale themselves.

# Explain a line

```bash
orcaops why src/auth.ts:42 --json --details --limit 1
```

Read rich `best` when it is present. In detail mode, `best` and `results`
use the same rich candidate representation, including a best outside the
requested result page. Read `best.plan_support.plan.task` and `.decisions`,
`best.checkpoint.summary`, `.decisions`, and `.uncertainty`, and the pinned
`best.source_plan.content` when available. These are the candidate's
originally supported bodies; `enrichment` is separately marked supplemental
context. Missing bodies remain null or explicitly unavailable.

Handle the evidence state before giving an explanation:

- **`best: null`:** no single best was selected. Inspect `conclusion`,
  `candidate_selection`, `completeness`, and query `uncertainty`; do not
  promote `results[0]` to best.
- **`conclusion: "ambiguous"`:** describe the competing claims and expand
  more rows. One returned row does not resolve a tie, even with `--limit 1`.
- **Incomplete evidence:** report candidate/support omissions, unavailable
  evidence, and provisional claims. A non-null best can still carry evidence
  limitations; inspect its reasons and completeness rather than asserting
  certainty from its rank.
- **`conclusion: "none"`:** no evaluated matches. This is not a confidence
  tier or proof that no historical work exists.

For line queries, `exact` means meaningful fingerprint or verified blame
supports the attribution; `likely` can reflect verified blame inside a
checkpoint interval; `weak` retains related context or uncertainty. Read
`best.reasons` to distinguish content evidence from ancestry evidence.
Without a fingerprint, do not describe file overlap alone as line authorship.

`--limit 1` limits result rows, not narrative bytes or shared diagnostics.
Detail mode may return large bodies, including rich best even on an empty
page. `--details` without `--json` adds nothing: human output already retains
its current captured rationale.

# Expand further without changing scope

Repeat the target with `--json --details` and a larger `--limit`, or follow
`pagination.next_offset`. Preserve the original `--project`, `--scope`,
`--branch`, `--origin`, `--touching`, and `--at` selections. The default page
size is 25; `--all` changes that default to 1,000 and an explicit `--limit`
overrides it. Separate processing budgets cover 500 candidate artifacts and
500 overlap-support artifacts. Neither flag promises complete history.

Distinguish `detail_omissions` (presentation), `pagination` (evaluated matches
outside the page), `candidate_selection` (processing budgets), and
`completeness` / `project_coverage` (evidence and coverage). Full diagnostics
are in detail mode, including those for artifacts with no result row.

Compact `source_versions` is a count and deterministic digest of every
evaluated candidate/support source version. Details retain the full array;
each candidate keeps its own version token in both modes. The digest detects
changed source state; it is not a historical retrieval token. A repeated
query reads current history, and `--at` fixes code only, not artifact history.

To inspect a specific artifact, carry both identities from the candidate:

```bash
orcaops show <artifact_id> --project <project_id> --json
```

`why` has no artifact-ID filter. `show` exposes an artifact's revisions and
checkpoints, including later changes; it does not reproduce an exact
historical candidate view. Use rich `best` or detail rows for anchored
explanations. Pair with `orcaops:show` for artifact history
or `orcaops-digest` for the broader PR account.

# Before you answer

Read `checkpoint.files_changed` from detailed evidence, including any design
documents. Corroborate the captured account against the implementation,
tests, and relevant commits. State which explanation was recorded, which
is your inference, and what you could not find documented. Inspect changes
since the checkpoint's `head_sha` before describing current behavior.

`origin: "imported"` means synthesized Git history. Cite the underlying
commit alongside reconstructed plan decisions. Supplemental enrichment is
not contemporaneous evidence; do not attribute a reconstructed concern to
an agent who did not record it.

For regressions, inspect `checkpoint.uncertainty` and the anchored plan and
checkpoint decisions. A recorded concern matching the failure is useful
evidence; a fix reversing a recorded decision should explain why. If no
suspect location is known, `orcaops-timetravel` can inspect
checkpoint boundaries.

# On a miss in a repo with imported history

Use `seed_guidance` and cached coverage to distinguish missing history from
a narrowed query or incomplete evaluation. When guidance offers an import,
recommend the user-invoked `orcaops-seed` skill with the named
commit or path (`orcaops seed --commit <sha>` / `orcaops seed --path <dir>`).
Record the offer with `orcaops seed status --offered <area>` so it is not
repeated during cooldown, as in `orcaops-seed-discovery`.
This records only the offer; it does not import history. For a declined
area, `orcaops seed status --offer-again <area>` is the user's call.
