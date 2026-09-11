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
import { projectFocusScopeJson } from './execution-focus-input.js';
import { publishProjectExecutionFocus } from './execution-focus.js';
import { readProjectExecution } from './execution-records.js';
import { type ProjectSettlement, runProjectOperation } from './transactions.js';
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

it('refuses wrong child payload or target before settlement and preserves original focus replay', async () => {
  const f = await fixture();
  const input = request(f);
  const binding = await publishProjectExecutionCheckout(
    f.handle,
    prepareProjectExecutionCheckout(f.handle, input)
  );
  const exact = {
    operationId: input.payload.focus.operationId,
    kind: 'execution.focus',
    intentChange: false,
    target: { scopeHash: digest(projectFocusScopeJson(input.payload.focus.scope)) },
    payload: { action: 'set', pinHash: input.payload.focus.pinHash },
    expectedState: {
      selection: null,
      target: {
        artifactId: f.artifactId,
        revision: { ...input.expected.revision },
        executionVersion: binding.value.executionVersion,
        bindingGeneration: binding.value.bindingGeneration,
      },
    },
  };
  const before = saved(f.handle);
  let settlements = 0;
  for (const changed of [
    { ...exact, kind: 'test.unrelated' },
    { ...exact, payload: { ...exact.payload, pinHash: '0'.repeat(64) } },
    { ...exact, target: { scopeHash: '0'.repeat(64) } },
    {
      ...exact,
      expectedState: { ...exact.expectedState, selection: { operationId: uuidv7(), version: 1 } },
    },
    { ...exact, intentChange: true },
  ])
    await expect(
      runProjectOperation(f.handle, changed, () => {
        settlements++;
        return null;
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(settlements).toBe(0);
  expect(saved(f.handle)).toEqual(before);
  const focus = {
    action: 'set' as const,
    operationId: exact.operationId,
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
  const original = await publishProjectExecutionFocus(f.handle, focus);
  const after = saved(f.handle);
  expect(await publishProjectExecutionFocus(f.handle, focus)).toEqual({
    ...original,
    replayed: true,
  });
  expect(saved(f.handle)).toEqual(after);
});
function pushHeader(
  f: Awaited<ReturnType<typeof fixture>>,
  terminalId: string,
  operationId: string
) {
  return {
    push_id: uuidv7(),
    admission_operation_id: operationId,
    terminal_operation_id: terminalId,
    artifact_id: f.artifactId,
    server_url: 'https://example.test',
    org_id: 'org',
    account_id: 'account',
    artifact_generation: 1,
    cloud_acknowledgement_id: uuidv7(),
    prepared_at: 'original',
    result_checkpoints: 0,
    result_summary: 0,
    result_evaluators: 0,
    request_sha256: 'a'.repeat(64),
    call_count: 2,
    artifact_payload_hash: 'b'.repeat(64),
  };
}
function insertPush(tx: ProjectSettlement, row: ReturnType<typeof pushHeader>) {
  tx.run(
    `INSERT INTO artifact_push_requests (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
      .map(() => '?')
      .join(',')})`,
    ...Object.values(row)
  );
  return null;
}
it('rechecks child ownership when an existing push reserves it after checkout preparation', async () => {
  const f = await fixture();
  const input = request(f);
  const prepared = prepareProjectExecutionCheckout(f.handle, input);
  const admissionId = uuidv7();
  const row = pushHeader(f, input.payload.focus.operationId, admissionId);
  await runProjectOperation(
    f.handle,
    {
      operationId: admissionId,
      kind: 'artifact.push.begin',
      target: { artifactId: f.artifactId },
      payload: {},
      expectedState: null,
      intentChange: false,
    },
    (tx) => insertPush(tx, row)
  );
  const before = saved(f.handle);
  await expect(publishProjectExecutionCheckout(f.handle, prepared)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(() => prepareProjectExecutionCheckout(f.handle, input)).toThrow(
    expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })
  );
  expect(saved(f.handle)).toEqual(before);
});
it('refuses a child receipt created after preparation without changing the binding', async () => {
  const f = await fixture();
  const input = request(f);
  const prepared = prepareProjectExecutionCheckout(f.handle, input);
  await runProjectOperation(
    f.handle,
    {
      operationId: input.payload.focus.operationId,
      kind: 'test.original',
      target: {},
      payload: {},
      expectedState: null,
      intentChange: false,
    },
    () => null
  );
  const before = saved(f.handle);
  await expect(publishProjectExecutionCheckout(f.handle, prepared)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(saved(f.handle)).toEqual(before);
});
