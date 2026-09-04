import path from 'node:path';

import {
  assertConfigVersionCurrent,
  type Config,
  ConfigValidationError,
  getDefaultConfig,
  resolveConfig,
} from '@orcaops/storage';

import {
  CONFIG_RELATIVE_PATH,
  resolveConfigSource,
  type ResolvedConfigSource,
  resolveWorktreeState,
  type WorktreeState,
} from './source.js';

export interface LoadConfigOptions {
  /** If true (default), missing config returns defaults. If false, missing throws. */
  allowMissing?: boolean;
}

export const READ_ONLY_PROJECT_CONFIG_PATHS = [
  ['artifacts', 'path'],
  ['cache', 'path'],
  ['diff_fingerprint', 'max_diff_bytes'],
  ['review', 'max_diff_bytes'],
  ['review', 'include_untracked'],
  // The review floor pins its tree to a durable ref, so the exclude set has to
  // survive the projection alongside the opt-ins it outranks. Dropping it here
  // would silently narrow the set to the built-ins on that path alone.
  ['capture', 'exclude'],
  ['capture', 'exclude_builtins'],
  // The secret gate runs BEFORE buildContext, so it cannot read the full
  // config. Without this row the loader would hand back the default empty
  // allowlist and every entry would silently never apply.
  ['redact', 'allow'],
] as const;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectReadOnlyConfig(raw: unknown): unknown {
  if (!isJsonObject(raw)) return raw;

  const projected: JsonObject = {};
  for (const [section, field] of READ_ONLY_PROJECT_CONFIG_PATHS) {
    if (!Object.prototype.hasOwnProperty.call(raw, section)) continue;
    const sourceSection = raw[section];
    if (!isJsonObject(sourceSection)) {
      projected[section] = sourceSection;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(sourceSection, field)) continue;
    const targetSection = (projected[section] ??= {}) as JsonObject;
    targetSection[field] = sourceSection[field];
  }
  return projected;
}

/**
 * Validate an already-resolved source into a full Config. Exactly the current
 * schema version loads; mismatches reject with regeneration or upgrade
 * guidance, and nothing is ever written back.
 */
export function configFromSource(source: ResolvedConfigSource): Config {
  if (source.kind === 'none' || source.unreadable) return getDefaultConfig();
  try {
    assertConfigVersionCurrent(source.raw);
    return resolveConfig(source.raw);
  } catch (err) {
    // Storage validates the DOCUMENT and cannot know which file it came from;
    // only the resolver does. Name it here so the user is not sent to
    // `.orcaops/config.json` when the offending file is the shared one.
    if (err instanceof ConfigValidationError) {
      throw new ConfigValidationError(`${source.configPath}: ${err.message}`, err.path);
    }
    throw err;
  }
}

/**
 * Load and validate the configuration governing `repoRoot`, deep-merged with
 * built-in defaults. The file is the worktree's own `.orcaops/config.json`, or
 * — under personal scope — the shared one in the git common directory; see
 * `resolveConfigSource` for the precedence and its fail-closed cases. Returns
 * a fully-defaulted Config even when no file exists.
 */
export async function loadConfig(repoRoot: string, opts: LoadConfigOptions = {}): Promise<Config> {
  return configFromSource(await resolveConfigSource(repoRoot, opts));
}

/**
 * Load the leaves named in {@link READ_ONLY_PROJECT_CONFIG_PATHS}: the stable
 * inputs used to discover artifacts and rebuild review floors, plus the capture
 * exclude set a floor has to honour before it pins a tree.
 *
 * Deliberately NOT version-gated, unlike `loadConfig` — watch and the review
 * floor span worktrees written by different Orcaops versions, and rejecting the
 * whole file over its version would take these derived read surfaces down with
 * it. The consequence is that the exclude set is honoured here from a config
 * `loadConfig` would refuse outright, so `exclude_builtins: false` can narrow
 * the built-in set on this path alone. Gating it would buy nothing:
 * `schema_version` lives in the same file as the exclude set, so whoever can
 * write one can write the other.
 *
 * Source selection is shared with `loadConfig`, so the two never read different
 * files — a projection that disagreed with the CLI about which config governs
 * would resolve artifacts under one `artifacts.path` and capture under another.
 */
export async function loadReadOnlyProjectConfig(
  repoRoot: string,
  opts: LoadConfigOptions = {}
): Promise<Config> {
  return readOnlyProjectConfigFromSource(await resolveConfigSource(repoRoot, opts));
}

export function readOnlyProjectConfigFromSource(source: ResolvedConfigSource): Config {
  if (source.kind === 'none' || source.unreadable) return getDefaultConfig();
  return resolveConfig(projectReadOnlyConfig(source.raw));
}

/**
 * The worktree-local config path. Personal scope does not live here — callers
 * that need the config actually in effect must resolve the source; this
 * remains the right answer only for a project/global destination.
 */
export function getConfigPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_RELATIVE_PATH);
}

/** Absolute path of the config actually governing `repoRoot`. */
export async function resolveConfigPath(repoRoot: string): Promise<string> {
  return (await resolveConfigSource(repoRoot)).configPath;
}

/** {@link resolveWorktreeState} with the version-gated loader. */
export function worktreeState(worktreeRoot: string): Promise<WorktreeState> {
  return resolveWorktreeState(worktreeRoot, configFromSource);
}

/** {@link resolveWorktreeState} with the read-only projection (watch, review floors). */
export function readOnlyWorktreeState(worktreeRoot: string): Promise<WorktreeState> {
  return resolveWorktreeState(worktreeRoot, readOnlyProjectConfigFromSource);
}
