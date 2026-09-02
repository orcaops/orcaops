import type { SkillId } from './types.js';

/**
 * Render-time naming helpers.
 *
 * orcaops skill/command identifiers are derived from a single `prefix` knob:
 *   - skills:   `${prefix}-${verb}`   (hyphen form, e.g. `orcaops-digest`)
 *   - commands: `${prefix}:${verb}`   (namespace form, e.g. `orcaops:show`)
 *
 * Centralizing the derivation here keeps the cross-skill references embedded in
 * skill bodies consistent with the names actually installed on disk, and lets a
 * future config knob (`config.naming.prefix`) retarget every surface from one
 * place instead of hunting hardcoded `orcaops-*` literals.
 */
export const DEFAULT_PREFIX = 'orcaops';

/** Skill identifier (hyphen form). `skillRef('digest')` → `orcaops-digest`. */
export function skillRef(verb: SkillId, prefix: string = DEFAULT_PREFIX): string {
  return `${prefix}-${verb}`;
}

/** Slash-command identifier (namespace form). `commandRef('show')` → `orcaops:show`. */
export function commandRef(verb: string, prefix: string = DEFAULT_PREFIX): string {
  return `${prefix}:${verb}`;
}
