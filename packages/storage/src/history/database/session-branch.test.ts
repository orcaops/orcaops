import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import * as branchCodec from './session-branch-codec.js';
import type { ProjectSessionBranchSelection } from './session-branch-input.js';
import * as branchInputs from './session-branch-input.js';
import {
  observeProjectSessionBranch,
  readProjectSessionBranch,
  type SessionBranchObservationInput,
} from './session-branch.js';
import { runProjectOperation } from './transactions.js';

const roots: string[] = [],
  handles: ProjectDatabase[] = [],
  databases: Database.Database[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'session-branch-')),
  });
  roots.push(root.resolvedRoot);
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
  handles.push(handle);
  const db = new Database(file);
  databases.push(db);
  db.pragma('foreign_keys=ON');
  return { handle, authority, db };
}
const options = { secretAllow: [] as string[] };
const key = {
  target: { server_url: 'https://example.test', org_id: 'org', account_id: 'account' },
  repoUrl: 'ssh://git@example.test/original/project',
  workingDir: '/original checkout',
};
function input(): SessionBranchObservationInput {
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    key: structuredClone(key),
    expectedSelection: null,
    stateBytes: Buffer.from(
      JSON.stringify(
        {
          schema_version: 1,
          target: key.target,
          repo_url: key.repoUrl,
          working_dir: key.workingDir,
          current_branch: 'main',
          branch_history: [],
          base_commit_sha: 'a'.repeat(40),
          last_acked_at: null,
        },
        null,
        3
      ) + '\n'
    ),
    observation: { headOid: 'a'.repeat(40), priorBranchExists: null },
  };
}
function next(
  original: SessionBranchObservationInput,
  selection: ProjectSessionBranchSelection,
  branch: string,
  priorExists: boolean | null
): SessionBranchObservationInput {
  const state = JSON.parse(Buffer.from(original.stateBytes).toString());
  const history = [...state.branch_history];
  if (!history.includes(state.current_branch)) history.push(state.current_branch);
  return {
    ...structuredClone(original),
    operationId: uuidv7(),
    revisionId: uuidv7(),
    expectedSelection: selection,
    stateBytes: Buffer.from(
      JSON.stringify({
        ...state,
        current_branch: branch,
        branch_history:
          priorExists === null
            ? state.branch_history
            : priorExists
              ? []
              : history.slice(-10).filter((name) => name !== branch),
        base_commit_sha: priorExists ? 'b'.repeat(40) : state.base_commit_sha,
        last_acked_at: priorExists ? null : state.last_acked_at,
      })
    ),
    observation: { headOid: 'b'.repeat(40), priorBranchExists: priorExists },
  };
}
function rows(handle: ProjectDatabase) {
  return handle.read((view) => ({
    revisions: view.all(
      `SELECT revision_id,publication_operation_id,hex(state_bytes) AS state_bytes,origin_kind,acknowledgement_id,target_server_url,target_org_id,target_account_id,repo_url,working_dir,state_sha256,current_branch,base_commit_sha,last_acked_at FROM session_branch_revisions ORDER BY revision_id`
    ),
    current: view.all('SELECT * FROM session_branch_current'),
    receipts: view.all('SELECT * FROM operations ORDER BY operation_id'),
  }));
}
function corrupt(db: Database.Database, change: () => void) {
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
const integrity = { code: 'HISTORY_INTEGRITY_REQUIRED' },
  conflict = { code: 'IDEMPOTENCY_CONFLICT' };

it('publishes exact initial bytes with one receipt and no intent change', async () => {
  const { handle, db } = await fixture(),
    original = input();
  expect(readProjectSessionBranch(handle, key)).toBeNull();
  const result = await observeProjectSessionBranch(handle, original, options);
  expect(result).toMatchObject({
    replayed: false,
    value: { selection: { revisionId: original.revisionId, version: 1 }, changed: true },
    counters: { writeSequence: 2, intentChangeCounter: 0 },
  });
  const selected = readProjectSessionBranch(handle, key)!;
  expect(selected.stateBytes).toEqual(original.stateBytes);
  expect(selected.state.branch_history).toEqual([]);
  const receipt = db
    .prepare('SELECT payload_json FROM operations WHERE operation_id=?')
    .get(original.operationId) as { payload_json: string };
  expect(JSON.parse(receipt.payload_json)).toEqual({
    revisionId: original.revisionId,
    stateSha256: digest(original.stateBytes),
    observation: original.observation,
  });
  selected.stateBytes.fill(0);
  expect(readProjectSessionBranch(handle, key)!.stateBytes).toEqual(original.stateBytes);
});
it('retains ordered rename history and resets it only on a real branch-off', async () => {
  const { handle } = await fixture(),
    original = input();
  const first = await observeProjectSessionBranch(handle, original, options);
  const renamed = next(original, first.value.selection, 'renamed', false);
  const second = await observeProjectSessionBranch(handle, renamed, options);
  expect(readProjectSessionBranch(handle, key)!.state).toMatchObject({
    current_branch: 'renamed',
    branch_history: ['main'],
    base_commit_sha: 'a'.repeat(40),
  });
  const branched = next(renamed, second.value.selection, 'branch-off', true);
  await observeProjectSessionBranch(handle, branched, options);
  expect(readProjectSessionBranch(handle, key)!.state).toMatchObject({
    current_branch: 'branch-off',
    branch_history: [],
    base_commit_sha: 'b'.repeat(40),
    last_acked_at: null,
  });
});
it('returns an unchanged selection without reserializing bytes or adding a receipt', async () => {
  const { handle } = await fixture(),
    original = input();
  const first = await observeProjectSessionBranch(handle, original, options),
    before = rows(handle);
  const same = next(original, first.value.selection, 'main', null);
  expect(Buffer.from(same.stateBytes)).not.toEqual(Buffer.from(original.stateBytes));
  const result = await observeProjectSessionBranch(handle, same, options);
  expect(result).toEqual({
    value: { selection: first.value.selection, changed: false },
    counters: first.counters,
    replayed: false,
  });
  expect(rows(handle)).toEqual(before);
  expect(readProjectSessionBranch(handle, key)!.stateBytes).toEqual(original.stateBytes);
});
it('replays the original receipt after a later selection without applying stale input', async () => {
  const { handle } = await fixture(),
    original = input();
  const first = await observeProjectSessionBranch(handle, original, options);
  await observeProjectSessionBranch(
    handle,
    next(original, first.value.selection, 'renamed', false),
    options
  );
  const before = rows(handle);
  const replay = await observeProjectSessionBranch(handle, original, options);
  expect(replay.value).toEqual(first.value);
  expect(replay.replayed).toBe(true);
  expect(rows(handle)).toEqual(before);
  expect(readProjectSessionBranch(handle, key)!.state.current_branch).toBe('renamed');
  await expect(
    observeProjectSessionBranch(handle, { ...original, revisionId: uuidv7() }, options)
  ).rejects.toMatchObject(conflict);
  expect(rows(handle)).toEqual(before);
});
it('refuses stale selection and invalid Git semantics before any publication', async () => {
  const { handle } = await fixture(),
    original = input();
  const first = await observeProjectSessionBranch(handle, original, options),
    before = rows(handle);
  await expect(observeProjectSessionBranch(handle, input(), options)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const proposed = next(original, first.value.selection, 'renamed', false);
  const invalid = {
    ...proposed,
    observation: { ...proposed.observation, priorBranchExists: true },
  };
  await expect(observeProjectSessionBranch(handle, invalid, options)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(rows(handle)).toEqual(before);
});
it('guards forged handles before invoking supplied read methods', async () => {
  const read = vi.fn(() => {
    throw new Error('supplied read invoked');
  });
  const handle = { read } as unknown as ProjectDatabase;
  expect(() => readProjectSessionBranch(handle, key)).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  await expect(observeProjectSessionBranch(handle, input(), options)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(read).not.toHaveBeenCalled();
});
it('uses one genuine reader claim and releases it after a missing-selector refusal', async () => {
  const { handle, authority, db } = await fixture(),
    original = input();
  await observeProjectSessionBranch(handle, original, options);
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  const selected = readProjectSessionBranch(reader, key)!;
  corrupt(db, () => db.exec('DELETE FROM session_branch_current'));
  expect(() => readProjectSessionBranch(reader, key)).toThrowError(
    expect.objectContaining(integrity)
  );
  corrupt(db, () =>
    db
      .prepare('INSERT INTO session_branch_current VALUES (?,?,?,?,?,?,?)')
      .run(
        key.target.server_url,
        key.target.org_id,
        key.target.account_id,
        key.repoUrl,
        key.workingDir,
        original.revisionId,
        1
      )
  );
  expect(readProjectSessionBranch(reader, key)).toEqual(selected);
});
it.each(['current', 'revision', 'both', 'receipt'] as const)(
  'refuses missing %s without replacing original history',
  async (loss) => {
    const { handle, db } = await fixture(),
      original = input();
    await observeProjectSessionBranch(handle, original, options);
    corrupt(db, () => {
      if (loss === 'current' || loss === 'both') db.exec('DELETE FROM session_branch_current');
      if (loss === 'revision' || loss === 'both') db.exec('DELETE FROM session_branch_revisions');
      if (loss === 'receipt')
        db.prepare('DELETE FROM operations WHERE operation_id=?').run(original.operationId);
    });
    const before = rows(handle);
    expect(() => readProjectSessionBranch(handle, key)).toThrowError(
      expect.objectContaining(integrity)
    );
    await expect(observeProjectSessionBranch(handle, input(), options)).rejects.toMatchObject(
      integrity
    );
    await expect(observeProjectSessionBranch(handle, original, options)).rejects.toMatchObject(
      integrity
    );
    expect(rows(handle)).toEqual(before);
  }
);
it.each(['bytes', 'hash', 'branch', 'result', 'target', 'version', 'kind'] as const)(
  'refuses inconsistent original %s',
  async (field) => {
    const { handle, db } = await fixture(),
      original = input();
    await observeProjectSessionBranch(handle, original, options);
    corrupt(db, () => {
      if (field === 'bytes')
        db.prepare('UPDATE session_branch_revisions SET state_bytes=?').run(Buffer.from('{}'));
      if (field === 'hash')
        db.prepare('UPDATE session_branch_revisions SET state_sha256=?').run('c'.repeat(64));
      if (field === 'branch') db.exec("UPDATE session_branch_revisions SET current_branch='other'");
      if (field === 'result')
        db.prepare('UPDATE operations SET result_json=? WHERE operation_id=?').run(
          JSON.stringify({ selection: { revisionId: uuidv7(), version: 1 }, changed: true }),
          original.operationId
        );
      if (field === 'target')
        db.prepare('UPDATE operations SET target_json=? WHERE operation_id=?').run(
          JSON.stringify({ ...key, workingDir: '/other' }),
          original.operationId
        );
      if (field === 'version') db.exec('UPDATE session_branch_current SET version=2');
      if (field === 'kind')
        db.prepare('UPDATE operations SET operation_kind=? WHERE operation_id=?').run(
          'different.original.owner',
          original.operationId
        );
    });
    expect(() => readProjectSessionBranch(handle, key)).toThrowError(
      expect.objectContaining(integrity)
    );
    await expect(observeProjectSessionBranch(handle, original, options)).rejects.toMatchObject(
      integrity
    );
  }
);
it('preserves genuine unrelated operation identity conflicts', async () => {
  const { handle } = await fixture(),
    original = input();
  await runProjectOperation(
    handle,
    {
      operationId: original.operationId,
      kind: 'independent.operation',
      intentChange: false,
      target: {},
      payload: {},
      expectedState: null,
    },
    () => ({ original: true })
  );
  const before = rows(handle);
  await expect(observeProjectSessionBranch(handle, original, options)).rejects.toMatchObject(
    conflict
  );
  expect(rows(handle)).toEqual(before);
});
it('serializes two original observations and retains one result', async () => {
  const { handle, authority, db } = await fixture(),
    original = input();
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  db.exec('BEGIN IMMEDIATE');
  const waiting = new Set<string>();
  const wait = (name: string) => {
    waiting.add(name);
    if (waiting.size === 2 && db.inTransaction) db.exec('ROLLBACK');
  };
  const results = await Promise.all([
    observeProjectSessionBranch(handle, original, {
      ...options,
      onWait() {
        wait('first');
      },
    }),
    observeProjectSessionBranch(other, original, {
      ...options,
      onWait() {
        wait('second');
      },
    }),
  ]);
  expect(waiting.size).toBe(2);
  expect(results.map((value) => value.replayed).sort()).toEqual([false, true]);
  expect(results[0]!.value).toEqual(results[1]!.value);
  expect(rows(handle).value.revisions).toHaveLength(1);
});
it('cancels a real writer wait without publishing and retries the exact original request', async () => {
  const { handle, db } = await fixture(),
    original = input(),
    saved = structuredClone(original),
    controller = new AbortController();
  const before = rows(handle);
  db.exec('BEGIN IMMEDIATE');
  await expect(
    observeProjectSessionBranch(handle, original, {
      ...options,
      signal: controller.signal,
      onWait() {
        original.stateBytes.fill(0);
        controller.abort();
      },
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  db.exec('ROLLBACK');
  expect(rows(handle)).toEqual(before);
  await observeProjectSessionBranch(handle, saved, options);
  expect(readProjectSessionBranch(handle, key)!.stateBytes).toEqual(Buffer.from(saved.stateBytes));
});

it('looks up a valid original receipt before attempting fresh input preparation', async () => {
  const { handle } = await fixture(),
    original = input();
  const first = await observeProjectSessionBranch(handle, original, options),
    before = rows(handle);
  const prepare = vi.spyOn(branchInputs, 'prepareProjectSessionBranch').mockImplementation(() => {
    throw new Error('fresh preparation must not run');
  });
  const replay = await observeProjectSessionBranch(handle, original, options);
  expect(replay).toMatchObject({ replayed: true, value: first.value });
  expect(prepare).not.toHaveBeenCalled();
  expect(rows(handle)).toEqual(before);
});
it('decodes retained state outside every observed SQLite transaction', async () => {
  const { handle } = await fixture(),
    original = input();
  const first = await observeProjectSessionBranch(handle, original, options);
  const connections = new Set<Database.Database>();
  const exec = Database.prototype.exec;
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    connections.add(this);
    return exec.call(this, sql);
  });
  const decode = branchCodec.decodeRetainedSessionBranch,
    observations: boolean[] = [];
  vi.spyOn(branchCodec, 'decodeRetainedSessionBranch').mockImplementation((value) => {
    observations.push([...connections].some((database) => database.inTransaction));
    return decode(value);
  });
  await observeProjectSessionBranch(
    handle,
    next(original, first.value.selection, 'renamed', false),
    options
  );
  expect(connections.size).toBeGreaterThan(0);
  expect(observations.length).toBeGreaterThan(0);
  expect(observations.every((value) => !value)).toBe(true);
});
it('checks the immediate original predecessor receipt as well as selected bytes', async () => {
  const { handle, db } = await fixture(),
    original = input();
  const first = await observeProjectSessionBranch(handle, original, options);
  await observeProjectSessionBranch(
    handle,
    next(original, first.value.selection, 'renamed', false),
    options
  );
  corrupt(db, () =>
    db
      .prepare('UPDATE operations SET result_json=? WHERE operation_id=?')
      .run(
        JSON.stringify({ selection: { revisionId: uuidv7(), version: 1 }, changed: true }),
        original.operationId
      )
  );
  expect(() => readProjectSessionBranch(handle, key)).toThrowError(
    expect.objectContaining(integrity)
  );
});
it('refuses decoded authored content before any publication and honors the explicit allowlist', async () => {
  const { handle } = await fixture(),
    original = input(),
    before = rows(handle);
  const token = ['ghp', 'A'.repeat(36)].join('_');
  const state = JSON.parse(Buffer.from(original.stateBytes).toString());
  original.stateBytes = Buffer.from(JSON.stringify({ ...state, current_branch: token }));
  await expect(observeProjectSessionBranch(handle, original, options)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(rows(handle)).toEqual(before);
  await observeProjectSessionBranch(handle, original, { secretAllow: [token] });
  expect(readProjectSessionBranch(handle, key)!.state.current_branch).toBe(token);
});
it('refuses a malformed explicit allowlist without writing', async () => {
  const { handle } = await fixture(),
    before = rows(handle);
  await expect(
    observeProjectSessionBranch(handle, input(), { secretAllow: null } as never)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rows(handle)).toEqual(before);
});
