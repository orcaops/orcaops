import { type Config, resolveConfig } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { openEffectiveConfig, writeConfigDocument } from '../../lib/config-file.js';
import { buildContext } from '../../lib/context.js';
import { withRepositoryInstallLock } from '../../lib/repository-install-lock.js';
import {
  currentSkillCapabilities,
  resolveSkillSet,
  type SkillGates,
  visibleSkillTemplates,
} from '../../lib/skill-set.js';

/**
 * `orcaops skills enable|disable <id>` — persist a per-skill enable override
 * into `.orcaops/config.json` (`skills.enabled[id]`), mirroring
 * `eval enable`'s shared-runToggle shape. Persisting does NOT touch the
 * installed files — the hint to run `orcaops update` is always emitted; the
 * enabled set flows to generation/prune/block from there.
 *
 * Lifecycle skills remain disableable unless the template marks itself
 * required. Enabling a capability-unsatisfied skill records the override
 * (intent survives config round-trips) and warns that gating wins until the
 * capability is satisfied.
 */

export interface ToggleSkillOptions {
  id: string;
  json?: boolean;
}

export interface SkillTogglePlan {
  id: string;
  enabled: boolean;
  /** The skill's effective state BEFORE this toggle. */
  previous_effective: boolean;
  /** The raw override value before this toggle (null = no override). */
  previous_override: boolean | null;
  /** True when the toggle does not change the effective state. */
  noop: boolean;
  warnings: string[];
}

/**
 * Compute the toggle outcome against the current config. Pure —
 * unit-tested directly; the action persists `plan.enabled` under
 * `skills.enabled[id]` regardless of `noop` (an explicit override on a
 * default is harmless and pins intent against future default changes).
 */
export function planSkillToggle(
  config: Config,
  id: string,
  enabled: boolean,
  gates: SkillGates
): SkillTogglePlan {
  // Without a session a cloud id is unknown, not merely un-materializable:
  // this function only warns on an unsatisfied capability, so the caller would
  // otherwise persist the id into the tracked config.
  const visible = visibleSkillTemplates(gates);
  const template = visible.find((t) => t.id === id);
  if (!template) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No skill "${id}". Known skills: ${visible.map((t) => t.id).join(', ')}.`,
      'id'
    );
  }
  if (!enabled && template.required === true) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Skill "${id}" is required and cannot be disabled.`,
      'id'
    );
  }
  const resolved = resolveSkillSet(config, gates);
  const previousEffective = resolved.enabled.some((t) => t.id === id);
  const previousOverride = config.skills.enabled[template.id] ?? null;

  const warnings: string[] = [];
  if (!enabled && template.group === 'lifecycle') {
    warnings.push(
      `"${id}" is a core lifecycle skill — disabling it degrades the capture lifecycle ` +
        `(plan → checkpoint → finish). Allowed, but re-enable it if ` +
        `captures start skipping phases.`
    );
  }
  if (enabled) {
    const satisfied = new Set(currentSkillCapabilities(config, gates));
    const missing = (template.requires ?? []).filter((c) => !satisfied.has(c));
    if (missing.length > 0) {
      warnings.push(
        `"${id}" requires ${missing.join(', ')}, which this config does not satisfy — the ` +
          `override is recorded but the skill will NOT materialize until the capability is ` +
          `available.`
      );
    }
  }

  return {
    id,
    enabled,
    previous_effective: previousEffective,
    previous_override: previousOverride,
    noop: previousEffective === enabled,
    warnings,
  };
}

export async function skillsEnableAction(opts: ToggleSkillOptions): Promise<void> {
  await runToggle(opts, true);
}

export async function skillsDisableAction(opts: ToggleSkillOptions): Promise<void> {
  await runToggle(opts, false);
}

const UPDATE_HINT = 'run `orcaops update` to apply the change to installed skills';

async function runToggle(opts: ToggleSkillOptions, enabled: boolean): Promise<void> {
  try {
    const ctx = await buildContext();
    try {
      const commonDir = await ctx.repo.getCommonDirAbsolute();
      const { plan, configRel } = await withRepositoryInstallLock(
        commonDir,
        async (installLease) => {
          const document = await openEffectiveConfig(ctx.repoRoot);
          const plan = planSkillToggle(resolveConfig(document.raw), opts.id, enabled, ctx.gates);
          const skills = (document.raw.skills ?? {}) as { enabled?: Record<string, boolean> };
          document.raw.skills = {
            ...skills,
            enabled: { ...(skills.enabled ?? {}), [opts.id]: enabled },
          };
          await installLease.verify();
          await writeConfigDocument(document);
          return { plan, configRel: document.displayPath };
        }
      );

      const result = {
        ok: true as const,
        id: plan.id,
        enabled: plan.enabled,
        previous_effective: plan.previous_effective,
        previous_override: plan.previous_override,
        noop: plan.noop,
        config_path: configRel,
        warnings: plan.warnings,
        hint: UPDATE_HINT,
      };
      if (opts.json) {
        emitOk(result);
        return;
      }
      const verb = enabled ? 'Enabled' : 'Disabled';
      const lines = [
        plan.noop
          ? `${verb} "${plan.id}" (no-op — already effectively ${enabled}; override recorded).`
          : `${verb} "${plan.id}" in ${configRel}.`,
        ...plan.warnings.map((w) => `Warning: ${w}`),
        `Next: ${UPDATE_HINT}.`,
      ];
      writeTerminalSafeStdout(lines.join('\n') + '\n');
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
