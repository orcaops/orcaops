import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml, type TomlTable } from 'smol-toml';

import { getAgentOverlay } from '@orcaops/adapters';
import { SUPPORTED_AGENT_IDS, type SupportedAgentId } from '@orcaops/storage';

import { atomicWriteFile } from './atomic-write.js';
import { resolveGlobalRoot } from './global-install.js';
import { getInvocationEnv } from './invocation-context.js';
import {
  canonicalSessionHookCommand,
  isSemanticallyEmpty,
  type JsonObject,
  reconcileDocument,
  serializeSettings,
  SESSION_HOOK_COMMAND,
  type SessionHookAction,
  type SettingsSpec,
  settingsSpecs,
} from './session-hooks.js';

/**
 * MACHINE-level session-hook registration — the consent-gated
 * `orcaops session-hooks install|uninstall|status` surface. Writes the same
 * self-identifying, version-free entries as the project planner, but into
 * each agent's USER config file (`~/.claude/settings.json`,
 * `~/.codex/config.toml`), so one explicit opt-in covers every repo on the
 * machine and survives re-clones with zero repo footprint.
 *
 * The consent boundary is absolute: only the dedicated interactive command
 * and interactive personal init after its full interview may write here —
 * update, doctor --fix, and repo uninstall never touch a user file. The
 * reconcile core is shared with the project planner (user hooks preserved,
 * invalid JSON untouched, semantically-empty husks deleted), and ownership
 * stays with exact canonical commands — `~/.orcaops/hooks.local.json` is
 * consent BOOKKEEPING, never the authority (uninstall/status scan every
 * resolvable path regardless).
 *
 * Mutations here are self-contained fs ops on absolute paths (the
 * global-install precedent) — the repo mutation layer is repo-relative by
 * construction.
 */

export interface UserHooksRecordEntry {
  agent: SupportedAgentId;
  /** Absolute path of the user settings file the entry was written into. */
  path: string;
  installed_at: string;
}

export interface UserHooksRecord {
  record_version: 1;
  consented_at: string;
  cli_version: string;
  entries: UserHooksRecordEntry[];
}

export type UserHooksRecordReadResult =
  | { status: 'absent' }
  | { status: 'ok'; record: UserHooksRecord }
  | { status: 'unreadable'; message: string };

export function userHooksRecordPath(): string {
  return path.join(resolveGlobalRoot(), 'hooks.local.json');
}

export async function readUserHooksRecordState(): Promise<UserHooksRecordReadResult> {
  let raw: string;
  try {
    raw = await readFile(userHooksRecordPath(), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'unreadable', message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = JSON.parse(raw) as UserHooksRecord;
    if (
      parsed?.record_version !== 1 ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.some(
        (entry) =>
          !SUPPORTED_AGENT_IDS.includes(entry?.agent) ||
          typeof entry?.path !== 'string' ||
          !path.isAbsolute(entry.path) ||
          typeof entry?.installed_at !== 'string'
      )
    ) {
      return { status: 'unreadable', message: 'record structure is invalid' };
    }
    return { status: 'ok', record: parsed };
  } catch (error) {
    return {
      status: 'unreadable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readUserHooksRecord(): Promise<UserHooksRecord | null> {
  const result = await readUserHooksRecordState();
  return result.status === 'ok' ? result.record : null;
}

export async function writeUserHooksRecord(record: UserHooksRecord | null): Promise<void> {
  const p = userHooksRecordPath();
  if (record === null) {
    await rm(p, { force: true });
    return;
  }
  await mkdir(path.dirname(p), { recursive: true });
  // Orcaops-owned bookkeeping under the global root: contained like the
  // grants file and user-only, matching its 0600 convention.
  await atomicWriteFile(p, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
    containmentRoot: resolveGlobalRoot(),
  });
}

/**
 * The agent's USER config home. Env overrides come from the invocation env
 * (per-test overridable) — deliberately NOT the agent-targets module-load
 * constants, which freeze `process.env` at import time.
 */
export function resolveUserHookHome(agent: SupportedAgentId): string | null {
  const env = getInvocationEnv();
  const trimmed = (v: string | undefined): string | null => {
    const t = v?.trim();
    return t && t.length > 0 ? t : null;
  };
  switch (agent) {
    case 'claude-code':
      return trimmed(env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), '.claude');
    case 'codex':
      return trimmed(env.CODEX_HOME) ?? path.join(os.homedir(), '.codex');
    default:
      return null;
  }
}

/** Absolute user settings path for an agent, or null when it has no user surface. */
export function resolveUserHookPath(agent: SupportedAgentId): string | null {
  const sh = getAgentOverlay(agent)?.sessionHooks;
  if (!sh || sh.kind !== 'settings-json' || !sh.userFile) return null;
  const home = resolveUserHookHome(agent);
  return home ? path.join(home, sh.userFile) : null;
}

/** The install set the machine-level surface can carry (overlay-derived). */
export function userHookCapableAgents(): SupportedAgentId[] {
  return SUPPORTED_AGENT_IDS.filter((id) => resolveUserHookPath(id) !== null);
}

export interface UserSessionHookConsentSurface {
  agent: SupportedAgentId;
  path: string;
  mode: 'reconcile' | 'managed-choice';
}

export interface UserSessionHookConsentPlan {
  agents: SupportedAgentId[];
  jsonAgents: SupportedAgentId[];
  codexWanted: boolean;
  surfaces: UserSessionHookConsentSurface[];
}

export function planUserSessionHookConsent(
  requestedAgents: SupportedAgentId[]
): UserSessionHookConsentPlan {
  const agents = [...new Set(requestedAgents)];
  const jsonAgents = agents.filter((agent) => agent !== 'codex');
  const codexWanted = agents.includes('codex' as SupportedAgentId);
  const surfaces = jsonAgents.flatMap((agent): UserSessionHookConsentSurface[] => {
    const settingsPath = resolveUserHookPath(agent);
    return settingsPath === null ? [] : [{ agent, path: settingsPath, mode: 'reconcile' }];
  });
  if (codexWanted) {
    surfaces.push({
      agent: 'codex' as SupportedAgentId,
      path: codexConfigTomlPath(),
      mode: 'managed-choice',
    });
  }
  return { agents, jsonAgents, codexWanted, surfaces };
}

/**
 * The user-level spec for an agent: the project spec re-pointed at the
 * absolute user path, with `--user` inside the guarded invocation so (a) the
 * runtime can arbitrate against a project entry (project wins, user no-ops)
 * and (b) agents that dedupe identical commands never merge the two. The
 * command stays distinct from the project form.
 */
export function userSettingsSpec(
  agent: SupportedAgentId,
  pathOverride?: string
): SettingsSpec | null {
  const abs = pathOverride ?? resolveUserHookPath(agent);
  if (abs === null) return null;
  const base = settingsSpecs().find((s) => s.agent === agent);
  if (!base) return null;
  const desired = structuredClone(base.desired) as JsonObject;
  if (base.schema === 'flat') {
    desired.command = canonicalSessionHookCommand(agent, { user: true });
  } else {
    const hooks = desired.hooks as JsonObject[];
    hooks[0].command = canonicalSessionHookCommand(agent, { user: true });
  }
  return { ...base, path: abs, desired };
}

export interface UserSessionHookFilePlan {
  agent: SupportedAgentId;
  /** ABSOLUTE user settings path. */
  path: string;
  action:
    | SessionHookAction
    | 'absent'
    | 'foreign-content'
    | 'preserved-unreadable'
    | 'preserved-unwritable';
  unresolved?: boolean;
}

export interface PlanUserSessionHooksResult {
  plans: UserSessionHookFilePlan[];
  warnings: string[];
}

type UserConfigPathState =
  | { status: 'ok'; writePath: string; mode: number; symlink: boolean }
  | { status: 'absent'; symlink: false }
  | { status: 'unreadable'; symlink: boolean; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectUserConfigPath(absPath: string): Promise<UserConfigPathState> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(absPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'absent', symlink: false }
      : { status: 'unreadable', symlink: false, message: errorMessage(error) };
  }

  const symlink = entry.isSymbolicLink();
  let writePath: string;
  try {
    writePath = await realpath(absPath);
  } catch (error) {
    if (symlink && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'unreadable',
        symlink: true,
        message: `${absPath} is a dangling symlink — repair or remove the link, then re-run`,
      };
    }
    return { status: 'unreadable', symlink, message: errorMessage(error) };
  }

  try {
    const target = await stat(writePath);
    if (!target.isFile()) {
      return {
        status: 'unreadable',
        symlink,
        message: `${absPath} does not resolve to a regular file`,
      };
    }
    return { status: 'ok', writePath, mode: target.mode & 0o7777, symlink };
  } catch (error) {
    return { status: 'unreadable', symlink, message: errorMessage(error) };
  }
}

interface UserConfigWriteOptions {
  expectedContent?: string | null;
  resolvedPath?: string;
  mode?: number;
  changedMessage?: string;
}

async function assertUserConfigPreImage(
  absPath: string,
  writePath: string,
  options: UserConfigWriteOptions
): Promise<void> {
  const changed = (): Error =>
    new Error(options.changedMessage ?? `${absPath} changed while editing — re-run`);
  if (options.resolvedPath !== undefined) {
    let currentResolvedPath: string;
    try {
      currentResolvedPath = await realpath(absPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw changed();
      throw error;
    }
    if (currentResolvedPath !== options.resolvedPath) throw changed();
  }

  let current: string | null;
  try {
    current = await readFile(writePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    current = null;
  }
  if (current !== options.expectedContent) throw changed();
}

async function writeUserConfigFile(
  absPath: string,
  content: string,
  options: UserConfigWriteOptions = {}
): Promise<void> {
  const state = await inspectUserConfigPath(absPath);
  if (state.status === 'unreadable') throw new Error(state.message);
  let writePath: string;
  let mode: number;
  if (options.resolvedPath !== undefined) {
    writePath = options.resolvedPath;
    mode = options.mode ?? (await stat(writePath)).mode & 0o7777;
  } else if (state.status === 'ok') {
    writePath = state.writePath;
    mode = state.mode;
  } else {
    await mkdir(path.dirname(absPath), { recursive: true });
    const resolvedParent = await realpath(path.dirname(absPath));
    writePath = path.join(resolvedParent, path.basename(absPath));
    mode = 0o600;
  }

  await atomicWriteFile(writePath, content, {
    mode,
    ...(options.expectedContent !== undefined
      ? {
          beforeRename: async (): Promise<void> =>
            assertUserConfigPreImage(absPath, writePath, options),
        }
      : {}),
  });
}

async function readUserFile(
  absPath: string
): Promise<
  | { status: 'ok'; raw: string; symlink: boolean; writePath: string; mode: number }
  | { status: 'absent' }
  | { status: 'unreadable'; message: string }
> {
  const state = await inspectUserConfigPath(absPath);
  if (state.status === 'absent') return { status: 'absent' };
  if (state.status === 'unreadable') {
    return { status: 'unreadable', message: state.message ?? `${absPath} could not be read` };
  }
  try {
    return {
      status: 'ok',
      raw: await readFile(state.writePath, 'utf8'),
      symlink: state.symlink,
      writePath: state.writePath,
      mode: state.mode,
    };
  } catch (error) {
    return { status: 'unreadable', message: errorMessage(error) };
  }
}

export type UserSessionHookPlanOperation = 'install' | 'uninstall';

/** Reconcile selected installs or strip every capable surface on uninstall. */
export async function planUserSessionHooks(
  agents: SupportedAgentId[],
  mode: 'apply' | 'preview',
  operation: UserSessionHookPlanOperation = 'install',
  recordedEntries: readonly UserHooksRecordEntry[] = [],
  beforeWrite?: (absPath: string) => Promise<void>
): Promise<PlanUserSessionHooksResult> {
  const plans: UserSessionHookFilePlan[] = [];
  const warnings: string[] = [];
  const currentTargets = (
    operation === 'uninstall' ? userHookCapableAgents() : [...new Set(agents)]
  )
    .map((agent) => ({ agent, path: resolveUserHookPath(agent) }))
    .filter((entry): entry is { agent: SupportedAgentId; path: string } => entry.path !== null);
  const targets = [
    ...currentTargets,
    ...(operation === 'uninstall'
      ? recordedEntries.filter(
          (entry) =>
            entry.agent !== ('codex' as SupportedAgentId) &&
            resolveUserHookPath(entry.agent) !== null
        )
      : []),
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) => candidate.agent === entry.agent && candidate.path === entry.path
      ) === index
  );
  const recordedPaths = new Set(recordedEntries.map((entry) => `${entry.agent}\0${entry.path}`));
  const desired = operation === 'install';

  for (const target of targets) {
    const { agent } = target;
    const spec = userSettingsSpec(agent, target.path);
    if (!spec) continue;
    const recorded = recordedPaths.has(`${agent}\0${spec.path}`);
    const file = await readUserFile(spec.path);

    if (file.status === 'absent') {
      if (!desired) {
        if (recorded) plans.push({ agent, path: spec.path, action: 'absent' });
        continue;
      }
      const root: JsonObject = structuredClone(spec.seed);
      reconcileDocument(root, spec, spec.desired);
      if (mode === 'apply') {
        await beforeWrite?.(spec.path);
        // expectedContent: null = the file must still be absent at rename.
        await writeUserConfigFile(spec.path, serializeSettings(root), { expectedContent: null });
      }
      plans.push({ agent, path: spec.path, action: 'created' });
      continue;
    }
    if (file.status === 'unreadable') {
      plans.push({ agent, path: spec.path, action: 'preserved-unreadable', unresolved: recorded });
      warnings.push(
        file.message.includes('dangling symlink')
          ? `${file.message}; left untouched`
          : `${file.message} — left untouched; retry after restoring access`
      );
      continue;
    }
    const { raw } = file;

    const relevant = desired || raw.includes(SESSION_HOOK_COMMAND);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      if (!relevant) continue;
      plans.push({
        agent,
        path: spec.path,
        action: 'preserved-invalid-json',
        unresolved: recorded,
      });
      warnings.push(`${spec.path} is not a valid JSON object — left untouched`);
      continue;
    }

    const root = structuredClone(parsed) as JsonObject;
    if (reconcileDocument(root, spec, desired ? spec.desired : null) === 'invalid') {
      if (!relevant) continue;
      plans.push({
        agent,
        path: spec.path,
        action: 'preserved-invalid-json',
        unresolved: recorded,
      });
      warnings.push(`${spec.path} has an unexpected "hooks" shape — left untouched`);
      continue;
    }

    if (JSON.stringify(parsed) === JSON.stringify(root)) {
      if (desired) plans.push({ agent, path: spec.path, action: 'unchanged' });
      else if (recorded) {
        plans.push({ agent, path: spec.path, action: 'foreign-content' });
        warnings.push(`${spec.path} has no exact orcaops-managed entry — left untouched`);
      }
      continue;
    }

    if (!desired && isSemanticallyEmpty(root, spec)) {
      if (mode === 'apply') {
        try {
          await beforeWrite?.(spec.path);
          if (file.symlink) {
            await writeUserConfigFile(spec.path, serializeSettings(structuredClone(spec.seed)), {
              expectedContent: raw,
              resolvedPath: file.writePath,
              mode: file.mode,
            });
          } else {
            await assertUserConfigPreImage(spec.path, file.writePath, {
              expectedContent: raw,
              resolvedPath: file.writePath,
            });
            await rm(spec.path, { force: true });
          }
        } catch {
          plans.push({
            agent,
            path: spec.path,
            action: 'preserved-unwritable',
            unresolved: recorded,
          });
          warnings.push(`${spec.path} could not be removed — retry after restoring access`);
          continue;
        }
      }
      plans.push({ agent, path: spec.path, action: 'removed' });
      continue;
    }

    if (mode === 'apply') {
      try {
        await beforeWrite?.(spec.path);
        await writeUserConfigFile(spec.path, serializeSettings(root), {
          expectedContent: raw,
          resolvedPath: file.writePath,
          mode: file.mode,
        });
      } catch {
        plans.push({
          agent,
          path: spec.path,
          action: 'preserved-unwritable',
          unresolved: recorded,
        });
        warnings.push(`${spec.path} could not be updated — retry after restoring access`);
        continue;
      }
    }
    plans.push({ agent, path: spec.path, action: desired ? 'updated' : 'removed' });
  }

  return { plans, warnings };
}

// Codex config.toml surface.
//
// Shipped codex-cli (0.146.0, live-validated) never reads hooks.json: hooks
// register as a `hooks` struct in $CODEX_HOME/config.toml, gated by
// `[features].hooks`. That file is the user's PRIMARY Codex config, so
// orcaops never TOML-round-trips it — the managed mode appends a
// marker-delimited text block ONLY when the existing file parses and has no
// root `features` or `hooks` key, and otherwise degrades to printing the
// snippet for a manual paste (the recommended mode either way).

export const CODEX_TOML_MARKER_START = '# >>> orcaops session-hooks >>>';
export const CODEX_TOML_MARKER_END = '# <<< orcaops session-hooks <<<';

export function codexMarkerLineGuidance(file: string, lines: number[]): string {
  return `${file} has malformed or duplicate orcaops marker lines (${lines.join(', ')}); remove those complete lines, then re-run the command`;
}

export function codexConfigTomlPath(): string {
  const home = resolveUserHookHome('codex' as SupportedAgentId);
  return home ? path.join(home, 'config.toml') : path.join(os.homedir(), '.codex', 'config.toml');
}

/** The exact TOML the registration needs — printed for manual paste and written by managed mode. */
export function codexTomlSnippet(): string {
  const command = canonicalSessionHookCommand('codex' as SupportedAgentId, { user: true });
  return [
    '[features]',
    'hooks = true',
    '',
    '[[hooks.SessionStart]]',
    'matcher = "startup|resume"',
    `hooks = [{ type = "command", command = "${command}" }]`,
  ].join('\n');
}

export interface CodexTomlState {
  path: string;
  resolvedPath: string | null;
  mode: number | null;
  readStatus: 'ok' | 'absent' | 'unreadable';
  symlink: boolean;
  readError?: string;
  /** File content, or null when absent. */
  raw: string | null;
  /** Our command substring is present (manual paste OR managed block). */
  installed: boolean;
  /** A marker-delimited orcaops block exists (managed mode owns it). */
  markerBlock: boolean;
  /** The owned block is present but cannot currently register the hook. */
  markerBlockBroken: boolean;
  /** Lines containing inverted, orphaned, or duplicate marker lines. */
  markerProblemLines: number[];
  /** TOML is invalid or root `features`/`hooks` exists outside our markers. */
  collision: boolean;
  /** Command present but the `hooks = true` features gate is not detectable. */
  gateMissing: boolean;
}

interface CodexTomlMarkerBlock {
  start: number;
  end: number;
}

interface CodexTomlMarkerLine {
  start: number;
  line: number;
}

interface CodexTomlMarkerState {
  block: CodexTomlMarkerBlock | null;
  problemLines: number[];
}

function markerLines(raw: string, marker: string): CodexTomlMarkerLine[] {
  const matches: CodexTomlMarkerLine[] = [];
  let start = 0;
  let line = 1;
  while (start <= raw.length) {
    const newline = raw.indexOf('\n', start);
    const end = newline === -1 ? raw.length : newline;
    const value = raw.slice(start, end).replace(/\r$/, '');
    if (value === marker) matches.push({ start, line });
    if (newline === -1) break;
    start = newline + 1;
    line += 1;
  }
  return matches;
}

function codexTomlMarkerState(raw: string): CodexTomlMarkerState {
  const starts = markerLines(raw, CODEX_TOML_MARKER_START);
  const ends = markerLines(raw, CODEX_TOML_MARKER_END);
  if (starts.length === 0 && ends.length === 0) return { block: null, problemLines: [] };

  if (starts.length === 1 && ends.length === 1 && ends[0].start > starts[0].start) {
    return {
      block: {
        start: starts[0].start,
        end: ends[0].start + CODEX_TOML_MARKER_END.length,
      },
      problemLines: [],
    };
  }

  return {
    block: null,
    problemLines: [...starts, ...ends].map((entry) => entry.line).sort((a, b) => a - b),
  };
}

function parseCodexToml(raw: string): TomlTable | null {
  try {
    return parseToml(raw);
  } catch {
    return null;
  }
}

function hasOwnTomlKey(table: TomlTable, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function codexHooksFeatureEnabled(table: TomlTable | null): boolean {
  if (table === null) return false;
  const features = table.features;
  return (
    typeof features === 'object' &&
    features !== null &&
    !Array.isArray(features) &&
    !(features instanceof Date) &&
    features.hooks === true
  );
}

function codexManagedTomlBlock(): string {
  return `${CODEX_TOML_MARKER_START}\n${codexTomlSnippet()}\n${CODEX_TOML_MARKER_END}`;
}

function codexTomlOwnedRemovalRange(
  raw: string,
  block: CodexTomlMarkerBlock
): CodexTomlMarkerBlock {
  let start = block.start;
  if (start > 0 && raw[start - 1] === '\n') {
    start -= start > 1 && raw[start - 2] === '\r' ? 2 : 1;
  }

  let end = block.end;
  if (raw.slice(end, end + 2) === '\r\n') end += 2;
  else if (raw[end] === '\n') end += 1;
  return { start, end };
}

function joinCodexTomlSeam(before: string, after: string): string {
  if (before === '' || after === '') return before + after;
  const trailing = before.match(/(?:\r?\n)+$/)?.[0] ?? '';
  const leading = after.match(/^(?:\r?\n)+/)?.[0] ?? '';
  if (trailing === '' || leading === '') return before + after;
  return `${before.slice(0, -trailing.length)}\n\n${after.slice(leading.length)}`;
}

export async function readCodexTomlState(
  configPath = codexConfigTomlPath()
): Promise<CodexTomlState> {
  const p = configPath;
  const pathState = await inspectUserConfigPath(p);
  let raw: string | null = null;
  const readStatus: CodexTomlState['readStatus'] = pathState.status;
  let readError = pathState.status === 'unreadable' ? pathState.message : undefined;
  if (pathState.status === 'ok') {
    try {
      raw = await readFile(pathState.writePath, 'utf8');
    } catch (error) {
      readError = errorMessage(error);
    }
  }
  if (raw === null) {
    return {
      path: p,
      resolvedPath: pathState.status === 'ok' ? pathState.writePath : null,
      mode: pathState.status === 'ok' ? pathState.mode : null,
      readStatus: readStatus === 'ok' ? 'unreadable' : readStatus,
      symlink: pathState.symlink,
      ...(readError ? { readError } : {}),
      raw,
      installed: false,
      markerBlock: false,
      markerBlockBroken: false,
      markerProblemLines: [],
      collision: false,
      gateMissing: false,
    };
  }
  const markerState = codexTomlMarkerState(raw);
  const ownedBlock = markerState.block;
  const markerBlock = ownedBlock !== null;
  const outside = ownedBlock ? raw.slice(0, ownedBlock.start) + raw.slice(ownedBlock.end) : raw;
  const parsedOutside = parseCodexToml(outside);
  const collision =
    parsedOutside === null ||
    hasOwnTomlKey(parsedOutside, 'features') ||
    hasOwnTomlKey(parsedOutside, 'hooks');
  const installed = raw.includes(SESSION_HOOK_COMMAND);
  const gateMissing = installed && !codexHooksFeatureEnabled(parseCodexToml(raw));
  const markerBlockBroken =
    ownedBlock !== null &&
    (!raw.slice(ownedBlock.start, ownedBlock.end).includes(SESSION_HOOK_COMMAND) || gateMissing);
  return {
    path: p,
    resolvedPath: pathState.status === 'ok' ? pathState.writePath : null,
    mode: pathState.status === 'ok' ? pathState.mode : null,
    readStatus,
    symlink: pathState.symlink,
    raw,
    installed,
    markerBlock,
    markerBlockBroken,
    markerProblemLines: markerState.problemLines,
    collision,
    gateMissing,
  };
}

export type UserSessionHookSurfaceState =
  | 'installed'
  | 'absent'
  | 'invalid-json'
  | 'registered-but-broken'
  | 'registered-but-missing'
  | 'registered-unverified'
  | 'registered-unsupported';

export interface UserSessionHookSurfaceHealth {
  agent: SupportedAgentId;
  path: string;
  state: UserSessionHookSurfaceState;
  remedy?: string;
  recorded: boolean;
  owned: boolean;
}

function userSessionHookInstallRemedy(agent: SupportedAgentId): string {
  const managedMode = agent === ('codex' as SupportedAgentId) ? ' and choose managed mode' : '';
  return `Run \`orcaops session-hooks install --agents ${agent}\`${managedMode} to repair the registration.`;
}

export async function evaluateUserSessionHookSurfaces(
  record: UserHooksRecord | null
): Promise<UserSessionHookSurfaceHealth[]> {
  const rows: UserSessionHookSurfaceHealth[] = [];
  const recordedEntries = record?.entries ?? [];
  const isRecorded = (agent: SupportedAgentId, targetPath: string): boolean =>
    recordedEntries.some((entry) => entry.agent === agent && entry.path === targetPath);

  const codexAgent = 'codex' as SupportedAgentId;
  const codexPaths = [
    codexConfigTomlPath(),
    ...recordedEntries.filter((entry) => entry.agent === codexAgent).map((entry) => entry.path),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  for (const configPath of codexPaths) {
    const codex = await readCodexTomlState(configPath);
    const recorded = isRecorded(codexAgent, configPath);
    const owned = codex.installed || codex.markerBlock || codex.markerProblemLines.length > 0;
    let state: UserSessionHookSurfaceState;
    let remedy: string | undefined;
    if (codex.readStatus === 'unreadable') {
      state = 'registered-unverified';
      remedy = `${codex.readError ?? `${configPath} could not be verified`} — retry after restoring access`;
    } else if (codex.markerProblemLines.length > 0) {
      state = 'registered-but-broken';
      remedy = codexMarkerLineGuidance(codex.path, codex.markerProblemLines);
    } else if (codex.markerBlockBroken || codex.gateMissing) {
      state = 'registered-but-broken';
      remedy = userSessionHookInstallRemedy(codexAgent);
    } else if (codex.installed) {
      state = 'installed';
    } else if (recorded) {
      state = 'registered-but-missing';
      remedy = userSessionHookInstallRemedy(codexAgent);
    } else {
      state = 'absent';
    }
    rows.push({ agent: codexAgent, path: codex.path, state, remedy, recorded, owned });
  }

  const jsonTargets = [
    ...userHookCapableAgents()
      .map((agent) => ({ agent, path: resolveUserHookPath(agent) }))
      .filter((entry): entry is { agent: SupportedAgentId; path: string } => entry.path !== null),
    ...recordedEntries.filter(
      (entry) => entry.agent !== codexAgent && resolveUserHookPath(entry.agent) !== null
    ),
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) => candidate.agent === entry.agent && candidate.path === entry.path
      ) === index
  );
  for (const target of jsonTargets) {
    const recorded = isRecorded(target.agent, target.path);
    const file = await readUserFile(target.path);
    let state: UserSessionHookSurfaceState;
    let remedy: string | undefined;
    let owned = false;
    if (file.status === 'unreadable') {
      state = 'registered-unverified';
      remedy = `${file.message} — retry after restoring access`;
    } else if (file.status === 'absent') {
      state = recorded ? 'registered-but-missing' : 'absent';
      if (recorded) remedy = userSessionHookInstallRemedy(target.agent);
    } else {
      owned = file.raw.includes(SESSION_HOOK_COMMAND);
      try {
        JSON.parse(file.raw);
        state = owned ? 'installed' : recorded ? 'registered-but-missing' : 'absent';
        if (state === 'registered-but-missing') {
          remedy = userSessionHookInstallRemedy(target.agent);
        }
      } catch {
        state = 'invalid-json';
      }
    }
    rows.push({ ...target, state, remedy, recorded, owned });
  }

  for (const entry of recordedEntries) {
    if (rows.some((row) => row.agent === entry.agent && row.path === entry.path)) continue;
    rows.push({
      agent: entry.agent,
      path: entry.path,
      state: 'registered-unsupported',
      remedy:
        `Registered for ${entry.agent}, but this CLI version has no user-level surface for it — ` +
        'run `orcaops session-hooks install` to re-register or `orcaops session-hooks uninstall` to clear the record.',
      recorded: true,
      owned: false,
    });
  }

  return rows;
}

/**
 * Managed mode appends a new block or rewrites the contents of an existing
 * structurally valid owned block. Content outside the block is never edited.
 */
export interface WriteCodexTomlBlockOptions {
  configPath?: string;
  beforeWrite?: () => Promise<void>;
}

function codexTomlWriteGuard(state: CodexTomlState): UserConfigWriteOptions {
  return {
    expectedContent: state.raw,
    ...(state.resolvedPath === null || state.mode === null
      ? {}
      : { resolvedPath: state.resolvedPath, mode: state.mode }),
    changedMessage: 'config.toml changed while editing — re-run',
  };
}

export async function writeCodexTomlBlock(
  options: WriteCodexTomlBlockOptions = {}
): Promise<
  'written' | 'unchanged' | 'refused-collision' | 'refused-markers' | 'refused-unreadable'
> {
  const state = await readCodexTomlState(options.configPath);
  if (state.readStatus === 'unreadable') return 'refused-unreadable';
  if (state.markerProblemLines.length > 0) return 'refused-markers';
  // A config already carrying the registration needs no write at all, so this
  // precedes the collision guard — which only gates an APPEND. The recommended
  // manual paste defines the root feature/hook tables itself, so it reads as a
  // collision, and refusing here told users their working config was invalid
  // and handed them the snippet to paste a second time.
  if (!state.markerBlock && state.installed) return 'unchanged';
  if (state.collision) return 'refused-collision';
  if (state.markerBlock && state.raw !== null) {
    const ownedBlock = codexTomlMarkerState(state.raw).block;
    if (ownedBlock === null) return 'refused-markers';
    const currentBlock = state.raw.slice(ownedBlock.start, ownedBlock.end);
    const desiredBlock = codexManagedTomlBlock();
    if (currentBlock !== desiredBlock) {
      await options.beforeWrite?.();
      await writeUserConfigFile(
        state.path,
        state.raw.slice(0, ownedBlock.start) + desiredBlock + state.raw.slice(ownedBlock.end),
        codexTomlWriteGuard(state)
      );
      return 'written';
    }
    return 'unchanged';
  }
  const block = `${codexManagedTomlBlock()}\n`;
  const next = state.raw === null || state.raw.trim() === '' ? block : `${state.raw}\n${block}`;
  await options.beforeWrite?.();
  await writeUserConfigFile(state.path, next, codexTomlWriteGuard(state));
  return 'written';
}

/**
 * Remove ONLY a marker-owned block. Manual pastes (no markers) are the
 * user's content — reported, never edited.
 */
export async function removeCodexTomlBlock(
  configPath?: string,
  beforeWrite?: () => Promise<void>
): Promise<'removed' | 'manual-content' | 'absent' | 'refused-markers' | 'unreadable'> {
  const state = await readCodexTomlState(configPath);
  if (state.readStatus === 'unreadable') return 'unreadable';
  if (state.raw === null) return 'absent';
  if (state.markerProblemLines.length > 0) return 'refused-markers';
  if (state.markerBlock) {
    const block = codexTomlMarkerState(state.raw).block;
    if (block === null) return 'refused-markers';
    const owned = codexTomlOwnedRemovalRange(state.raw, block);
    const next = joinCodexTomlSeam(state.raw.slice(0, owned.start), state.raw.slice(owned.end));
    const guard = codexTomlWriteGuard(state);
    await beforeWrite?.();
    if (next.trim() === '') {
      if (state.symlink) {
        await writeUserConfigFile(state.path, next, guard);
      } else if (state.resolvedPath !== null) {
        await assertUserConfigPreImage(state.path, state.resolvedPath, guard);
        await rm(state.resolvedPath, { force: true });
      }
    } else {
      await writeUserConfigFile(state.path, next, guard);
    }
    return 'removed';
  }
  if (!state.installed) return 'absent';
  return 'manual-content';
}
