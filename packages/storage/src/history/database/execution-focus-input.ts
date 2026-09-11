import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { ShellKeySchema } from '../../pins/shell-key.js';
import { CounterSchema, digest, DigestSchema } from '../event-integrity.js';
import { type ExecutionPin, ExecutionPinSchema } from '../execution-focus.js';
import type { ArtifactRevision } from './artifacts.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';

const ScopeSchema = z.strictObject({
  rootKey: DigestSchema,
  projectId: UuidV7Schema,
  storeInstanceId: UuidV7Schema,
  repositoryInstanceId: UuidV7Schema,
  worktreeId: UuidV7Schema,
  shellKey: ShellKeySchema.refine((key) => key.kind !== 'none'),
});
const SelectionSchema = z.strictObject({
  operationId: UuidV7Schema,
  version: CounterSchema.refine((version) => version > 0),
});
const RevisionSchema = z.strictObject({
  generation: CounterSchema.refine((value) => value > 0),
  orderedHash: DigestSchema,
  eventCount: CounterSchema.refine((value) => value > 0),
  byteLength: CounterSchema.refine((value) => value > 0),
  tailEventId: UuidV7Schema,
});
const common = {
  operationId: UuidV7Schema,
  scope: ScopeSchema,
  expectedSelection: SelectionSchema.nullable(),
  secretAllow: z.array(z.string()),
};
const ChangeSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...common,
    action: z.literal('set'),
    pinBytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
    expectedArtifactRevision: RevisionSchema,
    expectedExecutionVersion: CounterSchema.refine((version) => version > 0),
  }),
  z.strictObject({ ...common, action: z.literal('clear') }),
]);

export type ProjectFocusScope = z.infer<typeof ScopeSchema>;
export type ProjectFocusSelection = z.infer<typeof SelectionSchema>;
export type ProjectFocusChange = z.infer<typeof ChangeSchema>;
interface PreparedFocusCommon {
  readonly operationId: string;
  readonly scopeJson: string;
  readonly scopeHash: string;
  readonly expectedSelection: Readonly<ProjectFocusSelection> | null;
}
export type PreparedProjectFocus = PreparedFocusCommon &
  (
    | {
        readonly action: 'clear';
        readonly pinBytesBase64: null;
        readonly pinHash: null;
        readonly target: null;
      }
    | {
        readonly action: 'set';
        readonly pinBytesBase64: string;
        readonly pinHash: string;
        readonly target: Readonly<{
          artifactId: string;
          revision: Readonly<ArtifactRevision>;
          executionVersion: number;
          bindingGeneration: number;
        }>;
      }
  );

export function projectFocusScopeJson(scope: ProjectFocusScope): string {
  const parsed = ScopeSchema.safeParse(scope);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the complete project, repository, worktree and session identity for focus',
      { cause: parsed.error }
    );
  return canonicalJson(parsed.data);
}

function pinScope(pin: ExecutionPin): ProjectFocusScope {
  if (pin.shell_key.kind === 'none')
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select a supported session identity for focus'
    );
  return {
    rootKey: pin.root_key,
    projectId: pin.project_id,
    storeInstanceId: pin.store_instance_id,
    repositoryInstanceId: pin.repository_instance_id,
    worktreeId: pin.worktree_id,
    shellKey: pin.shell_key,
  };
}
function decodePin(bytes: Uint8Array): ExecutionPin {
  return ExecutionPinSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  );
}

export function prepareProjectFocus(input: ProjectFocusChange): PreparedProjectFocus {
  const result = ChangeSchema.safeParse(input);
  if (!result.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide a set with exact artifact and execution versions, or a clear with only the exact focus selection',
      { cause: result.error }
    );
  const value = result.data;
  const scopeJson = projectFocusScopeJson(value.scope);
  refuseJsonBytes(Buffer.from(scopeJson), value.secretAllow);
  const prepared = {
    operationId: value.operationId,
    scopeJson,
    scopeHash: digest(scopeJson),
    expectedSelection: value.expectedSelection ? Object.freeze(value.expectedSelection) : null,
  };
  if (value.action === 'clear')
    return Object.freeze({
      ...prepared,
      action: 'clear',
      pinBytesBase64: null,
      pinHash: null,
      target: null,
    });

  const bytes = Buffer.from(value.pinBytes);
  refuseJsonBytes(bytes, value.secretAllow);
  let pin: ExecutionPin;
  try {
    pin = decodePin(bytes);
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide an exact valid execution pin', {
      cause,
    });
  }
  if (projectFocusScopeJson(pinScope(pin)) !== scopeJson)
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Prepare focus for the same complete project, repository, worktree and session identity'
    );
  return Object.freeze({
    ...prepared,
    action: 'set',
    pinBytesBase64: bytes.toString('base64'),
    pinHash: digest(bytes),
    target: Object.freeze({
      artifactId: pin.artifact_id,
      revision: Object.freeze(value.expectedArtifactRevision),
      executionVersion: value.expectedExecutionVersion,
      bindingGeneration: pin.binding_generation,
    }),
  });
}

export function decodeRetainedFocusPin(
  scopeJson: string,
  bytes: Uint8Array,
  pinHash: string
): ExecutionPin {
  try {
    const scope: unknown = JSON.parse(scopeJson);
    const parsedScope = ScopeSchema.parse(scope);
    if (canonicalJson(parsedScope) !== scopeJson || digest(bytes) !== pinHash)
      throw new Error('Retained focus identity does not match its bytes');
    const pin = decodePin(bytes);
    if (projectFocusScopeJson(pinScope(pin)) !== scopeJson)
      throw new Error('Retained focus belongs to another namespace');
    return pin;
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained focus is invalid; preserve the original record for explicit repair',
      { cause }
    );
  }
}
