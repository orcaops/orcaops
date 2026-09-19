import type { Config, SupportedAgentId } from '@orcaops/storage';

import {
  type CodexHookGate,
  codexHooksDisabledGuidance,
  type SessionHookRepairAction,
  type UserSessionHookSurfaceHealth,
} from './session-hooks-user.js';
import {
  configSelectsProjectHook,
  hasMachineSessionHookSurface,
  machineSessionHookRequired,
} from './session-hooks.js';

/**
 * The single per-agent coverage verdict doctor and status both read.
 *
 * PURE by construction: every filesystem read happens in the caller
 * (`evaluateUserSessionHookSurfaces` for the rows, `readCodexHookGate` for the
 * agent-level switch), so the two commands cannot drift by inspecting
 * different things, and the classification itself stays trivially testable.
 */
export type MachineCoverageState = 'not-required' | 'covered' | 'missing' | 'broken' | 'unknown';

export interface MachineCoverageResult {
  agent: SupportedAgentId;
  required: boolean;
  /** Why coverage is, or is not, required of this agent. */
  reason: string;
  state: MachineCoverageState;
  /** Current candidate paths that informed this verdict. */
  contributing: string[];
  /** The ONE action to take. Absent when nothing needs doing. */
  remedy?: string;
  primaryAction: SessionHookRepairAction;
}

export interface MachineCoverageInput {
  config: Config;
  surfaces: readonly UserSessionHookSurfaceHealth[];
  /**
   * Codex's `features.hooks` switch. `disabled: null` means config.toml could
   * not be inspected — inconclusive, never a confirmed disable.
   */
  codexGate?: CodexHookGate | null;
}

const CODEX = 'codex' as SupportedAgentId;

function requirementReason(config: Config, agent: SupportedAgentId): string {
  if (!config.session_hooks.enabled) return 'session hooks are disabled for this repository';
  if (!config.install.agents.includes(agent)) {
    return `${agent} is not in the configured install set`;
  }
  if (configSelectsProjectHook(config, agent)) {
    return `${agent} uses this repository's project hook entry`;
  }
  // Three different reasons a project entry does not carry this agent, and
  // they call for different reading: the scope installs none, the repository
  // turned them off, or the agent simply has no project surface to use.
  if (config.install.scope !== 'project') {
    return `scope "${config.install.scope}" installs no project hook entries`;
  }
  if (config.session_hooks.entries === 'none') {
    return 'project hook entries are disabled for this repository';
  }
  return `${agent} has no project hook surface`;
}

function installRemedy(agent: SupportedAgentId): string {
  return `Run \`orcaops session-hooks install --agents ${agent}\` to register the machine hook.`;
}

function customizedRemedy(agent: SupportedAgentId, paths: string[]): string {
  const where = paths.length > 0 ? ` in ${paths.join(' and ')}` : '';
  return (
    `A customized session-hook command${where} cannot be verified as running the hook. ` +
    'Review it and either keep it as is, or replace it with a single canonical registration ' +
    `via \`orcaops session-hooks install --agents ${agent}\` — installing alongside it would ` +
    'add a second entry and may duplicate guidance.'
  );
}

/**
 * Assess every configured machine-capable agent.
 *
 * Order is load-bearing. A confirmed Codex disable outranks `covered` because
 * the switch silences hooks.json and config.toml alike: without that, a
 * canonical registration in either file reads as coverage while Codex runs
 * nothing. Unknown outranks missing and broken for the opposite reason — an
 * inconclusive inspection must never harden into a claim that the user's
 * registration was removed.
 */
export function assessMachineSessionHookCoverage(
  input: MachineCoverageInput
): MachineCoverageResult[] {
  const { config, surfaces, codexGate } = input;
  const results: MachineCoverageResult[] = [];

  for (const agent of config.install.agents) {
    // Machine-CAPABLE agents only. An agent with no machine surface is not
    // exempt for any reason the requirement policy can express, so including
    // it would attach a scope-based reason that is not the real one.
    if (!hasMachineSessionHookSurface(agent)) continue;
    const required = machineSessionHookRequired(config, agent);
    const rows = surfaces.filter((row) => row.agent === agent && row.current);
    const contributing = rows.map((row) => row.path);

    if (!required) {
      results.push({
        agent,
        required: false,
        reason: requirementReason(config, agent),
        state: 'not-required',
        contributing,
        primaryAction: 'none',
      });
      continue;
    }

    const reason = requirementReason(config, agent);
    const base = {
      agent,
      required: true as const,
      reason,
      contributing,
      primaryAction: 'none' as SessionHookRepairAction,
    };

    // The shared gate, before anything a registration could claim.
    if (agent === CODEX && codexGate?.disabled === true) {
      results.push({
        ...base,
        state: 'broken',
        remedy: codexHooksDisabledGuidance(codexGate.path),
        primaryAction: 'enable-setting',
      });
      continue;
    }

    // config.toml does double duty: it is a candidate surface AND it holds the
    // switch that silences both surfaces. So when it cannot be inspected, a
    // verified hooks.json entry is unprovable rather than proven — the file we
    // could not read may hold the setting that silences it.
    if (agent === CODEX && codexGate != null && codexGate.disabled === null) {
      results.push({
        ...base,
        state: 'unknown',
        contributing: contributing.includes(codexGate.path)
          ? contributing
          : [...contributing, codexGate.path],
        remedy:
          `${codexGate.path} could not be inspected, so Codex's hook setting cannot be ` +
          'confirmed — restore access to it, then re-run this check.',
        primaryAction: 'restore-access',
      });
      continue;
    }

    // `superseded` is a working registration in the file the resolved
    // representation has moved past — Codex loads both, so it still covers.
    if (rows.some((row) => row.coverage === 'covered')) {
      results.push({ ...base, state: 'covered' });
      continue;
    }

    const customized = rows.filter((row) => row.customized);
    if (customized.length > 0) {
      results.push({
        ...base,
        state: 'unknown',
        remedy: customizedRemedy(
          agent,
          customized.map((row) => row.path)
        ),
        primaryAction: 'manual-review',
      });
      continue;
    }

    const unverifiable = rows.filter((row) => row.coverage === 'unverifiable');
    if (unverifiable.length > 0) {
      const chosen = unverifiable.find((row) => row.remedy !== undefined) ?? unverifiable[0];
      results.push({
        ...base,
        state: 'unknown',
        // Whatever stopped the inspection is what to fix; the row carries it.
        remedy: chosen?.remedy,
        primaryAction: chosen?.primaryAction ?? 'manual-review',
      });
      continue;
    }

    const broken = rows.filter((row) => row.state === 'registered-but-broken');
    if (broken.length > 0) {
      const chosen = broken.find((row) => row.remedy !== undefined);
      results.push({
        ...base,
        state: 'broken',
        remedy: chosen?.remedy ?? installRemedy(agent),
        primaryAction: chosen?.primaryAction ?? 'install',
      });
      continue;
    }

    results.push({
      ...base,
      state: 'missing',
      remedy: installRemedy(agent),
      primaryAction: 'install',
    });
  }

  return results;
}

/** Does anything in this assessment want the user's attention? */
export function machineCoverageNeedsAttention(results: readonly MachineCoverageResult[]): boolean {
  return results.some(
    (result) => result.required && result.state !== 'covered' && result.state !== 'not-required'
  );
}
