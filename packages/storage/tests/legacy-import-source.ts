import { createHash } from 'node:crypto';

import type { EventType } from '../src/events/event-log.js';
import type { ProjectHistoryImportSource } from '../src/history/database/legacy-import.js';
import { digest, recordChecksum } from '../src/history/event-integrity.js';
import { uuidv7 } from '../src/ids/uuidv7.js';

function record(type: EventType, payload: unknown, ts: string) {
  const unsigned = {
    event_id: uuidv7(),
    type,
    ts,
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload,
  };
  const checked = { ...unsigned, checksum: recordChecksum(unsigned) };
  return { record: checked, bytes: Buffer.from(JSON.stringify(checked) + '\n') };
}

function plan(artifactId: string, startedAt: string) {
  return {
    schema_version: 4,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'legacy-base',
    agent: 'claude-code',
    agent_session_id: null,
    task: 'Retain the original legacy thread',
    label: 'Legacy thread',
    plan_steps: [
      {
        step_id: uuidv7(),
        text: 'Preserve identities',
        label: 'Preserve identities',
        acceptance_criteria: [],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: startedAt,
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  };
}

function usageRecord(artifactId: string, ordinal: number) {
  const idempotencyKey = uuidv7();
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const unsigned = {
    event_id: uuidv7(),
    type: 'agent_usage_snapshot_recorded',
    ts: `2026-06-0${ordinal}T00:05:00.000Z`,
    schema_version: 1,
    idempotency_key: idempotencyKey,
    payload: {
      snapshot_id: uuidv7(),
      idempotency_key: idempotencyKey,
      agent: 'claude-code',
      session_id: uuidv7(),
      artifact_id: artifactId,
      source_plan_ref_id: null,
      lifecycle_event: 'checkpoint_closed',
      checkpoint_n: ordinal,
      cumulative_usage: usage,
      delta_usage: usage,
      baseline_kind: 'whole_session',
      model_breakdown: [],
      record_count: 1,
      as_of: `2026-06-0${ordinal}T00:05:00.000Z`,
    },
  };
  const checked = { ...unsigned, checksum: recordChecksum(unsigned) };
  return { record: checked, bytes: Buffer.from(JSON.stringify(checked) + '\n') };
}

function legacySource(overrides: Partial<ProjectHistoryImportSource> = {}) {
  const first = uuidv7();
  const second = uuidv7();
  const firstEvents = Buffer.concat([
    record('plan_captured', plan(first, '2026-06-01T00:00:00.000Z'), '2026-06-01T00:00:00.000Z')
      .bytes,
  ]);
  const secondEvents = record(
    'plan_captured',
    plan(second, '2026-06-02T00:00:00.000Z'),
    '2026-06-02T00:00:00.000Z'
  ).bytes;
  const usageBytes = Buffer.concat([usageRecord(first, 1).bytes, usageRecord(second, 2).bytes]);
  const image = Buffer.from('legacy operational image');
  const source: ProjectHistoryImportSource = {
    sourceProfile: 'orcaops-0.2.0-rc.2',
    sourceRevision: '9cb6e606cebed31a3e22bb928119c04cb041bfc3',
    sourceManifestHash: createHash('sha256').update('legacy manifest').digest('hex'),
    artifacts: [
      { artifactId: first, eventBytes: firstEvents, sidecarPayloads: [] },
      { artifactId: second, eventBytes: secondEvents, sidecarPayloads: [] },
    ],
    usage: { eventBytes: usageBytes, sidecarPayloads: [] },
    seed: null,
    planIdempotency: [],
    lifecycles: [],
    attempts: [],
    sessionBranches: [
      {
        repoUrl: 'https://git.example.test/legacy.git',
        workingDir: '/legacy/repository',
        currentBranch: 'main',
        branchHistory: ['feature/legacy'],
        baseCommitSha: 'a'.repeat(40),
        // The frozen writer never acknowledged this session; the absence is retained as an
        // absence rather than filled in.
        ackedAt: null,
        sourceLocation: '/legacy/repository/.orcaops/cache/orcaops.db',
      },
    ],
    cloudFacts: [
      {
        // A successful sync followed by a later failed push: the frozen writer keeps both on
        // the same row, and so must the conversion.
        artifactId: first,
        syncedAt: '2026-06-02T09:05:00.000Z',
        syncHash: digest(Buffer.from('payload')),
        externalId: first,
        orgId: 'org-legacy',
        lastPushAttemptAt: '2026-06-02T09:40:00.000Z',
        lastPushErrorKind: 'http-5xx',
        lastPushErrorMessage: 'upstream unavailable',
        consecutiveFailures: 3,
        sourceLocation: '/legacy/repository/.orcaops/cache/orcaops.db',
      },
      {
        artifactId: second,
        syncedAt: null,
        syncHash: null,
        externalId: null,
        orgId: null,
        lastPushAttemptAt: '2026-06-02T09:06:00.000Z',
        lastPushErrorKind: 'network',
        lastPushErrorMessage: 'connect ECONNREFUSED',
        consecutiveFailures: 1,
        sourceLocation: '/legacy/repository/.orcaops/cache/orcaops.db',
      },
    ],
    sourcePlanRecords: [
      {
        sourceLocation: '/legacy/repository/.orcaops/cache/source-plan/pull/x/by-id/y@2.json',
        kind: 'approved',
        namespaceBaseUrl: 'https://cloud.example.test',
        namespaceOrgId: 'org-legacy',
        externalId: 'plan-gamma',
        slug: 'gamma',
        versionNumber: 2,
        versionId: null,
        target: null,
        title: 'Gamma rollout',
        contentHash: digest(Buffer.from('# Approved plan\n')),
        bodyBytes: Buffer.from('# Approved plan\n'),
        realPath: null,
        pulledAt: '2026-06-02T09:10:00.000Z',
        recordBytes: Buffer.from('{"schema_version":1,"external_id":"plan-gamma"}'),
      },
    ],
    sqliteImages: [
      {
        sourceLocation: '/legacy/repository/.orcaops/cache/orcaops.db',
        baselineVersion: 25,
        walFrames: 0,
        committedFrames: 0,
        tableCounts: { artifacts: 2, usage_snapshots: 2 },
        parts: [
          {
            part: 'main',
            sha256: createHash('sha256').update(image).digest('hex'),
            byteLength: image.length,
          },
        ],
      },
    ],
    omissions: [
      { location: '.orcaops/reviews', family: 'task-review', state: 'intentionally-not-inspected' },
    ],
    gitResources: [
      {
        ref: 'refs/orcaops/baseline/x',
        oid: 'b'.repeat(40),
        symbolicTarget: null,
        ownership: 'unknown',
      },
    ],
    ...overrides,
  };
  return { source, first, second };
}

export { record, plan, usageRecord, legacySource };
