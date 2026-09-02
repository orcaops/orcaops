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
  codexMarkerLineGuidance,
  evaluateUserSessionHookSurfaces,
  planUserSessionHooks,
  readCodexTomlState,
  readUserHooksRecordState,
  removeCodexTomlBlock,
  resolveUserHookPath,
  userHookCapableAgents,
  userHooksRecordPath,
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
}

export interface SessionHooksUninstallOptions {
  json?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

function parseAgents(list: string | undefined, json: boolean | undefined): SupportedAgentId[] {
  // codex registers via the config.toml flow, not the settings-json
  // machinery — still a valid install target here.
  const capable: SupportedAgentId[] = [...userHookCapableAgents(), 'codex' as SupportedAgentId];
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

export async function sessionHooksInstallAction(
  opts: SessionHooksInstallOptions = {}
): Promise<void> {
  const agents = parseAgents(opts.agents, opts.json);

  if (opts.dryRun) {
    const preview = await planUserSessionHooks(agents, 'preview');
    const plans = [...preview.plans];
    const warnings = [...preview.warnings];
    if (agents.includes('codex' as SupportedAgentId)) {
      // Codex registers via the config.toml chooser, not the settings-json
      // planner — the preview must still name the surface instead of
      // silently omitting it (an empty preview reads as "install would do
      // nothing", which is false).
      const state = await readCodexTomlState();
      plans.push({
        agent: 'codex' as SupportedAgentId,
        path: state.path,
        action:
          state.readStatus === 'unreadable'
            ? 'preserved-unreadable'
            : state.installed
              ? 'unchanged'
              : 'created',
      });
      if (state.readStatus === 'unreadable') {
        warnings.push(`${state.readError ?? `${state.path} could not be read`} — left untouched`);
      } else if (state.markerProblemLines.length > 0) {
        warnings.push(codexMarkerLineGuidance(state.path, state.markerProblemLines));
      } else if (state.markerBlockBroken) {
        warnings.push(
          `${state.path}: owned marker block is incomplete; re-run install and choose managed mode to repair it`
        );
      } else if (!state.installed) {
        warnings.push(
          `${state.path}: codex registration is chooser-driven at install — ` +
            `manual snippet paste (recommended) or a managed marker block` +
            (state.collision
              ? '; managed mode would REFUSE here (invalid TOML or root features/hooks already present), manual paste only'
              : '')
        );
      } else if (state.gateMissing) {
        warnings.push(
          `${state.path}: hook command present but no \`hooks = true\` features gate detected`
        );
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
      for (const p of plans) writeTerminalSafeStdout(`  ${p.action}: ${p.path}\n`);
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
  });
  if (staged === null) {
    say('Nothing written.\n');
    return;
  }
  const result = await applyUserSessionHookInstall(staged, CLI_VERSION);
  const guidance = await codexSessionHookGuidance(result.codexOutcome);
  if (guidance !== null) say(`\n${guidance}\n`);
  const outboundWarnings = result.warnings.map(scrubOutboundText);
  if (opts.json) {
    emitOk({
      command: 'session-hooks install',
      dry_run: false,
      plans: result.plans,
      record: result.record,
      restart_required: result.restartRequired,
      warnings: outboundWarnings,
    });
    return;
  }
  for (const p of result.plans) writeTerminalSafeStdout(`  ${p.action}: ${p.path}\n`);
  for (const w of outboundWarnings) writeTerminalSafeStdout(`  ! ${w}\n`);
  if (result.codexOutcome === 'managed-written') {
    writeTerminalSafeStdout(
      `  created: ${codexConfigTomlPath()} (marker-owned block)\n` +
        '  ! Codex reviews new hooks once (hash-pinned trust) — approve the orcaops\n' +
        '    entry when asked, or it is silently skipped.\n'
    );
  }
  if (result.installedEntries.length > 0) {
    writeTerminalSafeStdout(
      '\nInstalled. Repos opt in per-repo with `orcaops update --session-hooks`\n' +
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
  const codexPaths = [
    codexConfigTomlPath(),
    ...recordedEntries.filter((entry) => entry.agent === 'codex').map((entry) => entry.path),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  const codexRemovals: Array<{
    path: string;
    outcome: Awaited<ReturnType<typeof removeCodexTomlBlock>>;
  }> = [];
  for (const configPath of codexPaths) {
    const state = await readCodexTomlState(configPath);
    const outcome = opts.dryRun
      ? state.readStatus === 'unreadable'
        ? 'unreadable'
        : state.markerProblemLines.length > 0
          ? 'refused-markers'
          : state.markerBlock
            ? 'removed'
            : state.installed
              ? 'manual-content'
              : 'absent'
      : await removeCodexTomlBlock(configPath);
    codexRemovals.push({ path: configPath, outcome });
    if (outcome === 'manual-content') {
      result.warnings.push(
        `${configPath} carries a manually-pasted or foreign orcaops hook — remove it yourself; orcaops never edits content it did not mark`
      );
    } else if (outcome === 'refused-markers') {
      result.warnings.push(codexMarkerLineGuidance(configPath, state.markerProblemLines));
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
  if (opts.json) {
    emitOk({
      command: 'session-hooks uninstall',
      dry_run: !!opts.dryRun,
      plans: result.plans,
      restart_required: !opts.dryRun && restart,
      warnings: outboundWarnings,
    });
    return;
  }
  if (result.plans.length === 0 && codexRemovals.every((entry) => entry.outcome === 'absent')) {
    writeTerminalSafeStdout('No orcaops session-hook entries in any user config.\n');
  }
  for (const p of result.plans) writeTerminalSafeStdout(`  ${p.action}: ${p.path}\n`);
  for (const removal of codexRemovals) {
    if (removal.outcome === 'removed') {
      writeTerminalSafeStdout(`  removed: ${removal.path} (marker-owned block)\n`);
    }
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
  const rows = evaluated.map(({ agent, path, state, remedy }) => ({
    agent,
    path,
    state,
    ...(remedy ? { remedy: scrubOutboundText(remedy) } : {}),
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
