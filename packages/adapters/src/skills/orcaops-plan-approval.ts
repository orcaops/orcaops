import { ATTRIBUTION_INSTRUCTION } from '../attribution.js';
import type { SkillTemplate } from '../types.js';

/**
 * The skill owns the cloud APPROVAL loop — upload, wait, pull the approved
 * version, pin. The CLI verbs are `orcaops plan review …` even though the
 * skill id is `plan-approval` (surface stability). Proactive plan CRITIQUE
 * (draft review against prior art) is a different skill: `plan-critique`.
 */
export const orcaopsPlanApprovalSkill: SkillTemplate = {
  id: 'plan-approval',
  requires: ['cloud'],
  name: 'Orcaops: plan approval (cloud source plan)',
  description:
    'Get a plan APPROVED on the cloud web surface and pin the approved version as a graded conformance anchor — "get this plan approved", "upload my plan for approval", "is my plan approved yet?", "any feedback on my uploaded plan?", "pull the approved plan". Drives the approval loop end to end (upload, status/view/pull/propose/comment/verdict/decline/approve/diff/reviewers via the `orcaops plan review` CLI verbs), waits on approval with the bounded watch loop, and is the path when you need to read or download a plan body (the in-review candidate, or the approved version) or pin a local plan file as a born-pinned conformance anchor. Skip for: critiquing a plan draft before capture (plan-critique skill).',
  tags: ['orcaops', 'capture'],
  body: `# When to use

When the slice plan for a task is reviewed on a **web surface** (not just a
local file), or when you want to pin a local plan file as an immutable,
graded conformance anchor. The pin is consumed origin-agnostically by the
\`plan-conformance\` evaluator; pinning is the same regardless of which track
produced it.

${ATTRIBUTION_INSTRUCTION}

There are two tracks. Pick by where the plan lives.

# Read or download a plan body

Fetching the *body* depends on the plan's state — pick by that, not by which
track minted it:

- **In review (the common case)** — pull the live candidate:
  \`orcaops plan review pull <ref> --out <file>\`. Default target is the current
  under-review candidate. \`--proposal <id>\` pulls a proposal body instead;
  \`--version <n>\` pulls a sealed HISTORICAL version (read-only, never cached —
  see below). This body is **inspect/edit-only — NOT pinnable** as a
  \`cloud:<id>@<n>\` conformance anchor.
- **Approved (pinnable)** — \`orcaops plan pull <ref> --out <file>\`. This is a
  DIFFERENT command and only resolves once the plan is APPROVED; it
  \`NOT_FOUND\`s while the plan is still in review. Its body IS the graded pin.
- \`orcaops plan review view <ref>\` shows review **STATE**, not the body — it
  returns NO plan text. To read or download the body use \`plan review pull
  --out\` (in review) or \`plan pull --out\` (approved).

\`orcaops plan pull\` = the APPROVED, pinnable version (no \`--version\` flag — a
bare \`--version\` hits the global version flag and prints the CLI version).
\`orcaops plan review pull\` = the in-review candidate / proposal / historical
version (inspect/edit-only, never pinnable). Two different commands.

# Track A — review on the web, then pull (\`cloud:\` pin)

The plan is uploaded, approved by a human in the cloud, then pulled and pinned.
\`pinned == graded\`, and the push transitions the cloud plan \`APPROVED → PINNED\`.

1. **Upload** the plan file for review (\`--title\` is required):

   \`\`\`bash
   orcaops plan upload docs/slice-plan.md --title "Rate limiting the charges API" \\
     --reviewer @alice --review-note "focus on the Redis fallback"
   \`\`\`

   The id is **crash-safe + deterministic** (re-running the same file+content
   replays onto the same draft; an edit mints a new immutable draft and the
   prior id is reported). Note the printed \`externalId\`.

   **Check \`unresolved\` in the output.** Non-empty means those reviewer tags
   matched NOBODY — the plan is in review with no reviewer requested for them
   and no one notified. The CLI prints did-you-mean matches under the warning;
   confirm the full email with the user (v1 handles are full emails) or run
   \`orcaops plan review reviewers\` for the addressable roster, then re-run the
   upload with the corrected \`--reviewer\` (changed reviewers mint a new draft;
   the prior id is reported — that is expected).

2. **Approve** the plan in the cloud web UI (out of band).

3. **Pull** the approved version into the local pull-cache:

   \`\`\`bash
   orcaops plan pull <externalId>            # or the slug
   orcaops plan pull <externalId> --out docs/approved-plan.md   # also write the body
   \`\`\`

   It verifies the body hash and prints the ref to pin:
   \`--source-plan cloud:<externalId>@<versionNumber>\`. \`NOT_FOUND\` means
   there is no APPROVED version yet — get it approved first.

4. **Capture** against the pulled plan, then **push**:

   \`\`\`bash
   orcaops capture plan --input - --invoked-by-agent <your-agent-id> --source-plan cloud:<externalId>@<version> <<'EOF'
   task: |-
     ...
   EOF
   orcaops push <artifact_id>
   \`\`\`

   The push runs a **read-only preflight before publishing anything**: a
   wrong-origin / missing / stale / not-approved pin aborts with no orphan.
   On success it transitions the cloud plan \`APPROVED → PINNED\` in place.

# The review loop — read, react, triage (between upload and approval)

Match the user's intent to the verb. All read verbs take \`--json\` and print
the ready-to-paste \`cloud:<id>@<n>\` pin ref wherever an approved version
exists; none of them touch the local review cache (only \`plan review pull\`
does).

- **"What's the state of my plan review / any feedback?"** →
  \`orcaops plan review status\` (plans you authored + plans wanting your
  verdict, with per-plan next actions and a current-vs-stale verdict rollup),
  then \`orcaops plan review view <ref>\` for one plan's full state: candidate
  (with its \`Baseline: <branch> @ <sha7>\` authoring anchor when one was
  recorded), reviewer **standing**, open proposals (+ needs-rebase), comments
  (\`--comments\` for the whole thread; \`--history\` for each reviewer's full
  verdict trail; \`--proposal <id>\` to scope).
  Each reviewer shows a cloud-resolved \`standing\` — \`PENDING\`, \`APPROVED\`,
  \`CHANGES_REQUESTED\`, or \`NEEDS_RE_REVIEW\` (a prior verdict cast against an
  OLDER candidate; verdicts do not reset on a new push). Trust \`standing\`
  directly — it folds staleness in server-side, so a \`NEEDS_RE_REVIEW\` is
  needs-re-review, never a current sign-off, and \`status\` likewise surfaces a
  \`NEEDS_RE_REVIEW\` seat as still wanting your review.
- **"What plans are in review?"** → \`orcaops plan review list\`
  (\`--state in-review|approved|pinned|all\`, \`--mine\`, \`--author/--reviewer
  <email>\`, \`--limit\`; truncation is always announced; there is no DRAFT
  state — plans enter review at upload).
- **Address review feedback (author):** \`view\` →
  \`orcaops plan review pull <ref>\` (add \`--out <file>\` to read it) → edit →
  \`push <ref> --input <file>\`. Close a proposal you won't absorb with
  \`decline <ref> --proposal <id> --reason "…"\`. To absorb one, pull it
  (\`orcaops plan review pull <ref> --proposal <id>\`), fold it into the body,
  and \`push\` — there is deliberately no CLI integrate.
- **Review someone else's plan (reviewer seat):**
  \`orcaops plan review pull <ref>\` (\`--out <file>\` to read it) → read →
  \`comment\` / \`propose\` → record your advisory verdict:
  \`orcaops plan review verdict <ref> --approve|--request-changes [--note]\`.
  Verdicts never transition the plan — approval itself is web-only.
  **Reply to a comment** with \`orcaops plan review comment <ref> --reply-to
  <commentId>\` (one level only; a reply inherits the parent's target, so it
  takes no \`--quote\` / \`--disambiguator\` / \`--proposal\`). \`view\` prints each
  comment's id next to it for copy-paste. Replying to a reviewer's *verdict*
  is web-only — \`view --history\` renders verdict-replies read-only under their
  verdict, but the CLI cannot create one.
- **"What changed?"** → \`orcaops plan review diff <ref>\` (approved →
  candidate), \`diff <ref> --proposal <id>\` (candidate → proposal), or
  \`diff <ref> --from <n> [--to <m>]\` (sealed vN → vM, \`--to\` omitted =
  current candidate) — the reviewer's "what changed since I reviewed vN?".
  \`orcaops plan review pull <ref> --version <n>\` fetches one sealed body
  read-only (never cached, NOT a push base — it exists for inspection and
  diffs).
- **"Who can I request as a reviewer?"** → \`orcaops plan review reviewers\`
  (the org roster + a scope note; repo-aware once per-repo lists exist).
  Use it to resolve \`--reviewer\` handles before an upload.
- **Get it approved:** \`orcaops plan review approve <ref> --wait\` opens the
  web approval page (\`--no-open\` prints the URL) and polls until a human
  approves, then prints the pin ref. **Exit 0 without \`--wait\` means
  LAUNCHED, not approved.** A \`--wait\` timeout exits 2
  (\`REVIEW_APPROVE_TIMEOUT\`) — not approved yet, not a failure. After
  approval: \`plan pull <ref>\` → \`capture plan --source-plan cloud:<id>@<n>\`.

# Waiting for review — the watch loop

When the session is blocked on approval or feedback, run the bounded watch
loop instead of ad-hoc polling reads:

1. **Arm** \`orcaops plan review approve <ref> --wait --timeout <sec>
   --no-open\` in the background. **Always \`--no-open\` on a re-arm** — the
   browser was already opened once (or the human has the URL); re-opening
   it every cycle is hostile.
2. **Exit 0** → approved. Pull + pin: \`plan pull <ref>\` →
   \`capture plan --source-plan cloud:<id>@<n>\`.
3. **Exit 2** (\`REVIEW_APPROVE_TIMEOUT\`) → run exactly ONE
   \`orcaops plan review view <ref>\` to tell silence from feedback:
   - **Something moved** — new comments, a new proposal, a verdict change
     (including a reviewer now reading \`NEEDS_RE_REVIEW\`): surface it and act
     on the feedback (address it, push a new candidate) instead of re-arming.
   - **Nothing moved**: re-arm step 1.
4. **Cap the loop.** After 2–3 dry cycles (timeouts where nothing moved),
   stop re-arming and hand the turn back to the user with the ref and the
   current review state — a silent reviewer is the human's problem to chase,
   not a reason to poll forever.

# Track B — pin a local file (born-pinned)

No web review — pin a local plan file directly. The push creates a
born-\`PINNED\` cloud plan under a stable CLI-derived id.

\`\`\`bash
orcaops capture plan --input - --invoked-by-agent <your-agent-id> --source-plan ./docs/slice-plan.md <<'EOF'
task: |-
  ...
EOF
orcaops push <artifact_id>
\`\`\`

If \`./docs/slice-plan.md\` traces to a prior \`plan pull --out\` (same org), the
born-pin records \`derived_from\` lineage automatically; otherwise lineage is
simply omitted (never a wrong id).

**Born-pin version note (load-bearing):** the CLI seals a born-pin at
\`version_number: 1\`, not \`null\`. A fresh plan is
version 1, and a re-push (or a concurrent first-push loser) funnels into the
cloud's idempotent A-replay, which acks on \`version 1 + content_hash\`. Sending
\`null\` would 409 on that race. So a Branch-B **re-push returns an idempotent
ack, NOT a 409** — that is expected, not a bug.

# Re-runs, edits, and errors

- **Re-push** (either track) is idempotent — it acks rather than duplicating.
- **Edited the plan after capture?** The pin is **frozen set-once at capture**;
  \`--source-plan\` is NOT accepted on \`capture plan revise\`. Re-pull / re-upload
  and capture afresh to pin a new version.
- **\`stale\` / \`re-pull\` on push** — the cloud's approved version moved since you
  pulled; \`plan pull\` again and re-capture.
- **Can't get the plan body?** \`plan review view\` shows STATE only (no body) —
  read the body with \`orcaops plan review pull <ref> --out <file>\` while
  in review, or \`orcaops plan pull <ref> --out <file>\` once APPROVED
  (\`plan pull\` \`NOT_FOUND\`s before approval). A read verb that seems
  "missing" is usually on the other track: \`orcaops plan review --help\` lists
  the review-track verbs (pull/propose/push/comment/view/list/status/
  reviewers/verdict/decline/approve/diff).
- **Ambiguous \`cloud:\` ref at capture** — the same id is cached under multiple
  cloud sessions; re-run \`plan pull\` for the intended cloud, or clear the stale
  namespace under \`.orcaops/cache/source-plan\`.
- **\`run \\\`orcaops plan pull\\\` first\`** — the \`cloud:\` ref isn't cached locally;
  capture is offline, so the approved version must be pulled before it can pin.
`,
};
