import { type DatabaseJson, ProjectDatabaseError } from '@orcaops/storage/history/database';

import { copyDatabaseAuthoredValue, refuseDatabaseAuthoredSecrets } from '../authored-input.js';

export interface SetupProjectDatabaseInput {
  readonly cwd: string;
  readonly root: string;
  readonly projectId?: string;
  readonly authoredPayloads: readonly DatabaseJson[];
  readonly secretAllow: readonly string[];
}
export function refuseSetupSecrets(value: unknown, allow: readonly string[]): void {
  refuseDatabaseAuthoredSecrets(value, allow, 'setup');
}
export function prepareDatabaseSetupInput(
  input: SetupProjectDatabaseInput
): SetupProjectDatabaseInput {
  const cwd = input.cwd;
  const root = input.root;
  const projectId = input.projectId;
  if (
    !Array.isArray(input.secretAllow) ||
    input.secretAllow.some((value) => typeof value !== 'string') ||
    !Array.isArray(input.authoredPayloads)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Supply explicit authored JSON payloads and established secret allowances before setup'
    );
  const secretAllow = Object.freeze([...input.secretAllow]);
  const authoredPayloads = copyDatabaseAuthoredValue(input.authoredPayloads) as DatabaseJson[];
  refuseSetupSecrets({ cwd, root, projectId: projectId ?? null, authoredPayloads }, secretAllow);
  return Object.freeze({ cwd, root, projectId, authoredPayloads, secretAllow });
}
