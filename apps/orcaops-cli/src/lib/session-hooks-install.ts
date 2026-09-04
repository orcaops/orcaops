import type { Writable } from 'node:stream';

import type { SupportedAgentId } from '@orcaops/storage';

import {
  CODEX_HOOKS_JSON_MIN_VERSION,
  CODEX_HOOKS_JSON_NOTE,
  codexConfigTomlPath,
  codexFenceGuidance,
  codexHooksDisabledGuidance,
  codexHooksJsonCarriesHooks,
  codexHooksShapeGuidance,
  codexInvalidTomlGuidance,
  codexMarkerLineGuidance,
  type CodexRegistrationMigration,
  type CodexRepresentation,
  type CodexRepresentationSurface,
  codexTomlSnippet,
  type CodexTrustCarryReport,
  type CodexTrustShiftReport,
  isCodexHooksJsonPath,
  migrateCodexRegistrationToHooksJson,
  planUserSessionHookConsent,
  planUserSessionHooks,
  type PlanUserSessionHooksResult,
  readCodexTomlState,
  readUserHooksRecordState,
  type UserHooksRecordEntry,
  userHooksRecordPath,
  type UserSessionHookConsentPlan,
  type UserSessionHookConsentSurface,
  writeCodexTomlBlock,
  writeUserHooksRecord,
} from './session-hooks-user.js';
import { sessionHooksRestartRequired } from './session-hooks.js';

export type CodexSessionHookChoice = 'manual' | 'managed' | 'skip';
export type CodexSessionHookOutcome =
  | 'manual-snippet'
  | 'managed-written'
  | 'managed-unchanged'
  | 'refused-invalid'
  | 'refused-hooks-shape'
  | 'refused-fence'
  | 'refused-markers'
  | 'refused-unreadable'
  | 'failed'
  | 'skipped'
  | null;

export interface StagedUserSessionHookInstall {
  consent: UserSessionHookConsentPlan;
  codexChoice: CodexSessionHookChoice | null;
}

export interface PromptUserSessionHookInstallOptions {
  output: Writable;
  say: (text: string) => void;
  onCancel?: () => never;
  /** `--representation`: force the codex file rather than resolving one. */
  representationOverride?: CodexRepresentationSurface;
}

function consentSurfaceLine(surface: UserSessionHookConsentSurface): string {
  if (surface.mode === 'managed-choice') {
    return `  ? ${surface.path}  (${surface.agent}; may modify in managed mode only)\n`;
  }
  if (surface.mode === 'remove') {
    return `  - ${surface.path}  (${surface.agent}; the orcaops block is removed from this file)\n`;
  }
  return `  ~ ${surface.path}  (${surface.agent}; will reconcile this entry)\n`;
}

/**
 * Why codex is being registered where it is, when the answer is not the one
 * the file layout alone would give: a version gate that could not be cleared,
 * or an override that ignored one.
 */
function codexRepresentationNote(representation: CodexRepresentation | null): string {
  if (representation === null) return '';
  if (representation.reason === 'version-unsupported') {
    return (
      `Codex registers in ${representation.tomlPath}: this codex-cli is older than ` +
      `${CODEX_HOOKS_JSON_MIN_VERSION}, the oldest build measured to read hooks.json.\n\n`
    );
  }
  if (representation.reason === 'version-unknown') {
    return (
      `Codex registers in ${representation.tomlPath}: \`codex --version\` could not be read, ` +
      `so orcaops cannot tell whether this build reads hooks.json (needs ${CODEX_HOOKS_JSON_MIN_VERSION}).\n\n`
    );
  }
  if (representation.reason === 'override' && representation.versionGate !== 'supported') {
    return (
      `! --representation ${representation.surface} overrides the version gate ` +
      `(codex-cli ${representation.versionGate === 'unsupported' ? `is older than ${CODEX_HOOKS_JSON_MIN_VERSION}` : 'could not be read'}).\n` +
      '  A build that does not read the file you chose runs no hook at all.\n\n'
    );
  }
  return '';
}

export interface AppliedUserSessionHookInstall extends PlanUserSessionHooksResult {
  codexOutcome: CodexSessionHookOutcome;
  /**
   * Whether the registration left config.toml for hooks.json — `moved`, or
   * `kept-duplicate` when the old block could not go and both now register.
   * Null when nothing was in config.toml to move.
   */
  codexMigration: 'moved' | 'kept-duplicate' | null;
  /** Whether the approval the user already gave Codex moved with the registration. */
  codexTrustCarry: CodexTrustCarryReport | null;
  /** How the approvals for OTHER hooks in hooks.json fared when our group displaced them. */
  codexTrustShift: CodexTrustShiftReport;
  /** How a managed write landed: a fresh config.toml or a block merged into an existing one. */
  codexConfigWrite: 'created' | 'merged' | null;
  installedEntries: UserHooksRecordEntry[];
  liveAgents: SupportedAgentId[];
  record: string | null;
  restartRequired: boolean;
  partialFailure: boolean;
}

export async function promptUserSessionHookInstall(
  agents: SupportedAgentId[],
  options: PromptUserSessionHookInstallOptions
): Promise<StagedUserSessionHookInstall | null> {
  const prompts = await import('@clack/prompts');
  const consent = await planUserSessionHookConsent(agents, options.representationOverride);

  options.say(
    'Machine-level session hooks inject short orcaops capture guidance at every agent\n' +
      'session start, in every repo that has BOTH run `orcaops init` and enabled\n' +
      'session hooks. Repos without orcaops stay completely silent.\n\n' +
      'This consent covers the following user config surfaces:\n' +
      consent.surfaces.map(consentSurfaceLine).join('') +
      '\nOnly exact orcaops-managed entries are reconciled; other entries are preserved.\n' +
      'Undo managed entries any time with `orcaops session-hooks uninstall`.\n\n' +
      codexRepresentationNote(consent.representation)
  );
  const proceed = await prompts.confirm({
    message: `Continue with ${consent.surfaces.length} selected user config surface(s)?`,
    initialValue: false,
    output: options.output,
  });
  if (prompts.isCancel(proceed)) options.onCancel?.();
  if (proceed !== true) return null;

  // The chooser exists because config.toml is the user's primary Codex file
  // and a marker-owned block in it is a bigger ask than a JSON merge. The
  // hooks.json surface is the same reconcile Claude Code gets with no
  // chooser, and consent already named the file.
  let codexChoice: CodexSessionHookChoice | null = null;
  if (consent.representation?.surface === 'config-toml') {
    const choice = await prompts.select({
      message: 'Codex registers via ~/.codex/config.toml — how should orcaops handle it?',
      options: [
        {
          value: 'managed',
          label: 'Write a marker-owned block for me (recommended)',
          hint: 'appends one [[hooks.SessionStart]] table between markers; never touches your other settings',
        },
        {
          value: 'manual',
          label: 'Print the snippet — I will paste it myself',
          hint: 'zero write risk to your primary Codex config',
        },
        { value: 'skip', label: 'Skip Codex for now', hint: 'register later any time' },
      ],
      initialValue: 'managed',
      output: options.output,
    });
    if (prompts.isCancel(choice)) options.onCancel?.();
    codexChoice = prompts.isCancel(choice) ? 'skip' : (choice as CodexSessionHookChoice);
  }

  return { consent, codexChoice };
}

export function stagedUserSessionHookAgents(
  staged: StagedUserSessionHookInstall
): SupportedAgentId[] {
  return [
    ...staged.consent.jsonAgents,
    ...(staged.consent.codexWanted && staged.codexChoice === 'managed'
      ? ['codex' as SupportedAgentId]
      : []),
  ];
}

export async function applyUserSessionHookInstall(
  staged: StagedUserSessionHookInstall,
  cliVersion: string
): Promise<AppliedUserSessionHookInstall> {
  const representation = staged.consent.representation;
  const codexOnJson = representation?.surface === 'hooks-json';
  const result = await planUserSessionHooks(
    staged.consent.jsonAgents,
    'apply',
    'install',
    [],
    undefined,
    representation
  );
  let codexOutcome: CodexSessionHookOutcome = null;
  let codexConfigWrite: AppliedUserSessionHookInstall['codexConfigWrite'] = null;
  let codexMigration: AppliedUserSessionHookInstall['codexMigration'] = null;
  let codexTrustCarry: CodexTrustCarryReport | null = null;
  let codexTrustShift: CodexTrustShiftReport = { moved: 0, skipped: [] };

  if (representation?.surface === 'hooks-json') {
    const codexPlans = result.plans.filter((plan) => plan.agent === 'codex');
    const sidecarCarriesHook = codexPlans.some(
      (plan) =>
        plan.action === 'created' || plan.action === 'updated' || plan.action === 'unchanged'
    );
    // Only a hooks.json that actually carries the hook may retire config.toml.
    if (sidecarCarriesHook) {
      const migration = await migrateCodexRegistrationToHooksJson(representation, {
        groups: result.codexGroups,
      });
      codexMigration = migration.outcome === 'none' ? null : migration.outcome;
      codexTrustCarry = migration.trust;
      codexTrustShift = migration.trustShift;
      result.warnings.push(...(await codexMigrationWarnings(representation, migration)));
      const toml = await readCodexTomlState(representation.tomlPath);
      if (toml.hooksDisabled) result.warnings.push(codexHooksDisabledGuidance(toml.path));
    }
  } else if (staged.consent.codexWanted) {
    if (staged.codexChoice === 'manual') {
      codexOutcome = 'manual-snippet';
    } else if (staged.codexChoice === 'managed') {
      const existed = (await readCodexTomlState()).raw !== null;
      try {
        const wrote = await writeCodexTomlBlock();
        codexOutcome =
          wrote === 'written'
            ? 'managed-written'
            : wrote === 'unchanged'
              ? 'managed-unchanged'
              : wrote;
        if (wrote === 'written') codexConfigWrite = existed ? 'merged' : 'created';
      } catch (error) {
        codexOutcome = 'failed';
        result.warnings.push(
          `${codexConfigTomlPath()} could not be updated (${error instanceof Error ? error.message : String(error)})`
        );
      }
      if (codexOutcome === 'refused-unreadable') {
        const state = await readCodexTomlState();
        result.warnings.push(
          `${state.readError ?? `${state.path} could not be read`} — left untouched`
        );
      } else if (codexOutcome === 'managed-written' || codexOutcome === 'managed-unchanged') {
        const state = await readCodexTomlState();
        if (state.hooksDisabled) result.warnings.push(codexHooksDisabledGuidance(state.path));
      }
    } else {
      codexOutcome = 'skipped';
    }
  }

  const now = new Date().toISOString();
  const installedEntries: UserHooksRecordEntry[] = [
    ...result.plans
      .filter(
        (plan) =>
          plan.action === 'created' || plan.action === 'updated' || plan.action === 'unchanged'
      )
      .map((plan) => ({ agent: plan.agent, path: plan.path, installed_at: now })),
    ...(codexOutcome === 'managed-written' || codexOutcome === 'managed-unchanged'
      ? [
          {
            agent: 'codex' as SupportedAgentId,
            path: codexConfigTomlPath(),
            installed_at: now,
          },
        ]
      : []),
  ];
  let record: string | null = null;
  if (installedEntries.length > 0) {
    const previous = await readUserHooksRecordState();
    if (previous.status === 'unreadable') {
      result.warnings.push(
        `${userHooksRecordPath()} could not be read (${previous.message}) — left untouched; repair it before re-registering`
      );
    } else {
      const installedPaths = new Set(
        installedEntries.map((entry) => `${entry.agent}\0${entry.path}`)
      );
      try {
        await writeUserHooksRecord({
          record_version: 1,
          consented_at: now,
          cli_version: cliVersion,
          entries: [
            ...(previous.status === 'ok' ? previous.record.entries : []).filter(
              (entry) =>
                !installedPaths.has(`${entry.agent}\0${entry.path}`) &&
                // The record names where the registration LIVES: once codex is
                // on hooks.json, the config.toml entry it moved off is stale
                // even when the block itself could not be removed. Uninstall
                // scans config.toml regardless of the record.
                !(codexOnJson && entry.agent === 'codex' && !isCodexHooksJsonPath(entry.path))
            ),
            ...installedEntries,
          ],
        });
        record = userHooksRecordPath();
      } catch (error) {
        result.warnings.push(
          `${userHooksRecordPath()} could not be updated (${error instanceof Error ? error.message : String(error)})`
        );
      }
    }
  }

  const liveAgents = [...new Set(installedEntries.map((entry) => entry.agent))];
  const partialFailure =
    result.plans.some(
      (plan) =>
        plan.action === 'preserved-invalid-json' ||
        plan.action === 'preserved-unreadable' ||
        plan.action === 'preserved-unwritable'
    ) ||
    codexOutcome === 'refused-invalid' ||
    codexOutcome === 'refused-hooks-shape' ||
    codexOutcome === 'refused-fence' ||
    codexOutcome === 'refused-markers' ||
    codexOutcome === 'refused-unreadable' ||
    codexOutcome === 'failed' ||
    codexMigration === 'kept-duplicate' ||
    (installedEntries.length > 0 && record === null);

  // The settings-json planner never sees Codex; a repeat managed install
  // still reports the surface so the envelope does not read as a no-op.
  const plans =
    codexOutcome === 'managed-unchanged'
      ? [
          ...result.plans,
          {
            agent: 'codex' as SupportedAgentId,
            path: codexConfigTomlPath(),
            action: 'unchanged' as const,
          },
        ]
      : result.plans;

  return {
    ...result,
    plans,
    codexOutcome,
    codexMigration,
    codexTrustCarry,
    codexTrustShift,
    codexConfigWrite,
    installedEntries,
    liveAgents,
    record,
    restartRequired:
      sessionHooksRestartRequired(result.plans) ||
      codexOutcome === 'managed-written' ||
      // A move can leave every plan `unchanged` and still change what Codex
      // loads at its next start.
      codexMigration === 'moved',
    partialFailure,
  };
}

async function codexMigrationWarnings(
  representation: CodexRepresentation,
  migration: CodexRegistrationMigration
): Promise<string[]> {
  const tomlPath = representation.tomlPath;
  const warnings: string[] = [];
  if (migration.trust === 'failed') {
    warnings.push(`${tomlPath} could not be updated with the Codex approvals the move carries`);
  } else if (migration.trust === 'refused') {
    warnings.push(
      `the Codex approval for this hook could not be moved to its ${representation.hooksJsonPath} key, so the ${tomlPath} entry it still names was left in place`
    );
  }
  if (migration.removal === 'manual-content') {
    warnings.push(
      `${tomlPath} carries a manually-pasted or foreign orcaops hook — remove it yourself; orcaops never edits content it did not mark`
    );
  } else if (migration.removal === 'refused-markers') {
    const state = await readCodexTomlState(tomlPath);
    warnings.push(codexMarkerLineGuidance(tomlPath, state.markerProblemLines));
  } else if (migration.removal === 'refused-fence') {
    warnings.push(codexFenceGuidance(tomlPath));
  } else if (migration.removal === 'refused-invalid') {
    warnings.push(codexInvalidTomlGuidance(tomlPath));
  } else if (migration.removal === 'unreadable') {
    const state = await readCodexTomlState(tomlPath);
    warnings.push(
      `${state.readError ?? `${tomlPath} could not be checked for an older registration`} — left untouched`
    );
  }
  if (migration.outcome === 'kept-duplicate') {
    // The removal is skipped outright only when the approval could not move,
    // and that is the one kept-duplicate a plain re-run can clear.
    const retry =
      migration.removal === null
        ? '; re-run `orcaops session-hooks install` to retry the move'
        : '';
    warnings.push(
      `the Codex hook is now registered in ${representation.hooksJsonPath}, but the older registration in ${tomlPath} is still there — both are live until it is cleaned up${retry}`
    );
  }
  return warnings;
}

export async function codexSessionHookGuidance(
  outcome: CodexSessionHookOutcome
): Promise<string | null> {
  const configPath = codexConfigTomlPath();
  if (
    outcome === 'manual-snippet' ||
    outcome === 'managed-written' ||
    outcome === 'managed-unchanged'
  ) {
    const snippet =
      outcome === 'manual-snippet'
        ? `Paste this into ${configPath}:\n\n${codexTomlSnippet()}\n\n` +
          'Codex reviews new hooks once (hash-pinned trust). Approve the orcaops entry when asked; `orcaops session-hooks status` will confirm it after the paste.\n'
        : '';
    // This path registers in config.toml (or tells the user to), so hooks in
    // the sidecar are the second representation.
    const note = (await codexHooksJsonCarriesHooks()) ? CODEX_HOOKS_JSON_NOTE : null;
    const text = snippet + (note === null ? '' : `${note}\n`);
    return text.length > 0 ? text : null;
  }
  if (outcome === 'refused-invalid') {
    return `! ${codexInvalidTomlGuidance(configPath)}, or paste manually:\n\n${codexTomlSnippet()}\n`;
  }
  if (outcome === 'refused-hooks-shape') {
    return `! ${codexHooksShapeGuidance(configPath)}:\n\n${codexTomlSnippet()}\n`;
  }
  if (outcome === 'refused-fence') {
    return `! ${codexFenceGuidance(configPath)}.\n`;
  }
  if (outcome === 'refused-markers') {
    const state = await readCodexTomlState();
    return `! ${codexMarkerLineGuidance(state.path, state.markerProblemLines)}.\n`;
  }
  return null;
}
