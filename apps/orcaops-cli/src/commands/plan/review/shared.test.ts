import { describe, expect, it } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';

import { cloudRetryFlags, mapPlanCloudReadError, pinRefOf, pulledRefMissError } from './shared.js';
import {
  createMemoryPlanReviewPersistence,
  seedCandidate,
} from '../../../../tests/support/plan-review-persistence.js';
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

describe('cloudRetryFlags', () => {
  it('echoes the cloud and output flags a pasted refusal needs', () => {
    expect(
      cloudRetryFlags({ input: 'c1.md', baseUrl: 'https://staging.example', json: true })
    ).toEqual(['--input', 'c1.md', '--base-url', 'https://staging.example', '--json']);
  });

  it('echoes nothing for flags that were not passed', () => {
    expect(cloudRetryFlags({})).toEqual([]);
    expect(cloudRetryFlags({ json: false })).toEqual([]);
  });
});

describe('pulledRefMissError', () => {
  const CANONICAL = 'a'.repeat(64);

  async function aliased() {
    const persistence = createMemoryPlanReviewPersistence();
    await seedCandidate(persistence, {
      externalId: CANONICAL,
      versionId: 'ver_4',
      versionNumber: 4,
    });
    await persistence.writeRefAlias({
      ref: 'plan-slug',
      externalId: CANONICAL,
      pulledAt: '2026-06-09T00:00:00.000Z',
    });
    return persistence;
  }

  it('names the plan the ref was most recently pulled as', async () => {
    const persistence = createMemoryPlanReviewPersistence();
    const first = 'a'.repeat(64);
    const later = 'b'.repeat(64);
    await seedCandidate(persistence, { externalId: first, versionId: 'ver_1', versionNumber: 1 });
    await seedCandidate(persistence, { externalId: later, versionId: 'ver_2', versionNumber: 2 });
    await persistence.writeRefAlias({
      ref: 'plan-slug',
      externalId: first,
      pulledAt: '2026-06-09T00:00:00.000Z',
    });
    await persistence.writeRefAlias({
      ref: 'plan-slug',
      externalId: later,
      pulledAt: '2026-06-10T00:00:00.000Z',
    });
    await persistence.writeRefAlias({
      ref: 'plan-slug',
      externalId: first,
      pulledAt: '2026-06-11T00:00:00.000Z',
    });

    const err = await pulledRefMissError({
      persistence,
      ref: 'plan-slug',
      command: 'push',
      escape: 'pass --base-version-id <id>',
    });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain(first);
    expect(err.message).not.toContain(later);
  });

  it('ignores a record refreshed under a plan the ref no longer names', async () => {
    const persistence = createMemoryPlanReviewPersistence();
    const stale = 'a'.repeat(64);
    const current = 'b'.repeat(64);
    await seedCandidate(persistence, {
      externalId: stale,
      versionId: 'ver_1',
      versionNumber: 1,
      pulledAt: '2026-07-01T00:00:00.000Z',
    });
    await seedCandidate(persistence, {
      externalId: current,
      versionId: 'ver_2',
      versionNumber: 2,
      pulledAt: '2026-06-10T00:00:00.000Z',
    });
    await persistence.writeRefAlias({
      ref: 'plan-slug',
      externalId: stale,
      pulledAt: '2026-06-09T00:00:00.000Z',
    });
    await persistence.writeRefAlias({
      ref: 'plan-slug',
      externalId: current,
      pulledAt: '2026-06-10T00:00:00.000Z',
    });

    const err = await pulledRefMissError({
      persistence,
      ref: 'plan-slug',
      command: 'push',
      escape: 'pass --base-version-id <id>',
    });
    expect(err.message).toContain(current);
    expect(err.message).not.toContain(stale);
  });

  it('refuses an aliased ref by naming the canonical externalId in full', async () => {
    const persistence = await aliased();
    const err = await pulledRefMissError({
      persistence,
      ref: 'plan-slug',
      command: 'comment',
      escape: 'pass --proposal <id> to comment on a proposal',
    });
    expect(err).toBeInstanceOf(OrcaopsError);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain(CANONICAL);
    expect(err.message).toContain('orcaops plan review comment ' + CANONICAL);
  });

  it('echoes the typed flags so the printed command line runs as-is', async () => {
    const persistence = await aliased();
    const err = await pulledRefMissError({
      persistence,
      ref: 'plan-slug',
      command: 'comment',
      retryFlags: ['--input', 'c1.md'],
      escape: 'pass --proposal <id> to comment on a proposal',
    });
    expect(err.message).toContain(`orcaops plan review comment ${CANONICAL} --input c1.md`);
  });

  it('quotes a flag value carrying a shell-significant character', async () => {
    const persistence = await aliased();
    const err = await pulledRefMissError({
      persistence,
      ref: 'plan-slug',
      command: 'comment',
      retryFlags: ['--input', "it's.md"],
      escape: 'pass --proposal <id> to comment on a proposal',
    });
    expect(err.message).toContain(`--input 'it'\\''s.md'`);
  });

  it('quotes a flag value containing whitespace', async () => {
    const persistence = await aliased();
    const err = await pulledRefMissError({
      persistence,
      ref: 'plan-slug',
      command: 'comment',
      retryFlags: ['--input', 'my notes.md'],
      escape: 'pass --proposal <id> to comment on a proposal',
    });
    expect(err.message).toContain(`--input 'my notes.md'`);
  });

  it('keeps NO_INPUT when nothing local maps the ref', async () => {
    const persistence = createMemoryPlanReviewPersistence();
    const err = await pulledRefMissError({
      persistence,
      ref: 'plan-slug',
      command: 'push',
      escape: 'pass --base-version-id <id>',
    });
    expect(err.code).toBe('NO_INPUT');
    expect(err.message).toContain('orcaops plan review pull plan-slug');
    expect(err.message).toContain('pass --base-version-id <id>');
  });

  it('keeps NO_INPUT when the alias points at a record that is gone', async () => {
    const persistence = createMemoryPlanReviewPersistence();
    await persistence.writeRefAlias({
      ref: 'plan-slug',
      externalId: CANONICAL,
      pulledAt: '2026-06-09T00:00:00.000Z',
    });
    const err = await pulledRefMissError({
      persistence,
      ref: 'plan-slug',
      command: 'propose',
      escape: 'pass --base-version-id <id>',
    });
    expect(err.code).toBe('NO_INPUT');
  });

  it('keeps NO_INPUT when the alias read fails', async () => {
    const persistence = createMemoryPlanReviewPersistence();
    const err = await pulledRefMissError({
      persistence: {
        ...persistence,
        readRefAliases: async () => {
          throw new Error('damaged');
        },
      },
      ref: 'plan-slug',
      command: 'comment',
      escape: 'pass --proposal <id> to comment on a proposal',
    });
    expect(err.code).toBe('NO_INPUT');
  });
});
