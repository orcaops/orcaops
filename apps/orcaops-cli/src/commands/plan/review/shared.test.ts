import { describe, expect, it } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';

import { mapPlanCloudReadError, pinRefOf } from './shared.js';
import { OrcaopsError } from '../../../io/errors.js';

const OPTS = { notFoundMessage: 'Not found: the thing.', inputPath: 'plan-review-test' };

describe('mapPlanCloudReadError', () => {
  it('maps a below-minimum appCode to the terminal upgrade message, outranking every other arm', () => {
    // A floor rejection arrives as 422 with a typed appCode; it must never be
    // mislabeled as skew or a missing row.
    const mapped = mapPlanCloudReadError(
      new TrpcRequestError('client below minimum', {
        httpStatus: 422,
        appCode: 'CLIENT_BELOW_MINIMUM',
        appData: { minimum: '1.0.0', received: null },
      }),
      OPTS
    );
    expect(mapped).toBeInstanceOf(OrcaopsError);
    expect(mapped).toMatchObject({
      code: 'CLOUD_ERROR',
      message: expect.stringContaining('below its minimum supported version'),
      inputPath: 'plan-review-test',
    });
  });

  it('maps an unsupported payload schema to its terminal upgrade message', () => {
    const mapped = mapPlanCloudReadError(
      new TrpcRequestError('unsupported schema_version', {
        httpStatus: 422,
        appCode: 'PAYLOAD_SCHEMA_UNSUPPORTED',
      }),
      OPTS
    );
    expect(mapped).toMatchObject({
      code: 'CLOUD_ERROR',
      message: expect.stringContaining('schema version'),
    });
  });

  it('maps the typed UNKNOWN_PROCEDURE appCode to skew without any prose match', () => {
    const mapped = mapPlanCloudReadError(
      new TrpcRequestError('anything', { httpStatus: 404, appCode: 'UNKNOWN_PROCEDURE' }),
      OPTS
    );
    expect(mapped).toMatchObject({
      code: 'NO_INPUT',
      message: expect.stringContaining("doesn't expose the plan-review surface"),
    });
  });

  it('does not infer version skew from NOT_IMPLEMENTED or HTTP 501', () => {
    const raw = new TrpcRequestError('x', { code: 'NOT_IMPLEMENTED', httpStatus: 501 });
    expect(mapPlanCloudReadError(raw, OPTS)).toBe(raw);
  });

  it('maps typed UNKNOWN_PROCEDURE to skew before the overlapping NOT_FOUND code', () => {
    const mapped = mapPlanCloudReadError(
      new TrpcRequestError('anything', {
        code: 'NOT_FOUND',
        httpStatus: 404,
        appCode: 'UNKNOWN_PROCEDURE',
      }),
      OPTS
    );
    expect(mapped).toMatchObject({
      code: 'NO_INPUT',
      message: expect.stringContaining("doesn't expose the plan-review surface"),
    });
    expect((mapped as OrcaopsError).message).not.toContain('Not found: the thing.');
  });

  it("maps a plain NOT_FOUND to the caller's friendly message", () => {
    const mapped = mapPlanCloudReadError(
      new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 }),
      OPTS
    );
    expect(mapped).toMatchObject({
      code: 'NO_INPUT',
      message: 'Not found: the thing.',
      inputPath: 'plan-review-test',
    });
  });

  it('returns any other error unchanged for the wrapper to label CLOUD_ERROR', () => {
    const boom = new TrpcRequestError('boom', { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 });
    expect(mapPlanCloudReadError(boom, OPTS)).toBe(boom);
    const plain = new Error('socket hang up');
    expect(mapPlanCloudReadError(plain, OPTS)).toBe(plain);
  });

  it('missingProcedureMessage overrides ONLY the skew arm; plain NOT_FOUND keeps its message', () => {
    const opts = { ...OPTS, missingProcedureMessage: 'No discovery on this cloud.' };
    const skew = mapPlanCloudReadError(
      new TrpcRequestError('anything', {
        code: 'NOT_FOUND',
        httpStatus: 404,
        appCode: 'UNKNOWN_PROCEDURE',
      }),
      opts
    );
    expect(skew).toMatchObject({ code: 'NO_INPUT', message: 'No discovery on this cloud.' });
    const miss = mapPlanCloudReadError(
      new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 }),
      opts
    );
    expect(miss).toMatchObject({ code: 'NO_INPUT', message: 'Not found: the thing.' });
  });
});

describe('pinRefOf', () => {
  it('renders the ready-to-paste pin ref for an approved version', () => {
    expect(pinRefOf('sp_01ABC', 3)).toBe('cloud:sp_01ABC@3');
  });

  it('is null when the plan has never been approved', () => {
    expect(pinRefOf('sp_01ABC', null)).toBeNull();
  });
});
