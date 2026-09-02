import {
  ArtifactNotFoundError,
  CloudCapabilityError,
  ImportedArtifactLocalOnlyError,
  isBelowMinimumError,
  isMissingProcedureError,
  isPayloadSchemaUnsupportedError,
  MissingGitRemoteError,
  NotConnectedError,
} from '@orcaops/core';
import { PathContainmentError } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from './errors.js';

/**
 * Map a thrown error from a cloud-touching CLI command (`push`, `plan pull`,
 * `plan upload`) into a structured error envelope. Shared mapping:
 *
 *   - `OrcaopsError` → passthrough (already structured)
 *   - `NotConnectedError`    → `NOT_CONNECTED`
 *   - `ArtifactNotFoundError` → `UNKNOWN_ARTIFACT`
 *   - `ImportedArtifactLocalOnlyError` → `IMPORTED_ARTIFACT_LOCAL_ONLY`
 *   - `MissingGitRemoteError` → `MISSING_GIT_REMOTE`
 *   - `PathContainmentError`  → `INTERNAL`
 *   - any other `Error`      → `CLOUD_ERROR`
 *
 * There is deliberately NO ZodError special-case here: every surface that
 * reaches this envelope is cloud-derived (a `TrpcRequestError`, a transport
 * failure, or a cloud-data `*.parse` inside `writePullCacheRecord`), so a raw
 * `ZodError` here is corrupt CLOUD DATA and `CLOUD_ERROR` is the correct label.
 * User-INPUT parse errors are mapped to `INVALID_INPUT` at their own parse site
 * (e.g. `plan upload`'s `OssSourcePlanUploadPayload.parse`) BEFORE they would
 * reach this function, so they never get mislabeled here. The pull/upload arms
 * for ArtifactNotFound/MissingGitRemote are harmless there (those commands never
 * throw them) — carrying the full union keeps one shared mapping.
 */
export function toCloudErrorEnvelope(err: unknown): unknown {
  if (err instanceof OrcaopsError) return err;
  // Typed launch negotiation errors, ahead of the generic flatten so they
  // reach the user with their remediation even from boundaries no verb-level
  // mapper covers (the shared review ping, mutations, push). Verb-specific
  // mappers run first in their own catch and pass through above as
  // OrcaopsError, so these arms never shadow a tailored message.
  if (isBelowMinimumError(err)) {
    return new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      'The cloud rejected this CLI as below its minimum supported version. Upgrade your orcaops install, then re-run the command.'
    );
  }
  if (isPayloadSchemaUnsupportedError(err)) {
    return new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      "The cloud no longer accepts this payload's schema version. Upgrade your orcaops install, then re-run the command."
    );
  }
  if (isMissingProcedureError(err)) {
    return new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      'The cloud does not expose this procedure yet (deployment skew — the server is behind this CLI). Retry after the cloud deploy.'
    );
  }
  // The PROACTIVE twin of the three arms above: those classify a rejection the
  // cloud already made, this one carries a refusal taken locally from the
  // handshake before the request went out. Its message is already
  // remediation-bearing, so it passes through verbatim.
  if (err instanceof CloudCapabilityError) {
    return new OrcaopsError(ErrorCodes.CLOUD_ERROR, err.message);
  }
  if (err instanceof NotConnectedError) {
    return new OrcaopsError(ErrorCodes.NOT_CONNECTED, 'Not connected. Run `orcaops login` first.');
  }
  if (err instanceof ArtifactNotFoundError) {
    return new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, err.message);
  }
  if (err instanceof ImportedArtifactLocalOnlyError) {
    return new OrcaopsError(ErrorCodes.IMPORTED_ARTIFACT_LOCAL_ONLY, err.message);
  }
  if (err instanceof MissingGitRemoteError) {
    return new OrcaopsError(ErrorCodes.MISSING_GIT_REMOTE, err.message);
  }
  if (err instanceof PathContainmentError) {
    return new OrcaopsError(ErrorCodes.INTERNAL, err.message, err.label);
  }
  if (err instanceof Error) {
    return new OrcaopsError(ErrorCodes.CLOUD_ERROR, err.message);
  }
  return err;
}
