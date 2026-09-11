import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { canonicalizeBaseUrl } from '../../source-plan/canonical-base-url.js';
import { digest } from '../event-integrity.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';

const failure = z.strictObject({
  operationId: UuidV7Schema,
  revisionId: UuidV7Schema,
  artifactId: UuidV7Schema,
  target: z.strictObject({
    server_url: z.string().min(1),
    org_id: z.string().min(1),
    account_id: z.string().min(1),
  }),
  kind: z.enum([
    'timeout',
    'http-4xx',
    'http-5xx',
    'network',
    'wire-invalid',
    'content-invalid',
    'upgrade-required',
    'server-behind',
    'unknown',
  ]),
  message: z.string().nullable(),
  attemptedAt: z.string().min(1),
  attemptStartedAt: z.string().min(1),
});
export type ProjectCloudSyncFailureInput = z.infer<typeof failure>;
export interface PreparedProjectCloudSyncFailure {
  readonly kind: 'prepared-cloud-sync-failure';
}
export interface CloudSyncFailurePreparation {
  readonly input: ProjectCloudSyncFailureInput;
  readonly inputSha256: string;
}
const failures = new WeakMap<PreparedProjectCloudSyncFailure, CloudSyncFailurePreparation>();

function invalid(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'INVALID_INPUT',
    'Provide the original cloud failure identities, known canonical account scope and scrubbed failure fields',
    { cause }
  );
}

export function prepareProjectCloudSyncFailure(
  input: ProjectCloudSyncFailureInput,
  secretAllow: readonly string[]
): PreparedProjectCloudSyncFailure {
  let copied: unknown;
  try {
    copied = structuredClone(input);
  } catch (cause) {
    return invalid(cause);
  }
  const parsed = failure.safeParse(copied);
  if (!parsed.success) invalid(parsed.error);
  const allowed = z.array(z.string()).safeParse(secretAllow);
  if (!allowed.success) invalid(allowed.error);
  const value = parsed.data;
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
  const bytes = Buffer.from(canonicalJson(value));
  refuseJsonBytes(bytes, allowed.data);
  Object.freeze(value.target);
  Object.freeze(value);
  const prepared = Object.freeze({ kind: 'prepared-cloud-sync-failure' as const });
  failures.set(prepared, Object.freeze({ input: value, inputSha256: digest(bytes) }));
  return prepared;
}

export function cloudSyncFailure(
  prepared: PreparedProjectCloudSyncFailure
): CloudSyncFailurePreparation {
  const value = failures.get(prepared);
  if (!value) invalid();
  return value;
}

export { failure as CloudSyncFailureInputSchema };
