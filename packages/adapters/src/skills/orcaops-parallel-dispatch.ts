import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * Opt-in orchestration skill: run a plan's steps as FULLY CONCURRENT subagent
 * tasks with orcaops as the shared ledger. Plan-level scope separation is
 * step-id disjointness at open (the `OPEN_CP_OVERLAP` protocol);
 * attribution under overlapping checkpoint windows is rebuilt at close by
 * the segment-refined claims partition, so agents never take
 * turns or declare file scopes. The close-time `files_changed`
 * self-report is load-bearing: it is the attribution claim for genuinely
 * concurrent changes. Enable with `orcaops skills enable parallel-dispatch`
 * + `orcaops update`.
 */
export const orcaopsParallelDispatchSkill: SkillTemplate = {
  id: 'parallel-dispatch',
  name: 'Orcaops: parallel dispatch',
  description:
    'Parallelize or split a captured plan across subagents while keeping their work separately recorded.',
  tags: ['orcaops', 'orchestration'],
  group: 'orchestration',
  defaultEnabled: false,
  blockTriggerLine: (prefix: string) =>
    `parallel dispatch ("split this plan across subagents") → \`${skillRef('parallel-dispatch', prefix)}\``,
  body: (prefix: string) => `# When to use

Triggers (user phrasing):

- "parallelize this plan", "dispatch these steps to subagents"
- "split this plan across subagents", "run these tasks in parallel"
- "spec-driven dispatch", "SDD ledger"

Skip when: one agent is doing the work sequentially —
\`${skillRef('capture', prefix)}\` + \`${skillRef('checkpoint', prefix)}\` already cover it.

# Protocol

Subagents dispatch FULLY CONCURRENTLY — nothing in this protocol asks
agents to take turns, reserve files, or wait for each other. Plan-level
scope separation is step_id disjointness at open, and attribution across
overlapping checkpoint windows is rebuilt at close from boundary
snapshots (changes in intervals where only one checkpoint was active
attribute to it conclusively) plus each agent's close-time self-report.

1. **Plan = task list.** Capture (or revise) the plan so each dispatchable
   task is ONE step with its own \`acceptance_criteria\` (the rubric the
   subagent must satisfy). Save the returned \`step_id\`s — they are the
   dispatch tokens.
2. **Brief each task.** For every step:

   \`\`\`bash
   orcaops step brief <step_id> --json
   \`\`\`

   Paste the brief into the subagent's prompt: step text + label,
   \`acceptance_criteria\` WITH their \`criterion_id\`s (the subagent needs
   them for \`done_criteria\` evidence), \`guardrails\` (non_goals +
   touched_scope), and sibling claim states (what the other agents own). A
   brief with \`dropped_in_latest_revision: true\` is informational-only —
   NEVER dispatch it (checkpoint opens validate against the active revision).
3. **Open claims the step_id.** Each subagent MUST run
   \`checkpoint open\` declaring exactly its own \`step_id\` BEFORE touching
   the worktree —
   open marks the start of its attribution window. An \`OPEN_CP_OVERLAP\`
   error means another agent owns the step (open or already-claimed):
   **never retry with force, never widen the declared scope** — report
   back to the parent instead. If two agents genuinely need one step, the
   PARENT revises the plan to split it (overlap is a coordination bug,
   not a soft policy). Once open, work freely and concurrently — sharing
   the worktree with other open checkpoints is expected and handled.
4. **Close with an ACCURATE and COMPLETE \`files_changed\` — it is the
   attribution claim.** Under overlapping windows orcaops attributes
   conclusively from boundary-snapshot evidence where it can (a file you
   changed while no sibling was open stays yours even if you forget to
   report it), and arbitrates the genuinely concurrent changes by each
   checkpoint's \`files_changed\`. Report every file the task actually
   changed — no more, no fewer: an under-report of a concurrently-touched
   file can cost you the claim, and an over-report is rejected and
   flagged when the evidence contradicts it. On success close with
   \`completed_step_ids: [its step_id]\` and \`done_criteria\` entries keyed
   to every one of the brief's \`criterion_id\`s, plus at least one
   \`verification\` record for a command run fresh at close. If no meaningful work happened
   (dispatch failed, task rescoped), ABANDON — which releases the step
   for a fresh dispatch — rather than closing empty.
5. **Parent finishes the thread.** After every task resolves, use
   \`${skillRef('finish', prefix)}\` for the normal finalization path — one
   artifact, one reviewer-facing thread, per-step attribution intact.`,
};
