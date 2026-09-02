import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileStore } from '@orcaops/core';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { clearCloudLogin, commitFile } from '../support/test-helpers.js';

/**
 * Drain×capture composition in the REAL `capture checkpoint` command path.
 *
 * Every capture command runs a pre-body sync drain (isAuthReady → ensureFreshToken)
 * BEFORE snapshot capture, so a stale-but-refreshable credential is refreshed first;
 * an un-refreshable one stays stale. Snapshot capture itself is auth-independent
 * and proceeds in BOTH cases — what this file pins is the drain ordering
 * (the refresh is spent before capture) and that a failed refresh does not degrade
 * capture. The refresh MECHANISM (discovery → /oauth2/token → FileStore.write, both
 * branches) is already proven in packages/core/src/cloud/refresh-integration.test.ts —
 * this file mirrors its lightweight loopback server.
 */

// Mirror of refresh-integration.test.ts's loopback server: serves discovery (so the SDK
// resolves token_endpoint) + the refresh grant (ok | invalid_grant), and counts token
// POSTs so a test can prove the drain actually refreshed (vs. some other path).
interface MockCloud {
  baseUrl: string;
  tokenPosts: number;
  mode: 'ok' | 'invalid_grant';
  close: () => Promise<void>;
}

async function startMockCloud(): Promise<MockCloud> {
  const state = { tokenPosts: 0, mode: 'ok' as 'ok' | 'invalid_grant', baseUrl: '' };
  const server: Server = createServer((req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: state.baseUrl,
          authorization_endpoint: `${state.baseUrl}/oauth2/authorize`,
          token_endpoint: `${state.baseUrl}/oauth2/token`,
          revocation_endpoint: `${state.baseUrl}/oauth2/revoke`,
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['cli:full', 'offline_access'],
        })
      );
      return;
    }
    if (req.url === '/oauth2/token' && req.method === 'POST') {
      state.tokenPosts += 1;
      if (state.mode === 'invalid_grant') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ access_token: 'fresh_at', refresh_token: 'rotated_rt', expires_in: 3600 })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server address');
  state.baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    get baseUrl() {
      return state.baseUrl;
    },
    get tokenPosts() {
      return state.tokenPosts;
    },
    set mode(m: 'ok' | 'invalid_grant') {
      state.mode = m;
    },
    get mode() {
      return state.mode;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface OpenProj {
  open_snapshot: { tree_sha: string | null };
}
interface ClosedProj {
  close_snapshot: { tree_sha: string | null };
  diff_fingerprint_summary: { status: string };
}

describe('checkpoint snapshot — drain×gate composition (command path)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let cloud: MockCloud;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    cloud = await startMockCloud();
    // Drain ENABLED (no ORCAOPS_DISABLE_DRAIN) — exercising it is the whole point.
    agent = makeAgent({ cwd: repo.path, cloudBaseUrl: cloud.baseUrl });
    clearCloudLogin();
  });

  afterEach(async () => {
    clearCloudLogin();
    await cloud.close();
    await repo.cleanup();
  });

  async function readProj<T>(artifactId: string, n: number): Promise<T> {
    const p = path.join(repo.path, '.orcaops', 'artifacts', artifactId, `checkpoint-${n}.json`);
    return JSON.parse(await readFile(p, 'utf8')) as T;
  }

  // init + capture plan with NO seeded login. The plan command also runs the pre-body
  // drain, so seeding stale creds AFTER this is what guarantees the refresh is done by
  // the later CHECKPOINT command's drain, not the plan's — that's the ordering under test.
  async function planNoLogin(): Promise<{ artifactId: string; stepId: string }> {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const r = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'drain composition test',
          label: 'drain-composition',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
    const ok = JSON.parse(r.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    return { artifactId: ok.artifact_id, stepId: ok.plan_steps[0].step_id };
  }

  // Bare new FileStore() resolves the cli-setup's per-file ORCAOPS_CONFIG_HOME — the SAME
  // store the CLI's resolveCredentialStore() reads. The agent explicitly injects
  // this loopback cloud into both the Commander actions and background drain.
  function seedStaleLogin(): void {
    new FileStore().write(cloud.baseUrl, {
      v: 1,
      loginMethod: 'oauth',
      baseUrl: cloud.baseUrl,
      userId: 'usr_1',
      orgId: 'org_1',
      orgName: null,
      orgSlug: null,
      email: 'e@test',
      accessToken: 'stale_at',
      refreshToken: 'rt_valid',
      expiresAt: Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60, // 60 days past expiry (past grace)
    });
  }

  async function openCp(artifactId: string, stepId: string): Promise<void> {
    const r = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: artifactId,
          declared_step_ids: [stepId],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
  }

  async function closeCp(artifactId: string, stepId: string): Promise<void> {
    const r = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: artifactId,
          n: 1,
          summary: 'cp1',
          files_changed: ['src/foo.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepId],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
  }

  it('ok refresh: stale-but-refreshable → drain refreshes → checkpoint captures', async () => {
    const { artifactId, stepId } = await planNoLogin();
    seedStaleLogin();

    await openCp(artifactId, stepId);

    // The checkpoint command's drain spent the refresh token (proves the drain ran),
    // and capture proceeded on the now-fresh credential.
    expect(cloud.tokenPosts).toBeGreaterThanOrEqual(1);
    expect(new FileStore().read(cloud.baseUrl)?.accessToken).toBe('fresh_at');
    const openProj = await readProj<OpenProj>(artifactId, 1);
    expect(openProj.open_snapshot.tree_sha).not.toBeNull();

    await commitFile(repo.path, 'src/foo.ts', 'export const x = 1;\n', 'add foo');
    await closeCp(artifactId, stepId);
    const proj = await readProj<ClosedProj>(artifactId, 1);
    expect(proj.close_snapshot.tree_sha).not.toBeNull();
    expect(proj.diff_fingerprint_summary.status).toBe('captured');
  });

  it('invalid_grant: stale + un-refreshable → drain fails → checkpoint still captures', async () => {
    cloud.mode = 'invalid_grant';
    const { artifactId, stepId } = await planNoLogin();
    seedStaleLogin();

    await openCp(artifactId, stepId);

    // Refresh was attempted (>=1) but rejected; expiresAt stayed stale — and capture
    // proceeded anyway (the snapshot path is auth-independent).
    expect(cloud.tokenPosts).toBeGreaterThanOrEqual(1);
    expect(new FileStore().read(cloud.baseUrl)?.accessToken).toBe('stale_at'); // unchanged
    const openProj = await readProj<OpenProj>(artifactId, 1);
    expect(openProj.open_snapshot.tree_sha).not.toBeNull();

    await commitFile(repo.path, 'src/foo.ts', 'export const x = 1;\n', 'add foo');
    await closeCp(artifactId, stepId);
    const proj = await readProj<ClosedProj>(artifactId, 1);
    expect(proj.close_snapshot.tree_sha).not.toBeNull();
    expect(proj.diff_fingerprint_summary.status).toBe('captured');
  });
});
