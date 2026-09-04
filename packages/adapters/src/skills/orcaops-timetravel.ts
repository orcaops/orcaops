import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/**
 * Insight skill: consume the snapshot boundaries that capture pins. One
 * skill, three verbs, because agents skip fragmented skills: bisect a
 * regression at sub-commit granularity, salvage abandoned work WITH its
 * recorded reason, replay a feature checkpoint-by-checkpoint.
 * `requires: ['snapshot-checkout']` — inert when
 * `diff_fingerprint.enabled` is off (no refs exist to materialize).
 */
export const orcaopsTimetravelSkill: SkillTemplate = {
  id: 'timetravel',
  name: 'Orcaops: timetravel',
  description:
    'Bisect, recover, or replay checkpoint boundaries. Use for "which checkpoint broke this test?", "recover the abandoned attempt", or "replay how this came together".',
  tags: ['orcaops', 'insight', 'timetravel'],
  group: 'insight',
  defaultEnabled: true,
  requires: ['snapshot-checkout'],
  blockTriggerLine: (prefix: string) =>
    `bisect/salvage/replay checkpoint boundaries ("which checkpoint broke it?", "recover the abandoned attempt") → \`${skillRef('timetravel', prefix)}\``,
  body: (prefix: string) => `# When to use

Triggers (pick the verb):

- **bisect** — "which checkpoint broke this test?", a regression appeared
  somewhere inside an artifact's work, finer than commits can answer.
- **salvage** — "what was in the abandoned attempt?", "recover that dead
  end" — abandoned checkpoints keep their trees AND their recorded reason.
- **timelapse** — "replay how this came together" for self-review or
  build-in-public devlogs.

Skip when:

- One line's provenance → \`${skillRef('why', prefix)}\`.
- A reviewer-facing summary → \`${skillRef('digest', prefix)}\`.
- Both states are ordinary commits → plain \`git diff\`.

**Reach caveat (say it up front):** a checkpoint's open/close boundary
refs can be pruned once the artifact is no longer local-only —
time-travel is strongest on artifacts whose boundaries are still held. A
pruned boundary fails typed (\`SNAPSHOT_UNAVAILABLE\`); report it and fall
back per verb below, never guess.

# bisect

1. \`orcaops show <id> --json\` → the checkpoint list.
2. Binary-search the boundaries. For each probe n:
   \`\`\`bash
   orcaops snapshots checkout --artifact <id> --checkpoint <n> --phase close --json
   \`\`\`
   Run the failing test INSIDE the scratch dir (\`cd <dir>\`; run
   \`pnpm install\`/equivalent first — dependency dirs are not part of
   snapshot trees). Never run it in the live worktree.
3. First failing boundary = culprit checkpoint. Deliver it WITH its
   context: the cp's \`summary\`, \`decisions\`, and \`uncertainty[]\` from
   \`show --json\` (a pre-registered uncertainty that names the failure is
   the headline), plus \`orcaops snapshots diff <n> --artifact <id>\` for
   the exact change.
4. Clean up every scratch dir: \`git worktree remove --force <dir>\`.

# salvage

1. Find the abandoned cp + reason: \`orcaops show <id> --json\`
   (\`status: "abandoned"\`, \`abandon_reason\`).
2. The abandoned window's diff:
   \`\`\`bash
   orcaops snapshots diff <n> --artifact <id> --json   # open..abandon by default
   \`\`\`
3. If the open boundary was pruned (pre-amendment artifacts), fall back in
   order and SAY which step served: \`<n-1>..<n> --to-phase abandon\` (prior
   close) → \`baseline..<n> --to-phase abandon\` → checkout-only
   (\`snapshots checkout --phase abandon\` — tree without a diff).
4. Deliver: the recovered diff (or tree path) + the recorded abandon
   reason verbatim — the reason is WHY it was dead-ended; without it the
   salvage invites repeating the mistake.

**Mid-conflict caveat (check before reusing the tree):** an abandoned
checkpoint whose worktree held unresolved merge conflicts materializes
the conflict-marker bytes as-is — the abandon-time
\`unmerged-paths-degraded\` warning was the only record. Run
\`git status --short\` / grep for \`<<<<<<<\` in the scratch checkout
before treating the salvaged tree as buildable.

# timelapse

For n = 1..N: \`orcaops snapshots diff <n> --artifact <id>\` + that cp's
summary/decisions from \`show --json\`. Render as a sequence of "beat:
what changed / why" entries. Keep each beat to the summary plus the diff
STAT (don't paste whole diffs); link \`orcaops digest\` as the closing
artifact view.

# Requirements

Snapshot capture on (\`diff_fingerprint.enabled\`, the default) — this
skill only materializes when it is. Boundaries may be individually
unavailable (skipped capture, pruned refs): the commands fail typed with
the reason; disclose and degrade rather than reconstructing by hand.`,
};
