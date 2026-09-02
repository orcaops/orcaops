import type { Entry as KeyringEntry } from '@napi-rs/keyring';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  type CredentialStore,
  type CredentialStoreKind,
  type StoredCredentials,
} from '@orcaops/sdk';

import { defaultConfigDir } from './file-store.js';
import { PersistedOAuthCredentialsSchema } from './persisted-credentials.js';
import { withRefreshLock as runWithRefreshLock } from './refresh-lock.js';

const SERVICE_NAME = 'orcaops';

/**
 * Lazily load the native `Entry` constructor. `@napi-rs/keyring` links the OS
 * secret backend (libsecret on Linux) at load time, so importing it eagerly
 * would crash startup on hosts without that backend — even for users on the
 * default {@link FileStore} who never touch the keyring. The keyring is opt-in
 * (`ORCAOPS_CREDENTIAL_STORE=keyring`) and declared an OPTIONAL dependency, so
 * the `require` is deferred to the first `Entry` construction. Synchronous, so
 * `isAvailable()` and `resolveCredentialStore()` stay sync; it throws when the
 * optional module is absent or its backend fails to load, which callers treat
 * as "keyring unavailable".
 */
type NativeEntryCtor = typeof import('@napi-rs/keyring').Entry;
const requireNative = createRequire(import.meta.url);
let cachedEntryCtor: NativeEntryCtor | undefined;
function loadEntryCtor(): NativeEntryCtor {
  return (cachedEntryCtor ??= requireNative('@napi-rs/keyring').Entry as NativeEntryCtor);
}

/**
 * OS keychain credential store via @napi-rs/keyring (gnome-keyring / kwallet
 * on Linux, Keychain Access on macOS, Credential Manager on Windows). One
 * keyring entry per `baseUrl` so a host can hold staging + prod + self-hosted
 * creds in parallel — same shape as {@link FileStore} but backed by the OS
 * secret store.
 *
 * Single JSON-encoded blob per entry → one OS permission prompt on first
 * use rather than one per field.
 *
 * `isAvailable()` is a static probe: round-trip a unique throwaway secret to
 * confirm the OS keychain backend is reachable. Headless Linux (no DBus) and
 * locked-keychain hosts return `false`, letting `resolveCredentialStore`
 * fall through to {@link FileStore} cleanly.
 */
export class KeyringStore implements CredentialStore {
  readonly kind: CredentialStoreKind = 'keyring';

  private readonly serviceName: string;

  constructor(opts: { serviceName?: string } = {}) {
    this.serviceName = opts.serviceName ?? SERVICE_NAME;
  }

  read(baseUrl: string): StoredCredentials | null {
    let raw: string | null;
    try {
      raw = this.entry(baseUrl).getPassword();
    } catch (cause) {
      throw new KeyringStoreError(`failed to read entry for ${baseUrl}`, { cause });
    }
    if (raw == null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new KeyringStoreError(`keychain entry for ${baseUrl} is not valid JSON`, { cause });
    }
    const result = PersistedOAuthCredentialsSchema.safeParse(parsed);
    if (!result.success) {
      throw new KeyringStoreError(
        `keychain entry for ${baseUrl} failed validation: ${result.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`
      );
    }
    if (result.data.baseUrl !== baseUrl) {
      throw new KeyringStoreError(
        `keychain entry for ${baseUrl} contains credentials for ${result.data.baseUrl}`
      );
    }
    return result.data;
  }

  write(baseUrl: string, credentials: StoredCredentials): void {
    if (credentials.baseUrl !== baseUrl) {
      throw new KeyringStoreError(
        `credentials.baseUrl (${credentials.baseUrl}) does not match write key (${baseUrl})`
      );
    }
    const result = PersistedOAuthCredentialsSchema.safeParse(credentials);
    if (!result.success) {
      throw new KeyringStoreError(
        `credentials failed validation: ${result.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`
      );
    }
    try {
      this.entry(baseUrl).setPassword(JSON.stringify(result.data));
    } catch (cause) {
      throw new KeyringStoreError(`failed to write entry for ${baseUrl}`, { cause });
    }
  }

  clear(baseUrl: string): void {
    try {
      this.entry(baseUrl).deletePassword();
    } catch {
      // The native binding throws when the entry doesn't exist; treat as
      // idempotent. We can't distinguish "absent" from "backend unavailable"
      // by error class here, but read() / write() will surface the latter
      // on their next call — keeping clear() throw-free preserves the
      // logout-flow contract that local clear MUST always succeed.
    }
  }

  /**
   * Cross-process token-refresh critical section. The keychain has no directory
   * of its own, so the lock lives under the user's config home rather than a
   * predictable shared-temp parent. Keyring users with concurrent subagents get
   * the same single-flight protection as the file store.
   */
  async withRefreshLock<T>(baseUrl: string, fn: () => Promise<T>): Promise<T> {
    // PER-BASE-URL, unlike the file store. The keychain holds one independent
    // entry per base URL (see the class doc), so there is no shared file to
    // lose an update to — the only thing needing serialization is one cloud's
    // own refresh. A service-wide lock here would let a slow cloud time out
    // an unrelated one for no safety gain.
    const key = createHash('sha256').update(baseUrl).digest('hex').slice(0, 16);
    const serviceKey = createHash('sha256').update(this.serviceName).digest('hex').slice(0, 16);
    const lockDir = path.join(defaultConfigDir(), 'keyring-refresh-locks', serviceKey, key);
    return runWithRefreshLock(lockDir, fn);
  }

  /**
   * Round-trip a throwaway secret to confirm the OS keychain backend is
   * reachable. Cheap (~ms), called once at resolver time. Probe service is
   * `<serviceName>-probe` so a stray failure leaves no debris in the real
   * `orcaops` namespace.
   */
  static isAvailable(opts: { serviceName?: string } = {}): boolean {
    const probeService = `${opts.serviceName ?? SERVICE_NAME}-probe`;
    const probeAccount = `availability-${randomUUID()}`;
    let probe: KeyringEntry;
    try {
      probe = new (loadEntryCtor())(probeService, probeAccount);
    } catch {
      // Optional native module absent, or its OS secret backend failed to load
      // (e.g. no libsecret / locked D-Bus session). Keyring is unavailable; the
      // resolver falls through to FileStore.
      return false;
    }
    let setSucceeded = false;
    try {
      probe.setPassword('1');
      setSucceeded = true;
      const got = probe.getPassword();
      return got === '1';
    } catch {
      return false;
    } finally {
      // Cleanup in `finally` so a throw between setPassword and getPassword
      // (e.g. gnome-keyring lock contention, network mount weirdness)
      // doesn't leave the throwaway secret in the user's keychain. We only
      // attempt the delete if the set actually succeeded — calling
      // deletePassword on a never-written account would throw a confusing
      // "not found" that swallows the actual failure cause.
      if (setSucceeded) {
        try {
          probe.deletePassword();
        } catch {
          // Best-effort cleanup; the next probe will overwrite anyway.
        }
      }
    }
  }

  private entry(baseUrl: string): KeyringEntry {
    return new (loadEntryCtor())(this.serviceName, baseUrl);
  }
}

export class KeyringStoreError extends Error {
  readonly name = 'KeyringStoreError';
  constructor(reason: string, options?: ErrorOptions) {
    super(`KeyringStore: ${reason}`, options);
  }
}
