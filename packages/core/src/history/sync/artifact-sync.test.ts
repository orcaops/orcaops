import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';
import {
  CapturePlanInputSchema,
  deriveUsageLedgerRecord,
  prepareArtifactDraft,
  sha256Hex,
  uuidv7,
} from '@orcaops/storage';
import {
  appendProjectArtifactEvents,
  appendProjectUsageEvents,
  openProjectDatabase,
  type ProjectDatabase,
  publishProjectSourcePlanLocator,
  publishProjectSourcePlanRecord,
  readProjectArtifact,
  readProjectUsage,
} from '@orcaops/storage/history/database';
import {
  beginProjectArtifactPush,
  readProjectArtifactPush,
} from '@orcaops/storage/history/database/artifact-push';

import {
  buildDatabaseArtifactPushInput,
  DatabaseArtifactPushUnavailableError,
  pushDatabaseArtifact,
} from './artifact-sync.js';
import type { ArtifactPushClient } from './dispatch.js';
import { observeDatabaseSessionBranch } from './session-observation.js';
import { readDatabaseArtifactUsageSource } from '../../cloud/database-usage.js';
import { callsForSnapshot } from '../../cloud/push-calls.js';
import { bornPinExternalId, type PreflightClient } from '../../cloud/source-plan-pin.js';
import { buildDiffFingerprintManifest } from '../../diff-fingerprint/adapter.js';
import { captureDatabasePlan } from '../capture/plan.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const target = { server_url: 'https://example.test', org_id: 'org', account_id: 'account' };
function fakePushClient() {
  const sent: string[] = [];
  const method = (name: string) => async () => {
    sent.push(name);
    return Buffer.from(JSON.stringify({ accepted: name }));
  };
  const client: ArtifactPushClient = {
    captureThread: {
      start: method('captureThread.start'),
      attachPlan: method('captureThread.attachPlan'),
      attachPlanRevision: method('captureThread.attachPlanRevision'),
      attachCheckpointOpened: method('captureThread.attachCheckpointOpened'),
      attachCheckpoint: method('captureThread.attachCheckpoint'),
      attachSummary: method('captureThread.attachSummary'),
      attachEvaluators: method('captureThread.attachEvaluators'),
      attachCodingSessionsUsage: method('captureThread.attachCodingSessionsUsage'),
    },
    sourcePlan: { attachPin: method('sourcePlan.attachPin') },
  };
  return { client, sent };
}
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  await execute('git', ['-c', 'gc.auto=0', '-C', cwd, ...args], {
    env: {
      ...env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_OPTIONAL_LOCKS: '0',
    },
    timeout: 10_000,
  });
}
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'push-input-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Original fixture');
  const root = path.join(directory, 'history');
  await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: ['Disposable checkout'],
    secretAllow: [],
  });
  const context = await requireDatabaseExecutionContext({ cwd, root });
  const handle = await openProjectDatabase({ authority: context.authority, mode: 'writer' });
  handles.push(handle);
  async function capture(
    sourcePlan: Parameters<typeof captureDatabasePlan>[2]['sourcePlan'] = null
  ) {
    return captureDatabasePlan(handle, context, {
      authored: CapturePlanInputSchema.parse({
        idempotency_key: uuidv7(),
        task: 'Assemble a grouped push from the retained thread',
        label: 'Push input fixture',
        plan_steps: [{ text: 'Assemble', label: 'Assemble' }],
      }),
      sourcePlan,
      agent: 'codex',
      snapshot: { enabled: false, excludePatterns: [] },
      secretAllow: [],
    });
  }
  return { handle, context, capture };
}
async function appendUsage(
  handle: ProjectDatabase,
  artifactId: string,
  options: { asOf?: string; recordedAt?: string; dimensions?: Record<string, number> } = {}
) {
  const counters = {
    input_tokens: 7,
    output_tokens: 3,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
  };
  const asOf = options.asOf ?? '2026-09-01T00:00:00Z';
  const payload = {
    snapshot_id: uuidv7(),
    idempotency_key: uuidv7(),
    agent: 'codex' as const,
    session_id: 'session-1',
    artifact_id: artifactId,
    source_plan_ref_id: null,
    lifecycle_event: 'checkpoint_close' as const,
    checkpoint_n: 1,
    cumulative_usage: counters,
    delta_usage: null,
    baseline_kind: 'first_observation' as const,
    model_breakdown: [{ model: 'a-model', cumulative: counters, delta: null }],
    record_count: 1,
    as_of: asOf,
  };
  const { record } = deriveUsageLedgerRecord({
    type: 'agent_usage_snapshot_recorded',
    ts: options.recordedAt ?? asOf,
    idempotency_key: payload.idempotency_key,
    payload,
  });
  await appendProjectUsageEvents(handle, {
    operationId: uuidv7(),
    expectedRevision: readProjectUsage(handle)?.revision ?? null,
    eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  });
}

it('assembles a plan-only push the accepted admission consumes', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture();
  const input = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl: 'ssh://example.test/repo',
  });
  expect(input.calls.map((call) => call.method)).toEqual([
    'captureThread.start',
    'captureThread.attachPlan',
  ]);
  expect(JSON.parse(input.calls[0]!.payloadBytes.toString())).toMatchObject({
    externalId: artifactId,
  });
  expect(JSON.parse(input.calls[1]!.payloadBytes.toString())).toMatchObject({
    artifact_id: artifactId,
  });
  expect(input.result).toEqual({
    checkpoints: 0,
    summary: false,
    evaluators: 0,
    sourcePlanPinned: null,
  });
  // The dispatcher's admission accepts the assembled input against live database state.
  await beginProjectArtifactPush(f.handle, input, { secretAllow: [] });
  const admitted = readProjectArtifactPush(f.handle, input.pushId).value!;
  expect(admitted.calls.map((call) => call.request.scope.method)).toEqual([
    'captureThread.start',
    'captureThread.attachPlan',
  ]);
});
it('adds a coding-sessions usage call when the artifact has retained usage', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture();
  await appendUsage(f.handle, artifactId);
  const input = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl: 'ssh://example.test/repo',
  });
  expect(input.calls.map((call) => call.method)).toEqual([
    'captureThread.start',
    'captureThread.attachPlan',
    'captureThread.attachCodingSessionsUsage',
  ]);
  expect(input.usageRevision).not.toBeNull();
  await beginProjectArtifactPush(f.handle, input, { secretAllow: [] });
});
it('refuses an artifact with no retained plan', async () => {
  const f = await fixture();
  await expect(
    buildDatabaseArtifactPushInput(f.handle, uuidv7(), {
      target,
      repoUrl: 'ssh://example.test/repo',
    })
  ).rejects.toBeInstanceOf(DatabaseArtifactPushUnavailableError);
});
it('refuses a mismatched retained fingerprint before sending and preserves its payload', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture();
  const retained = readProjectArtifact(f.handle, artifactId)!;
  const plan = retained.thread.plan!;
  const built = await buildDiffFingerprintManifest({
    artifactId: uuidv7(),
    checkpointN: 1,
    openTreeSha: 'a'.repeat(40),
    closeTreeSha: 'b'.repeat(40),
    diffBytes: Buffer.from(
      'diff --git a/value.ts b/value.ts\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-old\n+new\n'
    ),
    truncated: false,
    maxDiffBytes: 100_000,
  });
  if (built.manifest === null) throw new Error('Expected a manifest fixture');
  const draft = await prepareArtifactDraft(
    {
      artifactId,
      priorEvents: retained.thread.events,
      authoredPayload: {},
      secretAllow: [],
      idempotencyBlocks: [],
    },
    async (semantics) => {
      const opened = await semantics.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [plan.plan_steps[0]!.step_id] },
        { idempotencyKey: uuidv7(), headSha: plan.base_sha }
      );
      if (opened.outcome !== 'created') throw new Error('Expected a new checkpoint');
      await semantics.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: opened.checkpoint.n,
          summary: 'Retain inconsistent fingerprint bytes',
          files_changed: ['value.ts'],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'fixture verification', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0]!.step_id],
          head_sha: plan.base_sha,
        },
        {
          idempotencyKey: uuidv7(),
          snapshotCallbacks: {
            async captureCloseFingerprint() {
              return {
                boundary: {
                  snapshot_ref: 'refs/orcaops/test/close',
                  tree_sha: built.manifest!.close_tree_sha,
                  snapshot_commit_sha: 'c'.repeat(40),
                  snapshot_error_reason: null,
                },
                summary: built.summary,
                manifest: built.manifest,
              };
            },
          },
        }
      );
    }
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  await appendProjectArtifactEvents(f.handle, {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: retained.revision,
    eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
    sidecarPayloads: draft.events
      .filter((event) => event.sidecar !== null)
      .map((event) => ({ eventId: event.record.event_id, bytes: event.payloadBytes })),
    secretAllow: [],
  });
  const before = structuredClone(
    readProjectArtifact(f.handle, artifactId)!.thread.events.find(
      (event) => event.record.type === 'checkpoint_closed'
    )!.payload
  );
  const client = fakePushClient();

  await expect(
    pushDatabaseArtifact(f.handle, artifactId, {
      target,
      repoUrl: 'ssh://example.test/repo',
      client: client.client,
    })
  ).rejects.toMatchObject({
    code: 'CLOUD_PUSH_UNAVAILABLE',
    message: expect.stringMatching(/could not be validated.*Nothing was sent/),
  });
  expect(client.sent).toEqual([]);
  expect(
    readProjectArtifact(f.handle, artifactId)!.thread.events.find(
      (event) => event.record.type === 'checkpoint_closed'
    )!.payload
  ).toEqual(before);
});
it('requires a preflight client for a retained source plan', async () => {
  const f = await fixture();
  const content = '# Pinned plan\n\nbody';
  const { artifactId } = await f.capture({
    source_ref: { kind: 'local', locator: 'plan.md' },
    content,
    hash: sha256Hex(content),
    baseline: null,
  });
  await expect(
    buildDatabaseArtifactPushInput(f.handle, artifactId, {
      target,
      repoUrl: 'ssh://example.test/repo',
    })
  ).rejects.toMatchObject({
    code: 'CLOUD_PUSH_UNAVAILABLE',
    message: expect.stringMatching(/pin/),
  });
});
it('requires the repository session identity when session state exists', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture();
  const observed = await observeDatabaseSessionBranch(f.handle, f.context, {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    target,
    repoUrl: 'ssh://example.test/repo',
    secretAllow: [],
  });
  expect(observed).not.toBeNull();
  await expect(
    buildDatabaseArtifactPushInput(f.handle, artifactId, {
      target,
      repoUrl: 'ssh://example.test/repo',
    })
  ).rejects.toMatchObject({
    code: 'CLOUD_PUSH_UNAVAILABLE',
    message: expect.stringMatching(/session identity/),
  });
});

function localPin() {
  const content = '# Retained Source Plan';
  return {
    source_ref: { kind: 'local' as const, locator: 'plan.md' },
    content,
    hash: sha256Hex(content),
    baseline: null,
  };
}
function missingPlanClient(): PreflightClient {
  return {
    sourcePlan: {
      get: vi
        .fn()
        .mockRejectedValue(new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 })),
    },
  };
}
function approvedPlanClient(): PreflightClient {
  return {
    sourcePlan: {
      get: vi.fn().mockResolvedValue({
        externalId: 'approved-plan',
        slug: 'approved-plan',
        title: 'Approved plan',
        status: 'APPROVED',
        approvedVersionNumber: 3,
        webUrl: 'https://example.test/plans/approved-plan',
        captureThread: null,
      }),
    },
  };
}
function cloudPin() {
  return {
    ...localPin(),
    source_ref: {
      kind: 'cloud' as const,
      locator: 'approved-plan',
      version: '3',
      base_url: target.server_url,
      org_id: target.org_id,
    },
  };
}
it('assembles a born Source Plan pin from retained content without a file lookup', async () => {
  const f = await fixture();
  const pin = localPin();
  const { artifactId } = await f.capture(pin);
  const before = f.handle.read(() => null).counters;
  const input = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl: 'ssh://example.test/repo',
    repoRoot: f.context.git.worktreeRoot,
    sourcePlanClient: missingPlanClient(),
  });
  expect(input.result.sourcePlanPinned).toBe('B');
  const call = input.calls.find((call) => call.method === 'sourcePlan.attachPin')!;
  expect(JSON.parse(call.payloadBytes.toString())).toMatchObject({
    external_id: bornPinExternalId(artifactId),
    version_number: 1,
    body: pin.content,
    content_hash: pin.hash,
    derived_from: null,
  });
  expect(f.handle.read(() => null).counters).toEqual(before);
  await beginProjectArtifactPush(f.handle, input, { secretAllow: [] });
});
it('assembles the exact approved cloud pin after a read-only preflight', async () => {
  const f = await fixture();
  const pin = cloudPin();
  const { artifactId } = await f.capture(pin);
  const sourcePlanClient = approvedPlanClient();
  const input = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl: 'ssh://example.test/repo',
    sourcePlanClient,
  });
  expect(sourcePlanClient.sourcePlan.get).toHaveBeenCalledWith({
    slugOrExternalId: 'approved-plan',
  });
  expect(input.result.sourcePlanPinned).toBe('A');
  expect(
    JSON.parse(
      input.calls.find((call) => call.method === 'sourcePlan.attachPin')!.payloadBytes.toString()
    )
  ).toMatchObject({
    external_id: 'approved-plan',
    version_number: 3,
    body: pin.content,
    content_hash: pin.hash,
  });
  await beginProjectArtifactPush(f.handle, input, { secretAllow: [] });
});
it('rejects a stale cloud pin before recording a push', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture({
    ...cloudPin(),
    source_ref: { ...cloudPin().source_ref, version: '2' },
  });
  const before = f.handle.read(() => null).counters;
  await expect(
    buildDatabaseArtifactPushInput(f.handle, artifactId, {
      target,
      repoUrl: 'ssh://example.test/repo',
      sourcePlanClient: approvedPlanClient(),
    })
  ).rejects.toMatchObject({ reason: 'stale' });
  expect(f.handle.read(() => null).counters).toEqual(before);
});
it('keeps the payload usage revision when usage changes during pin preflight', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture(localPin());
  await appendUsage(f.handle, artifactId);
  const original = readProjectUsage(f.handle)!.revision;
  const sourcePlanClient = missingPlanClient();
  sourcePlanClient.sourcePlan.get = async () => {
    await appendUsage(f.handle, artifactId);
    throw new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 });
  };
  const input = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl: 'ssh://example.test/repo',
    sourcePlanClient,
  });
  expect(input.usageRevision).toEqual(original);
  expect(readProjectUsage(f.handle)!.revision).not.toEqual(original);
  await expect(
    beginProjectArtifactPush(f.handle, input, { secretAllow: [] })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProjectArtifactPush(f.handle, input.pushId).value).toBeNull();
});
it('includes only the selected repository and worktree session in push admission', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture();
  const repoUrl = 'ssh://example.test/repo';
  await observeDatabaseSessionBranch(f.handle, f.context, {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    target,
    repoUrl,
    secretAllow: [],
  });
  const selected = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl,
    session: { repoUrl, workingDir: f.context.git.worktreeRoot },
  });
  expect(selected.session?.key).toEqual({
    target,
    repoUrl,
    workingDir: f.context.git.worktreeRoot,
  });
  expect(selected.session?.expectedSelection).toMatchObject({ version: 1 });
  await beginProjectArtifactPush(f.handle, selected, { secretAllow: [] });
  const other = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl,
    session: { repoUrl: 'ssh://example.test/other', workingDir: f.context.git.worktreeRoot },
  });
  expect(other.session).toBeNull();
});
it('pushes historical artifacts without attributing them to an unrelated session branch', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture();
  await git(f.context.git.worktreeRoot, 'checkout', '-qb', 'unrelated');
  const context = await requireDatabaseExecutionContext({
    cwd: f.context.git.worktreeRoot,
    root: f.context.authority.resolvedRoot,
  });
  const repoUrl = 'ssh://example.test/repo';
  await observeDatabaseSessionBranch(f.handle, context, {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    target,
    repoUrl,
    secretAllow: [],
  });
  const input = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl,
    session: { repoUrl, workingDir: context.git.worktreeRoot },
  });
  expect(input.session).toBeNull();
  expect(JSON.parse(input.calls[0]!.payloadBytes.toString())).toMatchObject({
    branch: 'topic',
    branchHistory: [],
  });
});

it.each([
  { accountId: 'account', source: 'file', expected: true },
  { accountId: 'another-account', source: 'file', expected: false },
  { accountId: 'account', source: 'alias', expected: true },
  { accountId: 'account', source: 'deleted', expected: false },
])('resolves $source local pin lineage for $accountId', async ({ accountId, source, expected }) => {
  const f = await fixture();
  const pin = localPin();
  const realPath = path.join(f.context.git.worktreeRoot, 'plan.md');
  await writeFile(realPath, pin.content);
  if (source === 'alias') {
    await symlink(realPath, path.join(f.context.git.worktreeRoot, 'plan-alias.md'));
    pin.source_ref.locator = 'plan-alias.md';
  }
  const { artifactId } = await f.capture(pin);
  const namespace = {
    namespaceId: uuidv7(),
    scopeKind: 'account' as const,
    serverUrl: target.server_url,
    orgId: target.org_id,
    accountId,
    originalNamespaceHash: null,
    originalLocatorHash: null,
  };
  const recordId = uuidv7();
  await publishProjectSourcePlanRecord(
    f.handle,
    {
      operationId: uuidv7(),
      recordId,
      namespace,
      kind: 'approved',
      expectedSelection: null,
      recordBytes: Buffer.from(
        JSON.stringify({
          schema_version: 1,
          external_id: 'ancestor-plan',
          slug: 'ancestor',
          version_number: 7,
          title: 'Ancestor',
          body: pin.content,
          content_hash: pin.hash,
          source_ref: null,
          base_url: target.server_url,
          org_id: target.org_id,
          pulled_at: '2026-09-01T00:00:00Z',
        })
      ),
    },
    { secretAllow: [] }
  );
  await publishProjectSourcePlanLocator(
    f.handle,
    {
      operationId: uuidv7(),
      revisionId: uuidv7(),
      namespace,
      kind: 'path',
      realPath,
      approvedRecordId: recordId,
      expectedSelection: null,
      recordBytes: Buffer.from(
        JSON.stringify({ real_path: realPath, external_id: 'ancestor-plan', version_number: 7 })
      ),
    },
    { secretAllow: [] }
  );
  if (source === 'deleted') await rm(realPath);
  const input = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl: 'ssh://example.test/repo',
    repoRoot: f.context.git.worktreeRoot,
    sourcePlanClient: missingPlanClient(),
  });
  const payload = JSON.parse(
    input.calls.find((call) => call.method === 'sourcePlan.attachPin')!.payloadBytes.toString()
  );
  expect(payload.derived_from).toEqual(
    expected ? { source_plan_external_id: 'ancestor-plan', version_number: 7 } : null
  );
});
it('rejects admission after the selected session changes during preparation', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture(localPin());
  const repoUrl = 'ssh://example.test/repo';
  await observeDatabaseSessionBranch(f.handle, f.context, {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    target,
    repoUrl,
    secretAllow: [],
  });
  const sourcePlanClient = missingPlanClient();
  sourcePlanClient.sourcePlan.get = async () => {
    await git(f.context.git.worktreeRoot, 'checkout', '-qb', 'next-branch');
    const context = await requireDatabaseExecutionContext({
      cwd: f.context.git.worktreeRoot,
      root: f.context.authority.resolvedRoot,
    });
    await observeDatabaseSessionBranch(f.handle, context, {
      operationId: uuidv7(),
      revisionId: uuidv7(),
      target,
      repoUrl,
      secretAllow: [],
    });
    throw new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 });
  };
  const input = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl,
    sourcePlanClient,
    session: { repoUrl, workingDir: f.context.git.worktreeRoot },
  });
  await expect(
    beginProjectArtifactPush(f.handle, input, { secretAllow: [] })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProjectArtifactPush(f.handle, input.pushId).value).toBeNull();
});

it.each(['local', 'cloud'] as const)(
  'refuses a retained %s pin whose content does not match its hash',
  async (kind) => {
    const f = await fixture();
    const pin = kind === 'local' ? localPin() : cloudPin();
    const { artifactId } = await f.capture({ ...pin, hash: 'a'.repeat(64) });
    const sourcePlanClient = approvedPlanClient();
    const before = f.handle.read(() => null).counters;
    await expect(
      buildDatabaseArtifactPushInput(f.handle, artifactId, {
        target,
        repoUrl: 'ssh://example.test/repo',
        sourcePlanClient,
      })
    ).rejects.toMatchObject({ name: 'SourcePlanIntegrityError' });
    expect(sourcePlanClient.sourcePlan.get).not.toHaveBeenCalled();
    expect(f.handle.read(() => null).counters).toEqual(before);
  }
);
it('honors cancellation during Source Plan preparation before returning an admission input', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture(localPin());
  const stop = new AbortController();
  const sourcePlanClient = missingPlanClient();
  sourcePlanClient.sourcePlan.get = async () => {
    stop.abort();
    throw new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 });
  };
  const before = f.handle.read(() => null).counters;
  await expect(
    buildDatabaseArtifactPushInput(f.handle, artifactId, {
      target,
      repoUrl: 'ssh://example.test/repo',
      sourcePlanClient,
      signal: stop.signal,
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(f.handle.read(() => null).counters).toEqual(before);
});

it('ships only artifact snapshots while retaining source-time session high-water dimensions', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture();
  await appendUsage(f.handle, artifactId, {
    asOf: '2026-09-01T01:00:00Z',
    recordedAt: '2026-09-01T04:00:00Z',
  });
  await appendUsage(f.handle, uuidv7(), {
    asOf: '2026-09-01T02:00:00Z',
    recordedAt: '2026-09-01T03:00:00Z',
    dimensions: { reasoning: 20 },
  });
  const before = readProjectUsage(f.handle)!;
  const usage = readDatabaseArtifactUsageSource(f.handle, artifactId)!;
  expect(usage.snapshots).toHaveLength(1);
  expect(usage.modelBreakdowns[0]?.dimensions).toBe(JSON.stringify({ reasoning: 20 }));
  const input = await buildDatabaseArtifactPushInput(f.handle, artifactId, {
    target,
    repoUrl: 'ssh://example.test/repo',
  });
  const call = input.calls.find(
    (call) => call.method === 'captureThread.attachCodingSessionsUsage'
  )!;
  expect(Buffer.from(call.payloadBytes).toString()).toContain('reasoning');
  expect(readProjectUsage(f.handle)).toEqual(before);
});

it('preserves original revision, checkpoint, summary and pin wire ordering', async () => {
  const f = await fixture();
  const { artifactId } = await f.capture();
  const retained = readProjectArtifact(f.handle, artifactId)!;
  const plan = retained.thread.plan!;
  const start = {
    externalId: artifactId,
    repoUrl: 'ssh://example.test/repo',
    branch: plan.branch,
    branchHistory: [],
    description: plan.task,
    label: plan.label,
    agent: plan.agent,
    startedAt: plan.started_at,
  };
  const draft = await prepareArtifactDraft(
    {
      artifactId,
      priorEvents: retained.thread.events,
      authoredPayload: {},
      secretAllow: [],
      idempotencyBlocks: [],
    },
    async (semantics) => {
      await semantics.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [plan.plan_steps[0]!.step_id] },
        { idempotencyKey: uuidv7(), headSha: plan.base_sha }
      );
      const opened = await callsForSnapshot(
        {
          plan,
          checkpoints: await semantics.readCheckpoints(artifactId),
          summary: null,
          evaluators: null,
          source_plan: null,
          fingerprintByN: new Map(),
          usage: null,
        },
        start,
        null,
        async () => new Map()
      );
      expect(opened.map((call) => call.method)).toEqual([
        'captureThread.start',
        'captureThread.attachPlan',
        'captureThread.attachCheckpointOpened',
      ]);
      expect(JSON.parse(opened[2]!.payload_json)).toMatchObject({
        artifact_id: artifactId,
        n: 1,
        plan_revision_id: plan.source_event_id,
      });
      await semantics.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: 1,
          summary: 'Complete original scope',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'fixture verification', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0]!.step_id],
          head_sha: plan.base_sha,
        },
        { idempotencyKey: uuidv7() }
      );
      await semantics.revisePlan(
        {
          idempotency_key: uuidv7(),
          artifact_id: artifactId,
          label: 'Revised label',
          plan_steps: plan.plan_steps,
          touched_scope: [],
          non_goals: [],
          decisions: [],
          rationale: 'Clarify captured label',
          prior_plan_event_id: plan.source_event_id!,
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
        },
        { idempotencyKey: uuidv7() }
      );
      await semantics.writeSummary({
        schema_version: 1,
        artifact_id: artifactId,
        outcome: 'Completed scope',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: plan.base_sha,
        ts: '2026-09-01T05:00:00Z',
      });
      return callsForSnapshot(
        {
          plan: await semantics.readPlan(artifactId),
          checkpoints: await semantics.readCheckpoints(artifactId),
          summary: await semantics.readSummary(artifactId),
          evaluators: await semantics.readEvaluatorLog(artifactId),
          source_plan: null,
          fingerprintByN: new Map(),
          usage: null,
        },
        start,
        { retained: 'original pin payload' },
        async () => new Map()
      );
    }
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  const calls = draft.evaluation.value;
  expect(calls.map((call) => call.method)).toEqual([
    'captureThread.start',
    'captureThread.attachPlanRevision',
    'captureThread.attachCheckpoint',
    'captureThread.attachSummary',
    'captureThread.attachEvaluators',
    'sourcePlan.attachPin',
  ]);
  expect(JSON.parse(calls[1]!.payload_json)).toMatchObject({
    artifact_id: artifactId,
    label: 'Revised label',
    revision_n: 1,
  });
  expect(JSON.parse(calls[2]!.payload_json)).toMatchObject({
    artifact_id: artifactId,
    n: 1,
    summary: 'Complete original scope',
  });
  expect(JSON.parse(calls[3]!.payload_json)).toMatchObject({
    artifact_id: artifactId,
    outcome: 'Completed scope',
  });
  expect(JSON.parse(calls[5]!.payload_json)).toEqual({ retained: 'original pin payload' });
});
