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
import { assertCheckoutChildOperation } from './execution-checkout-identity.js';
import { assertCheckoutPinHash, reconstructCheckoutPin } from './execution-checkout-input.js';
import {
  prepareProjectExecutionCheckout,
  type ProjectExecutionCheckoutInput,
  projectExecutionCheckoutRequest,
  publishProjectExecutionCheckout,
  readProjectExecutionCheckout,
  replayProjectExecutionCheckout,
} from './execution-checkout.js';
import { projectFocusScopeJson } from './execution-focus-input.js';
import { publishProjectExecutionFocus, readProjectExecutionFocus } from './execution-focus.js';
import { readProjectExecution } from './execution-records.js';
import { transitionProjectExecution } from './execution-transitions.js';
import { runProjectOperation } from './transactions.js';

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
it('retains one minimal focus recipe and replays original binding after later selections', async () => {
  const f = await fixture();
  const input = request(f);
  const before = readProjectArtifact(f.handle, f.artifactId)!;
  const prepared = prepareProjectExecutionCheckout(f.handle, input);
  const original = await publishProjectExecutionCheckout(f.handle, prepared);
  const retained = readProjectExecutionCheckout(f.handle, input.operationId)!;
  expect(retained.result).toEqual(original.value);
  expect(retained.request).toEqual(projectExecutionCheckoutRequest(prepared));
  expect(readProjectArtifact(f.handle, f.artifactId)!.eventBytes).toEqual(before.eventBytes);
  expect(readProjectExecutionFocus(f.handle, input.payload.focus.scope).status).toBe('absent');
  const payload = f.handle.read((v) =>
    v.get<{ payload: string }>(
      'SELECT payload_json AS payload FROM operations WHERE operation_id=?',
      input.operationId
    )
  ).value!.payload;
  expect(payload).not.toContain('pinBytes');
  expect(payload).not.toContain('pinned_at');
  const pin = assertCheckoutPinHash(retained.request);
  await publishProjectExecutionFocus(f.handle, {
    action: 'set',
    operationId: input.payload.focus.operationId,
    scope: input.payload.focus.scope,
    expectedSelection: null,
    expectedArtifactRevision: input.expected.revision,
    expectedExecutionVersion: original.value.executionVersion,
    pinBytes: pin,
    secretAllow: [],
  });
  const state = readProjectExecution(f.handle, f.artifactId)!;
  await transitionProjectExecution(f.handle, {
    artifactId: f.artifactId,
    operationId: uuidv7(),
    expectedRevision: input.expected.revision,
    expectedVersion: state.version,
    expectedGeneration: state.state.binding_generation,
    expectedBinding: state.state.current_binding,
    action: 'context_changed',
    target: { ...input.payload.target, git_context: { branch: 'later', head_sha: 'c'.repeat(40) } },
    reason: null,
    ts: '2026-09-01T00:02:00.000Z',
    secretAllow: [],
  });
  const later = saved(f.handle);
  expect(await replayProjectExecutionCheckout(f.handle, input.operationId)).toEqual({
    ...original,
    replayed: true,
  });
  expect(saved(f.handle)).toEqual(later);
  expect(
    assertCheckoutPinHash(readProjectExecutionCheckout(f.handle, input.operationId)!.request)
  ).toEqual(pin);
});
it('refuses a changed focus slot before binding settlement without undo or new receipts', async () => {
  const f = await fixture();
  const input = request(f);
  const prepared = prepareProjectExecutionCheckout(f.handle, input);
  await publishProjectExecutionFocus(f.handle, {
    action: 'clear',
    operationId: uuidv7(),
    scope: input.payload.focus.scope,
    expectedSelection: null,
    secretAllow: [],
  });
  const before = saved(f.handle);
  await expect(publishProjectExecutionCheckout(f.handle, prepared)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(saved(f.handle)).toEqual(before);
});
it('copies the original recipe and rejects forged preparation or counterfeit readers', async () => {
  const f = await fixture();
  const input = request(f);
  const prepared = prepareProjectExecutionCheckout(f.handle, input);
  const original = projectExecutionCheckoutRequest(prepared);
  input.payload.focus.pinnedAt = '2026-09-01T00:03:00.000Z';
  input.payload.target.git_context.branch = 'changed';
  expect(projectExecutionCheckoutRequest(prepared)).toEqual(original);
  await expect(
    publishProjectExecutionCheckout(f.handle, { kind: 'prepared-execution-checkout' })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(() =>
    readProjectExecutionCheckout(
      {
        read() {
          throw new Error('Must not call');
        },
      } as never,
      uuidv7()
    )
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
it('refuses retained checkout receipts after original transition loss without read repair', async () => {
  const f = await fixture();
  const input = request(f);
  await publishProjectExecutionCheckout(f.handle, prepareProjectExecutionCheckout(f.handle, input));
  const db = new Database(f.file);
  db.pragma('foreign_keys = OFF');
  const triggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='execution_transitions'"
    )
    .all() as { name: string; sql: string }[];
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  db.prepare('DELETE FROM execution_transitions WHERE operation_id=?').run(input.operationId);
  for (const t of triggers) db.exec(t.sql);
  db.pragma('foreign_keys = ON');
  db.close();
  const before = saved(f.handle);
  expect(() => readProjectExecutionCheckout(f.handle, input.operationId)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(saved(f.handle)).toEqual(before);
});
it('refuses reused child identities and inconsistent pin hashes before any binding write', async () => {
  const f = await fixture();
  const input = request(f);
  const before = saved(f.handle);
  input.payload.focus.pinHash = '0'.repeat(64);
  expect(() => prepareProjectExecutionCheckout(f.handle, input)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  input.payload.focus.pinHash = digest(
    reconstructCheckoutPin(input.artifactId, input.payload, input.expected.generation + 1)
  );
  input.payload.focus.operationId = input.operationId;
  expect(() => prepareProjectExecutionCheckout(f.handle, input)).toThrow(
    expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })
  );
  expect(saved(f.handle)).toEqual(before);
});

it('protects a committed binding focus identity from unrelated project operations', async () => {
  const f = await fixture();
  const input = request(f);
  await publishProjectExecutionCheckout(f.handle, prepareProjectExecutionCheckout(f.handle, input));
  const before = saved(f.handle);
  await expect(
    runProjectOperation(
      f.handle,
      {
        operationId: input.payload.focus.operationId,
        kind: 'test.unrelated',
        target: {},
        payload: {},
        expectedState: null,
        intentChange: false,
      },
      () => null
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(saved(f.handle)).toEqual(before);
});
it('admits only the exact original child request through the fixed ownership guard', async () => {
  const f = await fixture();
  const input = request(f);
  const parent = await publishProjectExecutionCheckout(
    f.handle,
    prepareProjectExecutionCheckout(f.handle, input)
  );
  const exact = {
    operationId: input.payload.focus.operationId,
    kind: 'execution.focus',
    target: { scopeHash: digest(projectFocusScopeJson(input.payload.focus.scope)) },
    payload: { action: 'set', pinHash: input.payload.focus.pinHash },
    expectedState: {
      selection: null,
      target: {
        artifactId: f.artifactId,
        revision: { ...input.expected.revision },
        executionVersion: parent.value.executionVersion,
        bindingGeneration: parent.value.bindingGeneration,
      },
    },
    intentChange: false,
  };
  expect(() =>
    f.handle.read((v) => {
      assertCheckoutChildOperation(v, exact);
      return null;
    })
  ).not.toThrow();
  for (const changed of [
    { ...exact, kind: 'test.unrelated' },
    { ...exact, payload: { ...exact.payload, pinHash: '0'.repeat(64) } },
    { ...exact, target: { scopeHash: '0'.repeat(64) } },
    {
      ...exact,
      expectedState: { ...exact.expectedState, selection: { operationId: uuidv7(), version: 1 } },
    },
  ])
    expect(() =>
      f.handle.read((v) => {
        assertCheckoutChildOperation(v, changed);
        return null;
      })
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  const another = request(f);
  another.payload.focus.operationId = input.payload.focus.operationId;
  expect(() => prepareProjectExecutionCheckout(f.handle, another)).toThrow(
    expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })
  );
});
