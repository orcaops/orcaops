import { CloudWireError, TrpcRequestError } from '@orcaops/sdk';
import { type CloudSyncFailureKind, ForbiddenControlCharError } from '@orcaops/storage';

import { CloudCapabilityError } from './handshake.js';
import { scrubError } from './scrub-error.js';
import {
  isBelowMinimumError,
  isMissingProcedureError,
  isPayloadSchemaUnsupportedError,
} from './trpc-errors.js';

export function classifyCloudSyncFailure(err: unknown): {
  kind: CloudSyncFailureKind;
  message: string | null;
} {
  if (err instanceof ForbiddenControlCharError) {
    return { kind: 'content-invalid', message: scrubError(err.message) };
  }
  if (err instanceof TrpcRequestError) {
    if (isBelowMinimumError(err) || isPayloadSchemaUnsupportedError(err)) {
      return { kind: 'upgrade-required', message: scrubError(err.message) };
    }
    if (isMissingProcedureError(err)) {
      return { kind: 'server-behind', message: scrubError(err.message) };
    }
    const status = err.data?.httpStatus;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { kind: 'http-4xx', message: scrubError(err.message) };
    }
    if (typeof status === 'number' && status >= 500) {
      return { kind: 'http-5xx', message: scrubError(err.message) };
    }
    return { kind: 'network', message: scrubError(err.message) };
  }
  if (err instanceof CloudCapabilityError) {
    return { kind: err.kind, message: scrubError(err.message) };
  }
  if (err instanceof CloudWireError) {
    return { kind: 'wire-invalid', message: scrubError(err.message) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'unknown', message: scrubError(message) };
}
