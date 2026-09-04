import type { Writable } from 'node:stream';

import type { SupportedAgentId } from '@orcaops/storage';

import {
  codexConfigTomlPath,
  codexFenceGuidance,
  codexHooksDisabledGuidance,
  codexHooksJsonNote,
  codexHooksShapeGuidance,
  codexInvalidTomlGuidance,
  codexMarkerLineGuidance,
  codexTomlSnippet,
  planUserSessionHookConsent,
  planUserSessionHooks,
  type PlanUserSessionHooksResult,
  readCodexTomlState,
  readUserHooksRecordState,
  type UserHooksRecordEntry,
  userHooksRecordPath,
  type UserSessionHookConsentPlan,
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
}

export interface AppliedUserSessionHookInstall extends PlanUserSessionHooksResult {
  codexOutcome: CodexSessionHookOutcome;
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
  const consent = planUserSessionHookConsent(agents);

  options.say(
    'Machine-level session hooks inject short orcaops capture guidance at every agent\n' +
      'session start, in every repo that has BOTH run `orcaops init` and enabled\n' +
      'session hooks. Repos without orcaops stay completely silent.\n\n' +
      'This consent covers the following user config surfaces:\n' +
      consent.surfaces
        .map((surface) =>
          surface.mode === 'managed-choice'
            ? `  ? ${surface.path}  (${surface.agent}; may modify in managed mode only)\n`
            : `  ~ ${surface.path}  (${surface.agent}; will reconcile this entry)\n`
        )
        .join('') +
      '\nOnly exact orcaops-managed entries are reconciled; other entries are preserved.\n' +
      'Undo managed entries any time with `orcaops session-hooks uninstall`.\n\n'
  );
  const proceed = await prompts.confirm({
    message: `Continue with ${consent.surfaces.length} selected user config surface(s)?`,
    initialValue: false,
    output: options.output,
  });
  if (prompts.isCancel(proceed)) options.onCancel?.();
  if (proceed !== true) return null;

  let codexChoice: CodexSessionHookChoice | null = null;
  if (consent.codexWanted) {
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
  const result = await planUserSessionHooks(staged.consent.jsonAgents, 'apply');
  let codexOutcome: CodexSessionHookOutcome = null;
  let codexConfigWrite: AppliedUserSessionHookInstall['codexConfigWrite'] = null;

  if (staged.consent.codexWanted) {
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
              (entry) => !installedPaths.has(`${entry.agent}\0${entry.path}`)
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
    codexConfigWrite,
    installedEntries,
    liveAgents,
    record,
    restartRequired:
      sessionHooksRestartRequired(result.plans) || codexOutcome === 'managed-written',
    partialFailure,
  };
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
    const note = await codexHooksJsonNote();
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
