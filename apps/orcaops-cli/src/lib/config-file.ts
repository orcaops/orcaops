import path from 'node:path';

import {
  type ConfigLocation,
  configLocationForScope,
  type Repo,
  resolveConfigSource,
  worktreeConfigLocation,
} from '@orcaops/core';
import {
  assertConfigVersionCurrent,
  type Config,
  ConfigValidationError,
  configVersionForWrite,
  getDefaultConfig,
  type KnowledgeProcessingConfig,
  resolveConfig,
} from '@orcaops/storage';

import { atomicWriteFile } from './atomic-write.js';
import { readRepositoryFileOrNull } from './mutations.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * How a config path is named to the user. A worktree config is shown
 * repo-relative, the way it always has been; the shared one is shown
 * absolute, because its repo-relative form (`../../.git/orcaops/config.json`
 * from a linked worktree) reads as a path traversal rather than a location.
 */
export function displayConfigPath(location: ConfigLocation, worktreeRoot: string): string {
  return location.origin === 'worktree'
    ? path.relative(worktreeRoot, location.configPath)
    : location.configPath;
}

export interface ConfigDocument {
  location: ConfigLocation;
  /** Repo-relative or absolute, per {@link displayConfigPath}. */
  displayPath: string;
  raw: Record<string, unknown>;
}

function uninitialized(displayPath: string): OrcaopsError {
  return new OrcaopsError(ErrorCodes.UNINITIALIZED, `${displayPath} does not exist.`);
}

async function readDocument(
  location: ConfigLocation,
  worktreeRoot: string
): Promise<ConfigDocument> {
  const displayPath = displayConfigPath(location, worktreeRoot);
  const raw = await readRepositoryFileOrNull(
    location.configPath,
    location.containmentRoot,
    'orcaops configuration'
  );
  if (raw === null) throw uninitialized(displayPath);
  return { location, displayPath, raw: JSON.parse(raw) as Record<string, unknown> };
}

/**
 * Open the config actually governing this worktree for a per-key edit. Reads
 * and writes are containment-checked against the source's OWN root, not the
 * worktree — the shared personal config lives outside every worktree, so a
 * worktree-rooted check would refuse to read the file it just selected.
 */
export async function openEffectiveConfig(worktreeRoot: string): Promise<ConfigDocument> {
  const source = await resolveConfigSource(worktreeRoot);
  if (source.kind === 'none') {
    throw uninitialized(displayConfigPath(worktreeConfigLocation(worktreeRoot), worktreeRoot));
  }
  return readDocument(source, worktreeRoot);
}

/** Open the config a write with this destination scope should target. */
export async function openConfigForScope(
  worktreeRoot: string,
  scope: 'project' | 'global' | 'personal'
): Promise<ConfigDocument> {
  return readDocument(await configLocationForScope(worktreeRoot, scope), worktreeRoot);
}

/** Persist a per-key edit back to the document it came from. */
export async function writeConfigDocument(document: ConfigDocument): Promise<void> {
  await atomicWriteFile(
    document.location.configPath,
    `${JSON.stringify(document.raw, null, 2)}\n`,
    document.location.containmentRoot
  );
}

export interface KnowledgeProcessingWritePlan {
  /** The opened document carrying the edited body, ready for {@link writeConfigDocument}. */
  document: ConfigDocument;
  config: Config;
  /** False when the edit leaves the file exactly as it is. */
  changed: boolean;
  /**
   * Set when the write moves the file to a version older orcaops builds refuse
   * to load. Under project scope the file is committed, so a caller must say
   * this before writing: every teammate on an older build is locked out until
   * they upgrade.
   */
  versionChange: { from: number; to: number } | null;
}

/**
 * Plan a `knowledge_processing` edit without writing. Only the named keys are
 * touched, and a key given as `undefined` is removed. The version stamp moves
 * in this same document, so the first write that adds the section is also the
 * one that makes an older build say "upgrade orcaops" instead of rejecting a
 * key it does not know. A file without the section stays without it when the
 * edit holds nothing but defaults: disabling what was never enabled must not
 * move the stamp. Throws ConfigValidationError, writing nothing, when the
 * result would not load.
 */
export function planKnowledgeProcessingWrite(
  document: ConfigDocument,
  settings: Partial<KnowledgeProcessingConfig>
): KnowledgeProcessingWritePlan {
  assertConfigVersionCurrent(document.raw);
  const hasSection = Object.prototype.hasOwnProperty.call(document.raw, 'knowledge_processing');
  const existing = document.raw.knowledge_processing;
  const section: Record<string, unknown> = {
    ...(typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? existing
      : {}),
  };
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete section[key];
    else section[key] = value;
  }

  const defaults: Record<string, unknown> = getDefaultConfig().knowledge_processing;
  const holdsOnlyDefaults = Object.entries(section).every(
    ([key, value]) =>
      Object.hasOwn(defaults, key) && JSON.stringify(value) === JSON.stringify(defaults[key])
  );
  if (!hasSection && holdsOnlyDefaults) {
    return {
      document,
      config: resolveConfig(document.raw),
      changed: false,
      versionChange: null,
    };
  }

  const from = document.raw.schema_version as number;
  const raw: Record<string, unknown> = { ...document.raw, knowledge_processing: section };
  const to = configVersionForWrite(raw, from);
  raw.schema_version = to;
  return {
    document: { ...document, raw },
    config: resolveConfig(raw),
    changed: JSON.stringify(raw) !== JSON.stringify(document.raw),
    versionChange: to === from ? null : { from, to },
  };
}

export async function writeKnowledgeProcessingSection(
  document: ConfigDocument,
  settings: Partial<KnowledgeProcessingConfig>
): Promise<KnowledgeProcessingWritePlan> {
  const plan = planKnowledgeProcessingWrite(document, settings);
  if (plan.changed) await writeConfigDocument(plan.document);
  return plan;
}

export function resolvePersonalConfigForAdoption(content: string, configPath: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_CONFIG,
      `${configPath} cannot be adopted because it is not valid JSON: ${(error as Error).message}`,
      'config'
    );
  }
  const install =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).install
      : undefined;
  const scope =
    typeof install === 'object' && install !== null && !Array.isArray(install)
      ? (install as Record<string, unknown>).scope
      : undefined;
  if (scope !== 'personal') {
    throw new OrcaopsError(
      ErrorCodes.INVALID_CONFIG,
      `${configPath} cannot be adopted because it does not explicitly declare install.scope "personal". The existing shared configuration was left unchanged.`,
      'install.scope'
    );
  }
  try {
    return resolveConfig(raw);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_CONFIG,
        `${configPath} cannot be adopted: ${error.message} The existing shared configuration was left unchanged.`,
        error.path
      );
    }
    throw error;
  }
}

/**
 * The tracked orcaops files a project→personal move would have to remove.
 * Personal scope promises zero tracked-file changes, so a transition that
 * would produce a committable diff has to be requested explicitly through
 * `orcaops update --scope personal`, which shows that diff, rather than
 * happening as a side effect of an `init --force` or a `configure` answer.
 */
export async function trackedProjectInstallPaths(
  repo: Repo,
  candidates: readonly string[]
): Promise<string[]> {
  try {
    return [...(await repo.listTrackedPaths(candidates))].sort();
  } catch {
    // A repo too broken to answer `ls-files` cannot prove a file is
    // orcaops-managed either; the mutation guards refuse it downstream.
    return [];
  }
}

export function refuseTrackedPersonalTransition(
  tracked: readonly string[],
  opts: { fromResetDefault?: boolean } = {}
): OrcaopsError {
  if (opts.fromResetDefault) {
    return new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--reset-config restores the personal-scope default, but this checkout carries ' +
        `committed orcaops file(s) (${tracked.join(', ')}) that moving to personal scope would edit. ` +
        'Re-run with `--scope project` to keep the committed project install, or run ' +
        '`orcaops update --scope personal` to plan that removal and review the diff.'
    );
  }
  return new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `this checkout carries committed orcaops file(s) (${tracked.join(', ')}), so moving it to ` +
      'personal scope edits tracked files. Run `orcaops update --scope personal`, which plans ' +
      'that removal and leaves the diff for you to review and commit.'
  );
}
