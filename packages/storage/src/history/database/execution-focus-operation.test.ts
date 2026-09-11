import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest, recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import { readProjectArtifact } from './artifacts.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { appendProjectExecutionCapture } from './execution-capture.js';
import { reconstructCheckoutPin } from './execution-checkout-input.js';
import {
  prepareProjectExecutionCheckout,
  type ProjectExecutionCheckoutInput,
  publishProjectExecutionCheckout,
} from './execution-checkout.js';
import { readProjectExecutionFocusOperation } from './execution-focus-operation.js';
import { publishProjectExecutionFocus, readProjectExecutionFocus } from './execution-focus.js';
import { readProjectExecution } from './execution-records.js';
const handles: ProjectDatabase[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) h.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'checkout-')),
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
    initializedAt: '2026-09-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(handle);
  const original = JSON.parse(
    await readFile(new URL('./fixtures/execution-history.json', import.meta.url), 'utf8')
  );
  const { checksum: _checksum, ...event } = JSON.parse(
    Buffer.from(original.rows.artifact_events[0].record_bytes.blobHex, 'hex').toString()
  );
  const artifactId = uuidv7();
  event.event_id = uuidv7();
  event.idempotency_key = uuidv7();
  event.payload.artifact_id = artifactId;
  await appendProjectExecutionCapture(handle, {
    artifactId,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...event, checksum: recordChecksum(event) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
    execution: {
      kind: 'create',
      context: {
        repository_instance_id: authority.repositoryInstanceId,
        worktree_id: uuidv7(),
        git_context: { branch: 'original', head_sha: 'a'.repeat(40) },
      },
      ts: '2026-09-01T00:00:00.000Z',
    },
  });
  return { handle, authority, artifactId, file };
}
function request(f: Awaited<ReturnType<typeof fixture>>): ProjectExecutionCheckoutInput {
  const state = readProjectExecution(f.handle, f.artifactId)!;
  const worktreeId = uuidv7();
  const input: ProjectExecutionCheckoutInput = {
    artifactId: f.artifactId,
    operationId: uuidv7(),
    secretAllow: [],
    expected: {
      revision: readProjectArtifact(f.handle, f.artifactId)!.revision,
      version: state.version,
      generation: state.state.binding_generation,
    },
    payload: {
      action: 'handoff',
      expectedBinding: state.state.current_binding,
      target: {
        repository_instance_id: f.authority.repositoryInstanceId,
        worktree_id: worktreeId,
        git_context: { branch: 'target', head_sha: 'b'.repeat(40) },
      },
      reason: null,
      ts: '2026-09-01T00:01:00.000Z',
      focus: {
        operationId: uuidv7(),
        scope: {
          rootKey: f.authority.rootKey,
          projectId: f.authority.projectId,
          storeInstanceId: f.authority.storeInstanceId,
          repositoryInstanceId: f.authority.repositoryInstanceId,
          worktreeId,
          shellKey: { kind: 'codex_session', value: 'original-session' },
        },
        expectedSelection: null,
        pinnedAt: '2026-09-01T00:01:00.000Z',
        pinHash: '0'.repeat(64),
      },
    },
  };
  input.payload.focus.pinHash = digest(
    reconstructCheckoutPin(input.artifactId, input.payload, input.expected.generation + 1)
  );
  return input;
}
function saved(handle: ProjectDatabase) {
  return handle.read((v) => ({
    operations: v.all('SELECT * FROM operations ORDER BY operation_id'),
    execution: v.all('SELECT * FROM execution_current'),
    focus: v.all('SELECT * FROM execution_focus_current'),
  }));
}

async function focusFixture() {
  const f = await fixture();
  const input = request(f);
  const binding = await publishProjectExecutionCheckout(
    f.handle,
    prepareProjectExecutionCheckout(f.handle, input)
  );
  const change = {
    action: 'set' as const,
    operationId: input.payload.focus.operationId,
    scope: input.payload.focus.scope,
    expectedSelection: null,
    expectedArtifactRevision: input.expected.revision,
    expectedExecutionVersion: binding.value.executionVersion,
    pinBytes: reconstructCheckoutPin(
      input.artifactId,
      input.payload,
      binding.value.bindingGeneration
    ),
    secretAllow: [],
  };
  const publication = await publishProjectExecutionFocus(f.handle, change);
  return { ...f, change, publication };
}
it('recovers exact original focus bytes and clear requests after later slot changes', async () => {
  const f = await focusFixture();
  const original = readProjectExecutionFocusOperation(f.handle, f.change.operationId)!;
  const { secretAllow: _, ...input } = f.change;
  expect(original.input).toEqual(input);
  expect(original.result).toEqual(f.publication.value);
  const cleared = await publishProjectExecutionFocus(f.handle, {
    action: 'clear',
    operationId: uuidv7(),
    scope: f.change.scope,
    expectedSelection: original.result.selection,
    secretAllow: [],
  });
  const clear = readProjectExecutionFocusOperation(f.handle, cleared.value.selection.operationId)!;
  expect(clear.input).toEqual({
    action: 'clear',
    operationId: cleared.value.selection.operationId,
    scope: f.change.scope,
    expectedSelection: original.result.selection,
  });
  const before = saved(f.handle);
  expect(
    await publishProjectExecutionFocus(f.handle, { ...original.input, secretAllow: [] })
  ).toEqual({ ...f.publication, replayed: true });
  expect(await publishProjectExecutionFocus(f.handle, { ...clear.input, secretAllow: [] })).toEqual(
    { ...cleared, replayed: true }
  );
  expect(readProjectExecutionFocus(f.handle, f.change.scope).status).toBe('cleared');
  expect(readProjectExecutionFocusOperation(f.handle, f.change.operationId)).toEqual(original);
  expect(saved(f.handle)).toEqual(before);
});

it('refuses missing original focus rows and missing receipts without changing retained history', async () => {
  for (const table of ['execution_focus_records', 'operations']) {
    const f = await focusFixture();
    const db = new Database(f.file);
    db.pragma('foreign_keys = OFF');
    const triggers = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
      .all(table) as { name: string; sql: string }[];
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
    db.prepare(`DELETE FROM ${table} WHERE operation_id=?`).run(f.change.operationId);
    for (const trigger of triggers) db.exec(trigger.sql);
    db.close();
    const before = saved(f.handle);
    expect(() => readProjectExecutionFocusOperation(f.handle, f.change.operationId)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(saved(f.handle)).toEqual(before);
  }
});
it('validates original focus identity and genuine handle before invoking caller methods', async () => {
  const f = await focusFixture();
  expect(readProjectExecutionFocusOperation(f.handle, uuidv7())).toBeNull();
  expect(() => readProjectExecutionFocusOperation(f.handle, 'bad')).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  let calls = 0;
  expect(() =>
    readProjectExecutionFocusOperation(
      {
        read() {
          calls++;
        },
      } as never,
      uuidv7()
    )
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(calls).toBe(0);
  f.handle.close();
  expect(() => readProjectExecutionFocusOperation(f.handle, f.change.operationId)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INACCESSIBLE' })
  );
});
