import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { CapturePlanInputSchema, deriveUsageLedgerRecord, uuidv7 } from '@orcaops/storage';
import type { ArtifactThread, Checkpoint } from '@orcaops/storage';
import {
  appendProjectUsageEvents,
  openProjectDatabase,
  type ProjectDatabase,
  readProjectArtifact,
  readProjectUsage,
} from '@orcaops/storage/history/database';

import {
  readDatabaseCheckpointDiffFingerprints,
  resolveDatabaseDoneCriterionText,
} from './database-checkpoint-sources.js';
import { readDatabaseArtifactUsageSource } from './database-usage.js';
import { buildDiffFingerprintManifest } from '../diff-fingerprint/adapter.js';
import { captureDatabasePlan } from '../history/capture/plan.js';
import { requireDatabaseExecutionContext } from '../history/context/execution.js';
import { setupProjectDatabase } from '../history/setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
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
const counters = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 10,
  cache_read_input_tokens: 5,
};
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'db-sources-')));
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
  const plan = await captureDatabasePlan(handle, context, {
    authored: CapturePlanInputSchema.parse({
      idempotency_key: uuidv7(),
      task: 'Read the retained cloud push sources',
      label: 'Sources fixture',
      plan_steps: [
        {
          text: 'Read the sources',
          label: 'Read',
          acceptance_criteria: [{ text: 'sources read' }],
        },
      ],
    }),
    sourcePlan: null,
    agent: 'codex',
    snapshot: { enabled: false, excludePatterns: [] },
    secretAllow: [],
  });
  const thread = readProjectArtifact(handle, plan.artifactId)!.thread;
  return { handle, artifactId: plan.artifactId, thread };
}
async function appendUsage(handle: ProjectDatabase, artifactId: string, asOf: string) {
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
    ts: asOf,
    idempotency_key: payload.idempotency_key,
    payload,
  });
  return appendProjectUsageEvents(handle, {
    operationId: uuidv7(),
    expectedRevision: readProjectUsage(handle)?.revision ?? null,
    eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  });
}
function planEventId(thread: ArtifactThread): string {
  return thread.events.find((event) => event.record.type === 'plan_captured')!.record.event_id;
}

describe('readDatabaseArtifactUsageSource', () => {
  it('reconstructs cloud usage rows from retained database usage rows', async () => {
    const f = await fixture();
    await appendUsage(f.handle, f.artifactId, '2026-09-01T00:00:00Z');
    const usage = readDatabaseArtifactUsageSource(f.handle, f.artifactId)!;
    expect(usage.sessions).toEqual([
      {
        agent: 'codex',
        session_id: 'session-1',
        cumulative_input_tokens: 100,
        cumulative_output_tokens: 50,
        cumulative_cache_creation_input_tokens: 10,
        cumulative_cache_read_input_tokens: 5,
        as_of: '2026-09-01T00:00:00Z',
        record_count: 1,
      },
    ]);
    expect(usage.snapshots).toHaveLength(1);
    expect(usage.snapshots[0]).toMatchObject({
      artifact_id: f.artifactId,
      session_id: 'session-1',
      cumulative_input_tokens: 100,
    });
    expect(usage.modelBreakdowns).toHaveLength(1);
    expect(usage.source_plan_links).toEqual([]);
    expect(usage.anchor).toMatch(/^[0-9a-f]{64}$/);
  });
  it('returns null when no usage is retained, and for an unrelated artifact', async () => {
    const f = await fixture();
    expect(readDatabaseArtifactUsageSource(f.handle, f.artifactId)).toBeNull();
    await appendUsage(f.handle, f.artifactId, '2026-09-01T00:00:00Z');
    expect(readDatabaseArtifactUsageSource(f.handle, uuidv7())).toBeNull();
  });
});

describe('resolveDatabaseDoneCriterionText', () => {
  it('resolves each criterion id to its text in the open plan revision', async () => {
    const f = await fixture();
    const criterion = f.thread.plan!.plan_steps[0]!.acceptance_criteria[0]!;
    const cp = {
      status: 'closed',
      artifact_id: f.artifactId,
      n: 1,
      open_plan_revision_event_id: planEventId(f.thread),
      done_criteria: [{ criterion_id: criterion.criterion_id, evidence: 'shown' }],
    } as unknown as Checkpoint;
    const text = await resolveDatabaseDoneCriterionText(f.thread, cp);
    expect(text.get(criterion.criterion_id)).toBe(criterion.text);
  });
  it('fails fast when the open revision event is unresolvable', async () => {
    const f = await fixture();
    const cp = {
      status: 'closed',
      artifact_id: f.artifactId,
      n: 1,
      open_plan_revision_event_id: uuidv7(),
      done_criteria: [],
    } as unknown as Checkpoint;
    await expect(resolveDatabaseDoneCriterionText(f.thread, cp)).rejects.toThrow();
  });
  it('fails fast when a criterion is absent from the open revision', async () => {
    const f = await fixture();
    const cp = {
      status: 'closed',
      artifact_id: f.artifactId,
      n: 1,
      open_plan_revision_event_id: planEventId(f.thread),
      done_criteria: [{ criterion_id: uuidv7(), evidence: 'shown' }],
    } as unknown as Checkpoint;
    await expect(resolveDatabaseDoneCriterionText(f.thread, cp)).rejects.toThrow();
  });
});

describe('readDatabaseCheckpointDiffFingerprints', () => {
  it('is empty for a thread with no closed checkpoints', async () => {
    const f = await fixture();
    expect((await readDatabaseCheckpointDiffFingerprints(f.thread)).size).toBe(0);
  });
  async function fingerprintThread(
    mismatch: 'none' | 'artifact' | 'tree' | 'hash' | 'recovered' = 'none'
  ) {
    const artifactId = uuidv7();
    const openTreeSha = 'a'.repeat(40);
    const closeTreeSha = 'b'.repeat(40);
    const built = await buildDiffFingerprintManifest({
      artifactId,
      checkpointN: 1,
      openTreeSha,
      closeTreeSha,
      diffBytes: Buffer.from(
        'diff --git a/value.ts b/value.ts\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-old\n+new\n'
      ),
      truncated: false,
      maxDiffBytes: 100_000,
    });
    if (built.manifest === null) throw new Error('Expected a manifest fixture');
    const manifest = structuredClone(built.manifest);
    const summary = structuredClone(built.summary);
    if (mismatch === 'artifact') manifest.artifact_id = uuidv7();
    if (mismatch === 'tree') manifest.close_tree_sha = 'c'.repeat(40);
    if (mismatch === 'hash') summary.manifest_hash = 'forged';
    const checkpoint = {
      artifact_id: artifactId,
      n: 1,
      status: 'closed',
      files_changed: ['value.ts'],
      open_snapshot: { tree_sha: mismatch === 'recovered' ? closeTreeSha : openTreeSha },
      close_snapshot: { tree_sha: closeTreeSha },
      diff_fingerprint_summary: summary,
      source_event_ids: { opened: 'open', closed: 'current-close' },
    };
    const thread = {
      artifactId,
      checkpoints: [checkpoint],
      events: [
        {
          record: { type: 'plan_captured', event_id: 'plan' },
          payload: { baseline_seed_tree_sha: openTreeSha },
        },
        {
          record: { type: 'checkpoint_opened', event_id: 'open' },
          payload: { n: 1, open_snapshot: { tree_sha: closeTreeSha } },
        },
        {
          record: { type: 'checkpoint_closed', event_id: 'older-close' },
          payload: { n: 1, diff_fingerprint_manifest: built.manifest },
        },
        {
          record: { type: 'checkpoint_closed', event_id: 'current-close' },
          payload: { n: 1, diff_fingerprint_manifest: manifest },
        },
      ],
    } as unknown as ArtifactThread;
    return { manifest, thread };
  }
  it('loads the manifest from the exact retained close', async () => {
    const f = await fingerprintThread();
    const map = await readDatabaseCheckpointDiffFingerprints(f.thread);
    expect(map.get(1)).toEqual(f.manifest);
    expect(map.get(1)).not.toBe(f.manifest);
  });
  it('loads a recovered manifest from its documented empty physical fence', async () => {
    const f = await fingerprintThread('recovered');
    expect((await readDatabaseCheckpointDiffFingerprints(f.thread)).get(1)).toEqual(f.manifest);
  });
  it.each(['artifact', 'tree', 'hash'] as const)(
    'leaves a mismatched %s manifest unavailable without changing its bytes',
    async (mismatch) => {
      const f = await fingerprintThread(mismatch);
      const original = structuredClone(f.manifest);
      const map = await readDatabaseCheckpointDiffFingerprints(f.thread);
      expect(map.has(1)).toBe(false);
      expect(f.manifest).toEqual(original);
    }
  );
  it('does not fall back to an older close when the retained close is inconsistent', async () => {
    const f = await fingerprintThread('hash');
    expect((await readDatabaseCheckpointDiffFingerprints(f.thread)).has(1)).toBe(false);
  });
});
