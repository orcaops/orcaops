import { expect, it } from 'vitest';

import {
  prepareProjectSessionBranch,
  projectSessionBranch,
  type ProjectSessionBranchPreparation,
} from './session-branch-input.js';
import { validateSessionBranchObservation } from './session-branch-observation.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const head = 'a'.repeat(40);
const key = {
  target: { server_url: 'https://example.test', org_id: 'org', account_id: 'account' },
  repoUrl: 'original repository',
  workingDir: '/original checkout',
};
type State = ProjectSessionBranchPreparation['state'];
function state(overrides: Partial<State> = {}): State {
  return {
    schema_version: 1,
    target: key.target,
    repo_url: key.repoUrl,
    working_dir: key.workingDir,
    current_branch: 'main',
    branch_history: [],
    base_commit_sha: head,
    last_acked_at: null,
    ...overrides,
  };
}
function prepared(value: State) {
  return projectSessionBranch(
    prepareProjectSessionBranch(
      {
        operationId: uuidv7(),
        revisionId: uuidv7(),
        key,
        expectedSelection: null,
        stateBytes: Buffer.from(JSON.stringify(value)),
      },
      { secretAllow: [] }
    )
  );
}

it('starts an unacknowledged session at the observed head', () => {
  expect(
    validateSessionBranchObservation(prepared(state()), null, {
      headOid: head,
      priorBranchExists: null,
    }).changed
  ).toBe(true);
  expect(() =>
    validateSessionBranchObservation(prepared(state({ last_acked_at: 'invented' })), null, {
      headOid: head,
      priorBranchExists: null,
    })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

it('keeps unchanged branch state even when HEAD advanced', () => {
  const previous = state({ branch_history: ['original'], last_acked_at: 'original time' });
  expect(
    validateSessionBranchObservation(prepared(previous), previous, {
      headOid: 'b'.repeat(40),
      priorBranchExists: null,
    }).changed
  ).toBe(false);
  expect(() =>
    validateSessionBranchObservation(prepared(state()), previous, {
      headOid: head,
      priorBranchExists: null,
    })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

it('starts a distinct branch without carrying the previous acknowledgment', () => {
  const previous = state({ branch_history: ['older'], last_acked_at: 'original time' });
  const next = state({ current_branch: 'topic', base_commit_sha: 'b'.repeat(40) });
  expect(
    validateSessionBranchObservation(prepared(next), previous, {
      headOid: 'b'.repeat(40),
      priorBranchExists: true,
    }).changed
  ).toBe(true);
  expect(() =>
    validateSessionBranchObservation(
      prepared({ ...next, last_acked_at: previous.last_acked_at }),
      previous,
      { headOid: 'b'.repeat(40), priorBranchExists: true }
    )
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

it('retains rename order and duplicates while capping before stripping the current branch', () => {
  const previous = state({
    branch_history: [
      'first',
      'duplicate',
      'duplicate',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'topic',
    ],
    base_commit_sha: '',
    last_acked_at: '',
  });
  const next = state({
    current_branch: 'topic',
    branch_history: [
      'duplicate',
      'duplicate',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'main',
    ],
    base_commit_sha: '',
    last_acked_at: '',
  });
  expect(
    validateSessionBranchObservation(prepared(next), previous, {
      headOid: 'b'.repeat(40),
      priorBranchExists: false,
    }).changed
  ).toBe(true);
});

it('uses the observed head only for a null prior base during rename', () => {
  const previous = state({ base_commit_sha: null, branch_history: ['main'] });
  expect(
    validateSessionBranchObservation(
      prepared(state({ current_branch: 'topic', branch_history: ['main'] })),
      previous,
      { headOid: head, priorBranchExists: false }
    ).changed
  ).toBe(true);
});

it.each([
  { headOid: '', priorBranchExists: null },
  { headOid: head, priorBranchExists: true },
  { headOid: head, priorBranchExists: false },
])('refuses incomplete or irrelevant initial Git observations: %j', (observation) => {
  expect(() => validateSessionBranchObservation(prepared(state()), null, observation)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
});

it('refuses detached state and an unknown branch-existence result', () => {
  expect(() =>
    validateSessionBranchObservation(prepared(state({ current_branch: 'HEAD' })), null, {
      headOid: head,
      priorBranchExists: null,
    })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() =>
    validateSessionBranchObservation(prepared(state({ current_branch: 'topic' })), state(), {
      headOid: head,
      priorBranchExists: null,
    })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

it('detaches the original observation and refuses another retained scope', () => {
  const observation = { headOid: head, priorBranchExists: null };
  const result = validateSessionBranchObservation(prepared(state()), null, observation);
  observation.headOid = 'b'.repeat(40);
  expect(result.observation.headOid).toBe(head);
  expect(Object.isFrozen(result.observation)).toBe(true);
  expect(() =>
    validateSessionBranchObservation(prepared(state()), state({ working_dir: '/other' }), {
      headOid: head,
      priorBranchExists: null,
    })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
