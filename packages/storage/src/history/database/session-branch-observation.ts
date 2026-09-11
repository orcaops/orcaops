import { ProjectDatabaseError } from './errors.js';
import type { ProjectSessionBranchPreparation } from './session-branch-input.js';
import { canonicalJson } from '../../events/canonical-json.js';

export interface SessionBranchGitObservation {
  readonly headOid: string;
  readonly priorBranchExists: boolean | null;
}

type State = ProjectSessionBranchPreparation['state'];

function invalid(): never {
  throw new ProjectDatabaseError(
    'INVALID_INPUT',
    'Provide session state matching the original Git observation and retained prior state'
  );
}

export function validateSessionBranchObservation(
  proposed: ProjectSessionBranchPreparation,
  previous: State | null,
  observation: SessionBranchGitObservation
): Readonly<{ changed: boolean; observation: SessionBranchGitObservation }> {
  const observed = structuredClone(observation);
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(observed.headOid) ||
    ![null, true, false].includes(observed.priorBranchExists) ||
    Object.keys(observed).sort().join(',') !== 'headOid,priorBranchExists' ||
    proposed.state.current_branch === 'HEAD'
  )
    invalid();
  if (
    previous !== null &&
    (canonicalJson(previous.target) !== canonicalJson(proposed.state.target) ||
      previous.repo_url !== proposed.state.repo_url ||
      previous.working_dir !== proposed.state.working_dir)
  )
    invalid();
  const changed = previous === null || previous.current_branch !== proposed.state.current_branch;
  let expected: State;
  if (!changed) {
    if (observed.priorBranchExists !== null) invalid();
    expected = previous!;
  } else if (previous === null || observed.priorBranchExists === true) {
    if (previous === null && observed.priorBranchExists !== null) invalid();
    expected = {
      ...proposed.state,
      branch_history: [],
      base_commit_sha: observed.headOid,
      last_acked_at: null,
    };
  } else {
    if (observed.priorBranchExists !== false) invalid();
    const history = [...previous.branch_history];
    if (!history.includes(previous.current_branch)) history.push(previous.current_branch);
    // Cap before stripping the new branch, matching the existing wire producer.
    const retained = history.slice(-10).filter((name) => name !== proposed.state.current_branch);
    expected = {
      ...proposed.state,
      branch_history: retained,
      base_commit_sha: previous.base_commit_sha ?? observed.headOid,
      last_acked_at: previous.last_acked_at,
    };
  }
  if (canonicalJson(expected) !== canonicalJson(proposed.state)) invalid();
  return Object.freeze({ changed, observation: Object.freeze(observed) });
}
