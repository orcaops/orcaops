import {
  type CredentialStore,
  type CredentialStoreKind,
  decodeJwt,
  type JwtPayload,
  type StoredCredentials,
} from '@orcaops/sdk';

const ENV_VAR = 'ORCAOPS_TOKEN';

/**
 * Read-only credential store backed by the `ORCAOPS_TOKEN` environment
 * variable. Used for CI / non-interactive contexts where a long-lived
 * token (typically a JWT) is provisioned out of band by the secret
 * manager.
 *
 * - read() synthesizes a {@link StoredCredentials} from the env var. If the
 *   token decodes as a JWT, claims (sub / reference_id / org_name / org_slug
 *   / email) populate the user/org metadata; non-JWT tokens leave them blank.
 * - write() / clear() throw — env-mode is not mutable from the CLI.
 *   Updating the token means changing the env var (re-export, restart shell).
 *   Refresh is not attempted in env mode (no refresh token to use).
 *
 * The store reports `kind: 'env'` so {@link getAuthState} from the SDK takes
 * the cloud-managed-expiry branch (expiresAt: null) — env-mode tokens are
 * opaque to the CLI's expiry math.
 */
export class EnvStore implements CredentialStore {
  readonly kind: CredentialStoreKind = 'env';

  read(baseUrl: string): StoredCredentials | null {
    const token = process.env[ENV_VAR];
    if (!token) return null;
    const claims = tryDecode(token);
    return {
      v: 1,
      loginMethod: 'env',
      baseUrl,
      userId: claims?.sub ?? '',
      orgId: claims?.reference_id ?? '',
      orgName: claims?.org_name ?? null,
      orgSlug: claims?.org_slug ?? null,
      email: claims?.email ?? '',
      accessToken: token,
      refreshToken: '',
      expiresAt: 0,
    };
  }

  write(): never {
    throw new EnvStoreError(
      `env-mode tokens are read-only — set ${ENV_VAR} in the environment, do not write through the store`
    );
  }

  clear(): never {
    throw new EnvStoreError(
      `env-mode tokens are read-only — unset ${ENV_VAR} in the environment, do not clear through the store`
    );
  }
}

export class EnvStoreError extends Error {
  readonly name = 'EnvStoreError';
  constructor(reason: string) {
    super(`EnvStore: ${reason}`);
  }
}

/**
 * Best-effort claim extraction from an environment-supplied JWT.
 *
 * IMPORTANT: `decodeJwt` from `@orcaops/sdk` base64url-decodes the payload
 * but does NOT verify the signature, issuer, audience, or expiry. A forged
 * JWT placed in `ORCAOPS_TOKEN` produces attacker-controlled values for
 * `userId` / `orgId` / `email` here. The cloud rejects forged tokens on
 * the first API call (JWKS verification in `cliProcedure`), so this can
 * only mislead the CLI's LOCAL identity display — never a server-side
 * authorization decision. Documented at the consumer boundary so future
 * callers don't treat the returned shape as authenticated identity.
 */
function tryDecode(token: string): JwtPayload | null {
  try {
    return decodeJwt(token);
  } catch {
    return null;
  }
}

/** True iff `ORCAOPS_TOKEN` is set to a non-empty value. */
export function envTokenIsSet(): boolean {
  const token = process.env[ENV_VAR];
  return typeof token === 'string' && token.length > 0;
}
