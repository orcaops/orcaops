import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileStore } from '@orcaops/core';
import type { StoredCredentials } from '@orcaops/sdk';

import { loginAction } from '../../src/commands/login.js';
import { logoutAction } from '../../src/commands/logout.js';
import { type MockOAuthServer, startMockOAuthServer } from '../fixtures/mock-oauth-server.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`child exited with code ${child.exitCode}`));
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

describe('orcaops logout (RFC 7009 revoke + local clear E2E)', () => {
  let mock: MockOAuthServer;
  let dir: string;
  let store: FileStore;
  let originalExit: typeof process.exit;
  let exitCalled: number | null = null;

  beforeEach(async () => {
    // Direct-action tests run OUTSIDE the in-process agent's cwd sandbox, so
    // loginAction's post-login drain would buildContext against the REAL repo
    // this suite runs in (and loadConfig migration writeback would mutate its
    // .orcaops/config.json). Kill the drain up front.
    vi.stubEnv('ORCAOPS_DISABLE_DRAIN', '1');
    mock = await startMockOAuthServer();
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-logout-e2e-'));
    store = new FileStore({ dir });
    exitCalled = null;
    originalExit = process.exit;
    Object.defineProperty(process, 'exit', {
      value: ((code?: number) => {
        exitCalled = code ?? 0;
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never,
      configurable: true,
      writable: true,
    });
    // logoutAction calls resolveCredentialStore() at runtime — point it at our tmpdir store.
    vi.spyOn(await import('@orcaops/core'), 'resolveCredentialStore').mockReturnValue(store);
  });

  afterEach(async () => {
    await mock.shutdown();
    await rm(dir, { recursive: true, force: true });
    Object.defineProperty(process, 'exit', {
      value: originalExit,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function driveBrowser(authzUrl: string): Promise<void> {
    return (async () => {
      const auth = await fetch(authzUrl, { redirect: 'manual' });
      const callbackUrl = auth.headers.get('location');
      if (!callbackUrl) throw new Error('mock /authorize missing Location');
      await fetch(callbackUrl, { redirect: 'manual' });
    })();
  }

  it('revokes the refresh token at the cloud + clears the local store', async () => {
    // Set up a live login first so we have a real refresh token.
    await loginAction({
      baseUrl: mock.baseUrl,
      store,
      openBrowser: false,
      onAuthorizeUrl: driveBrowser,
    });
    const beforeLogout = store.read(mock.baseUrl);
    expect(beforeLogout).not.toBeNull();
    const refreshToken = beforeLogout?.refreshToken ?? '';

    await logoutAction({ baseUrl: mock.baseUrl });

    expect(store.read(mock.baseUrl)).toBeNull();
    expect(mock.isRefreshTokenRevoked(refreshToken)).toBe(true);
  });

  it('emits a polite info line when not logged in (no error)', async () => {
    await logoutAction({ baseUrl: mock.baseUrl });
    expect(exitCalled).toBeNull();
    expect(store.read(mock.baseUrl)).toBeNull();
  });

  it('clears the local store even when revocation fails (server unreachable)', async () => {
    // Persist a fake credential blob.
    store.write(mock.baseUrl, {
      v: 1,
      loginMethod: 'oauth',
      baseUrl: mock.baseUrl,
      userId: 'usr_offline',
      orgId: 'org_offline',
      orgName: 'Offline',
      orgSlug: 'offline',
      email: 'offline@test',
      accessToken: 'eyJ.fake',
      refreshToken: 'rt_offline',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    // Shut the mock down BEFORE logout — fetchDiscovery will fail.
    await mock.shutdown();

    await logoutAction({ baseUrl: mock.baseUrl });
    // Local store still cleared regardless.
    expect(store.read(mock.baseUrl)).toBeNull();
  });

  it('targets production and is a clean no-op with an empty store', async () => {
    // Empty store → 0 clouds → write intent floors to prod → no creds there →
    // "nothing to do" (exit 0). The refuse-and-list guard only fires at >1
    // stored cloud (covered by core base-url-resolve unit tests).
    await logoutAction({});
    expect(exitCalled).toBeNull();
  });
});

describe('logout reports revoke and local clear separately', () => {
  let dir: string;
  // A reachable revocation endpoint, so a failing revoke in these tests is a
  // real signal rather than the mock being absent.
  let mock: MockOAuthServer;

  beforeEach(async () => {
    vi.stubEnv('ORCAOPS_DISABLE_DRAIN', '1');
    mock = await startMockOAuthServer();
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-logout-sep-'));
  });

  afterEach(async () => {
    await mock.shutdown();
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function creds(baseUrl: string): StoredCredentials {
    return {
      v: 1,
      loginMethod: 'oauth',
      baseUrl,
      userId: 'u',
      orgId: 'o',
      orgName: null,
      orgSlug: null,
      email: 'e@example.test',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  /**
   * Drive the real command, not the facade. The facade is an implementation
   * detail; what a user is exposed to is the summary `logoutAction` emits, so
   * that is what these assert on.
   */
  async function runLogout(store: FileStore, baseUrl: string): Promise<Record<string, unknown>> {
    const core = await import('@orcaops/core');
    vi.spyOn(core, 'resolveCredentialStore').mockReturnValue(store);
    const emitted: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        emitted.push(String(chunk));
        return true;
      });
    try {
      await logoutAction({ baseUrl, json: true });
    } finally {
      spy.mockRestore();
    }
    return JSON.parse(emitted.join('')) as Record<string, unknown>;
  }

  it('reports a successful revoke alongside a local clear that did nothing', async () => {
    // The combination that used to be unreportable, and the one that matters
    // most: the server DID revoke, and the credential is still on disk. The
    // old single-branch message claimed the inverse of both halves.
    const store = new FileStore({ dir });
    const baseUrl = mock.baseUrl;
    store.write(baseUrl, creds(baseUrl));
    // Suppress the deletion exactly as the keyring backend does.
    vi.spyOn(store, 'clear').mockImplementation(() => undefined);

    const out = await runLogout(store, baseUrl);

    expect(out.remote_revoked).toBe(true);
    expect(out.local_cleared).toBe(false);
    expect(store.read(baseUrl)).not.toBeNull();
  });

  it('reports a successful revoke and a confirmed local clear', async () => {
    const store = new FileStore({ dir });
    const baseUrl = mock.baseUrl;
    store.write(baseUrl, creds(baseUrl));

    const out = await runLogout(store, baseUrl);

    expect(out.remote_revoked).toBe(true);
    expect(out.local_cleared).toBe(true);
    expect(out.local_clear_error).toBeNull();
    expect(store.read(baseUrl)).toBeNull();
  });

  it('a clear that throws is reported as a LOCAL failure, not a revoke failure', async () => {
    const store = new FileStore({ dir });
    const baseUrl = mock.baseUrl;
    store.write(baseUrl, creds(baseUrl));
    vi.spyOn(store, 'clear').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const out = await runLogout(store, baseUrl);

    expect(out.remote_revoked, 'the revoke succeeded and must be reported as such').toBe(true);
    expect(out.local_cleared).toBe(false);
    expect(out.local_clear_error).toContain('EACCES');
  });

  it('preserves policy refusal when the SDK converts the fetch error into revoked false', async () => {
    const store = new FileStore({ dir });
    const baseUrl = mock.baseUrl;
    store.write(baseUrl, creds(baseUrl));
    const attackerUrl = 'https://attacker.example/oauth2/revoke';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== `${baseUrl}/.well-known/oauth-authorization-server`) {
        throw new Error(`unexpected outbound request: ${url}`);
      }
      return new Response(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/oauth2/token`,
          revocation_endpoint: attackerUrl,
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['cli:full', 'offline_access'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    // This intentionally crosses the real SDK boundary. The SDK returns the
    // policy error as the remote outcome while still clearing locally.
    const out = await runLogout(store, baseUrl);

    expect(out.remote_revoked).toBe(false);
    expect(out.remote_revoke_failure).toBe('policy_refused');
    expect(out.remote_revoke_error).toContain('not same-origin');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.read(baseUrl)).toBeNull();
  });

  it('a store read that throws does not masquerade as a revoke failure', async () => {
    // The SDK owns both the initial read and the confirmation read. A failure
    // in the latter must not relabel a successful remote revoke.
    const store = new FileStore({ dir });
    const baseUrl = mock.baseUrl;
    store.write(baseUrl, creds(baseUrl));
    const real = store.read.bind(store);
    let calls = 0;
    vi.spyOn(store, 'read').mockImplementation((url: string) => {
      calls += 1;
      // First read is the CLI's own; fail every read after it, which is where
      // the SDK's would have landed.
      if (calls === 1) return real(url);
      throw new Error('store unreadable');
    });

    const out = await runLogout(store, baseUrl);

    expect(out.remote_revoked).toBe(true);
    // The confirmation read failed too, so absence is UNKNOWN — not "still
    // present", which would be a claim this run cannot support.
    expect(out.local_cleared).toBeNull();
    expect(out.local_clear_error).toContain('store unreadable');
  });

  it('--all reports the state left by clearAll, not the state before it', async () => {
    // Each per-URL confirmation read runs BEFORE the store-wide clearAll, so
    // reporting those unchanged would describe a state the command has since
    // replaced — warning that credentials remain in a file it just deleted.
    const store = new FileStore({ dir });
    const baseUrl = mock.baseUrl;
    store.write(baseUrl, creds(baseUrl));
    // Per-URL clear does nothing; only clearAll actually removes anything.
    vi.spyOn(store, 'clear').mockImplementation(() => undefined);

    const core = await import('@orcaops/core');
    vi.spyOn(core, 'resolveCredentialStore').mockReturnValue(store);
    const emitted: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        emitted.push(String(chunk));
        return true;
      });
    try {
      await logoutAction({ all: true, json: true });
    } finally {
      spy.mockRestore();
    }

    const out = JSON.parse(emitted.join('')) as { sessions: Record<string, unknown>[] };
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]!.local_cleared).toBe(true);
    expect(out.sessions[0]!.local_clear_error).toBeNull();
    expect(store.read(baseUrl)).toBeNull();
  });

  it('--all continues past an invalid stored cloud URL and clears every session', async () => {
    const store = new FileStore({ dir });
    const invalidBaseUrl = 'http://staging.internal';
    store.write(invalidBaseUrl, creds(invalidBaseUrl));
    store.write(mock.baseUrl, creds(mock.baseUrl));

    const core = await import('@orcaops/core');
    vi.spyOn(core, 'resolveCredentialStore').mockReturnValue(store);
    const emitted: string[] = [];
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        emitted.push(String(chunk));
        return true;
      });
    try {
      await logoutAction({ all: true, json: true });
    } finally {
      output.mockRestore();
    }

    const result = JSON.parse(emitted.join('')) as {
      sessions: Array<{
        baseUrl: string;
        remote_revoked: boolean;
        remote_revoke_failure: string | null;
        remote_revoke_error: string | null;
        local_cleared: boolean | null;
      }>;
    };
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.find((session) => session.baseUrl === invalidBaseUrl)).toMatchObject({
      remote_revoked: false,
      remote_revoke_failure: 'policy_refused',
      local_cleared: true,
    });
    expect(
      result.sessions.find((session) => session.baseUrl === invalidBaseUrl)?.remote_revoke_error
    ).toMatch(/must use https/);
    expect(result.sessions.find((session) => session.baseUrl === mock.baseUrl)).toMatchObject({
      remote_revoked: true,
      remote_revoke_failure: null,
      remote_revoke_error: null,
      local_cleared: true,
    });
    expect(store.knownBaseUrls()).toEqual([]);
  });

  it('--all identifies outbound-policy refusals in human output', async () => {
    const store = new FileStore({ dir });
    const invalidBaseUrl = 'http://staging.internal';
    store.write(invalidBaseUrl, creds(invalidBaseUrl));

    const core = await import('@orcaops/core');
    vi.spyOn(core, 'resolveCredentialStore').mockReturnValue(store);
    const emitted: string[] = [];
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        emitted.push(String(chunk));
        return true;
      });
    try {
      await logoutAction({ all: true });
    } finally {
      output.mockRestore();
    }

    expect(emitted.join('')).toContain('Outbound policy refused 1');
    expect(store.knownBaseUrls()).toEqual([]);
  });

  it('--all holds one store lock until a waiting writer can safely run', async () => {
    const store = new FileStore({ dir });
    store.write(mock.baseUrl, creds(mock.baseUrl));
    const core = await import('@orcaops/core');
    vi.spyOn(core, 'resolveCredentialStore').mockReturnValue(store);

    const worker = path.join(dir, 'logout-writer.mjs');
    const ready = path.join(dir, 'writer-ready');
    const start = path.join(dir, 'writer-start');
    const attempting = path.join(dir, 'writer-attempting');
    const done = path.join(dir, 'writer-done');
    const nextBaseUrl = 'https://new-login.test';
    const coreDist = path.join(REPO_ROOT, 'packages/core/dist/index.js');
    expect(existsSync(coreDist), 'build @orcaops/core before this cross-process proof').toBe(true);
    await writeFile(
      worker,
      [
        'const [coreDist, dir, ready, start, attempting, done, baseUrl] = process.argv.slice(2);',
        'const { FileStore } = await import(coreDist);',
        'const { existsSync, writeFileSync } = await import("node:fs");',
        'writeFileSync(ready, "ready");',
        'while (!existsSync(start)) await new Promise((r) => setTimeout(r, 10));',
        'const store = new FileStore({ dir });',
        'writeFileSync(attempting, "attempting");',
        'store.write(baseUrl, {',
        '  v: 1, loginMethod: "oauth", baseUrl, userId: "new", orgId: "new",',
        '  orgName: null, orgSlug: null, email: "new@example.test",',
        '  accessToken: "new-at", refreshToken: "new-rt",',
        '  expiresAt: Math.floor(Date.now() / 1000) + 3600,',
        '});',
        'writeFileSync(done, "done");',
      ].join('\n'),
      'utf8'
    );
    const child = spawn(process.execPath, [
      worker,
      coreDist,
      dir,
      ready,
      start,
      attempting,
      done,
      nextBaseUrl,
    ]);
    const clear = store.clear.bind(store);
    vi.spyOn(store, 'clear').mockImplementation((baseUrl) => {
      clear(baseUrl);
      writeFileSync(start, 'start');
    });
    const clearAll = store.clearAll.bind(store);
    vi.spyOn(store, 'clearAll').mockImplementation(() => {
      const lockPath = path.join(dir, '.credentials.lock');
      const ownerFile = readdirSync(lockPath).find((entry) => entry.startsWith('owner.'));
      expect(ownerFile).toBeDefined();
      const owner = JSON.parse(readFileSync(path.join(lockPath, ownerFile!), 'utf8')) as {
        pid: number;
      };
      expect(owner.pid).toBe(process.pid);
      const deadline = Date.now() + 5_000;
      while (!existsSync(attempting) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      expect(existsSync(attempting)).toBe(true);
      expect(existsSync(done)).toBe(false);
      clearAll();
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await waitForFile(ready);
      await logoutAction({ all: true, json: true });
      await waitForChild(child);
      expect(existsSync(done)).toBe(true);
      expect(store.read(nextBaseUrl)?.accessToken).toBe('new-at');
    } finally {
      output.mockRestore();
      if (!existsSync(start)) writeFileSync(start, 'start');
      if (child.exitCode === null) child.kill();
    }
  });
});
