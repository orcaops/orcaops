import type { SupportedAgentId } from '@orcaops/storage';

import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  scrubOutboundText,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { isCi } from '../lib/invocation-context.js';
import {
  applyUserSessionHookInstall,
  codexSessionHookGuidance,
  promptUserSessionHookInstall,
} from '../lib/session-hooks-install.js';
import {
  codexConfigTomlPath,
  codexDualRepresentationNote,
  codexFenceGuidance,
  codexHooksDisabledGuidance,
  codexHooksShapeGuidance,
  codexInvalidTomlGuidance,
  codexMarkerLineGuidance,
  type CodexRepresentationSurface,
  type CodexTomlRemoveOutcome,
  type CodexTomlState,
  evaluateUserSessionHookSurfaces,
  isCodexHooksJsonPath,
  planCodexTomlInstall,
  planUserSessionHooks,
  readCodexTomlState,
  readUserHooksRecordState,
  removeCodexTomlBlock,
  resolveCodexRepresentation,
  resolveUserHookPath,
  userHookCapableAgents,
  userHooksRecordPath,
  type UserSessionHookFilePlan,
  writeUserHooksRecord,
} from '../lib/session-hooks-user.js';
import { SESSION_HOOK_RESTART_NOTICE, sessionHooksRestartRequired } from '../lib/session-hooks.js';

/**
 * `orcaops session-hooks install|uninstall|status` — the MACHINE-level hook
 * registration command. Interactive personal init stages the same consent
 * plan and invokes the same writer after its interview completes.
 *
 * CONSENT CONTRACT: install is TTY-interactive ONLY, lists the exact absolute paths it
 * will modify before writing, and hard-refuses `--yes` / non-TTY with zero
 * writes — there is no unattended path into a user's home config, ever.
 * Uninstall restores the pre-consent state, so `--yes` is permitted there.
 * `--dry-run` previews (read-only) are allowed everywhere.
 */

export interface SessionHooksInstallOptions {
  agents?: string;
  json?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  representation?: string;
}

export interface SessionHooksUninstallOptions {
  json?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

function parseAgents(list: string | undefined, json: boolean | undefined): SupportedAgentId[] {
  const capable = userHookCapableAgents();
  if (!list) return capable;
  const wanted = list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown = wanted.filter((w) => !capable.includes(w as SupportedAgentId));
  if (unknown.length > 0) {
    const msg =
      `no user-level hook surface for: ${unknown.join(', ')} ` +
      `(supported: ${capable.join(', ')})`;
    if (json) emitError(new Error(msg));
    writeTerminalSafeStderr(`Error: ${msg}.\n`);
    throw new CliExit(1);
  }
  return wanted as SupportedAgentId[];
}

const CODEX_REPRESENTATIONS = ['hooks-json', 'config-toml'] as const;

function parseRepresentation(
  value: string | undefined,
  json: boolean | undefined
): CodexRepresentationSurface | undefined {
  if (value === undefined) return undefined;
  if ((CODEX_REPRESENTATIONS as readonly string[]).includes(value)) {
    return value as CodexRepresentationSurface;
  }
  const msg =
    `unknown --representation: ${value} ` + `(supported: ${CODEX_REPRESENTATIONS.join(', ')})`;
  if (json) emitError(new Error(msg));
  writeTerminalSafeStderr(`Error: ${msg}.\n`);
  throw new CliExit(1);
}

/** Why a config.toml removal refused, or null when it would go cleanly. */
function codexRemovalRefusal(
  outcome: CodexTomlRemoveOutcome,
  state: CodexTomlState
): string | null {
  if (outcome === 'removed' || outcome === 'absent') return null;
  if (outcome === 'manual-content') {
    return `${state.path} carries a manually-pasted or foreign orcaops hook — remove it yourself`;
  }
  if (outcome === 'refused-markers') {
    return codexMarkerLineGuidance(state.path, state.markerProblemLines);
  }
  if (outcome === 'refused-invalid') return codexInvalidTomlGuidance(state.path);
  if (outcome === 'refused-fence') return codexFenceGuidance(state.path);
  return `${state.readError ?? `${state.path} could not be read`} — left untouched`;
}

export async function sessionHooksInstallAction(
  opts: SessionHooksInstallOptions = {}
): Promise<void> {
  const agents = parseAgents(opts.agents, opts.json);
  const representationOverride = parseRepresentation(opts.representation, opts.json);

  if (opts.dryRun) {
    // One resolution per command, exactly as the consent plan does it.
    const representation = agents.includes('codex')
      ? await resolveCodexRepresentation(representationOverride)
      : null;
    const preview = await planUserSessionHooks(
      agents,
      'preview',
      'install',
      [],
      undefined,
      representation
    );
    const plans: Array<UserSessionHookFilePlan & { managed?: string }> = [...preview.plans];
    const warnings = [...preview.warnings];
    if (representation !== null && representation.surface === 'hooks-json') {
      // The sidecar is in the plans already; what the preview owes the reader
      // is the config.toml block the move would take away.
      const state = await readCodexTomlState(representation.tomlPath);
      const removal = await removeCodexTomlBlock(representation.tomlPath, undefined, 'preview');
      if (removal !== 'absent') {
        const refusal = codexRemovalRefusal(removal, state);
        plans.push({
          agent: 'codex' as SupportedAgentId,
          path: representation.tomlPath,
          action: refusal === null ? 'removed' : 'preserved-invalid',
          managed:
            refusal === null ? 'move the registration out of config.toml' : `keep both: ${refusal}`,
        });
        if (refusal !== null) warnings.push(`the move would keep both registrations: ${refusal}`);
      }
    } else if (representation !== null) {
      // Codex registers via the config.toml chooser, not the settings-json
      // planner — the preview names the surface and the edit the managed
      // choice would make (an empty preview reads as "install would do
      // nothing", which is false).
      const state = await readCodexTomlState();
      if (state.readStatus === 'unreadable') {
        plans.push({
          agent: 'codex' as SupportedAgentId,
          path: state.path,
          action: 'preserved-unreadable',
        });
        warnings.push(`${state.readError ?? `${state.path} could not be read`} — left untouched`);
      } else {
        const outcome = planCodexTomlInstall(state.raw).outcome;
        const refusal =
          outcome === 'refused-invalid'
            ? codexInvalidTomlGuidance(state.path)
            : outcome === 'refused-hooks-shape'
              ? codexHooksShapeGuidance(state.path)
              : outcome === 'refused-fence'
                ? codexFenceGuidance(state.path)
                : outcome === 'refused-markers'
                  ? codexMarkerLineGuidance(state.path, state.markerProblemLines)
                  : null;
        const action: UserSessionHookFilePlan['action'] =
          outcome === 'unchanged'
            ? 'unchanged'
            : refusal !== null
              ? 'preserved-invalid'
              : state.raw !== null && state.raw.trim() !== ''
                ? 'updated'
                : 'created';
        plans.push({
          agent: 'codex' as SupportedAgentId,
          path: state.path,
          action,
          managed:
            outcome === 'written'
              ? 'append the block'
              : outcome === 'unchanged'
                ? 'unchanged (already registered)'
                : `refuse: ${refusal}`,
        });
        if (refusal !== null) warnings.push(`managed mode would refuse: ${refusal}`);
        if (state.hooksDisabled) warnings.push(codexHooksDisabledGuidance(state.path));
      }
    }
    const outboundWarnings = warnings.map(scrubOutboundText);
    if (opts.json) {
      emitOk({
        command: 'session-hooks install',
        dry_run: true,
        plans,
        restart_required: false,
        warnings: outboundWarnings,
      });
    } else {
      writeTerminalSafeStdout('DRY RUN — nothing written.\n');
      for (const p of plans) {
        writeTerminalSafeStdout(
          `  ${p.action}: ${p.path}${p.managed === undefined ? '' : ` — ${p.managed}`}\n`
        );
      }
      for (const w of outboundWarnings) writeTerminalSafeStdout(`  ! ${w}\n`);
    }
    return;
  }

  // The consent boundary: no TTY (or an explicit --yes, or CI) can NEVER
  // write a user's home config. Hard refusal, zero writes, no bypass flag.
  if (opts.yes || !process.stdout.isTTY || !process.stdin.isTTY || isCi(process.env.CI)) {
    const msg =
      'Error: `orcaops session-hooks install` modifies YOUR user-level agent config ' +
      '(e.g. ~/.claude/settings.json) and therefore requires an interactive consent ' +
      'prompt — it never runs unattended and `--yes` is deliberately refused.\n' +
      'Run it from a terminal to review the exact files before anything is written.\n';
    if (opts.json) {
      emitError(new Error(msg.trim()));
    } else {
      writeTerminalSafeStderr(msg);
    }
    throw new CliExit(1);
  }

  // Under --json, stdout is the machine envelope — human prose (the consent
  // paragraph, the outcome text) rides stderr instead. The raw stream is
  // only for @clack's interactive rendering; prose goes terminal-safe.
  const say = opts.json ? writeTerminalSafeStderr : writeTerminalSafeStdout;
  const staged = await promptUserSessionHookInstall(agents, {
    say,
    output: opts.json ? process.stderr : process.stdout,
    representationOverride,
  });
  if (staged === null) {
    say('Nothing written.\n');
    return;
  }
  const result = await applyUserSessionHookInstall(staged, CLI_VERSION);
  const guidance = await codexSessionHookGuidance(result.codexOutcome);
  const outboundWarnings = result.warnings.map(scrubOutboundText);
  if (opts.json) {
    if (guidance !== null) say(`\n${guidance}\n`);
    emitOk({
      command: 'session-hooks install',
      dry_run: false,
      plans: result.plans,
      record: result.record,
      codex_migration: result.codexMigration,
      codex_trust_carry: result.codexTrustCarry,
      codex_trust_shift: result.codexTrustShift,
      restart_required: result.restartRequired,
      warnings: outboundWarnings,
    });
    return;
  }
  const representation = staged.consent.representation;
  for (const p of result.plans) {
    const note =
      p.agent === 'codex' && p.action === 'unchanged'
        ? ' (already registered)'
        : p.agent === 'codex' && p.action === 'updated' && p.path === representation?.hooksJsonPath
          ? ' (joined existing hooks.json)'
          : '';
    writeTerminalSafeStdout(`  ${p.action}: ${p.path}${note}\n`);
  }
  for (const w of outboundWarnings) writeTerminalSafeStdout(`  ! ${w}\n`);
  if (result.codexOutcome === 'managed-written') {
    const landed = result.codexConfigWrite === 'merged' ? 'merged into' : 'created:';
    writeTerminalSafeStdout(
      `  ${landed} ${codexConfigTomlPath()} (marker-owned block)\n` +
        '  ! Codex reviews new hooks once (hash-pinned trust) — approve the orcaops\n' +
        '    entry when asked, or it is silently skipped.\n'
    );
  }
  if (result.codexMigration === 'moved' && representation !== null) {
    const carried = result.codexTrustCarry === 'present' || result.codexTrustCarry === 'unchanged';
    writeTerminalSafeStdout(
      `  removed: ${representation.tomlPath} (marker block moved)\n` +
        `  The Codex registration moved to ${representation.hooksJsonPath}; Codex now loads\n` +
        '  it from one file instead of two.\n' +
        (carried
          ? '  The approval you already gave this hook moved with it, so Codex should not\n  ask about it again.\n'
          : '  ! Codex reviews the entry once in its new file — approve it when asked, or it\n    is silently skipped.\n')
    );
  }
  const shift = result.codexTrustShift;
  if (shift.moved > 0) {
    const moved =
      shift.moved === 1
        ? '1 approval already given to another hook moved with it'
        : `${shift.moved} approvals already given to other hooks moved with them`;
    writeTerminalSafeStdout(
      `  The orcaops entry goes first in hooks.json, so ${moved},\n` +
        '  and Codex should not ask about them again.\n'
    );
  }
  if (shift.skipped.length > 0) {
    const count = shift.skipped.length;
    writeTerminalSafeStdout(
      `  ! ${count} approval${count === 1 ? '' : 's'} for other hooks could not be moved, so Codex asks about\n` +
        `    ${count === 1 ? 'that hook' : 'those hooks'} once:\n` +
        shift.skipped.map((key) => `      ${key}\n`).join('')
    );
  }
  if (guidance !== null) writeTerminalSafeStdout(`\n${guidance}`);
  if (result.installedEntries.length > 0) {
    const codexNeedsAttention =
      result.codexOutcome !== null &&
      (result.codexOutcome.startsWith('refused-') || result.codexOutcome === 'failed');
    const installed = codexNeedsAttention
      ? `Installed for ${result.liveAgents.join(', ')}; Codex needs attention above.\n`
      : 'Installed. ';
    writeTerminalSafeStdout(
      `\n${installed}Repos opt in per-repo with \`orcaops update --session-hooks\`\n` +
        '(the hook stays silent everywhere else). Remove any time with\n' +
        '`orcaops session-hooks uninstall`.\n'
    );
  } else {
    writeTerminalSafeStdout('\nNo managed entries written.\n');
  }
  if (result.restartRequired) {
    writeTerminalSafeStdout(`! ${SESSION_HOOK_RESTART_NOTICE}\n`);
  }
}

export async function sessionHooksUninstallAction(
  opts: SessionHooksUninstallOptions = {}
): Promise<void> {
  const mode = opts.dryRun ? 'preview' : 'apply';
  const recordState = await readUserHooksRecordState();
  const recordedEntries = recordState.status === 'ok' ? recordState.record.entries : [];
  const result = await planUserSessionHooks([], mode, 'uninstall', recordedEntries);
  if (recordState.status === 'unreadable') {
    result.warnings.push(
      `${userHooksRecordPath()} could not be read (${recordState.message}) — left untouched; retry after restoring access`
    );
  }

  const unresolved = new Set(
    result.plans.filter((plan) => plan.unresolved).map((plan) => `${plan.agent}\0${plan.path}`)
  );
  for (const entry of recordedEntries) {
    if (entry.agent !== 'codex' && resolveUserHookPath(entry.agent) === null) {
      unresolved.add(`${entry.agent}\0${entry.path}`);
    }
  }
  // A recorded codex sidecar path is stripped by the JSON planner above; only
  // config.toml paths belong to the marker-proof remover.
  const codexPaths = [
    codexConfigTomlPath(),
    ...recordedEntries
      .filter((entry) => entry.agent === 'codex' && !isCodexHooksJsonPath(entry.path))
      .map((entry) => entry.path),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  const codexRemovals: Array<{
    path: string;
    outcome: Awaited<ReturnType<typeof removeCodexTomlBlock>>;
  }> = [];
  for (const configPath of codexPaths) {
    const state = await readCodexTomlState(configPath);
    const outcome = await removeCodexTomlBlock(configPath, undefined, mode);
    codexRemovals.push({ path: configPath, outcome });
    if (outcome === 'manual-content') {
      result.warnings.push(
        `${configPath} carries a manually-pasted or foreign orcaops hook — remove it yourself; orcaops never edits content it did not mark`
      );
    } else if (outcome === 'refused-markers') {
      result.warnings.push(codexMarkerLineGuidance(configPath, state.markerProblemLines));
      unresolved.add(`codex\0${configPath}`);
    } else if (outcome === 'refused-fence') {
      result.warnings.push(codexFenceGuidance(configPath));
      unresolved.add(`codex\0${configPath}`);
    } else if (outcome === 'refused-invalid') {
      result.warnings.push(codexInvalidTomlGuidance(configPath));
      unresolved.add(`codex\0${configPath}`);
    } else if (outcome === 'unreadable') {
      result.warnings.push(
        `${state.readError ?? `${configPath} could not be verified or cleaned`} — retry after restoring access`
      );
      unresolved.add(`codex\0${configPath}`);
    }
  }

  if (!opts.dryRun && recordState.status === 'ok') {
    const remaining = recordState.record.entries.filter((entry) =>
      unresolved.has(`${entry.agent}\0${entry.path}`)
    );
    await writeUserHooksRecord(
      remaining.length === 0 ? null : { ...recordState.record, entries: remaining }
    );
  }

  const restart = sessionHooksRestartRequired(result.plans);
  const outboundWarnings = result.warnings.map(scrubOutboundText);
  const codexRows = codexRemovals.filter((entry) => entry.outcome !== 'absent');
  if (opts.json) {
    emitOk({
      command: 'session-hooks uninstall',
      dry_run: !!opts.dryRun,
      plans: result.plans,
      codex: codexRows,
      restart_required: !opts.dryRun && restart,
      warnings: outboundWarnings,
    });
    return;
  }
  if (opts.dryRun) writeTerminalSafeStdout('DRY RUN — nothing written.\n');
  if (result.plans.length === 0 && codexRows.length === 0) {
    writeTerminalSafeStdout('No orcaops session-hook entries in any user config.\n');
  }
  for (const p of result.plans) writeTerminalSafeStdout(`  ${p.action}: ${p.path}\n`);
  for (const removal of codexRows) {
    writeTerminalSafeStdout(
      `  ${removal.outcome}: ${removal.path}${removal.outcome === 'removed' ? ' (marker-owned block)' : ''}\n`
    );
  }
  for (const w of outboundWarnings) writeTerminalSafeStdout(`  ! ${w}\n`);
  if (!opts.dryRun && restart) {
    writeTerminalSafeStdout(`! ${SESSION_HOOK_RESTART_NOTICE}\n`);
  }
}

export async function sessionHooksStatusAction(opts: { json?: boolean } = {}): Promise<void> {
  const recordState = await readUserHooksRecordState();
  const record = recordState.status === 'ok' ? recordState.record : null;
  const evaluated = await evaluateUserSessionHookSurfaces(record);
  const hooksJsonNote = await codexDualRepresentationNote();
  const codexConfig = codexConfigTomlPath();
  const rows = evaluated.map(({ agent, path, state, remedy }) => ({
    agent,
    path,
    state,
    ...(remedy ? { remedy: scrubOutboundText(remedy) } : {}),
    ...(hooksJsonNote !== null && agent === 'codex' && path === codexConfig
      ? { note: hooksJsonNote }
      : {}),
  }));
  const recordError =
    recordState.status === 'unreadable' ? scrubOutboundText(recordState.message) : null;

  if (opts.json) {
    emitOk({
      command: 'session-hooks status',
      record,
      record_error: recordError,
      record_path: userHooksRecordPath(),
      surfaces: rows,
    });
    return;
  }
  writeTerminalSafeStdout(
    recordError !== null
      ? `Registration record could not be read and was left untouched: ${recordError}\n`
      : record
        ? `Consented ${record.consented_at} (CLI ${record.cli_version}).\n`
        : 'No machine-level registration recorded.\n'
  );
  for (const r of rows) {
    writeTerminalSafeStdout(`  ${r.state.padEnd(24)} ${r.path}  (${r.agent})\n`);
    if (r.remedy) writeTerminalSafeStdout(`  ! ${r.remedy}\n`);
    if (r.note) writeTerminalSafeStdout(`  ${r.note}\n`);
  }
  if (rows.some((r) => r.state === 'registered-but-missing')) {
    writeTerminalSafeStdout(
      '! A registered entry is missing — re-run `orcaops session-hooks install`.\n'
    );
  }
  if (rows.some((r) => r.state === 'registered-unsupported')) {
    writeTerminalSafeStdout(
      '! A registration names an agent this CLI version has no user surface for — ' +
        're-register or run `orcaops session-hooks uninstall` to clear it.\n'
    );
  }
}
