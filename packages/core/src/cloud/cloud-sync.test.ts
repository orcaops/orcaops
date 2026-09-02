import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudWireError, TrpcRequestError } from '@orcaops/sdk';
import {
  ArtifactStore,
  ForbiddenControlCharError,
  getDefaultConfig,
  type PlanInput,
  Store,
} from '@orcaops/storage';

import { resetDefaultCliVersion, setDefaultCliVersion } from './cli-version.js';
import * as clientModule from './client.js';
import { eagerPush, flushPendingPushes } from './cloud-sync.js';
import { ArtifactNotFoundError, MissingGitRemoteError, NotConnectedError } from './errors.js';
import { CloudCapabilityError } from './handshake.js';
import type { PushArtifactOptions, PushArtifactResult } from './sync.js';
import { withRefreshLock } from '../credentials/refresh-lock.js';
import type { Repo } from '../git/repo.js';
import * as snapshotsModule from '../git/snapshots.js';

const SUCCESS_RESULT: PushArtifactResult = {
  skipped: false,
  externalId: 't-1',
  attached: { plan: true, checkpoints: 0, summary: false, evaluators: 0 },
  // Honest per PushArtifactResult: null = this push carried no source-plan pin.
  source_plan_pinned: null,
};

// eagerPush requires a resolved baseUrl + credential store. The describes
// below always inject `pushFn`, so these are only forwarded into the mock —
// a hermetic stub keeps the host's real credential store out.
const EAGER_BASE_URL = 'https://api.test';
function eagerCredStore() {
  return {
    kind: 'file' as const,
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn(),
    clear: vi.fn(),
    knownBaseUrls: () => [EAGER_BASE_URL],
  };
}

function fakeRepo(remoteUrl: string | null = 'git@github.com:o/r.git'): Repo {
  return {
    getRemoteUrl: vi.fn().mockResolvedValue(remoteUrl),
  } as unknown as Repo;
}

describe('eagerPush', () => {
  const ARTIFACT_ID = 'a-1';
  let recordFailure: ReturnType<typeof vi.fn>;
  let fakeRoot: string;
  const fakeStore = (): ArtifactStore =>
    ({
      store: { recordCloudSyncFailure: recordFailure },
      repoRoot: fakeRoot,
    }) as unknown as ArtifactStore;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    fakeRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-cloudsync-'));
    recordFailure = vi.fn();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    stderrSpy.mockRestore();
    const { rm } = await import('node:fs/promises');
    await rm(fakeRoot, { recursive: true, force: true });
  });

  it('silently absorbs NotConnectedError (offline)', async () => {
    const pushFn = vi.fn(async (_: PushArtifactOptions): Promise<PushArtifactResult> => {
      throw new NotConnectedError();
    });
    await eagerPush({
      store: fakeStore(),
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(pushFn).toHaveBeenCalledOnce();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('silently absorbs MissingGitRemoteError', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new MissingGitRemoteError();
    });
    await eagerPush({
      store: fakeStore(),
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('silently absorbs ArtifactNotFoundError', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new ArtifactNotFoundError(ARTIFACT_ID);
    });
    await eagerPush({
      store: fakeStore(),
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('records a timeout failure silently (no stderr — surfaced via doctor/cloud_sync)', async () => {
    const pushFn = vi.fn(
      (opts: PushArtifactOptions) =>
        new Promise<PushArtifactResult>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
        })
    );
    await eagerPush({
      store: fakeStore(),
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      timeoutMs: 25,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledOnce();
    expect(recordFailure.mock.calls[0]![1]).toMatchObject({ kind: 'timeout' });
  });

  it('cancels a credential refresh-lock wait at the eager deadline', async () => {
    const lockDir = path.join(fakeRoot, 'credentials');
    let releaseHolder!: () => void;
    let holderEntered!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      holderEntered = resolve;
    });
    const holder = withRefreshLock(lockDir, async () => {
      holderEntered();
      await held;
    });
    await entered;
    const pushFn = vi.fn(() =>
      withRefreshLock(lockDir, async () => SUCCESS_RESULT, {
        acquireMs: 5_000,
        retryMs: 5,
      })
    );

    const startedAt = Date.now();
    try {
      await eagerPush({
        store: fakeStore(),
        repo: fakeRepo(),
        artifactId: ARTIFACT_ID,
        pushFn,
        timeoutMs: 25,
        baseUrl: EAGER_BASE_URL,
        credentialStore: eagerCredStore(),
      });
    } finally {
      releaseHolder();
      await holder;
    }

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(recordFailure).toHaveBeenCalledOnce();
    expect(recordFailure.mock.calls[0]![1]).toMatchObject({ kind: 'timeout' });
  });

  it('preserves a cooperative env-class error that settles on the deadline', async () => {
    const pushFn = vi.fn(
      (opts: PushArtifactOptions) =>
        new Promise<PushArtifactResult>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new NotConnectedError()), {
            once: true,
          });
        })
    );

    await eagerPush({
      store: fakeStore(),
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      timeoutMs: 25,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });

    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('records an unknown-error failure silently (no stderr)', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new Error('boom');
    });
    await eagerPush({
      store: fakeStore(),
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledOnce();
  });

  it('records a ForbiddenControlCharError as a distinct content-invalid kind (not unknown)', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new ForbiddenControlCharError('evaluators.runs[0].raw.output');
    });
    await eagerPush({
      store: fakeStore(),
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(recordFailure).toHaveBeenCalledOnce();
    const recorded = recordFailure.mock.calls[0]![1] as { kind: string; message: string | null };
    expect(recorded.kind).toBe('content-invalid');
    // keeps the field path so doctor can show where the disallowed byte is
    expect(recorded.message).toContain('evaluators.runs[0].raw.output');
  });

  it('does not warn on a successful push', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => SUCCESS_RESULT);
    await eagerPush({
      store: fakeStore(),
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(pushFn).toHaveBeenCalledOnce();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does not warn on a hash-skip success result', async () => {
    const pushFn = vi.fn(
      async (): Promise<PushArtifactResult> => ({
        skipped: true,
        reason: 'unchanged',
        externalId: 't-1',
        // Honest per the skip path: `snapshot.source_plan ? 'skipped' : null`
        // — this scenario models an unpinned artifact, so null.
        source_plan_pinned: null,
      })
    );
    await eagerPush({
      store: fakeStore(),
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('flushPendingPushes', () => {
  let storeDir: string;
  let store: ArtifactStore;
  let env: NodeJS.ProcessEnv;

  function seedArtifact(s: ArtifactStore, id: string, startedAt: string): void {
    s.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id,
      branch: 'main',
      task: id,
      agent: 'claude',
      base_sha: 'sha',
      started_at: startedAt,
      completed_at: null,
      status: 'active',
    });
  }

  beforeEach(async () => {
    setDefaultCliVersion('0.0.5');
    storeDir = await mkdtemp(path.join(tmpdir(), 'orcaops-flush-store-'));
    // Test-local env copy so ORCAOPS_DISABLE_DRAIN can be dropped without
    // mutating process.env (a cross-test hazard under vitest concurrency).
    env = { ...process.env };
    delete env.ORCAOPS_DISABLE_DRAIN;
    const sqlite = new Store(path.join(storeDir, 'orcaops.db'));
    store = new ArtifactStore({ repoRoot: storeDir, config: getDefaultConfig(), store: sqlite });
  });

  afterEach(async () => {
    resetDefaultCliVersion();
    store.close();
    await rm(storeDir, { recursive: true, force: true });
    // Critical: every flushPendingPushes test that mocks `isAuthReady` must
    // restore so the test that provides a real CredentialStore and expects
    // isAuthReady to invoke it isn't false-passed by a leaked spy from a
    // sibling test.
    vi.restoreAllMocks();
  });

  // The auth-readiness preflight goes through `isAuthReady`. Tests inject
  // the gate explicitly so the host's real keychain / XDG store can't leak
  // in and flip the gate to the wrong side.
  function mockAuthReady(ready: boolean): void {
    vi.spyOn(clientModule, 'isAuthReady').mockResolvedValue(ready);
  }

  // The drain resolves a target cloud + credential store before the preflight.
  // Tests inject a hermetic pair so the host's real store can't leak in.
  const TEST_BASE_URL = 'https://api.test';
  function testCredStore() {
    return {
      kind: 'file' as const,
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn(),
      clear: vi.fn(),
      knownBaseUrls: () => [TEST_BASE_URL],
    };
  }

  it('skips silently when the auth-readiness preflight fails (offline / no token)', async () => {
    mockAuthReady(false);
    seedArtifact(store, 'a', new Date().toISOString());
    const pushFn = vi.fn(async () => SUCCESS_RESULT);
    const result = await flushPendingPushes({ store, repo: fakeRepo(), pushFn, env });
    expect(result).toMatchObject({ skipped: true, reason: 'not-connected', attempted: 0 });
    expect(pushFn).not.toHaveBeenCalled();
  });

  it('skips silently when no git remote is configured', async () => {
    mockAuthReady(true);
    const pushFn = vi.fn(async () => SUCCESS_RESULT);
    const result = await flushPendingPushes({
      store,
      repo: fakeRepo(null),
      pushFn,
      env,
      credentialStore: testCredStore(),
      baseUrl: TEST_BASE_URL,
    });
    expect(result).toMatchObject({ skipped: true, reason: 'missing-remote', attempted: 0 });
    expect(pushFn).not.toHaveBeenCalled();
  });

  it('skips when ORCAOPS_DISABLE_DRAIN=1 even with creds + remote', async () => {
    mockAuthReady(true);
    const drainEnv: NodeJS.ProcessEnv = { ...env, ORCAOPS_DISABLE_DRAIN: '1' };
    const pushFn = vi.fn(async () => SUCCESS_RESULT);
    const result = await flushPendingPushes({ store, repo: fakeRepo(), pushFn, env: drainEnv });
    expect(result).toMatchObject({ skipped: true, reason: 'disabled-by-env', attempted: 0 });
    expect(pushFn).not.toHaveBeenCalled();
  });

  it('drains every candidate artifact when creds + remote are present', async () => {
    mockAuthReady(true);
    seedArtifact(store, 'a', new Date(Date.now() - 1000).toISOString());
    seedArtifact(store, 'b', new Date(Date.now() - 2000).toISOString());
    const pushFn = vi.fn<(opts: PushArtifactOptions) => Promise<PushArtifactResult>>(
      async () => SUCCESS_RESULT
    );
    const result = await flushPendingPushes({
      store,
      repo: fakeRepo(),
      pushFn,
      env,
      credentialStore: testCredStore(),
      baseUrl: TEST_BASE_URL,
    });
    expect(result.skipped).toBe(false);
    expect(result.attempted).toBe(2);
    expect(pushFn).toHaveBeenCalledTimes(2);
  });

  it('forwards force to the push so `resync --force` bypasses the unchanged-hash short-circuit', async () => {
    mockAuthReady(true);
    seedArtifact(store, 'a', new Date(Date.now() - 1000).toISOString());
    const pushFn = vi.fn<(opts: PushArtifactOptions) => Promise<PushArtifactResult>>(
      async () => SUCCESS_RESULT
    );
    await flushPendingPushes({
      store,
      repo: fakeRepo(),
      pushFn,
      env,
      credentialStore: testCredStore(),
      baseUrl: TEST_BASE_URL,
      force: true,
    });
    expect(pushFn).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it('does not force the push on an implicit (non-force) drain', async () => {
    mockAuthReady(true);
    seedArtifact(store, 'a', new Date(Date.now() - 1000).toISOString());
    const pushFn = vi.fn<(opts: PushArtifactOptions) => Promise<PushArtifactResult>>(
      async () => SUCCESS_RESULT
    );
    await flushPendingPushes({
      store,
      repo: fakeRepo(),
      pushFn,
      env,
      credentialStore: testCredStore(),
      baseUrl: TEST_BASE_URL,
    });
    expect(pushFn).toHaveBeenCalledWith(expect.not.objectContaining({ force: true }));
  });

  it('aborts the loop once the total time budget elapses', async () => {
    mockAuthReady(true);
    for (let i = 0; i < 5; i++) {
      seedArtifact(store, `t_${i}`, new Date(Date.now() - i * 1000).toISOString());
    }
    const pushFn = vi.fn<(opts: PushArtifactOptions) => Promise<PushArtifactResult>>(
      () =>
        new Promise<PushArtifactResult>((resolve) => setTimeout(() => resolve(SUCCESS_RESULT), 50))
    );
    const result = await flushPendingPushes({
      store,
      repo: fakeRepo(),
      pushFn,
      totalBudgetMs: 80,
      perPushTimeoutMs: 200,
      env,
      credentialStore: testCredStore(),
      baseUrl: TEST_BASE_URL,
    });
    expect(result.skipped).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.attempted).toBeLessThan(5);
  });

  // Regression guard — the preflight goes through `isAuthReady`
  // (OAuth-aware), not through a credentials file on disk. That file is
  // empty on every OAuth-only install, so gating on it returns
  // `not-connected` on every drain attempt for OAuth users.
  it('uses isAuthReady (OAuth-aware) for the preflight; passes when an OAuth credentialStore has a token', async () => {
    // Construct a real in-memory CredentialStore (no host keychain access).
    const validCreds = {
      v: 1 as const,
      loginMethod: 'oauth' as const,
      baseUrl: 'https://api.test',
      accessToken: 'jwt.test.token',
      refreshToken: 'rt_test',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      userId: 'u',
      orgId: 'o',
      orgName: 'Test Org',
      orgSlug: 'org',
      email: 'alex@example.com',
    };
    const baseUrl = 'https://api.test';
    const memoryStore = {
      kind: 'file' as const,
      read: vi.fn().mockResolvedValue(validCreds),
      write: vi.fn(),
      clear: vi.fn(),
      knownBaseUrls: () => [baseUrl],
    };
    // No on-disk credentials exist for this test; confirms the preflight
    // does not gate on an on-disk credentials file at all.
    seedArtifact(store, 'oauth-only', new Date().toISOString());
    const pushFn = vi.fn(async () => SUCCESS_RESULT);
    const result = await flushPendingPushes({
      store,
      repo: fakeRepo(),
      pushFn,
      env,
      credentialStore: memoryStore,
      baseUrl,
    });
    expect(result.skipped).toBe(false);
    expect(result.attempted).toBe(1);
    expect(memoryStore.read).toHaveBeenCalledWith(baseUrl);
    expect(pushFn).toHaveBeenCalledOnce();
  });

  it('force=true ignores per-artifact backoff (artifact in backoff window is still drained)', async () => {
    mockAuthReady(true);
    seedArtifact(store, 'stuck', new Date(Date.now() - 60_000).toISOString());
    // Mark a recent failure so the backoff filter would gate the artifact.
    const now = new Date().toISOString();
    store.store.recordCloudSyncFailure('stuck', {
      kind: 'http-5xx',
      message: 'cloud broke',
      attemptedAt: now,
      attemptStartedAt: now,
    });
    const pushFn = vi.fn<(opts: PushArtifactOptions) => Promise<PushArtifactResult>>(
      async () => SUCCESS_RESULT
    );

    // Without force the candidate set is empty (artifact gated by backoff).
    const drained = await flushPendingPushes({
      store,
      repo: fakeRepo(),
      pushFn,
      env,
      credentialStore: testCredStore(),
      baseUrl: TEST_BASE_URL,
    });
    expect(drained.attempted).toBe(0);

    // With force the artifact is attempted.
    const forced = await flushPendingPushes({
      store,
      repo: fakeRepo(),
      pushFn,
      force: true,
      env,
      credentialStore: testCredStore(),
      baseUrl: TEST_BASE_URL,
    });
    expect(forced.attempted).toBe(1);
    expect(pushFn).toHaveBeenCalledTimes(1);
  });
});

describe('eagerPush — outcome recording', () => {
  let storeDir: string;
  let store: ArtifactStore;
  const ARTIFACT_ID = 'rec-1';

  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(tmpdir(), 'orcaops-rec-store-'));
    // Every test below injects its own pushFn, so the real pushArtifact —
    // and therefore credential resolution — never runs. No setup needed.
    const sqlite = new Store(path.join(storeDir, 'orcaops.db'));
    store = new ArtifactStore({ repoRoot: storeDir, config: getDefaultConfig(), store: sqlite });
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: ARTIFACT_ID,
      branch: 'main',
      task: 't',
      agent: 'claude',
      base_sha: 'sha',
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'active',
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    store.close();
    await rm(storeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function readState(id: string): {
    cloud_last_push_attempt_at: string | null;
    cloud_last_push_error_kind: string | null;
    cloud_last_push_error_message: string | null;
    cloud_consecutive_failures: number;
  } {
    return store.store.db
      .prepare(
        `SELECT cloud_last_push_attempt_at, cloud_last_push_error_kind,
                cloud_last_push_error_message, cloud_consecutive_failures
         FROM artifacts WHERE id = ?`
      )
      .get(id) as {
      cloud_last_push_attempt_at: string | null;
      cloud_last_push_error_kind: string | null;
      cloud_last_push_error_message: string | null;
      cloud_consecutive_failures: number;
    };
  }

  it('records timeout outcome with null message on EagerPushTimeoutError', async () => {
    const pushFn = vi.fn(
      (opts: PushArtifactOptions) =>
        new Promise<PushArtifactResult>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
        })
    );
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      timeoutMs: 25,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    const row = readState(ARTIFACT_ID);
    expect(row.cloud_last_push_error_kind).toBe('timeout');
    expect(row.cloud_last_push_error_message).toBeNull();
    expect(row.cloud_consecutive_failures).toBe(1);
    expect(row.cloud_last_push_attempt_at).not.toBeNull();
  });

  it('records http-5xx for TrpcRequestError with httpStatus >= 500', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new TrpcRequestError('upstream 502', { httpStatus: 502 });
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe('http-5xx');
  });

  it('records http-4xx for TrpcRequestError with httpStatus 400-499', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new TrpcRequestError('payload too large', { httpStatus: 413 });
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe('http-4xx');
  });

  it('records upgrade-required for a below-minimum appCode, outranking the 4xx bucket', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new TrpcRequestError('client below minimum', {
        httpStatus: 422,
        appCode: 'CLIENT_BELOW_MINIMUM',
        appData: { minimum: '1.0.0', received: null },
      });
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe('upgrade-required');
  });

  it('records upgrade-required for an unsupported payload schema', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new TrpcRequestError('unsupported schema_version', {
        httpStatus: 422,
        appCode: 'PAYLOAD_SCHEMA_UNSUPPORTED',
      });
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe('upgrade-required');
  });

  it('records server-behind for the typed UNKNOWN_PROCEDURE appCode without prose', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new TrpcRequestError('anything', { httpStatus: 404, appCode: 'UNKNOWN_PROCEDURE' });
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe('server-behind');
  });

  describe('a locally-decided capability refusal keeps its kind', () => {
    // Without an explicit arm these fall through to `unknown`, and a background
    // drain would offer a bare retry for a deterministic condition no retry
    // fixes — while the foreground CLI showed the right message. The missing
    // owner-ref capability is the case that actually reaches eager push today.
    it('records server-behind for a missing owner-ref capability, not unknown', async () => {
      const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
        throw new CloudCapabilityError(
          'server-behind',
          'a push carrying a pinned cloud plan',
          'the cloud does not advertise source-plan-owner-ref/v1.'
        );
      });
      await eagerPush({
        store,
        repo: fakeRepo(),
        artifactId: ARTIFACT_ID,
        pushFn,
        baseUrl: EAGER_BASE_URL,
        credentialStore: eagerCredStore(),
      });
      const state = readState(ARTIFACT_ID);
      expect(state.cloud_last_push_error_kind).toBe('server-behind');
      expect(state.cloud_last_push_error_kind).not.toBe('unknown');
      expect(state.cloud_last_push_error_message).toContain('source-plan-owner-ref/v1');
    });

    it.each(['server-behind', 'upgrade-required', 'wire-invalid'] as const)(
      'carries kind %s across verbatim',
      async (kind) => {
        const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
          throw new CloudCapabilityError(kind, 'an operation', 'detail.');
        });
        await eagerPush({
          store,
          repo: fakeRepo(),
          artifactId: ARTIFACT_ID,
          pushFn,
          baseUrl: EAGER_BASE_URL,
          credentialStore: eagerCredStore(),
        });
        expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe(kind);
      }
    );
  });

  it('does not classify missing-procedure prose as server-behind', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new TrpcRequestError('No "mutation"-procedure on path "captureThread.start"', {
        code: 'NOT_FOUND',
        httpStatus: 404,
      });
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe('http-4xx');
  });

  it('records wire-invalid for CloudWireError (reachable but malformed cloud)', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new CloudWireError('non-JSON response from cloud');
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe('wire-invalid');
  });

  it('records network for a TrpcRequestError with no usable status (transport failure)', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new TrpcRequestError('fetch failed', {});
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe('network');
  });

  it('records unknown for arbitrary thrown errors', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new Error('boom');
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(readState(ARTIFACT_ID).cloud_last_push_error_kind).toBe('unknown');
  });

  it('scrubs the persisted error message', async () => {
    const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
      throw new TrpcRequestError('Authorization: Bearer abc123def456 rejected', {
        httpStatus: 401,
      });
    });
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    const row = readState(ARTIFACT_ID);
    expect(row.cloud_last_push_error_message).not.toContain('abc123def456');
    expect(row.cloud_last_push_error_message).toContain('[REDACTED_SECRET]');
  });

  it('does NOT record on env-class outcomes (NotConnected / MissingGitRemote / ArtifactNotFound)', async () => {
    for (const err of [
      new NotConnectedError(),
      new MissingGitRemoteError(),
      new ArtifactNotFoundError(ARTIFACT_ID),
    ]) {
      const pushFn = vi.fn(async (): Promise<PushArtifactResult> => {
        throw err;
      });
      await eagerPush({
        store,
        repo: fakeRepo(),
        artifactId: ARTIFACT_ID,
        pushFn,
        baseUrl: EAGER_BASE_URL,
        credentialStore: eagerCredStore(),
      });
    }
    const row = readState(ARTIFACT_ID);
    expect(row.cloud_last_push_attempt_at).toBeNull();
    expect(row.cloud_last_push_error_kind).toBeNull();
    expect(row.cloud_consecutive_failures).toBe(0);
  });
});

describe('eagerPush — timeout cancellation', () => {
  let storeDir: string;
  let store: ArtifactStore;
  const ARTIFACT_ID = 'late-1';
  let unhandled: ReturnType<typeof vi.fn<(reason: unknown, promise: Promise<unknown>) => void>>;

  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(tmpdir(), 'orcaops-late-store-'));
    // No injected `store:` — the capture path (cli buildContext) lets the
    // ArtifactStore own its Store, so close() genuinely closes the db handle.
    // An injected store would make close() a no-op and mask the race.
    store = new ArtifactStore({ repoRoot: storeDir, config: getDefaultConfig() });
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: ARTIFACT_ID,
      branch: 'main',
      task: 't',
      agent: 'claude',
      base_sha: 'sha',
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'active',
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    unhandled = vi.fn<(reason: unknown, promise: Promise<unknown>) => void>();
    process.on('unhandledRejection', unhandled);
  });

  afterEach(async () => {
    process.off('unhandledRejection', unhandled);
    try {
      store.close();
    } catch {
      // already closed by the test body
    }
    await rm(storeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('awaits abort cleanup before returning and records one timeout', async () => {
    let cleanupFinished = false;
    const pushFn = vi.fn(
      (opts: PushArtifactOptions) =>
        new Promise<PushArtifactResult>((_, reject) => {
          opts.signal?.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                cleanupFinished = true;
                reject(opts.signal?.reason);
              }, 20);
            },
            { once: true }
          );
        })
    );
    await eagerPush({
      store,
      repo: fakeRepo(),
      artifactId: ARTIFACT_ID,
      pushFn,
      timeoutMs: 25,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(cleanupFinished).toBe(true);
    const state = store.store.getCloudSyncStateForArtifact(ARTIFACT_ID);
    expect(state?.lastErrorKind).toBe('timeout');
    expect(state?.consecutiveFailures).toBe(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('aborts the real push stack before tail writes and leaves no orphan work', async () => {
    const REAL_ID = 'late-real-1';
    await store.writePlan({
      schema_version: 4,
      artifact_id: REAL_ID,
      branch: 'main',
      base_sha: 'sha-base',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'real tail after close',
      label: 'real-tail-after-close',
      plan_steps: [
        { step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX', label: 's1', text: 's1', acceptance_criteria: [] },
      ],
      touched_scope: [],
      non_goals: [],
      started_at: new Date().toISOString(),
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });

    let operationSignal: AbortSignal | undefined;
    const r = (v: unknown = {}) => vi.fn().mockResolvedValue(v);
    const attachPlan = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          const signal = operationSignal;
          if (!signal) {
            reject(new Error('missing operation signal'));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    const client = {
      repo: { upsertByRemote: r({ id: 'cloud-repo' }) },
      captureThread: {
        start: r({ id: 'cloud-thread' }),
        update: r({ id: 'cloud-thread' }),
        attachPlan,
        attachPlanRevision: r(),
        attachCheckpointOpened: r(),
        attachCheckpoint: r(),
        attachSummary: r(),
        attachEvaluators: r(),
      },
    };
    vi.spyOn(clientModule, 'createCloudClient').mockImplementation(async (opts) => {
      operationSignal = opts.signal;
      return {
        client: client as never,
        credentials: {
          v: 1,
          loginMethod: 'oauth',
          baseUrl: 'http://localhost:3001',
          orgId: 'o',
          userId: 'u',
          orgName: null,
          orgSlug: null,
          email: 'alex@example.com',
          accessToken: 'jwt.test.token',
          refreshToken: 'rt_test',
          expiresAt: 0,
        },
      };
    });
    vi.spyOn(snapshotsModule, 'collectPrunableRefsForArtifact').mockResolvedValue([]);
    vi.spyOn(snapshotsModule, 'pruneSnapshotRefs').mockResolvedValue({ deleted: 0, refs: [] });
    const repo = {
      cwd: storeDir,
      getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:o/r.git'),
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      getHeadSha: vi.fn().mockResolvedValue('sha-head'),
      branchExists: vi.fn().mockResolvedValue(false),
    } as unknown as Repo;

    await eagerPush({
      store,
      repo,
      artifactId: REAL_ID,
      baseUrl: EAGER_BASE_URL,
      credentialStore: eagerCredStore(),
    });
    expect(attachPlan).toHaveBeenCalledOnce();
    expect(operationSignal?.aborted).toBe(true);
    expect(unhandled).not.toHaveBeenCalled();
    expect(store.store.getCloudSyncState(REAL_ID)).toBeNull();
    const state = store.store.getCloudSyncStateForArtifact(REAL_ID);
    expect(state?.lastErrorKind).toBe('timeout');
    expect(state?.pending).toBe(true);
    const acked = store.store.db
      .prepare(`SELECT last_acked_at FROM cli_session_branch_state`)
      .all() as Array<{ last_acked_at: string | null }>;
    expect(acked.length).toBeGreaterThan(0);
    for (const row of acked) expect(row.last_acked_at).toBeNull();
  }, 10_000);
});

// ── caller-path auto-prune inheritance ───────
//
// The auto-prune gate lives in ONE place (finalizePush inside the real
// pushArtifact). These tests run eagerPush / flushPendingPushes with
// `pushFn` OMITTED (the default = real pushArtifact) + a mocked cloud
// client + spied snapshot helpers, proving the summary-eager and
// resync caller paths inherit the gate. The explicit-push path
// (`push.ts` → pushArtifact, no logic between) is covered directly by
// sync.test.ts — `packages/core` must not import `apps/orcaops-cli`.

describe('auto-prune inherited through eagerPush / flushPendingPushes', () => {
  const ART = 'a1';
  const STEP = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let store: ArtifactStore;

  const PLAN: PlanInput = {
    schema_version: 4,
    artifact_id: ART,
    branch: 'main',
    base_sha: 'sha-base',
    agent: 'claude-code',
    agent_session_id: null,
    task: 'auto-prune inheritance',
    label: 'auto-prune-inherit',
    plan_steps: [{ step_id: STEP, label: 's1', text: 's1', acceptance_criteria: [] }],
    touched_scope: [],
    non_goals: [],
    started_at: new Date().toISOString(),
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    prior_plan_event_id: null,
    decisions: [],
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
  };

  function mockRepo(remoteUrl: string | null = 'git@github.com:o/r.git'): Repo {
    return {
      cwd: dir,
      getRemoteUrl: vi.fn().mockResolvedValue(remoteUrl),
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      getHeadSha: vi.fn().mockResolvedValue('sha-head'),
      branchExists: vi.fn().mockResolvedValue(false),
    } as unknown as Repo;
  }

  // createCloudClient is mocked via mountClient, so the credential store only
  // feeds the drain's org-filter read; a null-returning stub is enough.
  const TEST_BASE_URL = 'https://api.test';
  function autoPruneCredStore() {
    return {
      kind: 'file' as const,
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn(),
      clear: vi.fn(),
      knownBaseUrls: () => [TEST_BASE_URL],
    };
  }

  function mountClient(overrides: Record<string, unknown> = {}): void {
    const r = (v: unknown = {}) => vi.fn().mockResolvedValue(v);
    const client = {
      repo: { upsertByRemote: r({ id: 'cloud-repo' }) },
      captureThread: {
        start: r({ id: 'cloud-thread' }),
        update: r({ id: 'cloud-thread' }),
        attachPlan: r(),
        attachPlanRevision: r(),
        attachCheckpointOpened: r(),
        attachCheckpoint: r(),
        attachSummary: r(),
        attachEvaluators: r(),
        ...overrides,
      },
    };
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: {
        v: 1,
        loginMethod: 'oauth',
        baseUrl: 'http://localhost:3001',
        orgId: 'o',
        userId: 'u',
        orgName: null,
        orgSlug: null,
        email: 'alex@example.com',
        accessToken: 'jwt.test.token',
        refreshToken: 'rt_test',
        expiresAt: 0,
      },
    });
  }

  function spyPrune() {
    const refs = [`refs/orcaops/snap/${ART}/1/close`];
    const collect = vi
      .spyOn(snapshotsModule, 'collectPrunableRefsForArtifact')
      .mockResolvedValue(refs);
    const prune = vi
      .spyOn(snapshotsModule, 'pruneSnapshotRefs')
      .mockResolvedValue({ deleted: refs.length, refs });
    return { collect, prune };
  }

  const boundary = (phase: string) => ({
    snapshot_ref: `refs/orcaops/snap/${ART}/1/${phase}`,
    tree_sha: (phase === 'open' ? 'a' : 'b').repeat(40),
    snapshot_commit_sha: 'c'.repeat(40),
    snapshot_error_reason: null,
  });

  async function seedCapturedCp(): Promise<void> {
    await store.writeCheckpointOpened(
      { artifact_id: ART, declared_step_ids: [STEP] },
      {
        idempotencyKey: 'o1',
        headSha: 'cafef00d',
        snapshotCallbacks: { captureOpenSnapshot: async () => ({ boundary: boundary('open') }) },
      }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: ART,
        n: 1,
        summary: 'closed',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [STEP],
        head_sha: 'cafef00d',
      },
      {
        idempotencyKey: 'c1',
        snapshotCallbacks: {
          captureCloseFingerprint: async () =>
            ({
              boundary: boundary('close'),
              summary: {
                status: 'captured',
                hunk_count: 1,
                captured_hunk_count: 1,
                truncated: false,
                fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2',
                manifest_hash: 'a'.repeat(43),
                manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
                error_reason: null,
              },
              manifest: {
                schema_version: 1,
                artifact_id: ART,
                checkpoint_n: 1,
                open_tree_sha: 'a'.repeat(40),
                close_tree_sha: 'b'.repeat(40),
                status: 'captured',
                hunk_count: 1,
                captured_hunk_count: 1,
                truncated: false,
                error_reason: null,
                normalization_version: 'orcaops-line-normalization-v1',
                diff_algorithm: 'git-diff-unified-v1',
                diff_options: { unified: 3, find_renames: true, no_ext_diff: true },
                limits: { max_diff_bytes: 2_000_000 },
                hash_encoding: 'base64url-nopad',
                line_hash_algorithm: 'blake3-xof-96-base64url-nopad-v2',
                patch_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
                hunk_header_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
                manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
                hunks: [
                  {
                    hunk_index: 0,
                    file_before: null,
                    file_after: 'f.ts',
                    change_type: 'add',
                    binary: false,
                    old_start: null,
                    old_lines: null,
                    new_start: 1,
                    new_lines: 1,
                    patch_hash: 'ph0',
                    added_line_hashes: ['lh-0-padpadpad'],
                    deleted_line_hashes: [],
                    hunk_header_hash: null,
                    added_line_count: 1,
                    deleted_line_count: 0,
                  },
                ],
              },
            }) as never,
        },
      }
    );
  }

  async function seedSummary(): Promise<void> {
    await store.writeSummary({
      schema_version: 1,
      artifact_id: ART,
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'cafef00d',
      ts: new Date().toISOString(),
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-autoprune-store-'));
    env = { ...process.env };
    delete env.ORCAOPS_DISABLE_DRAIN;
    store = new ArtifactStore({ repoRoot: dir, config: getDefaultConfig() });
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: ART,
      branch: 'main',
      task: PLAN.task,
      agent: PLAN.agent,
      base_sha: PLAN.base_sha,
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
    });
    await store.writePlan(PLAN);
    // These tests cover the auto-prune chain through flushPendingPushes
    // (resync path, real pushArtifact). Force the auth-readiness preflight
    // to pass so the drain reaches pushArtifact, which `mountClient`-spy
    // intercepts.
    vi.spyOn(clientModule, 'isAuthReady').mockResolvedValue(true);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('eagerPush (summary path, real pushArtifact) inherits the prune on success', async () => {
    await seedCapturedCp();
    await seedSummary();
    const { collect, prune } = spyPrune();
    mountClient();

    await eagerPush({
      store,
      repo: mockRepo(),
      artifactId: ART,
      baseUrl: TEST_BASE_URL,
      credentialStore: autoPruneCredStore(),
    });

    expect(collect).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(expect.anything(), [`refs/orcaops/snap/${ART}/1/close`]);
  });

  it('eagerPush does NOT prune when there is no summary (in-flight)', async () => {
    await seedCapturedCp(); // no summary
    const { prune } = spyPrune();
    mountClient();

    await eagerPush({
      store,
      repo: mockRepo(),
      artifactId: ART,
      baseUrl: TEST_BASE_URL,
      credentialStore: autoPruneCredStore(),
    });

    expect(prune).not.toHaveBeenCalled();
  });

  it('eagerPush does NOT prune when the cloud client rejects (error absorbed)', async () => {
    await seedCapturedCp();
    await seedSummary();
    const { prune } = spyPrune();
    mountClient({ start: vi.fn().mockRejectedValue(new Error('cloud 500')) });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await eagerPush({
      store,
      repo: mockRepo(),
      artifactId: ART,
      baseUrl: TEST_BASE_URL,
      credentialStore: autoPruneCredStore(),
    });

    expect(prune).not.toHaveBeenCalled();
    expect(store.store.getCloudSyncState(ART)).toBeNull();
    stderrSpy.mockRestore();
  });

  it('flushPendingPushes (resync path, real pushArtifact) inherits the prune', async () => {
    await seedCapturedCp();
    await seedSummary();
    const { collect, prune } = spyPrune();
    mountClient();

    const result = await flushPendingPushes({
      store,
      repo: mockRepo(),
      env,
      force: true,
      baseUrl: TEST_BASE_URL,
      credentialStore: autoPruneCredStore(),
    });

    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledTimes(1);
  });
});
