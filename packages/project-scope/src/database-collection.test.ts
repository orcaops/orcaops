import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { canonicalJson, uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  appendProjectArtifactEvents,
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { resolveDatabaseHistoryArtifact } from './database-artifact.js';
import { collectDatabaseHistory, hydrateDatabaseHistorySelection } from './database-collection.js';
import { type DatabaseHistoryScope, resolveDatabaseHistoryScope } from './database-scope.js';

const roots: string[] = [];
const scopes: DatabaseHistoryScope[] = [];
const writers: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  scopes.splice(0).forEach((scope) => scope.close());
  writers.splice(0).forEach((writer) => writer.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const saved = JSON.parse(
  await readFile(
    new URL('../../storage/src/history/database/fixtures/artifact-history.json', import.meta.url),
    'utf8'
  )
) as {
  rows: { artifact_events: Array<{ artifact_id: string; record_bytes: { blobHex: string } }> };
};
const plans = saved.rows.artifact_events.filter(
  (row) =>
    JSON.parse(Buffer.from(row.record_bytes.blobHex, 'hex').toString()).type === 'plan_captured'
);
async function fixture(count = 2, dates?: string[][]) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'database-collection-')));
  roots.push(cwd);
  const root = await normalizeHistoryRoot({ root: path.join(cwd, 'history') });
  const projects = [];
  for (let i = 0; i < count; i++) {
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
    writers.push(writer);
    for (const [index, row] of plans.entries()) {
      let bytes = Buffer.from(row.record_bytes.blobHex, 'hex');
      if (dates) {
        const { checksum: _checksum, ...record } = JSON.parse(bytes.toString());
        record.payload.started_at = dates[i][index];
        const checksum = createHash('sha256').update(canonicalJson(record)).digest('hex');
        bytes = Buffer.from(JSON.stringify({ ...record, checksum }) + '\n');
      }
      await appendProjectArtifactEvents(writer, {
        operationId: uuidv7(),
        artifactId: row.artifact_id,
        expectedRevision: null,
        eventBytes: bytes,
        sidecarPayloads: [],
        secretAllow: [],
      });
    }
    projects.push({ authority, writer });
  }
  const scope = await resolveDatabaseHistoryScope({
    cwd,
    root: root.resolvedRoot,
    selector: { scope: 'all-projects' },
  });
  scopes.push(scope);
  return { scope, projects };
}
it('merges project SQL pages by final time and binary identities before the global offset', async () => {
  const { scope } = await fixture();
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const prepare = Database.prototype.prepare;
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const statement = prepare.call(this, sql);
    if (sql.includes('AS artifactId')) {
      const all = statement.all.bind(statement);
      statement.all = (...args: unknown[]) => {
        calls.push({ sql, args });
        return Reflect.apply(all, statement, args);
      };
    }
    return statement;
  });
  const result = collectDatabaseHistory(scope, { offset: 1, limit: 2 }, 'versions');
  spy.mockRestore();
  const ordered = scope.projects.flatMap((project) =>
    plans.map((plan) => [project.projectId, plan.artifact_id])
  );
  ordered.sort((a, b) => (a.join('/') < b.join('/') ? -1 : 1));
  expect(result.entries.map((entry) => [entry.projectId, entry.row.artifactId])).toEqual(
    ordered.slice(1, 3)
  );
  expect(result.counts).toEqual({ captured: 4, imported: 0 });
  expect(result.hasMore).toBe(true);
  expect(result.sources).toHaveLength(2);
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.sql).toContain('COLLATE BINARY ASC LIMIT ? OFFSET ?');
    expect(call.args.slice(-2)).toEqual([3, 0]);
  }
  expect(
    result.entries.every((entry) => entry.row.watchJson === null && entry.row.detailsJson === null)
  ).toBe(true);
  expect(collectDatabaseHistory(scope, { offset: 3, limit: 1 }).hasMore).toBe(false);
});
it('applies branch and date filters before counting and merging projects', async () => {
  const { scope } = await fixture();
  scope.branch = { source: 'explicit', value: 'retention' };
  const result = collectDatabaseHistory(scope, {
    since: '2026-06-01',
    until: '2026-06-01',
    limit: 1,
  });
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].row.branch).toBe('retention');
  expect(result.counts).toEqual({ captured: 2, imported: 0 });
  expect(result.hasMore).toBe(true);
  expect(collectDatabaseHistory(scope, { since: '2026-06-02' }).counts).toEqual({
    captured: 0,
    imported: 0,
  });
});
it('keeps available rows while refusing complete counts for a failed project', async () => {
  const { scope } = await fixture();
  scope.projects[0].database!.close();
  const result = collectDatabaseHistory(scope);
  expect(result.entries).toHaveLength(2);
  expect(result.availableCounts).toEqual({ captured: 2, imported: 0 });
  expect(result.counts).toEqual({ captured: null, imported: null });
  expect(result.completeness.complete).toBe(false);
  expect(result.completeness.issues[0].project_id).toBe(scope.projects[0].projectId);
  expect(result.hasMore).toBeNull();
});
it('never widens an unavailable current branch to all history', async () => {
  const { scope } = await fixture();
  scope.branch = { source: 'unavailable', value: null };
  const result = collectDatabaseHistory(scope);
  expect(result.entries).toEqual([]);
  expect(result.sources).toEqual([]);
  expect(result.completeness.issues[0].code).toBe('BRANCH_SELECTION_UNAVAILABLE');
  expect(result.counts.captured).toBeNull();
});
it('reports unknown worktree membership only among otherwise matching artifacts', async () => {
  const { scope } = await fixture(1);
  scope.kind = 'worktree';
  scope.gitContext = { worktreeId: uuidv7() } as NonNullable<DatabaseHistoryScope['gitContext']>;
  const result = collectDatabaseHistory(scope);
  expect(result.entries).toEqual([]);
  expect(result.completeness.issues).toContainEqual(
    expect.objectContaining({ code: 'UNKNOWN_WORKTREE_ASSOCIATION', count: 2 })
  );
  scope.branch = { source: 'explicit', value: 'absent' };
  expect(collectDatabaseHistory(scope).completeness.complete).toBe(true);
});
it('hydrates only the selected original revision after a later artifact publication', async () => {
  const { scope, projects } = await fixture();
  const selected = collectDatabaseHistory(scope, { limit: 1 });
  const entry = selected.entries[0];
  const project = projects.find((p) => p.authority.projectId === entry.projectId)!;
  const before = readProjectArtifact(project.writer, entry.row.artifactId)!;
  const later = saved.rows.artifact_events.filter(
    (row) => row.artifact_id === entry.row.artifactId && !plans.includes(row)
  );
  expect(later.length).toBeGreaterThan(0);
  await appendProjectArtifactEvents(project.writer, {
    operationId: uuidv7(),
    artifactId: entry.row.artifactId,
    expectedRevision: before.revision,
    eventBytes: Buffer.concat(later.map((row) => Buffer.from(row.record_bytes.blobHex, 'hex'))),
    sidecarPayloads: [],
    secretAllow: [],
  });
  const result = hydrateDatabaseHistorySelection(scope, selected.entries);
  expect(result).toHaveLength(1);
  expect(result[0].artifact!.revision).toEqual(before.revision);
  expect(result[0].artifact!.thread).toEqual(before.thread);
  expect(result[0].execution).toBeNull();
  expect(
    readProjectArtifact(project.writer, entry.row.artifactId)!.revision.generation
  ).toBeGreaterThan(before.revision.generation);
  const refreshed = collectDatabaseHistory(scope, { limit: 1 });
  expect(
    refreshed.sources.find((s) => s.projectId === entry.projectId)!.counters.writeSequence
  ).toBeGreaterThan(
    selected.sources.find((s) => s.projectId === entry.projectId)!.counters.writeSequence
  );
});
it('does not relabel another project or hydrate a selection against a different store', async () => {
  const { scope } = await fixture();
  const selected = collectDatabaseHistory(scope, { limit: 1 });
  selected.entries[0].storeInstanceId = uuidv7();
  expect(() => hydrateDatabaseHistorySelection(scope, selected.entries)).toThrow(
    expect.objectContaining({ code: 'AUTHORITY_MISMATCH' })
  );
  scope.projects[0].projectId = uuidv7();
  expect(collectDatabaseHistory(scope).completeness.issues).toContainEqual(
    expect.objectContaining({ code: 'AUTHORITY_MISMATCH' })
  );
});
it.each([
  null,
  [],
  { touching: 1 },
  { since: {} },
  { offset: Number.MAX_SAFE_INTEGER, limit: 1 },
  { limit: 0 },
])('rejects invalid filters before project reads: %j', async (input) => {
  const { scope } = await fixture(0);
  expect(() => collectDatabaseHistory(scope, input as never)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
});

it('merges parsed instants across projects before taking the requested page', async () => {
  const { scope } = await fixture(2, [
    ['2026-06-01T02:00:00Z', '2026-06-01T00:00:00Z'],
    ['2026-06-01T01:00:00Z', '2026-06-01T03:00:00Z'],
  ]);
  const result = collectDatabaseHistory(scope, { offset: 1, limit: 3 });
  expect(result.entries.map((entry) => entry.row.startedAt)).toEqual([
    '2026-06-01T02:00:00Z',
    '2026-06-01T01:00:00Z',
    '2026-06-01T00:00:00Z',
  ]);
  expect(result.hasMore).toBe(false);
});

it('places unknown query timestamps after dated results across projects', async () => {
  const { scope, projects } = await fixture();
  const database = new Database(projectDatabasePath(projects[0].authority));
  try {
    database.prepare('UPDATE artifact_metadata SET started_at=?').run('unknown');
  } finally {
    database.close();
  }
  const result = collectDatabaseHistory(scope);
  expect(result.entries.map((entry) => entry.row.startedMs === null)).toEqual([
    false,
    false,
    true,
    true,
  ]);
});

it('discloses a known project whose reader is no longer available', async () => {
  const { scope } = await fixture(1);
  scope.projects[0].database = null;
  const result = collectDatabaseHistory(scope);
  expect(result.completeness.complete).toBe(false);
  expect(result.completeness.issues).toContainEqual(
    expect.objectContaining({
      code: 'HISTORY_INACCESSIBLE',
      project_id: scope.projects[0].projectId,
    })
  );
  expect(result.counts).toEqual({ captured: null, imported: null });
  expect(result.hasMore).toBeNull();
});
it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])(
  'requires an explicit selected execution version before reading: %j',
  async (version) => {
    const { scope } = await fixture(1);
    const selected = collectDatabaseHistory(scope, { limit: 1 }).entries;
    Object.assign(selected[0].row, { executionVersion: version });
    const spy = vi.spyOn(Database.prototype, 'prepare');
    expect(() => hydrateDatabaseHistorySelection(scope, selected)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
    expect(spy).not.toHaveBeenCalled();
  }
);
it('classifies noncopyable selected input without opening a read transaction', async () => {
  const { scope } = await fixture(1);
  const selected = collectDatabaseHistory(scope, { limit: 1 }).entries;
  Object.assign(selected[0], { extra() {} });
  const spy = vi.spyOn(Database.prototype, 'prepare');
  expect(() => hydrateDatabaseHistorySelection(scope, selected)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(spy).not.toHaveBeenCalled();
});

it('resolves exact project history independently of unavailable branch context', async () => {
  const { scope } = await fixture(1);
  scope.kind = 'project';
  scope.branch = { value: null, source: 'unavailable' };
  const result = resolveDatabaseHistoryArtifact(scope, plans[0].artifact_id);
  expect(result.projectId).toBe(scope.projects[0].projectId);
  expect(result.artifactId).toBe(plans[0].artifact_id);
  expect(result.artifact.thread.plan?.artifact_id).toBe(plans[0].artifact_id);
  expect(result.authority).toEqual(scope.projects[0].authority);
  expect(result.authority).not.toBe(scope.projects[0].authority);
  expect(result.followup).toBe(
    `orcaops show ${plans[0].artifact_id} --project ${scope.projects[0].projectId}`
  );
});

it('requires one explicit project and discloses qualified prefix candidates', async () => {
  const { scope } = await fixture(1);
  expect(() => resolveDatabaseHistoryArtifact(scope, plans[0].artifact_id)).toThrow(
    expect.objectContaining({ code: 'PROJECT_REQUIRED' })
  );
  scope.kind = 'project';
  expect(() => resolveDatabaseHistoryArtifact(scope, '0')).toThrow(
    expect.objectContaining({
      code: 'AMBIGUOUS_ARTIFACT',
      context: {
        candidates: plans
          .map((plan) => plan.artifact_id)
          .sort()
          .map((artifactId) => ({
            project_id: scope.projects[0].projectId,
            artifact_id: artifactId,
            command: `orcaops show ${artifactId} --project ${scope.projects[0].projectId}`,
          })),
        truncated: false,
      },
    })
  );
  expect(() => resolveDatabaseHistoryArtifact(scope, uuidv7())).toThrow(
    expect.objectContaining({ code: 'UNKNOWN_ARTIFACT' })
  );
});

it.each(['repositoryInstanceId', 'rootKey', 'resolvedRoot'] as const)(
  'refuses unavailable or mismatched exact project %s before SQL',
  async (key) => {
    const { scope } = await fixture(1);
    scope.kind = 'project';
    const project = scope.projects[0];
    const authority = project.authority!;
    project.authority = { ...authority, [key]: uuidv7() };
    const prepare = vi.spyOn(Database.prototype, 'prepare');
    expect(() => resolveDatabaseHistoryArtifact(scope, plans[0].artifact_id)).toThrow(
      expect.objectContaining({ code: 'AUTHORITY_MISMATCH' })
    );
    expect(prepare).not.toHaveBeenCalled();
    project.authority = authority;
    const database = project.database;
    project.database = null;
    expect(() => resolveDatabaseHistoryArtifact(scope, plans[0].artifact_id)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INACCESSIBLE' })
    );
    expect(prepare).not.toHaveBeenCalled();
    project.database = database;
  }
);
