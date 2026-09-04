import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  COMMON_PERSONAL_MANIFEST_FILE,
  commonOrcaopsDirFrom,
  resolveCommonDir,
} from '@orcaops/core';
import { assertResolvedWithin, PathContainmentError } from '@orcaops/storage';

import { PERSONAL_EXCLUDE_LINES } from './git-info-exclude.js';
import {
  type LocalManifest,
  localManifestSchema,
  normalizeLocalManifest,
  readLocalManifest,
} from './install-manifest.js';
import { type PlannedMutation, writeMutation } from './mutations.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * The personal-scope ownership manifest: `<common>/orcaops/personal-manifest.json`.
 * Same schema as the worktree `install.local.json`, but repository-wide —
 * it records the global materialization and is the single owner of the
 * managed `info/exclude` lines, which also live in the common dir. Fresh
 * personal scope writes no worktree manifest at all.
 */
export interface PersonalManifestLocation {
  manifestPath: string;
  /** The canonical git common dir. */
  containmentRoot: string;
}

export async function personalManifestLocation(
  worktreeRoot: string
): Promise<PersonalManifestLocation> {
  const commonDir = await resolveCommonDir(worktreeRoot);
  return {
    manifestPath: path.join(commonOrcaopsDirFrom(commonDir), COMMON_PERSONAL_MANIFEST_FILE),
    containmentRoot: commonDir,
  };
}

export type PersonalManifestState =
  | { kind: 'absent'; location: PersonalManifestLocation }
  | {
      kind: 'valid';
      location: PersonalManifestLocation;
      manifest: LocalManifest;
      content: string;
    }
  /** A safely contained regular file whose body is not a manifest — init replaces it. */
  | { kind: 'stale'; location: PersonalManifestLocation; content: string; reason: string };

function unsafeManifest(manifestPath: string, why: string): OrcaopsError {
  // Never "run orcaops update": an uninitialized repository has nothing to
  // update, and the only safe way past an unreadable ownership file is to
  // remove it by hand and install afresh.
  return new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `${manifestPath} ${why}. Inspect and remove it, then rerun \`orcaops init --personal\`.`,
    'personal manifest'
  );
}

/**
 * Read the common manifest without ever trusting it blindly: a symlink, a
 * non-regular file, or a containment failure fails closed with the manual
 * recovery; a regular file that does not parse or validate is reported as
 * `stale` so a fresh init can replace it instead of looping the user back
 * to the same refusal.
 */
export async function readPersonalManifestState(
  worktreeRoot: string
): Promise<PersonalManifestState> {
  const location = await personalManifestLocation(worktreeRoot);
  let safePath: string;
  try {
    safePath = assertResolvedWithin(
      location.manifestPath,
      location.containmentRoot,
      'personal manifest',
      { rejectSymlinks: true }
    );
  } catch (err) {
    if (err instanceof PathContainmentError) {
      throw unsafeManifest(location.manifestPath, 'is not safely contained in the git common dir');
    }
    throw err;
  }
  let stats;
  try {
    stats = await lstat(safePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent', location };
    throw err;
  }
  if (stats.isSymbolicLink()) throw unsafeManifest(location.manifestPath, 'is a symlink');
  if (!stats.isFile()) throw unsafeManifest(location.manifestPath, 'is not a regular file');
  const content = await readFile(safePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      kind: 'stale',
      location,
      content,
      reason: `not valid JSON: ${(err as Error).message}`,
    };
  }
  const result = localManifestSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'stale', location, content, reason: 'not a valid personal manifest' };
  }
  return { kind: 'valid', location, manifest: normalizeLocalManifest(result.data), content };
}

/** The valid common manifest, or null when absent or stale. */
export async function readPersonalManifest(worktreeRoot: string): Promise<LocalManifest | null> {
  const state = await readPersonalManifestState(worktreeRoot);
  return state.kind === 'valid' ? state.manifest : null;
}

/**
 * The ownership manifest a scope reads its prior install from: the common
 * one under personal, the worktree one otherwise. Callers pass the scope the
 * PRIOR install was made under — on a transition that is where its entries
 * were recorded.
 */
export async function readEffectiveLocalManifest(
  worktreeRoot: string,
  scope: 'project' | 'global' | 'personal'
): Promise<LocalManifest | null> {
  return scope === 'personal'
    ? readPersonalManifest(worktreeRoot)
    : readLocalManifest(worktreeRoot);
}

/** True when the common manifest claims the `.orcaops/` exclusion. */
export async function personalManifestClaimsExclude(worktreeRoot: string): Promise<boolean> {
  const state = await readPersonalManifestState(worktreeRoot);
  if (state.kind === 'stale') {
    throw unsafeManifest(
      state.location.manifestPath,
      `cannot prove exclusion ownership because it is stale (${state.reason})`
    );
  }
  return (
    state.kind === 'valid' &&
    (state.manifest.info_exclude ?? []).some((line) => PERSONAL_EXCLUDE_LINES.includes(line))
  );
}

/**
 * The managed `info/exclude` lines this repository should carry now. Shared
 * by every reconciler (install planner, drift, doctor) so they cannot
 * disagree. The block stays while ANY worktree is personal — the exclude file
 * is common state, so a sibling switching to project scope must not expose
 * the others' stores — and while the manifest still claims it after an
 * uninstall.
 */
export async function desiredPersonalExcludeLines(
  worktreeRoot: string,
  scope: 'project' | 'global' | 'personal'
): Promise<string[]> {
  if (scope === 'personal') return [...PERSONAL_EXCLUDE_LINES];
  return (await personalManifestClaimsExclude(worktreeRoot)) ? [...PERSONAL_EXCLUDE_LINES] : [];
}

export function personalManifestJson(manifest: LocalManifest): string {
  return `${JSON.stringify(normalizeLocalManifest(manifest), null, 2)}\n`;
}

/** A write of the common manifest, contained in the git common dir. */
export function planPersonalManifestWrite(
  worktreeRoot: string,
  location: PersonalManifestLocation,
  manifest: LocalManifest,
  currentContent: string | null
): PlannedMutation {
  const desired = personalManifestJson(manifest);
  return writeMutation(
    worktreeRoot,
    path.relative(worktreeRoot, location.manifestPath),
    desired,
    currentContent,
    desired !== currentContent,
    location.containmentRoot,
    location.manifestPath
  );
}

/** What uninstall keeps: no entries, only the exclusion it still owns. */
export function retainedPersonalManifest(prior: LocalManifest): LocalManifest {
  return {
    manifest_version: prior.manifest_version,
    entries: [],
    info_exclude: [...PERSONAL_EXCLUDE_LINES],
  };
}
