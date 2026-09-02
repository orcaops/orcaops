import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileStore, OutboundPolicyError } from '@orcaops/core';
import type { StoredCredentials } from '@orcaops/sdk';

/**
 * Injection coverage for the CLI's own SDK constructions.
 *
 * Every SDK network entry point does `options.fetch ?? fetch`: a site that
 * omits the option — or passes `undefined`, or the bare global — silently
 * bypasses the outbound policy. Proof here is BEHAVIORAL: drive each
 * production command with the SDK mocked, capture what it actually handed
 * over, and assert that value enforces the policy. A textual scan cannot
 * make that claim (`fetch: undefined` reads the same as a real wrapper);
 * the source sweep at the bottom of this file is a change tripwire only,
 * and documents its own limits.
 */

const captured: Array<{ site: string; fetch: unknown }> = [];

vi.mock('@orcaops/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/sdk')>();
  return {
    ...actual,
    fetchDiscovery: (baseUrl: string, opts?: { fetch?: typeof fetch }) => {
      captured.push({ site: 'fetchDiscovery', fetch: opts?.fetch });
      return Promise.resolve({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth2/authorize`,
        token_endpoint: `${baseUrl}/oauth2/token`,
        revocation_endpoint: `${baseUrl}/oauth2/revoke`,
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['cli:full'],
      });
    },
    exchangeCode: (args: { fetch?: typeof fetch }) => {
      captured.push({ site: 'exchangeCode', fetch: args.fetch });
      return Promise.resolve({
        accessToken: 'at_new',
        refreshToken: 'rt_new',
        expiresIn: 3600,
      });
    },
    createAuthedCloudClient: (opts: { fetch?: typeof fetch }) => {
      captured.push({ site: 'createAuthedCloudClient', fetch: opts.fetch });
      return {
        client: {
          user: {
            me: () =>
              Promise.resolve({
                user: { id: 'usr_1', email: 'u@example.test' },
                organization: { id: 'org_1', name: 'Acme', slug: 'acme' },
              }),
          },
        },
        authState: () => Promise.resolve({ kind: 'connected' }),
        verifyToken: () => Promise.resolve(),
        ensureFreshToken: () => Promise.resolve(),
        logout: () =>
          Promise.resolve({
            remoteRevoked: true,
            remoteFailure: null,
            remoteError: null,
            localCleared: true,
            localClearReason: 'cleared' as const,
            localClearError: null,
            alreadyLoggedOut: false,
          }),
      };
    },
  };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// Loopback so assertSafeCloudUrl accepts http without an override; nothing
// listens here — every network call is mocked.
const BASE = 'http://127.0.0.1:59731';

/**
 * A captured fetch must BE the policy wrapper, which takes two assertions.
 *
 * Refusing cross-origin is not enough on its own: a captured bare global
 * would also reject `attacker.example`, with a DNS `TypeError` rather than
 * a policy error, and it would miss a later-installed spy because the
 * reference predates it. So the refusal must be an OutboundPolicyError.
 * And an always-throwing stub would satisfy that if the error were the only
 * check, so a same-origin request must also DELEGATE to the real fetch.
 */
async function expectHardened(entry: { site: string; fetch: unknown }): Promise<void> {
  expect(entry.fetch, `${entry.site} passed no fetch`).toBeTypeOf('function');
  const captured = entry.fetch as typeof fetch;

  await expect(
    captured('https://attacker.example/steal'),
    `${entry.site} did not refuse a cross-origin request with a policy error`
  ).rejects.toThrow(OutboundPolicyError);

  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  try {
    await captured(`${BASE}/api/trpc/cli.ping`);
    expect(spy, `${entry.site} did not delegate a same-origin request`).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  } finally {
    spy.mockRestore();
  }
}

function credentials(baseUrl: string): StoredCredentials {
  return {
    v: 1,
    loginMethod: 'oauth',
    baseUrl,
    userId: 'usr_1',
    orgId: 'org_1',
    orgName: 'Acme',
    orgSlug: 'acme',
    email: 'u@example.test',
    accessToken: 'at_live',
    refreshToken: 'rt_live',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe('hardened-fetch injection — CLI command constructions', () => {
  let dir: string;

  beforeEach(async () => {
    captured.length = 0;
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-injection-'));
    vi.stubEnv('ORCAOPS_DISABLE_DRAIN', '1');
    vi.stubEnv('ORCAOPS_CONFIG_HOME', dir);
    vi.stubEnv('ORCAOPS_TOKEN', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('login hands a policy-enforcing fetch to discovery, code exchange, and the identity probe', async () => {
    const { loginAction } = await import('../../src/commands/login.js');
    const store = new FileStore({ dir });
    await loginAction({
      baseUrl: BASE,
      store,
      openBrowser: false,
      // Resolve the real loopback server the flow is waiting on; discovery
      // and exchange are mocked, so no authorization server is involved.
      onAuthorizeUrl: async (url) => {
        const authz = new URL(url);
        const redirectUri = new URL(authz.searchParams.get('redirect_uri') ?? '');
        redirectUri.searchParams.set('code', 'test-code');
        redirectUri.searchParams.set('state', authz.searchParams.get('state') ?? '');
        await fetch(redirectUri.toString()).catch(() => undefined);
      },
    });

    const sites = captured.map((c) => c.site);
    expect(sites).toContain('fetchDiscovery');
    expect(sites).toContain('exchangeCode');
    expect(sites).toContain('createAuthedCloudClient');
    for (const entry of captured) await expectHardened(entry);
  });

  it('logout hands a policy-enforcing fetch to the revocation client', async () => {
    new FileStore({ dir }).write(BASE, credentials(BASE));
    const { logoutAction } = await import('../../src/commands/logout.js');
    await logoutAction({ baseUrl: BASE, json: true });
    expect(captured.map((c) => c.site)).toEqual(['createAuthedCloudClient']);
    await expectHardened(captured[0]);
  });

  it('whoami --verify hands a policy-enforcing fetch to both the refresh and verify clients', async () => {
    new FileStore({ dir }).write(BASE, credentials(BASE));
    const { whoamiAction } = await import('../../src/commands/whoami.js');
    await whoamiAction({ baseUrl: BASE, verify: true, json: true });
    // proactivelyRefresh + the un-wrapped --verify probe.
    expect(captured).toHaveLength(2);
    for (const entry of captured) await expectHardened(entry);
  });
});

/**
 * Change detector for NEW references to SDK network entry points.
 *
 * What this proves: the set of production files that so much as NAME one of
 * these functions, and how often, is exactly the inventory the behavioral
 * tests above cover. Counting every mention rather than `name(` call syntax
 * is deliberate — `const make = createAuthedCloudClient`, a re-export, or an
 * aliased import all name the identifier and so all move the count.
 *
 * What it does NOT prove: that a listed site passes a working wrapper (the
 * behavioral tests own that), nor that evasion is impossible — a computed
 * string access (`sdk['create' + 'Authed…']`) names nothing and would slip
 * past. It is a tripwire for ordinary edits, not a security boundary.
 *
 * `packages/core` and `apps/orcaops-cli` are the only workspace packages
 * that depend on `@orcaops/sdk`; a third would need adding here.
 */
describe('SDK network reference inventory', () => {
  const NETWORK_ENTRY_POINTS = [
    'createAuthedCloudClient',
    'createOrcaCloudClient',
    'fetchDiscovery',
    'exchangeCode',
    'refreshTokens',
  ];

  // Includes the import statement's mention, hence e.g. login.ts = 3 calls
  // + 3 imported names.
  const EXPECTED_REFERENCES: Record<string, number> = {
    'packages/core/src/cloud/client.ts': 3,
    'apps/orcaops-cli/src/commands/login.ts': 7,
    'apps/orcaops-cli/src/commands/logout.ts': 2,
    'apps/orcaops-cli/src/commands/whoami.ts': 3,
  };

  function productionSources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) {
        if (name === '__tests__' || name === 'test-fixtures' || name === 'node_modules') continue;
        out.push(...productionSources(abs));
        continue;
      }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || name.endsWith('.d.ts')) continue;
      out.push(abs);
    }
    return out;
  }

  /** Strip comments so a documented or commented-out name never counts. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  it('the set of production files naming an SDK network entry point matches the covered inventory', () => {
    const found: Record<string, number> = {};
    for (const tree of [
      path.join(REPO_ROOT, 'packages', 'core', 'src'),
      path.join(REPO_ROOT, 'apps', 'orcaops-cli', 'src'),
    ]) {
      for (const file of productionSources(tree)) {
        const source = stripComments(readFileSync(file, 'utf8'));
        let count = 0;
        for (const fn of NETWORK_ENTRY_POINTS) {
          count += [...source.matchAll(new RegExp(String.raw`\b${fn}\b`, 'g'))].length;
        }
        if (count > 0) found[path.relative(REPO_ROOT, file)] = count;
      }
    }
    expect(found).toEqual(EXPECTED_REFERENCES);
  });
});
