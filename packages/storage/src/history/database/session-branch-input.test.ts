import childProcess from 'node:child_process';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import {
  prepareProjectSessionAcknowledgement,
  prepareProjectSessionBranch,
  projectSessionAcknowledgement,
  type ProjectSessionAcknowledgementInput,
  projectSessionBranch,
  type ProjectSessionBranchInput,
} from './session-branch-input.js';

afterEach(() => vi.restoreAllMocks());
const options = { secretAllow: [] as string[] };
function input(): ProjectSessionBranchInput {
  const key = {
    target: { server_url: 'https://example.test', org_id: 'original org', account_id: 'account' },
    repoUrl: 'ssh://git@example.test/original/project',
    workingDir: '/original path/worktree',
  };
  const state = {
    schema_version: 1,
    target: key.target,
    repo_url: key.repoUrl,
    working_dir: key.workingDir,
    current_branch: 'feature/original',
    branch_history: ['first', 'second', 'first'],
    base_commit_sha: 'original opaque base',
    last_acked_at: 'original opaque time',
  };
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    key,
    expectedSelection: { revisionId: uuidv7(), version: 7 },
    stateBytes: Buffer.from(JSON.stringify(state, null, 3) + '\n'),
  };
}
function ack(): ProjectSessionAcknowledgementInput {
  return {
    operationId: uuidv7(),
    acknowledgementId: uuidv7(),
    resultRevisionId: uuidv7(),
    key: input().key,
    expectedSelection: { revisionId: uuidv7(), version: 4 },
    pushId: uuidv7(),
    ackedAt: 'original opaque acknowledged time',
  };
}
function state(value: ProjectSessionBranchInput, changes: Record<string, unknown>) {
  value.stateBytes = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(value.stateBytes).toString()), ...changes })
  );
  return value;
}
const invalid = expect.objectContaining({ code: 'INVALID_INPUT' });
const refused = expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' });

it('retains exact state bytes, ordered duplicates, opaque values and original identities', () => {
  const value = input();
  const prepared = projectSessionBranch(prepareProjectSessionBranch(value, options));
  expect(Buffer.from(prepared.stateBase64, 'base64')).toEqual(Buffer.from(value.stateBytes));
  expect(prepared.stateSha256).toBe(digest(value.stateBytes));
  expect(prepared.state.branch_history).toEqual(['first', 'second', 'first']);
  expect(prepared.state.base_commit_sha).toBe('original opaque base');
  expect(prepared.state.last_acked_at).toBe('original opaque time');
  expect(prepared.key).toEqual(value.key);
  expect(prepared.operationId).toBe(value.operationId);
  expect(prepared.revisionId).toBe(value.revisionId);
  expect(prepared.expectedSelection).toEqual(value.expectedSelection);
});
it.each([null, ''])('preserves nullable and empty legacy-compatible opaque fields %s', (opaque) => {
  const value = state(input(), { base_commit_sha: opaque, last_acked_at: opaque });
  value.expectedSelection = null;
  const prepared = projectSessionBranch(prepareProjectSessionBranch(value, options));
  expect(prepared.state.base_commit_sha).toBe(opaque);
  expect(prepared.state.last_acked_at).toBe(opaque);
  expect(prepared.expectedSelection).toBeNull();
});
it('detaches all caller input and freezes original prepared branch values', () => {
  const value = input();
  const original = structuredClone(value);
  const prepared = prepareProjectSessionBranch(value, options);
  value.stateBytes.fill(0);
  value.key.target.account_id = 'changed';
  value.expectedSelection!.version = 99;
  value.revisionId = uuidv7();
  const retained = projectSessionBranch(prepared);
  expect(retained.revisionId).toBe(original.revisionId);
  expect(retained.key).toEqual(original.key);
  expect(retained.expectedSelection).toEqual(original.expectedSelection);
  expect(Buffer.from(retained.stateBase64, 'base64')).toEqual(Buffer.from(original.stateBytes));
  expect(() => retained.state.branch_history.push('changed')).toThrow();
  expect(() => {
    retained.key.target.account_id = 'changed';
  }).toThrow();
});
it.each(['target', 'repo_url', 'working_dir'])('refuses different original state %s', (field) => {
  const value = input();
  state(value, {
    [field]: field === 'target' ? { ...value.key.target, account_id: 'other' } : 'other',
  });
  expect(() => prepareProjectSessionBranch(value, options)).toThrowError(invalid);
});
it.each([
  'https://EXAMPLE.test/',
  'file:///tmp/server',
  'https://user@example.test',
  'https://example.test?q=x',
])('refuses noncanonical or unsafe account server %s', (url) => {
  const value = input();
  value.key.target.server_url = url;
  state(value, { target: value.key.target });
  expect(() => prepareProjectSessionBranch(value, options)).toThrowError(invalid);
});
it('refuses unknown account, extra state fields and invalid original selectors', () => {
  const value = input();
  value.key.target.account_id = '';
  expect(() => prepareProjectSessionBranch(value, options)).toThrowError(invalid);
  expect(() => prepareProjectSessionBranch(state(input(), { extra: true }), options)).toThrowError(
    invalid
  );
  const other = input();
  other.expectedSelection!.version = 0;
  expect(() => prepareProjectSessionBranch(other, options)).toThrowError(invalid);
});
it.each([Buffer.from([0xff]), Buffer.from('{'), Buffer.from('null')])(
  'refuses malformed original bytes %s',
  (bytes) => {
    expect(() =>
      prepareProjectSessionBranch({ ...input(), stateBytes: bytes }, options)
    ).toThrowError(invalid);
  }
);
it('refuses raw, duplicate, escaped and control-split authored secrets without changing bytes', () => {
  const secret = ['ghp_', 'A'.repeat(36)].join('');
  const value = input();
  const safe = Buffer.from(value.stateBytes).toString();
  const examples = [
    JSON.stringify({ ...JSON.parse(safe), current_branch: secret }),
    '{"current_branch":' + JSON.stringify(secret) + ',' + safe.slice(1),
    '{"current_branch":' + JSON.stringify(secret).replace('g', '\\u0067') + ',' + safe.slice(1),
    JSON.stringify({
      ...JSON.parse(safe),
      current_branch: secret.slice(0, 8) + '\0' + secret.slice(8),
    }),
  ];
  for (const raw of examples) {
    const bytes = Buffer.from(raw);
    expect(() =>
      prepareProjectSessionBranch({ ...value, stateBytes: bytes }, options)
    ).toThrowError(refused);
    expect(bytes.toString()).toBe(raw);
  }
  const bytes = Buffer.from(examples[1]!);
  const prepared = projectSessionBranch(
    prepareProjectSessionBranch({ ...value, stateBytes: bytes }, { secretAllow: [secret] })
  );
  expect(Buffer.from(prepared.stateBase64, 'base64')).toEqual(bytes);
});
it('retains copied acknowledgment input without inventing completed push or applied result', () => {
  const value = ack();
  const original = structuredClone(value);
  const prepared = prepareProjectSessionAcknowledgement(value, options);
  value.pushId = uuidv7();
  value.key.workingDir = 'changed';
  value.expectedSelection.version = 99;
  const retained = projectSessionAcknowledgement(prepared);
  expect(retained).toEqual(original);
  expect(retained).not.toHaveProperty('applied');
  expect(retained).not.toHaveProperty('completed');
  expect(Object.isFrozen(retained.key.target)).toBe(true);
});
it('refuses missing push, fabricated outcome and refused acknowledgment metadata', () => {
  expect(() =>
    prepareProjectSessionAcknowledgement({ ...ack(), pushId: '' }, options)
  ).toThrowError(invalid);
  expect(() =>
    prepareProjectSessionAcknowledgement(
      { ...ack(), applied: true } as ProjectSessionAcknowledgementInput,
      options
    )
  ).toThrowError(invalid);
  const secret = ['ghp_', 'A'.repeat(36)].join('');
  expect(() =>
    prepareProjectSessionAcknowledgement({ ...ack(), ackedAt: secret }, options)
  ).toThrowError(refused);
});
it('rejects counterfeit and cloned prepared values', () => {
  const prepared = prepareProjectSessionBranch(input(), options);
  expect(() => projectSessionBranch(structuredClone(prepared))).toThrowError(invalid);
  expect(() =>
    projectSessionAcknowledgement({ kind: 'prepared-session-acknowledgement' })
  ).toThrowError(invalid);
});
it('performs preparation without filesystem or subprocess calls', () => {
  const spies = [
    vi.spyOn(fs, 'readFileSync'),
    vi.spyOn(fs, 'writeFileSync'),
    vi.spyOn(promises, 'readFile'),
    vi.spyOn(promises, 'writeFile'),
    vi.spyOn(childProcess, 'spawn'),
    vi.spyOn(childProcess, 'execFile'),
  ];
  prepareProjectSessionBranch(input(), options);
  prepareProjectSessionAcknowledgement(ack(), options);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
