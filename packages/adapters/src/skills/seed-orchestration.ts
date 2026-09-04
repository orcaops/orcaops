import type { SkillBodyOptions } from '../types.js';

export function seedEnrichmentOrchestration(options?: SkillBodyOptions): string {
  const scratchIsolation = `Every enrichment worker must use a private scratch directory OUTSIDE the
shared bundle directory. A worker must not write helper files into the shared
directory or run any helper script it did not create for this task. Its final
enrichment JSON is the only file it may write outside its private directory.`;

  if (options?.subagentOrchestration === 'parallel') {
    return `# Enrichment orchestration

After the user approves an import, enrich the approved bundle set through a
bounded worker queue when there is more than one. Give each subagent a disjoint
bundle and one output JSON path INSIDE the bundle directory; as a worker
finishes, dispatch the next queued bundle until the approved set is exhausted.
If a launch fails, keep that bundle queued and retry it when a slot is free;
never silently drop it.

${scratchIsolation}

Require every worker to preserve each citation and the
bundle's artifact id, and to honor the bundle's per-bundle decision ceiling.
Wait for every subagent, validate that each expected JSON file exists, then make
ONE apply call with \`--enrichment-dir\` pointing at that same bundle directory.
Never let a subagent run the apply command.`;
  }

  return `# Enrichment orchestration

After the user approves an import, process the dry-run bundles serially — the
triaged set, not every bundle. Write one output JSON file per bundle INSIDE the
bundle directory, preserving every citation and the bundle's artifact id and
honoring the bundle's per-bundle decision ceiling.

${scratchIsolation}

Then make ONE apply call with
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
