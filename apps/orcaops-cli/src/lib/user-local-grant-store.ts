import type { Stats } from 'node:fs';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';

import { defaultConfigDir, FileStore } from '@orcaops/core';
import { resolveCanonicalPath } from '@orcaops/storage';

import { isInsideRepositoryWorktree } from './repository-worktree-containment.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * Mechanics shared by the user-local consent stores. Each store is one JSON
 * file in the config home, beside credentials.json and outside every
 * repository. A store that resolves inside the repository would let checked-in
 * content mint consent, so reads of one yield nothing and writes are refused.
 */

export type GrantStoreRefusalReason = 'repository_root_invalid' | 'store_not_outside_repository';

export type GrantStoreResolution =
  | { ok: true; dir: string }
  | { ok: false; reason: GrantStoreRefusalReason; requestedDir: string };

/** Resolves the canonical store directory without creating or changing anything. */
export function resolveGrantStoreDir(opts: {
  repoRoot: string;
  configDir?: string;
}): GrantStoreResolution {
  const requestedDir = opts.configDir ?? defaultConfigDir();
  const resolvedRepo = resolveRepositoryRoot(opts.repoRoot);
  if (resolvedRepo === null) return { ok: false, reason: 'repository_root_invalid', requestedDir };
  const dir = resolveGrantStoreOutsideRepository(requestedDir, resolvedRepo);
  if (dir === null) return { ok: false, reason: 'store_not_outside_repository', requestedDir };
  return { ok: true, dir };
}

export function requireGrantStoreDir(
  opts: { repoRoot: string; configDir?: string },
  storeLabel: string
): string {
  const resolution = resolveGrantStoreDir(opts);
  if (resolution.ok) return resolution.dir;
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    resolution.reason === 'repository_root_invalid'
      ? `cannot validate ${storeLabel}: repository root ${JSON.stringify(opts.repoRoot)} ` +
          `must be an existing absolute directory`
      : `refusing to mutate ${storeLabel} at ${JSON.stringify(resolution.requestedDir)}: the grant store ` +
          `must be an absolute location outside the repository`
  );
}

function resolveRepositoryRoot(repoRoot: string): string | null {
  if (!path.isAbsolute(repoRoot)) return null;
  try {
    const resolvedRepo = realpathSync(repoRoot);
    return statSync(resolvedRepo).isDirectory() ? resolvedRepo : null;
  } catch {
    return null;
  }
}

function resolveGrantStoreOutsideRepository(
  configDir: string,
  resolvedRepo: string
): string | null {
  if (!path.isAbsolute(configDir)) return null;
  try {
    const resolvedDir = resolveCanonicalPath(configDir, 'grant store');
    const relative = path.relative(resolvedRepo, resolvedDir);
    const insideBySpelling =
      relative === '' ||
      (relative !== '..' && !path.isAbsolute(relative) && !relative.startsWith('..' + path.sep));
    if (insideBySpelling || isInsideRepositoryWorktree(resolvedDir, resolvedRepo)) return null;
    return resolvedDir;
  } catch {
    return null;
  }
}

function currentUid(): number | null {
  return process.platform !== 'win32' && typeof process.getuid === 'function'
    ? process.getuid()
    : null;
}

function ownershipProblem(observed: Stats, target: string): string | null {
  const uid = currentUid();
  return uid !== null && observed.uid !== uid
    ? `${target} is owned by uid ${observed.uid}, not the current uid ${uid}.`
    : null;
}

function assertOwnedByCurrentUser(observed: Stats, target: string): void {
  const problem = ownershipProblem(observed, target);
  if (problem !== null) throw new Error(problem);
}

function ensureGrantDirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const observed = statSync(dir);
  assertOwnedByCurrentUser(observed, dir);
  if ((observed.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  const repaired = statSync(dir);
  assertOwnedByCurrentUser(repaired, dir);
  if ((repaired.mode & 0o077) !== 0) {
    throw new Error(`${dir} could not be tightened to mode 700.`);
  }
}

function repairGrantState(dir: string, file: string): void {
  let directory;
  try {
    directory = statSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!directory.isDirectory()) throw new Error(`${dir} is not a directory.`);
  assertOwnedByCurrentUser(directory, dir);
  if (process.platform !== 'win32' && (directory.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
  const repairedDirectory = statSync(dir);
  if (!repairedDirectory.isDirectory()) throw new Error(`${dir} is not a directory.`);
  assertOwnedByCurrentUser(repairedDirectory, dir);
  if (process.platform !== 'win32' && (repairedDirectory.mode & 0o077) !== 0) {
    throw new Error(`${dir} could not be tightened to mode 700.`);
  }

  let grantFile;
  try {
    grantFile = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!grantFile.isFile()) throw new Error(`${file} is not a regular file.`);
  assertOwnedByCurrentUser(grantFile, file);
  if (process.platform !== 'win32' && (grantFile.mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
    const repaired = lstatSync(file);
    if (!repaired.isFile()) throw new Error(`${file} is not a regular file.`);
    assertOwnedByCurrentUser(repaired, file);
    if ((repaired.mode & 0o077) !== 0) {
      throw new Error(`${file} could not be tightened to mode 600.`);
    }
  }
}

export interface GrantStateFinding {
  /**
   * `readable_by_others` exposes the contents but cannot have changed them.
   * `writable_by_others` means another user could have written the contents,
   * so tightening the mode afterwards does not make them trustworthy.
   */
  kind: 'unsafe' | 'readable_by_others' | 'writable_by_others';
  message: string;
}

/**
 * Judges ownership, type and mode and changes nothing. An absent directory or
 * file is not a finding. Each mode finding says how to put it right.
 */
export function inspectGrantState(dir: string, file: string): GrantStateFinding[] {
  let directory: Stats;
  try {
    directory = statSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ kind: 'unsafe', message: `${dir} could not be inspected.` }];
  }
  if (!directory.isDirectory()) return [{ kind: 'unsafe', message: `${dir} is not a directory.` }];

  let grantFile: Stats | null = null;
  try {
    grantFile = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return [{ kind: 'unsafe', message: `${file} could not be inspected.` }];
    }
  }

  const findings = ownerAndModeFindings(directory, dir, {
    whenReadable: `which lets other users reach it. Run \`chmod 700 ${JSON.stringify(dir)}\`.`,
    whenWritable:
      `which lets other users replace the files in it, so nothing in it can be trusted. ` +
      `Run \`chmod 700 ${JSON.stringify(dir)}\`` +
      (grantFile === null
        ? ` before granting consent.`
        : `, move ${file} aside, and grant consent again.`),
  });
  if (grantFile === null) return findings;
  if (!grantFile.isFile()) {
    return [...findings, { kind: 'unsafe', message: `${file} is not a regular file.` }];
  }
  return [
    ...findings,
    ...ownerAndModeFindings(grantFile, file, {
      whenReadable: `which lets other users read it. Run \`chmod 600 ${JSON.stringify(file)}\`.`,
      whenWritable:
        `which lets other users write it, so its contents cannot be trusted. ` +
        `Move it aside and grant consent again.`,
    }),
  ];
}

function ownerAndModeFindings(
  observed: Stats,
  target: string,
  remedy: { whenReadable: string; whenWritable: string }
): GrantStateFinding[] {
  const findings: GrantStateFinding[] = [];
  const owner = ownershipProblem(observed, target);
  if (owner !== null) findings.push({ kind: 'unsafe', message: owner });
  if (process.platform !== 'win32' && (observed.mode & 0o077) !== 0) {
    const writable = (observed.mode & 0o022) !== 0;
    findings.push({
      kind: writable ? 'writable_by_others' : 'readable_by_others',
      message:
        `${target} has mode ${(observed.mode & 0o777).toString(8)}, ` +
        (writable ? remedy.whenWritable : remedy.whenReadable),
    });
  }
  return findings;
}

export type GrantFileRead<Contents> =
  | { status: 'absent' }
  | { status: 'unsafe'; findings: GrantStateFinding[] }
  | { status: 'unparseable' }
  | { status: 'invalid' }
  | { status: 'ok'; contents: Contents };

/**
 * Reads one store file, never inferring consent from state it cannot vouch
 * for. `repair` tightens widened modes before reading and re-verifies them;
 * `inspect` changes nothing and yields no contents from a widened store.
 */
export function readGrantFile<Contents>(
  dir: string,
  file: string,
  schema: z.ZodType<Contents>,
  unsafeState: 'repair' | 'inspect'
): GrantFileRead<Contents> {
  if (unsafeState === 'repair') {
    try {
      repairGrantState(dir, file);
    } catch (error) {
      return {
        status: 'unsafe',
        findings: [{ kind: 'unsafe', message: (error as Error).message }],
      };
    }
  } else {
    const findings = inspectGrantState(dir, file);
    if (findings.length > 0) return { status: 'unsafe', findings };
  }
  if (!existsSync(file)) return { status: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { status: 'unparseable' };
  }
  const result = schema.safeParse(parsed);
  return result.success ? { status: 'ok', contents: result.data } : { status: 'invalid' };
}

function writeGrantBytesDurable(dir: string, file: string, contents: string | Uint8Array): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    const staged = statSync(tmp);
    assertOwnedByCurrentUser(staged, tmp);
    if (process.platform !== 'win32' && (staged.mode & 0o777) !== 0o600) {
      throw new Error(`${tmp} could not be restricted to mode 600.`);
    }
    renameSync(tmp, file);
    fsyncDirectory(dir);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The rename consumed it, or creation failed before the temp existed.
    }
    throw error;
  }
  repairGrantState(dir, file);
}

function restoreGrantSnapshot(dir: string, file: string, snapshot: Buffer | null): void {
  if (snapshot !== null) {
    writeGrantBytesDurable(dir, file, snapshot);
    return;
  }
  try {
    unlinkSync(file);
    fsyncDirectory(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number;
  try {
    fd = openSync(dir, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Some filesystems do not support directory fsync.
  } finally {
    closeSync(fd);
  }
}

/**
 * One read-modify-write of a store file under the config home's cross-process
 * lock. `plan` sees the repaired store and returns the bytes to write, or
 * `null` to leave the file alone; `commit` is the caller's paired change. If
 * the write or `commit` fails, the file is restored to the bytes it held when
 * the lock was taken, so the pair lands together or not at all.
 *
 * `dir` must already be the canonical directory from
 * {@link requireGrantStoreDir}: re-resolving the requested spelling under the
 * lock would follow an alias swapped in after containment was checked.
 *
 * `refuseState` lets a store throw on state it will not repair. It sees the
 * findings before the lock is taken as well as under it, because taking the
 * lock tightens the directory and would erase the evidence.
 */
export async function withGrantFileMutation<Planned, Result>(
  target: {
    dir: string;
    file: string;
    lockName: string;
    rollbackFailureMessage: string;
    refuseState?: (findings: GrantStateFinding[]) => void;
  },
  plan: () => { contents: string | null; planned: Planned },
  commit: (planned: Planned) => Promise<Result>
): Promise<{ planned: Planned; result: Result }> {
  const { dir, file } = target;
  target.refuseState?.(inspectGrantState(dir, file));
  const lock = new FileStore({ dir });
  return lock.withRefreshLock(target.lockName, async () => {
    target.refuseState?.(inspectGrantState(dir, file));
    ensureGrantDirPrivate(dir);
    repairGrantState(dir, file);
    const snapshot = existsSync(file) ? readFileSync(file) : null;
    const { contents, planned } = plan();

    try {
      if (contents !== null) writeGrantBytesDurable(dir, file, contents);
      return { planned, result: await commit(planned) };
    } catch (error) {
      try {
        restoreGrantSnapshot(dir, file, snapshot);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], target.rollbackFailureMessage);
      }
      throw error;
    }
  });
}
