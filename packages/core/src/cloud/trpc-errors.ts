import { OSS_APP_CODES, type OssAppCode } from '@orcaops/protocol';
import { TrpcRequestError } from '@orcaops/sdk';

/**
 * The typed `data.appCode` off a cloud error envelope, or null when absent or
 * outside the launch-wire vocabulary. Consumed before HTTP-status buckets
 * everywhere classification is directional: the codes are the stable wire
 * contract, while status codes overlap.
 */
export function cloudAppCodeOf(err: unknown): OssAppCode | null {
  if (!(err instanceof TrpcRequestError)) return null;
  const raw = (err.data as { appCode?: unknown }).appCode;
  return typeof raw === 'string' && Object.hasOwn(OSS_APP_CODES, raw) ? (raw as OssAppCode) : null;
}

/**
 * True when the cloud rejected this client as too old — `CLIENT_BELOW_MINIMUM`
 * (CLI version under the floor) or `PROTOCOL_BELOW_MINIMUM` (protocol under
 * the floor). Terminal until the install is upgraded: retrying with the same
 * binary deterministically fails again.
 */
export function isBelowMinimumError(err: unknown): boolean {
  const code = cloudAppCodeOf(err);
  return (
    code === OSS_APP_CODES.CLIENT_BELOW_MINIMUM || code === OSS_APP_CODES.PROTOCOL_BELOW_MINIMUM
  );
}

/**
 * True when the cloud no longer accepts this payload's `schema_version`
 * (`PAYLOAD_SCHEMA_UNSUPPORTED`, 422 with `{payload, expected, received}`).
 * Terminal for the payload — an upgrade, not a retry, resolves it.
 */
export function isPayloadSchemaUnsupportedError(err: unknown): boolean {
  return cloudAppCodeOf(err) === OSS_APP_CODES.PAYLOAD_SCHEMA_UNSUPPORTED;
}

/**
 * True when the cloud structurally reports a missing row. The source-plan read
 * paths key on this tRPC code, so the predicate lives once next to the cloud
 * error handling rather than being inlined at each call site.
 */
export function isNotFoundError(err: unknown): boolean {
  return err instanceof TrpcRequestError && err.data.code === 'NOT_FOUND';
}

/**
 * True when the cloud structurally reports that the procedure itself is
 * absent. The typed appCode distinguishes deployment skew from a missing row;
 * callers check this before `isNotFoundError` because both may carry the tRPC
 * NOT_FOUND code.
 */
export function isMissingProcedureError(err: unknown): boolean {
  return cloudAppCodeOf(err) === OSS_APP_CODES.UNKNOWN_PROCEDURE;
}

/**
 * True when a thrown cloud error is a FORBIDDEN / 403. The `plan review` verbs
 * raise it for an author-only `push` by a non-author and a `propose
 * --supersedes` over a proposal the caller doesn't own. Checks the tRPC `code`
 * OR the bare `httpStatus` (the envelope may carry only one), mirroring
 * `isNotFoundError`. Both forbidden cases share this shape — the CALLER selects
 * the user-facing message from command + flag context.
 */
export function isForbiddenError(err: unknown): boolean {
  return (
    err instanceof TrpcRequestError &&
    (err.data.code === 'FORBIDDEN' || err.data.httpStatus === 403)
  );
}

/**
 * True when a thrown cloud error is a CONFLICT / 409 — raised when the plan is
 * no longer IN_REVIEW (push/propose on an APPROVED or PINNED plan; comment on a
 * PINNED plan). NOTE the `push` publish (CAS) conflict does NOT throw — the SDK
 * maps it into `reviewPush`'s discriminated `conflict` arm — so this predicate
 * only ever fires on the status-guard conflicts, never the CAS race.
 */
export function isConflictError(err: unknown): boolean {
  return (
    err instanceof TrpcRequestError && (err.data.code === 'CONFLICT' || err.data.httpStatus === 409)
  );
}
