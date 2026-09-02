import {
  createAuthedCloudClient,
  type CredentialStore,
  getAuthState,
  type OrcaCloudClient,
  type StoredCredentials,
} from '@orcaops/sdk';

import { requireCliVersion } from './cli-version.js';
import { NotConnectedError } from './errors.js';
import { createHardenedFetch } from './hardened-fetch.js';
import { assertSafeCloudUrl } from './url.js';
import { resolveCredentialStore } from '../credentials/store.js';

// Re-export SDK pieces consumers in this package + the CLI app commonly
// need so `@orcaops/sdk` doesn't have to be a direct dep of every caller.
export { CloudWireError, TrpcRequestError, trimTrailingSlash } from '@orcaops/sdk';
export type { OrcaCloudClient } from '@orcaops/sdk';

/**
 * Resolved cloud client + the credential blob it was bound to. Returned by
 * {@link createCloudClient}; the SDK's authed client + getAuthState are
 * already wired underneath, so callers just consume `client.*` and trust
 * the refresh-on-401 + CliAuthError mapping happens automatically.
 */
export interface CloudClientHandle {
  client: OrcaCloudClient;
  credentials: StoredCredentials;
}

export interface CreateCloudClientOptions {
  /** Resolved cloud baseUrl injected at the command boundary. */
  baseUrl: string;
  /** Credential store the caller resolved (`resolveCredentialStore()`). */
  store: CredentialStore;
  /** CLI release version for the `x-orcaops-cli-version` header. Defaults to
   *  the required process-wide value set at program bootstrap. */
  cliVersion?: string;
  /** Internal operation deadline propagated to every SDK request. */
  signal?: AbortSignal;
}

/**
 * Build a cloud client backed by the caller-resolved credential store + SDK
 * `createAuthedCloudClient`. Requires an already-resolved `baseUrl` + `store`
 * (target selection lives at the executable boundary). Throws
 * {@link NotConnectedError} when no credentials exist for the baseUrl —
 * callers gate cloud features on whether this throws.
 *
 * Auth lifecycle (Bearer + refresh-on-401 + CliAuthError mapping) is
 * fully wired by the SDK factory; this layer just routes the baseUrl +
 * store and surfaces the handful of fields existing call-sites read off
 * `credentials` (orgId for cache keys, baseUrl for log lines).
 */
export async function createCloudClient(
  opts: CreateCloudClientOptions
): Promise<CloudClientHandle> {
  if (!opts || !opts.baseUrl) {
    throw new Error(
      'createCloudClient requires a resolved baseUrl injected at the command boundary.'
    );
  }
  if (!opts.store) {
    throw new Error('createCloudClient requires a credential store.');
  }
  const store = opts.store;
  const baseUrl = assertSafeCloudUrl(opts.baseUrl);
  const credentials = await Promise.resolve(store.read(baseUrl));
  if (!credentials) {
    throw new NotConnectedError(`Not connected to ${baseUrl}. Run \`orcaops login\` first.`);
  }
  const authed = createAuthedCloudClient({
    baseUrl,
    credentialStore: store,
    fetch: createHardenedFetch(baseUrl, opts.signal),
    cliVersion: requireCliVersion(opts.cliVersion),
  });
  return { client: authed.client, credentials };
}

/**
 * Pre-flight check for auto-push paths. Returns `true` only when the
 * resolved store has usable credentials for the resolved baseUrl AND the
 * SDK's getAuthState reports `connected`. Auto-push paths (capture
 * summary finalization, digest publish, etc.) gate on this so they
 * silently skip cloud sync rather than build the client and surface a
 * 401 to the user.
 *
 * Before checking state it proactively renews an expired-but-refreshable
 * token: `getAuthState` is a pure local clock check, so without this an
 * expired access token would read `expired` → gate false → skip forever,
 * even though the refresh token could trivially restore the session. The
 * renew is best-effort (`ensureFreshToken` swallows its own failures); if it
 * can't refresh, the state check below still returns false.
 */
export async function isAuthReady(
  opts: { store?: CredentialStore; baseUrl?: string } = {}
): Promise<boolean> {
  const store = opts.store ?? resolveCredentialStore();
  const baseUrl = resolveCloudTarget(opts.baseUrl);
  let cliVersion: string;
  try {
    cliVersion = requireCliVersion();
  } catch {
    return false;
  }
  try {
    await createAuthedCloudClient({
      baseUrl,
      credentialStore: store,
      fetch: createHardenedFetch(baseUrl),
      cliVersion,
    }).ensureFreshToken();
  } catch {
    // Defensive: ensureFreshToken is already best-effort, but a preflight must
    // never throw — fall through to the state check.
  }
  const state = await getAuthState(store, baseUrl);
  return state.kind === 'connected';
}

/** The official production cloud injected by the shipped CLI entrypoint. */
export const DEFAULT_CLOUD_BASE_URL = 'https://api.orcaops.ai';

/**
 * Resolve the explicit target injected by an internal caller, or the official
 * production cloud. Stored credential origins never select the target: they
 * remain origin-keyed data, and the chosen program determines which key to use.
 */
export function resolveCloudTarget(injectedBaseUrl?: string): string {
  return assertSafeCloudUrl(injectedBaseUrl ?? DEFAULT_CLOUD_BASE_URL);
}
