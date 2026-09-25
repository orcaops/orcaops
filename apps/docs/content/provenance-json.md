---
title: Provenance JSON
description: 'Read focused historical explanations, preserve ambiguity, and migrate why consumers to schema 8.'
---

# Provenance JSON

`orcaops why <file> --json` and `orcaops why <file>:<line> --json` return schema **8**.
For a known target and a reasons question, start with `--view rationale --limit 5`.
Use compact to compare candidate histories, `--details` for needed checkpoint evidence,
or exact expansion for a missing account or qualification. These are alternatives, not a
required sequence. Resolve existing paths before querying and corroborate material historical
claims against current code/docs; do not expand every candidate merely because it was returned.

```sh
orcaops why src/auth.ts --json
orcaops why src/auth.ts:42 --json
orcaops why src/auth.ts --json --view rationale
orcaops why src/auth.ts --json --details --candidate <candidate-id> --anchor <inspection.anchor>
orcaops knowledge show <reference> --project <project_id> --json
orcaops show <artifact_id> --project <project_id> --json
```

Whole-file queries return related recorded history, not line authorship. All views use
the same retrieval and authority rules. They differ in how much evidence fits: **16 KiB**
compact, **32 KiB** rationale, **64 KiB** explicit `--details --audit`, including the JSON envelope and newline.
`output.bytes` is the exact serialized JSON byte count. Human output shares the ceiling;
if formatting would exceed it, the command emits the bounded JSON representation instead.
Human output uses the same selection. Exact inspection has a **16 KiB** display ceiling,
or **32 KiB** for knowledge inspection with its explicit `--details` option.

## Exact historical candidate inspection

For a needed checkpoint body, use the returned `results[].id` (or `best_candidate.id`) with
`inspection.anchor`: `why <same-target> --details --candidate <id> --anchor <token> --json`.
Preserve the original scope, branch, origin, touching, code revision, and knowledge boundary
options. The anchor binds the query, store, code contents, history observation and source versions;
changed observations are rejected instead of substituting current evidence. It is a locator,
not authorization. Candidate pagination does not participate in exact selection.

The schema-8 `representation: candidate` response contains one historical `candidate`, its
`selection`, the original `conclusion`, and evidence limits. The 16 KiB ceiling covers the
whole response. It neither repeats rationale nor exposes other candidate bodies, and selecting
one candidate does not resolve ambiguity. Its `plan_support` is the checkpoint's original plan,
not a later artifact revision. Supplemental enrichment stays separately marked.

An oversized candidate has `status: omitted_oversized`, `candidate: null`, and a bounded `sections`
index with available selectors, entry counts and content byte costs. Repeat the same target,
scope, candidate and anchor with `--section index` to obtain that index directly. Select
`checkpoint`, `plan`, or `source-plan` for a whole anchored body, or `checkpoint-metadata`
for just the checkpoint number and head SHA. Array sections
`checkpoint-decisions`, `plan-decisions`, `uncertainty`, and `files` return bounded pages:
`--section-offset` is zero-based, `--section-limit` defaults to five and is capped at twenty.
Follow `pagination.next_offset` without changing the original selection. Positions are one-based;
`--decision <n>` selects one complete decision from either decision section. Whole units are
never clipped; an oversized array entry retains its position and an explicit omission.
Oversized decisions carry a wording preview marked `preview_only` for discovery, not evidence.
The index also previews up to three decisions per decision section, with original one-based
positions, content byte sizes and direct `--decision` selectors. `--section index --section-offset <n>`
pages both decision lists independently at the same zero-based offset; each has its own
`next_offset`. `--section-limit` controls the preview page size. Previews never replace evidence.
Ordinary `selection` contains the candidate ID, validating anchor and project ID; full scope,
target hashes and observation metadata remain in an explicit export rather than repeating in each section.

A section response contains `content`, not a complete candidate. Its `qualifications` explicitly
identifies excluded checkpoint uncertainty and warns that governing knowledge is separate.
An available decision alone does not establish fully qualified standing. Missing bodies remain
null with `status: unavailable`, not reconstructed from a later plan. Section selectors do not alter the observation anchor.

For a needed unit that still exceeds the ceiling, use `--output <new-file>` with the same
selection (and section/decision if applicable). The complete selection is
exported without display clipping; stdout is a bounded receipt. Existing files are not replaced.
Use `--details --audit` only for intentional bounded comparison of a candidate page; it retains
`audit.candidates` and audit omissions. Bare `--details` no longer selects multiple bodies.

## Bounded artifact inspection

`orcaops show <artifact-id>` now returns a **schema-4** digest, not a complete
artifact. Both JSON and human stdout are limited to **16 KiB**. Its response has:

- `artifact`: identity, project, branch, and state.
- `task`, `label`, `source_plan`, `decisions`: bounded recorded context, not a current-authority claim.
- `checkpoints`: a checkpoint index, ordered by checkpoint number; not checkpoint bodies.
- `pagination`: total, offset, limit, next cursor and a paste-ready next-page command.
- `selection`: an exact artifact/store/knowledge-boundary/observation anchor.
- `omissions`: whole-unit omissions with their size and exact inspection action.
- `follow_up`: anchored checkpoint, decision, authority, and export instructions.
- `output`: enforced byte ceiling and exact serialized JSON bytes, including envelope/newline.

Use `--checkpoint <n>` or `--decision <n>` (one-based) to inspect one complete
record. `--section` accepts `plan`, `knowledge`, `summary`, `evaluators`, `usage`,
or `repository`. A focused response contains `content` and `status: available`;
an oversized result instead has `content: null`, `status: omitted_oversized`, and
an export instruction. It never clips a reason or silently drops alternatives.
Recorded checks are reports, not independent verification.

Checkpoint pages default to five rows, with `--limit` capped at 20. Follow
`pagination.next` to discover checkpoints beyond the initial page. Preserve the
returned `--anchor` when selecting a record. Both page cursors and anchors reject
changed observations rather than substituting current evidence. `--at-boundary`
still controls continuing knowledge, not historical reconstruction of an artifact.

For deliberate complete inspection, use `--output <new-file>`, optionally with an
exact selector. The file contains the authorized/redacted selected evidence without
display shortening; stdout contains only an `export_receipt` with its path, bytes,
selection, and coverage. Existing files and symlinks are not overwritten. Export
has a 64 MiB operational limit; failure does not publish a partial destination.
Missing retained evidence is not repaired by exporting. Reading an exported file
still costs context: read only the necessary portion.

### Migrating show consumers

Normal schema-3 `show --json` previously duplicated the artifact under `artifact`
and `results[0]`. Schema-4 default output is a digest; `results` is absent.
Use focused `content` for an individual record, or read the full `artifact` from
an explicit schema-4 whole-artifact export. Resume's read model is unchanged.

This is a deliberate breaking change from the released schema-3 contract. There is
one export format, with no duplicate body or legacy-output option.

The emitted types are maintained in the CLI's `artifact-inspection.ts`; actual-command
tests cover the digest, focused/oversized variants, pagination, export, and byte count.

## Bounded knowledge inspection

`knowledge show <reference>` returns schema **2**. Small accounts retain `status: available`
and complete `content`. Oversized accounts return `status: omitted_oversized`, `content: null`,
the measured selection size, and a file-export instruction. Both JSON and human output are
bounded; `output.bytes` measures the serialized JSON envelope and newline. No reason,
alternative, exception, or correction is silently clipped to fit. Clients must handle
the omission variant before reading content.

Account content alone is not all its qualifying context. A readable selector identifies the
record; normal inspection includes a concise `current_status` summary and completeness reasons.
Project comes from `--project` or the checkout; authority scope defaults to project. Use
`--scope artifact:<id>` for artifact-specific authority. Use `knowledge show <reference> --context --json`
to recover the account and identities citing its source field, resolved at the current observation.
Each `qualifications` entry contains the resolved authority state,
statements, retained correction actions (including corrected wording), and coverage limits.
This includes qualifications whose references were omitted from the explanation. Scope is
not inferred from the artifact containing the source. This does not reproduce an earlier why response.

Context pages default to five identities, ordered by kind and identity, with `--limit 1` through
`8` and `pagination.next_cursor` / `follow_up.next`. A large page may itself be omitted whole;
reduce the context limit or export it. `completeness` distinguishes unreturned identities,
restricted sources, bounded discovery, and resolver omissions. Unresolved or out-of-scope
effects stay visible; correction wording does not establish decision replacement. Discovery
covers retained citations, not every possible uncited qualification or transitive historical link.
`completeness.reasons` identifies why coverage is incomplete: qualifications outside this page,
index limits, restricted/unavailable sources or content, omitted context, unavailable corrections,
or unresolved evidence/authority. `complete: false` does not itself mean another page exists.
Only a non-null next cursor offers another page; export does not repair unavailable evidence.
Complete displayed selections do not recommend export. Oversized omitted selections do.

Use `--output <new-file>` for an exact account export, or add `--context` to include the
qualifying identities. Without an explicit limit, context export includes the indexed context
remaining after the cursor. With `--limit`, it exports only that page. The receipt states
completeness; a paged or source-incomplete file is not a complete account-and-context export.
Source reads allow 16 MiB for account and context inspection/export, with a
32 MiB aggregate context-read bound and a 4,096-source/identity discovery bound. These are
operational limits, not display budgets; unavailable records remain unavailable, and a failed
read does not publish a file. The common 64 MiB export bound and no-overwrite rules also apply.

Selectors remain valid after unrelated history writes; current qualifications can change.
Context cursors reject changed project/scope/account/observation; restart without the cursor.
Old development-only encoded references are rejected. Rerun `why` for readable selectors;
no history upgrade or index rebuild is required. Source access and storage integrity checks
remain in force. A file export is deliberate evidence access, not free context.

## Response shape

| Field                     | Meaning                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `context`                 | Project, authority scope, current/historical mode, historical boundary, observation ceiling    |
| `code_revision`, `target` | Selected code and file/line, including dirty state and blame evidence                          |
| `conclusion`              | Existing attribution conclusion; ambiguity remains explicit                                    |
| `best`                    | Candidate ID string, or null when no single candidate was selected                             |
| `results`                 | Small summaries of every candidate on the requested page                                       |
| `inspection.anchor`       | Original query/observation anchor for exact historical candidate inspection                    |
| `best_candidate`          | Present only when a selected best is outside the requested page                                |
| `pagination`              | Evaluated matches, requested page, and next offset                                             |
| `knowledge.obligations`   | Applicable continuing requirements/decisions and their necessary authority context             |
| `knowledge.rationale`     | Ranked complete explanations or explicit oversized-omission placeholders                       |
| `knowledge.evolution`     | Resolved changes and explicitly qualified change-related passages                              |
| `knowledge.verification`  | Optional compact successful-check summary, or null                                             |
| `diagnostics`             | Coverage, selection limits, unavailable evidence, and uncertainty                              |
| `output`                  | Output omissions, byte ceiling, withholding reason, and bounded inspection suggestions         |
| `follow_up`               | Supported commands and scope cautions                                                          |
| `audit`                   | Details only: selected rich candidates, knowledge records, source versions, retrieval counters |

## Candidates cannot be displaced by background knowledge

A candidate summary retains `id`, `artifact_id`, `source_event_id`, historical `label`,
`kind`, numeric/null `checkpoint`, `recorded_at`, `confidence`, `relationship`, `reachability`,
`origin`, `reasons`, and `evidence`. Rationale omits historical task text;
compact discovery and audit include nullable `historical_task`. Reasons shared by all returned
candidates appear once in `candidate_caveats`; read those alongside each row's distinct reasons.

`label` and `historical_task` come from the historically supported plan, not a later revision
or supplemental enrichment. Complete labels/tasks/reasons are strings; shortened previews use
`{ "text": "...", "length": 300, "truncated": true }`, at most 240 Unicode code points
after redaction. Identity fields are not previews. A missing label or task is null.
`evidence.plan`, `.fingerprint`, and `.provisional` describe available attribution evidence.
Full support, checkpoint, source-plan, overlap, and enrichment bodies belong in `audit.candidates`.

`best` names a row's `id`; read that row, or `best_candidate` if it is off-page.
Never substitute `results[0]` for a null best. An ambiguous query with `--limit 1`
remains ambiguous. A non-null best can still have incomplete evidence.

`exact` confidence requires meaningful fingerprint or verified blame evidence; `likely`
can mean verified blame inside a checkpoint interval; `weak` retains related history
without establishing line ownership. Read reasons and diagnostics alongside confidence.
Imported origin means synthesized Git history, not a contemporaneous captured explanation.

The requested page's summaries are reserved before knowledge allocation. If essential
summaries and warnings cannot fit, the command fails explicitly and recommends a smaller
`--limit`; it does not report success with the candidate page silently removed.

## Focused knowledge, not duplicate storage representations

Check `status` first: `omitted_oversized` identifies a placeholder, not an explanation.
A complete rationale item has no `status` and includes `id`, `kind`, `form`, `account`, `source`, `relevance`,
`temporal`, `authority`, `context`, and an exact expansion `reference`.
Captured accounts keep wording, reason, alternatives, and rejection reasons together.
An absent alternatives field on a continuing record means that projection did not read them;
an empty array on a captured account means none were retained in that account.
An interpretation may also retain its distinct `source_account`: an unknown detector
reason does not erase a reason recorded in the source.

When a recorded account and an interpretation share the exact source reference and field,
the interpretation can appear under that account's `interpretations` instead of as another
top-level explanation. Each variant retains its ID, authority and exact reference. In ordinary
output, kind, relevance, time context and `context_ids` inherit from the enclosing group when
identical; differing values remain explicit. Audit retains all these fields. Its `account` carries
different wording/reason/alternatives, including a null reason when unknown. An identical
account instead uses `account_from` pointing to the recorded account. This is source grouping,
not semantic equivalence or authority adoption. Similar text alone cannot group records.
Variants that would make a readable source oversized remain separate. Shared context is
deduplicated only when it agrees; competing states and corrections are not discarded.

Forms distinguish `recorded_capture`, `unapproved_interpretation`, and `continuing_record`.
Recorded wording does not automatically become an adopted current requirement.
A continuing record with multiple relevant revisions has `account: null`; read every
account in its context instead of choosing one representative statement.

`relevance.basis` describes the route: candidate event, supporting plan, lexical overlap,
or continuing-record routes. `relevance.target` reports `explicit_path`, `target_terms`,
or `candidate_context`; matched terms are audit-only. An explicit path in a passage is stronger
retrieval evidence than shared words, but neither proves line attribution. Candidate
context without target evidence remains possible context, not a confirmed explanation.
Selection is deterministic: candidate-connected explanations precede weak background; explicit
path wording and target-stem wording precede incidental reason/directory matches and unqualified
candidate context. Artifact rotation occurs only within the same strength/purpose tier.
`relevance.support`, when present, names another recorded candidate account and the exact
knowledge identity both accounts cite. Its target evidence can support a differently worded
decision without requiring filename vocabulary. Support is non-transitive; unrelated siblings,
detector-only wording, and lexical accounts do not inherit it. The original `basis`, `target`,
and authority are unchanged: shared identity support is relevance evidence, not adoption,
semantic equivalence, or file-level attribution.

Obligations and rationale `context` entries carry identity, kind, placement, explanation,
relevant revision accounts, source identities, and an expansion reference. Accounts retain
standing, applicability, and scope-specific state. Optional conflicts, corrections,
unresolved points, and limitations appear when present. Competing governing revisions
are retained together. `wording_from` / `reason_from` point to the enclosing rationale
item or grouped interpretation when its account already contains the same text. Resolve IDs
within the group, not only the top-level rationale array. A null context reference means
no separate reference is carried there; inspect the enclosing item when available.

In compact and rationale output, single-revision context whose wording/reason already matches
an included account, with no conflicts, corrections, limitations, unresolved authority/scope
questions, or multiple scopes, omits the redundant `explanation` and `sources` inventories.
Its `qualification` replaces the repeated `accounts` array, retaining revision ID, standing,
applicability, scope state and exact wording/reason pointers. Its identity and placement
remain, as does any `evidence_not_attached` warning. Its separate context reference is null:
use the enclosing account's exact reference with `knowledge show --context` to recover
qualifications in the current project or explicitly selected artifact scope. Details retains those inventories and
separate references. Governing obligations and
complex context retain their full focused representation.

Continuing records also carry `relevance.discovery`: the observed originating event and
`candidate_event`, `candidate_plan`, or `lexical_overlap` origin for each source-reference
traversal. A source-reference hop does not strengthen a lexical connection to the target.
An empty list means no event-origin path was observed by this reader, not direct attribution.
Independent candidate paths can strengthen a record also discovered lexically. Explanatory
candidate-event accounts precede candidate-plan accounts, then other continuing context, then
lexically derived material. Within each connection tier, decisions precede reason-bearing
accounts, criteria, and general context. Artifact rotation happens within those groups;
target text matches never establish code attribution.

Corrections keep wording, status, source, exact action reference, and explicit unavailability.
A correction is not a replacement of a design decision. A retained explanation and its
required corrective/authority context are selected as a unit, or omitted together.
Unrelated identities sharing the same source event are not mandatory baggage when their
individual capture fields establish separate accounts.

Routine successful verification uses `status: "reported"`, `reported_records`, up to four
status `groups`, and up to three exact `references`. Groups preserve authority, scope/standing
state, and whether evidence is `not_attached` or `not_evaluated_by_this_query`. This is not
independent verification. Counts are source records, **not tests or unique runs**.
`omitted_status_records` and `omitted_references` disclose bounded summary omissions.
Causal failures, uncertain outcomes, and corrected/conflicting checks remain full accounts.
After obligations, up to 1.5 KiB is reserved before background explanation allocation. If no
summary fits or obligations withhold background, `output.omitted_verification` reports the
withheld records. A null summary never proves nothing was tested.

Routine command-shaped test criteria are summarized separately in `planned`, with
`status: "planned"`, source-record counts, and bounded references. They never increase
`reported_records`. A plan-only summary has top-level `status: "planned"`. Causal findings,
qualified checks, and applicable obligations remain explanatory or governing material.
`output.omitted_planned_verification` counts planned records excluded from the summary.

## Evolution and authority

`knowledge.evolution` distinguishes:

- `relationship`: retained decision/revision endpoints, `supersedes` or `challenges`,
  standing, scope, attribution, and the resolver's actual `applied` / `not_applied` effect.
  Endpoint wording is included when retrieved; otherwise `availability: "not_retrieved"`
  explicitly limits the explanation.
- `outside_scope`: an observed relationship has no effect in this query's scope. It must
  not be used to declare the earlier statement obsolete.
- `change_passage`: source wording mentions change, but no established connection is
  asserted. `account_id` names the retained account; `earlier` and `relationship` are null,
  and standing is `recorded_wording_only`. Read the passage: it may describe a proposal,
  rejection, or explicit non-change. Ordinary output refers to the complete account already
  carried in rationale instead of repeating its wording. Audit also provides bounded `wording`
  and nullable `reason` previews (`text`, original character `length`, `truncated`). A truncated
  preview is not sufficient evidence for a replacement claim. Passages from the same artifact/event
  are grouped, with `related_passages` carrying other account IDs and authority classifications.
  `source` identifies that event. Grouping describes a shared source event, not one decision
  or an established replacement. Separate events are not merged merely for similar wording.

Only the existing authority resolver establishes relationship effects. Later dates and
similar words do not. Replacing one decision does not retire its artifact's surviving
siblings. `not_standing` may mean unadopted, not superseded.

Selection allocates the strongest explanatory accounts before discretionary changes. A later
decision can receive space through localized support from those accounts (including recorded
alternatives), without requiring a file touch or formal supersession edge. Change-like summaries
and criteria have no separate reserved allocation. Explicit corrections and relationship effects
remain qualified together with their account. Every discretionary unit shares the final-response
target; required qualifications use whole-unit omission rather than clipping.
An unrelated cleanup sentence cannot reserve a broad outcome through its other paragraphs.
This only changes selection of whole accounts; it never creates a shortened evidence passage.
Lexical admission requires informative overlap in the account's wording as well as local
wording/reason overlap with a candidate explanation. A change verb alone does not substitute
for that connection. Both discovery and output filtering include the candidate's recorded
alternatives; verification-only context does not seed supplemental explanations. Vocabulary
matches remain provisional and vocabulary-disjoint changes may still be missed.

`context.historical_boundary` controls what stood then. `context.observation_ceiling`
controls which later annotations were observed. `diagnostics.later_annotations` is not
a timeline: a current query may have none despite extensive earlier design changes.

## Limits and inspection

Applicable obligations retain priority. If they cannot all fit or identity limits leave
their coverage uncertain, `output.rationale_withheld` explains why background explanations
are unavailable. Candidate summaries remain. `output.inspect` supplies at most four
omitted-record descriptors when space allows; it is not a complete omitted-record index.
Each descriptor has `reference`, `kind`, a nullable bounded `wording` preview,
`reason: output_budget` or `selection_target`, and `qualification_recovery: use_context`. The preview helps select
an expansion; it is not shortened evidence and must not be used without the full account.
Use `knowledge lookup --adopted` for governing obligations.

The 32 KiB rationale ceiling is a safety limit, not a size goal. Ordinary selection stops near
16 KiB and at most six ordinary accounts. Accounts and related change decisions share a
20 KiB final-response target; change vocabulary cannot bypass it. Strong explanations are
selected before discretionary evolution. Material qualifications stay with their account;
governing obligations retain the hard allowance and withholding policy. Weak background does
not fill spare capacity. `output.selection.stopped` is `exhausted`,
`selection_target`, or `output_budget`. None asserts semantic sufficiency or complete history.
`target_bytes` is null for explicit audit. Output omissions remain distinct from
retrieval limits. Repeated diagnostic totals/code-count inventories are absent in ordinary
output; distinct issue messages, occurrence counts, and omitted-warning counts remain.

Each explanatory unit, including its required context, has an 8 KiB allowance in all three
views. Oversized units are omitted whole, not silently clipped. Up to four placeholders retain
their position among returned explanations, within a 2 KiB ordinary placeholder allowance.
Material corrections may require more space; `output.target_exception` discloses a required
metadata/qualification overrun of the ordinary target, never of the hard ceiling.
They carry identity, kind, source, connection strength, authority classification, time context,
a neutral omission reason, and the exact account `reference`; they have no `account` or `context`.
This means too large to shorten safely, not irrelevant. Rejected lexical material gets no placeholder.

When present, `source_reference` expands a distinct source account; `context_references` expands
resolved authority; `corrections` retains status, kind, source, exact action references, and
`content: "not_displayed"`. Relationships retain endpoints, standing, scope, and actual effect;
outside-scope relationships remain explicitly unapplied. Conflicts, unresolved points, and
scope/coverage limitations remain warnings, not silently absent qualifications. `change_passage`
denotes only recorded change-related wording, never an established replacement.
Context references, corrections, and each relationship list are individually capped at four,
with explicit omitted counts. A placeholder is a discovery aid, not enough evidence to state
what the missing account decided or what currently stands.

Use the shared `follow_up` command template with the attached references. `output.inspect` is
reserved for other omitted units, not duplicate copies of placeholder references.
Exact account expansion returns original reasons and alternatives; it does not independently
establish authority. Its current-status summary discloses unexamined qualifications. Use `--context` on the
account reference to recover its qualifying identities, including undisplayed references.
Exact candidate inspection or explicit audit may carry the larger captured body. Governing obligations
keep their separate full-response allowance and withholding policy.

Ordinary references are readable record selectors, not serialized observations:

- `capture:<event-id>:<field-path>` identifies an original captured account.
- `interpretation:<id>` and `correction:<id>` identify recorded extraction or correction records.
- `requirement:<id>`, `decision:<id>`, `claim:<id>`, and `relationship:<id>` identify knowledge entities.

`knowledge show` selects the project from `--project` or the checkout, repeats access checks,
and reads current qualification status without rewriting captured wording. Authority scope
defaults to project; `--scope artifact:<id>` selects artifact-specific authority. Missing or
restricted records stay unavailable; there is no cross-project fallback. No reference cache,
encoded snapshot, ordinary-reference hash, or legacy token reader is involved.

The default response includes concise `current_status` and explicit completeness reasons.
`--context` returns full qualifying records with pagination. Unexamined qualifications and
unavailable evidence are not equivalent to an absence of corrections. A selector survives
unrelated writes; a context cursor binds one observation and rejects stale continuation.
Restart pagination without its cursor after history changes. Explicit historical candidate
and section inspection still uses its original anchor and query scope.

Keep these independent quantities separate:

- `pagination`: matches outside the page of already evaluated provenance results.
- `diagnostics.candidate_selection`: candidate/support artifacts not evaluated.
- `diagnostics.retrieval`, `.knowledge_limits`: bounded discovery or resolution, unreadable
  sources, and index availability; not merely omitted output.
- `output.omitted_rationale`: complete explanatory units not carried; excludes routine
  verification summarized separately. `omitted_knowledge` counts resolved identities not
  fully carried, which can overlap those units. Do not add these counts together.
- `output.selection`: `excluded_lexical` counts retrieved explanations rejected for weak local
  support; `omitted_supplemental` counts accounts excluded by ordinary selection or the separate
  optional-background allowance; `omitted_changes` counts retrieved change/correction units not carried. The last
  two are subsets of rationale omissions, not additional missing records.
  `grouped_interpretations` counts variants folded into source groups, not lost explanations.
  `grouped_interpretations` and `excluded_lexical` are audit-only counters.
- `output.selection.omitted_oversized`: relevant explanation bodies above the per-item limit,
  including those represented by placeholders. `omitted_placeholders` counts those whose
  placeholder also could not be carried. A placeholder does not count as a complete explanation
  or fully carried knowledge and is not subtracted from `omitted_rationale`.
- `output.omitted_provenance`: zero on successful schema-8 responses; background cannot
  evict page summaries. `omitted_audit` counts detailed records that did not fit.
- `diagnostics.completeness`, `.project_coverage`, `.processing`, `.integrity`,
  `.seed_guidance`, `.uncertainty`: provenance/knowledge coverage and actionable warnings.

Diagnostic issue collections group repeated code/message/resource/count combinations into
bounded previews with occurrence counts, total/code counts, and omitted issue counts.
Detailed source identities remain in `audit.diagnostics` when they fit. Default output
omits internal coverage tokens and full source-version inventories. Details adds the full
retrieval counters and bounded audit records; exact expansion provides deeper record history.
Ordinary output also omits candidate/materialization and captured/imported artifact inventories,
lexical matched/rejected counts, and suppressed seed-guidance internals. Actual omissions,
incomplete coverage, restricted/unavailable evidence and applicable follow-up actions remain.

The default candidate page is five. `--all` changes the default limit to 1,000; explicit
`--limit` overrides it. Separate processing budgets cover 500 candidate artifacts and
500 overlap-support artifacts. Neither flag promises complete history. Follow
`pagination.next_offset` while preserving `--project`, `--scope`, `--branch`, `--origin`,
`--touching`, and `--at`. Pagination does not continue rationale search. Repeated queries
read current history; `--at` fixes code, not artifact history.

Rationale retrieval examines up to 16 candidate artifacts, 32 direct/support events,
16 interpretations per event, and 64 identities per governing/event context. Target
evidence influences interpretation and identity selection before those limits.
Lexical discovery uses at most 32 terms, 256 postings per term, 4,096 postings overall,
and 32 matched accounts. The index retains at most 128 accounts per event, 32 KiB per
account, and 256 terms per account. Vocabulary-disjoint changes and saturated posting
lists can be missed. Missing/stale indexes disable discovery; reads never repair them.
Before the 32-account limit, bounded previews (1,024 wording characters and 512 reason characters)
must share at least two informative terms with one seed and have wording-level support,
including for change passages. Generic path/platform words alone do not qualify. Pure numbers do not consume
search seeds. Up to eight qualified change passages receive reserved discovery slots.
`rejected_accounts` counts preview-based exclusions; `truncated_qualification_previews` warns
that matching text beyond those windows was not considered. These previews are selection inputs,
not excerpts presented as complete accounts. Source reads still enforce restrictions.
Output bounds do not imply constant-cost Git work or authority resolution.

## Migrating from the released why schema 4

The released schema-4 response predates focused rationale and exact knowledge inspection.
Read the new knowledge sections using the contracts above, including grouped accounts,
qualified evolution, reported verification, and explicit oversized omissions. Intermediate
development response formats are not compatibility contracts.

| Previous path                                                             | Schema 8                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `best.artifact_id`                                                        | Find `best` in `results[].id`, or use `best_candidate`                     |
| Rich `results` / `best` with details                                      | Summaries remain; rich bodies are `audit.candidates`                       |
| `scope`                                                                   | `context.scope`, with the knowledge query mode and boundaries in `context` |
| Top-level coverage, integrity, uncertainty, selection, seed guidance      | `diagnostics`                                                              |
| Source versions, revision histories, mapping/byte ranges, extraction data | Details or exact expansion                                                 |
| `detail_omissions`                                                        | View contract plus `output` counters                                       |

## Example excerpts

These are excerpts, not complete envelopes; identities and references are illustrative.
An ambiguous query retains both candidates:

```json
{
  "schema_version": 8,
  "conclusion": "ambiguous",
  "best": null,
  "results": [
    {
      "id": "artifact-a:event-a",
      "artifact_id": "artifact-a",
      "source_event_id": "event-a",
      "confidence": "weak"
    },
    {
      "id": "artifact-b:event-b",
      "artifact_id": "artifact-b",
      "source_event_id": "event-b",
      "confidence": "weak"
    }
  ]
}
```

A selected result identifies its summary without repeating the whole candidate:

```json
{
  "conclusion": "supported",
  "best": "artifact-a:event-a",
  "results": [{ "id": "artifact-a:event-a", "confidence": "exact" }]
}
```

Withheld rationale is different from finding no explanatory history:

```json
{
  "knowledge": { "obligations": [], "rationale": [], "evolution": [], "verification": null },
  "output": {
    "rationale_withheld": "Applicable obligations could not all fit or could not all be examined.",
    "omitted_provenance": 0
  }
}
```

Unavailable source evidence remains visible even when some candidates are usable:

```json
{
  "diagnostics": {
    "retrieval": {
      "unavailable_events": 1,
      "limits": [
        {
          "kind": "restricted_source",
          "detail": "A candidate source could not be read within access and size limits."
        }
      ]
    }
  }
}
```
