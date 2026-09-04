import { ATTRIBUTION_INSTRUCTION } from '../attribution.js';
import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';

export const orcaopsPrePrSkill: SkillTemplate = {
  id: 'pre-pr',
  name: 'Orcaops: pre-PR check',
  description:
    'Manually run final pre-PR checks for inspection or repair. Normal finalization starts with finish.',
  tags: ['orcaops', 'capture'],
  body: (prefix: string) => `# When to use

For normal finalization, use \`${skillRef('finish', prefix)}\`; it runs this
check and pauses before saving the summary when attention is needed. Use this
standalone command when the user explicitly asks to inspect or rerun only the
pre-PR checks. It runs the enabled \`fires_at: pre-pr\` evaluators across the
whole artifact thread.

Skipping this means \`capture summary\` runs without the final pass; the
digest will be poorer.

${ATTRIBUTION_INSTRUCTION}

# How to run

\`\`\`bash
orcaops capture pre-pr-check --input - --invoked-by-agent <your-agent-id> <<'EOF'
artifact_id: a3b1f0c2
EOF
\`\`\`

\`artifact_id\` is **optional** — omit it to target the single active
artifact on the branch (it's autodetected). Pass it explicitly only when
more than one artifact is active; omitting it then returns
\`AMBIGUOUS_ARTIFACT\` with a \`candidates[]\` list so you can pick one. The
id comes from \`orcaops status --json\`.

# Interpreting the response

\`\`\`json
{
  "ok": true,
  "artifact_id": "a3b1f0c2",
  "evaluator_results": [
    { "evaluator_ref": "core/plan-conformance-pre-pr", "severity": "warn",
      "run_status": "completed", "verdict": "violation",
      "body": "VIOLATION\\n\\nThe delivered scope differs from the approved plan..." }
  ],
  "blocking": false
}
\`\`\`

Severity \`info\` findings are advisory. Severity \`warn\` findings are also
returned from a successful standalone pre-PR capture; the primitive command
does not turn them into blocks. When the normal closing path uses \`finish\`,
warnings pause before summary so the agent can fix the concern or explicitly
accept the exact reviewed finding. Severity \`block\` prevents summary until
it is resolved with \`orcaops block acknowledge\` when permitted or
\`orcaops block dismiss\`.

# After pre-PR passes

If you intentionally chose the manual path, proceed to
\`${skillRef('summary', prefix)}\`. Otherwise return to
\`${skillRef('finish', prefix)}\` for normal finalization.

# Re-running

You can re-run pre-PR any number of times. Each passing run appends a
fresh \`pre_pr_checked\` marker event (it is NOT idempotency-keyed against
your input), so the latest pass always reflects the current event-log
state. A new commit — or any new orcaops event — makes the prior pass
stale, and the next-step hint re-suggests pre-PR. Re-running never
finalizes anything (only \`capture summary\` finalizes).
`,
};
