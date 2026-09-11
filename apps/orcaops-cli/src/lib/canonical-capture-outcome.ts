import { scrubAndBound } from '@orcaops/core';
import { CliAuthError } from '@orcaops/sdk';
import { HistoryError } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';
import { HistoryPersistenceError } from '@orcaops/storage/history/primitives';

import { OrcaopsError } from '../io/errors.js';
import { toErrorEnvelope } from '../io/output.js';

export function captureFailure(cause: unknown) {
  if (cause instanceof ProjectDatabaseError) {
    const { code, message, reason } = toErrorEnvelope(cause).error;
    return { code, message, ...(reason ? { reason } : {}) };
  }
  const legacy =
    cause instanceof OrcaopsError ||
    cause instanceof CliAuthError ||
    cause instanceof HistoryError ||
    cause instanceof HistoryPersistenceError;
  return {
    code: legacy ? scrubAndBound(cause.code, 1024) : 'POST_CAPTURE_FAILED',
    message: scrubAndBound(cause instanceof Error ? cause.message : String(cause), 1024),
  };
}
