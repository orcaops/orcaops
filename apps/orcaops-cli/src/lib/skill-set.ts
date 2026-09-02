import {
  type ResolvedSkillSet,
  resolveEnabledSkills,
  SKILL_TEMPLATES,
  type SkillCapability,
  type SkillTemplate,
} from '@orcaops/adapters';
import { hasCloudCredentials } from '@orcaops/core';
import type { Config } from '@orcaops/storage';

/**
 * The single Config → enabled-skill-set choke point. Every consumer of
 * "which skills materialize" — install planning, global install,
 * install-drift, doctor's expected set, the managed AGENTS.md block —
 * derives from here, so a config change flows everywhere at once.
 */

/**
 * Machine state, not repo config. Required at every call site: defaulting to
 * false withdraws a paying user's skills, true leaks the cloud into a public
 * install.
 */
export interface SkillGates {
  /** Does this machine hold cloud credentials? */
  cloud: boolean;
}

export function resolveSkillGates(env: NodeJS.ProcessEnv): SkillGates {
  return { cloud: hasCloudCredentials(env) };
}

/** Capabilities the current config + machine state satisfy (capability gating). */
export function currentSkillCapabilities(config: Config, gates: SkillGates): SkillCapability[] {
  return [
    ...(config.diff_fingerprint.enabled ? (['diff-fingerprint'] as const) : []),
    // The archive capability gates precedent/handoff — they
    // materialize the moment archive.enabled flips on (+ `orcaops update`).
    ...(config.archive.enabled ? (['archive'] as const) : []),
    // BOTH consumption capabilities key on the same knob —
    // `diff_fingerprint.enabled` is the snapshot/fingerprint kill-switch
    // (capture/checkpoint.ts returns skipped boundaries when it is off), so
    // with it off there are no refs to materialize and no manifests to
    // match. Two names are kept for independent future knobs.
    ...(config.diff_fingerprint.enabled ? (['snapshot-checkout', 'matcher'] as const) : []),
    ...(gates.cloud ? (['cloud'] as const) : []),
  ];
}

export const CLOUD_GATED_SKILL_IDS: ReadonlySet<string> = new Set(
  SKILL_TEMPLATES.filter((t) => (t.requires ?? []).includes('cloud')).map((t) => t.id)
);

/** Full resolution (enabled + disabled-with-reason). */
export function resolveSkillSet(config: Config, gates: SkillGates): ResolvedSkillSet {
  const resolved = resolveEnabledSkills({
    templates: SKILL_TEMPLATES,
    overrides: config.skills.enabled,
    capabilities: currentSkillCapabilities(config, gates),
  });
  if (gates.cloud) return resolved;
  // Other capabilities report their gated templates so the user can enable the
  // feature; naming an enterprise-only one advertises what it cannot reach.
  // Filtered after resolution, not by pre-filtering `templates`, or a
  // teammate's committed override reads as an id this version does not know.
  return {
    ...resolved,
    disabled: resolved.disabled.filter((d) => !CLOUD_GATED_SKILL_IDS.has(d.template.id)),
  };
}

/** Just the enabled templates, in registry order. */
export function enabledSkillTemplates(config: Config, gates: SkillGates): SkillTemplate[] {
  return resolveSkillSet(config, gates).enabled;
}

/**
 * Templates the GATE — and only the gate — is withholding: enabled with
 * credentials, absent without them. The single input to every "blocks creation,
 * never deletion" rule, so the project preservation and the global hold cannot
 * disagree.
 *
 * Derived by DIFFERENCE, not from `CLOUD_GATED_SKILL_IDS`, so a skill the USER
 * disabled is absent from both sets and stays removable.
 */
export function gateWithheldSkillTemplates(config: Config, gates: SkillGates): SkillTemplate[] {
  if (gates.cloud) return [];
  const enabled = new Set(enabledSkillTemplates(config, gates).map((t) => t.id));
  return enabledSkillTemplates(config, { ...gates, cloud: true }).filter((t) => !enabled.has(t.id));
}

/**
 * For surfaces that would otherwise iterate `SKILL_TEMPLATES` directly:
 * capability gating governs what materializes, not what gets printed.
 */
export function visibleSkillTemplates(gates: SkillGates): SkillTemplate[] {
  return gates.cloud
    ? [...SKILL_TEMPLATES]
    : SKILL_TEMPLATES.filter((t) => !CLOUD_GATED_SKILL_IDS.has(t.id));
}
