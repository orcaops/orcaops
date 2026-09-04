import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, type TomlTable, type TomlValue } from 'smol-toml';

import { getAgentOverlay } from '@orcaops/adapters';
import { runBoundedSubprocess } from '@orcaops/evaluator-protocol/subprocess';
import { providerBinPath } from '@orcaops/llm';
import { SUPPORTED_AGENT_IDS, type SupportedAgentId } from '@orcaops/storage';

import { atomicWriteFile } from './atomic-write.js';
import { resolveGlobalRoot } from './global-install.js';
import { getInvocationCwd, getInvocationEnv } from './invocation-context.js';
import {
  canonicalSessionHookCommand,
  isOrcaopsHook,
  isSemanticallyEmpty,
  type JsonObject,
  reconcileDocument,
  serializeSettings,
  SESSION_HOOK_COMMAND,
  type SessionHookAction,
  type SettingsSpec,
  userJsonSpecs,
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

/**
 * Absolute user JSON hook path for an agent, or null when it has no user
 * surface. Same rule as `userJsonSpecs()`: a `machine-config` row that
 * declares a `userFile` (codex's `hooks.json`) has a user-level JSON surface
 * even though it has no project one.
 */
export function resolveUserHookPath(agent: SupportedAgentId): string | null {
  const sh = getAgentOverlay(agent)?.sessionHooks;
  if (!sh || !sh.userFile) return null;
  if (sh.kind !== 'settings-json' && sh.kind !== 'machine-config') return null;
  const home = resolveUserHookHome(agent);
  return home ? path.join(home, sh.userFile) : null;
}

/** The install set the machine-level surface can carry (overlay-derived). */
export function userHookCapableAgents(): SupportedAgentId[] {
  return SUPPORTED_AGENT_IDS.filter((id) => resolveUserHookPath(id) !== null);
}

/**
 * Does a recorded codex path name the JSON surface? Codex is the one agent
 * with two representations, and a path recorded under an older CODEX_HOME
 * cannot be compared against today's, so the file NAME the overlay declares
 * is what tells the two apart.
 */
export function isCodexHooksJsonPath(candidate: string): boolean {
  const userFile = getAgentOverlay('codex')?.sessionHooks?.userFile;
  return userFile !== undefined && path.basename(candidate) === userFile;
}

export interface UserSessionHookConsentSurface {
  agent: SupportedAgentId;
  path: string;
  mode: 'reconcile' | 'managed-choice' | 'remove';
}

export interface UserSessionHookConsentPlan {
  agents: SupportedAgentId[];
  jsonAgents: SupportedAgentId[];
  codexWanted: boolean;
  /** Null when codex was not requested — nothing resolved, nothing probed. */
  representation: CodexRepresentation | null;
  surfaces: UserSessionHookConsentSurface[];
}

/**
 * THE seat of the codex representation decision: resolved once here and
 * carried on the plan, so one command probes `codex --version` at most once
 * and consent, the planners and the record can never disagree about which
 * file the registration belongs in.
 */
export async function planUserSessionHookConsent(
  requestedAgents: SupportedAgentId[],
  representationOverride?: CodexRepresentationSurface
): Promise<UserSessionHookConsentPlan> {
  const agents = [...new Set(requestedAgents)];
  const codexWanted = agents.includes('codex');
  const representation = codexWanted
    ? await resolveCodexRepresentation(representationOverride)
    : null;
  const codexOnJson = representation?.surface === 'hooks-json';
  const jsonAgents = agents.filter((agent) => agent !== 'codex' || codexOnJson);
  const surfaces = jsonAgents.flatMap((agent): UserSessionHookConsentSurface[] => {
    const settingsPath = resolveUserHookPath(agent);
    return settingsPath === null ? [] : [{ agent, path: settingsPath, mode: 'reconcile' }];
  });
  if (representation !== null && !codexOnJson) {
    surfaces.push({ agent: 'codex', path: representation.tomlPath, mode: 'managed-choice' });
  }
  if (representation !== null && codexOnJson && (await codexTomlRegistersOurs(representation))) {
    surfaces.push({ agent: 'codex', path: representation.tomlPath, mode: 'remove' });
  }
  return { agents, jsonAgents, codexWanted, representation, surfaces };
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
  const base = userJsonSpecs().find((s) => s.agent === agent);
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

/** `hooks.<eventKey>` of a settings document, or an empty array when it has none. */
function hookEventGroups(document: unknown, eventKey: string): unknown[] {
  const entries = tomlTable(tomlTable(document)?.hooks)?.[eventKey];
  return Array.isArray(entries) ? entries : [];
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

export interface CodexHooksJsonGroups {
  /** `hooks.SessionStart` as hooks.json held it before the reconcile. */
  before: unknown[];
  /** The same array as the reconcile left it — what the file now holds. */
  after: unknown[];
}

export interface PlanUserSessionHooksResult {
  plans: UserSessionHookFilePlan[];
  warnings: string[];
  /**
   * The codex hooks.json groups either side of the reconcile, present only when
   * an install reconciled that file. Codex keys hook trust by group POSITION,
   * so the config.toml trust edit needs the real before-to-after mapping.
   */
  codexGroups?: CodexHooksJsonGroups;
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

/**
 * Reconcile selected installs or strip every capable surface on uninstall.
 * `representation` is the resolved codex answer from the consent plan: codex
 * reaches the JSON reconcile only when it says `hooks-json`, so an install
 * can never write hooks.json on a resolver's behalf that never ran.
 */
export async function planUserSessionHooks(
  agents: SupportedAgentId[],
  mode: 'apply' | 'preview',
  operation: UserSessionHookPlanOperation = 'install',
  recordedEntries: readonly UserHooksRecordEntry[] = [],
  beforeWrite?: (absPath: string) => Promise<void>,
  representation: CodexRepresentation | null = null
): Promise<PlanUserSessionHooksResult> {
  const plans: UserSessionHookFilePlan[] = [];
  const warnings: string[] = [];
  let codexGroups: CodexHooksJsonGroups | undefined;
  const currentTargets = (
    operation === 'uninstall'
      ? userHookCapableAgents()
      : [...new Set(agents)].filter(
          (agent) => agent !== 'codex' || representation?.surface === 'hooks-json'
        )
  )
    .map((agent) => ({ agent, path: resolveUserHookPath(agent) }))
    .filter((entry): entry is { agent: SupportedAgentId; path: string } => entry.path !== null);
  const targets = [
    ...currentTargets,
    ...(operation === 'uninstall'
      ? // A recorded codex path is only ours to reconcile as JSON when it
        // names the sidecar; config.toml has its own marker-proof remover.
        recordedEntries.filter(
          (entry) =>
            resolveUserHookPath(entry.agent) !== null &&
            (entry.agent !== 'codex' || isCodexHooksJsonPath(entry.path))
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
    // `parsed` is never reconciled in place, so its array is the true before.
    const recordCodexGroups = (before: unknown, after: unknown): void => {
      if (agent === 'codex' && desired && isCodexHooksJsonPath(spec.path)) {
        codexGroups = {
          before: hookEventGroups(before, spec.eventKey),
          after: hookEventGroups(after, spec.eventKey),
        };
      }
    };
    const file = await readUserFile(spec.path);

    if (file.status === 'absent') {
      if (!desired) {
        if (recorded) plans.push({ agent, path: spec.path, action: 'absent' });
        continue;
      }
      const root: JsonObject = structuredClone(spec.seed);
      reconcileDocument(root, spec, spec.desired);
      recordCodexGroups(spec.seed, root);
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
    recordCodexGroups(parsed, root);

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

  return { plans, warnings, codexGroups };
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
 * Does `<codex home>/hooks.json` hold hooks Codex loads? Read-only: an absent
 * file, a directory, one that does not parse, and one with no hook entries all
 * answer no — existence alone is not a second representation.
 */
export async function codexHooksJsonCarriesHooks(): Promise<boolean> {
  try {
    const hooksJsonPath = codexHooksJsonPath();
    if (!(await stat(hooksJsonPath)).isFile()) return false;
    const parsed: unknown = JSON.parse(await readFile(hooksJsonPath, 'utf8'));
    return countCodexHookEntries(tomlTable(parsed)) > 0;
  } catch {
    return false;
  }
}

/**
 * The note for a layer that really carries two representations: hooks in
 * hooks.json AND hooks in config.toml. Codex prints its "loading hooks from
 * both" line whoever owns the entries, so another tool's hooks.json beside our
 * config.toml block still earns it — while a machine whose registration has
 * moved into hooks.json alone runs one representation and gets none.
 */
export async function codexDualRepresentationNote(): Promise<string | null> {
  if (!(await codexHooksJsonCarriesHooks())) return null;
  const toml = await readCodexTomlState();
  if (toml.raw === null) return null;
  return countCodexHookEntries(parseCodexToml(toml.raw)) > 0 ? CODEX_HOOKS_JSON_NOTE : null;
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

// Codex representation resolver.
//
// Codex loads hooks from BOTH `$CODEX_HOME/hooks.json` and config.toml and
// says so at startup ("prefer a single representation for this layer"), so
// orcaops registers in exactly one of them. hooks.json is the better home —
// it is plain JSON the shared reconcile already understands, and it is not
// the file Codex appends its own trust tables to — but only builds new enough
// to load the sidecar may be sent there.

export type CodexRepresentationSurface = 'hooks-json' | 'config-toml';

export type CodexRepresentationReason =
  | 'version-unsupported'
  | 'version-unknown'
  | 'existing-hooks-json'
  | 'existing-toml-hooks'
  | 'toml-unreadable'
  | 'default'
  | 'override';

export type CodexVersionGate = 'supported' | 'unsupported' | 'unknown';

export interface CodexRepresentation {
  surface: CodexRepresentationSurface;
  reason: CodexRepresentationReason;
  hooksJsonPath: string;
  tomlPath: string;
  /** The gate's verdict, reported even when an override bypassed it. */
  versionGate: CodexVersionGate;
}

/**
 * The lowest codex-cli build MEASURED to load a hooks.json hook (0.146.0,
 * 0.146.1 and 0.147.0 were the builds available to measure). Codex's own docs
 * date the hooks.json sidecar to 0.114, and two upstream issues report the
 * sidecar not firing, so the documented floor is not evidence. Gating on the
 * measured one costs a user on an older build only the informational
 * dual-representation warning they already get; a lower bound that turns out
 * to be wrong costs them the hook itself, silently.
 */
export const CODEX_HOOKS_JSON_MIN_VERSION = '0.146.0';

const CODEX_VERSION_PROBE_TIMEOUT_MS = 5_000;
const CODEX_VERSION_PROBE_MAX_OUTPUT_BYTES = 8 * 1024;

/** `codex --version` stdout, or null when the probe could not answer. */
export type CodexVersionProbe = () => Promise<string | null>;

export function codexHooksJsonPath(): string {
  return (
    resolveUserHookPath('codex' as SupportedAgentId) ??
    path.join(os.homedir(), '.codex', 'hooks.json')
  );
}

async function probeCodexVersionOutput(): Promise<string | null> {
  const invocationEnv = getInvocationEnv();
  const result = await runBoundedSubprocess({
    argv: [providerBinPath('codex', invocationEnv), '--version'],
    cwd: getInvocationCwd(),
    env: Object.fromEntries(
      Object.entries(invocationEnv).filter(([, value]) => value !== undefined)
    ) as Record<string, string>,
    timeoutMs: CODEX_VERSION_PROBE_TIMEOUT_MS,
    maxOutputBytes: CODEX_VERSION_PROBE_MAX_OUTPUT_BYTES,
  });
  const answered =
    result.spawn_error === null && result.killed_reason === null && result.exit_code === 0;
  return answered ? result.stdout : null;
}

function parseCodexVersion(output: string | null): [number, number, number] | null {
  const match = output?.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/) ?? null;
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function meetsCodexHooksJsonFloor(version: [number, number, number]): boolean {
  const floor = CODEX_HOOKS_JSON_MIN_VERSION.split('.').map(Number);
  for (const [index, part] of version.entries()) {
    if (part !== floor[index]) return part > floor[index];
  }
  return true;
}

/** A regular hooks.json holding a JSON object — the file we can join. */
async function codexHooksJsonHoldsObject(hooksJsonPath: string): Promise<boolean> {
  try {
    if (!(await stat(hooksJsonPath)).isFile()) return false;
    const parsed: unknown = JSON.parse(await readFile(hooksJsonPath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Hook entries under `hooks.<Event>`, ours included. Every array element counts
 * (a group contributes its inner hooks, any other shape counts as one), so a
 * user's own hooks are recognised whichever schema they wrote them in;
 * `hooks.state`, Codex's own trust bookkeeping, is a table rather than an array
 * and never counts. The grouped shape is the same in config.toml and in
 * hooks.json, so a parsed document of either kind can be counted here.
 */
function countCodexHookEntries(table: TomlTable | null): number {
  const hooks = tomlTable(table?.hooks);
  if (hooks === null) return 0;
  let total = 0;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const inner = tomlTable(entry)?.hooks;
      total += Array.isArray(inner) ? inner.length : 1;
    }
  }
  return total;
}

/** Hook entries under `hooks.<Event>` that are not our canonical registration. */
function countForeignCodexHookEntries(table: TomlTable | null): number {
  return countCodexHookEntries(table) - countCodexRegistrations(table);
}

type CodexTomlHooksOwnership = 'foreign' | 'ours-or-none' | 'unreadable';

async function inspectCodexTomlHooks(tomlPath: string): Promise<CodexTomlHooksOwnership> {
  let raw: string;
  try {
    raw = await readFile(tomlPath, 'utf8');
  } catch (error) {
    // No config.toml at all is not a reason to stay in it; anything else is,
    // because a file we cannot read may register hooks we cannot see.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ours-or-none' : 'unreadable';
  }
  const parsed = parseCodexToml(raw);
  if (parsed === null) return 'unreadable';
  return countForeignCodexHookEntries(parsed) > 0 ? 'foreign' : 'ours-or-none';
}

/**
 * Which file codex's registration belongs in. Join whatever already exists,
 * else create hooks.json:
 *
 *  1. an override answers directly, but still reports what the gate found;
 *  2. a build below the measured floor (or a probe that could not answer)
 *     stays on config.toml, the surface validated on every build measured;
 *  3. a hooks.json holding a JSON object is joined;
 *  4. a config.toml carrying hooks that are not ours keeps the registration
 *     beside them (as does one we cannot read or parse);
 *  5. otherwise hooks.json is created.
 *
 * Never throws: a probe that rejects reads as "could not answer", and every
 * file inspection degrades to leaving us where we already are.
 */
export async function resolveCodexRepresentation(
  override?: CodexRepresentationSurface,
  probeVersion: CodexVersionProbe = probeCodexVersionOutput
): Promise<CodexRepresentation> {
  const paths = { hooksJsonPath: codexHooksJsonPath(), tomlPath: codexConfigTomlPath() };
  const output = await probeVersion().catch(() => null);
  const version = parseCodexVersion(output);
  const versionGate: CodexVersionGate =
    version === null ? 'unknown' : meetsCodexHooksJsonFloor(version) ? 'supported' : 'unsupported';
  const base = { ...paths, versionGate };

  if (override !== undefined) return { ...base, surface: override, reason: 'override' };
  if (versionGate !== 'supported') {
    return {
      ...base,
      surface: 'config-toml',
      reason: versionGate === 'unsupported' ? 'version-unsupported' : 'version-unknown',
    };
  }
  if (await codexHooksJsonHoldsObject(paths.hooksJsonPath)) {
    return { ...base, surface: 'hooks-json', reason: 'existing-hooks-json' };
  }
  const toml = await inspectCodexTomlHooks(paths.tomlPath);
  if (toml !== 'ours-or-none') {
    return {
      ...base,
      surface: 'config-toml',
      reason: toml === 'foreign' ? 'existing-toml-hooks' : 'toml-unreadable',
    };
  }
  return { ...base, surface: 'hooks-json', reason: 'default' };
}

// Codex hook trust.
//
// Codex records approval as
// `[hooks.state."<source path>:<event>:<group idx>:<hook idx>"] trusted_hash`
// in config.toml, whatever file the hook itself came from, and the hash covers
// the hook DEFINITION — command AND matcher — rather than the key: the same
// definition approved under one key runs unprompted under another (measured),
// while our canonical command under a stale matcher is a different hook that
// hashes differently. Moving the registration between representations may
// therefore CARRY the existing approval instead of asking the user to
// re-approve a command they already approved. A stale hash costs a prompt,
// never a wrong grant, but a hash is still only ever copied — never invented.

const CODEX_TRUST_EVENT = 'session_start';

/**
 * `<path>:session_start:<group>:<hook>` for the canonical command inside a
 * PARSED document (a config.toml table or a hooks.json object — the grouped
 * shape is the same in both), or null when it registers nothing of ours.
 * Indexes are read from the document rather than assumed: a Superset rewrite
 * of hooks.json can put our group anywhere.
 */
export function codexTrustKey(document: unknown, filePath: string): string | null {
  const command = codexHookCommand();
  const groups = tomlTable(tomlTable(document)?.hooks)?.SessionStart;
  if (!Array.isArray(groups)) return null;
  for (const [groupIndex, group] of groups.entries()) {
    const hooks = tomlTable(group)?.hooks;
    if (!Array.isArray(hooks)) continue;
    const hookIndex = hooks.findIndex((hook) => tomlTable(hook)?.command === command);
    if (hookIndex !== -1) {
      return `${filePath}:${CODEX_TRUST_EVENT}:${groupIndex}:${hookIndex}`;
    }
  }
  return null;
}

/** The group and hook indexes a trust key names for `filePath`, or null for any other key. */
function codexTrustKeyIndexes(key: string, filePath: string): CodexHookPosition | null {
  const prefix = `${filePath}:${CODEX_TRUST_EVENT}:`;
  if (!key.startsWith(prefix)) return null;
  const match = /^(\d+):(\d+)$/.exec(key.slice(prefix.length));
  return match === null ? null : { group: Number(match[1]), hook: Number(match[2]) };
}

/** A hook's place in an event array — the tail of the trust key that names it. */
export interface CodexHookPosition {
  group: number;
  hook: number;
}

function codexHookPositionKey(position: CodexHookPosition): string {
  return `${position.group}:${position.hook}`;
}

function codexTrustKeyAt(filePath: string, position: CodexHookPosition): string {
  return `${filePath}:${CODEX_TRUST_EVENT}:${position.group}:${position.hook}`;
}

interface CodexGroupOutcome {
  /** What this group is worth comparing against the after array. */
  value: unknown;
  /** Before hook index → its index inside the surviving group; our own hooks are absent. */
  hooks: Map<number, number>;
  /** The reconcile rewrote this group around a foreign hook, stripping ours out of it. */
  rewritten: boolean;
  /** Every hook in it is ours, so a group that does not survive took only rows of ours with it. */
  ours: boolean;
}

/**
 * What the reconcile does to one group: drops it when every hook is ours,
 * REWRITES it around the foreign hooks when only some are, and otherwise
 * preserves it verbatim. Stripping our entry from ahead of a foreign hook
 * re-indexes that hook inside its own group, so the surviving hooks carry
 * their new positions with them.
 */
function codexGroupOutcome(group: unknown, isOurs: (hook: unknown) => boolean): CodexGroupOutcome {
  const hooks = tomlTable(group)?.hooks;
  if (!Array.isArray(hooks))
    return { value: group, hooks: new Map(), rewritten: false, ours: false };
  const surviving = new Map<number, number>();
  const foreign: unknown[] = [];
  for (const [index, hook] of hooks.entries()) {
    if (isOurs(hook)) continue;
    surviving.set(index, foreign.length);
    foreign.push(hook);
  }
  if (foreign.length === hooks.length) {
    return { value: group, hooks: surviving, rewritten: false, ours: false };
  }
  if (foreign.length === 0) {
    // All ours: dropped, unless it is exactly the group we want and the
    // reconcile keeps it in place — in which case it survives verbatim.
    const identity = new Map(hooks.map((_, index): [number, number] => [index, index]));
    return { value: group, hooks: identity, rewritten: false, ours: true };
  }
  return {
    value: { ...(tomlTable(group) ?? {}), hooks: foreign },
    hooks: surviving,
    rewritten: true,
    ours: false,
  };
}

/**
 * Where the reconcile left each HOOK of an event array: `<group>:<hook>` →
 * the position it now occupies. Surviving groups are matched by value in
 * order, so two identical groups map first-to-first; groups the reconcile
 * preserves verbatim claim their slot before rewritten ones are matched by
 * the value they take once our entries are stripped, so a rewritten group
 * never steals the slot of the group it happens to resemble. A before group
 * that reaches no after position and held nothing but our hooks is DROPPED;
 * an after position no before group reaches is the group we inserted.
 */
export function codexHookPositionMap(
  before: readonly unknown[],
  after: readonly unknown[],
  isOurs: (hook: unknown) => boolean
): { positions: Map<string, CodexHookPosition>; droppedGroups: Set<number> } {
  const outcomes = before.map((group) => codexGroupOutcome(group, isOurs));
  const claimed = new Set<number>();
  const landed = new Map<number, number>();
  const claim = (from: number, outcome: CodexGroupOutcome): void => {
    const to = after.findIndex(
      (candidate, index) => !claimed.has(index) && isDeepStrictEqual(candidate, outcome.value)
    );
    if (to === -1) return;
    claimed.add(to);
    landed.set(from, to);
  };
  for (const [from, outcome] of outcomes.entries()) if (!outcome.rewritten) claim(from, outcome);
  for (const [from, outcome] of outcomes.entries()) if (outcome.rewritten) claim(from, outcome);

  const positions = new Map<string, CodexHookPosition>();
  const droppedGroups = new Set<number>();
  for (const [from, outcome] of outcomes.entries()) {
    const to = landed.get(from);
    if (to === undefined) {
      // A group that survives but matched nothing is one we cannot account
      // for; only a group that provably lost every hook — all of them ours —
      // may have its rows retired.
      if (outcome.ours) droppedGroups.add(from);
      continue;
    }
    for (const [hook, landedHook] of outcome.hooks) {
      positions.set(codexHookPositionKey({ group: from, hook }), { group: to, hook: landedHook });
    }
  }
  return { positions, droppedGroups };
}

/**
 * The re-index the reconcile forces on hooks.json, or null when it left every
 * hook where it was and dropped none. Derived from the group arrays either
 * side of the reconcile rather than from our own position: the reconcile
 * inserts our canonical group, DROPS any stale group of ours, and REWRITES a
 * group that holds a foreign hook beside ours — so the hooks behind it do not
 * all move by the same amount, and one that did not move must not be re-keyed.
 */
export function codexTrustShiftFor(
  hooksJsonPath: string,
  groups: { before: readonly unknown[]; after: readonly unknown[] }
): CodexTrustShiftKeys | null {
  const spec = userSettingsSpec('codex', hooksJsonPath);
  const { positions, droppedGroups } = codexHookPositionMap(groups.before, groups.after, (hook) =>
    spec === null ? false : isOrcaopsHook(hook, spec)
  );
  const moves = new Map<string, CodexHookPosition>();
  for (const [from, to] of positions) if (from !== codexHookPositionKey(to)) moves.set(from, to);
  return moves.size === 0 && droppedGroups.size === 0
    ? null
    : { hooksJsonPath, moves, droppedGroups };
}

export interface CodexTrustCarryKeys {
  fromKey: string;
  toKey: string;
}

export interface CodexTrustShiftKeys {
  /** The file whose trust keys the reconcile re-indexed. */
  hooksJsonPath: string;
  /**
   * Every hook whose group OR hook index changed, keyed `<group>:<hook>` as it
   * was before. Hooks that stayed put — and positions the after document does
   * not have — are absent, so nothing is ever re-keyed onto a hook that is not
   * there.
   */
  moves: ReadonlyMap<string, CodexHookPosition>;
  /**
   * Before-indexes of the groups that lost every hook. Only an all-ours group
   * can lose all of them, so an approval keyed to one of these is provably ours
   * and describes a hook that no longer exists.
   */
  droppedGroups: ReadonlySet<number>;
}

export interface CodexTrustEditKeys {
  /** Our own approval, copied from its config.toml key onto its hooks.json one. */
  carry: CodexTrustCarryKeys | null;
  shift: CodexTrustShiftKeys | null;
}

export type CodexTrustCarryVerdict = 'present' | 'absent' | 'unchanged' | 'refused';

export interface CodexTrustEditPlan {
  /** How our own approval fared. */
  carry: CodexTrustCarryVerdict;
  /** Approvals belonging to OTHER hooks that followed their group to its new index. */
  moved: number;
  /** Approvals left at their stale key, so Codex asks about those hooks once. */
  skipped: string[];
  /** The composed document, or null when there is nothing to write. */
  next: string | null;
}

function codexTomlTrustState(parsed: TomlTable): TomlTable | null {
  return tomlTable(tomlTable(parsed.hooks)?.state);
}

function codexTrustedHash(state: TomlTable | null, key: string): string | null {
  const hash = tomlTable(state?.[key])?.trusted_hash;
  return typeof hash === 'string' && hash.trim() !== '' ? hash : null;
}

/**
 * The dotted key path of a plain TOML table header (`[a.b."c"]`), or null for
 * an array-of-tables header and for anything this cannot read exactly. A
 * header we cannot read is a key we decline to relocate rather than guess at.
 */
function tomlTableHeaderPath(line: string): string[] | null {
  const text = line.trim();
  if (!text.startsWith('[') || text.startsWith('[[')) return null;
  let quote: string | null = null;
  let close = -1;
  for (let i = 1; i < text.length && close === -1; i += 1) {
    const ch = text[i];
    if (quote === '"' && ch === '\\') i += 1;
    else if (quote !== null) quote = ch === quote ? null : quote;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ']') close = i;
  }
  if (close === -1) return null;
  const trailing = text.slice(close + 1).trim();
  if (trailing !== '' && !trailing.startsWith('#')) return null;
  return tomlKeyPath(text.slice(1, close));
}

function tomlKeyPath(text: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      let end = i + 1;
      while (end < text.length && text[end] !== quote) {
        end += quote === '"' && text[end] === '\\' ? 2 : 1;
      }
      if (end >= text.length) return null;
      const literal = text.slice(i, end + 1);
      try {
        parts.push(quote === '"' ? (JSON.parse(literal) as string) : literal.slice(1, -1));
      } catch {
        return null;
      }
      i = end + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (bare === null) return null;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) return parts;
    if (text[i] !== '.') return null;
    i += 1;
  }
}

interface CodexTrustTableText {
  /** Bytes the entry occupies, cut when it moves. */
  start: number;
  end: number;
  /** Its value lines, without the header or any trailing blank or comment line. */
  body: string[];
}

/**
 * Where `[hooks.state."<key>"]` is written, or null when the key is not a
 * table of its own (an inline or dotted form) or is written more than once.
 * A trailing comment run is left behind rather than cut, because it reads as
 * a heading for whatever table follows.
 */
function codexTrustTableText(raw: string, key: string): CodexTrustTableText | null {
  const lines: Array<{ text: string; start: number; header: boolean }> = [];
  let offset = 0;
  for (const text of raw.split('\n')) {
    lines.push({ text, start: offset, header: /^\s*\[/.test(text) });
    offset += text.length + 1;
  }
  const wanted = ['hooks', 'state', key];
  const found = lines.filter(
    (line) => line.header && isDeepStrictEqual(tomlTableHeaderPath(line.text), wanted)
  );
  if (found.length !== 1) return null;

  const first = lines.indexOf(found[0]);
  let last = first;
  let after = lines.length;
  for (let i = first + 1; i < lines.length; i += 1) {
    if (lines[i].header) {
      after = i;
      break;
    }
    const text = lines[i].text.trim();
    if (text !== '' && !text.startsWith('#')) last = i;
  }
  const comment = lines.slice(last + 1, after).find((line) => line.text.trim().startsWith('#'));
  const end = comment?.start ?? (after === lines.length ? raw.length : lines[after].start);
  return {
    start: lines[first].start,
    end,
    body: lines.slice(first + 1, last + 1).map((line) => line.text.replace(/\r$/, '')),
  };
}

interface CodexTrustRelocation {
  fromKey: string;
  toKey: string;
  hash: string;
  /** What lands at `toKey`, for the diff the whole edit is proved by. */
  value: TomlValue;
  /** The lines re-emitted under the new header. */
  body: string[];
  /** The bytes the source occupies, or null when the entry is copied rather than moved. */
  cut: { start: number; end: number } | null;
}

/** A dead entry of ours, cut from `[hooks.state]` and re-emitted nowhere. */
interface CodexTrustRetirement {
  key: string;
  cut: { start: number; end: number };
}

interface CodexTrustShiftPlan {
  relocations: CodexTrustRelocation[];
  retirements: CodexTrustRetirement[];
  unmovable: string[];
}

function planCodexTrustShift(
  raw: string,
  state: TomlTable | null,
  shift: CodexTrustShiftKeys | null
): CodexTrustShiftPlan {
  const relocations: CodexTrustRelocation[] = [];
  const retirements: CodexTrustRetirement[] = [];
  const unmovable: string[] = [];
  if (shift === null || state === null) return { relocations, retirements, unmovable };
  const keyed = Object.keys(state)
    .flatMap((key) => {
      const at = codexTrustKeyIndexes(key, shift.hooksJsonPath);
      return at === null ? [] : [{ key, at }];
    })
    .sort((a, b) => a.at.group - b.at.group || a.at.hook - b.at.hook);
  for (const { key, at } of keyed) {
    // A group loses every hook only when every hook in it was our exact
    // command, so this entry is ours and its hook is gone. Retiring it frees
    // the index for whichever surviving hook moved onto it.
    if (shift.droppedGroups.has(at.group)) {
      const dead = codexTrustTableText(raw, key);
      if (dead !== null) retirements.push({ key, cut: { start: dead.start, end: dead.end } });
      continue;
    }
    const to = shift.moves.get(codexHookPositionKey(at));
    // A hook that never moved keeps its key; inventing a destination for it
    // lands trust on a hook that is not there, and Codex then runs neither.
    if (to === undefined) continue;
    // An entry recording no hash records no approval, so it has nothing to
    // preserve — but it still occupies its key, and may block a move onto it.
    const hash = codexTrustedHash(state, key);
    if (hash === null) continue;
    const text = codexTrustTableText(raw, key);
    if (text === null) {
      unmovable.push(key);
      continue;
    }
    relocations.push({
      fromKey: key,
      toKey: codexTrustKeyAt(shift.hooksJsonPath, to),
      hash,
      value: state[key],
      body: text.body,
      cut: { start: text.start, end: text.end },
    });
  }
  return { relocations, retirements, unmovable };
}

/**
 * The largest set of relocations that overwrites nothing: a target key held by
 * an entry that is not itself moving away — or being retired — and whose hash
 * differs, blocks its move; and blocking one move can block the move that was
 * waiting for it to vacate, so the set shrinks until it is stable.
 */
function acceptCodexTrustRelocations(
  state: TomlTable | null,
  relocations: CodexTrustRelocation[],
  retirements: readonly CodexTrustRetirement[]
): { accepted: Set<CodexTrustRelocation>; written: Set<CodexTrustRelocation> } {
  const occupied = (key: string): boolean => state !== null && hasOwnTomlKey(state, key);
  const accepted = new Set(relocations);
  const vacatedKeys = (): Set<string> =>
    new Set([
      ...retirements.map((r) => r.key),
      ...[...accepted].filter((r) => r.cut !== null).map((r) => r.fromKey),
    ]);
  for (;;) {
    const vacated = vacatedKeys();
    const blocked = [...accepted].find(
      (r) =>
        occupied(r.toKey) && !vacated.has(r.toKey) && codexTrustedHash(state, r.toKey) !== r.hash
    );
    if (blocked === undefined) break;
    accepted.delete(blocked);
  }
  const vacated = vacatedKeys();
  // A target left holding the identical hash already records this approval;
  // the entry moves onto it without the write.
  const written = new Set([...accepted].filter((r) => !occupied(r.toKey) || vacated.has(r.toKey)));
  return { accepted, written };
}

function composeCodexTrustEdit(
  raw: string,
  applied: CodexTrustRelocation[],
  written: Set<CodexTrustRelocation>,
  retirements: readonly CodexTrustRetirement[]
): string {
  const eol = codexTomlEol(raw);
  const cuts = [
    ...retirements.map((r) => r.cut),
    ...applied.flatMap((r) => (r.cut === null ? [] : [r.cut])),
  ];
  let text = raw;
  for (const cut of [...cuts].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, cut.start) + text.slice(cut.end);
  }
  if (cuts.length > 0) text = text.replace(/[ \t\r\n]+$/, eol);
  const tables = applied
    .filter((r) => written.has(r))
    .map((r) => [`[hooks.state.${JSON.stringify(r.toKey)}]`, ...r.body, ''].join(eol));
  if (tables.length === 0) return text;
  const base = text === '' || /\r?\n$/.test(text) ? text : `${text}${eol}`;
  return `${base}${eol}${tables.join(eol)}`;
}

/**
 * Rewrite `[hooks.state]` so every approval survives the reconcile that put our
 * group into hooks.json: ours copied onto its new key, each approval whose hook
 * moved re-keyed to the group and hook index it now sits at, and our own dead
 * entries — those keyed to a group the reconcile emptied — retired, which frees
 * their index for whichever survivor moved onto it. New tables are APPENDED, so
 * they land after any trailing orcaops marker rather than inside the fence Codex
 * itself writes into.
 *
 * The whole edit is proved by diff — the composed document must parse to the
 * original with exactly the intended key moves and byte-identical hashes — so
 * anything else refuses and writes nothing.
 */
export function planCodexTrustEdit(rawToml: string, keys: CodexTrustEditKeys): CodexTrustEditPlan {
  const parsed = parseCodexToml(rawToml);
  if (parsed === null) return { carry: 'absent', moved: 0, skipped: [], next: null };
  const state = codexTomlTrustState(parsed);

  const carryHash = keys.carry === null ? null : codexTrustedHash(state, keys.carry.fromKey);
  const ours: CodexTrustRelocation | null =
    keys.carry === null || carryHash === null
      ? null
      : {
          fromKey: keys.carry.fromKey,
          toKey: keys.carry.toKey,
          hash: carryHash,
          value: { trusted_hash: carryHash },
          body: [`trusted_hash = ${JSON.stringify(carryHash)}`],
          cut: null,
        };
  const shift = planCodexTrustShift(rawToml, state, keys.shift);
  const { retirements } = shift;
  const planned = [...shift.relocations, ...(ours === null ? [] : [ours])];
  const nothingWritten = (
    carry: CodexTrustCarryVerdict,
    skipped: string[]
  ): CodexTrustEditPlan => ({
    carry: ours === null ? 'absent' : carry,
    moved: 0,
    skipped,
    next: null,
  });
  if (planned.length === 0 && retirements.length === 0) {
    return nothingWritten('absent', shift.unmovable);
  }

  const { accepted, written } = acceptCodexTrustRelocations(state, planned, retirements);
  const skipped = [
    ...shift.relocations.filter((r) => !accepted.has(r)).map((r) => r.fromKey),
    ...shift.unmovable,
  ];
  const applied = planned.filter((r) => accepted.has(r));
  if (applied.length === 0 && retirements.length === 0) return nothingWritten('refused', skipped);
  if (written.size === 0 && retirements.length === 0 && applied.every((r) => r.cut === null)) {
    return nothingWritten('unchanged', skipped);
  }

  const next = composeCodexTrustEdit(rawToml, applied, written, retirements);
  const nextState: TomlTable = { ...(state ?? {}) };
  for (const r of retirements) delete nextState[r.key];
  for (const r of applied) if (r.cut !== null) delete nextState[r.fromKey];
  for (const r of applied) if (written.has(r)) nextState[r.toKey] = r.value;
  const expected: TomlTable = {
    ...parsed,
    hooks: { ...(tomlTable(parsed.hooks) ?? {}), state: nextState },
  };
  if (!isDeepStrictEqual(parseCodexToml(next), expected)) {
    return nothingWritten('refused', [
      ...shift.relocations.map((r) => r.fromKey),
      ...shift.unmovable,
    ]);
  }
  return {
    carry:
      ours === null
        ? 'absent'
        : !accepted.has(ours)
          ? 'refused'
          : written.has(ours)
            ? 'present'
            : 'unchanged',
    moved: applied.filter((r) => r !== ours).length,
    skipped,
    next,
  };
}

export type CodexTrustCarryOutcome = CodexTrustCarryVerdict | 'unreadable';

export interface CodexTrustEditReport {
  carry: CodexTrustCarryOutcome;
  moved: number;
  skipped: string[];
}

export interface CarryCodexTrustOptions {
  configPath?: string;
  beforeWrite?: () => Promise<void>;
}

/** Apply `planCodexTrustEdit` under the same pre-image guard as the other config.toml writers. */
export async function carryCodexTrust(
  keys: CodexTrustEditKeys,
  options: CarryCodexTrustOptions = {}
): Promise<CodexTrustEditReport> {
  const state = await readCodexTomlState(options.configPath);
  if (state.readStatus === 'unreadable') return { carry: 'unreadable', moved: 0, skipped: [] };
  if (state.raw === null) return { carry: 'absent', moved: 0, skipped: [] };
  const plan = planCodexTrustEdit(state.raw, keys);
  if (plan.next === null) return { carry: plan.carry, moved: 0, skipped: plan.skipped };
  await options.beforeWrite?.();
  await writeUserConfigFile(state.path, plan.next, codexTomlWriteGuard(state));
  return { carry: plan.carry, moved: plan.moved, skipped: plan.skipped };
}

/** Does config.toml still register (or fence) the orcaops hook? */
async function codexTomlRegistersOurs(representation: CodexRepresentation): Promise<boolean> {
  const state = await readCodexTomlState(representation.tomlPath);
  return state.installed || state.markerBlock;
}

export type CodexTrustCarryReport = CodexTrustCarryOutcome | 'failed';

export type CodexMigrationOutcome = 'moved' | 'kept-duplicate' | 'none';

export interface CodexTrustShiftReport {
  /** Approvals for OTHER hooks that followed their group to its new index. */
  moved: number;
  /** Approvals left at their stale key, so Codex asks about those hooks once. */
  skipped: string[];
}

export interface CodexRegistrationMigration {
  outcome: CodexMigrationOutcome;
  /** The removal's verdict, or null when config.toml held nothing of ours. */
  removal: CodexTomlRemoveOutcome | null;
  /** The approval's verdict, or null when config.toml recorded none for us. */
  trust: CodexTrustCarryReport | null;
  trustShift: CodexTrustShiftReport;
}

export interface MigrateCodexRegistrationOptions {
  /**
   * The hooks.json groups either side of the reconcile. Only the hooks that
   * actually changed position are re-keyed, so re-running against a file we
   * are already in shifts nothing.
   */
  groups?: CodexHooksJsonGroups;
}

/**
 * May the block go? Only once the approval it carries either moved to the
 * hooks.json key or was never there: a write that threw and a plan that
 * refused both leave the grant on the config.toml key, and removing the block
 * that key names would strand it.
 */
function codexTrustReleasesTomlBlock(trust: CodexTrustCarryReport | null): boolean {
  return trust === null || trust === 'present' || trust === 'unchanged' || trust === 'absent';
}

/**
 * Make config.toml agree with the hooks.json that now carries the
 * registration: re-key every approval whose group the reconcile moved, copy the
 * one the user already granted us, then remove any block we own. Both trust
 * indexes are READ from their documents — Codex keys trust by position, and a
 * Superset rewrite can put our hooks.json group anywhere.
 *
 * The order is load-bearing. Trust is settled while the block still stands,
 * and an approval that did not move stops the move, so every failure leaves
 * the hook registered twice (today's state) rather than not at all.
 */
export async function migrateCodexRegistrationToHooksJson(
  representation: CodexRepresentation,
  options: MigrateCodexRegistrationOptions = {}
): Promise<CodexRegistrationMigration> {
  const noShift: CodexTrustShiftReport = { moved: 0, skipped: [] };
  const state = await readCodexTomlState(representation.tomlPath);
  if (state.readStatus === 'unreadable') {
    return { outcome: 'none', removal: 'unreadable', trust: null, trustShift: noShift };
  }
  if (state.raw === null) {
    return { outcome: 'none', removal: null, trust: null, trustShift: noShift };
  }

  const registered = state.installed || state.markerBlock;
  const parsed = parseCodexToml(state.raw);
  const fromKey =
    parsed === null || !registered ? null : codexTrustKey(parsed, representation.tomlPath);
  const toKey = await codexHooksJsonTrustKey(representation);
  const carry = fromKey !== null && toKey !== null ? { fromKey, toKey } : null;
  const shift =
    options.groups === undefined
      ? null
      : codexTrustShiftFor(representation.hooksJsonPath, options.groups);

  let trust: CodexTrustCarryReport | null = null;
  let trustShift = noShift;
  if (carry !== null || shift !== null) {
    try {
      const report = await carryCodexTrust(
        { carry, shift },
        { configPath: representation.tomlPath }
      );
      trust = carry === null ? null : report.carry;
      trustShift = { moved: report.moved, skipped: report.skipped };
    } catch {
      trust = 'failed';
    }
  }
  if (!registered) return { outcome: 'none', removal: null, trust, trustShift };
  if (!codexTrustReleasesTomlBlock(trust)) {
    return { outcome: 'kept-duplicate', removal: null, trust, trustShift };
  }

  const removal = await removeCodexTomlBlock(representation.tomlPath);
  return {
    outcome: removal === 'removed' ? 'moved' : 'kept-duplicate',
    removal,
    trust,
    trustShift,
  };
}

/** The trust key of our entry in the RECONCILED hooks.json, read back from disk. */
async function codexHooksJsonTrustKey(representation: CodexRepresentation): Promise<string | null> {
  const file = await readUserFile(representation.hooksJsonPath);
  if (file.status !== 'ok') return null;
  let document: unknown;
  try {
    document = JSON.parse(file.raw);
  } catch {
    return null;
  }
  return codexTrustKey(document, representation.hooksJsonPath);
}

export type UserSessionHookSurfaceState =
  | 'installed'
  | 'absent'
  /** Registered, working, but in the file the resolved representation has replaced. */
  | 'superseded'
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

/** The chooser is offered for config.toml only, so only that surface names it. */
function userSessionHookInstallRemedy(agent: SupportedAgentId, targetPath?: string): string {
  const managedMode =
    agent === ('codex' as SupportedAgentId) &&
    (targetPath === undefined || !isCodexHooksJsonPath(targetPath))
      ? ' and choose managed mode'
      : '';
  return `Run \`orcaops session-hooks install --agents ${agent}\`${managedMode} to repair the registration.`;
}

function codexSupersededRemedy(hooksJsonPath: string): string {
  return `The Codex hook now runs from ${hooksJsonPath}; run \`orcaops session-hooks install --agents codex\` to clean up this leftover block.`;
}

function userSessionHookInvalidJsonRemedy(agent: SupportedAgentId, targetPath: string): string {
  return `${targetPath} is not valid JSON — fix it, then re-run \`orcaops session-hooks install --agents ${agent}\`.`;
}

export async function evaluateUserSessionHookSurfaces(
  record: UserHooksRecord | null,
  representation?: CodexRepresentation
): Promise<UserSessionHookSurfaceHealth[]> {
  const rows: UserSessionHookSurfaceHealth[] = [];
  const recordedEntries = record?.entries ?? [];
  const isRecorded = (agent: SupportedAgentId, targetPath: string): boolean =>
    recordedEntries.some((entry) => entry.agent === agent && entry.path === targetPath);

  // Both codex files are reported, but the representation is resolved (and
  // codex probed for its version) only where the answer can change a row:
  // when the registration is live in BOTH files at once.
  let resolved = representation ?? null;
  const codexRepresentation = async (): Promise<CodexRepresentation> =>
    (resolved ??= await resolveCodexRepresentation());
  let hooksJsonRegisters: boolean | null = null;
  const codexHooksJsonRegisters = async (): Promise<boolean> => {
    if (hooksJsonRegisters === null) {
      const file = await readUserFile(codexHooksJsonPath());
      hooksJsonRegisters = file.status === 'ok' && file.raw.includes(SESSION_HOOK_COMMAND);
    }
    return hooksJsonRegisters;
  };

  const codexAgent = 'codex' as SupportedAgentId;
  // A recorded codex path may name either representation; only the TOML ones
  // belong to the reader below (the sidecar is evaluated as JSON with the
  // other user files).
  const codexPaths = [
    codexConfigTomlPath(),
    ...recordedEntries
      .filter((entry) => entry.agent === codexAgent && !isCodexHooksJsonPath(entry.path))
      .map((entry) => entry.path),
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
    // A registration the resolved representation has moved past still WORKS
    // (Codex runs both files), so this is a nudge to re-run install, not a
    // failure — and only once the registration is actually live in hooks.json,
    // since until then re-running install would change nothing.
    if (
      state === 'installed' &&
      configPath === codexConfigTomlPath() &&
      (await codexHooksJsonRegisters())
    ) {
      const codexSurface = await codexRepresentation();
      if (codexSurface.surface === 'hooks-json') {
        state = 'superseded';
        remedy = codexSupersededRemedy(codexSurface.hooksJsonPath);
      }
    }
    rows.push({ agent: codexAgent, path: codex.path, state, remedy, recorded, owned });
  }

  const jsonTargets = [
    ...userHookCapableAgents()
      .map((agent) => ({ agent, path: resolveUserHookPath(agent) }))
      .filter((entry): entry is { agent: SupportedAgentId; path: string } => entry.path !== null),
    ...recordedEntries.filter(
      (entry) =>
        resolveUserHookPath(entry.agent) !== null &&
        (entry.agent !== codexAgent || isCodexHooksJsonPath(entry.path))
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
      if (recorded) remedy = userSessionHookInstallRemedy(target.agent, target.path);
    } else {
      owned = file.raw.includes(SESSION_HOOK_COMMAND);
      try {
        JSON.parse(file.raw);
        state = owned ? 'installed' : recorded ? 'registered-but-missing' : 'absent';
        if (state === 'registered-but-missing') {
          remedy = userSessionHookInstallRemedy(target.agent, target.path);
        }
      } catch {
        // A file that no longer parses registers nothing, however it reads:
        // when it is ours (recorded, or still carrying the command text) that
        // is a broken registration with a repair, not someone else's mess.
        state = recorded || owned ? 'registered-but-broken' : 'invalid-json';
        if (state === 'registered-but-broken') {
          remedy = userSessionHookInvalidJsonRemedy(target.agent, target.path);
        }
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
