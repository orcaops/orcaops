import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { resolveProjectArtifactOverview } from './artifact-overview.js';
import * as artifacts from './artifacts.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { prepareArtifactDraft } from '../../artifacts/draft-preparation.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';

vi.mock('./artifacts.js', async (original) => ({
  ...(await original<typeof artifacts>()),
}));
const roots: string[] = [],
  handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'artifact-overview-control-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const writer = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(writer);
  const saved = JSON.parse(
    await readFile(new URL('./fixtures/artifact-history.json', import.meta.url), 'utf8')
  );
  const row = saved.rows.artifact_events[0];
  await artifacts.appendProjectArtifactEvents(writer, {
    operationId: uuidv7(),
    artifactId: row.artifact_id,
    expectedRevision: null,
    eventBytes: Buffer.from(row.record_bytes.blobHex, 'hex'),
    sidecarPayloads: [],
    secretAllow: [],
  });
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  return { authority, writer, reader, artifactId: row.artifact_id as string, saved };
}
async function addClosedFiles(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const prior = artifacts.readProjectArtifact(f.writer, id)!;
  const draft = await prepareArtifactDraft(
    {
      artifactId: id,
      priorEvents: prior.thread.events,
      authoredPayload: 'shared.ts',
      secretAllow: [],
      idempotencyBlocks: [],
    },
    async (semantics) => {
      const plan = await semantics.readPlan(id);
      const opened = await semantics.writeCheckpointOpened(
        { artifact_id: id, declared_step_ids: [plan!.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha: plan!.base_sha }
      );
      if (!('checkpoint' in opened)) throw new Error('Expected checkpoint');
      await semantics.writeCheckpointClosed(
        {
          artifact_id: id,
          n: opened.checkpoint.n,
          head_sha: plan!.base_sha,
          summary: 'Retained shared file',
          files_changed: ['shared.ts'],
          completed_step_ids: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [],
        },
        { idempotencyKey: uuidv7() }
      );
    }
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  await artifacts.appendProjectArtifactEvents(f.writer, {
    operationId: uuidv7(),
    artifactId: id,
    expectedRevision: prior.revision,
    eventBytes: Buffer.concat(draft.events.map((e) => e.eventBytes)),
    sidecarPayloads: draft.events.flatMap((e) =>
      e.sidecar ? [{ eventId: e.record.event_id, bytes: e.sidecar.bytes }] : []
    ),
    secretAllow: [],
  });
}
async function relatedFixture() {
  const f = await fixture();
  const row = f.saved.rows.artifact_events.find(
    (r: { artifact_id: string; record_bytes: { blobHex: string } }) =>
      r.artifact_id !== f.artifactId
  );
  const event = JSON.parse(Buffer.from(row.record_bytes.blobHex, 'hex').toString());
  const existing = artifacts.readProjectArtifact(f.writer, f.artifactId)!;
  event.payload.branch = existing.thread.plan!.branch;
  event.payload.started_at = '2026-05-31T00:00:00.000Z';
  // This is a fresh authored plan with retained valid producer fields, not conversion proof.
  const draft = await prepareArtifactDraft(
    {
      artifactId: row.artifact_id,
      priorEvents: [],
      authoredPayload: event.payload,
      secretAllow: [],
      idempotencyBlocks: [],
    },
    (s) => s.writePlan(event.payload, { idempotencyKey: uuidv7() })
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  await artifacts.appendProjectArtifactEvents(f.writer, {
    operationId: uuidv7(),
    artifactId: row.artifact_id,
    expectedRevision: null,
    eventBytes: Buffer.concat(draft.events.map((e) => e.eventBytes)),
    sidecarPayloads: [],
    secretAllow: [],
  });
  await addClosedFiles(f, f.artifactId);
  await addClosedFiles(f, row.artifact_id);
  return { ...f, original: row.artifact_id as string, later: f.artifactId };
}
it('selects related evidence from the same snapshot before a concurrent metadata change', async () => {
  const f = await relatedFixture();
  const before = f.reader.read(() => null).counters;
  const select = artifacts.selectProjectArtifactRecords;
  let changed = false;
  vi.spyOn(artifacts, 'selectProjectArtifactRecords').mockImplementation((view, ...args) => {
    const selected = select(view, ...args);
    if (!changed) {
      changed = true;
      const db = new Database(projectDatabasePath(f.authority));
      try {
        db.prepare('UPDATE artifact_metadata SET started_at=? WHERE artifact_id=?').run(
          '2000-01-01T00:00:00.000Z',
          f.later
        );
      } finally {
        db.close();
      }
    }
    return selected;
  });
  const result = resolveProjectArtifactOverview(f.reader, f.original);
  expect(result.kind).toBe('resolved');
  if (result.kind !== 'resolved') throw new Error('Expected artifact');
  expect(changed).toBe(true);
  expect(result.repoEvidence).toMatchObject({
    state: 'available',
    laterArtifact: { artifact_id: f.later, files: ['shared.ts'] },
  });
  expect(result.counters).toEqual(before);
  const next = resolveProjectArtifactOverview(f.reader, f.original);
  expect(next.kind === 'resolved' && next.repoEvidence).toEqual({
    state: 'available',
    laterArtifact: null,
  });
});
it('does not decode the selected sibling narrative and discloses missing optional metadata', async () => {
  const f = await relatedFixture();
  const hydrate = vi.spyOn(artifacts, 'hydrateProjectArtifactRecords');
  const first = resolveProjectArtifactOverview(f.reader, f.original);
  expect(first.kind === 'resolved' && first.repoEvidence).toMatchObject({
    state: 'available',
    laterArtifact: { artifact_id: f.later },
  });
  expect(hydrate).toHaveBeenCalledTimes(1);
  const db = new Database(projectDatabasePath(f.authority));
  try {
    db.prepare('DELETE FROM artifact_query_metadata WHERE artifact_id=?').run(f.later);
  } finally {
    db.close();
  }
  const next = resolveProjectArtifactOverview(f.reader, f.original);
  expect(next.kind === 'resolved' && next.repoEvidence).toMatchObject({
    state: 'unavailable',
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  expect(artifacts.readProjectArtifact(f.reader, f.original)).not.toBeNull();
});
it('discloses malformed selected metadata rather than asserting no later artifact', async () => {
  const f = await relatedFixture();
  const db = new Database(projectDatabasePath(f.authority));
  try {
    db.prepare('UPDATE artifact_metadata SET started_at=? WHERE artifact_id=?').run(
      'not-a-timestamp',
      f.later
    );
  } finally {
    db.close();
  }
  const result = resolveProjectArtifactOverview(f.reader, f.original);
  expect(result.kind === 'resolved' && result.repoEvidence).toMatchObject({
    state: 'unavailable',
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
});

it('discloses an invalid original timestamp before comparing related artifacts', async () => {
  const f = await relatedFixture();
  const db = new Database(projectDatabasePath(f.authority));
  try {
    db.prepare('UPDATE artifact_metadata SET started_at=? WHERE artifact_id=?').run(
      'invalid',
      f.original
    );
  } finally {
    db.close();
  }
  const result = resolveProjectArtifactOverview(f.reader, f.original);
  expect(result.kind === 'resolved' && result.repoEvidence).toMatchObject({
    state: 'unavailable',
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
});
it('does not treat equivalent timestamp precision as a later artifact', async () => {
  const f = await relatedFixture();
  const db = new Database(projectDatabasePath(f.authority));
  try {
    const update = db.prepare('UPDATE artifact_metadata SET started_at=? WHERE artifact_id=?');
    update.run('2026-06-01T00:00:00.000Z', f.original);
    update.run('2026-06-01T00:00:00Z', f.later);
  } finally {
    db.close();
  }
  const result = resolveProjectArtifactOverview(f.reader, f.original);
  expect(result.kind === 'resolved' && result.repoEvidence).toEqual({
    state: 'available',
    laterArtifact: null,
  });
});
