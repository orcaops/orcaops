import path from 'node:path';

import {
  type ConfigLocation,
  configLocationForScope,
  type Repo,
  resolveConfigSource,
  worktreeConfigLocation,
} from '@orcaops/core';
import { type Config, ConfigValidationError, resolveConfig } from '@orcaops/storage';

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

export function refuseTrackedPersonalTransition(tracked: readonly string[]): OrcaopsError {
  return new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `this checkout carries committed orcaops file(s) (${tracked.join(', ')}), so moving it to ` +
      'personal scope edits tracked files. Run `orcaops update --scope personal`, which plans ' +
      'that removal and leaves the diff for you to review and commit.'
  );
}
