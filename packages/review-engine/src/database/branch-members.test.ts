import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import * as scopes from '@orcaops/project-scope/history/database';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import * as store from '@orcaops/storage/history/database';

import { readDatabaseReviewBranchMembers } from './branch-members.js';
import { resolveDatabaseReviewForBranch } from './review-resolution.js';

vi.mock('@orcaops/project-scope/history/database', async (original) => ({
  ...(await original<typeof scopes>()),
}));

const Database = createRequire(new URL('../../../storage/package.json', import.meta.url))(
  'better-sqlite3'
) as new (file: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
};

interface FixtureEvent {
  artifact_id: string;
  event_id: string;
  ordinal: number;
  record_bytes: { blobHex: string };
  sidecar_payload_bytes: { blobHex: string } | null;
}

const roots: string[] = [];
const handles: store.ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureEvents() {
  const saved = JSON.parse(
    await readFile(
      new URL(
        '../../../storage/src/history/database/fixtures/artifact-events.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as { rows: { artifacts: { artifact_id: string }[]; artifact_events: FixtureEvent[] } };
  return saved.rows;
}

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'review-branch-members-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(store.projectDatabasePath(authority)), { recursive: true });
  const db = await store.initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(db);
  return {
    authority,
    db,
    request: {
      dataRoot: root.resolvedRoot,
      cwd: root.resolvedRoot,
      projectId: authority.projectId,
    },
  };
}

/** Append one retained fixture artifact's complete event stream. */
async function appendRetained(
  f: Awaited<ReturnType<typeof fixture>>,
  artifactId: string,
  events: FixtureEvent[]
) {
  const ordered = events
    .filter((event) => event.artifact_id === artifactId)
    .sort((a, b) => a.ordinal - b.ordinal);
  const handle = await store.openProjectDatabase({ authority: f.authority, mode: 'writer' });
  try {
    return (
      await store.appendProjectArtifactEvents(handle, {
        operationId: uuidv7(),
        artifactId,
        expectedRevision: null,
        eventBytes: Buffer.concat(
          ordered.map((event) => Buffer.from(event.record_bytes.blobHex, 'hex'))
        ),
        sidecarPayloads: ordered
          .filter((event) => event.sidecar_payload_bytes !== null)
          .map((event) => ({
            eventId: event.event_id,
            bytes: Buffer.from(event.sidecar_payload_bytes!.blobHex, 'hex'),
          })),
        secretAllow: [],
      })
    ).value.revision;
  } finally {
    handle.close();
  }
}

/**
 * Mint a further plan-captured artifact on a chosen branch from the retained
 * fixture plan, so a branch can carry more than one member.
 */
async function appendPlanOn(
  f: Awaited<ReturnType<typeof fixture>>,
  source: FixtureEvent,
  artifactId: string,
  branch: string
) {
  const payload = JSON.parse(
    Buffer.from(source.sidecar_payload_bytes!.blobHex, 'hex').toString('utf8')
  ) as Record<string, unknown> & { plan_steps: { step_id: string }[] };
  const sidecar = Buffer.from(
    JSON.stringify({
      ...payload,
      artifact_id: artifactId,
      branch,
      plan_steps: payload.plan_steps.map((step) => ({ ...step, step_id: uuidv7() })),
    })
  );
  const record = {
    event_id: uuidv7(),
    type: 'plan_captured',
    ts: '2026-06-01T00:01:00.000Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    sidecar_sha256: createHash('sha256').update(sidecar).digest('hex'),
    sidecar_size: sidecar.length,
  };
  const checksum = createHash('sha256').update(canonicalJson(record)).digest('hex');
  const handle = await store.openProjectDatabase({ authority: f.authority, mode: 'writer' });
  try {
    return (
      await store.appendProjectArtifactEvents(handle, {
        operationId: uuidv7(),
        artifactId,
        expectedRevision: null,
        eventBytes: Buffer.from(JSON.stringify({ ...record, checksum }) + '\n'),
        sidecarPayloads: [{ eventId: record.event_id, bytes: sidecar }],
        secretAllow: [],
      })
    ).value.revision;
  } finally {
    handle.close();
  }
}

it('selects only the branch artifacts at their exact retained revisions', async () => {
  const f = await fixture();
  const rows = await fixtureEvents();
  const [first, second] = rows.artifacts.map((artifact) => artifact.artifact_id);
  const mainRevision = await appendRetained(f, first!, rows.artifact_events);
  await appendRetained(f, second!, rows.artifact_events);
  const selected = await readDatabaseReviewBranchMembers({ ...f.request, branch: 'main' });
  expect(selected.projectId).toBe(f.authority.projectId);
  expect(selected.members).toEqual([
    {
      artifactId: first,
      generation: mainRevision.generation,
      orderedHash: mainRevision.orderedHash,
    },
  ]);
});

it('orders several branch members by artifact id and feeds the resolver unchanged', async () => {
  const f = await fixture();
  const rows = await fixtureEvents();
  const [first, second] = rows.artifacts.map((artifact) => artifact.artifact_id);
  await appendRetained(f, first!, rows.artifact_events);
  const plan = rows.artifact_events.find(
    (event) => event.artifact_id === second && event.ordinal === 1
  )!;
  // A later UUIDv7 sorts after the retained fixture ids, so a query order that
  // is not artifact-id ascending would show up here.
  const later = uuidv7();
  await appendPlanOn(f, plan, later, 'main');
  const selected = await readDatabaseReviewBranchMembers({ ...f.request, branch: 'main' });
  expect(selected.members.map((member) => member.artifactId)).toEqual([first, later]);
  const again = await readDatabaseReviewBranchMembers({ ...f.request, branch: 'main' });
  expect(again.members).toEqual(selected.members);
  const resolved = await resolveDatabaseReviewForBranch({
    authority: selected.authority,
    operationId: uuidv7(),
    branch: 'main',
    members: selected.members,
    initialContext: { worktreeId: null, baseSha: null, headSha: null },
    secretAllow: [],
  });
  expect(resolved.outcome).toBe('created');
  const database = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  try {
    expect(
      database.read((view) =>
        view.all<{ artifact_id: string }>(
          'SELECT artifact_id FROM review_members ORDER BY artifact_id'
        )
      ).value
    ).toEqual([{ artifact_id: first }, { artifact_id: later }]);
  } finally {
    database.close();
  }
});

it('returns an empty membership for a branch with no retained artifacts', async () => {
  const f = await fixture();
  const rows = await fixtureEvents();
  await appendRetained(f, rows.artifacts[0]!.artifact_id, rows.artifact_events);
  const selected = await readDatabaseReviewBranchMembers({
    ...f.request,
    branch: 'never-captured',
  });
  expect(selected.members).toEqual([]);
});

it('refuses an incomplete project scope instead of a narrower member set', async () => {
  const f = await fixture();
  const rows = await fixtureEvents();
  await appendRetained(f, rows.artifacts[0]!.artifact_id, rows.artifact_events);
  const close = vi.fn();
  vi.spyOn(scopes, 'resolveDatabaseHistoryScope').mockResolvedValue({
    kind: 'project',
    projects: [],
    branch: { source: 'git', value: 'main' },
    completeness: {
      complete: false,
      issues: [
        {
          code: 'HISTORY_INACCESSIBLE',
          project_id: f.authority.projectId,
          message: 'Selected project history is unavailable',
        },
      ],
    },
    close,
  } as unknown as scopes.DatabaseHistoryScope);
  await expect(
    readDatabaseReviewBranchMembers({ ...f.request, branch: 'main' })
  ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
  expect(close).toHaveBeenCalled();
});

it('refuses retained artifact metadata it cannot decode', async () => {
  const f = await fixture();
  const rows = await fixtureEvents();
  const artifactId = rows.artifacts[0]!.artifact_id;
  const revision = await appendRetained(f, artifactId, rows.artifact_events);
  for (const db of handles.splice(0)) db.close();
  const raw = new Database(store.projectDatabasePath(f.authority));
  try {
    raw.exec('PRAGMA foreign_keys=OFF');
    const triggers = raw
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name = 'artifact_revisions'"
      )
      .all() as { name: string; sql: string }[];
    for (const trigger of triggers) raw.exec(`DROP TRIGGER "${trigger.name}"`);
    raw
      .prepare('UPDATE artifact_revisions SET ordered_hash = ? WHERE artifact_id = ?')
      .run('not-a-retained-digest', artifactId);
    for (const trigger of triggers) raw.exec(trigger.sql);
  } finally {
    raw.close();
  }
  await expect(
    readDatabaseReviewBranchMembers({ ...f.request, branch: 'main' })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(revision.generation).toBe(1);
});
