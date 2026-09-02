import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  type CredentialStore,
  type CredentialStoreKind,
  type StoredCredentials,
} from '@orcaops/sdk';

import { PersistedOAuthCredentialsSchema } from './persisted-credentials.js';
import {
  type RefreshLockTiming,
  withRefreshLock as runWithRefreshLock,
  withRefreshLockSync,
} from './refresh-lock.js';

/**
 * On-disk credential store. One file at `<dir>/credentials.json` with a
 * top-level map keyed by `baseUrl` so a single host can hold staging,
 * production, and self-hosted credentials simultaneously. Mode 0600 is
 * re-applied on every write — even an in-place rewrite cannot widen
 * permissions.
 *
 * Default `dir`:
 *   `${XDG_CONFIG_HOME ?? "~/.config"}/orcaops`
 */

export class FileStore implements CredentialStore {
  readonly kind: CredentialStoreKind = 'file';

  private readonly dir: string;
  private readonly file: string;
  private readonly lockTiming: RefreshLockTiming;

  constructor(
    opts: {
      dir?: string;
      /** Refresh-lock timing overrides. Production omits these; tests tune them. */
      refreshLock?: RefreshLockTiming;
    } = {}
  ) {
    this.dir = opts.dir ?? defaultConfigDir();
    this.file = path.join(this.dir, 'credentials.json');
    this.lockTiming = opts.refreshLock ?? {};
  }

  read(baseUrl: string): StoredCredentials | null {
    const all = this.readAll();
    return all[baseUrl] ?? null;
  }

  /**
   * Every mutation is a read-modify-write of ONE file shared by all base
   * URLs, so each takes the store-wide lock. Without it, two concurrent
   * mutations for DIFFERENT clouds each read, each modify their own entry,
   * and the second write discards the first — leaving valid JSON with a dead
   * refresh token for the loser.
   */
  write(baseUrl: string, credentials: StoredCredentials): void {
    if (credentials.baseUrl !== baseUrl) {
      throw new FileStoreError(
        `credentials.baseUrl (${credentials.baseUrl}) does not match write key (${baseUrl})`
      );
    }
    const parsedCredentials = PersistedOAuthCredentialsSchema.safeParse(credentials);
    if (!parsedCredentials.success) {
      throw new FileStoreError(
        `credentials failed validation: ${formatValidationIssues(parsedCredentials.error.issues)}`
      );
    }
    withRefreshLockSync(
      this.dir,
      () => {
        const all = this.readAll();
        all[baseUrl] = parsedCredentials.data;
        this.writeAll(all);
      },
      this.lockTiming
    );
  }

  clear(baseUrl: string): void {
    withRefreshLockSync(
      this.dir,
      () => {
        const all = this.readAll();
        if (!(baseUrl in all)) return;
        delete all[baseUrl];
        if (Object.keys(all).length === 0) {
          try {
            unlinkSync(this.file);
            // Acknowledged deletion: without the directory sync a crash can
            // undo the unlink and the session reappears.
            fsyncDir(this.dir);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
          return;
        }
        this.writeAll(all);
      },
      this.lockTiming
    );
  }

  /** Removes the entire store file. Idempotent. Used by tests and `logout --all` flows. */
  clearAll(): void {
    withRefreshLockSync(
      this.dir,
      () => {
        try {
          unlinkSync(this.file);
          fsyncDir(this.dir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      },
      this.lockTiming
    );
  }

  /** Enumerate credential origins for explicit whole-store operations such as logout-all. */
  knownBaseUrls(): string[] {
    return Object.keys(this.readAll());
  }

  /**
   * Cross-process token-refresh critical section (consumed by the SDK's
   * `createAuthedCloudClient`). Delegates to the shared {@link runWithRefreshLock}
   * mkdir-lock in this store's dir — serializes refresh across the subagent
   * processes that share one file store, and fails closed on contention.
   */
  async withRefreshLock<T>(_baseUrl: string, fn: () => Promise<T>): Promise<T> {
    // The SDK passes a baseUrl, but the lock is store-wide by design: the
    // protected resource is the shared file, not one cloud's entry.
    return runWithRefreshLock(this.dir, fn, this.lockTiming);
  }

  private readAll(): Record<string, StoredCredentials> {
    repairModeOnRead(this.file, this.dir);
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new FileStoreError(`failed to parse ${this.file} as JSON`, { cause });
    }
    const result = StoreFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new FileStoreError(
        `${this.file} failed validation: ${result.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`
      );
    }
    return result.data;
  }

  private writeAll(all: Record<string, StoredCredentials>): void {
    ensureDirPrivate(this.dir);

    // Durable atomic replace. A torn write leaves credentials that fail
    // validation on next read, locking the user out with no automatic
    // recovery — and because a refresh ROTATES the token, losing the new
    // bytes after the server has already invalidated the old ones logs the
    // user out for real. rename(2) gives atomic VISIBILITY but no durability
    // (an earlier comment here claimed "fsync via rename", which conflated
    // the two), so the bytes are fsynced before the rename and the directory
    // entry is fsynced after it.
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(all, null, 2) + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      fsyncDir(this.dir);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // tmp may not exist if the open/write threw before creating it.
      }
      throw err;
    }
    enforceModeOnce(this.file);
  }
}

/**
 * Resolve the default config directory using XDG Base Directory Specification:
 * - `$XDG_CONFIG_HOME/orcaops` when XDG_CONFIG_HOME is set
 * - `$HOME/.config/orcaops` otherwise
 */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ORCAOPS_CONFIG_HOME;
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return path.join(xdg, 'orcaops');
  return path.join(homedir(), '.config', 'orcaops');
}

const StoreFileSchema = z
  .record(z.string(), PersistedOAuthCredentialsSchema)
  .superRefine((credentialsByBaseUrl, ctx) => {
    for (const [baseUrl, credentials] of Object.entries(credentialsByBaseUrl)) {
      if (credentials.baseUrl !== baseUrl) {
        ctx.addIssue({
          code: 'custom',
          path: [baseUrl, 'baseUrl'],
          message: `must match map key ${JSON.stringify(baseUrl)}`,
        });
      }
    }
  });

function formatValidationIssues(issues: z.core.$ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}

export class FileStoreError extends Error {
  readonly name = 'FileStoreError';
  constructor(reason: string, options?: ErrorOptions) {
    super(`FileStore: ${reason}`, options);
  }
}

/**
 * Belt-and-suspenders mode check on the file we just wrote. Some filesystems
 * (network mounts, FUSE) silently widen modes — surface that immediately
 * rather than letting the credential file sit world-readable.
 */
function enforceModeOnce(file: string): void {
  // Windows maps only the read-only attribute into st_mode, reporting 0o666
  // for any writable file, so this check can never hold there and would fail
  // every write. POSIX permissions are the thing being asserted.
  if (process.platform === 'win32') return;
  const observed = statSync(file).mode & 0o777;
  if (observed !== 0o600) {
    throw new FileStoreError(
      `wrote ${file} but observed mode ${observed.toString(8)} (expected 600); refusing to leave credentials world-readable`
    );
  }
}

/**
 * Create the credential directory private, and TIGHTEN it if it already
 * exists — `mkdir` applies its mode only to directories it creates, so a
 * pre-existing world-readable directory would otherwise keep its mode
 * forever.
 */
function ensureDirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Assert credential permissions on READ, not only on write: a file
 * widened out-of-band stays widened until the next write, which may never
 * come. Repairing rather than refusing is deliberate — refusing would strand
 * a user behind a manual chmod, and the store already self-heals a widened
 * file on rewrite. Only an unrepairable permission is fatal.
 */
function repairModeOnRead(file: string, dir: string): void {
  if (process.platform === 'win32') return;
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let mode: number;
  try {
    mode = statSync(file).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if ((mode & 0o077) === 0) return;
  try {
    chmodSync(file, 0o600);
  } catch (cause) {
    throw new FileStoreError(
      `${file} has mode ${mode.toString(8)} (group/other-accessible) and could not be tightened to 600`,
      { cause }
    );
  }
}

/** fsync a directory so a rename into it survives a crash. Best-effort: some
 *  platforms refuse to open a directory for this, and there is nothing to
 *  fall back to. */
function fsyncDir(dir: string): void {
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
    // Directory fsync unsupported on this filesystem.
  } finally {
    closeSync(fd);
  }
}
