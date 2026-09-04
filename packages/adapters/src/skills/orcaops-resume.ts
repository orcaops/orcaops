import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

export const orcaopsResumeSkill: SkillTemplate = {
  id: 'resume',
  name: 'Orcaops: resume an artifact',
  description:
    'Resume one in-flight artifact with a paste-ready continuation prompt, or cold-start it in a fresh worktree or clone. Use for "where was I?", "pick up where we left off", or "continue artifact <id> here"; a broad branch-status survey is `orcaops status`.',
  tags: ['orcaops', 'read'],
  body: (prefix: string) => `# When to use

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

Do **not** match (use \`orcaops status\` instead):

- "what's the status of <branch>?", "what's going on?"
- "show me what's in flight", "what's the state of work?"

These are survey questions — \`orcaops status\` returns the full thread
state across all artifacts, which is the right answer. \`resume\` is
narrower: it picks one in-flight artifact and produces a paste-ready
continuation prompt.

# How to invoke

\`\`\`bash
orcaops resume                          # latest active artifact on current branch
orcaops resume --branch feat/x          # specific branch
orcaops resume --artifact <id>          # specific artifact
orcaops resume --accept-default         # choose and pin the newest active candidate
orcaops resume --accept-default --no-pin # choose it once without saving the choice
orcaops resume --json                   # machine-readable
orcaops resume --copy                   # also copy the suggested prompt to clipboard
\`\`\`

When more than one artifact is active and no pin selects one, resume returns an
ambiguous picker instead of guessing. In JSON, inspect \`candidates\` and
\`default_candidate_id\`. Use \`orcaops checkout <id>\` to save an explicit
choice, \`orcaops resume --artifact <id>\` to use one only this time, or
\`--accept-default\` to choose the most recently active candidate and save that
choice. Add \`--no-pin\` when accepting the default should be one-time only.

# Interpreting the output

Output sections:

- **Plan steps** — each marked ☑ (done) or ☐ (remaining). Step
  completion is **agent-declared** via each checkpoint's
  \`completed_step_ids\` field (UUIDv7s, stable across plan
  revisions). The runtime never infers — if a step was completed but
  no checkpoint claimed its step_id, it'll still show as ☐.
- **Plan revisions** — \`revision_n\` shows how many times the plan
  has been revised; closed-cp completions whose step_ids no longer
  appear in the latest plan surface under "Historic completions"
  (audit-only — the steps themselves were dropped via
  \`orcaops capture plan revise\`).
- **Top-level \`plan_event_id\`** (in \`--json\` mode) — the latest
  plan event_id, suitable for passing forward as
  \`plan_revision_id\` on the next \`orcaops capture checkpoint open\`
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
  Each shows its declared scope, \`agent_session_id\` (if any subagent
  attribution), and how long it's been idle. A fresh agent can either:
  (1) close in-flight work that the prior session left open,
  (2) abandon a stale open with a reason, or
  (3) open a new cp on the **uncovered plan steps** (also surfaced in
  the resume output).
- **Suggested prompt** — paste-ready text the user can hand back to you
  ("continue from step N: do X, Y") to re-anchor.

Surface any \`repo_state\` note before continuing. The current renderer may say
that the working tree is dirty, that commits since \`artifact_head_sha\` touch
the artifact's files and work may already be partly done, that HEAD moved with
no overlap, or that open items may already be addressed. Use the accompanying
\`repo_state\` fields to decide what needs rechecking; do not substitute an
older quoted warning.

# Cold-start in a fresh worktree (the handoff mechanic)

\`orcaops resume --artifact <id>\` also cold-starts work this worktree
has never seen — **if the archive is enabled** (\`archive.enabled:
true\`; without it this path simply doesn't exist and resume reads the
local hot store only). When the hot store lacks the artifact, resume
restores it from the home-dir archive first — the response carries
\`restored_from_archive: true\` — then the thread continues normally
(checkpoint open → work → close) and new events mirror back to the same
archive automatically.

1. Find the artifact id if unknown — search the archive from anywhere
   (archive-enabled installs only). From inside a repo or linked worktree,
   these commands include both hot and retained archive history for the
   current project; duplicate artifact IDs use the freshest projection
   (archive only when strictly newer, tie to hot):

   \`\`\`bash
   orcaops list --all-projects --json
   orcaops search "<task terms>" --all-projects --json
   \`\`\`

2. In the TARGET worktree (init'd, \`archive.enabled: true\`, same
   project identity — worktrees share it automatically via git config):

   \`\`\`bash
   orcaops resume --artifact <id> --json
   \`\`\`

Failure modes:

- \`INVALID_INPUT\` mentioning divergence: this worktree holds LOCAL
  events the archive lacks — run \`orcaops archive repair\` here first
  (mirror the local work), then retry. Handoff is a move, not a fork.
- \`UNKNOWN_ARTIFACT\`: not in this project's archive — check
  \`orcaops list --all-projects --json\` for the right project, and that
  this repo shares the source project's identity
  (\`git config --local orcaops.projectid\`).

# When there are no in-flight artifacts

\`orcaops resume\` will report "No in-flight artifacts on branch <name>"
(or equivalent) when every artifact on the branch has either a captured
summary or no plan at all.

**Stop. Do NOT re-run the same command, do NOT loop through
\`orcaops status\` / \`show\` / \`git log\` looking for hidden state.**
The runtime is authoritative — there genuinely is no thread to resume.

Instead, present 2-3 options to the user and ask which they want:

1. **Open the PR** for the most recently summarized artifact
   (run \`orcaops digest --artifact <id>\` first if missing).
2. **Start a new task** — capture a new plan via \`${skillRef('capture', prefix)}\`.
3. **Start a follow-up artifact** if later or forgotten work remains. A
   summary amendment only corrects the existing summary's wording; it does
   not reopen the plan or make the closed artifact cover new work.

Pick one based on the user's response. The runtime can't infer their
intent here — only the user knows whether the closed artifact is "done"
or "I forgot to checkpoint."
`,
};
