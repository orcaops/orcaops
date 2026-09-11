import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest, recordChecksum } from '../event-integrity.js';
import * as provenance from '../metadata-provenance.js';
import { normalizeHistoryRoot } from '../paths.js';
import { type ArtifactSourceTimeMember, prepareSourceCommitTime } from '../source-time.js';
import {
  appendProjectArtifactEvents,
  prepareArtifactAppend,
  prepareArtifactAppendRequest,
  readProjectArtifact,
} from './artifacts.js';
import {
  type AuthoredSourceTimeInput,
  prepareAuthoredSourceTime,
} from './capture-operation-input.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { publishProjectSourceTime } from './source-time-publication.js';
import { readProjectSourceTime, readProjectSourceTimeSource } from './source-time-records.js';
import { runProjectOperation } from './transactions.js';
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const refusal = { secretAllow: [] };
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((h) => h.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'source-chronology-')),
  });
  roots.push(root.resolvedRoot);
  const git = path.join(root.resolvedRoot, 'git');
  await mkdir(git);
  execFileSync('git', ['init', '-q', git]);
  const tree = execFileSync('git', ['-C', git, 'mktree'], { input: '' }).toString().trim();
  const objects = [1234567890, 1234567990]
    .map((time) => {
      const bytes = Buffer.from(
        'tree ' +
          tree +
          '\nauthor A <a@example.test> ' +
          time +
          ' +0000\ncommitter B <b@example.test> ' +
          time +
          ' -0800\n\nOriginal message\n'
      );
      const commitOid = execFileSync(
        'git',
        ['-C', git, 'hash-object', '-t', 'commit', '-w', '--stdin'],
        { input: bytes }
      )
        .toString()
        .trim();
      const commitBytes = execFileSync('git', [
        '--no-replace-objects',
        '-C',
        git,
        'cat-file',
        'commit',
        commitOid,
      ]);
      return { commitOid, commitBytes };
    })
    .sort((a, b) => a.commitOid.localeCompare(b.commitOid));
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
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(handle);
  const artifactId = uuidv7();
  const old = JSON.parse(
    await readFile(new URL('./fixtures/execution-history.json', import.meta.url), 'utf8')
  );
  const { checksum: _checksum, ...record } = JSON.parse(
    Buffer.from(old.rows.artifact_events[0].record_bytes.blobHex, 'hex').toString()
  );
  record.event_id = uuidv7();
  record.idempotency_key = uuidv7();
  record.payload.artifact_id = artifactId;
  record.payload.origin = {
    kind: 'git-import',
    imported_at: '2026-06-01T00:00:00.000Z',
    tool_version: 'original',
    source_range: 'original',
    authors: ['A'],
    enriched_at: null,
    member_shas: objects.map((o) => o.commitOid),
  };
  await appendProjectArtifactEvents(handle, {
    artifactId,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  });
  const member: ArtifactSourceTimeMember = {
    schema_version: 1,
    artifact_id: artifactId,
    member_commits: objects.map((o) => o.commitOid),
    sources: [record.event_id, 'digest'].sort().map((source_id) => ({
      schema_version: 1,
      artifact_id: artifactId,
      source_id,
      attributed_commits: objects.map((o) => o.commitOid),
      facts: objects.map((o) => prepareSourceCommitTime(o)),
    })),
  };
  const bytes = Buffer.from(' ' + JSON.stringify(member) + '\n');
  const input: AuthoredSourceTimeInput = {
    artifactId,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    artifactRevision: readProjectArtifact(handle, artifactId)!.revision,
    expectedSelection: null,
    bytes,
    commitObjects: objects,
    source: {
      identity: 'original member',
      locator: 'source-time/original.json',
      revisionId: 'original-revision',
      eventId: null,
      operationId: null,
      sha256: digest(bytes),
    },
  };
  return { handle, file, artifactId, input, member, objects, git, record };
}
function changed(
  input: AuthoredSourceTimeInput,
  member: ArtifactSourceTimeMember
): AuthoredSourceTimeInput {
  const bytes = Buffer.from(' ' + JSON.stringify(member) + '\n');
  return {
    ...input,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    bytes,
    source: { ...input.source, sha256: digest(bytes) },
  };
}
function saved(handle: ProjectDatabase) {
  return handle.read((view) => ({
    records: view.all(
      'SELECT revision_id,hex(record_bytes) AS bytes FROM source_time_revisions ORDER BY revision_id'
    ),
    current: view.all('SELECT * FROM source_time_current'),
    sources: view.all('SELECT * FROM source_time_sources ORDER BY revision_id,source_id'),
    search: view.all('SELECT * FROM artifact_search_sources ORDER BY artifact_id,source_id'),
    state: view.all('SELECT * FROM artifact_search_state'),
    receipts: view.all('SELECT * FROM operations ORDER BY operation_id'),
  }));
}
function appendInput(f: Awaited<ReturnType<typeof fixture>>) {
  const next = {
    ...f.record,
    event_id: uuidv7(),
    idempotency_key: uuidv7(),
    type: 'plan_revised',
    payload: {
      ...f.record.payload,
      revision_n: 1,
      revised_at: '2026-06-02T00:00:00.000Z',
      rationale: 'Retain updated plan',
      prior_plan_event_id: f.record.event_id,
    },
  };
  return {
    artifactId: f.artifactId,
    operationId: uuidv7(),
    expectedRevision: readProjectArtifact(f.handle, f.artifactId)!.revision,
    eventBytes: Buffer.from(JSON.stringify({ ...next, checksum: recordChecksum(next) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  };
}
it('retains original Git bytes, identities and source times in one non-intent publication', async () => {
  const f = await fixture();
  const before = saved(f.handle).counters;
  const result = await publishProjectSourceTime(f.handle, f.input, refusal);
  const actual = readProjectSourceTime(f.handle, f.artifactId)!;
  expect(actual.bytes).toEqual(f.input.bytes);
  expect(actual.member).toEqual(f.member);
  expect(actual.source).toEqual(f.input.source);
  expect(actual.artifactGeneration).toBe(1);
  expect(result.counters.writeSequence).toBe(before.writeSequence + 1);
  expect(result.counters.intentChangeCounter).toBe(before.intentChangeCounter);
  const expected = f.member.sources[0]!.facts.map((fact) => fact.committer_time)
    .sort()
    .at(-1)!;
  expect(readProjectSourceTimeSource(f.handle, f.artifactId, 'digest')?.time.evidence_time).toBe(
    expected
  );
  expect(saved(f.handle).value.search.every((row: any) => row.evidence_time === expected)).toBe(
    true
  );
  const unchanged = saved(f.handle);
  expect(
    (await publishProjectSourceTime(f.handle, { ...f.input, commitObjects: [] }, refusal)).replayed
  ).toBe(true);
  expect(saved(f.handle)).toEqual(unchanged);
});
it('carries verified facts after Git objects disappear and requires raw objects for added facts', async () => {
  const f = await fixture();
  const partial = structuredClone(f.member);
  partial.sources.forEach((s) => (s.facts = s.facts.slice(0, 1)));
  const firstInput = { ...changed(f.input, partial), commitObjects: [f.objects[0]!] };
  const first = await publishProjectSourceTime(f.handle, firstInput, refusal);
  expect(readProjectSourceTimeSource(f.handle, f.artifactId, 'digest')!.time).toMatchObject({
    evidence_time: null,
    evidence_time_basis: 'unknown',
  });
  await rm(
    path.join(
      f.git,
      '.git',
      'objects',
      f.objects[0]!.commitOid.slice(0, 2),
      f.objects[0]!.commitOid.slice(2)
    )
  );
  const next = {
    ...changed(f.input, f.member),
    expectedSelection: first.value.selection,
    commitObjects: [f.objects[1]!],
  };
  expect(() => prepareAuthoredSourceTime(next, refusal)).toThrow('exact original Git object');
  await expect(
    publishProjectSourceTime(f.handle, { ...next, commitObjects: [] }, refusal)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await publishProjectSourceTime(f.handle, next, refusal);
  expect(readProjectSourceTime(f.handle, f.artifactId)!.member).toEqual(f.member);
  expect(
    (await publishProjectSourceTime(f.handle, { ...firstInput, commitObjects: [] }, refusal))
      .replayed
  ).toBe(true);
  expect(readProjectSourceTime(f.handle, f.artifactId, firstInput.revisionId)?.member).toEqual(
    partial
  );
});
it('refuses removed or changed prior attribution and facts without changing history', async () => {
  const f = await fixture();
  const first = await publishProjectSourceTime(f.handle, f.input, refusal);
  const before = saved(f.handle);
  for (const member of [
    { ...f.member, sources: f.member.sources.slice(1) },
    { ...f.member, sources: f.member.sources.map((s) => ({ ...s, facts: [] })) },
  ]) {
    await expect(
      publishProjectSourceTime(
        f.handle,
        {
          ...changed(f.input, member),
          expectedSelection: first.value.selection,
          commitObjects: [],
        },
        refusal
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(saved(f.handle)).toEqual(before);
});
it('refuses secrets and caller-authored retained proofs before consulting a handle', async () => {
  const f = await fixture();
  const fake = { read: vi.fn() } as unknown as ProjectDatabase;
  await expect(
    publishProjectSourceTime(
      fake,
      { ...f.input, source: { ...f.input.source, locator: 'ghp_' + 'a'.repeat(36) } },
      refusal
    )
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  await expect(
    publishProjectSourceTime(
      fake,
      { ...f.input, retainedMember: f.member } as AuthoredSourceTimeInput,
      refusal
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fake.read).not.toHaveBeenCalled();
});
it('keeps exact authoritative bytes readable when a derived source row is missing', async () => {
  const f = await fixture();
  await publishProjectSourceTime(f.handle, f.input, refusal);
  const db = new Database(f.file);
  db.prepare('DELETE FROM source_time_sources WHERE revision_id=? AND source_id=?').run(
    f.input.revisionId,
    'digest'
  );
  db.close();
  const before = saved(f.handle);
  expect(readProjectSourceTime(f.handle, f.artifactId)!.bytes).toEqual(f.input.bytes);
  expect(() => readProjectSourceTimeSource(f.handle, f.artifactId, f.record.event_id)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(saved(f.handle)).toEqual(before);
});
it('queries a selected source without decoding artifact events or the complete member', async () => {
  const f = await fixture();
  await publishProjectSourceTime(f.handle, f.input, refusal);
  const original = Database.prototype.prepare;
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (/artifact_events|hex\(r.record_bytes\)/u.test(sql))
      throw new Error('unexpected corpus read');
    return original.call(this, sql);
  });
  expect(
    readProjectSourceTimeSource(f.handle, f.artifactId, 'digest')!.time.evidence_time
  ).not.toBeNull();
  spy.mockRestore();
});
it('rolls back source facts, selection and search when its receipt fails, then retries its original identity', async () => {
  const f = await fixture();
  const before = saved(f.handle);
  const original = Database.prototype.prepare;
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.startsWith('INSERT INTO operations'))
      throw new Database.SqliteError('fixture full', 'SQLITE_FULL');
    return original.call(this, sql);
  });
  await expect(publishProjectSourceTime(f.handle, f.input, refusal)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'disk-full',
  });
  spy.mockRestore();
  expect(saved(f.handle)).toEqual(before);
  expect((await publishProjectSourceTime(f.handle, f.input, refusal)).replayed).toBe(false);
});
it('preserves retained source facts and search evidence time through a later artifact revision', async () => {
  const f = await fixture();
  await publishProjectSourceTime(f.handle, f.input, refusal);
  const original = readProjectSourceTime(f.handle, f.artifactId)!;
  const time = readProjectSourceTimeSource(f.handle, f.artifactId, 'digest')!.time.evidence_time;
  await appendProjectArtifactEvents(f.handle, appendInput(f));
  expect(readProjectSourceTime(f.handle, f.artifactId)!.bytes).toEqual(original.bytes);
  expect(readProjectSourceTime(f.handle, f.artifactId)!.artifactGeneration).toBe(1);
  expect(
    f.handle.read((view) =>
      view.get<{ evidence_time: string }>(
        'SELECT evidence_time FROM artifact_search_sources WHERE artifact_id=? AND source_id=?',
        f.artifactId,
        'digest'
      )
    ).value?.evidence_time
  ).toBe(time);
});
it('refuses a stale prepared chronology snapshot without publishing the artifact or retargeting it', async () => {
  const f = await fixture();
  const request = prepareArtifactAppendRequest(appendInput(f));
  const prepared = await prepareArtifactAppend(f.handle, request);
  await publishProjectSourceTime(f.handle, f.input, refusal);
  const before = saved(f.handle);
  await expect(
    runProjectOperation(f.handle, request.operation, (tx) => ({
      ...prepared.settle(tx),
      revision: { ...prepared.revision },
    }))
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(saved(f.handle)).toEqual(before);
  expect(readProjectArtifact(f.handle, f.artifactId)!.revision.generation).toBe(1);
});
it('rejects changed source content under an original operation and stale new artifact targets', async () => {
  const f = await fixture();
  await publishProjectSourceTime(f.handle, f.input, refusal);
  const before = saved(f.handle);
  await expect(
    publishProjectSourceTime(
      f.handle,
      { ...f.input, source: { ...f.input.source, locator: 'different' } },
      refusal
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(saved(f.handle)).toEqual(before);
  await appendProjectArtifactEvents(f.handle, appendInput(f));
  await expect(
    publishProjectSourceTime(
      f.handle,
      {
        ...changed(f.input, f.member),
        expectedSelection: readProjectSourceTime(f.handle, f.artifactId)!.selection,
      },
      refusal
    )
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

it.each([1, 2])(
  'refreshes chronology at most once when %s selections change during admission',
  async (changes) => {
    const f = await fixture();
    const other = await openProjectDatabase({ authority: f.handle.authority, mode: 'writer' });
    handles.push(other);
    const input = appendInput(f);
    const original = Database.prototype.exec;
    let nested = false;
    let starts = 0;
    const publications: Promise<unknown>[] = [];
    const spy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (sql === 'BEGIN IMMEDIATE' && !nested) {
        starts++;
        if (starts <= changes) {
          nested = true;
          const current = readProjectSourceTime(other, f.artifactId);
          publications.push(
            publishProjectSourceTime(
              other,
              {
                ...f.input,
                operationId: uuidv7(),
                revisionId: uuidv7(),
                expectedSelection: current?.selection ?? null,
              },
              refusal
            )
          );
          nested = false;
        }
      }
      return original.call(this, sql);
    });
    const result = appendProjectArtifactEvents(f.handle, input);
    if (changes === 1)
      await expect(result).resolves.toMatchObject({
        replayed: false,
        value: { revision: { generation: 2 } },
      });
    else await expect(result).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    spy.mockRestore();
    await Promise.all(publications);
    expect(starts).toBe(2);
    expect(readProjectArtifact(f.handle, f.artifactId)!.revision.generation).toBe(
      changes === 1 ? 2 : 1
    );
    const receipt = f.handle.read((view) =>
      view.get<{ payload_json: string }>(
        'SELECT payload_json FROM operations WHERE operation_id=?',
        input.operationId
      )
    ).value;
    if (changes === 1) {
      expect(receipt?.payload_json).toBe(
        JSON.stringify(prepareArtifactAppendRequest(input).operation.payload)
      );
      expect(
        readProjectSourceTimeSource(f.handle, f.artifactId, 'digest')?.time.evidence_time
      ).not.toBeNull();
    } else expect(receipt).toBeNull();
  }
);
it('does not refresh an authored artifact target when another append wins admission', async () => {
  const f = await fixture();
  const other = await openProjectDatabase({ authority: f.handle.authority, mode: 'writer' });
  handles.push(other);
  const input = appendInput(f);
  const competitor = appendInput(f);
  const original = provenance.historyProvenanceMetadata;
  let starts = 0;
  const exec = Database.prototype.exec;
  let competitorFinished = false;
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql === 'BEGIN IMMEDIATE' && competitorFinished) starts++;
    return exec.call(this, sql);
  });
  vi.spyOn(provenance, 'historyProvenanceMetadata').mockImplementationOnce(async (thread) => {
    await appendProjectArtifactEvents(other, competitor);
    competitorFinished = true;
    return original(thread);
  });
  await expect(appendProjectArtifactEvents(f.handle, input)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  vi.restoreAllMocks();
  expect(starts).toBe(1);
  expect(readProjectArtifact(f.handle, f.artifactId)!.revision.generation).toBe(2);
  expect(
    f.handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id=?', input.operationId)
    ).value
  ).toBeNull();
});
it('refuses foreign source IDs and incomplete plan attribution without inventing chronology', async () => {
  const f = await fixture();
  const before = saved(f.handle);
  const foreign = structuredClone(f.member);
  foreign.sources[0]!.source_id = uuidv7();
  foreign.sources.sort((a, b) => a.source_id.localeCompare(b.source_id));
  const partial = structuredClone(f.member);
  partial.sources.forEach((s) => {
    s.attributed_commits = s.attributed_commits.slice(0, 1);
    s.facts = s.facts.slice(0, 1);
  });
  for (const [member, objects] of [
    [foreign, f.objects],
    [partial, [f.objects[0]!]],
  ] as const)
    await expect(
      publishProjectSourceTime(
        f.handle,
        { ...changed(f.input, member), commitObjects: [...objects] },
        refusal
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(saved(f.handle)).toEqual(before);
});
it('refuses missing source selection rather than treating retained history as a fresh slot', async () => {
  const f = await fixture();
  await publishProjectSourceTime(f.handle, f.input, refusal);
  const db = new Database(f.file);
  const guard = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name='source_time_current_no_delete'")
    .get() as { sql: string };
  db.exec('DROP TRIGGER source_time_current_no_delete;DELETE FROM source_time_current');
  db.exec(guard.sql);
  db.close();
  const before = saved(f.handle);
  expect(() => readProjectSourceTime(f.handle, f.artifactId)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  await expect(
    publishProjectSourceTime(f.handle, changed(f.input, f.member), refusal)
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(saved(f.handle)).toEqual(before);
});

it('keeps authored bytes detached during admission and honors the original cancellation signal', async () => {
  const f = await fixture();
  const lock = new Database(f.file);
  lock.exec('BEGIN IMMEDIATE');
  const originalBytes = Buffer.from(f.input.bytes);
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    onWait: () => {
      f.input.bytes.fill(0);
      f.input.source.locator = 'changed';
      options.signal = new AbortController().signal;
      controller.abort();
    },
  };
  const before = saved(f.handle);
  await expect(publishProjectSourceTime(f.handle, f.input, refusal, options)).rejects.toMatchObject(
    { code: 'CANCELLED' }
  );
  lock.exec('ROLLBACK');
  lock.close();
  expect(saved(f.handle)).toEqual(before);
  const retry = {
    ...f.input,
    bytes: originalBytes,
    source: {
      ...f.input.source,
      locator: 'source-time/original.json',
      sha256: digest(originalBytes),
    },
  };
  await publishProjectSourceTime(f.handle, retry, refusal);
  expect(readProjectSourceTime(f.handle, f.artifactId)!.bytes).toEqual(originalBytes);
});
