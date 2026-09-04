import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type StoredCredentials, TrpcRequestError } from '@orcaops/sdk';
import {
  ArtifactStore,
  getDefaultConfig,
  type PlanInput,
  rebuildCache,
  RecoveryRefusedError,
  type SourcePlanPin,
  UsageLedger,
  withNonDerivableWriteLease,
} from '@orcaops/storage';

import * as clientModule from './client.js';
import {
  ArtifactNotFoundError,
  DoneCriterionTextUnresolvableError,
  ImportedArtifactLocalOnlyError,
  MissingGitRemoteError,
  NotConnectedError,
  RepoUrlTooLongError,
} from './errors.js';
import { type ArtifactUsageData } from './hash.js';
import { bornPinExternalId } from './source-plan-pin.js';
import { materializeArtifactUsage, pushArtifact, toWireEvaluators, toWireUsage } from './sync.js';
import type { Repo } from '../git/repo.js';
import * as snapshotsModule from '../git/snapshots.js';

function buildMockClient() {
  // Cloud responses:
  // - cliProcedure mutations that enqueue commands (start, update, complete,
  //   repo.upsertByRemote) return { commandId, status: 'accepted' }.
  // - attach* mutations remain synchronous tRPC writes and return the
  //   AttachedEntity ({ id, ...passthrough }) shape per the SDK contract.
  const ack = (id: string) => ({ commandId: id, status: 'accepted' as const });
  const entity = (id: string) => ({ id });
  const upsertByRemote = vi.fn().mockResolvedValue(ack('cmd_repo_upsert'));
  const start = vi.fn().mockResolvedValue(ack('cmd_start'));
  const update = vi.fn().mockResolvedValue(ack('cmd_update'));
  const attachPlan = vi.fn().mockResolvedValue(entity('ent_plan'));
  const attachPlanRevision = vi.fn().mockResolvedValue(entity('ent_plan_rev'));
  const attachCheckpointOpened = vi.fn().mockResolvedValue(entity('ent_cp_open'));
  const attachCheckpoint = vi.fn().mockResolvedValue(entity('ent_cp'));
  const attachSummary = vi.fn().mockResolvedValue(entity('ent_summary'));
  const attachEvaluators = vi.fn().mockResolvedValue([entity('ent_eval')]);
  const attachCodingSessionsUsage = vi.fn().mockResolvedValue([entity('ent_usage')]);

  const client = {
    repo: { upsertByRemote },
    captureThread: {
      start,
      update,
      attachPlan,
      attachPlanRevision,
      attachCheckpointOpened,
      attachCheckpoint,
      attachSummary,
      attachEvaluators,
      attachCodingSessionsUsage,
    },
  };

  return {
    client,
    mocks: {
      upsertByRemote,
      start,
      attachPlan,
      attachPlanRevision,
      attachCheckpointOpened,
      attachCheckpoint,
      attachSummary,
      attachEvaluators,
      attachCodingSessionsUsage,
    },
  };
}

function mockRepo(remoteUrl: string | null): Repo {
  return {
    cwd: '/tmp/sync-test-working-dir',
    getRemoteUrl: vi.fn().mockResolvedValue(remoteUrl),
    getCurrentBranch: vi.fn().mockResolvedValue('main'),
    getHeadSha: vi.fn().mockResolvedValue('sha-head'),
    branchExists: vi.fn().mockResolvedValue(false),
  } as unknown as Repo;
}

// Deterministic stand-in for the ssh -G host resolver. Returning the host
// unchanged means "not an alias", so canonicalizeRemoteUrl is a no-op and wire
// assertions never depend on the runner's ~/.ssh/config or a real ssh binary.
const identityResolveHost = async (host: string): Promise<string | null> => host;

const PLAN: PlanInput = {
  schema_version: 4,
  artifact_id: 'a1',
  branch: 'main',
  base_sha: 'sha-base',
  agent: 'claude-code',
  agent_session_id: null,
  task: 'demo task',
  label: 'lbl',
  plan_steps: [
    {
      step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
      label: 'step 1',
      text: 'step 1',
      acceptance_criteria: [],
    },
  ],
  touched_scope: [],
  non_goals: [],
  started_at: '2026-04-28T01:00:00.000Z',
  revision_n: 0,
  revised_at: null,
  rationale: null,
  step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
  criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
  decisions: [],
  prior_plan_event_id: null,
};

const ORG_ID = 'org-test';
const USER_ID = 'user-test';
const TEST_BASE_URL = 'http://localhost:3001';

// Full credential blob matching the SDK's StoredCredentials shape. The push
// path reads only `orgId` off it; the remaining fields are inert test values.
function testCredentials(orgId: string, baseUrl: string = TEST_BASE_URL): StoredCredentials {
  return {
    v: 1,
    loginMethod: 'oauth',
    baseUrl,
    userId: USER_ID,
    orgId,
    orgName: null,
    orgSlug: null,
    email: 'alex@example.com',
    accessToken: 'jwt.test.token',
    refreshToken: 'rt_test',
    expiresAt: 0,
  };
}

// pushArtifact requires a caller-resolved credential store. createCloudClient
// is mocked throughout this suite, so the store is only threaded, never read —
// a hermetic null-returning stub keeps the host's real store out.
function testCredentialStore() {
  return {
    kind: 'file' as const,
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn(),
    clear: vi.fn(),
    knownBaseUrls: () => [TEST_BASE_URL],
  };
}

describe('pushArtifact', () => {
  let dir: string;
  let credsHome: string;
  let store: ArtifactStore;

  function mountClientWithPausedStart() {
    const { client, mocks } = buildMockClient();
    let releaseStart!: () => void;
    let startEntered!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    mocks.start.mockImplementationOnce(async () => {
      startEntered();
      await held;
      return { commandId: 'cmd_start', status: 'accepted' as const };
    });
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });
    return { mocks, entered, releaseStart };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-sync-'));
    credsHome = path.join(dir, 'creds');
    store = new ArtifactStore({ repoRoot: dir, config: getDefaultConfig() });
    fs.mkdirSync(credsHome, { recursive: true });
    fs.writeFileSync(
      path.join(credsHome, 'credentials.json'),
      JSON.stringify({ baseUrl: 'http://localhost:3001', orgId: ORG_ID, userId: USER_ID }),
      { mode: 0o600 }
    );
    // Seed an artifact row + plan on disk.
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: PLAN.artifact_id,
      branch: PLAN.branch,
      task: PLAN.task,
      agent: PLAN.agent,
      base_sha: PLAN.base_sha,
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
    });
    await store.writePlan(PLAN);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('throws NotConnectedError when no credentials are loaded', async () => {
    // The OAuth FileStore reads ORCAOPS_CONFIG_HOME / XDG_CONFIG_HOME, so
    // this suite cannot scope credentials via env alone. Mock
    // createCloudClient to throw the same NotConnectedError it would on a
    // no-creds path, which preserves the test's contract without depending
    // on that env var.
    vi.spyOn(clientModule, 'createCloudClient').mockRejectedValue(
      new NotConnectedError('Not connected. Run `orcaops login` first.')
    );
    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('throws ArtifactNotFoundError when the artifact id is missing locally', async () => {
    const { client } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });
    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: 'does-not-exist',
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it('refuses an imported artifact before any cloud client is constructed', async () => {
    const clientSpy = vi
      .spyOn(clientModule, 'createCloudClient')
      .mockRejectedValue(new Error('cloud client constructed'));
    store.store.upsertArtifact({
      label: 'imported-label',
      non_goals: '[]',
      id: 'imported-1',
      branch: 'origin/main',
      task: 'imported task',
      agent: 'other',
      base_sha: 'sha-base',
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
      origin_kind: 'git-import',
    });
    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: 'imported-1',
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toBeInstanceOf(ImportedArtifactLocalOnlyError);
    expect(clientSpy).not.toHaveBeenCalled();
  });

  it('throws MissingGitRemoteError when origin is not configured', async () => {
    const { client } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });
    await expect(
      pushArtifact({
        store,
        repo: mockRepo(null),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toBeInstanceOf(MissingGitRemoteError);
  });

  it('on happy path issues the SDK calls in the documented order', async () => {
    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    const result = await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      resolveHost: identityResolveHost,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(result.skipped).toBe(false);
    expect(result.externalId).toBe(PLAN.artifact_id);
    // Cloud resolves repoUrl → Repo row internally at handle time; the CLI
    // never calls upsertByRemote. The session-state PK still normalizes
    // locally but no pre-flight RPC is required.
    expect(mocks.upsertByRemote).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: PLAN.artifact_id,
        repoUrl: 'git@github.com:foo/bar.git',
        branch: PLAN.branch,
        description: PLAN.task,
        agent: PLAN.agent,
        startedAt: PLAN.started_at,
      })
    );
    // `externalId` is the wire-stable identity.
    const startArg = (mocks.start as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(startArg).not.toHaveProperty('id');
    // V4 wire: toWirePlan emits the full structured plan verbatim
    // (schema_version 4, per-step acceptance_criteria, structured non_goals,
    // criterion_lineage).
    expect(mocks.attachPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        ...PLAN,
        schema_version: 4,
        // The V4 wire criterion_lineage carries {added, removed, rewritten}
        // only — OssPlanPayload.parse strips the storage-side `carried` key.
        criterion_lineage: { added: [], removed: [], rewritten: [] },
      })
    );
    expect(mocks.attachCheckpoint).not.toHaveBeenCalled();
    expect(mocks.attachSummary).not.toHaveBeenCalled();
    expect(mocks.attachEvaluators).not.toHaveBeenCalled();
    // A usage-less artifact must NOT attach usage (its hash omits it too).
    expect(mocks.attachCodingSessionsUsage).not.toHaveBeenCalled();
  });

  it('attaches coding-sessions usage (after evaluators) when the artifact has usage', async () => {
    // Seed one session's usage into the SAME store the push reads from.
    const ledger = new UsageLedger({ repoRoot: dir, store: store.store });
    await ledger.appendUsageSnapshot({
      agent: 'claude-code',
      session_id: 'sess-1',
      artifact_id: PLAN.artifact_id,
      source_plan_ref_id: null,
      lifecycle_event: 'checkpoint_close',
      checkpoint_n: 1,
      cumulative_usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 200,
      },
      model_breakdown: [
        {
          model: 'claude-opus-4-8',
          cumulative: {
            input_tokens: 100,
            output_tokens: 40,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 200,
          },
        },
      ],
      record_count: 7,
      as_of: '2026-04-28T02:00:00.000Z',
      ts: '2026-04-28T02:00:00.000Z',
      baseline_hint: 'first_observation',
      idempotency_key: 'usage-k1',
    });

    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      resolveHost: identityResolveHost,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(mocks.attachCodingSessionsUsage).toHaveBeenCalledTimes(1);
    const payload = (mocks.attachCodingSessionsUsage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.artifact_id).toBe(PLAN.artifact_id);
    // exact session total, native → wire renamed
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]).toMatchObject({
      agent: 'claude-code',
      session_id: 'sess-1',
      total: { in: 100, out: 40, cache_read: 200, cache_write: 5 },
      record_count: 7,
    });
    expect(payload.sessions[0].model_breakdown).toEqual([
      {
        model: 'claude-opus-4-8',
        cumulative: { in: 100, out: 40, cache_read: 200, cache_write: 5 },
      },
    ]);
    // snapshots are cumulative-only — no delta_* on the wire
    expect(payload.snapshots).toHaveLength(1);
    expect(payload.snapshots[0].cumulative).toEqual({
      in: 100,
      out: 40,
      cache_read: 200,
      cache_write: 5,
    });
    expect(Object.keys(payload.snapshots[0]).some((k: string) => k.includes('delta'))).toBe(false);
    // emitted within the attach sequence, after the plan (the usage block sits
    // immediately after attachEvaluators in pushArtifact).
    const usageOrder = (mocks.attachCodingSessionsUsage as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    const planOrder = (mocks.attachPlan as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(usageOrder).toBeGreaterThan(planOrder);
  });

  it('materializeArtifactUsage emits source-plan-linked snapshots (own + ts<=linked_at scope)', async () => {
    const ledger = new UsageLedger({ repoRoot: dir, store: store.store });
    // a pre-capture source-plan snapshot (artifact_id=null), recorded before linked_at
    await ledger.appendUsageSnapshot({
      agent: 'claude-code',
      session_id: 'sess-sp',
      artifact_id: null,
      source_plan_ref_id: 'cloud:ext1',
      lifecycle_event: 'plan_review',
      checkpoint_n: null,
      cumulative_usage: {
        input_tokens: 30,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model_breakdown: [],
      record_count: 1,
      as_of: '2026-04-28T00:00:00.000Z',
      ts: '2026-04-28T00:00:00.000Z',
      baseline_hint: 'prior_same_source_plan',
      idempotency_key: 'sp-1',
    });
    await ledger.appendSourcePlanLink({
      canonical_ref_id: 'cloud:ext1',
      artifact_id: PLAN.artifact_id,
      linked_at: '2026-04-28T01:00:00.000Z',
      pinned_version: null,
      idempotency_key: 'L-1',
    });

    const usage = materializeArtifactUsage(store, PLAN.artifact_id);
    expect(usage).not.toBeNull();
    // the artifact_id=null source-plan snapshot is in scope (ts <= linked_at) and
    // therefore reaches the wire — readUsageSnapshots(artifact_id=X) would drop it.
    expect(usage!.snapshots.map((s) => s.idempotency_key)).toContain('sp-1');
    expect(usage!.snapshots.find((s) => s.idempotency_key === 'sp-1')!.artifact_id).toBeNull();
    expect(usage!.source_plan_links.map((l) => l.source_plan_ref_id)).toContain('cloud:ext1');
  });

  it('materializeArtifactUsage returns null for a links-only (pinned, tokenless) artifact', async () => {
    const ledger = new UsageLedger({ repoRoot: dir, store: store.store });
    // a source-plan link with no in-scope sessions or snapshots → nothing to attribute
    await ledger.appendSourcePlanLink({
      canonical_ref_id: 'cloud:ext2',
      artifact_id: PLAN.artifact_id,
      linked_at: '2026-04-28T01:00:00.000Z',
      pinned_version: null,
      idempotency_key: 'L-2',
    });
    expect(materializeArtifactUsage(store, PLAN.artifact_id)).toBeNull();
  });

  it('toWireUsage carries the lifecycle_event labels (summary, pre_pr_check) to the wire', async () => {
    const ledger = new UsageLedger({ repoRoot: dir, store: store.store });
    await ledger.appendUsageSnapshot({
      agent: 'claude-code',
      session_id: 'sess-life',
      artifact_id: PLAN.artifact_id,
      source_plan_ref_id: null,
      lifecycle_event: 'summary',
      checkpoint_n: null,
      cumulative_usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model_breakdown: [],
      record_count: 1,
      as_of: '2026-04-28T00:00:00.000Z',
      ts: '2026-04-28T00:00:00.000Z',
      baseline_hint: 'prior_same_artifact',
      idempotency_key: 'life-summary',
    });
    await ledger.appendUsageSnapshot({
      agent: 'claude-code',
      session_id: 'sess-life',
      artifact_id: PLAN.artifact_id,
      source_plan_ref_id: null,
      lifecycle_event: 'pre_pr_check',
      checkpoint_n: null,
      cumulative_usage: {
        input_tokens: 20,
        output_tokens: 9,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model_breakdown: [],
      record_count: 2,
      as_of: '2026-04-28T00:01:00.000Z',
      ts: '2026-04-28T00:01:00.000Z',
      baseline_hint: 'prior_same_artifact',
      idempotency_key: 'life-prepr',
    });

    const usage = materializeArtifactUsage(store, PLAN.artifact_id);
    expect(usage).not.toBeNull();
    // The free-form lifecycle_event passes through toWireUsageSnapshot unfiltered,
    // so labels added at new lifecycle sites reach the cloud with no wire change.
    const events = toWireUsage(usage!, PLAN.artifact_id).snapshots.map((s) => s.lifecycle_event);
    expect(events).toContain('summary');
    expect(events).toContain('pre_pr_check');
  });

  it('attachPlan carries the rev-0 plan decisions (with alternatives) on the wire', async () => {
    const artifactId = 'a-dec0';
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: artifactId,
      branch: PLAN.branch,
      task: PLAN.task,
      agent: PLAN.agent,
      base_sha: PLAN.base_sha,
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
    });
    await store.writePlan({
      ...PLAN,
      artifact_id: artifactId,
      decisions: [
        {
          decision: 'sliding-window rate limiter',
          reason: 'smooths burst-at-boundary',
          revision_n: 0,
          alternatives_considered: [
            {
              option: 'fixed-window counter',
              rejected_because: 'allows a 2x burst across the boundary',
            },
          ],
        },
      ],
    });

    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId,
      resolveHost: identityResolveHost,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    // Rev 0 → attachPlan, carrying the plan decision verbatim (incl. alternatives).
    expect(mocks.attachPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        revision_n: 0,
        decisions: [
          {
            decision: 'sliding-window rate limiter',
            reason: 'smooths burst-at-boundary',
            revision_n: 0,
            alternatives_considered: [
              {
                option: 'fixed-window counter',
                rejected_because: 'allows a 2x burst across the boundary',
              },
            ],
          },
        ],
      })
    );
    expect(mocks.attachPlanRevision).not.toHaveBeenCalled();
  });

  it('attachPlanRevision carries the cumulative decision set across revisions', async () => {
    const artifactId = 'a-dec-rev';
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: artifactId,
      branch: PLAN.branch,
      task: PLAN.task,
      agent: PLAN.agent,
      base_sha: PLAN.base_sha,
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
    });
    // rev 0 carries one decision...
    await store.writePlan({
      ...PLAN,
      artifact_id: artifactId,
      decisions: [
        {
          decision: 'D0 rev-0 choice',
          reason: 'made up front',
          revision_n: 0,
          alternatives_considered: [{ option: 'alt0', rejected_because: 'no0' }],
        },
      ],
    });
    // ...rev 1 appends a new decision (base shape — write path stamps revision_n).
    await store.revisePlan(
      {
        idempotency_key: 'dec-rev-r1',
        artifact_id: artifactId,
        label: 'rev1-label',
        plan_steps: PLAN.plan_steps.map((s) => ({
          step_id: s.step_id,
          text: s.text,
          label: s.label,
          acceptance_criteria: s.acceptance_criteria,
        })),
        touched_scope: [],
        non_goals: [],
        decisions: [{ decision: 'D1 rev-1 choice', reason: 'discovered mid-flight' }],
        rationale: 'add D1',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'dec-rev-r1' }
    );

    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId,
      resolveHost: identityResolveHost,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    // Rev ≥1 → attachPlanRevision, carrying the FULL cumulative set (append-only),
    // each entry keeping its made-at revision_n.
    expect(mocks.attachPlan).not.toHaveBeenCalled();
    expect(mocks.attachPlanRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        revision_n: 1,
        decisions: [
          expect.objectContaining({
            decision: 'D0 rev-0 choice',
            revision_n: 0,
            alternatives_considered: [{ option: 'alt0', rejected_because: 'no0' }],
          }),
          expect.objectContaining({ decision: 'D1 rev-1 choice', revision_n: 1 }),
        ],
      })
    );
  });

  it('ships the alias-resolved canonical URL on the wire when ssh resolves an alias', async () => {
    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com-alex:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      resolveHost: async () => 'github.com',
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    // The cloud's host allowlist sees the resolved host, not the alias.
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: 'git@github.com:foo/bar.git' })
    );
  });

  it('caps RepoUrlTooLong on the canonical wire URL, not the raw alias URL', async () => {
    const { client } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    // Raw alias URL is over the 2048 cap, but canonicalizes to a short host —
    // the cloud only ever sees the canonical value, so the guard must not fire.
    const rawOverCap = `git@github.com-${'a'.repeat(2100)}:foo/bar.git`;
    expect(rawOverCap.length).toBeGreaterThan(2048);

    await expect(
      pushArtifact({
        store,
        repo: mockRepo(rawOverCap),
        artifactId: PLAN.artifact_id,
        resolveHost: async () => 'github.com',
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).resolves.toMatchObject({ skipped: false });
  });

  it('throws RepoUrlTooLongError when the wire URL still exceeds the cap', async () => {
    const { client } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    // Non-SSH URL is passed through unchanged by canonicalize, so the cap fires.
    const rawOverCap = `https://github.com/foo/${'a'.repeat(2100)}`;
    expect(rawOverCap.length).toBeGreaterThan(2048);

    await expect(
      pushArtifact({
        store,
        repo: mockRepo(rawOverCap),
        artifactId: PLAN.artifact_id,
        resolveHost: identityResolveHost,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toBeInstanceOf(RepoUrlTooLongError);
  });

  it('records sync state after a successful push', async () => {
    const { client } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });
    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    const state = store.store.getCloudSyncState(PLAN.artifact_id);
    expect(state).not.toBeNull();
    expect(state!.externalId).toBe(PLAN.artifact_id);
    expect(state!.orgId).toBe(ORG_ID);
    expect(state!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replays the same cloud artifact after rebuild and then skips an unchanged retry', async () => {
    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });
    const push = () =>
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });

    await push();
    await rebuildCache({ repoRoot: dir, config: getDefaultConfig(), store: store.store });

    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeNull();
    expect(store.store.getArtifact(PLAN.artifact_id)?.id).toBe(PLAN.artifact_id);
    expect(store.store.getCloudSyncStateForArtifact(PLAN.artifact_id)?.pending).toBe(true);

    const replayed = await push();
    const unchanged = await push();

    expect(replayed).toMatchObject({ skipped: false, externalId: PLAN.artifact_id });
    expect(unchanged).toMatchObject({ skipped: true, reason: 'unchanged' });
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.start.mock.calls.map(([input]) => input.externalId)).toEqual([
      PLAN.artifact_id,
      PLAN.artifact_id,
    ]);
  });

  it('keeps a stale push pending when summary content lands after its snapshot', async () => {
    const { mocks, entered, releaseStart } = mountClientWithPausedStart();

    const pushing = pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    await entered;
    await store.writeSummary({
      schema_version: 1,
      artifact_id: PLAN.artifact_id,
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'cafef00d',
      ts: '2026-05-16T00:00:00.000Z',
    });
    releaseStart();
    await pushing;

    expect(mocks.attachSummary).not.toHaveBeenCalled();
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeNull();
    expect(store.store.getCloudSyncStateForArtifact(PLAN.artifact_id)?.pending).toBe(true);
  });

  it('keeps a stale push pending when usage lands after its snapshot', async () => {
    const { mocks, entered, releaseStart } = mountClientWithPausedStart();

    const pushing = pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    await entered;
    const ledger = new UsageLedger({ repoRoot: dir, store: store.store });
    await ledger.appendUsageSnapshot({
      agent: 'claude-code',
      session_id: 'race-session',
      artifact_id: PLAN.artifact_id,
      source_plan_ref_id: null,
      lifecycle_event: 'summary',
      checkpoint_n: null,
      cumulative_usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model_breakdown: [],
      record_count: 1,
      as_of: '2026-05-16T00:00:01.000Z',
      ts: '2026-05-16T00:00:01.000Z',
      baseline_hint: 'first_observation',
      idempotency_key: 'usage-race',
    });
    releaseStart();
    await pushing;

    expect(mocks.attachCodingSessionsUsage).not.toHaveBeenCalled();
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeNull();
    expect(store.store.getCloudSyncStateForArtifact(PLAN.artifact_id)?.pending).toBe(true);
  });

  it('keeps a stale push pending when a source-plan usage link lands after its snapshot', async () => {
    const ledger = new UsageLedger({ repoRoot: dir, store: store.store });
    await ledger.appendUsageSnapshot({
      agent: 'claude-code',
      session_id: 'source-session',
      artifact_id: null,
      source_plan_ref_id: 'cloud:source-plan@1',
      lifecycle_event: 'plan',
      checkpoint_n: null,
      cumulative_usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model_breakdown: [],
      record_count: 1,
      as_of: '2026-05-16T00:00:00.000Z',
      ts: '2026-05-16T00:00:00.000Z',
      baseline_hint: 'first_observation',
      idempotency_key: 'source-usage-race',
    });
    const { mocks, entered, releaseStart } = mountClientWithPausedStart();

    const pushing = pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    await entered;
    await ledger.appendSourcePlanLink({
      canonical_ref_id: 'cloud:source-plan@1',
      artifact_id: PLAN.artifact_id,
      linked_at: '2026-05-16T00:00:01.000Z',
      pinned_version: '1',
      idempotency_key: 'source-link-race',
    });
    releaseStart();
    await pushing;

    expect(mocks.attachCodingSessionsUsage).not.toHaveBeenCalled();
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeNull();
    expect(store.store.getCloudSyncStateForArtifact(PLAN.artifact_id)?.pending).toBe(true);
  });

  it('does not let an older push overwrite a newer acknowledged payload', async () => {
    const { entered, releaseStart } = mountClientWithPausedStart();

    const olderPush = pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    await entered;
    const ledger = new UsageLedger({ repoRoot: dir, store: store.store });
    await ledger.appendUsageSnapshot({
      agent: 'claude-code',
      session_id: 'newer-push-session',
      artifact_id: PLAN.artifact_id,
      source_plan_ref_id: null,
      lifecycle_event: 'checkpoint_close',
      checkpoint_n: 1,
      cumulative_usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model_breakdown: [],
      record_count: 1,
      as_of: '2026-05-16T00:00:00.000Z',
      ts: '2026-05-16T00:00:00.000Z',
      baseline_hint: 'first_observation',
      idempotency_key: 'newer-push-usage',
    });
    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    const newerState = store.store.getCloudSyncState(PLAN.artifact_id);
    expect(newerState).not.toBeNull();
    releaseStart();
    await olderPush;

    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toEqual(newerState);
    expect(store.store.getCloudSyncStateForArtifact(PLAN.artifact_id)?.pending).toBe(false);
  });

  it('skips on a second push when nothing has changed', async () => {
    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    const second = await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('unchanged');
    // Cloud was hit once total — once for the first push, not the second.
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('clears a recorded failure when an unchanged retry succeeds', async () => {
    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    const firstSync = store.store.getCloudSyncState(PLAN.artifact_id);
    if (!firstSync) throw new Error('expected initial cloud sync state');
    const failedAt = new Date(Date.parse(firstSync.syncedAt) + 1).toISOString();
    store.store.recordCloudSyncFailure(PLAN.artifact_id, {
      kind: 'network',
      message: 'transient failure',
      attemptedAt: failedAt,
      attemptStartedAt: failedAt,
    });
    expect(store.store.getCloudSyncStateForArtifact(PLAN.artifact_id)?.pending).toBe(true);

    const retried = await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(retried).toMatchObject({ skipped: true, reason: 'unchanged' });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(store.store.getCloudSyncStateForArtifact(PLAN.artifact_id)).toMatchObject({
      pending: false,
      consecutiveFailures: 0,
      lastErrorKind: null,
    });
  });

  it('keeps a fully landed push synced when the deadline fires before its local tail', async () => {
    const abort = new AbortController();
    const { client, mocks } = buildMockClient();
    mocks.attachPlan.mockImplementationOnce(async () => {
      abort.abort(new Error('eager deadline reached'));
      return { id: 'ent_plan' };
    });
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        signal: abort.signal,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toThrow('eager deadline reached');

    expect(mocks.attachPlan).toHaveBeenCalledOnce();
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).not.toBeNull();
    const session = store.store.getSessionBranchState(
      'https://github.com/foo/bar',
      '/tmp/sync-test-working-dir'
    );
    expect(session?.lastAckedAt).not.toBeNull();
  });

  it('keeps a true unchanged no-op independent of the rebuild lock', async () => {
    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });
    const push = () =>
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
    await push();

    let releaseHolder!: () => void;
    let holderEntered!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      holderEntered = resolve;
    });
    const holder = withNonDerivableWriteLease(dir, async () => {
      holderEntered();
      await held;
    });
    await entered;
    const releaseTimer = setTimeout(releaseHolder, 500);
    const startedAt = Date.now();
    const second = await push();
    const elapsedMs = Date.now() - startedAt;
    clearTimeout(releaseTimer);
    releaseHolder();
    await holder;

    expect(second).toMatchObject({ skipped: true, reason: 'unchanged' });
    expect(elapsedMs).toBeLessThan(400);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('--force bypasses the unchanged short-circuit', async () => {
    const { client, mocks } = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID),
    });

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      force: true,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it('re-pushes when the cloud_org_id differs from the current credentials', async () => {
    const { client: c1 } = buildMockClient();
    const spy = vi.spyOn(clientModule, 'createCloudClient');
    spy.mockResolvedValueOnce({
      client: c1 as never,
      credentials: testCredentials('org-A'),
    });
    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    const { client: c2, mocks: m2 } = buildMockClient();
    spy.mockResolvedValueOnce({
      client: c2 as never,
      credentials: testCredentials('org-B'),
    });
    const second = await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(second.skipped).toBe(false);
    expect(m2.start).toHaveBeenCalledTimes(1);
    expect(store.store.getCloudSyncState(PLAN.artifact_id)?.orgId).toBe('org-B');
  });

  describe('branch-history wiring', () => {
    function repoWithBranch(
      branch: string,
      head = 'sha-head',
      opts: { existingBranches?: ReadonlyArray<string> } = {}
    ): Repo {
      const present = new Set(opts.existingBranches ?? []);
      return {
        cwd: '/tmp/sync-test-working-dir',
        getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:foo/bar.git'),
        getCurrentBranch: vi.fn().mockResolvedValue(branch),
        getHeadSha: vi.fn().mockResolvedValue(head),
        branchExists: vi.fn().mockImplementation(async (name: string) => present.has(name)),
      } as unknown as Repo;
    }

    function mountClient(): ReturnType<typeof buildMockClient>['mocks'] {
      const built = buildMockClient();
      vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
        client: built.client as never,
        credentials: testCredentials(ORG_ID),
      });
      return built.mocks;
    }

    /**
     * Mint a fresh artifact + plan with the given captured branch. Lets a
     * test pin plan.branch independently of the suite's default PLAN
     * fixture (whose `main` value makes assertions about live-vs-captured
     * branch divergence ambiguous).
     */
    async function seedPlanOnBranch(artifactId: string, branch: string): Promise<void> {
      store.store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        id: artifactId,
        branch,
        task: PLAN.task,
        agent: PLAN.agent,
        base_sha: PLAN.base_sha,
        started_at: PLAN.started_at,
        completed_at: null,
        status: 'active',
      });
      await store.writePlan({ ...PLAN, artifact_id: artifactId, branch });
    }

    it('ships explicit empty branchHistory on a first push', async () => {
      const mocks = mountClient();
      await pushArtifact({
        store,
        repo: repoWithBranch(PLAN.branch),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
      const startArgs = mocks.start.mock.calls[0][0];
      expect(startArgs.branch).toBe(PLAN.branch);
      expect(startArgs.branchHistory).toEqual([]);
    });

    it('ships the rename chain in branchHistory when the local branch differs from the stored row', async () => {
      // Seed: a prior session observed branch=`old-name` for this (repo, cwd).
      store.store.upsertSessionBranchState({
        repoUrl: 'https://github.com/foo/bar',
        workingDir: '/tmp/sync-test-working-dir',
        currentBranch: 'old-name',
        branchHistory: [],
        baseCommitSha: 'sha-base',
      });

      const mocks = mountClient();
      await pushArtifact({
        store,
        repo: repoWithBranch(PLAN.branch),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
      const startArgs = mocks.start.mock.calls[0][0];
      expect(startArgs.branch).toBe(PLAN.branch);
      expect(startArgs.branchHistory).toEqual(['old-name']);
    });

    it('ships the live git branch (not the recorded plan branch) so mid-flight renames propagate', async () => {
      // The CLI's wire `branch` field is "current branch right now" — used by
      // the cloud's task-routing path. If the agent renamed the branch after
      // plan capture (or between pushes of the same artifact), the recorded
      // plan.branch is stale; shipping it would mask the rename signal.
      store.store.upsertSessionBranchState({
        repoUrl: 'https://github.com/foo/bar',
        workingDir: '/tmp/sync-test-working-dir',
        currentBranch: PLAN.branch,
        branchHistory: [],
        baseCommitSha: 'sha-base',
      });

      const mocks = mountClient();
      await pushArtifact({
        store,
        repo: repoWithBranch('renamed-mid-flight'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
      const startArgs = mocks.start.mock.calls[0][0];
      expect(startArgs.branch).toBe('renamed-mid-flight');
      expect(startArgs.branchHistory).toEqual([PLAN.branch]);
    });

    it('clears the branch-history chain via markAcked after a successful push', async () => {
      store.store.upsertSessionBranchState({
        repoUrl: 'https://github.com/foo/bar',
        workingDir: '/tmp/sync-test-working-dir',
        currentBranch: 'old',
        branchHistory: ['older'],
        baseCommitSha: 'sha-base',
      });

      mountClient();
      await pushArtifact({
        store,
        repo: repoWithBranch(PLAN.branch),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
      const after = store.store.getSessionBranchState(
        'https://github.com/foo/bar',
        '/tmp/sync-test-working-dir'
      );
      expect(after?.branchHistory).toEqual([]);
      expect(after?.lastAckedAt).not.toBeNull();
      expect(after?.currentBranch).toBe(PLAN.branch);
    });

    it('preserves the rename chain when a downstream attach fails after start acks', async () => {
      // If markAcked fires right after captureThread.start,
      // a 5xx on any subsequent attach (Plan / Checkpoint / Summary / Evaluators)
      // wipes the chain and the next retry starts blind. With markAcked moved to
      // after the last attach, an attach failure must leave the chain intact so
      // the retry can still route through to the existing task.
      store.store.upsertSessionBranchState({
        repoUrl: 'https://github.com/foo/bar',
        workingDir: '/tmp/sync-test-working-dir',
        currentBranch: 'old-name',
        branchHistory: [],
        baseCommitSha: 'sha-base',
      });

      const built = buildMockClient();
      built.mocks.attachPlan.mockRejectedValueOnce(new Error('5xx from cloud'));
      vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
        client: built.client as never,
        credentials: testCredentials(ORG_ID),
      });

      await expect(
        pushArtifact({
          store,
          repo: repoWithBranch(PLAN.branch),
          artifactId: PLAN.artifact_id,
          baseUrl: TEST_BASE_URL,
          credentialStore: testCredentialStore(),
        })
      ).rejects.toThrow('5xx from cloud');

      const after = store.store.getSessionBranchState(
        'https://github.com/foo/bar',
        '/tmp/sync-test-working-dir'
      );
      // syncToGit wrote the post-reconcile row before the start call, so the
      // current branch reflects the rename and the chain holds the prior name.
      // markAcked never fired → branchHistory still carries 'old-name', so the
      // next push retry surfaces the chain to the cloud.
      expect(after?.currentBranch).toBe(PLAN.branch);
      expect(after?.branchHistory).toEqual(['old-name']);
      expect(after?.lastAckedAt).toBeNull();
    });

    it('ships empty branchHistory when the stored branch still exists locally', async () => {
      // Branch-off case: feature A's PR is open on
      // the cloud, user runs `git checkout -b feat-b feat-a` and CAPTURES
      // a new artifact from feat-b. Without the branch-off detection, the
      // CLI would ship branchHistory=[feat-a] and cloud would pull the new
      // captures into Task A's spine. With the detection, the prior branch
      // still exists, so syncToGit resets the session row to a fresh
      // feat-b state and ships no history — cloud creates a fresh task.
      const inFlightId = 'a1-feat-b';
      await seedPlanOnBranch(inFlightId, 'feat-b');

      store.store.upsertSessionBranchState({
        repoUrl: 'https://github.com/foo/bar',
        workingDir: '/tmp/sync-test-working-dir',
        currentBranch: 'feat-a',
        branchHistory: [],
        baseCommitSha: 'sha-base',
      });

      const mocks = mountClient();
      await pushArtifact({
        store,
        repo: repoWithBranch('feat-b', 'sha-b', { existingBranches: ['feat-a'] }),
        artifactId: inFlightId,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
      const startArgs = mocks.start.mock.calls[0][0];
      expect(startArgs.branch).toBe('feat-b');
      expect(startArgs.branchHistory).toEqual([]);
      // Stored row reset to the new branch — no carryover history.
      const after = store.store.getSessionBranchState(
        'https://github.com/foo/bar',
        '/tmp/sync-test-working-dir'
      );
      expect(after?.currentBranch).toBe('feat-b');
      expect(after?.branchHistory).toEqual([]);
    });

    it('ships snapshot.plan.branch (not live branch) when pushing a historical artifact from a forked branch', async () => {
      // Scenario: an agent captures on `feat-a`, then runs
      // `git checkout -b feat-b feat-a`, then pushes a still-historical
      // feat-a artifact from feat-b. Without the historical-fork guard
      // the wire branch becomes feat-b and the cloud silently re-
      // attributes the capture to feat-b's task while overwriting the
      // cloud row's `branch` column.
      //
      // Seed: captured artifact pinned to feat-a; session post branch-off
      // sits on feat-b with no chain (mirrors what syncToGit would write).
      const historicalId = 'a1-historical-feat-a';
      await seedPlanOnBranch(historicalId, 'feat-a');
      store.store.upsertSessionBranchState({
        repoUrl: 'https://github.com/foo/bar',
        workingDir: '/tmp/sync-test-working-dir',
        currentBranch: 'feat-b',
        branchHistory: [],
        baseCommitSha: 'sha-base',
      });

      const mocks = mountClient();
      await pushArtifact({
        store,
        // Live is feat-b; feat-a still exists locally (fork, not rename).
        repo: repoWithBranch('feat-b', 'sha-b', { existingBranches: ['feat-a'] }),
        artifactId: historicalId,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
      const startArgs = mocks.start.mock.calls[0][0];
      expect(startArgs.branch).toBe('feat-a');
      expect(startArgs.branchHistory).toEqual([]);
    });

    it('preserves the rename chain when a historical-fork push happens mid-rename', async () => {
      // Edge case: an in-flight rename has staged feat-b ← feat-a (chain
      // holds ['feat-a']). Before the rename acks, the agent pushes a
      // historical artifact captured on feat-c (an unrelated past branch).
      // The historical-fork guard must ship feat-c — AND not run markAcked,
      // so the next in-flight push still carries the pending rename chain
      // up to the cloud.
      const historicalId = 'a1-historical-feat-c';
      await seedPlanOnBranch(historicalId, 'feat-c');
      store.store.upsertSessionBranchState({
        repoUrl: 'https://github.com/foo/bar',
        workingDir: '/tmp/sync-test-working-dir',
        currentBranch: 'feat-b',
        branchHistory: ['feat-a'],
        baseCommitSha: 'sha-base',
      });

      const mocks = mountClient();
      await pushArtifact({
        store,
        // Live branch is feat-b (already renamed from feat-a). syncToGit's
        // unchanged path returns the stored row as-is.
        repo: repoWithBranch('feat-b', 'sha-b'),
        artifactId: historicalId,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
      const startArgs = mocks.start.mock.calls[0][0];
      expect(startArgs.branch).toBe('feat-c');
      expect(startArgs.branchHistory).toEqual([]);
      // The pending rename chain must survive — markAcked never fired on
      // the historical-fork push.
      const after = store.store.getSessionBranchState(
        'https://github.com/foo/bar',
        '/tmp/sync-test-working-dir'
      );
      expect(after?.currentBranch).toBe('feat-b');
      expect(after?.branchHistory).toEqual(['feat-a']);
      expect(after?.lastAckedAt).toBeNull();
    });

    it('still ships the live branch + chain when the historical artifact was renamed (plan.branch in chain)', async () => {
      // The opposite-side case of the previous test: artifact captured on
      // feat-a, then renamed feat-a → feat-b. plan.branch === 'feat-a' is
      // now present in branchHistory. The historical-fork guard must NOT
      // fire here — we want the cloud to route feat-a's historical capture
      // through to the feat-b task via the rename chain.
      const historicalId = 'a1-historical-feat-a-renamed';
      await seedPlanOnBranch(historicalId, 'feat-a');
      store.store.upsertSessionBranchState({
        repoUrl: 'https://github.com/foo/bar',
        workingDir: '/tmp/sync-test-working-dir',
        currentBranch: 'feat-b',
        branchHistory: ['feat-a'], // plan.branch ('feat-a') is in the chain
        baseCommitSha: 'sha-base',
      });

      const mocks = mountClient();
      await pushArtifact({
        store,
        repo: repoWithBranch('feat-b', 'sha-b'),
        artifactId: historicalId,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
      const startArgs = mocks.start.mock.calls[0][0];
      expect(startArgs.branch).toBe('feat-b');
      expect(startArgs.branchHistory).toEqual(['feat-a']);
    });

    it('falls back to snapshot.plan.branch with empty branchHistory on detached HEAD', async () => {
      // `git rev-parse --abbrev-ref HEAD` returns the
      // literal string "HEAD" in a detached state (rebase / bisect / checkout-
      // by-sha). Without a guard the CLI would ship branch="HEAD" which the
      // cloud would try to match against a task literally named "HEAD". The
      // hardened path returns null from syncToGit so pushArtifact falls back
      // to snapshot.plan.branch with no chain.
      const detachedRepo = {
        cwd: '/tmp/sync-test-working-dir',
        getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:foo/bar.git'),
        getCurrentBranch: vi.fn().mockResolvedValue('HEAD'),
        getHeadSha: vi.fn().mockResolvedValue('sha-head'),
      } as unknown as Repo;

      const mocks = mountClient();
      await pushArtifact({
        store,
        repo: detachedRepo,
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      });
      const startArgs = mocks.start.mock.calls[0][0];
      expect(startArgs.branch).toBe(PLAN.branch); // not "HEAD"
      expect(startArgs.branchHistory).toEqual([]);
    });

    it('falls back to snapshot.plan.branch when git introspection throws', async () => {
      // getHeadSha() or getCurrentBranch() throwing on an
      // empty repo / worktree corruption must not block the capture push. The
      // hardened path catches and falls back to the snapshot's plan branch.
      const brokenRepo = {
        cwd: '/tmp/sync-test-working-dir',
        getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:foo/bar.git'),
        getCurrentBranch: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'fatal: not a git repository \u001b[2J ghp_ABCDEF1234567890abcdef1234567890ABCDEF'
            )
          ),
        getHeadSha: vi.fn().mockResolvedValue('sha-head'),
      } as unknown as Repo;

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const mocks = mountClient();
        await pushArtifact({
          store,
          repo: brokenRepo,
          artifactId: PLAN.artifact_id,
          baseUrl: TEST_BASE_URL,
          credentialStore: testCredentialStore(),
        });
        const startArgs = mocks.start.mock.calls[0][0];
        expect(startArgs.branch).toBe(PLAN.branch);
        expect(startArgs.branchHistory).toEqual([]);
        const warning = String(warn.mock.calls[0]?.[0]);
        expect(warning).toContain('[REDACTED_SECRET]');
        expect(warning).not.toContain('\u001b');
        expect(warning).not.toContain('ghp_ABCDEF');
      } finally {
        warn.mockRestore();
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// toWireEvaluators — protocol-aligned wire shape.
// Unit-level tests on the pure transform; integration with pushArtifact
// is covered by the broader push-flow tests above (which exercise the
// attachEvaluators mock).
// ─────────────────────────────────────────────────────────────────────

describe('toWireEvaluators', () => {
  const baseRun = {
    schema: 'orcaops.evaluator_run/v1' as const,
    run_id: '01HXRUN0000000000000000000',
    artifact_id: '01HXART0000000000000000000',
    evaluator_ref: 'core/api-stability',
    package_id: 'core',
    evaluator_id: 'api-stability',
    severity: 'block' as const,
    run_status: 'completed' as const,
    verdict: 'violation' as const,
    body: 'VIOLATION',
    ts: '2026-05-12T20:30:00.000Z',
    source_event_index: 4,
    local_kind_rank: 0 as const,
    local_index: 0,
    disposition: 'unresolved' as const,
  };

  it('preserves checkpoint-open and checkpoint-close as distinct phases (no collapse)', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [
        { ...baseRun, run_id: 'r-open', phase: 'checkpoint-open' },
        {
          ...baseRun,
          run_id: 'r-close',
          phase: 'checkpoint-close',
          source_event_index: 5,
        },
      ],
      dispositions: [],
    }) as unknown as {
      runs: Array<{ phase: string; run_id: string }>;
      dispositions: unknown[];
    };
    const phases = wire.runs.map((r) => r.phase);
    expect(phases).toContain('checkpoint-open');
    expect(phases).toContain('checkpoint-close');
    expect(phases).not.toContain('post-checkpoint');
  });

  it('sends run_status, verdict, and disposition as separate fields', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [{ ...baseRun, phase: 'checkpoint-close' }],
      dispositions: [],
    }) as unknown as {
      runs: Array<{ run_status: string; verdict: string | null; disposition: string | null }>;
    };
    expect(wire.runs[0].run_status).toBe('completed');
    expect(wire.runs[0].verdict).toBe('violation');
    expect(wire.runs[0].disposition).toBe('unresolved');
  });

  it('keeps the local provider field off the frozen cloud wire', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [{ ...baseRun, phase: 'checkpoint-close', provider: 'claude' }],
      dispositions: [],
    });
    expect(wire.runs[0]).not.toHaveProperty('provider');
  });

  it('emits the dispositions[] array as a separate top-level field', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [{ ...baseRun, phase: 'checkpoint-close', disposition: 'acknowledged' }],
      dispositions: [
        {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: 'd-1',
          artifact_id: 'a-1',
          run_id: 'r-1',
          evaluator_ref: 'core/api-stability',
          disposition: 'acknowledged',
          reason: 'ack',
          agent_session_id: null,
          ts: '2026-05-12T20:35:00.000Z',
          source_event_index: 5,
          local_kind_rank: 1,
          local_index: 0,
        },
      ],
    }) as unknown as {
      dispositions: Array<{ disposition: string; run_id: string }>;
    };
    expect(wire.dispositions).toHaveLength(1);
    expect(wire.dispositions[0].disposition).toBe('acknowledged');
  });

  it('forwards order-key components on each run and disposition', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [
        {
          ...baseRun,
          phase: 'checkpoint-close',
          source_event_index: 7,
          local_kind_rank: 0,
          local_index: 2,
        },
      ],
      dispositions: [
        {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: 'd-1',
          artifact_id: 'a-1',
          run_id: 'r-1',
          evaluator_ref: 'core/api-stability',
          disposition: 'acknowledged',
          reason: 'ack',
          agent_session_id: null,
          ts: '2026-05-12T20:35:00.000Z',
          source_event_index: 8,
          local_kind_rank: 1,
          local_index: 0,
        },
      ],
    }) as unknown as {
      runs: Array<{
        source_event_index: number;
        local_kind_rank: number;
        local_index: number;
      }>;
      dispositions: Array<{
        source_event_index: number;
        local_kind_rank: number;
        local_index: number;
      }>;
    };
    expect(wire.runs[0]).toMatchObject({
      source_event_index: 7,
      local_kind_rank: 0,
      local_index: 2,
    });
    expect(wire.dispositions[0]).toMatchObject({
      source_event_index: 8,
      local_kind_rank: 1,
      local_index: 0,
    });
  });

  it('omits optional fields when not present on the materialized row', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [{ ...baseRun, phase: 'checkpoint-close' }],
      dispositions: [],
    }) as unknown as {
      runs: Array<Record<string, unknown>>;
    };
    expect(wire.runs[0].raw).toBeUndefined();
    expect(wire.runs[0].metrics).toBeUndefined();
    expect(wire.runs[0].tokens).toBeUndefined();
    expect(wire.runs[0].cost_usd).toBeUndefined();
    expect(wire.runs[0].model).toBeUndefined();
  });

  it('preserves null verdict and null disposition for errored / skipped runs', () => {
    const wire = toWireEvaluators({
      schema_version: 1,
      artifact_id: 'a-1',
      source_event_id: 'ev-log-src',
      runs: [
        {
          ...baseRun,
          run_id: 'r-error',
          phase: 'checkpoint-close',
          run_status: 'error',
          verdict: null,
          body: 'ERROR',
          error: { code: 'TIMEOUT', message: 'timed out' },
          disposition: null,
        },
      ],
      dispositions: [],
    }) as unknown as {
      runs: Array<{ run_status: string; verdict: null; disposition: null; error: unknown }>;
    };
    expect(wire.runs[0].verdict).toBeNull();
    expect(wire.runs[0].disposition).toBeNull();
    expect(wire.runs[0].error).toEqual({ code: 'TIMEOUT', message: 'timed out' });
  });
});

describe('pushArtifact — fingerprint wire (v2/v4 + strict sync)', () => {
  let dir: string;
  let store: ArtifactStore;
  const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
  const TREE_O = 'a'.repeat(40);
  const TREE_C = 'b'.repeat(40);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-sync-fp-'));
    const credsHome = path.join(dir, 'creds');
    store = new ArtifactStore({ repoRoot: dir, config: getDefaultConfig() });
    fs.mkdirSync(credsHome, { recursive: true });
    fs.writeFileSync(
      path.join(credsHome, 'credentials.json'),
      JSON.stringify({ baseUrl: 'http://localhost:3001', orgId: ORG_ID, userId: USER_ID }),
      { mode: 0o600 }
    );
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: PLAN.artifact_id,
      branch: PLAN.branch,
      task: PLAN.task,
      agent: PLAN.agent,
      base_sha: PLAN.base_sha,
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
    });
    await store.writePlan(PLAN);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function successBoundary(phase: string) {
    return {
      snapshot_ref: `refs/orcaops/snap/${PLAN.artifact_id}/1/${phase}`,
      tree_sha: phase === 'open' ? TREE_O : TREE_C,
      snapshot_commit_sha: 'c'.repeat(40),
      snapshot_error_reason: null,
    };
  }

  function capturedManifest(lineHashes: number) {
    return {
      schema_version: 1 as const,
      artifact_id: PLAN.artifact_id,
      checkpoint_n: 1,
      open_tree_sha: TREE_O,
      close_tree_sha: TREE_C,
      status: 'captured' as const,
      hunk_count: 1,
      captured_hunk_count: 1,
      truncated: false,
      error_reason: null,
      normalization_version: 'orcaops-line-normalization-v1' as const,
      diff_algorithm: 'git-diff-unified-v1' as const,
      diff_options: { unified: 3 as const, find_renames: true, no_ext_diff: true },
      limits: { max_diff_bytes: 2_000_000 },
      hash_encoding: 'base64url-nopad' as const,
      line_hash_algorithm: 'blake3-xof-96-base64url-nopad-v2' as const,
      patch_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1' as const,
      hunk_header_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1' as const,
      manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1' as const,
      hunks: [
        {
          hunk_index: 0,
          file_before: null,
          file_after: 'f.ts',
          change_type: 'add' as const,
          binary: false,
          old_start: null,
          old_lines: null,
          new_start: 1,
          new_lines: lineHashes,
          patch_hash: 'ph0',
          added_line_hashes: Array.from({ length: lineHashes }, (_u, j) => `lh-${j}-padpadpad`),
          deleted_line_hashes: [],
          hunk_header_hash: null,
          added_line_count: lineHashes,
          deleted_line_count: 0,
        },
      ],
    };
  }

  function capturedSummary() {
    return {
      status: 'captured' as const,
      hunk_count: 1,
      captured_hunk_count: 1,
      truncated: false,
      fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2' as const,
      manifest_hash: 'a'.repeat(43),
      manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1' as const,
      error_reason: null,
    };
  }

  async function open(idem: string, boundary = successBoundary('open')) {
    await store.writeCheckpointOpened(
      { artifact_id: PLAN.artifact_id, declared_step_ids: [STEP_ID] },
      {
        idempotencyKey: idem,
        headSha: 'cafef00d',
        snapshotCallbacks: { captureOpenSnapshot: async () => ({ boundary }) },
      }
    );
  }

  async function close(
    idem: string,
    out: { boundary: unknown; summary: unknown; manifest: unknown }
  ) {
    await store.writeCheckpointClosed(
      {
        artifact_id: PLAN.artifact_id,
        n: 1,
        summary: 'closed',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [STEP_ID],
        head_sha: 'cafef00d',
      },
      {
        idempotencyKey: idem,
        snapshotCallbacks: { captureCloseFingerprint: async () => out as never },
      }
    );
  }

  function mountClient() {
    const built = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: built.client as never,
      credentials: testCredentials(ORG_ID),
    });
    return built.mocks;
  }

  it('sends a v4 closed payload with snapshots + summary + full manifest, no raw text', async () => {
    await open('o1');
    await close('c1', {
      boundary: successBoundary('close'),
      summary: capturedSummary(),
      manifest: capturedManifest(3),
    });
    const localCheckpoint = store.store.getCheckpoints(PLAN.artifact_id)[0];
    const mocks = mountClient();

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(mocks.attachCheckpoint).toHaveBeenCalledTimes(1);
    const payload = mocks.attachCheckpoint.mock.calls[0][0];
    expect(payload.opened_at).toBe(localCheckpoint.opened_at);
    expect(payload.schema_version).toBe(4);
    expect(payload.open_snapshot.tree_sha).toBe(TREE_O);
    expect(payload.close_snapshot.tree_sha).toBe(TREE_C);
    expect(payload.diff_fingerprint_summary.status).toBe('captured');
    expect(payload.diff_fingerprint).toBeDefined();
    expect(payload.diff_fingerprint.hunks[0].added_line_hashes.length).toBe(3);
    // No raw diff / patch / line text anywhere in the wire payload.
    const json = JSON.stringify(payload);
    for (const k of ['diff', 'patch', 'raw_diff', 'raw_patch', 'diff_text', 'patch_text']) {
      expect(payload).not.toHaveProperty(k);
    }
    expect(json).not.toMatch(/^@@ |^--- a\/|^\+\+\+ b\//m);
  });

  it('sends diff_fingerprint for an empty cp (manifest_hash non-null, hunks [])', async () => {
    await open('o2');
    const emptyManifest = {
      ...capturedManifest(0),
      status: 'empty' as const,
      hunk_count: 0,
      captured_hunk_count: 0,
      hunks: [],
    };
    await close('c2', {
      boundary: successBoundary('close'),
      summary: {
        ...capturedSummary(),
        status: 'empty' as const,
        hunk_count: 0,
        captured_hunk_count: 0,
      },
      manifest: emptyManifest,
    });
    const mocks = mountClient();

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    const payload = mocks.attachCheckpoint.mock.calls[0][0];
    expect(payload.diff_fingerprint_summary.status).toBe('empty');
    // empty is NOT skipped: a real manifest IS sent (hunks []), not omitted.
    expect(payload.diff_fingerprint).toBeDefined();
    expect(payload.diff_fingerprint.hunks).toEqual([]);
  });

  it('omits diff_fingerprint for a skipped cp (manifest_hash null)', async () => {
    await open('o3');
    await close('c3', {
      boundary: {
        snapshot_ref: null,
        tree_sha: null,
        snapshot_commit_sha: null,
        snapshot_error_reason: null,
      },
      summary: {
        status: 'skipped' as const,
        hunk_count: 0,
        captured_hunk_count: 0,
        truncated: false,
        fingerprint_algorithm: null,
        manifest_hash: null,
        manifest_hash_algorithm: null,
        error_reason: null,
      },
      manifest: null,
    });
    const mocks = mountClient();

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    const payload = mocks.attachCheckpoint.mock.calls[0][0];
    expect(payload.diff_fingerprint_summary.status).toBe('skipped');
    expect(payload).not.toHaveProperty('diff_fingerprint');
  });

  it('sends a v2 opened payload with open_snapshot', async () => {
    await open('o4');
    const mocks = mountClient();

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(mocks.attachCheckpointOpened).toHaveBeenCalledTimes(1);
    const payload = mocks.attachCheckpointOpened.mock.calls[0][0];
    expect(payload.schema_version).toBe(2);
    expect(payload.open_snapshot.tree_sha).toBe(TREE_O);
    expect(mocks.attachCheckpoint).not.toHaveBeenCalled();
  });

  it('abandoned cp is still skipped by sync (no attach call)', async () => {
    await open('o5');
    await store.writeCheckpointAbandoned(
      { artifact_id: PLAN.artifact_id, n: 1, reason: 'rescoped' },
      { idempotencyKey: 'a5' }
    );
    const mocks = mountClient();

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(mocks.attachCheckpoint).not.toHaveBeenCalled();
  });

  it('replayed push short-circuits unchanged with no attach calls', async () => {
    await open('o6');
    await close('c6', {
      boundary: successBoundary('close'),
      summary: capturedSummary(),
      manifest: capturedManifest(2),
    });
    const mocks = mountClient();
    const first = await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    expect(first.skipped).toBe(false);
    expect(mocks.attachCheckpoint).toHaveBeenCalledTimes(1);

    const second = await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('unchanged');
    expect(mocks.attachCheckpoint).toHaveBeenCalledTimes(1); // not called again
  });

  it('strict sync: corrupt close-event sidecar → artifact-level refusal, sync state unchanged', async () => {
    await open('o7');
    await close('c7', {
      boundary: successBoundary('close'),
      summary: capturedSummary(),
      manifest: capturedManifest(900), // large → spills to sidecar
    });
    // Corrupt the close event's sidecar so readEventLog drops the whole
    // event. Under the artifact-level contract the READ refuses before
    // the wire-side fingerprint check (which stays as defense in depth).
    const artDir = path.join(dir, '.orcaops', 'artifacts', PLAN.artifact_id);
    const sidecarsDir = path.join(artDir, 'sidecars');
    for (const f of fs.readdirSync(sidecarsDir)) {
      fs.writeFileSync(path.join(sidecarsDir, f), '{"tampered":true}\n');
    }
    mountClient();

    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toBeInstanceOf(RecoveryRefusedError);
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeNull();
  });

  it('cloud rejection on attachCheckpoint leaves cloud_sync_state unchanged', async () => {
    await open('o8');
    await close('c8', {
      boundary: successBoundary('close'),
      summary: capturedSummary(),
      manifest: capturedManifest(2),
    });
    const built = buildMockClient();
    built.mocks.attachCheckpoint.mockRejectedValue(
      Object.assign(new Error('cloud 400: schema'), { status: 400 })
    );
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: built.client as never,
      credentials: testCredentials(ORG_ID),
    });

    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toThrow();
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeNull();
  });

  it('wire-parse guard: a payload that violates a strict superRefine fails the push (no attach, no sync state)', async () => {
    await open('o9');
    await close('c9', {
      boundary: successBoundary('close'),
      summary: capturedSummary(),
      manifest: capturedManifest(1),
    });
    // Force a wire-invalid projection past readSnapshot: status 'captured'
    // but manifest_hash null violates the summary superRefine. manifest_hash
    // null also makes readSnapshot skip materialization (no throw), so the
    // failure surfaces at toWireCheckpoint's OssCheckpointPayload.parse.
    const real = await store.readCheckpointsRecovered(PLAN.artifact_id);
    const bad = real.map((c) =>
      c.status === 'closed'
        ? { ...c, diff_fingerprint_summary: { ...c.diff_fingerprint_summary, manifest_hash: null } }
        : c
    );
    vi.spyOn(store, 'readCheckpointsRecovered').mockResolvedValue(bad as never);
    const mocks = mountClient();

    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toThrow();
    // Strict-sync invariant: no checkpoint attached, no synced-state written.
    // (NOT asserting "no network" — repo.upsert/start/attachPlan precede the
    // checkpoint loop and are idempotent on retry.)
    expect(mocks.attachCheckpoint).not.toHaveBeenCalled();
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeNull();
  });

  it('a recovered manifest whose open_tree_sha ≠ the checkpoint open snapshot flows through the OSS wire unchanged', async () => {
    // Empty-fence recovery emits a `diff_fingerprint` manifest whose
    // `open_tree_sha` is the HWM baseline — DELIBERATELY ≠ the checkpoint's real
    // `open_snapshot.tree_sha`. The close tree stays real. The OSS
    // wire path makes NO manifest↔checkpoint open-tree equality assertion (that
    // assertion is cloud-side only). This test documents+pins that: the divergent
    // manifest must NOT throw on the OSS wire and must carry open_tree_sha through
    // verbatim.
    // tree_sha must be lowercase hex (storage CheckpointSnapshotBoundarySchema
    // enforces /^[0-9a-f]{40,64}$/), so we use distinct lowercase fills rather
    // than 'A'/'B'. CHECKPOINT_OPEN reuses the suite's TREE_O ('a'*40); the
    // recovered baseline open is a distinct fill ('d'*40).
    const CHECKPOINT_OPEN = TREE_O; // = 'a'*40 — the cp's REAL open snapshot tree
    const RECOVERED_OPEN = 'd'.repeat(40); // the manifest's HWM-baseline open tree

    // The cp's open_snapshot tree = TREE_O (successBoundary('open')'s default).
    await open('orec');

    // Recovered manifest: open_tree_sha = the baseline ('d'*40, ≠ the checkpoint
    // open 'a'*40); close_tree_sha = TREE_C = the checkpoint's real close tree.
    const recoveredManifest = { ...capturedManifest(3), open_tree_sha: RECOVERED_OPEN };
    await close('crec', {
      boundary: successBoundary('close'), // close_snapshot.tree_sha === TREE_C
      summary: capturedSummary(),
      manifest: recoveredManifest,
    });
    const mocks = mountClient();

    // Must NOT throw — the OSS wire mapping (toWireCheckpoint →
    // OssCheckpointPayload.parse) makes no manifest↔checkpoint open-tree check.
    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).resolves.toMatchObject({ skipped: false });

    expect(mocks.attachCheckpoint).toHaveBeenCalledTimes(1);
    const payload = mocks.attachCheckpoint.mock.calls[0][0];
    // The checkpoint's real open snapshot is 'a'*40...
    expect(payload.open_snapshot.tree_sha).toBe(CHECKPOINT_OPEN);
    // ...the close snapshot is the real close tree...
    expect(payload.close_snapshot.tree_sha).toBe(TREE_C);
    // ...and the manifest (an optional inner field) carries the DIVERGENT
    // recovered open_tree_sha 'd'*40 through unchanged — proving the OSS wire
    // makes no equality assertion against the checkpoint open snapshot.
    expect(payload.diff_fingerprint).toBeDefined();
    expect(payload.diff_fingerprint.open_tree_sha).toBe(RECOVERED_OPEN);
    expect(payload.diff_fingerprint.open_tree_sha).not.toBe(payload.open_snapshot.tree_sha);
    // The manifest's close tree still matches the checkpoint close (recovery
    // preserves the real close — the cloud-side close_tree_sha guard is kept).
    expect(payload.diff_fingerprint.close_tree_sha).toBe(payload.close_snapshot.tree_sha);
  });
});

describe('pushArtifact — centralized auto-prune gate', () => {
  let dir: string;
  let store: ArtifactStore;
  const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
  const PRUNABLE = [`refs/orcaops/snap/${PLAN.artifact_id}/1/close`];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-sync-prune-'));
    const credsHome = path.join(dir, 'creds');
    store = new ArtifactStore({ repoRoot: dir, config: getDefaultConfig() });
    fs.mkdirSync(credsHome, { recursive: true });
    fs.writeFileSync(
      path.join(credsHome, 'credentials.json'),
      JSON.stringify({ baseUrl: 'http://localhost:3001', orgId: ORG_ID, userId: USER_ID }),
      { mode: 0o600 }
    );
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: PLAN.artifact_id,
      branch: PLAN.branch,
      task: PLAN.task,
      agent: PLAN.agent,
      base_sha: PLAN.base_sha,
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
    });
    await store.writePlan(PLAN);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const boundary = (phase: string) => ({
    snapshot_ref: `refs/orcaops/snap/${PLAN.artifact_id}/1/${phase}`,
    tree_sha: (phase === 'open' ? 'a' : 'b').repeat(40),
    snapshot_commit_sha: 'c'.repeat(40),
    snapshot_error_reason: null,
  });
  const capturedSummary = () => ({
    status: 'captured' as const,
    hunk_count: 1,
    captured_hunk_count: 1,
    truncated: false,
    fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2' as const,
    manifest_hash: 'a'.repeat(43),
    manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1' as const,
    error_reason: null,
  });
  const capturedManifest = (lineHashes: number) => ({
    schema_version: 1 as const,
    artifact_id: PLAN.artifact_id,
    checkpoint_n: 1,
    open_tree_sha: 'a'.repeat(40),
    close_tree_sha: 'b'.repeat(40),
    status: 'captured' as const,
    hunk_count: 1,
    captured_hunk_count: 1,
    truncated: false,
    error_reason: null,
    normalization_version: 'orcaops-line-normalization-v1' as const,
    diff_algorithm: 'git-diff-unified-v1' as const,
    diff_options: { unified: 3 as const, find_renames: true, no_ext_diff: true },
    limits: { max_diff_bytes: 2_000_000 },
    hash_encoding: 'base64url-nopad' as const,
    line_hash_algorithm: 'blake3-xof-96-base64url-nopad-v2' as const,
    patch_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1' as const,
    hunk_header_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1' as const,
    manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1' as const,
    hunks: [
      {
        hunk_index: 0,
        file_before: null,
        file_after: 'f.ts',
        change_type: 'add' as const,
        binary: false,
        old_start: null,
        old_lines: null,
        new_start: 1,
        new_lines: lineHashes,
        patch_hash: 'ph0',
        added_line_hashes: Array.from({ length: lineHashes }, (_u, j) => `lh-${j}-padpadpad`),
        deleted_line_hashes: [],
        hunk_header_hash: null,
        added_line_count: lineHashes,
        deleted_line_count: 0,
      },
    ],
  });

  async function seedCapturedClosedCp(manifestLineHashes = 3): Promise<void> {
    await store.writeCheckpointOpened(
      { artifact_id: PLAN.artifact_id, declared_step_ids: [STEP_ID] },
      {
        idempotencyKey: `o-${PLAN.artifact_id}`,
        headSha: 'cafef00d',
        snapshotCallbacks: { captureOpenSnapshot: async () => ({ boundary: boundary('open') }) },
      }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: PLAN.artifact_id,
        n: 1,
        summary: 'closed',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [STEP_ID],
        head_sha: 'cafef00d',
      },
      {
        idempotencyKey: `c-${PLAN.artifact_id}`,
        snapshotCallbacks: {
          captureCloseFingerprint: async () =>
            ({
              boundary: boundary('close'),
              summary: capturedSummary(),
              manifest: capturedManifest(manifestLineHashes),
            }) as never,
        },
      }
    );
  }

  async function seedSummary(): Promise<void> {
    await store.writeSummary({
      schema_version: 1,
      artifact_id: PLAN.artifact_id,
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'cafef00d',
      ts: '2026-05-16T00:00:00.000Z',
    });
  }

  function spyPrune() {
    const collect = vi
      .spyOn(snapshotsModule, 'collectPrunableRefsForArtifact')
      .mockResolvedValue(PRUNABLE);
    const prune = vi
      .spyOn(snapshotsModule, 'pruneSnapshotRefs')
      .mockResolvedValue({ deleted: PRUNABLE.length, refs: PRUNABLE });
    // maybePruneSnapshots ALSO collects + prunes the plan-time baseline ref.
    // These tests assert the SNAPSHOT-ref wiring, so stub the baseline pair to
    // a no-op (empty collect) — otherwise the real `collectBaselineRefsForArtifact`
    // would `spawn git` against the non-git mockRepo cwd (ENOENT).
    const collectBaseline = vi
      .spyOn(snapshotsModule, 'collectBaselineRefsForArtifact')
      .mockResolvedValue([]);
    const pruneBaseline = vi
      .spyOn(snapshotsModule, 'pruneBaselineRefs')
      .mockResolvedValue({ deleted: 0, refs: [] });
    return { collect, prune, collectBaseline, pruneBaseline };
  }

  function mountClient(overrides: Record<string, unknown> = {}) {
    const built = buildMockClient();
    Object.assign(built.client.captureThread, overrides);
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: built.client as never,
      credentials: testCredentials(ORG_ID),
    });
    return built.mocks;
  }

  it('prunes the selective set after a successful push (summary present)', async () => {
    await seedCapturedClosedCp();
    await seedSummary();
    const { collect, prune } = spyPrune();
    mountClient();

    const r = await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(r.skipped).toBe(false);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledTimes(1);
    // Selective wiring: pruneSnapshotRefs receives EXACTLY what
    // collectPrunableRefsForArtifact returned (not a blind total list).
    expect(prune).toHaveBeenCalledWith(expect.anything(), PRUNABLE);
  });

  it('still prunes on the unchanged short-circuit (a prior push landed it)', async () => {
    await seedCapturedClosedCp();
    await seedSummary();
    const { prune } = spyPrune();
    mountClient();

    await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    prune.mockClear();

    const second = await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('unchanged');
    expect(prune).toHaveBeenCalledTimes(1); // skip path reaches the tail
  });

  it('does NOT prune when the artifact has no summary (in-flight)', async () => {
    await seedCapturedClosedCp(); // closed cp, but no summary written
    const { collect, prune } = spyPrune();
    mountClient();

    const r = await pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });

    expect(r.skipped).toBe(false);
    expect(collect).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it('does NOT prune when the push throws (cloud rejection); refs stay pinned', async () => {
    await seedCapturedClosedCp();
    await seedSummary();
    const { prune } = spyPrune();
    mountClient({ start: vi.fn().mockRejectedValue(new Error('cloud 500')) });

    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toThrow(/cloud 500/);
    expect(prune).not.toHaveBeenCalled();
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeNull();
  });

  it('does NOT prune on a corrupt-sidecar refusal (refs are recovery material)', async () => {
    await seedCapturedClosedCp(900); // large manifest → spills to sidecar
    await seedSummary();
    const sidecarsDir = path.join(dir, '.orcaops', 'artifacts', PLAN.artifact_id, 'sidecars');
    for (const f of fs.readdirSync(sidecarsDir)) {
      fs.writeFileSync(path.join(sidecarsDir, f), '{"tampered":true}\n');
    }
    const { prune } = spyPrune();
    mountClient();

    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toBeInstanceOf(RecoveryRefusedError);
    expect(prune).not.toHaveBeenCalled();
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeNull();
  });

  it('does NOT prune when offline (NotConnectedError) or no git remote', async () => {
    await seedCapturedClosedCp();
    await seedSummary();
    const { prune } = spyPrune();

    // No credentials → NotConnectedError before the tail. Mock the
    // createCloudClient throw directly (the OAuth FileStore reads only
    // ORCAOPS_CONFIG_HOME / XDG_CONFIG_HOME).
    const createCloudClientSpy = vi
      .spyOn(clientModule, 'createCloudClient')
      .mockRejectedValueOnce(new NotConnectedError('Not connected. Run `orcaops login` first.'));
    fs.unlinkSync(path.join(dir, 'creds', 'credentials.json'));
    await expect(
      pushArtifact({
        store,
        repo: mockRepo('git@github.com:foo/bar.git'),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toBeInstanceOf(NotConnectedError);
    createCloudClientSpy.mockRestore();

    // Restore creds; missing git remote → MissingGitRemoteError before the tail.
    fs.writeFileSync(
      path.join(dir, 'creds', 'credentials.json'),
      JSON.stringify({ baseUrl: 'http://localhost:3001', orgId: ORG_ID, userId: USER_ID }),
      { mode: 0o600 }
    );
    mountClient();
    await expect(
      pushArtifact({
        store,
        repo: mockRepo(null),
        artifactId: PLAN.artifact_id,
        baseUrl: TEST_BASE_URL,
        credentialStore: testCredentialStore(),
      })
    ).rejects.toBeInstanceOf(MissingGitRemoteError);

    expect(prune).not.toHaveBeenCalled();
  });
});

describe('pushArtifact — V4 done_criteria.text + plan_revision_id', () => {
  let dir: string;
  let store: ArtifactStore;
  const ART = '01HXV4ART000000000000000A1';
  const STEP = '01HXV4STEP00000000000000A1';
  const CRIT = '01HXV4CRIT00000000000000A1';

  const SKIP_BOUNDARY = {
    snapshot_ref: null,
    tree_sha: null,
    snapshot_commit_sha: null,
    snapshot_error_reason: null,
  };
  const SKIPPED_FP = {
    boundary: SKIP_BOUNDARY,
    summary: {
      status: 'skipped' as const,
      hunk_count: 0,
      captured_hunk_count: 0,
      truncated: false,
      fingerprint_algorithm: null,
      manifest_hash: null,
      manifest_hash_algorithm: null,
      error_reason: null,
    },
    manifest: null,
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-sync-v4-'));
    const credsHome = path.join(dir, 'creds');
    store = new ArtifactStore({ repoRoot: dir, config: getDefaultConfig() });
    fs.mkdirSync(credsHome, { recursive: true });
    fs.writeFileSync(
      path.join(credsHome, 'credentials.json'),
      JSON.stringify({ baseUrl: 'http://localhost:3001', orgId: ORG_ID, userId: USER_ID }),
      { mode: 0o600 }
    );
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function mountClient(): ReturnType<typeof buildMockClient>['mocks'] {
    const built = buildMockClient();
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: built.client as never,
      credentials: testCredentials(ORG_ID),
    });
    return built.mocks;
  }

  function pushOpts() {
    return {
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: ART,
      resolveHost: identityResolveHost,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    };
  }

  async function seedPlan(critText: string): Promise<void> {
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: ART,
      branch: 'main',
      task: 'demo',
      agent: 'claude-code',
      base_sha: 'sha-base',
      started_at: '2026-04-28T01:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: ART,
        branch: 'main',
        base_sha: 'sha-base',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'demo',
        label: 'lbl',
        plan_steps: [
          {
            step_id: STEP,
            label: 'step 1',
            text: 'step 1',
            acceptance_criteria: [{ criterion_id: CRIT, text: critText }],
          },
        ],
        touched_scope: [],
        non_goals: [],
        started_at: '2026-04-28T01:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
        decisions: [],
      },
      { idempotencyKey: 'plan-0' }
    );
  }

  async function openCp(): Promise<void> {
    await store.writeCheckpointOpened(
      { artifact_id: ART, declared_step_ids: [STEP] },
      {
        idempotencyKey: 'cp-open',
        headSha: 'cafef00d',
        snapshotCallbacks: { captureOpenSnapshot: async () => ({ boundary: SKIP_BOUNDARY }) },
      }
    );
  }

  async function closeCp(
    doneCriteria: Array<{ criterion_id: string; evidence: string }>
  ): Promise<void> {
    await store.writeCheckpointClosed(
      {
        artifact_id: ART,
        n: 1,
        summary: 'closed',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: doneCriteria,
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [STEP],
        head_sha: 'cafef00d',
      },
      {
        idempotencyKey: 'cp-close',
        snapshotCallbacks: { captureCloseFingerprint: async () => SKIPPED_FP as never },
      }
    );
  }

  async function reviseCriteria(
    next: Array<{ criterion_id: string; text: string }>,
    acknowledgeCriteriaChanges: string[] = []
  ): Promise<void> {
    const res = await store.revisePlan(
      {
        idempotency_key: 'plan-1',
        artifact_id: ART,
        label: 'lbl-rev1',
        plan_steps: [{ step_id: STEP, text: 'step 1', label: 'step 1', acceptance_criteria: next }],
        touched_scope: [],
        non_goals: [],
        rationale: 'narrow the rubric',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: acknowledgeCriteriaChanges,
        decisions: [],
      },
      { idempotencyKey: 'plan-1' }
    );
    if (res.outcome === 'conflict') throw new Error('unexpected revise conflict in test');
  }

  it('rejects rewriting a criterion after its step is completed', async () => {
    await seedPlan('rev0 rubric text');
    await openCp();
    await closeCp([{ criterion_id: CRIT, evidence: 'did the thing' }]);
    await expect(
      reviseCriteria([{ criterion_id: CRIT, text: 'rev1 weaker rubric' }])
    ).rejects.toThrow(/Cannot revise protected step meaning/);
  });

  it('emits done_criteria.text from the OPEN-time revision after the criterion is REMOVED', async () => {
    await seedPlan('rev0 rubric text');
    await openCp();
    await closeCp([{ criterion_id: CRIT, evidence: 'did the thing' }]);
    await reviseCriteria([], [CRIT]);
    const mocks = mountClient();

    await pushArtifact(pushOpts());

    const payload = mocks.attachCheckpoint.mock.calls[0]![0];
    expect(payload.done_criteria).toEqual([
      { criterion_id: CRIT, evidence: 'did the thing', text: 'rev0 rubric text' },
    ]);
  });

  it('CLOSE payload plan_revision_id is the server-derived open-time event id', async () => {
    await seedPlan('rubric');
    const rev0 = await store.readPlan(ART);
    await openCp();
    await closeCp([{ criterion_id: CRIT, evidence: 'done' }]);
    const mocks = mountClient();

    await pushArtifact(pushOpts());

    const payload = mocks.attachCheckpoint.mock.calls[0]![0];
    expect(payload.plan_revision_id).toBe(rev0?.source_event_id);
    expect(payload.plan_revision_id).not.toBeNull();
  });

  it('OPEN payload plan_revision_id is the server-derived open-time event id', async () => {
    await seedPlan('rubric');
    const rev0 = await store.readPlan(ART);
    await openCp(); // leave it open → only attachCheckpointOpened fires
    const mocks = mountClient();

    await pushArtifact(pushOpts());

    expect(mocks.attachCheckpointOpened).toHaveBeenCalledTimes(1);
    expect(mocks.attachCheckpoint).not.toHaveBeenCalled();
    const payload = mocks.attachCheckpointOpened.mock.calls[0]![0];
    expect(payload.plan_revision_id).toBe(rev0?.source_event_id);
    expect(payload.plan_revision_id).not.toBeNull();
  });

  describe('fail-fast when open-time text is unresolvable (no degraded write)', () => {
    it('open revision not in the projection → throws, no attach, sync state untouched', async () => {
      await seedPlan('rubric');
      await openCp();
      await closeCp([{ criterion_id: CRIT, evidence: 'done' }]);
      const real = await store.readCheckpointsRecovered(ART);
      const bad = real.map((c) =>
        c.status === 'closed' ? { ...c, open_plan_revision_event_id: 'no-such-event-id' } : c
      );
      vi.spyOn(store, 'readCheckpointsRecovered').mockResolvedValue(bad as never);
      const mocks = mountClient();

      const thrown = await pushArtifact(pushOpts()).then(
        () => null,
        (err: unknown) => err
      );
      expect(thrown).toBeInstanceOf(DoneCriterionTextUnresolvableError);
      expect((thrown as DoneCriterionTextUnresolvableError).kind).toBe(
        'open-revision-not-in-cache'
      );
      expect(mocks.attachCheckpoint).not.toHaveBeenCalled();
      expect(store.store.getCloudSyncState(ART)).toBeNull();
    });

    it('an EMPTY-rubric close cannot bypass resolution — unresolvable revision still throws', async () => {
      await seedPlan('rubric');
      await openCp();
      await closeCp([{ criterion_id: CRIT, evidence: 'done' }]);
      const real = await store.readCheckpointsRecovered(ART);
      const bad = real.map((c) =>
        c.status === 'closed'
          ? { ...c, done_criteria: [], open_plan_revision_event_id: 'no-such-event-id' }
          : c
      );
      vi.spyOn(store, 'readCheckpointsRecovered').mockResolvedValue(bad as never);
      const mocks = mountClient();

      const thrown = await pushArtifact(pushOpts()).then(
        () => null,
        (err: unknown) => err
      );
      expect(thrown).toBeInstanceOf(DoneCriterionTextUnresolvableError);
      expect(mocks.attachCheckpoint).not.toHaveBeenCalled();
    });

    it('criterion absent from the open revision → throws', async () => {
      await seedPlan('rubric');
      await openCp();
      await closeCp([{ criterion_id: CRIT, evidence: 'done' }]);
      const real = await store.readCheckpointsRecovered(ART);
      const bad = real.map((c) =>
        c.status === 'closed'
          ? { ...c, done_criteria: [{ criterion_id: 'never-existed', evidence: 'x' }] }
          : c
      );
      vi.spyOn(store, 'readCheckpointsRecovered').mockResolvedValue(bad as never);
      mountClient();

      await expect(pushArtifact(pushOpts())).rejects.toBeInstanceOf(
        DoneCriterionTextUnresolvableError
      );
      expect(store.store.getCloudSyncState(ART)).toBeNull();
    });
  });
});

describe('pushArtifact — source plan', () => {
  let dir: string;
  let store: ArtifactStore;
  const BASE_URL = 'http://localhost:3001';
  const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-sync-sp-'));
    store = new ArtifactStore({ repoRoot: dir, config: getDefaultConfig() });
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function cloudPin(
    over: { version?: string; org_id?: string; base_url?: string } = {}
  ): SourcePlanPin {
    const content = 'CLOUD BODY';
    return {
      source_ref: {
        kind: 'cloud',
        locator: 'ext-1',
        version: over.version ?? '3',
        base_url: over.base_url ?? BASE_URL,
        org_id: over.org_id ?? ORG_ID,
      },
      content,
      hash: sha(content),
      baseline: null,
    };
  }
  // Populated baseline: the Branch-B e2e below proves the storage→wire path
  // (real writePlan → projection → readSnapshot → buildBranchBPin) carries it.
  const LOCAL_BASELINE = {
    repo_url: 'https://github.com/acme/widgets',
    branch: 'feature/pin-baseline',
    head_sha: 'c'.repeat(40),
  };
  function localPin(): SourcePlanPin {
    const content = 'LOCAL BODY';
    return {
      source_ref: { kind: 'local', locator: 'docs/p.md' },
      content,
      hash: sha(content),
      baseline: LOCAL_BASELINE,
    };
  }

  async function seedPinned(id: string, sourcePlan: SourcePlanPin): Promise<void> {
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id,
      branch: PLAN.branch,
      task: PLAN.task,
      agent: PLAN.agent,
      base_sha: PLAN.base_sha,
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
    });
    // Pass an idempotencyKey: writePlan's default-mint only fires when `opts`
    // is omitted entirely, so an opts object without a key would write a
    // keyless (and thus on-read-corrupt) event. The real caller (capture/plan.ts)
    // always supplies one.
    await store.writePlan(
      { ...PLAN, artifact_id: id },
      { idempotencyKey: `seed-${id}`, sourcePlan }
    );
  }

  async function revisePinnedLabel(
    id: string,
    label: string,
    idempotencyKey: string
  ): Promise<void> {
    await store.revisePlan(
      {
        idempotency_key: idempotencyKey,
        artifact_id: id,
        label,
        plan_steps: PLAN.plan_steps,
        touched_scope: [],
        non_goals: [],
        decisions: [],
        rationale: 'clarify the current thread label',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey }
    );
  }

  const PING_HANDSHAKE = {
    server_version: '1.4.0',
    protocol_version: '0.0.21',
    min_cli_version: '0.0.0',
    min_protocol_version: '0.0.0',
    capabilities: ['source-plan-owner-ref/v1'],
  };

  function mockClient(
    over: {
      ping?: ReturnType<typeof vi.fn>;
      get?: ReturnType<typeof vi.fn>;
      attachPin?: ReturnType<typeof vi.fn>;
    } = {}
  ) {
    const base = buildMockClient();
    // A pinned push requires the ownership capability, so the default ping
    // advertises it — these tests are about pin semantics, not negotiation. The
    // refusal cases override `ping` to withhold it.
    const ping =
      over.ping ??
      vi.fn().mockResolvedValue({
        ok: true,
        orgId: ORG_ID,
        userId: USER_ID,
        handshake: PING_HANDSHAKE,
      });
    const get =
      over.get ??
      vi
        .fn()
        .mockRejectedValue(new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 }));
    const attachPin = over.attachPin ?? vi.fn().mockResolvedValue({ id: 'pin-row' });
    const client = { ...base.client, cli: { ping }, sourcePlan: { get, attachPin } };
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: client as never,
      credentials: testCredentials(ORG_ID, BASE_URL),
    });
    return { ...base.mocks, ping, get, attachPin };
  }

  function push(id: string, opts: { force?: boolean } = {}) {
    return pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: id,
      baseUrl: BASE_URL,
      repoRoot: dir,
      resolveHost: identityResolveHost,
      credentialStore: testCredentialStore(),
      cliVersion: '0.0.5',
      ...(opts.force ? { force: true } : {}),
    });
  }

  const approved = (n: number | null, status = 'APPROVED') => ({
    externalId: 'ext-1',
    slug: 's',
    title: 't',
    status,
    approvedVersionNumber: n,
  });

  it('Branch-A preflight aborts a STALE cloud pin BEFORE captureThread.start (zero thread writes)', async () => {
    await seedPinned('a-stale', cloudPin({ version: '3' }));
    const m = mockClient({ get: vi.fn().mockResolvedValue(approved(5)) });
    await expect(push('a-stale')).rejects.toMatchObject({ reason: 'stale' });
    expect(m.start).not.toHaveBeenCalled();
    expect(m.attachPlan).not.toHaveBeenCalled();
    expect(m.attachPin).not.toHaveBeenCalled();
  });

  it('Branch-A preflight aborts a WRONG-ORG pin before start (and before get)', async () => {
    await seedPinned('a-wrongorg', cloudPin({ org_id: 'org-other' }));
    const m = mockClient();
    await expect(push('a-wrongorg')).rejects.toMatchObject({ reason: 'wrong-origin' });
    expect(m.start).not.toHaveBeenCalled();
    expect(m.get).not.toHaveBeenCalled();
  });

  it('Branch-A preflight aborts a NOT-FOUND pin before start', async () => {
    await seedPinned('a-missing', cloudPin());
    const m = mockClient({
      get: vi
        .fn()
        .mockRejectedValue(new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 })),
    });
    await expect(push('a-missing')).rejects.toMatchObject({ reason: 'not-found' });
    expect(m.start).not.toHaveBeenCalled();
  });

  it('a PINNED-status re-push does NOT staleness-fail and attaches Branch A', async () => {
    await seedPinned('a-pinned', cloudPin({ version: '3' }));
    // A genuine RE-push: the first establishes this artifact's thread so the
    // plan's owner can legitimately be it. Previously this ran as a first push
    // and only passed because an owner-less PINNED plan was tolerated — which is
    // the tolerance this branch removes. Ownership now has to be real for the
    // staleness rule under test to be reachable.
    const m = mockClient({ get: vi.fn().mockResolvedValue(approved(3)) });
    await push('a-pinned');
    m.get.mockResolvedValue({
      ...approved(99, 'PINNED'),
      captureThread: { externalId: 'a-pinned', label: 'owning thread', taskNumber: null },
    });
    const result = await push('a-pinned', { force: true });
    expect(result.source_plan_pinned).toBe('A');
    expect(m.start).toHaveBeenCalledTimes(2);
    expect(m.attachPin).toHaveBeenCalledTimes(2);
    // Branch A always ships baseline null — the authoring baseline lives
    // cloud-side from the upload.
    expect(m.attachPin.mock.calls[0][0]).toMatchObject({ baseline: null });
  });

  it('first push attaches the pin & the hash covers it; the unchanged re-push skips without re-attaching', async () => {
    await seedPinned('a-detect', cloudPin({ version: '3' }));
    const m = mockClient({ get: vi.fn().mockResolvedValue(approved(3)) });
    const first = await push('a-detect');
    expect(first.skipped).toBe(false);
    expect(first.source_plan_pinned).toBe('A');
    expect(m.attachPin).toHaveBeenCalledTimes(1);

    const second = await push('a-detect');
    expect(second.skipped).toBe(true);
    expect(second.source_plan_pinned).toBe('skipped');
    expect(m.attachPin).toHaveBeenCalledTimes(1); // NOT re-attached
  });

  it('a failed attach leaves the cloud_sync hash unstored → the next push retries', async () => {
    await seedPinned('a-retry', cloudPin({ version: '3' }));
    const attachPin = vi
      .fn()
      .mockRejectedValueOnce(new Error('attach boom'))
      .mockResolvedValue({ id: 'pin-row' });
    const m = mockClient({ get: vi.fn().mockResolvedValue(approved(3)), attachPin });
    await expect(push('a-retry')).rejects.toThrow('attach boom');
    expect(store.store.getCloudSyncState('a-retry')).toBeNull(); // hash unstored → retryable
    const retry = await push('a-retry');
    expect(retry.skipped).toBe(false);
    expect(retry.source_plan_pinned).toBe('A');
    expect(m.attachPin).toHaveBeenCalledTimes(2);
  });

  it('Branch-B resolves and attaches version 1 under the deterministic born id', async () => {
    await seedPinned('b-born', localPin());
    const m = mockClient();
    const result = await push('b-born');
    expect(result.source_plan_pinned).toBe('B');
    expect(m.get).toHaveBeenCalledWith({ slugOrExternalId: bornPinExternalId('b-born') });
    expect(m.attachPin).toHaveBeenCalledTimes(1);
    expect(m.attachPin.mock.calls[0][0]).toMatchObject({
      external_id: bornPinExternalId('b-born'),
      version_number: 1,
      // seedPinned went through the REAL writePlan → projection →
      // readSnapshot path, so this is the full storage-to-wire e2e for the
      // frozen authoring baseline.
      baseline: LOCAL_BASELINE,
    });
  });

  it('Branch-B preserves the title accepted by a first push after revision', async () => {
    await seedPinned('b-born-revised', localPin());
    await revisePinnedLabel('b-born-revised', 'first pushed label', 'born-label-rev-1');
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 })
      )
      .mockResolvedValue({
        externalId: bornPinExternalId('b-born-revised'),
        slug: 'first-pushed-label',
        title: 'first pushed label',
        status: 'PINNED',
        approvedVersionNumber: null,
        webUrl: 'https://cloud.example/plans/first-pushed-label',
        captureThread: {
          externalId: 'b-born-revised',
          label: 'first pushed label',
          taskNumber: null,
        },
      });
    const m = mockClient({ get });

    await push('b-born-revised');
    await revisePinnedLabel('b-born-revised', 'later thread label', 'born-label-rev-2');
    await push('b-born-revised');

    expect(m.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: 'later thread label' })
    );
    expect(m.attachPin.mock.calls.map(([payload]) => payload.title)).toEqual([
      'first pushed label',
      'first pushed label',
    ]);
  });

  it('an unchanged Branch-B push does not look up or reattach its born pin', async () => {
    await seedPinned('b-born-unchanged', localPin());
    const m = mockClient();
    await push('b-born-unchanged');
    m.get.mockClear();
    m.attachPin.mockClear();

    const result = await push('b-born-unchanged');

    expect(result).toMatchObject({ skipped: true, reason: 'unchanged' });
    expect(m.get).not.toHaveBeenCalled();
    expect(m.attachPin).not.toHaveBeenCalled();
  });

  it('Branch-A keeps its cloud-locator preflight and latest thread label', async () => {
    await seedPinned('a-revised-label', cloudPin({ version: '3' }));
    await revisePinnedLabel('a-revised-label', 'latest thread label', 'cloud-label-rev-1');
    const m = mockClient({ get: vi.fn().mockResolvedValue(approved(3)) });

    await push('a-revised-label');

    expect(m.get).toHaveBeenCalledWith({ slugOrExternalId: 'ext-1' });
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ label: 'latest thread label' }));
    expect(m.attachPin).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: 'ext-1', title: 'latest thread label' })
    );
  });

  describe('a pinned push requires the ownership capability', () => {
    const pingAdvertising = (capabilities: string[]) =>
      vi.fn().mockResolvedValue({
        ok: true,
        orgId: ORG_ID,
        userId: USER_ID,
        handshake: { ...PING_HANDSHAKE, capabilities },
      });

    it('publishes NO thread when the cloud does not advertise it', async () => {
      await seedPinned('a-nocap', cloudPin({ version: '3' }));
      const m = mockClient({
        ping: pingAdvertising([]),
        get: vi.fn().mockResolvedValue(approved(3)),
      });
      await expect(push('a-nocap')).rejects.toThrow(/source-plan-owner-ref/);
      // The whole point: the refusal lands before anything is published, and
      // before the preflight read that would otherwise diagnose ownership.
      expect(m.start).not.toHaveBeenCalled();
      expect(m.get).not.toHaveBeenCalled();
      expect(m.attachPin).not.toHaveBeenCalled();
    });

    it('ignores capabilities it does not recognize alongside the one it needs', async () => {
      await seedPinned('a-unknowncap', cloudPin({ version: '3' }));
      const m = mockClient({
        ping: pingAdvertising(['source-plan-owner-ref/v1', 'invented-later/v3']),
        get: vi.fn().mockResolvedValue(approved(3)),
      });
      await push('a-unknowncap');
      expect(m.start).toHaveBeenCalledTimes(1);
    });

    it('requires the handshake but not the ownership capability for a born-pin', async () => {
      await seedPinned('b-born', localPin());
      const m = mockClient({
        ping: pingAdvertising([]),
      });
      const result = await push('b-born');
      expect(result.source_plan_pinned).toBe('B');
      expect(m.start).toHaveBeenCalledTimes(1);
    });

    it('reaches the wire when the capability IS advertised', async () => {
      // The control for the refusals above: same fixture and client shape,
      // capability present — the push proceeds and publishes. Without this the
      // two "not called" assertions would also hold for a wholly broken push.
      await seedPinned('a-hascap', cloudPin({ version: '3' }));
      const m = mockClient({ get: vi.fn().mockResolvedValue(approved(3)) });
      await push('a-hascap');
      expect(m.start).toHaveBeenCalledTimes(1);
      expect(m.attachPin).toHaveBeenCalledTimes(1);
    });
  });

  it('a pinless push adds no ping and no attach (fast path unchanged)', async () => {
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'no-pin',
      branch: PLAN.branch,
      task: PLAN.task,
      agent: PLAN.agent,
      base_sha: PLAN.base_sha,
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
    });
    await store.writePlan({ ...PLAN, artifact_id: 'no-pin' });
    const m = mockClient();
    const result = await push('no-pin');
    expect(result.source_plan_pinned).toBeNull();
    expect(m.ping).not.toHaveBeenCalled();
    expect(m.attachPin).not.toHaveBeenCalled();
  });
});

describe('toWireUsage', () => {
  const ISO = '2026-01-01T00:00:00.000Z';
  const snapshot = (over: Record<string, unknown> = {}) =>
    ({
      snapshot_id: 'snap-1',
      idempotency_key: 'idem-1',
      session_id: 'sess-1',
      agent: 'claude-code',
      artifact_id: 'a1',
      source_plan_ref_id: null,
      lifecycle_event: 'checkpoint_close',
      checkpoint_n: 2,
      cumulative_input_tokens: 10,
      cumulative_output_tokens: 5,
      cumulative_cache_creation_input_tokens: 1,
      cumulative_cache_read_input_tokens: 20,
      delta_input_tokens: 4,
      delta_output_tokens: 2,
      delta_cache_creation_input_tokens: 0,
      delta_cache_read_input_tokens: 8,
      baseline_kind: 'checkpoint_open',
      model_breakdown: JSON.stringify([
        {
          model: 'm',
          cumulative: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 20,
          },
          delta: {
            input_tokens: 4,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 8,
          },
        },
      ]),
      record_count: 3,
      as_of: ISO,
      ts: ISO,
      ...over,
    }) as unknown as ArtifactUsageData['snapshots'][number];
  const mk = (over: Partial<ArtifactUsageData> = {}): ArtifactUsageData => ({
    sessions: [],
    snapshots: [snapshot()],
    modelBreakdowns: [],
    source_plan_links: [],
    anchor: 'x',
    ...over,
  });
  const session = (over: Record<string, unknown> = {}) =>
    ({
      agent: 'claude-code',
      session_id: 'sess-1',
      cumulative_input_tokens: 10,
      cumulative_output_tokens: 5,
      cumulative_cache_creation_input_tokens: 1,
      cumulative_cache_read_input_tokens: 20,
      as_of: ISO,
      record_count: 3,
      ...over,
    }) as unknown as ArtifactUsageData['sessions'][number];
  const modelBreakdown = (json: string) =>
    ({
      agent: 'claude-code',
      session_id: 'sess-1',
      model_breakdown: json,
    }) as unknown as ArtifactUsageData['modelBreakdowns'][number];

  it('renames native token names to wire names and drops every delta (cumulative-only)', () => {
    const wire = toWireUsage(mk(), 'a1');
    expect(wire.schema_version).toBe(1);
    expect(wire.artifact_id).toBe('a1');
    expect(wire.snapshots[0].cumulative).toEqual({
      in: 10,
      out: 5,
      cache_read: 20,
      cache_write: 1,
    });
    expect(Object.keys(wire.snapshots[0]).some((k) => k.includes('delta'))).toBe(false);
    expect(wire.snapshots[0].model_breakdown[0]).toEqual({
      model: 'm',
      cumulative: { in: 10, out: 5, cache_read: 20, cache_write: 1 },
    });
    expect(wire.snapshots[0].model_breakdown[0]).not.toHaveProperty('delta');
  });

  it('treats malformed stored model_breakdown JSON as empty', () => {
    const wire = toWireUsage(
      mk({
        sessions: [session()],
        snapshots: [snapshot({ model_breakdown: '{' })],
        modelBreakdowns: [modelBreakdown('{')],
      }),
      'a1'
    );

    expect(wire.sessions[0].model_breakdown).toEqual([]);
    expect(wire.snapshots[0].model_breakdown).toEqual([]);
  });

  it('treats schema-invalid stored model_breakdown JSON as empty', () => {
    const invalidBreakdown = JSON.stringify([
      {
        model: 'm',
        cumulative: { input_tokens: 10 },
        delta: null,
      },
    ]);
    const wire = toWireUsage(
      mk({
        sessions: [session()],
        snapshots: [snapshot({ model_breakdown: invalidBreakdown })],
        modelBreakdowns: [modelBreakdown(invalidBreakdown)],
      }),
      'a1'
    );

    expect(wire.sessions[0].model_breakdown).toEqual([]);
    expect(wire.snapshots[0].model_breakdown).toEqual([]);
  });

  it('omits checkpoint_n / pinned_version when null and passes a null artifact_id through', () => {
    const wire = toWireUsage(
      mk({
        snapshots: [
          snapshot({
            checkpoint_n: null,
            artifact_id: null,
            source_plan_ref_id: 'cloud:ext1',
            baseline_kind: 'first_observation',
          }),
        ],
        source_plan_links: [
          {
            source_plan_ref_id: 'cloud:ext1',
            artifact_id: 'a1',
            linked_at: ISO,
            pinned_version: null,
          } as unknown as ArtifactUsageData['source_plan_links'][number],
        ],
      }),
      'a1'
    );
    expect(wire.snapshots[0]).not.toHaveProperty('checkpoint_n');
    expect(wire.snapshots[0].artifact_id).toBeNull();
    expect(wire.source_plan_links[0]).not.toHaveProperty('pinned_version');
    expect(wire.source_plan_links[0].source_plan_ref_id).toBe('cloud:ext1');
  });

  it('emits dimensions + rate classes on the session total, per-model cumulative, and the snapshot', () => {
    const richBreakdown = JSON.stringify([
      {
        model: 'claude-haiku-4-5-20251001',
        speed: 'fast',
        service_tier: 'batch',
        inference_geo: 'us',
        cumulative: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 20,
          dimensions: { cache_creation_5m_input_tokens: 1, web_search_requests: 2 },
        },
        delta: null,
      },
    ]);
    const wire = toWireUsage(
      mk({
        sessions: [session()],
        snapshots: [
          snapshot({
            model_breakdown: richBreakdown,
            dimensions: JSON.stringify({ cache_creation_1h_input_tokens: 7 }),
          }),
        ],
        modelBreakdowns: [
          {
            agent: 'claude-code',
            session_id: 'sess-1',
            model_breakdown: richBreakdown,
            dimensions: JSON.stringify({
              cache_creation_1h_input_tokens: 7,
              cache_creation_5m_input_tokens: 1,
            }),
          } as unknown as ArtifactUsageData['modelBreakdowns'][number],
        ],
      }),
      'a1'
    );
    // The session total carries the high-water session-total dimensions (joined
    // from the per-session breakdown row, since CodingSessionRow has no JSON column).
    expect(wire.sessions[0].total.dimensions).toEqual({
      cache_creation_1h_input_tokens: 7,
      cache_creation_5m_input_tokens: 1,
    });
    // The per-model entry carries the three rate classes + the per-model dimensions.
    const pm = wire.sessions[0].model_breakdown[0];
    expect(pm.speed).toBe('fast');
    expect(pm.service_tier).toBe('batch');
    expect(pm.inference_geo).toBe('us');
    expect(pm.cumulative.dimensions).toEqual({
      cache_creation_5m_input_tokens: 1,
      web_search_requests: 2,
    });
    // The snapshot cumulative carries the snapshot-total dimensions column, and the
    // snapshot's own per-model breakdown carries the rate classes too.
    expect(wire.snapshots[0].cumulative.dimensions).toEqual({ cache_creation_1h_input_tokens: 7 });
    expect(wire.snapshots[0].model_breakdown[0].speed).toBe('fast');
  });

  it('omits dimensions + rate classes entirely for a default session (byte-identical wire)', () => {
    const plainBreakdown = JSON.stringify([
      {
        model: 'm',
        cumulative: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 20,
        },
        delta: null,
      },
    ]);
    const wire = toWireUsage(
      mk({
        sessions: [session()],
        snapshots: [snapshot({ model_breakdown: plainBreakdown })],
        modelBreakdowns: [modelBreakdown(plainBreakdown)],
      }),
      'a1'
    );
    expect(wire.sessions[0].total).not.toHaveProperty('dimensions');
    expect(wire.snapshots[0].cumulative).not.toHaveProperty('dimensions');
    const pm = wire.sessions[0].model_breakdown[0];
    expect(pm).not.toHaveProperty('speed');
    expect(pm).not.toHaveProperty('service_tier');
    expect(pm).not.toHaveProperty('inference_geo');
    expect(pm.cumulative).not.toHaveProperty('dimensions');
  });
});

describe('pushArtifact — bounded checkpoint attach concurrency', () => {
  let dir: string;
  let store: ArtifactStore;

  const STEP_IDS = Array.from({ length: 6 }, (_u, i) => `01HX0K8N6ZQF8M5R2V8DZ7T3K${String(i)}`);
  const SIX_STEP_PLAN: PlanInput = {
    ...PLAN,
    plan_steps: STEP_IDS.map((stepId, i) => ({
      step_id: stepId,
      label: `step ${String(i)}`,
      text: `step ${String(i)}`,
      acceptance_criteria: [],
    })),
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-sync-conc-'));
    const credsHome = path.join(dir, 'creds');
    store = new ArtifactStore({ repoRoot: dir, config: getDefaultConfig() });
    fs.mkdirSync(credsHome, { recursive: true });
    fs.writeFileSync(
      path.join(credsHome, 'credentials.json'),
      JSON.stringify({ baseUrl: 'http://localhost:3001', orgId: ORG_ID, userId: USER_ID }),
      { mode: 0o600 }
    );
    store.store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: PLAN.artifact_id,
      branch: PLAN.branch,
      task: PLAN.task,
      agent: PLAN.agent,
      base_sha: PLAN.base_sha,
      started_at: PLAN.started_at,
      completed_at: null,
      status: 'active',
    });
    await store.writePlan(SIX_STEP_PLAN);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const boundary = (n: number, phase: string) => ({
    snapshot_ref: `refs/orcaops/snap/${PLAN.artifact_id}/${String(n)}/${phase}`,
    tree_sha: (phase === 'open' ? 'a' : 'b').repeat(40),
    snapshot_commit_sha: 'c'.repeat(40),
    snapshot_error_reason: null,
  });
  const capturedSummary = () => ({
    status: 'captured' as const,
    hunk_count: 1,
    captured_hunk_count: 1,
    truncated: false,
    fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2' as const,
    manifest_hash: 'a'.repeat(43),
    manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1' as const,
    error_reason: null,
  });
  const capturedManifest = (n: number) => ({
    schema_version: 1 as const,
    artifact_id: PLAN.artifact_id,
    checkpoint_n: n,
    open_tree_sha: 'a'.repeat(40),
    close_tree_sha: 'b'.repeat(40),
    status: 'captured' as const,
    hunk_count: 1,
    captured_hunk_count: 1,
    truncated: false,
    error_reason: null,
    normalization_version: 'orcaops-line-normalization-v1' as const,
    diff_algorithm: 'git-diff-unified-v1' as const,
    diff_options: { unified: 3 as const, find_renames: true, no_ext_diff: true },
    limits: { max_diff_bytes: 2_000_000 },
    hash_encoding: 'base64url-nopad' as const,
    line_hash_algorithm: 'blake3-xof-96-base64url-nopad-v2' as const,
    patch_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1' as const,
    hunk_header_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1' as const,
    manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1' as const,
    hunks: [
      {
        hunk_index: 0,
        file_before: null,
        file_after: `f${String(n)}.ts`,
        change_type: 'add' as const,
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
  });

  async function writeClosedCheckpoints(count: number) {
    for (let i = 0; i < count; i += 1) {
      const n = i + 1;
      await store.writeCheckpointOpened(
        { artifact_id: PLAN.artifact_id, declared_step_ids: [STEP_IDS[i]!] },
        {
          idempotencyKey: `open-${String(n)}`,
          headSha: 'cafef00d',
          snapshotCallbacks: {
            captureOpenSnapshot: async () => ({ boundary: boundary(n, 'open') }),
          },
        }
      );
      await store.writeCheckpointClosed(
        {
          artifact_id: PLAN.artifact_id,
          n,
          summary: `closed ${String(n)}`,
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'fixture verification', exit_code: 0 }],
          completed_step_ids: [STEP_IDS[i]!],
          head_sha: 'cafef00d',
        },
        {
          idempotencyKey: `close-${String(n)}`,
          snapshotCallbacks: {
            captureCloseFingerprint: async () =>
              ({
                boundary: boundary(n, 'close'),
                summary: capturedSummary(),
                manifest: capturedManifest(n),
              }) as never,
          },
        }
      );
    }
  }

  const waitUntil = async (cond: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  };

  interface Deferred {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }

  function gatedMocks() {
    const built = buildMockClient();
    const deferreds: Deferred[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    built.mocks.attachCheckpoint.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          deferreds.push({
            resolve: (v) => {
              inFlight -= 1;
              resolve(v);
            },
            reject: (e) => {
              inFlight -= 1;
              reject(e);
            },
          });
        })
    );
    vi.spyOn(clientModule, 'createCloudClient').mockResolvedValue({
      client: built.client as never,
      credentials: testCredentials(ORG_ID),
    } as never);
    return { mocks: built.mocks, deferreds, stats: () => ({ inFlight, maxInFlight }) };
  }

  it('dispatches checkpoint attaches with bounded parallelism and holds the summary', async () => {
    // Neutralize the post-push auto-prune tail (summary present → prune
    // eligible); this test asserts dispatch shape, not ref pruning.
    vi.spyOn(snapshotsModule, 'collectPrunableRefsForArtifact').mockResolvedValue([]);
    vi.spyOn(snapshotsModule, 'collectBaselineRefsForArtifact').mockResolvedValue([]);
    await writeClosedCheckpoints(6);
    await store.writeSummary({
      schema_version: 1,
      artifact_id: PLAN.artifact_id,
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'cafef00d',
      ts: '2026-04-28T03:00:00.000Z',
    });
    const { mocks, deferreds, stats } = gatedMocks();

    const push = pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    // The pool must saturate at its documented limit — not 1 (serial), not 6.
    await waitUntil(() => deferreds.length === 4, 'pool saturation at 4 in-flight attaches');
    // Give a stalled serial/unbounded implementation a beat to overshoot.
    await new Promise((r) => setTimeout(r, 20));
    expect(deferreds.length).toBe(4);
    expect(mocks.attachSummary).not.toHaveBeenCalled();

    deferreds.forEach((d) => d.resolve({ ok: true }));
    await waitUntil(() => deferreds.length === 6, 'remaining attaches to start');
    // The summary barrier must hold through the SECOND wave too: checkpoints
    // 5 and 6 are in flight and unresolved, so the summary may not attach yet.
    expect(mocks.attachSummary).not.toHaveBeenCalled();
    deferreds.slice(4).forEach((d) => d.resolve({ ok: true }));
    await push;

    expect(mocks.attachCheckpoint).toHaveBeenCalledTimes(6);
    expect(stats().maxInFlight).toBe(4);
    expect(mocks.attachSummary).toHaveBeenCalledTimes(1);
  });

  it('a rejecting attach fails the push with no cloud-sync hash stored', async () => {
    await writeClosedCheckpoints(6);
    // A summary EXISTS so the not-called assertion below is non-vacuous.
    await store.writeSummary({
      schema_version: 1,
      artifact_id: PLAN.artifact_id,
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'cafef00d',
      ts: '2026-04-28T03:00:00.000Z',
    });
    const { deferreds, mocks } = gatedMocks();

    const push = pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    await waitUntil(() => deferreds.length >= 2, 'attaches to start');
    deferreds[1]!.reject(new Error('cloud attach exploded'));
    // Per-cp open-revision resolution is async before each attach, so
    // post-rejection stragglers may start in a later turn — keep
    // resolving them until the push settles (double-resolve is a no-op).
    const drain = setInterval(() => {
      deferreds.forEach((d, i) => {
        if (i !== 1) d.resolve({ ok: true });
      });
    }, 5);
    try {
      await expect(push).rejects.toThrow('cloud attach exploded');
    } finally {
      clearInterval(drain);
    }
    expect(mocks.attachSummary).not.toHaveBeenCalled();
    // Hash unstored → the next push re-runs and re-attaches (idempotent upserts).
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeFalsy();
  });

  it('bounds post-rejection starts to same-turn settles (observation granularity)', async () => {
    await writeClosedCheckpoints(6);
    const { deferreds, mocks } = gatedMocks();

    const push = pushArtifact({
      store,
      repo: mockRepo('git@github.com:foo/bar.git'),
      artifactId: PLAN.artifact_id,
      baseUrl: TEST_BASE_URL,
      credentialStore: testCredentialStore(),
    });
    await waitUntil(() => deferreds.length === 4, 'pool saturation');
    // Same-turn burst: lane 0 resolves, THEN lane 1 rejects. Reactions run in
    // settle order, so lane 0's continuation claims item 5 before lane 1's
    // catch marks the failure — the documented bounded overshoot. Every lane
    // settling after the catch has run must observe the failure and claim
    // nothing further.
    deferreds[0]!.resolve({ ok: true });
    deferreds[1]!.reject(new Error('cloud attach exploded'));
    await new Promise((r) => setTimeout(r, 20));
    expect(deferreds.length).toBe(5); // exactly one overshoot start, never item 6

    deferreds.slice(2).forEach((d) => d.resolve({ ok: true }));
    await expect(push).rejects.toThrow('cloud attach exploded');
    expect(deferreds.length).toBe(5); // nothing started after observation
    expect(mocks.attachCheckpoint).toHaveBeenCalledTimes(5);
    expect(mocks.attachSummary).not.toHaveBeenCalled();
    expect(store.store.getCloudSyncState(PLAN.artifact_id)).toBeFalsy();
  });
});
