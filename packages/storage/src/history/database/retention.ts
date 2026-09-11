import { z } from 'zod';

import type { ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { gitRetentionPreparation, type PreparedProjectGitRetention } from './retention-input.js';
import {
  advanceRetentionRecords,
  insertRetentionRecords,
  readRetentionRecords,
  retentionId,
} from './retention-records.js';
import {
  assertRetainedPublicationTargets,
  assertRetentionTarget,
  bindRetainedPublications,
  prepareRetainedPublicationInputs,
  staleRetention,
} from './retention-targets.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';
import type { DatabaseJson } from './values.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';

function json(value: unknown): DatabaseJson {
  return JSON.parse(canonicalJson(value)) as DatabaseJson;
}
function authority(handle: ProjectDatabase, repositoryId: string): void {
  if (handle.authority.repositoryInstanceId !== repositoryId)
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Git retention belongs to another repository instance; select its original validated authority'
    );
}
export async function beginProjectGitRetention(
  handle: ProjectDatabase,
  prepared: PreparedProjectGitRetention,
  options: ProjectOperationOptions = {}
) {
  const input = gitRetentionPreparation(prepared);
  authority(handle, input.repositoryInstanceId);
  if (input.target.kind !== 'capture')
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Review publication requires its fixed review-engine aggregate with exact semantic evidence validation'
    );
  prepareRetainedPublicationInputs(handle, input, input.admissionOperationId);
  return runProjectOperation(
    handle,
    {
      operationId: input.admissionOperationId,
      kind: 'git.retention.begin',
      target: json({
        originalOperationId: input.operationId,
        repositoryInstanceId: input.repositoryInstanceId,
      }),
      payload: json(input),
      expectedState: json(input.target),
      intentChange: false,
    },
    (tx) => {
      if (readRetentionRecords(tx, input.operationId))
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'Original Git operation already has another admission identity; retain its original request or start a new operation'
        );
      assertRetentionTarget(tx, input);
      assertRetainedPublicationTargets(tx, input);
      insertRetentionRecords(tx, input);
      return {
        originalOperationId: input.operationId,
        transitionId: input.preparedTransitionId,
        state: 'prepared',
      };
    },
    options
  );
}
export async function settleProjectGitRetention(
  handle: ProjectDatabase,
  prepared: PreparedProjectGitRetention,
  expectedTransitionId: string,
  selectedTransitionId: string,
  options: ProjectOperationOptions = {}
) {
  const input = gitRetentionPreparation(prepared);
  retentionId(expectedTransitionId);
  retentionId(selectedTransitionId);
  authority(handle, input.repositoryInstanceId);
  if (input.target.kind !== 'capture')
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Review publication requires its fixed review-engine aggregate with exact semantic evidence validation'
    );
  prepareRetainedPublicationInputs(handle, input, input.operationId);
  return runProjectOperation(
    handle,
    {
      operationId: input.operationId,
      kind: 'git.retention.select',
      target: json({
        originalOperationId: input.operationId,
        repositoryInstanceId: input.repositoryInstanceId,
      }),
      payload: json({ input, selectedTransitionId }),
      expectedState: json({ transitionId: expectedTransitionId, target: input.target }),
      intentChange: false,
    },
    (tx) => {
      const current = readRetentionRecords(tx, input.operationId);
      if (!current)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'Original Git publication intent is missing; preserve any refs and use explicit repair'
        );
      if (canonicalJson(current.input) !== canonicalJson(input))
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'This Git operation identifies different retained input; use its original request or an explicitly new operation'
        );
      if (
        current.current.kind !== 'prepared' ||
        current.current.transitionId !== expectedTransitionId
      )
        staleRetention();
      assertRetentionTarget(tx, input);
      assertRetainedPublicationTargets(tx, input);
      advanceRetentionRecords(tx, current, {
        transitionId: selectedTransitionId,
        kind: 'selected',
        commandOperationId: input.operationId,
        retirementReason: null,
      });
      bindRetainedPublications(tx, input);
      return {
        originalOperationId: input.operationId,
        transitionId: selectedTransitionId,
        state: 'selected',
        publicationIds: input.publications.map((publication) => publication.publicationId),
      };
    },
    options
  );
}
const retirementSchema = z.strictObject({
  operationId: z.string().refine(isUuidV7),
  originalOperationId: z.string().refine(isUuidV7),
  expectedTransitionId: z.string().refine(isUuidV7),
  transitionId: z.string().refine(isUuidV7),
  reason: z.string().min(1),
  secretAllow: z.array(z.string()),
});
export type RetireProjectGitRetention = z.input<typeof retirementSchema>;
export async function retireProjectGitRetention(
  handle: ProjectDatabase,
  request: RetireProjectGitRetention,
  options: ProjectOperationOptions = {}
) {
  const parsed = retirementSchema.safeParse(request);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide exact original operation and transition identities with an explicit retirement reason',
      { cause: parsed.error }
    );
  const { secretAllow, ...input } = parsed.data;
  if (input.operationId === input.originalOperationId)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Retirement requires a distinct command ID; never replace an original terminal result'
    );
  try {
    assertNoSecretsInPayload(input, secretAllow);
  } catch (cause) {
    if (!(cause instanceof SecretInPayloadError)) throw cause;
    throw new ProjectDatabaseError(
      'SECRET_IN_PAYLOAD',
      'Remove or redescribe refused retirement input before any write',
      { cause }
    );
  }
  return runProjectOperation(
    handle,
    {
      operationId: input.operationId,
      kind: 'git.retention.retire',
      target: json({ originalOperationId: input.originalOperationId }),
      payload: json({ transitionId: input.transitionId, reason: input.reason }),
      expectedState: input.expectedTransitionId,
      intentChange: false,
    },
    (tx) => {
      const current = readRetentionRecords(tx, input.originalOperationId);
      if (!current)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'Original Git publication intent is missing; preserve unknown refs for explicit repair'
        );
      authority(handle, current.input.repositoryInstanceId);
      if (
        current.current.kind === 'retired' ||
        current.current.transitionId !== input.expectedTransitionId
      )
        staleRetention();
      advanceRetentionRecords(tx, current, {
        transitionId: input.transitionId,
        kind: 'retired',
        commandOperationId: input.operationId,
        retirementReason: input.reason,
      });
      return {
        originalOperationId: input.originalOperationId,
        transitionId: input.transitionId,
        state: 'retired',
      };
    },
    options
  );
}
