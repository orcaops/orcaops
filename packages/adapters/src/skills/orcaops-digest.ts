import { commandRef, skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

export const orcaopsDigestSkill: SkillTemplate = {
  id: 'digest',
  name: 'Orcaops: render digest',
  description:
    'Render a reviewer-facing summary or PR body. Use for "show me the digest", "draft the PR description", or "write the PR body".',
  tags: ['orcaops', 'read'],
  body: (prefix: string) => `# When to use

Invoke when the user wants a **reviewer-facing summary** — outcome,
decisions, release checks, and open items. Use branch-wide mode for a PR
or branch summary so follow-up artifacts are not omitted. Use the default
single-artifact mode only when the user names one artifact or thread. Pair with
\`${skillRef('why', prefix)}\` for file:line provenance and \`${commandRef('show', prefix)}\` for the raw
thread.

Triggers (user phrasing):

- "show me the digest", "render the digest", "render the PR summary"
- "what does this PR look like?", "what changed?"
- "give me the orcaops summary for <branch>"
- "draft the PR description", "write the PR body"

# How to invoke

\`\`\`bash
orcaops digest                          # latest artifact on current branch (markdown)
orcaops digest --branch feat/x          # latest on another branch
orcaops digest --artifact <id>          # a specific artifact
orcaops digest --branch-wide            # all captured work in the current PR range
orcaops digest --branch-wide --base origin/main
orcaops digest --branch-wide --branch feat/x --primary-artifact <id>
orcaops digest --out PR-DESCRIPTION.md  # write to file; stdout confirms the path
orcaops digest --json                   # machine-readable
\`\`\`

# Interpreting the output

Markdown sections: outcome, plan steps, checkpoints,
release checks (gating evaluators), process notes (informational
evaluators), open items, deferred decisions. Headings rendered at H2
under the digest's H1.

An imported artifact carries \`origin.kind: git-import\` and the digest renders
an imported-history banner. Preserve that banner in every shareable or reshaped
output. Imported decisions are evidence-cited paraphrases: include the citation,
and attribute the work to \`origin.authors\` rather than the current user or
agent in the first person.

If the thread is incomplete (no \`capture summary\`), the digest still
renders but with a "_Thread is incomplete — no summary captured yet._"
warning and missing the \`outcome\` headline. If the user wanted a
finished digest, suggest they run the ${skillRef('finish', prefix)} skill. It
runs the final checks, captures the summary, synchronizes the artifact, and
renders the digest in one workflow.

# PR-body format

When the ask is a pull-request DESCRIPTION rather than the raw digest,
reshape the branch-wide digest yourself:

1. \`orcaops digest --branch-wide --json\` → read \`data\` (structured) and
   \`markdown\` (rendered).
2. Compose the PR body from it:
   - **Title**: use \`data.title.text\` when \`data.title\` is non-null.
     Otherwise write a title from the branch outcome. Use
     \`--primary-artifact\` when the default is not the branch's main outcome.
   - **Summary**: tighten \`data.outcome\`, or the relevant entries in
     \`data.outcomes\`, to 2-4 sentences.
   - **What changed**: one bullet per entry in \`data.changes\`; fold trivial
     entries together.
   - **Decisions**: select only the load-bearing entries from
     \`data.decisions\`.
   - **Open items / follow-ups**: carry \`data.open_items\` forward — hiding
     known gaps from a PR description is the failure mode.
   - **Tests**: use \`data.tests\` when verification belongs in the PR body.
   - **Imported provenance**: when present, keep the synthesized-history
     disclosure and commit-author attribution near the top.
   - Keep evaluator "release checks" only when something FAILED or was
     policy-excepted; green checks are noise in a PR body.
3. Write the reshaped body where the user wants it (stdout, a file via
   your own write, or \`gh pr create --body-file -\`). \`--out\` writes the
   full raw digest to the file and prints only a confirmation on stdout; it
   does not create the reshaped PR body.

# Errors

- \`UNKNOWN_ARTIFACT\` — no matching artifact. Run \`orcaops status --json\`
  to see what's captured on the current branch.
- \`INVALID_INPUT\` — the branch or base cannot be resolved, selectors conflict,
  or \`--primary-artifact\` is not an included summarized artifact.
`,
};
