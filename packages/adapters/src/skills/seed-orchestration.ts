import type { SkillBodyOptions } from '../types.js';

export function seedEnrichmentOrchestration(options?: SkillBodyOptions): string {
  if (options?.subagentOrchestration === 'parallel') {
    return `# Enrichment orchestration

After the user approves an import, enrich the dry-run bundles in parallel when
there is more than one — the triaged set, not every bundle. Give each subagent a
disjoint bundle and one output JSON path INSIDE the bundle directory; require it
to preserve every citation and the bundle's artifact id, and to honor the
bundle's per-bundle decision ceiling. Wait for every subagent, validate that each
expected JSON file exists, then make ONE apply call with \`--enrichment-dir\`
pointing at that same bundle directory. Never let a subagent run the apply
command.`;
  }

  return `# Enrichment orchestration

After the user approves an import, process the dry-run bundles serially — the
triaged set, not every bundle. Write one output JSON file per bundle INSIDE the
bundle directory, preserving every citation and the bundle's artifact id and
honoring the bundle's per-bundle decision ceiling, then make ONE apply call with
\`--enrichment-dir\` pointing at that same directory. Do not issue per-bundle
apply commands.`;
}

export function seedDiscoveryAssessment(options?: SkillBodyOptions): string {
  if (options?.subagentOrchestration === 'parallel') {
    return `When several old subsystems are plausible gaps, you may ask parallel
subagents to assess disjoint directories against the cached coverage report.
Collect their read-only findings before reporting one narrow recommendation; no
subagent may preview or import history, alter seed state, or ask for consent.`;
  }

  return `When several old subsystems are plausible gaps, assess them serially
against the cached coverage report before reporting one narrow recommendation.
Do not preview or import history, alter seed state, or ask for consent.`;
}
