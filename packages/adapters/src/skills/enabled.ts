import type { SkillCapability, SkillId, SkillTemplate } from '../types.js';

/**
 * The enabled-set resolver: which skill templates materialize, given
 * per-id enable overrides and the capabilities the current CLI/config
 * satisfies. Config-free structural input — the CLI's `skill-set.ts`
 * adapter is the single place that feeds it from `Config`.
 *
 * Rules (pinned):
 *   - required templates are enabled regardless of overrides;
 *   - otherwise effective = `overrides[id] ?? defaultEnabled ?? true`;
 *   - an unsatisfied `requires` capability EXCLUDES the template regardless
 *     of any override (enabling records intent, gating wins);
 *   - template order is preserved (deterministic install.json).
 */
export interface ResolveEnabledSkillsInput<Id extends string = SkillId> {
  templates: ReadonlyArray<SkillTemplate<Id>>;
  /** Per-skill-id enable overrides (the config `skills.enabled` record). */
  overrides: Readonly<Partial<Record<Id, boolean>>>;
  /** Capabilities the current CLI/config satisfies. */
  capabilities: ReadonlyArray<SkillCapability>;
}

export type SkillDisabledReason =
  | 'override_disabled'
  | 'default_disabled'
  | 'capability_unsatisfied';

export interface DisabledSkill<Id extends string = SkillId> {
  template: SkillTemplate<Id>;
  reason: SkillDisabledReason;
  /** Present only for capability_unsatisfied. */
  missing_capabilities?: SkillCapability[];
}

export interface ResolvedSkillSet<Id extends string = SkillId> {
  /** Enabled templates, in template (registry) order. */
  enabled: SkillTemplate<Id>[];
  disabled: DisabledSkill<Id>[];
}

export function resolveEnabledSkills<Id extends string>(
  input: ResolveEnabledSkillsInput<Id>
): ResolvedSkillSet<Id> {
  const satisfied = new Set(input.capabilities);
  const enabled: SkillTemplate<Id>[] = [];
  const disabled: DisabledSkill<Id>[] = [];
  for (const template of input.templates) {
    const missing = (template.requires ?? []).filter((c) => !satisfied.has(c));
    if (missing.length > 0) {
      disabled.push({ template, reason: 'capability_unsatisfied', missing_capabilities: missing });
      continue;
    }
    const override = input.overrides[template.id];
    const effective = template.required === true || (override ?? template.defaultEnabled ?? true);
    if (effective) {
      enabled.push(template);
    } else {
      disabled.push({
        template,
        reason: override === false ? 'override_disabled' : 'default_disabled',
      });
    }
  }
  return { enabled, disabled };
}
