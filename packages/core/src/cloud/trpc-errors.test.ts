import { describe, expect, it } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';

import {
  cloudAppCodeOf,
  isBelowMinimumError,
  isMissingProcedureError,
  isNotFoundError,
  isPayloadSchemaUnsupportedError,
} from './trpc-errors.js';

describe('isNotFoundError', () => {
  it('is true for a NOT_FOUND procedure code', () => {
    expect(isNotFoundError(new TrpcRequestError('x', { code: 'NOT_FOUND', httpStatus: 404 }))).toBe(
      true
    );
  });

  it('does not infer not-found from a bare HTTP status', () => {
    expect(isNotFoundError(new TrpcRequestError('x', { httpStatus: 404 }))).toBe(false);
  });

  it('is false for other tRPC errors', () => {
    expect(isNotFoundError(new TrpcRequestError('x', { code: 'CONFLICT', httpStatus: 409 }))).toBe(
      false
    );
    expect(isNotFoundError(new TrpcRequestError('x', { httpStatus: 500 }))).toBe(false);
  });

  it('is false for non-TrpcRequestError values', () => {
    expect(isNotFoundError(new Error('nope'))).toBe(false);
    expect(isNotFoundError({ data: { httpStatus: 404 } })).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });
});

describe('isMissingProcedureError', () => {
  it('does not infer a missing procedure from NOT_IMPLEMENTED or a bare 501', () => {
    expect(
      isMissingProcedureError(
        new TrpcRequestError('x', { code: 'NOT_IMPLEMENTED', httpStatus: 501 })
      )
    ).toBe(false);
    expect(isMissingProcedureError(new TrpcRequestError('x', { httpStatus: 501 }))).toBe(false);
  });

  it('does not infer a missing procedure from error prose', () => {
    expect(
      isMissingProcedureError(
        new TrpcRequestError('No "query"-procedure on path "sourcePlan.reviewDetail"', {
          code: 'NOT_FOUND',
          httpStatus: 404,
        })
      )
    ).toBe(false);
    expect(
      isMissingProcedureError(new TrpcRequestError('Procedure not found', { httpStatus: 404 }))
    ).toBe(false);
  });

  it('is false for a plain missing-row NOT_FOUND (no procedure message)', () => {
    expect(
      isMissingProcedureError(
        new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 })
      )
    ).toBe(false);
  });

  it('typed UNKNOWN_PROCEDURE outranks the overlapping NOT_FOUND code', () => {
    const skew = new TrpcRequestError('anything', {
      code: 'NOT_FOUND',
      httpStatus: 404,
      appCode: 'UNKNOWN_PROCEDURE',
    });
    expect(isNotFoundError(skew)).toBe(true);
    expect(isMissingProcedureError(skew)).toBe(true);
  });

  it('is false for other tRPC errors and non-TrpcRequestError values', () => {
    expect(
      isMissingProcedureError(new TrpcRequestError('x', { code: 'CONFLICT', httpStatus: 409 }))
    ).toBe(false);
    expect(isMissingProcedureError(new Error('No procedure on path'))).toBe(false);
    expect(isMissingProcedureError(null)).toBe(false);
  });
});

describe('cloudAppCodeOf', () => {
  it('returns a launch-wire appCode off the error envelope', () => {
    expect(
      cloudAppCodeOf(
        new TrpcRequestError('x', { httpStatus: 422, appCode: 'CLIENT_BELOW_MINIMUM' })
      )
    ).toBe('CLIENT_BELOW_MINIMUM');
  });

  it('returns null for absent, non-string, or out-of-vocabulary appCodes', () => {
    expect(cloudAppCodeOf(new TrpcRequestError('x', { httpStatus: 422 }))).toBeNull();
    expect(cloudAppCodeOf(new TrpcRequestError('x', { appCode: 42 } as never))).toBeNull();
    expect(
      cloudAppCodeOf(new TrpcRequestError('x', { appCode: 'SOURCE_PLAN_PUBLISH_CONFLICT' }))
    ).toBeNull();
    expect(cloudAppCodeOf(new Error('nope'))).toBeNull();
  });
});

describe('below-minimum and payload-schema predicates', () => {
  it('detects both below-minimum directions', () => {
    expect(
      isBelowMinimumError(
        new TrpcRequestError('x', { httpStatus: 422, appCode: 'CLIENT_BELOW_MINIMUM' })
      )
    ).toBe(true);
    expect(
      isBelowMinimumError(
        new TrpcRequestError('x', { httpStatus: 422, appCode: 'PROTOCOL_BELOW_MINIMUM' })
      )
    ).toBe(true);
    expect(isBelowMinimumError(new TrpcRequestError('x', { httpStatus: 422 }))).toBe(false);
  });

  it('detects an unsupported payload schema', () => {
    expect(
      isPayloadSchemaUnsupportedError(
        new TrpcRequestError('x', { httpStatus: 422, appCode: 'PAYLOAD_SCHEMA_UNSUPPORTED' })
      )
    ).toBe(true);
    expect(
      isPayloadSchemaUnsupportedError(
        new TrpcRequestError('x', { httpStatus: 422, appCode: 'CLIENT_BELOW_MINIMUM' })
      )
    ).toBe(false);
  });
});

describe('isMissingProcedureError — typed UNKNOWN_PROCEDURE', () => {
  it('is true on the typed appCode alone, without prose or a 501', () => {
    // The launch-wire cloud reports skew structurally; no message matching.
    expect(
      isMissingProcedureError(
        new TrpcRequestError('anything at all', { httpStatus: 404, appCode: 'UNKNOWN_PROCEDURE' })
      )
    ).toBe(true);
  });
});
