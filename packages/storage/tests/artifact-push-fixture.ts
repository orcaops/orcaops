import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ProjectArtifactPushInput } from '../src/history/database/artifact-push-input.js';
import { appendProjectArtifactEvents } from '../src/history/database/artifacts.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from '../src/history/database/connection.js';
import { appendProjectUsageEvents, readProjectUsage } from '../src/history/database/usage.js';
import { recordChecksum } from '../src/history/event-integrity.js';
import { normalizeHistoryRoot } from '../src/history/paths.js';
import { uuidv7 } from '../src/ids/uuidv7.js';
import { deriveUsageLedgerRecord } from '../src/usage/record.js';

export const pushTarget = {
  server_url: 'https://example.test',
  org_id: 'org',
  account_id: 'account',
};
export const pushOptions = { secretAllow: [] as string[] };
export async function artifactPushFixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'artifact-push-')),
  });
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const file = projectDatabasePath(authority);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-01T00:00:00Z',
    authorize() {},
  });
  const handles: ProjectDatabase[] = [handle],
    db = new Database(file);
  db.pragma('foreign_keys=ON');
  async function artifact() {
    const artifactId = uuidv7();
    const payload = {
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'main',
      base_sha: 'original base',
      agent: 'codex',
      agent_session_id: null,
      task: 'Retain original grouped push',
      label: 'Grouped push',
      plan_steps: [
        {
          step_id: uuidv7(),
          text: 'Retain original wire calls',
          label: 'Original calls',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: '2026-09-01T00:00:00Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    };
    const event = {
      event_id: uuidv7(),
      type: 'plan_captured',
      ts: '2026-09-01T00:00:00Z',
      schema_version: 1,
      idempotency_key: uuidv7(),
      payload,
    };
    const result = await appendProjectArtifactEvents(handle, {
      operationId: uuidv7(),
      artifactId,
      expectedRevision: null,
      eventBytes: Buffer.from(JSON.stringify({ ...event, checksum: recordChecksum(event) }) + '\n'),
      sidecarPayloads: [],
      secretAllow: [],
    });
    return { artifactId, revision: result.value.revision };
  }
  const initial = await artifact();
  function input(): ProjectArtifactPushInput {
    return {
      pushId: uuidv7(),
      operationId: uuidv7(),
      terminalOperationId: uuidv7(),
      artifactId: initial.artifactId,
      target: structuredClone(pushTarget),
      artifactRevision: initial.revision,
      usageRevision: null,
      artifactPayloadHash: 'a'.repeat(64),
      expectedPushSelection: null,
      expectedCloudSelection: null,
      session: null,
      cloudAcknowledgementId: uuidv7(),
      preparedAt: '2026-09-01T00:00:01Z',
      result: { checkpoints: 0, summary: false, evaluators: 0, sourcePlanPinned: null },
      calls: [
        {
          requestId: uuidv7(),
          method: 'captureThread.start',
          targetExternalId: initial.artifactId,
          payloadBytes: Buffer.from(
            JSON.stringify({ externalId: initial.artifactId }, null, 3) + '\n'
          ),
        },
        {
          requestId: uuidv7(),
          method: 'captureThread.attachPlan',
          targetExternalId: initial.artifactId,
          payloadBytes: Buffer.from(
            JSON.stringify({ artifact_id: initial.artifactId }, null, 3) + '\n'
          ),
        },
      ],
    };
  }
  async function usage(artifactId = initial.artifactId) {
    const counters = {
      input_tokens: 12,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const payload = {
      snapshot_id: uuidv7(),
      idempotency_key: uuidv7(),
      agent: 'codex' as const,
      session_id: 'original session',
      artifact_id: artifactId,
      source_plan_ref_id: null,
      lifecycle_event: 'checkpoint_close' as const,
      checkpoint_n: 1,
      cumulative_usage: counters,
      delta_usage: null,
      baseline_kind: 'first_observation' as const,
      model_breakdown: [{ model: 'original model', cumulative: counters, delta: null }],
      record_count: 1,
      as_of: '2026-09-01T00:00:00Z',
    };
    const { record } = deriveUsageLedgerRecord({
      type: 'agent_usage_snapshot_recorded',
      ts: payload.as_of,
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
  return {
    handle,
    db,
    authority,
    artifactId: initial.artifactId,
    input,
    artifact,
    usage,
    async open(mode: 'reader' | 'writer' = 'writer') {
      const value = await openProjectDatabase({ authority, mode });
      handles.push(value);
      return value;
    },
    async close() {
      db.close();
      handles.forEach((value) => value.close());
      await rm(root.resolvedRoot, { recursive: true, force: true });
    },
  };
}
export function corruptPushFixture(db: Database.Database, change: () => void) {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as {
    name: string;
    sql: string;
  }[];
  db.pragma('foreign_keys=OFF');
  try {
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
    change();
  } finally {
    for (const trigger of triggers) db.exec(trigger.sql);
    db.pragma('foreign_keys=ON');
  }
}
export function artifactPushRows(handle: ProjectDatabase) {
  return handle.read((view) => ({
    headers: view.all('SELECT * FROM artifact_push_requests ORDER BY push_id'),
    current: view.all('SELECT * FROM artifact_push_current'),
    calls: view.all(
      'SELECT request_id,operation_id,owner_kind,push_id,call_ordinal,hex(payload_bytes) AS bytes,payload_sha256,request_key FROM remote_requests ORDER BY request_id'
    ),
    remote: view.all('SELECT * FROM remote_current ORDER BY request_id'),
    receipts: view.all('SELECT * FROM operations ORDER BY operation_id'),
  }));
}
