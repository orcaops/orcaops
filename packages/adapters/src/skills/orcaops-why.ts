import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

export const orcaopsWhySkill: SkillTemplate = {
  id: 'why',
  name: 'Orcaops: why code is the way it is',
  description:
    'Trace why code is the way it is — a line, a symbol, a file, or a whole subsystem — back to the captured artifact + checkpoint behind it. Invoke before reading the code. Use when the user asks "why does X exist?" (any symbol/file/concept), "why is this built this way?", "where did this come from?", "who/what added this line?", "who owns this code?", "what is the history behind this file?", "how did this evolve?", "what was the rationale for this validator/handler/middleware?", or wants captured context on a specific change — including debugging a regression through its captured provenance: "why is this line here?", "what was the agent worried about when it wrote this?", "which change broke this and what was the rationale?"',
  tags: ['orcaops', 'read'],
  body: (prefix: string) => `# When to use

Use captured provenance when the user asks why code exists, who changed it,
or how it evolved. \`why\` locates recorded work; read its evidence and
corroborate against code, tests, or commits before explaining the rationale.

Choose the target from the question:

- **File and line:** query \`<file>:<line>\` for line attribution.
- **Named symbol:** locate its definition with \`rg\` or symbol search, then
  query that line before inferring intent from the implementation.
- **Whole file:** query \`<file>\` for ranked recorded history within the
  evaluated candidate set. This does not assert line authorship.
- **Subsystem:** start with its strongest known entry-point file, discover candidates,
  and expand relevant work using historical labels and source identities.
  Results are ranked by applicability, not newest-first. Inspect timestamps
  and detailed evidence before constructing a chronology; no entry is
  guaranteed to be the subsystem's founding decision.

# Choose the smallest useful query

Resolve existing paths with a file listing or symbol search before querying them.
For a known target and a reasons question, start with bounded rationale. Use compact
when choosing between candidate histories; a line target does not inherently need details.
For a subsystem, add another entry point when a material part remains unsupported,
not merely to gather more context. These are alternatives, not a mandatory sequence of commands.

\`\`\`bash
orcaops why src/auth.ts --json --view rationale --limit 5
orcaops why src/auth.ts --json --limit 5
orcaops why src/auth.ts:42 --json --limit 5 --branch feat/auth
\`\`\`

\`--all\` increases candidate rows, not rationale discovery or the search for later changes.
Use candidate pagination only when more candidate summaries are actually needed.

JSON schema 8 uses \`representation: "compact"\` by default. Read \`target.line\`,
\`conclusion\`, and the candidate summaries in \`results\`. \`best\` is an ID string or null.
Find that ID in \`results[].id\`, or use \`best_candidate\` when it is off-page.
Candidate-specific reasons are on each row. A null target line means whole-file history.

Read candidate confidence, reasons, shared \`candidate_caveats\`, origin, and evidence availability. Candidates cannot
be displaced by background knowledge; reduce \`--limit\` if the page itself cannot fit.
A null label is unavailable; labels/reasons are previews, not complete historical accounts.

# Read the focused explanation

Response map:

- \`results[]\`: candidate summaries; \`best\` identifies one or is null.
- \`knowledge.rationale[]\`: complete accounts or \`omitted_oversized\` placeholders.
  Read \`account.wording\`, \`reason\`, and \`alternatives\` together. An \`account: null\`
  on a continuing record means read its context accounts; a placeholder has no account.
- \`interpretations[]\` inside an explanation: exact-source unapproved variants. Read
  their distinct \`account\`, or \`account_from\` when identical; they do not inherit authority.
- \`knowledge.evolution[]\`: qualified changes; resolve \`account_id\` and \`related_passages\`
  to the already-returned accounts. Grouping by source event does not establish one replacement decision.
- \`knowledge.obligations\` and each item's \`context\`: current/historical authority and qualifications.
- \`diagnostics\` / \`output\`: retrieval limits versus omitted output.
- \`inspection.anchor\`: binds exact candidate inspection to this query and observation.
- \`output.inspect[]\`: omitted-item descriptors; wording is a discovery preview, not evidence.

For uncommon fields, consult the [response reference](https://docs.orcaops.ai/provenance-json).
Normal explanation does not require jq or learning the full schema.

Context \`wording_from\` / \`reason_from\` reuse the named account or interpretation's text
within the group. Do not discard competing revisions, corrections, scope, or uncertainty.
Simple matching context uses \`qualification\` instead of repeating revision accounts.
Interpretation kind, relevance, time context and context IDs inherit from the enclosing
group when omitted; authority remains explicit and distinct wording stays visible.

Check \`status\` first. An \`omitted_oversized\` item is a ranked placeholder, not an
explanation: it has no \`account\` or \`context\`. The full account could not be shortened
safely. Expand its \`reference\` and any attached correction and context references before
using it; current-state inspection must disclose unexamined qualifications. Its absence of
wording does not mean irrelevance. Omitted-reference counts mean inspection is incomplete.

Recorded accounts and unapproved interpretations are not automatically adopted.
\`relevance.basis\` names the retrieval route; \`candidate_event\` and \`candidate_plan\`
are indirect evidence. \`relevance.target\` distinguishes explicit path wording from
weaker target vocabulary and undifferentiated candidate context. None creates line attribution.
\`lexical_overlap\` is provisional context; vocabulary-disjoint changes may be missed.
For continuing records, \`relevance.discovery\` preserves the original route: following
a source reference from a lexical event does not strengthen its connection to the target.
Optional \`relevance.support\` connects recorded candidate accounts through the same knowledge
identity. It improves selection, not authority or decision-level file attribution.

Read \`knowledge.evolution\` for established or suggested relationships with their actual
scope effects. An established replacement with \`applied: false\` does not retire the
earlier decision in this query. Competing governing revisions remain unresolved.
A \`change_passage\` is only recorded wording, not an established supersession; it may
describe a proposal, rejection, or explicit non-change. One replaced decision does not
make its entire artifact obsolete. Correcting an account is not replacing a decision.
Corrections retain wording, status, source, and an exact action reference.

\`knowledge.verification\` summarizes reported checks, not independent verification or test
totals. Its optional \`planned\` section is not evidence that checks ran. Preserve authority,
missing-evidence warnings, and omitted status/reference counts.
Causal failures and corrected claims remain full accounts.
\`diagnostics.later_annotations\` means after the historical boundary, not the evolution
timeline; it can be empty even when the current answer contains many historical changes.

Handle evidence limits before answering:

- **\`best: null\`:** inspect conclusion and diagnostics; do not
  promote \`results[0]\` to best.
- **\`conclusion: "ambiguous"\`:** describe the competing candidates.
  One returned row does not resolve a tie, even with \`--limit 1\`.
- **Incomplete evidence:** report omitted candidates, unreadable sources,
  and provisional matches. A non-null best can still carry evidence limitations.
- **\`conclusion: "none"\`:** no evaluated matches, not proof that no history exists.

For line queries, \`exact\` means meaningful fingerprint or verified blame evidence;
\`likely\` can reflect blame inside a checkpoint interval; \`weak\` preserves related
context or uncertainty. Read the selected summary's reasons. File overlap alone
is not line authorship.

# Expand only what is needed

Choose the expansion for the missing information:

- More explanations from the same bounded retrieval: \`--view rationale\`.
- One account, oversized omission, correction, or authority state: \`knowledge show\`.
- Checkpoint decisions, changed files, or head SHA: \`why --details --candidate <results[].id>
  --anchor <inspection.anchor>\`, with the original target and scope.
- Broader artifact chronology missing from those bodies: \`show\` provides a bounded checkpoint
  index. Follow its next page or anchored \`--checkpoint <n>\` selection, not a full export.

Do not expand every candidate or run every command below. Independent entry-point queries
can run together; first decide what is missing before requesting several detailed responses.

\`\`\`bash
orcaops why src/auth.ts --json --view rationale
orcaops knowledge show <reference> --project <project_id> --json
orcaops why src/auth.ts:42 --json --details --candidate <candidate-id> --anchor <inspection.anchor>
orcaops show <artifact_id> --project <project_id> --json
\`\`\`

Use the returned readable account selector with knowledge show, for example
\`capture:<event-id>:decisions.0.decision\`. It reads the original account with current
qualification status; it does not replay the earlier why observation. The project comes from
\`--project\` or the checkout; authority scope defaults to project. Use
\`--scope artifact:<id>\` for artifact-specific authority. Inspection is bounded to 16 KiB
(32 KiB with \`--details\`) and repeats access checks. Add \`--context\` for full qualifying
records, including references omitted from a placeholder or concise context. Follow \`follow_up.next\`
when missing qualifications matter. \`completeness: { complete: false }\` does not imply
another page: read \`reasons\` and \`pagination.next_cursor\`. Unavailable evidence or unresolved
authority cannot be repaired by exporting or repeatedly requesting more history.
The selector remains usable after history advances; a stale context cursor requires restarting
pagination without the cursor. Oversized selections require explicit file export.
\`show\` includes later artifact revisions; it is not exact historical candidate reproduction.
Its schema-4 digest and exact inspections are limited to 16 KiB. Preserve the returned
anchor when selecting a checkpoint, decision, or section. Oversized units require explicit
\`--output <new-file>\`; stdout is only a receipt. Export only for a concrete missing claim
and read only the necessary content, not the entire file by default.
\`why\` has no artifact-ID filter.

Exact candidate inspection returns one \`candidate\`, including \`plan_support.plan\`, checkpoint
summary/decisions/uncertainty, and pinned \`source_plan.content\` when present, if it fits under 16 KiB.
An oversized candidate returns an \`omitted_oversized\` receipt and a \`sections\` index, not its body.
Keep the same target, candidate and anchor: use \`--section checkpoint-decisions\` or
\`--section plan-decisions\`, follow \`pagination.next_offset\` with \`--section-offset\`,
or select one complete decision with \`--decision <n>\` (one-based).
The index previews individual decisions: choose a \`--decision\` directly when possible.
Preview wording is a locator, not complete evidence. Page previews with \`--section index
--section-offset <n>\`. \`--section files\` and \`--section uncertainty\` are also paged.
\`--section checkpoint-metadata\` returns its number and head SHA without the large body.
Section inspection carries only the named fields; inspect uncertainty and knowledge context
when needed. It neither substitutes a later plan nor establishes fully qualified authority.
It does not repeat rationale or other candidate bodies. Preserve the original query scope;
changed code/history invalidates the anchor. \`enrichment\` remains supplemental.
Missing bodies remain unavailable.
Use \`--details --audit\` only for a deliberate bounded multi-candidate comparison through
\`audit.candidates\`.

\`--limit 1\` limits provenance rows, not rationale retrieval. JSON is bounded to
16 KiB by default, 32 KiB with \`--view rationale\`, and 64 KiB for explicit \`--details --audit\`.
The default candidate page is five. Human output is also bounded. If applicable obligations cannot all fit or be
examined, background rationale is withheld explicitly; candidate summaries remain.
Ordinary selection stops at a lower target instead of filling spare bytes with weak background.
\`output.selection.stopped: selection_target\` means a display policy stopped selection,
not that the question is fully answered or history is complete. Ordinary accounts and later
changes share a final-response target; change vocabulary does not bypass it. Governing
obligations and required qualifications may need the hard allowance or explicit withholding.

Read output omissions separately from retrieval, knowledge limits, and coverage warnings.
Counts can overlap; do not add them into a false total. No read repairs an index.

Follow \`pagination.next_offset\` for evaluated candidates, preserving \`--project\`,
\`--scope\`, \`--branch\`, \`--origin\`, \`--touching\`, and \`--at\`.
Pagination does not continue rationale search. \`--at\` fixes code only; repeated queries
read current captured history. See the response reference for the separate processing bounds.

# Before you answer

Corroborate material claims against current code/docs and relevant commits. When relying on
a checkpoint to describe current behavior, inspect its \`checkpoint.files_changed\` and changes
since its \`head_sha\`; expand only the supporting checkpoints needed for those claims,
not all returned candidates. State what was recorded, inferred, or unavailable.

Stop when the answer's material claims have recorded support or explicit inference labels,
the retrieved corrections/later changes have been addressed, and current behavior is
corroborated. Disclose remaining coverage limits; do not pursue exhaustive subsystem history
or claim that bounded retrieval ruled out every later reversal.

\`origin: "imported"\` means synthesized Git history. Cite the underlying
commit alongside reconstructed plan decisions. Supplemental enrichment is
not contemporaneous evidence; do not attribute a reconstructed concern to
an agent who did not record it.

For regressions, inspect \`checkpoint.uncertainty\` and the anchored plan and
checkpoint decisions. A recorded concern matching the failure is useful
evidence; a fix reversing a recorded decision should explain why. If no
suspect location is known, \`${skillRef('timetravel', prefix)}\` can inspect
checkpoint boundaries.

# On a miss in a repo with imported history

Use \`diagnostics.seed_guidance\` and cached coverage to distinguish missing history from
a narrowed query or incomplete evaluation. When guidance offers an import,
recommend the user-invoked \`${skillRef('seed', prefix)}\` skill with the named
commit or path (\`orcaops seed --commit <sha>\` / \`orcaops seed --path <dir>\`).
Record the offer with \`orcaops seed status --offered <area>\` so it is not
repeated during cooldown, as in \`${skillRef('seed-discovery', prefix)}\`.
This records only the offer; it does not import history. For a declined
area, \`orcaops seed status --offer-again <area>\` is the user's call.
`,
};
