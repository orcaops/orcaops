import {
  createHardenedFetch,
  OutboundPolicyError,
  resolveCloudTarget,
  resolveCredentialStore,
  scrubAndBound,
} from '@orcaops/core';
import { createAuthedCloudClient } from '@orcaops/sdk';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';

export interface LogoutOptions {
  baseUrl?: string;
  json?: boolean;
  /** Logout from every cloud the store has credentials for; clears the entire file. */
  all?: boolean;
}

interface CredentialStoreWithEnumeration {
  read(baseUrl: string): unknown;
  clear(baseUrl: string): unknown;
  knownBaseUrls(): string[];
  clearAll(): void;
  withRefreshLock<T>(baseUrl: string, fn: () => Promise<T>): Promise<T>;
}

interface LogoutSummary {
  baseUrl: string;
  /**
   * True iff the cloud confirmed RT + AT revocation. False means the cloud
   * was unreachable, discovery failed, or one of the revoke POSTs returned
   * non-2xx. Named to contrast with `local_cleared`.
   */
  remote_revoked: boolean;
  /** Why the remote revoke did not complete; null on success or when no credential existed. */
  remote_revoke_failure: 'policy_refused' | 'request_failed' | null;
  /** Scrubbed, bounded diagnostic for the remote failure when one threw. */
  remote_revoke_error: string | null;
  /**
   * Did the credential actually leave this machine? Established by RE-READING
   * after the clear, not by the clear returning without error — the keyring
   * backend suppresses every deletion failure by design, so a silent success
   * there proves nothing.
   *
   * `null` means absence cannot be established. `local_clear_reason` says
   * which of the two causes applies; do not infer it from anything else.
   */
  local_cleared: boolean | null;
  /**
   * Why `local_cleared` holds what it holds. A discriminant rather than
   * something a consumer infers: `null` has two causes that need different
   * advice, and inferring them from whether `local_clear_error` is set was
   * simply wrong — the env store's `clear` THROWS by design, so the
   * read-only backend and a failed confirmation read produced identical
   * shapes.
   */
  local_clear_reason: 'cleared' | 'still_present' | 'read_only_backend' | 'unverifiable';
  /** Scrubbed reason the local clear failed, when it threw. */
  local_clear_error: string | null;
  alreadyLoggedOut: boolean;
}

/**
 * RFC 7009 revocation followed by an unconditional local clear.
 *
 * The SDK's `createAuthedCloudClient.logout()` is the single wire surface
 * for revoke. Internally it does two POSTs (`token_type_hint=refresh_token`
 * and `token_type_hint=access_token`), each carrying `client_id` for the
 * public-client auth posture. The cloud's `/oauth2/revoke` wrap cascades
 * `OauthAccessToken.revokedAt` from the RT revoke as a backstop. The
 * explicit AT POST is belt-and-suspenders.
 *
 * Local clear MUST always succeed — partial failure ('logged out but still
 * have creds on disk') is the worst possible UX. Server-side revoke is
 * best-effort; the local clear is unconditional.
 *
 * `--all` iterates every baseUrl the FileStore knows about and clears the
 * entire file. Useful for stuck multi-cloud setups where one host is
 * unreachable and the user wants a clean slate.
 */
export async function logoutAction(opts: LogoutOptions = {}): Promise<void> {
  try {
    const store = resolveCredentialStore();

    if (opts.all === true) {
      await logoutAllAction(store, opts);
      return;
    }

    const baseUrl = resolveCloudTarget(opts.baseUrl);

    const summary = await logoutOne(store, baseUrl);

    if (opts.json) {
      emitOk(summary);
      return;
    }
    if (summary.alreadyLoggedOut) {
      writeTerminalSafeStdout(`Not logged in to ${baseUrl}; nothing to do.\n`);
      return;
    }
    writeTerminalSafeStdout(describeLogout(summary));
  } catch (err) {
    emitError(err);
  }
}

/**
 * Run the whole logout under the store's refresh lock.
 *
 * The revoke is issued against the credential read at the START of this
 * function, so a concurrent refresh landing in between would leave us
 * revoking tokens the server has already rotated away from — a 200 response
 * and `remote_revoked: true` while the CURRENT refresh token stays valid, and
 * then a local clear that destroys it. The lock is the same one refreshes
 * take, so the two cannot interleave. It is re-entrant within this async
 * context, so the store's own sync-locked `clear` still works underneath.
 *
 * The env store has no lock and needs none: it holds no persistent state to
 * rotate.
 */
async function logoutOne(
  store: ReturnType<typeof resolveCredentialStore>,
  baseUrl: string
): Promise<LogoutSummary> {
  const run = (): Promise<LogoutSummary> => logoutOneLocked(store, baseUrl);
  return typeof store.withRefreshLock === 'function' ? store.withRefreshLock(baseUrl, run) : run();
}

async function logoutOneLocked(
  store: ReturnType<typeof resolveCredentialStore>,
  baseUrl: string
): Promise<LogoutSummary> {
  let hardenedFetch: typeof fetch;
  let basePolicyRefused = false;
  try {
    hardenedFetch = createHardenedFetch(baseUrl);
  } catch (err) {
    basePolicyRefused = true;
    hardenedFetch = async () => {
      throw err;
    };
  }
  const result = await createAuthedCloudClient({
    baseUrl,
    credentialStore: store,
    fetch: hardenedFetch,
    cliVersion: CLI_VERSION,
  }).logout();
  const remotePolicyRefused =
    basePolicyRefused || result.remoteError instanceof OutboundPolicyError;

  return {
    baseUrl,
    remote_revoked: result.remoteRevoked,
    remote_revoke_failure: result.remoteRevoked
      ? null
      : remotePolicyRefused
        ? 'policy_refused'
        : result.remoteFailure === null
          ? null
          : 'request_failed',
    remote_revoke_error: result.remoteError ? scrubAndBound(result.remoteError.message, 512) : null,
    local_cleared: result.localCleared,
    local_clear_reason: result.localClearReason,
    local_clear_error: result.localClearError
      ? scrubAndBound(result.localClearError.message, 512)
      : null,
    alreadyLoggedOut: result.alreadyLoggedOut,
  };
}

function reasonFor(localCleared: boolean | null): LogoutSummary['local_clear_reason'] {
  if (localCleared === true) return 'cleared';
  if (localCleared === false) return 'still_present';
  return 'unverifiable';
}

async function confirmCredentialAbsent(
  store: ReturnType<typeof resolveCredentialStore>,
  baseUrl: string
): Promise<boolean | null> {
  if (store.kind === 'env') return null;
  return (await Promise.resolve(store.read(baseUrl))) === null;
}

/** Describe remote revocation and local credential removal independently. */
function describeLogout(s: LogoutSummary): string {
  const local = ((): string => {
    switch (s.local_clear_reason) {
      case 'cleared':
        return 'Local credentials cleared.';
      case 'read_only_backend':
        return 'Credentials come from ORCAOPS_TOKEN, so nothing local can be cleared — unset it to log out here.';
      case 'unverifiable':
        return `Could not confirm whether the local credentials were removed${s.local_clear_error ? ` (${s.local_clear_error})` : ''} — check them by hand.`;
      case 'still_present':
        return `Local credentials were NOT cleared${s.local_clear_error ? ` (${s.local_clear_error})` : ''} — they are still on this machine.`;
    }
  })();
  const remote = s.remote_revoked
    ? 'Server-side tokens revoked.'
    : s.remote_revoke_failure === 'policy_refused'
      ? `Server-side revoke was blocked by outbound policy${s.remote_revoke_error ? ` (${s.remote_revoke_error})` : ''}; fix the stored cloud URL or discovery metadata before retrying.`
      : 'Server-side revoke FAILED (server unreachable or revoke unavailable); your tokens may remain valid until they expire. If you suspect compromise, ask your admin to revoke all sessions.';
  return `${remote}\n${local}\n`;
}

async function logoutAllAction(
  store: ReturnType<typeof resolveCredentialStore>,
  opts: LogoutOptions
): Promise<void> {
  const enumerable = store as Partial<CredentialStoreWithEnumeration>;
  if (
    typeof enumerable.knownBaseUrls !== 'function' ||
    typeof enumerable.clearAll !== 'function' ||
    typeof enumerable.withRefreshLock !== 'function'
  ) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--all only works with the FileStore (XDG-pathed credentials). The active store (' +
        (store.kind ?? 'unknown') +
        ') does not enumerate baseUrls.'
    );
  }
  const fileStore = enumerable as CredentialStoreWithEnumeration;
  await fileStore.withRefreshLock('logout-all', () => logoutAllLocked(store, fileStore, opts));
}

async function logoutAllLocked(
  store: ReturnType<typeof resolveCredentialStore>,
  enumerable: CredentialStoreWithEnumeration,
  opts: LogoutOptions
): Promise<void> {
  const baseUrls = enumerable.knownBaseUrls();
  const summaries: LogoutSummary[] = [];
  for (const baseUrl of baseUrls) {
    summaries.push(await logoutOneLocked(store, baseUrl));
  }
  // Unconditional local nuke — even if every server revoke failed, the
  // user asked for a clean slate.
  enumerable.clearAll();

  // Re-observe AFTER the nuke. Each summary's `local_cleared` was established
  // by a per-URL confirmation read that ran before `clearAll()`, so reporting
  // it unchanged would describe a state this command has since replaced —
  // "could not be confirmed removed" about a file that is now gone.
  for (const summary of summaries) {
    try {
      summary.local_cleared = await confirmCredentialAbsent(store, summary.baseUrl);
      if (summary.local_cleared === true) summary.local_clear_error = null;
      summary.local_clear_reason = reasonFor(summary.local_cleared);
    } catch (err) {
      summary.local_cleared = null;
      summary.local_clear_reason = 'unverifiable';
      summary.local_clear_error = scrubAndBound(
        err instanceof Error ? err.message : String(err),
        512
      );
    }
  }

  if (opts.json) {
    emitOk({ all: true, sessions: summaries });
    return;
  }
  if (baseUrls.length === 0) {
    writeTerminalSafeStdout('No saved cloud sessions to clear.\n');
    return;
  }
  const fullyRevoked = summaries.filter((s) => s.remote_revoked).length;
  const policyRefused = summaries.filter(
    (s) => s.remote_revoke_failure === 'policy_refused'
  ).length;
  const stillPresent = summaries.filter((s) => s.local_cleared === false).length;
  const unknown = summaries.filter((s) => s.local_clear_reason === 'unverifiable').length;
  writeTerminalSafeStdout(
    `Cleared ${baseUrls.length} saved session(s). ` +
      `Server-side revoked: ${fullyRevoked}/${baseUrls.length}.` +
      (policyRefused > 0
        ? ` Outbound policy refused ${policyRefused}; run with --json for details.`
        : '') +
      (stillPresent > 0 ? ` WARNING: ${stillPresent} are STILL on this machine.` : '') +
      (unknown > 0 ? ` WARNING: ${unknown} could not be checked.` : '') +
      '\n'
  );
}
