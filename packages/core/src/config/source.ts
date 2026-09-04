import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertResolvedWithin,
  type Config,
  ConfigValidationError,
  type HotStateProbe,
  probeHotState,
} from '@orcaops/storage';

import { Repo } from '../git/repo.js';

/** `.orcaops/config.json`, relative to a worktree root. */
export const CONFIG_RELATIVE_PATH = path.join('.orcaops', 'config.json');
/** `.orcaops/evaluators.yaml`, relative to a worktree root. */
export const EVALUATORS_RELATIVE_PATH = path.join('.orcaops', 'evaluators.yaml');

/**
 * The Orcaops directory inside the git common dir — already home to the
 * repository install locks, and under personal scope also to the shared
 * config, evaluator registration, and ownership manifest.
 */
export const COMMON_ORCAOPS_DIR = 'orcaops';
export const COMMON_CONFIG_FILE = 'config.json';
export const COMMON_EVALUATORS_FILE = 'evaluators.yaml';
/**
 * Deliberately not `personal-install-state.json`: the repository install lock
 * in the same directory is keyed `install-state`, and two neighbours that
 * differ by a suffix read as the same thing.
 */
export const COMMON_PERSONAL_MANIFEST_FILE = 'personal-manifest.json';

/** Where a config file lives, and the root it must resolve within. */
export interface ConfigLocation {
  /** Absolute path of `config.json` — exists or not. */
  configPath: string;
  /**
   * The root `configPath` must resolve beneath. NOT always the worktree root:
   * a common-dir config sits outside every worktree, so checking it against
   * the worktree would reject every linked-worktree personal install.
   */
  containmentRoot: string;
  /** Absolute path of the evaluator registration file beside the config. */
  evaluatorsPath: string;
  origin: 'worktree' | 'common';
}

export type ConfigSourceKind = 'worktree' | 'common' | 'none';

export interface ResolvedConfigSource extends ConfigLocation {
  kind: ConfigSourceKind;
  /** Always the CURRENT worktree — where every repo-relative data path is anchored. */
  worktreeRoot: string;
  /** Canonical git common dir, or null when git could not resolve one. */
  commonDir: string | null;
  /** The parsed config document; undefined when `kind` is `none` or `unreadable`. */
  raw: unknown | undefined;
  /**
   * The file exists but its body could not be parsed. Only ever set under
   * `tolerateUnreadable`, which exists so `init --force --reset-config` can
   * name and replace the offending file instead of guessing where it lives.
   */
  unreadable: boolean;
}

/**
 * `<commonDir>` per worktree root. Memoized process-wide because personal
 * scope reads config on paths that touch every linked worktree in a loop
 * (Watch's review targets), and each miss is a `git rev-parse` subprocess.
 * Each hit revalidates a cheap fingerprint of the worktree's Git layout so a
 * deleted/recreated path cannot retain another repository's common dir.
 */
interface CommonDirCacheEntry {
  commonDir: string;
  gitDir: string;
  layoutStamp: string;
}

const commonDirCache = new Map<string, CommonDirCacheEntry>();

/** Test seam: drop memoized common dirs so a fixture repo can be rebuilt in place. */
export function clearCommonDirCache(): void {
  commonDirCache.clear();
}

export async function resolveCommonDir(worktreeRoot: string): Promise<string> {
  const key = path.resolve(worktreeRoot);
  const cached = commonDirCache.get(key);
  if (cached !== undefined) {
    const currentStamp = await gitLayoutStamp(cached.gitDir);
    if (currentStamp === cached.layoutStamp) return cached.commonDir;
    commonDirCache.delete(key);
  }
  // `getCommonDirAbsolute`, never `getGitPathAbsolute('orcaops/config.json')`:
  // git maps only paths it knows (info/exclude, hooks) to the common dir, and
  // resolves an unknown one inside the CURRENT worktree's git dir — which
  // would silently give every worktree its own "shared" config.
  const repo = new Repo(key);
  const [commonDir, gitDir] = await Promise.all([
    repo.getCommonDirAbsolute(),
    repo.getGitDirAbsolute(),
  ]);
  const layoutStamp = await gitLayoutStamp(gitDir);
  if (layoutStamp !== '') commonDirCache.set(key, { commonDir, gitDir, layoutStamp });
  return commonDir;
}

async function gitLayoutStamp(gitDir: string): Promise<string> {
  try {
    const stats = await lstat(gitDir);
    const [commonLink, worktreeEntryRaw] = await Promise.all([
      readOptionalFile(path.join(gitDir, 'commondir')),
      readOptionalFile(path.join(gitDir, 'gitdir')),
    ]);
    if (worktreeEntryRaw === '') {
      return JSON.stringify([stats.dev, stats.ino, stats.birthtimeMs, commonLink]);
    }

    // Linked-worktree admin dirs survive plain deletion; this backlink reaches
    // the live `.git` entry whose bytes change when another repo reuses the path.
    const worktreeEntryPath = path.resolve(gitDir, worktreeEntryRaw.replace(/\r?\n$/, ''));
    const worktreeEntryStats = await lstat(worktreeEntryPath);
    const worktreeEntry = await readFile(worktreeEntryPath, 'utf8');
    return JSON.stringify([
      stats.dev,
      stats.ino,
      stats.birthtimeMs,
      commonLink,
      worktreeEntryRaw,
      worktreeEntryStats.dev,
      worktreeEntryStats.ino,
      worktreeEntryStats.birthtimeMs,
      worktreeEntry,
    ]);
  } catch {
    return '';
  }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export function worktreeConfigLocation(worktreeRoot: string): ConfigLocation {
  const root = path.resolve(worktreeRoot);
  return {
    configPath: path.join(root, CONFIG_RELATIVE_PATH),
    containmentRoot: root,
    evaluatorsPath: path.join(root, EVALUATORS_RELATIVE_PATH),
    origin: 'worktree',
  };
}

export function commonConfigLocationFrom(commonDir: string): ConfigLocation {
  const dir = path.join(commonDir, COMMON_ORCAOPS_DIR);
  return {
    configPath: path.join(dir, COMMON_CONFIG_FILE),
    containmentRoot: commonDir,
    evaluatorsPath: path.join(dir, COMMON_EVALUATORS_FILE),
    origin: 'common',
  };
}

export async function commonConfigLocation(worktreeRoot: string): Promise<ConfigLocation> {
  return commonConfigLocationFrom(await resolveCommonDir(worktreeRoot));
}

export function commonOrcaopsDirFrom(commonDir: string): string {
  return path.join(commonDir, COMMON_ORCAOPS_DIR);
}

export async function commonPersonalManifestPath(worktreeRoot: string): Promise<string> {
  const commonDir = await resolveCommonDir(worktreeRoot);
  return path.join(commonDir, COMMON_ORCAOPS_DIR, COMMON_PERSONAL_MANIFEST_FILE);
}

/**
 * The location a write should target, chosen by the scope the caller is
 * moving TO — never by where the current config happens to sit. A
 * project-to-personal transition has to publish to the common dir while a
 * project config is still the effective source.
 */
export async function configLocationForScope(
  worktreeRoot: string,
  scope: 'project' | 'global' | 'personal'
): Promise<ConfigLocation> {
  return scope === 'personal'
    ? commonConfigLocation(worktreeRoot)
    : worktreeConfigLocation(worktreeRoot);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The scope as WRITTEN, not as defaulted. Source selection must not read a
 * config that omits `install.scope` as personal just because the resolved
 * schema would have supplied a value.
 */
function declaredScope(raw: unknown): string | undefined {
  if (!isJsonObject(raw)) return undefined;
  const install = raw.install;
  if (!isJsonObject(install)) return undefined;
  const scope = install.scope;
  return typeof scope === 'string' ? scope : undefined;
}

/** Sentinel for a file that exists but does not parse. */
const UNREADABLE = Symbol('unreadable config body');

/** Read + parse a config file, or undefined when it does not exist. */
async function readConfigDocument(
  location: ConfigLocation,
  tolerateUnreadable: boolean
): Promise<unknown | undefined | typeof UNREADABLE> {
  const safePath = assertResolvedWithin(
    location.configPath,
    location.containmentRoot,
    'orcaops configuration',
    { rejectSymlinks: true }
  );
  let rawText: string;
  try {
    rawText = await readFile(safePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(rawText);
  } catch (err) {
    if (tolerateUnreadable) return UNREADABLE;
    throw new Error(`${location.configPath} is not valid JSON: ${(err as Error).message}`);
  }
}

export interface ResolveConfigSourceOptions {
  /** If true (default), no config anywhere resolves to `kind: 'none'` instead of throwing. */
  allowMissing?: boolean;
  /**
   * A canonical common dir the caller already resolved (the session hook's
   * one-shot probe): used as-is instead of spawning `git rev-parse` again.
   */
  commonDir?: string;
  /**
   * Report an unparseable body as `unreadable` instead of throwing, so a
   * caller that is about to REPLACE the file learns where it lives. Scope
   * violations still throw: those are decisions about which file governs,
   * not failures to read one.
   */
  tolerateUnreadable?: boolean;
}

function missingConfigError(location: ConfigLocation): NodeJS.ErrnoException {
  const err = new Error(
    `no orcaops configuration found (looked for ${location.configPath})`
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  err.path = location.configPath;
  return err;
}

/**
 * Pick the one config that governs this worktree.
 *
 * 1. A worktree `.orcaops/config.json` wins when it is valid project/global.
 * 2. A worktree config that is malformed, unreadable, unsafe, or claims
 *    `personal` fails closed — never silently falls through to the shared
 *    file, which would hand the user a different config than the one they
 *    are looking at.
 * 3. Otherwise the git-common config governs, and only when it explicitly
 *    declares `install.scope: "personal"`.
 * 4. Otherwise the repository is uninitialized.
 */
export async function resolveConfigSource(
  worktreeRoot: string,
  opts: ResolveConfigSourceOptions = {}
): Promise<ResolvedConfigSource> {
  const { allowMissing = true, tolerateUnreadable = false } = opts;
  const root = path.resolve(worktreeRoot);
  const worktree = worktreeConfigLocation(root);
  const worktreeRaw = await readConfigDocument(worktree, tolerateUnreadable);

  if (worktreeRaw !== undefined) {
    if (worktreeRaw === UNREADABLE) {
      return {
        ...worktree,
        kind: 'worktree',
        worktreeRoot: root,
        commonDir: null,
        raw: undefined,
        unreadable: true,
      };
    }
    if (declaredScope(worktreeRaw) === 'personal') {
      throw new ConfigValidationError(
        `${worktree.configPath} sets install.scope "personal", which a worktree-local ` +
          'config cannot do: personal scope is stored once in the git common directory and ' +
          'shared by every worktree. Remove that file, then run `orcaops init --personal`.',
        'install.scope'
      );
    }
    return {
      ...worktree,
      kind: 'worktree',
      worktreeRoot: root,
      commonDir: null,
      raw: worktreeRaw,
      unreadable: false,
    };
  }

  let commonDir: string | null = opts.commonDir ?? null;
  try {
    commonDir ??= await resolveCommonDir(root);
  } catch {
    // Git cannot resolve a common dir (not a repo, or too broken to answer).
    // A personal install is unreachable rather than absent, and guessing a
    // common path from a nearby `.git` would be a guess about shared state.
    commonDir = null;
  }

  if (commonDir !== null) {
    const common = commonConfigLocationFrom(commonDir);
    const commonRaw = await readConfigDocument(common, tolerateUnreadable);
    if (commonRaw === UNREADABLE) {
      return {
        ...common,
        kind: 'common',
        worktreeRoot: root,
        commonDir,
        raw: undefined,
        unreadable: true,
      };
    }
    if (commonRaw !== undefined) {
      const scope = declaredScope(commonRaw);
      if (scope !== 'personal') {
        throw new ConfigValidationError(
          `${common.configPath} is the shared personal configuration but declares ` +
            `install.scope ${scope === undefined ? '(absent)' : JSON.stringify(scope)} ` +
            'instead of "personal". Remove that file, then run `orcaops init --personal` ' +
            'to recreate it.',
          'install.scope'
        );
      }
      return {
        ...common,
        kind: 'common',
        worktreeRoot: root,
        commonDir,
        raw: commonRaw,
        unreadable: false,
      };
    }
  }

  if (!allowMissing) throw missingConfigError(worktree);
  return {
    ...worktree,
    kind: 'none',
    worktreeRoot: root,
    commonDir,
    raw: undefined,
    unreadable: false,
  };
}

/**
 * The four states a worktree can be in, decided from the governing config
 * and a non-mutating look at its data directory — never from whether
 * `<worktree>/.orcaops` exists, and never by opening SQLite:
 *
 * - `uninitialized`: no config governs this worktree;
 * - `enabled` with `hot.empty`: governed, but nothing captured here yet — a
 *   valid empty source, which read paths must serve without creating files;
 * - `enabled` with hot data;
 * - `broken`: a config governs it but the config or the data paths cannot be
 *   used (fails closed — the error names why).
 */
export type WorktreeState =
  | { kind: 'uninitialized'; worktreeRoot: string }
  | {
      kind: 'enabled';
      worktreeRoot: string;
      source: ResolvedConfigSource;
      config: Config;
      hot: HotStateProbe;
    }
  | { kind: 'broken'; worktreeRoot: string; error: Error };

export async function resolveWorktreeState(
  worktreeRoot: string,
  loadConfigFromSource: (source: ResolvedConfigSource) => Config
): Promise<WorktreeState> {
  const root = path.resolve(worktreeRoot);
  let source: ResolvedConfigSource;
  try {
    source = await resolveConfigSource(root);
  } catch (err) {
    return { kind: 'broken', worktreeRoot: root, error: err as Error };
  }
  if (source.kind === 'none') return { kind: 'uninitialized', worktreeRoot: root };
  try {
    const config = loadConfigFromSource(source);
    return {
      kind: 'enabled',
      worktreeRoot: root,
      source,
      config,
      hot: probeHotState(root, config),
    };
  } catch (err) {
    return { kind: 'broken', worktreeRoot: root, error: err as Error };
  }
}
