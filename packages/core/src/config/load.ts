import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertConfigVersionCurrent,
  assertResolvedWithin,
  type Config,
  getDefaultConfig,
  resolveConfig,
} from '@orcaops/storage';

const CONFIG_RELATIVE_PATH = path.join('.orcaops', 'config.json');

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

async function readConfigJson(
  repoRoot: string,
  opts: LoadConfigOptions
): Promise<unknown | undefined> {
  const { allowMissing = true } = opts;
  const configPath = path.join(repoRoot, CONFIG_RELATIVE_PATH);
  const safeConfigPath = assertResolvedWithin(configPath, repoRoot, 'orcaops configuration', {
    rejectSymlinks: true,
  });

  let raw: string;
  try {
    raw = await readFile(safeConfigPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && allowMissing) return undefined;
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Load and validate `.orcaops/config.json` from a repo root, deep-merged
 * with built-in defaults. Returns a fully-defaulted Config even when no
 * file exists.
 */
export async function loadConfig(repoRoot: string, opts: LoadConfigOptions = {}): Promise<Config> {
  const json = await readConfigJson(repoRoot, opts);
  if (json === undefined) return getDefaultConfig();

  // Exactly the current schema version loads; mismatches reject with
  // regeneration or upgrade guidance, and nothing is ever written back.
  assertConfigVersionCurrent(json);
  return resolveConfig(json);
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
 */
export async function loadReadOnlyProjectConfig(
  repoRoot: string,
  opts: LoadConfigOptions = {}
): Promise<Config> {
  const json = await readConfigJson(repoRoot, opts);
  if (json === undefined) return getDefaultConfig();
  return resolveConfig(projectReadOnlyConfig(json));
}

export function getConfigPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_RELATIVE_PATH);
}
