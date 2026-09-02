import { resolveCloudTarget, resolveCredentialStore } from '@orcaops/core';
import { getAuthState } from '@orcaops/sdk';

import { proactivelyRefresh, staleKeyringHint } from './whoami.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../io/output.js';

export interface AuthStateOptions {
  baseUrl?: string;
  json?: boolean;
}

/**
 * Print the SDK's AuthState as JSON for the given baseUrl. Designed for
 * agent consumers, who call this BEFORE cloud-touching commands to decide
 * whether to (a) proceed, (b) prompt the user to re-login on `expired`, or
 * (c) skip cloud features on `not_connected`. The --json output mirrors
 * `getAuthState`'s shape so agents branch on `state.kind` directly.
 *
 * Attempts a proactive refresh first (no-op unless the token is near expiry),
 * so `expired` here means the refresh token is also gone — i.e. genuinely
 * "re-login required", not a recoverable access-token lapse. Refresh-when-fresh
 * is a local-only no-op; only a near-expiry token incurs a network round-trip.
 */
export async function authStateAction(opts: AuthStateOptions): Promise<void> {
  try {
    const store = resolveCredentialStore();
    const baseUrl = resolveCloudTarget(opts.baseUrl);
    await proactivelyRefresh(store, baseUrl);
    const state = await getAuthState(store, baseUrl);
    const keyringHint = staleKeyringHint(store.kind, state);

    if (opts.json !== false) {
      // Default to JSON — agents are the primary consumer of this command.
      emitOk({ baseUrl, state, ...(keyringHint ? { hint: keyringHint } : {}) });
      return;
    }

    // Human-readable fallback — terse, matches whoami's tone but shorter.
    switch (state.kind) {
      case 'connected':
        writeTerminalSafeStdout(
          `Connected (${state.mode}) to ${baseUrl} as ${state.email || state.userId} for ${state.orgName ?? state.orgId}` +
            (state.expiresInSeconds !== null
              ? ` — expires in ${Math.max(0, Math.floor(state.expiresInSeconds / 60))} min\n`
              : '\n')
        );
        return;
      case 'expired':
        writeTerminalSafeStdout(
          `Session expired (${state.reason}) at ${baseUrl}. Run \`orcaops login\`.\n`
        );
        return;
      case 'not_connected':
        writeTerminalSafeStdout(`Not connected to ${baseUrl}. Run \`orcaops login\`.\n`);
        return;
    }
  } catch (err) {
    emitError(err);
  }
}
