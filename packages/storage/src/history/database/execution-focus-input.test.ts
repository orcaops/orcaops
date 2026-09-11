import { expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import type { ShellKey } from '../../pins/shell-key.js';
import { digest } from '../event-integrity.js';
import { createExecutionPin } from '../execution-focus.js';
import { initializeUnboundExecution } from '../execution.js';
import { historyRootKey } from '../paths.js';
import {
  decodeRetainedFocusPin,
  prepareProjectFocus,
  type ProjectFocusChange,
  type ProjectFocusScope,
  projectFocusScopeJson,
} from './execution-focus-input.js';

function fixture() {
  const scope: ProjectFocusScope = {
    rootKey: historyRootKey('/selected'),
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
    worktreeId: uuidv7(),
    shellKey: { kind: 'codex_session', value: 'full/session/identity' },
  };
  const pin = {
    schema_version: 1 as const,
    artifact_id: uuidv7(),
    root_key: scope.rootKey,
    project_id: scope.projectId,
    store_instance_id: scope.storeInstanceId,
    repository_instance_id: scope.repositoryInstanceId,
    worktree_id: scope.worktreeId,
    shell_key: scope.shellKey,
    binding_generation: 0,
    branch: 'main',
    head_sha: 'a'.repeat(40),
    pinned_at: '2026-09-05T00:00:00.000Z',
  };
  const input: Extract<ProjectFocusChange, { action: 'set' }> = {
    operationId: uuidv7(),
    scope,
    expectedSelection: { operationId: uuidv7(), version: 2 },
    secretAllow: [],
    action: 'set',
    pinBytes: Buffer.from(`${JSON.stringify(pin, null, 2)}\n`),
    expectedArtifactRevision: {
      generation: 3,
      orderedHash: 'b'.repeat(64),
      eventCount: 7,
      byteLength: 1000,
      tailEventId: uuidv7(),
    },
    expectedExecutionVersion: 4,
  };
  return { scope, pin, input };
}

it('retains exact pin bytes and identity without canonicalizing the authored record', () => {
  const { input, pin } = fixture();
  const original = Buffer.from(input.pinBytes);
  const prepared = prepareProjectFocus(input);
  expect(prepared.action).toBe('set');
  if (prepared.action !== 'set') throw new Error('Expected set');
  expect(Buffer.from(prepared.pinBytesBase64, 'base64')).toEqual(original);
  expect(prepared.pinHash).toBe(digest(original));
  expect(decodeRetainedFocusPin(prepared.scopeJson, original, prepared.pinHash)).toEqual(pin);
  expect(prepared.target).toEqual({
    artifactId: pin.artifact_id,
    revision: input.expectedArtifactRevision,
    executionVersion: 4,
    bindingGeneration: 0,
  });
});

it.each(['claude_session', 'codex_session', 'tmux_pane', 'screen_window', 'tty_session'] as const)(
  'retains the full %s namespace and separates later context from slot identity',
  (kind) => {
    const { input, pin } = fixture();
    const key: Exclude<ShellKey, { kind: 'none' }> = {
      kind,
      value: 'a'.repeat(200) + '/full:value\n尾',
    };
    input.scope.shellKey = key;
    pin.shell_key = key;
    input.pinBytes = Buffer.from(JSON.stringify(pin));
    const first = prepareProjectFocus(input);
    expect(JSON.parse(first.scopeJson).shellKey).toEqual(key);
    pin.branch = 'other';
    pin.head_sha = 'c'.repeat(40);
    input.pinBytes = Buffer.from(JSON.stringify(pin));
    const second = prepareProjectFocus(input);
    expect(second.scopeJson).toBe(first.scopeJson);
    expect(second.pinHash).not.toBe(first.pinHash);
    expect(
      projectFocusScopeJson({ ...input.scope, shellKey: { ...key, value: key.value + 'x' } })
    ).not.toBe(first.scopeJson);
  }
);

it('detaches all mutable input and returns immutable prepared values', () => {
  const { input } = fixture();
  const prepared = prepareProjectFocus(input);
  const snapshot = JSON.stringify(prepared);
  input.scope.projectId = uuidv7();
  input.scope.shellKey = { kind: 'codex_session', value: 'changed' };
  input.pinBytes.fill(0);
  input.expectedArtifactRevision.generation = 99;
  input.expectedSelection!.version = 99;
  input.secretAllow.push('changed');
  expect(JSON.stringify(prepared)).toBe(snapshot);
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.expectedSelection)).toBe(true);
  if (prepared.action !== 'set') throw new Error('Expected set');
  expect(Object.isFrozen(prepared.target)).toBe(true);
  expect(Object.isFrozen(prepared.target.revision)).toBe(true);
});

it.each(['imported', 'completed', 'legacy_unknown'] as const)(
  'prepares %s focus with original zero-generation execution and no ownership transition',
  (reason) => {
    const { input } = fixture();
    const state = initializeUnboundExecution({
      artifactId: uuidv7(),
      operationId: uuidv7(),
      ts: '2026-09-05T00:00:00.000Z',
      reason,
    });
    const before = JSON.stringify(state);
    const pin = createExecutionPin({
      authority: {
        resolvedRoot: '/selected',
        rootKey: input.scope.rootKey,
        projectId: input.scope.projectId,
        storeInstanceId: input.scope.storeInstanceId,
        formatVersion: 1,
      },
      gitContext: {
        commonDir: '/repo/.git',
        gitDir: '/repo/.git',
        worktreeRoot: '/repo',
        repositoryInstanceId: input.scope.repositoryInstanceId,
        worktreeId: input.scope.worktreeId,
        branch: null,
        headOid: 'a'.repeat(40),
      },
      shellKey: input.scope.shellKey,
      state,
      pinnedAt: '2026-09-05T00:00:00.000Z',
    });
    input.pinBytes = Buffer.from(JSON.stringify(pin));
    expect(prepareProjectFocus(input)).toMatchObject({
      target: { artifactId: state.artifact_id, bindingGeneration: 0 },
    });
    expect(JSON.stringify(state)).toBe(before);
  }
);

it('clears an exact slot without an artifact or execution condition', () => {
  const { input } = fixture();
  const clear: ProjectFocusChange = {
    action: 'clear',
    operationId: input.operationId,
    scope: input.scope,
    expectedSelection: input.expectedSelection,
    secretAllow: [],
  };
  expect(prepareProjectFocus(clear)).toMatchObject({
    action: 'clear',
    target: null,
    pinBytesBase64: null,
    pinHash: null,
    expectedSelection: input.expectedSelection,
  });
  expect(prepareProjectFocus({ ...clear, expectedSelection: null }).expectedSelection).toBeNull();
  expect(() =>
    prepareProjectFocus({ ...clear, expectedExecutionVersion: 7 } as ProjectFocusChange)
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

it.each([
  'rootKey',
  'projectId',
  'storeInstanceId',
  'repositoryInstanceId',
  'worktreeId',
  'shellKey',
] as const)('refuses a pin whose %s is outside the selected namespace', (field) => {
  const { input } = fixture();
  const changed =
    field === 'rootKey'
      ? 'c'.repeat(64)
      : field === 'shellKey'
        ? { kind: 'codex_session', value: 'other' }
        : uuidv7();
  Object.assign(input.scope, { [field]: changed });
  expect(() => prepareProjectFocus(input)).toThrow(
    expect.objectContaining({ code: 'AUTHORITY_MISMATCH' })
  );
});

it('rejects unsupported shells, unsafe versions and malformed bytes', () => {
  const { input, pin } = fixture();
  for (const changed of [
    { scope: { ...input.scope, shellKey: { kind: 'none' } } },
    { expectedExecutionVersion: Number.MAX_SAFE_INTEGER + 1 },
    { expectedExecutionVersion: 0 },
    { expectedSelection: { operationId: uuidv7(), version: 0 } },
    { expectedArtifactRevision: { ...input.expectedArtifactRevision, generation: 0 } },
    { pinBytes: Buffer.from([0xff]) },
    { pinBytes: Buffer.from('{}') },
    { pinBytes: Buffer.from(JSON.stringify({ ...pin, shell_key: { kind: 'none' } })) },
  ]) {
    expect(() => prepareProjectFocus({ ...input, ...changed } as ProjectFocusChange)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  }
});

it('refuses secrets in raw, escaped and overwritten JSON strings before producing a record', () => {
  const { input, pin } = fixture();
  const token = 'ghp_' + 'a'.repeat(36);
  const plain = JSON.stringify({ ...pin, branch: token });
  const escaped = plain.replace(
    token,
    [...token].map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  );
  const duplicate = plain.replace(
    '"branch":' + JSON.stringify(token),
    '"branch":' + JSON.stringify(token) + ',"branch":"safe"'
  );
  for (const value of [plain, escaped, duplicate]) {
    expect(() => prepareProjectFocus({ ...input, pinBytes: Buffer.from(value) })).toThrow(
      expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
    );
  }
  expect(() =>
    prepareProjectFocus({
      action: 'clear',
      operationId: input.operationId,
      scope: { ...input.scope, shellKey: { kind: 'codex_session', value: token } },
      expectedSelection: null,
      secretAllow: [],
    })
  ).toThrow(expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' }));
});

it('validates retained bytes and namespace without applying current authored secret refusal', () => {
  const { input, pin } = fixture();
  const scope = projectFocusScopeJson(input.scope);
  const bytes = Buffer.from(JSON.stringify({ ...pin, branch: 'ghp_' + 'a'.repeat(36) }));
  expect(decodeRetainedFocusPin(scope, bytes, digest(bytes)).artifact_id).toBe(pin.artifact_id);
  for (const [namespace, raw, hash] of [
    [scope, bytes, 'f'.repeat(64)],
    [scope, Buffer.from('{}'), digest('{}')],
    [projectFocusScopeJson({ ...input.scope, worktreeId: uuidv7() }), bytes, digest(bytes)],
    [JSON.stringify(input.scope, null, 2), bytes, digest(bytes)],
  ] as const) {
    expect(() => decodeRetainedFocusPin(namespace, raw, hash)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  }
});
