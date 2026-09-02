import { createHardenedFetch, resolveCloudTarget, resolveCredentialStore } from '@orcaops/core';
import {
  type AuthState,
  CliAuthError,
  createAuthedCloudClient,
  type CredentialStore,
  getAuthState,
} from '@orcaops/sdk';

import { emitError, emitOk, writeTerminalSafeStdout } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';

/**
 * Proactively renew an expired-but-refreshable token before reading state, so
 * `whoami` / `auth-state` self-heal and report the true post-refresh state
 * instead of a stale `expired` (which would wrongly tell the user to re-login
 * when a valid refresh token could recover). Best-effort and offline-safe:
 * `ensureFreshToken` no-ops when fresh/env/not-connected and swallows refresh
 * failures, so `getAuthState` afterward still reflects reality.
 */
export async function proactivelyRefresh(store: CredentialStore, baseUrl: string): Promise<void> {
  try {
    await createAuthedCloudClient({
      baseUrl,
      credentialStore: store,
      fetch: createHardenedFetch(baseUrl),
      cliVersion: CLI_VERSION,
    }).ensureFreshToken();
  } catch {
    // ignore — the subsequent getAuthState reports whatever state we're in
  }
}

export interface WhoamiOptions {
  baseUrl?: string;
  /** Hit a known protected endpoint to confirm the cloud accepts the token. Optional. */
  verify?: boolean;
  json?: boolean;
}

/**
 * Human-readable presentation of the SDK's AuthState. Single source of
 * truth for "am I logged in / who am I" — both `whoami` and the agent-
 * targeted `auth-state --json` share `getAuthState`.
 */
export async function whoamiAction(opts: WhoamiOptions): Promise<void> {
  try {
    const store = resolveCredentialStore();
    const baseUrl = resolveCloudTarget(opts.baseUrl);
    await proactivelyRefresh(store, baseUrl);
    const state = await getAuthState(store, baseUrl);

    let verifiedLine = '';
    let verified: boolean | null = null;
    if (opts.verify && state.kind === 'connected') {
      // Use the SDK's `verifyToken` probe (un-wrapped `user.me`), NOT the
      // refresh-aware client: --verify must report the server's verdict on the
      // CURRENT token. The wrapped client would catch a 401, silently refresh,
      // and mask the rejection (or fail the refresh and report "inconclusive").
      const authed = createAuthedCloudClient({
        baseUrl,
        credentialStore: store,
        fetch: createHardenedFetch(baseUrl),
        cliVersion: CLI_VERSION,
      });
      try {
        await authed.verifyToken();
        verified = true;
        verifiedLine = 'Verified: server recognizes token';
      } catch (err) {
        if (
          err instanceof CliAuthError &&
          (err.code === 'SESSION_EXPIRED' ||
            err.code === 'NOT_LOGGED_IN' ||
            err.code === 'MEMBERSHIP_REVOKED' ||
            err.code === 'ORG_SUSPENDED')
        ) {
          verified = false;
          verifiedLine = 'Verified: server REJECTED the token (re-login required)';
        } else {
          verifiedLine = 'Verified: inconclusive (network or server error)';
        }
      }
    }

    const keyringHint = staleKeyringHint(store.kind, state);

    if (opts.json) {
      emitOk({
        baseUrl,
        state,
        verified,
        ...(keyringHint ? { hint: keyringHint } : {}),
      });
      return;
    }
    const human = formatHuman(baseUrl, state, store.kind, verifiedLine);
    writeTerminalSafeStdout((keyringHint ? `${human}\n${keyringHint}` : human) + '\n');
  } catch (err) {
    emitError(err);
  }
}

/**
 * Cross-store nudges, messaging only (no resolution change). Kept I/O-free on
 * purpose: probing the keyring to confirm a login could itself trigger the
 * interactive prompt the file-store default exists to avoid.
 * A keyring user can deliberately switch stores, so an expired keyring
 * session points to the default file store as another current login location.
 */
export function staleKeyringHint(storageKind: string, state: AuthState): string | null {
  if (storageKind === 'keyring' && state.kind === 'expired') {
    return 'Tip: unset ORCAOPS_CREDENTIAL_STORE to use the file store login (it may be fresher).';
  }
  return null;
}

function formatHuman(
  baseUrl: string,
  state: AuthState,
  storageKind: string,
  verifiedLine: string
): string {
  switch (state.kind) {
    case 'not_connected':
      return `Not logged in to ${baseUrl}. Run \`orcaops login\`.`;
    case 'expired':
      return [
        `Session expired for ${state.userId ?? 'unknown user'} at ${baseUrl}.`,
        `Reason: ${state.reason}.`,
        'Run `orcaops login` to re-authenticate.',
      ].join('\n');
    case 'connected': {
      const orgLine = state.orgName ? `${state.orgName} (${state.orgId})` : state.orgId;
      const expiresLine =
        state.expiresInSeconds === null
          ? 'env-mode (cloud-managed expiry)'
          : `expires in ${Math.max(0, Math.floor(state.expiresInSeconds / 60))} min (auto-refresh enabled)`;
      const lines = [
        `Logged in to:    ${baseUrl}`,
        `User:            ${state.email || '(unknown)'} (${state.userId})`,
        `Organization:    ${orgLine}` + (state.orgSlug ? ` [${state.orgSlug}]` : ''),
        `Access token:    ${expiresLine}`,
        `Storage:         ${storageKind}`,
      ];
      if (verifiedLine) lines.push(verifiedLine);
      return lines.join('\n');
    }
  }
}
