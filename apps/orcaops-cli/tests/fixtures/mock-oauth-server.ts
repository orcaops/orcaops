import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * In-process Authorization Server fixture for E2E tests of the CLI's
 * OAuth flow. Implements the minimum surface the cloud's
 * `@better-auth/oauth-provider` would respond with:
 *
 *   - GET  /.well-known/oauth-authorization-server   discovery metadata
 *   - GET  /.well-known/jwks.json                    public JWK for JWT verification
 *   - GET  /authorize                                 immediate 302 to redirect_uri (with code or error)
 *   - POST /oauth2/token                              authorization_code | refresh_token grants
 *   - POST /oauth2/revoke                             RFC 7009 — delete refresh token
 *
 * Validates PKCE on the authcode grant + RFC 8707 `resource` on every
 * grant. Mints EdDSA-signed JWTs (1h expiry) carrying the spec's claims
 * (sub / reference_id / email / org_name / org_slug / scope / iss / aud).
 *
 * Test ergonomics:
 *   - Default `nextConsent` accepts; flip to `accept: false` for the
 *     access_denied path
 *   - `lastTokenRequestBody()` exposes the last form-encoded /token POST
 *     body so tests can assert resource= / code_verifier= / etc.
 */
export interface MockOAuthServer {
  readonly baseUrl: string;
  readonly validResource: string;
  /** The user/org/email the next mint will encode. */
  setNextConsent(opts: { accept: boolean; user?: MockUser }): void;
  /** Form-encoded body of the most recent /oauth2/token POST. */
  lastTokenRequestBody(): URLSearchParams | null;
  /** Best-effort revocation snapshot — true iff the named refresh token has been deleted. */
  isRefreshTokenRevoked(refreshToken: string): boolean;
  shutdown(): Promise<void>;
}

export interface MockUser {
  userId: string;
  orgId: string;
  email: string;
  orgName: string | null;
  orgSlug: string | null;
}

const DEFAULT_USER: MockUser = {
  userId: 'usr_test',
  orgId: 'org_test',
  email: 'jane@test',
  orgName: 'Acme',
  orgSlug: 'acme',
};

interface AuthcodeRecord {
  challenge: string;
  redirectUri: string;
  user: MockUser;
}

interface RefreshTokenRecord {
  user: MockUser;
  revoked: boolean;
}

export async function startMockOAuthServer(): Promise<MockOAuthServer> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'mock-oauth-key-1';
  jwk.use = 'sig';
  jwk.alg = 'EdDSA';

  let nextConsent: { accept: boolean; user: MockUser } = { accept: true, user: DEFAULT_USER };
  let lastTokenBody: URLSearchParams | null = null;
  const codes = new Map<string, AuthcodeRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      writeJson(res, 500, { error: 'server_error', error_description: String(err) });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) {
    server.close();
    throw new Error('mock OAuth server failed to bind');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const validResource = baseUrl;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', baseUrl);

    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      writeJson(res, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/oauth2/token`,
        revocation_endpoint: `${baseUrl}/oauth2/revoke`,
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['cli:full', 'offline_access'],
      });
      return;
    }

    if (url.pathname === '/.well-known/jwks.json' && req.method === 'GET') {
      writeJson(res, 200, { keys: [jwk] });
      return;
    }

    if (url.pathname === '/authorize' && req.method === 'GET') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const challenge = url.searchParams.get('code_challenge');
      const challengeMethod = url.searchParams.get('code_challenge_method');
      if (!redirectUri || !state || !challenge || challengeMethod !== 'S256') {
        writeJson(res, 400, {
          error: 'invalid_request',
          error_description:
            'missing redirect_uri / state / code_challenge / code_challenge_method',
        });
        return;
      }
      if (!nextConsent.accept) {
        const back = new URL(redirectUri);
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', state);
        res.statusCode = 302;
        res.setHeader('location', back.toString());
        res.end();
        return;
      }
      const code = `code_${randomBytes(16).toString('hex')}`;
      codes.set(code, { challenge, redirectUri, user: nextConsent.user });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', state);
      res.statusCode = 302;
      res.setHeader('location', back.toString());
      res.end();
      return;
    }

    if (url.pathname === '/oauth2/token' && req.method === 'POST') {
      const body = await readForm(req);
      lastTokenBody = body;
      const grantType = body.get('grant_type');
      const resource = body.get('resource');
      if (resource !== validResource) {
        writeJson(res, 400, {
          error: 'invalid_target',
          error_description: `resource must equal ${validResource}`,
        });
        return;
      }
      if (grantType === 'authorization_code') {
        const code = body.get('code') ?? '';
        const verifier = body.get('code_verifier') ?? '';
        const redirectUri = body.get('redirect_uri') ?? '';
        const record = codes.get(code);
        if (!record) {
          writeJson(res, 400, {
            error: 'invalid_grant',
            error_description: 'unknown or already-used code',
          });
          return;
        }
        codes.delete(code);
        const sha = createHash('sha256').update(verifier).digest('base64url');
        if (sha !== record.challenge) {
          writeJson(res, 400, {
            error: 'invalid_grant',
            error_description: 'PKCE code_verifier does not match challenge',
          });
          return;
        }
        if (redirectUri !== record.redirectUri) {
          writeJson(res, 400, {
            error: 'invalid_grant',
            error_description: 'redirect_uri does not match the one used at /authorize',
          });
          return;
        }
        const tokens = await mintTokens(record.user, privateKey, baseUrl, refreshTokens);
        writeJson(res, 200, tokens);
        return;
      }
      if (grantType === 'refresh_token') {
        const refresh = body.get('refresh_token') ?? '';
        const record = refreshTokens.get(refresh);
        if (!record || record.revoked) {
          writeJson(res, 400, {
            error: 'invalid_grant',
            error_description: 'refresh token unknown or revoked',
          });
          return;
        }
        // OAuth 2.1 BCP rotation: revoke the prior refresh, mint a new one.
        record.revoked = true;
        const tokens = await mintTokens(record.user, privateKey, baseUrl, refreshTokens);
        writeJson(res, 200, tokens);
        return;
      }
      writeJson(res, 400, {
        error: 'unsupported_grant_type',
        error_description: `grant_type ${grantType} is not supported`,
      });
      return;
    }

    if (url.pathname === '/oauth2/revoke' && req.method === 'POST') {
      const body = await readForm(req);
      const token = body.get('token') ?? '';
      const record = refreshTokens.get(token);
      if (record) record.revoked = true;
      writeJson(res, 200, {});
      return;
    }

    // Identity endpoint the CLI calls during login (to populate the credential
    // blob) and `whoami --verify`. Returns the identity carried by the Bearer
    // access token (a mock-signed JWT), so it reflects whichever user consented.
    // 401 when the Bearer is missing/undecodable — exercises the auth-error path.
    if (url.pathname === '/api/trpc/user.me') {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const claims = decodeJwtClaims(bearer);
      if (!claims) {
        writeJson(res, 401, {
          error: {
            json: { message: 'Invalid token', data: { code: 'UNAUTHORIZED', httpStatus: 401 } },
          },
        });
        return;
      }
      writeJson(res, 200, {
        result: {
          data: {
            json: {
              user: { id: claims.sub, email: claims.email, name: claims.email },
              organization: {
                id: claims.reference_id,
                slug: claims.org_slug,
                name: claims.org_name,
              },
            },
          },
        },
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  }

  return {
    baseUrl,
    validResource,
    setNextConsent: (opts) => {
      nextConsent = { accept: opts.accept, user: opts.user ?? DEFAULT_USER };
    },
    lastTokenRequestBody: () => lastTokenBody,
    isRefreshTokenRevoked: (refreshToken) =>
      refreshTokens.get(refreshToken)?.revoked === true ||
      // Not in the table at all = effectively revoked / unknown.
      !refreshTokens.has(refreshToken),
    shutdown: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface AccessTokenClaims {
  sub?: string;
  email?: string;
  reference_id?: string;
  org_name?: string;
  org_slug?: string;
}

/** Decode (without verifying — this is a mock) the JWT payload to recover the
 *  identity claims `mintTokens` signed in. Returns null for a missing/garbled token. */
function decodeJwtClaims(token: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as AccessTokenClaims;
  } catch {
    return null;
  }
}

async function mintTokens(
  user: MockUser,
  privateKey: CryptoKey,
  baseUrl: string,
  refreshTokens: Map<string, RefreshTokenRecord>
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}> {
  const accessToken = await new SignJWT({
    sub: user.userId,
    reference_id: user.orgId,
    email: user.email,
    org_name: user.orgName,
    org_slug: user.orgSlug,
    scope: 'cli:full offline_access',
    client_id: 'orcaops-cli',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'mock-oauth-key-1' })
    .setIssuer(`${baseUrl}/api/auth`)
    .setAudience(baseUrl)
    .setIssuedAt()
    .setExpirationTime('1h')
    .setJti(`jti_${randomBytes(8).toString('hex')}`)
    .sign(privateKey);
  const refreshToken = `rt_${randomBytes(24).toString('hex')}`;
  refreshTokens.set(refreshToken, { user, revoked: false });
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'cli:full offline_access',
  };
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
