import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, type TomlTable, type TomlValue } from 'smol-toml';

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
    | 'preserved-invalid'
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
// Codex loads hooks from both $CODEX_HOME/hooks.json and config.toml, and
// hooks are on by default since 0.124, so the registration is one
// `[[hooks.SessionStart]]` table and nothing else. config.toml stays the
// surface because it is the one validated end to end and already carries
// every existing registration. It is also the user's PRIMARY Codex config, so
// orcaops never TOML-round-trips it: install appends one marker-delimited
// block and proves the result parses; uninstall removes the block and proves
// the parsed file lost exactly our registration. Codex itself appends its
// hook-trust tables after the last key in the file, which lands them INSIDE
// the fence whenever the fence is last — foreign lines between the markers
// are expected and never rewritten.

export const CODEX_TOML_MARKER_START = '# >>> orcaops session-hooks >>>';
export const CODEX_TOML_MARKER_END = '# <<< orcaops session-hooks <<<';

const CODEX_TOML_MATCHER = 'startup|resume';

export function codexMarkerLineGuidance(file: string, lines: number[]): string {
  return `${file} has malformed or duplicate orcaops marker lines (${lines.join(', ')}); remove those complete lines, then re-run the command`;
}

export function codexInvalidTomlGuidance(file: string): string {
  return `${file} is not valid TOML outside the orcaops block — fix it, then re-run`;
}

export function codexHooksShapeGuidance(file: string): string {
  return `${file} already defines hooks.SessionStart in a form orcaops cannot append to — merge this entry manually`;
}

export function codexFenceGuidance(file: string): string {
  return `${file} has lines inside the orcaops block that orcaops did not write — move them outside the markers, then re-run`;
}

export function codexHooksDisabledGuidance(file: string): string {
  return `${file} sets features.hooks (or codex_hooks) = false, so Codex runs no hook; set it to true`;
}

export function codexConfigTomlPath(): string {
  const home = resolveUserHookHome('codex' as SupportedAgentId);
  return home ? path.join(home, 'config.toml') : path.join(os.homedir(), '.codex', 'config.toml');
}

export const CODEX_HOOKS_JSON_NOTE =
  'Codex will report loading hooks from both hooks.json and config.toml at startup; that is informational — both sets run.';

/**
 * The dual-representation note when `<codex home>/hooks.json` is a file
 * (another tool's, e.g. Superset). Existence only — never parsed, never
 * written; a directory or dangling symlink counts as absent.
 */
export async function codexHooksJsonNote(): Promise<string | null> {
  const home = resolveUserHookHome('codex' as SupportedAgentId);
  if (!home) return null;
  try {
    return (await stat(path.join(home, 'hooks.json'))).isFile() ? CODEX_HOOKS_JSON_NOTE : null;
  } catch {
    return null;
  }
}

function codexHookCommand(): string {
  return canonicalSessionHookCommand('codex' as SupportedAgentId, { user: true });
}

/** The exact TOML the registration needs — printed for manual paste and written by managed mode. */
export function codexTomlSnippet(): string {
  return [
    '[[hooks.SessionStart]]',
    `matcher = "${CODEX_TOML_MATCHER}"`,
    `hooks = [{ type = "command", command = "${codexHookCommand()}" }]`,
  ].join('\n');
}

function codexManagedTomlBlock(eol: string): string {
  return [CODEX_TOML_MARKER_START, ...codexTomlSnippet().split('\n'), CODEX_TOML_MARKER_END].join(
    eol
  );
}

function codexTomlEol(raw: string): string {
  return raw.includes('\r\n') ? '\r\n' : '\n';
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
  /**
   * The file does not parse as TOML: `outside` the block (or with no block),
   * or only once the block's own lines are read with it.
   */
  parseFailure: 'outside' | 'fence' | null;
  /** The canonical `--user` command is registered under hooks.SessionStart, inside or outside the block. */
  installed: boolean;
  /** A marker-delimited orcaops block exists (managed mode owns it). */
  markerBlock: boolean;
  /** The block exists but registers nothing (stale command or gutted). */
  markerBlockBroken: boolean;
  /** Lines containing inverted, orphaned, or duplicate marker lines. */
  markerProblemLines: number[];
  /** `[features]` turns Codex hooks off, so a registration runs nothing. */
  hooksDisabled: boolean;
}

interface CodexTomlMarkerBlock {
  start: number;
  end: number;
}

interface CodexTomlLine {
  start: number;
  line: number;
  /** Line content without its terminator (a CR before the LF is dropped too). */
  text: string;
}

interface CodexTomlMarkerState {
  block: CodexTomlMarkerBlock | null;
  problemLines: number[];
}

function codexTomlLines(raw: string): CodexTomlLine[] {
  const lines: CodexTomlLine[] = [];
  let start = 0;
  let line = 1;
  while (start <= raw.length) {
    const newline = raw.indexOf('\n', start);
    const end = newline === -1 ? raw.length : newline;
    lines.push({ start, line, text: raw.slice(start, end).replace(/\r$/, '') });
    if (newline === -1) break;
    start = newline + 1;
    line += 1;
  }
  return lines;
}

function codexTomlMarkerState(raw: string): CodexTomlMarkerState {
  const lines = codexTomlLines(raw);
  const starts = lines.filter((entry) => entry.text === CODEX_TOML_MARKER_START);
  const ends = lines.filter((entry) => entry.text === CODEX_TOML_MARKER_END);
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

function textOutsideCodexFence(raw: string, block: CodexTomlMarkerBlock): string {
  return raw.slice(0, block.start) + raw.slice(block.end);
}

function parseCodexToml(raw: string): TomlTable | null {
  try {
    return parseToml(raw);
  } catch {
    return null;
  }
}

function tomlTable(value: unknown): TomlTable | null {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
    ? (value as TomlTable)
    : null;
}

function hasOwnTomlKey(table: TomlTable, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function codexSessionStartEntries(table: TomlTable | null): TomlValue[] {
  const entries = tomlTable(table?.hooks)?.SessionStart;
  return Array.isArray(entries) ? entries : [];
}

// Ownership inside the markers is deliberately wider than registration: any
// entry whose command contains the hook command counts as ours, so a stale or
// hand-edited variant of our line is still repaired and removed. A user's own
// orcaops-invoking hook belongs outside the markers.
function isOrcaopsHookEntry(value: unknown): boolean {
  const hook = tomlTable(value);
  return (
    hook !== null &&
    Object.keys(hook).every((key) => key === 'type' || key === 'command') &&
    (hook.type === undefined || hook.type === 'command') &&
    typeof hook.command === 'string' &&
    hook.command.includes(SESSION_HOOK_COMMAND)
  );
}

/** Our SessionStart element, or what a stale command or a gutted line left of one. */
function isOrcaopsSessionStartElement(value: unknown): boolean {
  const element = tomlTable(value);
  return (
    element !== null &&
    Object.keys(element).every((key) => key === 'matcher' || key === 'hooks') &&
    (element.matcher === undefined || element.matcher === CODEX_TOML_MATCHER) &&
    (element.hooks === undefined ||
      (Array.isArray(element.hooks) && element.hooks.every(isOrcaopsHookEntry)))
  );
}

function countCodexRegistrations(table: TomlTable | null): number {
  const command = codexHookCommand();
  return codexSessionStartEntries(table).reduce<number>((count, entry) => {
    const hooks = tomlTable(entry)?.hooks;
    return (
      count +
      (Array.isArray(hooks)
        ? hooks.filter((hook) => tomlTable(hook)?.command === command).length
        : 0)
    );
  }, 0);
}

// `hooks` wins over its retired alias `codex_hooks` when both are set.
function codexHooksDisabled(table: TomlTable | null): boolean {
  const features = tomlTable(table?.features);
  if (features === null) return false;
  if (hasOwnTomlKey(features, 'hooks')) return features.hooks === false;
  return features.codex_hooks === false;
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

function joinCodexTomlSeam(before: string, after: string, eol: string): string {
  if (before === '' || after === '') return before + after;
  const trailing = before.match(/(?:\r?\n)+$/)?.[0] ?? '';
  const leading = after.match(/^(?:\r?\n)+/)?.[0] ?? '';
  if (trailing === '' || leading === '') return before + after;
  return `${before.slice(0, -trailing.length)}${eol}${eol}${after.slice(leading.length)}`;
}

/**
 * A line inside the block that orcaops wrote, recognised by what it parses
 * to rather than by its bytes. Blocks written before the snippet dropped its
 * `[features]` gate carry two extra lines; the header is only ours when
 * nothing else still hangs under it, so callers try both readings.
 */
function isCodexTomlOwnedLine(text: string, includeLegacyHeader: boolean): boolean {
  if (text === CODEX_TOML_MARKER_START || text === CODEX_TOML_MARKER_END) return true;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return false;
  const parsed = parseCodexToml(text);
  if (parsed === null) return false;
  if (isDeepStrictEqual(parsed, { hooks: { SessionStart: [{}] } })) return true;
  if (isDeepStrictEqual(parsed, { matcher: CODEX_TOML_MATCHER })) return true;
  if (isDeepStrictEqual(parsed, { hooks: true })) return true;
  if (includeLegacyHeader && isDeepStrictEqual(parsed, { features: {} })) return true;
  return (
    Object.keys(parsed).length === 1 &&
    Array.isArray(parsed.hooks) &&
    parsed.hooks.length > 0 &&
    parsed.hooks.every(isOrcaopsHookEntry)
  );
}

function codexTomlRemovalCandidates(raw: string, block: CodexTomlMarkerBlock): string[] {
  const owned = codexTomlOwnedRemovalRange(raw, block);
  const before = raw.slice(0, owned.start);
  const after = raw.slice(owned.end);
  const eol = codexTomlEol(raw);
  const verbatim = joinCodexTomlSeam(before, after, eol);
  const fenceLines = codexTomlLines(raw.slice(owned.start, owned.end));
  // A comment or foreign line inside the fence is invisible to the parse
  // proof, so dropping the whole span would pass it and still lose the line.
  const holdsForeignLines = fenceLines.some(
    (entry) => entry.text.trim() !== '' && !isCodexTomlOwnedLine(entry.text, true)
  );
  const withoutOwnedLines = (includeLegacyHeader: boolean): string => {
    const kept = fenceLines
      .filter((entry) => !isCodexTomlOwnedLine(entry.text, includeLegacyHeader))
      .map((entry) => entry.text);
    while (kept.length > 0 && kept[0].trim() === '') kept.shift();
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    if (kept.length === 0) return verbatim;
    const joined = [
      before.replace(/(?:\r?\n)+$/, ''),
      kept.join(eol),
      after.replace(/^(?:\r?\n)+/, ''),
    ]
      .filter((part) => part !== '')
      .join(`${eol}${eol}`);
    return joined.endsWith('\n') || !/\r?\n$/.test(raw) ? joined : `${joined}${eol}`;
  };
  const lineLevel = [withoutOwnedLines(true), withoutOwnedLines(false)];
  return holdsForeignLines ? lineLevel : [verbatim, ...lineLevel];
}

function chooseIndexes(indexes: number[], count: number): number[][] {
  if (count === 0) return [[]];
  return indexes.flatMap((index, position) =>
    chooseIndexes(indexes.slice(position + 1), count - 1).map((rest) => [index, ...rest])
  );
}

/**
 * Every parse the file may legitimately have once the block's own content is
 * gone: as many of our SessionStart elements dropped as the block contributed
 * (identical elements can sit at more than one index, so each choice is a
 * candidate) and, for a block that introduced the retired `[features]` gate,
 * `features.hooks = true` dropped with it. Empty containers go with their
 * last key. Anything else in the parse — a user's element, Codex's trust
 * tables, a toggle Codex appended under our header — must survive unchanged.
 */
function codexTomlWithoutOwnedContent(parsed: TomlTable, outside: TomlTable): TomlTable[] {
  const entries = codexSessionStartEntries(parsed);
  const ownIndexes = entries.flatMap((entry, index) =>
    isOrcaopsSessionStartElement(entry) ? [index] : []
  );
  const ownOutside = codexSessionStartEntries(outside).filter(isOrcaopsSessionStartElement).length;
  const removals = Math.max(0, ownIndexes.length - ownOutside);
  const legacyFeatures = tomlTable(parsed.features);
  const legacyGate = legacyFeatures !== null && !hasOwnTomlKey(outside, 'features');
  return chooseIndexes(ownIndexes, removals).map((removed) => {
    const expected: TomlTable = { ...parsed };
    const hooks = tomlTable(parsed.hooks);
    if (hooks !== null) {
      const nextHooks: TomlTable = { ...hooks };
      const remaining = entries.filter((_, index) => !removed.includes(index));
      if (remaining.length > 0) nextHooks.SessionStart = remaining;
      else delete nextHooks.SessionStart;
      if (Object.keys(nextHooks).length > 0) expected.hooks = nextHooks;
      else delete expected.hooks;
    }
    if (legacyGate && legacyFeatures !== null) {
      const nextFeatures: TomlTable = { ...legacyFeatures };
      if (nextFeatures.hooks === true) delete nextFeatures.hooks;
      if (Object.keys(nextFeatures).length > 0) expected.features = nextFeatures;
      else delete expected.features;
    }
    return expected;
  });
}

export type CodexTomlRemovalPlan =
  | { outcome: 'removed'; next: string }
  | {
      outcome:
        | 'absent'
        | 'manual-content'
        | 'refused-markers'
        | 'refused-invalid'
        | 'refused-fence';
    };

/**
 * Remove the orcaops block and prove nothing else moved: the whole span first,
 * then only the lines orcaops wrote when Codex or the user left something
 * inside the markers. A removal counts only when the parsed result equals the
 * parsed original minus our registration; otherwise the file stays as it is.
 */
export function planCodexTomlRemoval(raw: string): CodexTomlRemovalPlan {
  const markers = codexTomlMarkerState(raw);
  if (markers.problemLines.length > 0) return { outcome: 'refused-markers' };
  const parsed = parseCodexToml(raw);
  if (markers.block === null) {
    // With no fence there is nothing orcaops may edit, so the only question is
    // whether the user has content to clean up themselves: a parsed
    // registration, or — when the file does not parse — any mention of the
    // command, since a broken file cannot be read for a registration.
    const manualContent =
      parsed === null ? raw.includes(SESSION_HOOK_COMMAND) : countCodexRegistrations(parsed) > 0;
    return { outcome: manualContent ? 'manual-content' : 'absent' };
  }
  const outside = parseCodexToml(textOutsideCodexFence(raw, markers.block));
  if (outside === null) return { outcome: 'refused-invalid' };
  if (parsed === null) return { outcome: 'refused-fence' };
  const expected = codexTomlWithoutOwnedContent(parsed, outside);
  for (const next of codexTomlRemovalCandidates(raw, markers.block)) {
    const result = parseCodexToml(next);
    if (result !== null && expected.some((table) => isDeepStrictEqual(result, table))) {
      return { outcome: 'removed', next };
    }
  }
  return { outcome: 'refused-fence' };
}

export type CodexTomlInstallPlan =
  | { outcome: 'written'; next: string }
  | {
      outcome:
        | 'unchanged'
        | 'refused-markers'
        | 'refused-invalid'
        | 'refused-hooks-shape'
        | 'refused-fence';
    };

/**
 * Append the block and prove the result parses with exactly one registration.
 * A file that already registers the command anywhere — fenced or pasted,
 * whatever else sits between the markers — is left byte-for-byte alone. A
 * block that registers nothing (stale command, gutted lines) is removed by
 * the uninstall proof first, then appended fresh.
 */
export function planCodexTomlInstall(raw: string | null): CodexTomlInstallPlan {
  if (raw === null || raw.trim() === '') {
    return { outcome: 'written', next: `${codexManagedTomlBlock('\n')}\n` };
  }
  const markers = codexTomlMarkerState(raw);
  if (markers.problemLines.length > 0) return { outcome: 'refused-markers' };
  const parsed = parseCodexToml(raw);
  if (parsed !== null && countCodexRegistrations(parsed) > 0) return { outcome: 'unchanged' };
  const outside = markers.block === null ? raw : textOutsideCodexFence(raw, markers.block);
  if (parseCodexToml(outside) === null) return { outcome: 'refused-invalid' };
  let base = raw;
  if (markers.block !== null) {
    const repair = planCodexTomlRemoval(raw);
    if (repair.outcome !== 'removed') return { outcome: 'refused-fence' };
    base = repair.next;
  }
  const eol = codexTomlEol(raw);
  const block = `${codexManagedTomlBlock(eol)}${eol}`;
  const next = base.trim() === '' ? block : `${base}${eol}${block}`;
  const candidate = parseCodexToml(next);
  if (candidate === null || countCodexRegistrations(candidate) !== 1) {
    return { outcome: 'refused-hooks-shape' };
  }
  return { outcome: 'written', next };
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
      parseFailure: null,
      installed: false,
      markerBlock: false,
      markerBlockBroken: false,
      markerProblemLines: [],
      hooksDisabled: false,
    };
  }
  const markerState = codexTomlMarkerState(raw);
  const block = markerState.block;
  const parsed = parseCodexToml(raw);
  const outside = block === null ? parsed : parseCodexToml(textOutsideCodexFence(raw, block));
  const parseFailure = outside === null ? 'outside' : parsed === null ? 'fence' : null;
  const installed = parsed !== null && countCodexRegistrations(parsed) > 0;
  const blockRegisters =
    block !== null &&
    parsed !== null &&
    outside !== null &&
    countCodexRegistrations(parsed) > countCodexRegistrations(outside);
  return {
    path: p,
    resolvedPath: pathState.status === 'ok' ? pathState.writePath : null,
    mode: pathState.status === 'ok' ? pathState.mode : null,
    readStatus,
    symlink: pathState.symlink,
    raw,
    parseFailure,
    installed,
    markerBlock: block !== null,
    markerBlockBroken: block !== null && parseFailure === null && !blockRegisters,
    markerProblemLines: markerState.problemLines,
    hooksDisabled: codexHooksDisabled(parsed),
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
    // A file that no longer parses cannot be read for a registration, so a
    // pasted command that broke later is only recognisable by its text.
    const brokenPaste =
      codex.parseFailure !== null && codex.raw !== null && codex.raw.includes(SESSION_HOOK_COMMAND);
    const owned =
      codex.installed || codex.markerBlock || codex.markerProblemLines.length > 0 || brokenPaste;
    let state: UserSessionHookSurfaceState;
    let remedy: string | undefined;
    if (codex.readStatus === 'unreadable') {
      state = 'registered-unverified';
      remedy = `${codex.readError ?? `${configPath} could not be verified`} — retry after restoring access`;
    } else if (codex.markerProblemLines.length > 0) {
      state = 'registered-but-broken';
      remedy = codexMarkerLineGuidance(codex.path, codex.markerProblemLines);
    } else if (codex.parseFailure !== null) {
      state = 'registered-but-broken';
      remedy =
        codex.parseFailure === 'fence'
          ? codexFenceGuidance(codex.path)
          : codexInvalidTomlGuidance(codex.path);
    } else if (codex.markerBlockBroken) {
      state = 'registered-but-broken';
      remedy = userSessionHookInstallRemedy(codexAgent);
    } else if (codex.installed && codex.hooksDisabled) {
      state = 'registered-but-broken';
      remedy = codexHooksDisabledGuidance(codex.path);
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

export type CodexTomlWriteOutcome =
  | Exclude<CodexTomlInstallPlan['outcome'], 'written'>
  | 'written'
  | 'refused-unreadable';

/** Managed mode: append the block, or repair a block that registers nothing. Content outside the block is never edited. */
export async function writeCodexTomlBlock(
  options: WriteCodexTomlBlockOptions = {}
): Promise<CodexTomlWriteOutcome> {
  const state = await readCodexTomlState(options.configPath);
  if (state.readStatus === 'unreadable') return 'refused-unreadable';
  const plan = planCodexTomlInstall(state.raw);
  if (plan.outcome !== 'written') return plan.outcome;
  await options.beforeWrite?.();
  await writeUserConfigFile(state.path, plan.next, codexTomlWriteGuard(state));
  return 'written';
}

export type CodexTomlRemoveOutcome = CodexTomlRemovalPlan['outcome'] | 'unreadable';

/**
 * Remove ONLY a marker-owned block, and only when the removal proves clean.
 * Manual pastes (no markers) are the user's content — reported, never edited.
 */
export async function removeCodexTomlBlock(
  configPath?: string,
  beforeWrite?: () => Promise<void>,
  mode: 'apply' | 'preview' = 'apply'
): Promise<CodexTomlRemoveOutcome> {
  const state = await readCodexTomlState(configPath);
  if (state.readStatus === 'unreadable') return 'unreadable';
  if (state.raw === null) return 'absent';
  const plan = planCodexTomlRemoval(state.raw);
  if (plan.outcome !== 'removed' || mode === 'preview') return plan.outcome;
  const guard = codexTomlWriteGuard(state);
  await beforeWrite?.();
  if (plan.next.trim() === '') {
    if (state.symlink) {
      await writeUserConfigFile(state.path, plan.next, guard);
    } else if (state.resolvedPath !== null) {
      await assertUserConfigPreImage(state.path, state.resolvedPath, guard);
      await rm(state.resolvedPath, { force: true });
    }
  } else {
    await writeUserConfigFile(state.path, plan.next, guard);
  }
  return 'removed';
}
