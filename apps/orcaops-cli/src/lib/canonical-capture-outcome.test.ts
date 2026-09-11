import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliAuthError } from '@orcaops/sdk';
import { HistoryError } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';
import { HistoryPersistenceError } from '@orcaops/storage/history/primitives';

import { captureFailure } from './canonical-capture-outcome.js';
import { OrcaopsError } from '../io/errors.js';
import { emitOk, toErrorEnvelope } from '../io/output.js';

afterEach(() => vi.restoreAllMocks());

describe('secondary capture failure output', () => {
  it('retains an unclassified typed transaction failure without inventing a SQLite reason', () => {
    const error = new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      'Report the failed operation before retrying.',
      {
        cause: Object.assign(new Error('private application failure'), { code: 'SQLITE_FULL' }),
      }
    );
    expect(captureFailure(error)).toEqual({
      code: 'TRANSACTION_FAILED',
      message: 'Report the failed operation before retrying.',
    });
    expect(captureFailure(error)).toEqual(toErrorEnvelope(error).error);
  });

  it.each([
    ['STALE_BINDING_GENERATION', undefined],
    ['EXECUTION_BOUND_ELSEWHERE', undefined],
    ['OPEN_CHECKPOINTS', undefined],
    ['IMPORTED_READ_ONLY', undefined],
    ['HISTORY_MISSING', undefined],
    ['HISTORY_INACCESSIBLE', undefined],
    ['STALE_CONTEXT', undefined],
    ['CANCELLED', undefined],
    ['TRANSACTION_FAILED', 'SQLITE_FULL'],
    ['TRANSACTION_FAILED', 'SQLITE_READONLY'],
    ['TRANSACTION_FAILED', 'SQLITE_CONSTRAINT_UNIQUE'],
    ['TRANSACTION_FAILED', 'SQLITE_ERROR'],
    ['HISTORY_INTEGRITY_REQUIRED', 'SQLITE_CORRUPT'],
    ['TRANSACTION_FAILED', 'SQLITE_IOERR_READ'],
    ['TRANSACTION_RETRY_EXHAUSTED', 'SQLITE_BUSY'],
  ] as const)(
    'matches primary %s and %s without broadening the flat error shape',
    (code, sqliteCode) => {
      const message =
        'Preserve committed history and use the original operation identity after explicit repair.';
      const error = new ProjectDatabaseError(
        code,
        message,
        sqliteCode
          ? { cause: new Database.SqliteError('private SQL payload', sqliteCode) }
          : undefined
      );
      expect(captureFailure(error)).toEqual(toErrorEnvelope(error).error);
      expect(Object.keys(captureFailure(error)).sort()).toEqual(
        sqliteCode ? ['code', 'message', 'reason'] : ['code', 'message']
      );
    }
  );

  it('retains the same authored bound as primary database output', () => {
    const message = `${'Keep committed history and inspect the expected store. '.repeat(28)}Run explicit repair.`;
    const error = new ProjectDatabaseError('HISTORY_MISSING', message);
    expect(message.length).toBeGreaterThan(1024);
    expect(captureFailure(error)).toEqual({ code: 'HISTORY_MISSING', message });
    expect(captureFailure(error)).toEqual(toErrorEnvelope(error).error);
    const long = new ProjectDatabaseError('HISTORY_MISSING', message.repeat(10));
    expect(captureFailure(long)).toEqual(toErrorEnvelope(long).error);
    expect(captureFailure(long).message.length).toBeLessThan(5000);
  });

  it('preserves a retained safe reason without traversing cleanup causes', () => {
    const error = new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      'Free disk space before retrying.',
      { cause: new Database.SqliteError('private SQL', 'SQLITE_FULL') }
    );
    error.cause = new AggregateError(
      [error.cause, new Error('private cleanup payload')],
      'private settlement failure'
    );
    Object.assign(error, { context: { raw: 'private context' }, sql: 'private statement' });
    expect(captureFailure(error)).toEqual({
      code: 'TRANSACTION_FAILED',
      message: 'Free disk space before retrying.',
      reason: 'disk-full',
    });
  });

  it('scrubs typed secondary errors inside the successful capture envelope', () => {
    const token = 'ghp_0000000000000000000000000000000000000';
    const split = `${token.slice(0, 20)}\u001b[31m${token.slice(20)}`;
    const error = new ProjectDatabaseError(
      'INVALID_INPUT',
      `Remove ${split} and prepare accepted content.`,
      { cause: new Error('private SQL and cleanup') }
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    emitOk({ focus: { state: 'failed', error: captureFailure(error) } });
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.focus.error).toEqual(toErrorEnvelope(error).error);
    expect(output[0]).not.toContain(token);
    expect(output[0]).not.toContain('private');
    expect(output[0]).not.toContain('\u001b');
    expect(output[0]).toContain('[REDACTED_SECRET]');
  });

  it.each([
    new OrcaopsError('BLOCKED', 'Resolve the blocking evaluator.'),
    new CliAuthError({
      code: 'SESSION_EXPIRED',
      message: 'Log in before retrying.',
      actionable: 'login',
    }),
    new HistoryError('IDENTITY_CONFLICT', 'Validate the retained authority.'),
    new HistoryPersistenceError('REVIEW_STALE', 'Prepare a current review before retrying.'),
  ])('retains intentional legacy typed secondary code $code and flat shape', (error) => {
    expect(captureFailure(error)).toEqual({ code: error.code, message: error.message });
    expect(Object.keys(captureFailure(error)).sort()).toEqual(['code', 'message']);
  });

  it('preserves the legacy message bound and scrubs legacy code text', () => {
    const token = 'ghp_0000000000000000000000000000000000000';
    const error = new HistoryPersistenceError(token, 'x'.repeat(4000), { sql: 'private content' });
    const result = captureFailure(error);
    expect(result.code).not.toContain(token);
    expect(result.code).toContain('[REDACTED_SECRET]');
    expect(result.message.length).toBeLessThan(1100);
    expect(result.message).toContain('[truncated]');
    expect(Object.keys(result).sort()).toEqual(['code', 'message']);
  });

  it.each([
    Object.assign(new Error('Unknown application failure'), {
      code: 'STALE_CONTEXT',
      reason: 'contention',
    }),
    {
      name: 'ProjectDatabaseError',
      code: 'HISTORY_MISSING',
      message: 'Untrusted object',
      reason: 'disk-full',
    },
    { code: 'SQLITE_BUSY' },
    new Error('No typed domain condition'),
    'plain failure',
  ])('does not trust arbitrary secondary codes', (error) => {
    const result = captureFailure(error);
    expect(result.code).toBe('POST_CAPTURE_FAILED');
    expect(result).not.toHaveProperty('reason');
    expect(Object.keys(result).sort()).toEqual(['code', 'message']);
  });

  it('never reads an untrusted code getter', () => {
    const code = vi.fn(() => {
      throw new Error('untrusted getter');
    });
    const error = Object.defineProperty(new Error('Unknown failure'), 'code', { get: code });
    expect(captureFailure(error)).toEqual({
      code: 'POST_CAPTURE_FAILED',
      message: 'Unknown failure',
    });
    expect(code).not.toHaveBeenCalled();
  });
});
