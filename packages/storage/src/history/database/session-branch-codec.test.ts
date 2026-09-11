import { expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import {
  decodeRetainedSessionBranch,
  parseSessionBranchKey,
  type SessionBranchState,
} from './session-branch-codec.js';
import { prepareProjectSessionBranch } from './session-branch-input.js';

const key = {
  target: {
    server_url: 'https://example.test',
    org_id: 'original org',
    account_id: 'original account',
  },
  repoUrl: 'original repo',
  workingDir: '/original checkout',
};
function state(): SessionBranchState {
  return {
    schema_version: 1,
    target: { ...key.target },
    repo_url: key.repoUrl,
    working_dir: key.workingDir,
    current_branch: 'current',
    branch_history: ['old', 'old', 'earlier'],
    base_commit_sha: null,
    last_acked_at: null,
  };
}
function retained(value = state()) {
  const stateBytes = Buffer.from(' ' + JSON.stringify(value) + '\n');
  return { key, stateBytes, stateSha256: digest(stateBytes) };
}
it('returns detached exact bytes and ordered retained state without normalizing history', () => {
  const input = retained(),
    bytes = Buffer.from(input.stateBytes),
    result = decodeRetainedSessionBranch(input);
  input.stateBytes.fill(0);
  expect(Buffer.from(result.stateBase64, 'base64')).toEqual(bytes);
  expect(result.state.branch_history).toEqual(['old', 'old', 'earlier']);
  expect(result.state.base_commit_sha).toBeNull();
  expect(result.state.last_acked_at).toBeNull();
  expect(Object.isFrozen(result.state.branch_history)).toBe(true);
  expect(Object.isFrozen(result.state.target)).toBe(true);
});
it('preserves existing opaque and empty nullable scalar values', () => {
  const value = { ...state(), base_commit_sha: 'original opaque base', last_acked_at: '' };
  expect(decodeRetainedSessionBranch(retained(value)).state).toEqual(value);
});
it('keeps authoring refusal separate from retained decoding', () => {
  const value = { ...state(), current_branch: 'ghp_' + 'A'.repeat(36) };
  const input = retained(value);
  expect(decodeRetainedSessionBranch(input).state.current_branch).toBe(value.current_branch);
  expect(() =>
    prepareProjectSessionBranch(
      {
        operationId: uuidv7(),
        revisionId: uuidv7(),
        key,
        expectedSelection: null,
        stateBytes: input.stateBytes,
      },
      { secretAllow: [] }
    )
  ).toThrow(expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' }));
});
it.each(['hash', 'bytes', 'utf8', 'schema', 'scope'] as const)(
  'refuses retained %s inconsistency as integrity damage',
  (kind) => {
    const input = retained();
    if (kind === 'hash') input.stateSha256 = 'a'.repeat(64);
    if (kind === 'bytes') input.stateBytes = Buffer.from('changed');
    if (kind === 'utf8') {
      input.stateBytes = Buffer.from([0xff]);
      input.stateSha256 = digest(input.stateBytes);
    }
    if (kind === 'schema') {
      input.stateBytes = Buffer.from('{"schema_version":2}');
      input.stateSha256 = digest(input.stateBytes);
    }
    if (kind === 'scope') input.key = { ...key, workingDir: '/other' };
    expect(() => decodeRetainedSessionBranch(input)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  }
);
it('parses the original finite lookup tuple into an immutable detached key', () => {
  const input = structuredClone(key),
    parsed = parseSessionBranchKey(input);
  input.target.account_id = 'changed';
  expect(parsed).toEqual(key);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.target)).toBe(true);
});
it.each([
  { ...key, target: { ...key.target, account_id: '' } },
  { ...key, target: { ...key.target, server_url: 'https://example.test/' } },
  { ...key, target: { ...key.target, server_url: 'https://user@example.test' } },
  { ...key, extra: 'unknown' },
])('refuses a malformed or unowned lookup tuple', (input) => {
  expect(() => parseSessionBranchKey(input)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
});
