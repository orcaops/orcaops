import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { type ShellKey, shellKeyId, ShellKeySchema } from './shell-key.js';
import { canonicalJson } from '../events/canonical-json.js';
import { fsyncDir, mkdirDurable, writeDurable } from '../fs/durable.js';
import { ArtifactLock } from '../locks.js';

/**
 * Pin file.
 *
 * Pins live OUTSIDE the repo (`$XDG_STATE_HOME/orcaops/pins/...`) so
 * they're never committed and never carried by clones.
 */
export const PinSchema = z.object({
  schema_version: z.literal(1),
  artifact_id: z.string().min(1),
  branch: z.string().min(1),
  shell_key: ShellKeySchema,
  pinned_at: z.string().datetime(),
  pinned_via: z.enum(['auto-on-capture-plan', 'explicit-checkout']),
});
export type Pin = z.infer<typeof PinSchema>;

/** Absolute path to the pin store root (`<XDG-state>/orcaops/pins`). */
export function pinStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) return path.join(xdg, 'orcaops', 'pins');
  return path.join(homedir(), '.local', 'state', 'orcaops', 'pins');
}

/** Absolute path to the per-repo pin directory. */
export function pinRepoDir(repoId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(pinStoreRoot(env), repoId);
}

/** Absolute path to the pin file for a given (repo, shell-key) pair. */
export function pinFilePath(
  repoId: string,
  key: ShellKey,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(pinRepoDir(repoId, env), `${shellKeyId(key)}.json`);
}

export interface PinIoOptions {
  repoId: string;
  env?: NodeJS.ProcessEnv;
}

export interface LockedPinFile {
  file: string;
  assertLease(): Promise<void>;
  read(): Promise<Pin | null>;
  write(pin: Pin): Promise<string>;
  clear(): Promise<boolean>;
}

/** Stable compare token for pin CAS operations. */
export function pinIdentity(pin: Pin): string {
  return createHash('sha256')
    .update(canonicalJson(PinSchema.parse(pin)))
    .digest('hex');
}

/**
 * Serialize a complete read/compare/write or read/compare/delete operation for
 * one repo + shell key. Callers that need a multi-step CAS use the locked
 * methods; the simple read/write/clear helpers below use the same lock.
 */
export async function withPinFileLock<T>(
  opts: PinIoOptions & { key: ShellKey },
  fn: (pinFile: LockedPinFile) => Promise<T>
): Promise<T> {
  if (opts.key.kind === 'none') {
    throw new Error('Cannot lock pin: shell_key.kind is "none" (no pin possible).');
  }
  const repoDir = pinRepoDir(opts.repoId, opts.env);
  await mkdirDurable(repoDir, 0o700, pinStoreRoot(opts.env));
  const file = pinFilePath(opts.repoId, opts.key, opts.env);
  const lock = new ArtifactLock({
    locksDir: path.join(repoDir, '.locks'),
    containmentRoot: repoDir,
    heartbeatIntervalMs: 30_000,
  });
  return lock.withLock(shellKeyId(opts.key), async (lease) => {
    const readLocked = async (): Promise<Pin | null> => {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      try {
        const result = PinSchema.safeParse(JSON.parse(raw));
        return result.success ? result.data : null;
      } catch {
        return null;
      }
    };
    const result = await fn({
      file,
      assertLease: () => lease.verify(),
      read: readLocked,
      write: async (pin) => {
        const parsed = PinSchema.parse(pin);
        if (shellKeyId(parsed.shell_key) !== shellKeyId(opts.key)) {
          throw new Error('Locked pin write shell key does not match the acquired pin lock.');
        }
        await lease.verify();
        const temp = `${file}.tmp.${process.pid}.${randomUUID()}`;
        try {
          await writeDurable(temp, canonicalJson(parsed), 0o600, repoDir);
          await rename(temp, file);
          await fsyncDir(repoDir, repoDir);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
        return file;
      },
      clear: async () => {
        await lease.verify();
        try {
          await rm(file, { force: false });
          // A failed directory fsync can only make this stale pin reappear
          // after a crash. The unlink has already committed for this process,
          // so reporting refusal would make GC's progress envelope untruthful.
          await fsyncDir(repoDir, repoDir).catch(() => {});
          return true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw err;
        }
      },
    });
    await lease.verify();
    return result;
  });
}

/**
 * Read the pin for the given shell-key. Returns null when the file is
 * missing, malformed, or the shell-key is `kind: 'none'` (no pin
 * possible from a shell with no resolvable key).
 */
export async function readPin(opts: PinIoOptions & { key: ShellKey }): Promise<Pin | null> {
  if (opts.key.kind === 'none') return null;
  try {
    await lstat(pinFilePath(opts.repoId, opts.key, opts.env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return withPinFileLock(opts, (pinFile) => pinFile.read());
}

/**
 * Write a pin file. Returns the absolute path written. Throws if the
 * pin's `shell_key.kind` is `none`. Caller is expected to pre-resolve
 * the shell-key and reject `none` with an actionable error.
 */
export async function writePin(pin: Pin, opts: PinIoOptions): Promise<string> {
  if (pin.shell_key.kind === 'none') {
    throw new Error('Cannot write pin: shell_key.kind is "none" (no pin possible).');
  }
  const parsed = PinSchema.parse(pin);
  return withPinFileLock({ ...opts, key: parsed.shell_key }, (pinFile) => pinFile.write(parsed));
}

/**
 * Delete the pin for the given shell-key. Returns true if a file was
 * removed, false if there was nothing to remove (idempotent). `none`
 * shell-keys silently return false.
 */
export async function clearPin(opts: PinIoOptions & { key: ShellKey }): Promise<boolean> {
  if (opts.key.kind === 'none') return false;
  return withPinFileLock(opts, (pinFile) => pinFile.clear());
}

/**
 * List every pin for a repo across all shell-keys. Used by status,
 * doctor, and gc. Malformed files are skipped silently — the doctor's
 * stale-pin check is the place to surface them.
 */
export async function listPinsForRepo(opts: PinIoOptions): Promise<Pin[]> {
  const dir = pinRepoDir(opts.repoId, opts.env);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const pins: Pin[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(path.join(dir, name), 'utf8');
      const parsed = PinSchema.safeParse(JSON.parse(raw));
      if (parsed.success) pins.push(parsed.data);
    } catch {
      // skip unreadable / malformed
    }
  }
  return pins;
}
