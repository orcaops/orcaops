import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ArtifactNotFoundError, MissingGitRemoteError } from '@orcaops/core';
import { TrpcRequestError } from '@orcaops/sdk';
import { PathContainmentError } from '@orcaops/storage';

import { toCloudErrorEnvelope } from './cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from './errors.js';

describe('toCloudErrorEnvelope', () => {
  it('passes an OrcaopsError through unchanged (already structured)', () => {
    const e = new OrcaopsError(ErrorCodes.INVALID_INPUT, 'bad input');
    expect(toCloudErrorEnvelope(e)).toBe(e);
  });

  it('maps a generic Error to CLOUD_ERROR', () => {
    const out = toCloudErrorEnvelope(new Error('boom')) as OrcaopsError;
    expect(out).toBeInstanceOf(OrcaopsError);
    expect(out.code).toBe(ErrorCodes.CLOUD_ERROR);
    expect(out.message).toBe('boom');
  });

  it('maps a cloud-data ZodError to CLOUD_ERROR — NEVER INVALID_INPUT', () => {
    let zodErr: unknown;
    try {
      z.object({ x: z.string() }).parse({ x: 1 });
    } catch (e) {
      zodErr = e;
    }
    expect(zodErr).toBeInstanceOf(z.ZodError);
    const out = toCloudErrorEnvelope(zodErr) as OrcaopsError;
    expect(out).toBeInstanceOf(OrcaopsError);
    expect(out.code).toBe(ErrorCodes.CLOUD_ERROR);
    expect(out.code).not.toBe(ErrorCodes.INVALID_INPUT);
  });

  it('maps ArtifactNotFoundError to UNKNOWN_ARTIFACT', () => {
    const out = toCloudErrorEnvelope(new ArtifactNotFoundError('art-1')) as OrcaopsError;
    expect(out.code).toBe(ErrorCodes.UNKNOWN_ARTIFACT);
  });

  it('maps MissingGitRemoteError to MISSING_GIT_REMOTE', () => {
    const out = toCloudErrorEnvelope(new MissingGitRemoteError()) as OrcaopsError;
    expect(out.code).toBe(ErrorCodes.MISSING_GIT_REMOTE);
  });

  it('maps a local containment refusal to INTERNAL instead of CLOUD_ERROR', () => {
    const out = toCloudErrorEnvelope(
      new PathContainmentError('cache path traverses a symlink', 'source-plan cache')
    ) as OrcaopsError;
    expect(out).toMatchObject({
      code: ErrorCodes.INTERNAL,
      message: 'cache path traverses a symlink',
      inputPath: 'source-plan cache',
    });
  });

  it('returns a non-Error value unchanged', () => {
    const weird = { not: 'an error' };
    expect(toCloudErrorEnvelope(weird)).toBe(weird);
  });

  // The typed launch-negotiation arms cover boundaries no verb-level mapper
  // reaches — the shared review ping and every mutation path — so a floor
  // rejection can never flatten to a raw CLOUD_ERROR message.
  it('maps a below-minimum appCode to the terminal upgrade message (both directions)', () => {
    for (const appCode of ['CLIENT_BELOW_MINIMUM', 'PROTOCOL_BELOW_MINIMUM']) {
      const out = toCloudErrorEnvelope(
        new TrpcRequestError('server prose', { httpStatus: 422, appCode })
      ) as OrcaopsError;
      expect(out.code).toBe(ErrorCodes.CLOUD_ERROR);
      expect(out.message).toContain('below its minimum supported version');
      expect(out.message).toContain('Upgrade');
    }
  });

  it('maps an unsupported payload schema to its terminal upgrade message', () => {
    const out = toCloudErrorEnvelope(
      new TrpcRequestError('server prose', {
        httpStatus: 422,
        appCode: 'PAYLOAD_SCHEMA_UNSUPPORTED',
      })
    ) as OrcaopsError;
    expect(out.code).toBe(ErrorCodes.CLOUD_ERROR);
    expect(out.message).toContain('schema version');
  });

  it('maps typed UNKNOWN_PROCEDURE skew to the deployment-skew message, not raw prose', () => {
    const out = toCloudErrorEnvelope(
      new TrpcRequestError('anything', { httpStatus: 404, appCode: 'UNKNOWN_PROCEDURE' })
    ) as OrcaopsError;
    expect(out.code).toBe(ErrorCodes.CLOUD_ERROR);
    expect(out.message).toContain('deployment skew');
  });

  it('never shadows a verb-specific mapping: an OrcaopsError with negotiation cause passes through', () => {
    const tailored = new OrcaopsError(ErrorCodes.CLOUD_ERROR, 'verb-tailored message');
    expect(toCloudErrorEnvelope(tailored)).toBe(tailored);
  });
});
