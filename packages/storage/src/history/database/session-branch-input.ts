import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { canonicalizeBaseUrl } from '../../source-plan/canonical-base-url.js';
import { digest } from '../event-integrity.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';
import {
  SessionBranchKeySchema as key,
  SessionBranchSelectionSchema as selection,
  SessionBranchStateSchema as state,
} from './session-branch-codec.js';

const text = z.string().min(1);
const publication = z.strictObject({
  operationId: UuidV7Schema,
  revisionId: UuidV7Schema,
  key,
  expectedSelection: selection.nullable(),
  stateBytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
});
const acknowledgement = z.strictObject({
  operationId: UuidV7Schema,
  acknowledgementId: UuidV7Schema,
  resultRevisionId: UuidV7Schema,
  key,
  expectedSelection: selection,
  pushId: UuidV7Schema,
  ackedAt: text,
});
const options = z.strictObject({ secretAllow: z.array(z.string()) });

export type ProjectSessionBranchKey = z.infer<typeof key>;
export type ProjectSessionBranchSelection = z.infer<typeof selection>;
export type ProjectSessionBranchInput = z.infer<typeof publication>;
export type ProjectSessionAcknowledgementInput = z.infer<typeof acknowledgement>;
export type ProjectSessionInputOptions = z.infer<typeof options>;
export interface PreparedProjectSessionBranch {
  readonly kind: 'prepared-session-branch';
}
export interface PreparedProjectSessionAcknowledgement {
  readonly kind: 'prepared-session-acknowledgement';
}
export interface ProjectSessionBranchPreparation extends Omit<
  ProjectSessionBranchInput,
  'stateBytes'
> {
  readonly stateBase64: string;
  readonly stateSha256: string;
  readonly state: z.infer<typeof state>;
}
const branches = new WeakMap<PreparedProjectSessionBranch, ProjectSessionBranchPreparation>();
const acknowledgements = new WeakMap<
  PreparedProjectSessionAcknowledgement,
  ProjectSessionAcknowledgementInput
>();

function invalid(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'INVALID_INPUT',
    'Provide exact session identities, canonical known account scope and original state bytes',
    { cause }
  );
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid(result.error);
  return result.data;
}
function copy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    return invalid(cause);
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function exactKey(value: ProjectSessionBranchKey): void {
  let url: URL;
  try {
    url = new URL(value.target.server_url);
  } catch (cause) {
    return invalid(cause);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    canonicalizeBaseUrl(value.target.server_url) !== value.target.server_url
  )
    invalid();
}
export function prepareProjectSessionBranch(
  input: ProjectSessionBranchInput,
  inputOptions: ProjectSessionInputOptions
): PreparedProjectSessionBranch {
  const value = parse(publication, copy(input));
  const allow = parse(options, copy(inputOptions)).secretAllow;
  const { stateBytes, ...metadata } = value;
  refuseJsonBytes(Buffer.from(canonicalJson(metadata)), allow);
  const bytes = Buffer.from(stateBytes);
  refuseJsonBytes(bytes, allow);
  let decoded: z.infer<typeof state>;
  try {
    decoded = parse(state, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (cause) {
    return invalid(cause);
  }
  exactKey(value.key);
  if (
    canonicalJson(decoded.target) !== canonicalJson(value.key.target) ||
    decoded.repo_url !== value.key.repoUrl ||
    decoded.working_dir !== value.key.workingDir
  )
    invalid();
  const prepared = Object.freeze({ kind: 'prepared-session-branch' as const });
  branches.set(
    prepared,
    freeze({
      ...metadata,
      stateBase64: bytes.toString('base64'),
      stateSha256: digest(bytes),
      state: decoded,
    })
  );
  return prepared;
}
export function projectSessionBranch(
  prepared: PreparedProjectSessionBranch
): ProjectSessionBranchPreparation {
  const value = branches.get(prepared);
  if (!value) invalid();
  return value;
}
export function prepareProjectSessionAcknowledgement(
  input: ProjectSessionAcknowledgementInput,
  inputOptions: ProjectSessionInputOptions
): PreparedProjectSessionAcknowledgement {
  const value = parse(acknowledgement, copy(input));
  const allow = parse(options, copy(inputOptions)).secretAllow;
  refuseJsonBytes(Buffer.from(canonicalJson(value)), allow);
  exactKey(value.key);
  const prepared = Object.freeze({ kind: 'prepared-session-acknowledgement' as const });
  acknowledgements.set(prepared, freeze(value));
  return prepared;
}
export function projectSessionAcknowledgement(
  prepared: PreparedProjectSessionAcknowledgement
): ProjectSessionAcknowledgementInput {
  const value = acknowledgements.get(prepared);
  if (!value) invalid();
  return value;
}
