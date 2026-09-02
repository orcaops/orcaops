import { type CredentialStore } from '@orcaops/sdk';

import { EnvStore, envTokenIsSet } from './env-store.js';
import { FileStore } from './file-store.js';
import { KeyringStore } from './keyring-store.js';

/** Set `ORCAOPS_CREDENTIAL_STORE=keyring` to opt into the OS keychain. */
const STORE_OVERRIDE = 'ORCAOPS_CREDENTIAL_STORE';

/**
 * Pick the credential store the CLI should use right now.
 *
 * Priority (first match wins):
 *   1. `ORCAOPS_TOKEN` env var present? → {@link EnvStore} (read-only, no refresh)
 *   2. `ORCAOPS_CREDENTIAL_STORE=keyring` AND the keychain is reachable →
 *      {@link KeyringStore} (opt-in for the security-conscious)
 *   3. Otherwise → {@link FileStore} (the default)
 *
 * File store is the default for EVERY context — TTY, headless, CI, SSH — by
 * design, not as a headless fallback. orcaops runs under non-interactive
 * coding agents and CI containers, which can't drive an interactive OS keyring
 * (macOS prompts per-binary, Linux needs an unlocked D-Bus session, containers
 * have none). And a live agent already holds UID-level read access — it
 * executes untrusted model output + dependencies — so keyring encryption-at-
 * rest barely shifts the threat model: the real risk is mid-run exfiltration,
 * not cold-disk theft, and blast radius is bounded server-side via token
 * TTL/scope/rotation. The keyring stays opt-in (`ORCAOPS_CREDENTIAL_STORE=
 * keyring`) for the offline-disk-theft case only. A `0600` file under
 * `~/.config` matches gh / aws / gcloud / kubectl.
 */
export function resolveCredentialStore(): CredentialStore {
  if (envTokenIsSet()) return new EnvStore();
  if (process.env[STORE_OVERRIDE] === 'keyring' && KeyringStore.isAvailable()) {
    return new KeyringStore();
  }
  return new FileStore();
}
