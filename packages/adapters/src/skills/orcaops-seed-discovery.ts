import { skillRef } from '../refs.js';
import type { SkillTemplate } from '../types.js';
import { seedDiscoveryAssessment } from './seed-orchestration.js';

export const orcaopsSeedDiscoverySkill: SkillTemplate = {
  id: 'seed-discovery',
  name: 'Orcaops: discover history gaps',
  description:
    'Report a history-coverage gap found during normal work: after a provenance lookup finds nothing, in a directory with no captured history, or when prior-art search is empty for old code. Reads cached coverage only.',
  tags: ['orcaops', 'insight'],
  group: 'insight',
  defaultEnabled: true,
  blockTriggerLine: (prefix: string) =>
    `history gap during normal work (why miss, cold subsystem, empty old prior-art) → \`${skillRef('seed-discovery', prefix)}\``,
  body: (prefix, options) => `# Read-only discovery

Use this only after normal work exposes a history gap. This workflow is
strictly read-only about history: never preview, import, enrich, or ask for
import confirmation. It performs exactly one state write — recording that it
made an offer, in step 4 — so the same area is not offered again next week.

1. Read the cached worklist:

   \`\`\`bash
   orcaops seed status --json
   \`\`\`

   Check \`coverage\`, \`coverage_stale\`, and \`discovery\`. Suppression has three
   states per area, and \`discovery\` is the only source for them:
   - listed in \`discovery.declined\` — the user said no. Never offer that area
     again until they ask; the way back is
     \`orcaops seed status --offer-again <area>\`, which only the user decides to
     run.
   - listed in \`discovery.offered\` with \`cooldown_active: true\` — offered
     within the last 7 days and unanswered. Do not re-offer it yet.
   - absent, or offered with the cooldown expired — offerable.

   This state is durable and machine-local: it survives a cache wipe and is
   shared by every linked worktree, so a suppression you read here is the same
   one another worktree recorded.
2. Identify the narrowest likely gap from the read-only evidence:
   - For a \`why\` miss, report the implicated commit when one is already known.
   - For a cold subsystem, report the top-level directory and its coverage.
   - Empty prior art alone is not proof of a gap; corroborate it with repository
     age and the coverage report.

${seedDiscoveryAssessment(options)}

3. Report the cold coverage and recommend that the user explicitly invoke
   \`${skillRef('seed', prefix)}\`, passing along the suggested path or commit as
   context.
4. Record the offer you just made, so it is not repeated during the cooldown:

   \`\`\`bash
   orcaops seed status --offered <area>
   \`\`\`

   This is the workflow's ONE sanctioned state write. It stamps only the
   offer timestamp that suppression reads — it imports nothing and touches
   no repository file — so run it even when you are otherwise operating
   under a read-only or no-write posture; skipping it re-nags the user on
   every session. Then continue the user's original task. Recording a
   decline is the user's call, not yours.

All preview, confirmation, enrichment, and import actions belong to the
user-invoked \`${skillRef('seed', prefix)}\` workflow.`,
};
