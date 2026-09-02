import { ATTRIBUTION_INSTRUCTION } from '../attribution.js';
import type { SkillTemplate } from '../types.js';

export const orcaopsFinishSkill: SkillTemplate = {
  id: 'finish',
  name: 'Orcaops: finish workflow',
  description:
    'Close completed work in one command: run enabled pre-PR checks, pause on warnings, save the summary, sync, and render the digest.',
  tags: ['orcaops', 'capture'],
  required: true,
  body: `# When to use

Use this after all checkpoints are closed and the work is ready to finalize.
It is the normal closing path. The standalone pre-PR, summary, and digest
commands remain available for inspection and repair.

${ATTRIBUTION_INSTRUCTION}

# Run finish

\`\`\`bash
orcaops finish --invoked-by-agent <your-agent-id> --input - <<'EOF'
outcome: <what shipped>
tests_written: []
tests_run: []
open_items: []
deferred_decisions: []
EOF
\`\`\`

The artifact id is optional when exactly one active artifact exists.

# Respond to the result

- \`finalization_status: finalized\`: the summary, usage, sync, and digest completed.
- \`finalization_status: finalized_without_digest\`: the summary is saved. Run the
  returned repair command.
- \`status: needs_attention\` with \`acceptance_allowed: true\`: fix the findings and rerun,
  or copy the returned \`accepted_warnings\` into the same finish input and replace
  every empty reason. Acceptance is bound to that exact review and exact run set.
- \`status: needs_attention\` with \`acceptance_allowed: false\`: an evaluator failed.
  Rerun finish; errors cannot be accepted.
- \`status: blocked\`: resolve or rerun the named block-severity checks before retrying.

\`finalization_status\` is absent when finish pauses. Do not call summary after a
warning pause: finish has not persisted it or rendered its final digest yet.
If the work, evaluator set, plan, checkpoints, index, or relevant worktree input
changes, the prior warning review is stale and finish will require a fresh pass.

A replay can return both \`idempotency_status: replay\` and
\`finalization_status: finalized\`. No new summary was written; finish verified the
prior result and generated or repaired its digest.

# Amending a completed summary

An amendment corrects the wording of the existing summary. It does not reopen
the review or make the artifact cover later work. Pass the latest
\`prior_summary_event_id\` and repeat every previously accepted warning exactly,
including its reason. Order does not matter. Adding, removing, or changing an
acceptance is refused. Capture later work in a new artifact.
`,
};
