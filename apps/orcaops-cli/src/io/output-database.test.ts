import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactLockLeaseLostError } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { OrcaopsError } from './errors.js';
import { CliExit } from './exit.js';
import { emitError, toErrorEnvelope, writeErrorLine } from './output.js';

afterEach(() => vi.restoreAllMocks());

function outputs() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stdout, stderr };
}

describe('database error output', () => {
  it.each([
    [
      'STALE_BINDING_GENERATION',
      undefined,
      undefined,
      'Read the current binding and prepare a new explicit operation.',
    ],
    [
      'EXECUTION_BOUND_ELSEWHERE',
      undefined,
      undefined,
      'Continue in the owning worktree or request an explicit handoff.',
    ],
    [
      'OPEN_CHECKPOINTS',
      undefined,
      undefined,
      'Close the original checkpoints before handoff or completion.',
    ],
    ['IMPORTED_READ_ONLY', undefined, undefined, 'Select authored active work for task execution.'],
    [
      'HISTORY_MISSING',
      undefined,
      undefined,
      'Restore the expected database; never initialize a replacement.',
    ],
    [
      'HISTORY_INACCESSIBLE',
      undefined,
      undefined,
      'Check permissions and mount health before retrying.',
    ],
    [
      'STALE_CONTEXT',
      undefined,
      undefined,
      'Prepare a new operation against the reviewed version.',
    ],
    [
      'TRANSACTION_FAILED',
      'SQLITE_FULL',
      'disk-full',
      'Free disk space before retrying the original operation.',
    ],
    [
      'TRANSACTION_FAILED',
      'SQLITE_READONLY',
      'read-only',
      'Restore write access to the expected project store.',
    ],
    [
      'TRANSACTION_FAILED',
      'SQLITE_CONSTRAINT_UNIQUE',
      'constraint',
      'Correct the conflicting authored identity with a new operation.',
    ],
    [
      'TRANSACTION_FAILED',
      'SQLITE_ERROR',
      'invalid-sql',
      'Report the invalid statement implementation before retrying.',
    ],
    [
      'HISTORY_INTEGRITY_REQUIRED',
      'SQLITE_CORRUPT',
      'integrity',
      'Preserve history and use explicit repair.',
    ],
    [
      'TRANSACTION_FAILED',
      'SQLITE_IOERR_READ',
      'io',
      'Inspect storage health; this I/O failure is terminal.',
    ],
    [
      'TRANSACTION_RETRY_EXHAUSTED',
      'SQLITE_BUSY',
      'contention',
      'Retry the original operation after contention clears.',
    ],
    [
      'CANCELLED',
      undefined,
      undefined,
      'The operation was cancelled; retry the original identity when ready.',
    ],
  ] as const)(
    'preserves %s and %s through JSON and human output',
    (code, sqliteCode, reason, message) => {
      const error = new ProjectDatabaseError(
        code,
        message,
        sqliteCode
          ? { cause: new Database.SqliteError('SQL and payload are diagnostic only', sqliteCode) }
          : undefined
      );
      const expected = { ok: false, error: { code, message, ...(reason ? { reason } : {}) } };
      expect(toErrorEnvelope(error)).toEqual(expected);
      const { stdout, stderr } = outputs();
      expect(() => emitError(error)).toThrow(CliExit);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0])).toEqual(expected);
      expect(stderr).toEqual([]);
      writeErrorLine(error);
      expect(stderr).toEqual([`Error: [${code}${reason ? `; ${reason}` : ''}] ${message}\n`]);
      expect(stdout).toHaveLength(1);
    }
  );

  it('keeps authored guidance beyond the generic error bound and never renders raw diagnostic fields', () => {
    const guidance = `${'Inspect the expected database and preserve its identity. '.repeat(7)}Then run explicit repair.`;
    const sql = 'SELECT private_payload FROM confidential_rows';
    const cause = new AggregateError(
      [new Error(sql), new Error('private cleanup details')],
      'private aggregate'
    );
    const error = new ProjectDatabaseError('HISTORY_MISSING', guidance, { cause });
    Object.assign(error, { sql, payload: 'private payload', context: { cleanupCause: cause } });
    const envelope = toErrorEnvelope(error);
    expect(envelope.error.message).toBe(guidance);
    expect(Object.keys(envelope.error).sort()).toEqual(['code', 'message']);
    const { stdout, stderr } = outputs();
    expect(() => emitError(error)).toThrow(CliExit);
    writeErrorLine(error);
    expect([...stdout, ...stderr].join('')).not.toMatch(/private|confidential|SELECT/);
  });

  it('scrubs secret-bearing authored text and terminal controls in both modes', () => {
    const token = 'ghp_0000000000000000000000000000000000000';
    const split = `${token.slice(0, 20)}\u001b[31m${token.slice(20)}`;
    const error = new ProjectDatabaseError(
      'INVALID_INPUT',
      `Remove ${split} before preparing a new operation.`,
      { cause: new Error(`raw cause ${token}`) }
    );
    const { stdout, stderr } = outputs();
    expect(() => emitError(error)).toThrow(CliExit);
    writeErrorLine(error);
    for (const value of [...stdout, ...stderr]) {
      expect(value).not.toContain(token);
      expect(value).not.toContain('\u001b');
      expect(value).not.toContain('raw cause');
      expect(value).toContain('[REDACTED_SECRET]');
      expect(value).toContain('before preparing a new operation.');
    }
  });

  it('bounds long database messages and omits an unknown reason even on a typed instance', () => {
    const error = new ProjectDatabaseError('TRANSACTION_FAILED', 'x'.repeat(20_000));
    Object.defineProperty(error, 'reason', { value: 'SELECT private_payload' });
    const envelope = toErrorEnvelope(error);
    expect(envelope.error.message.length).toBeLessThan(5_000);
    expect(envelope.error.message).toContain('[truncated]');
    expect(envelope.error).not.toHaveProperty('reason');
  });

  it.each(['STALE_CONTEXT', 'SQLITE_BUSY', 'HISTORY_MISSING'])(
    'does not trust a plain error code %s',
    (code) => {
      const error = Object.assign(new Error('Unknown application failure'), {
        code,
        reason: 'contention',
      });
      expect(toErrorEnvelope(error)).toEqual({
        ok: false,
        error: { code: 'INTERNAL', message: 'Unknown application failure' },
      });
      expect(
        toErrorEnvelope({ code, message: 'Untrusted object', reason: 'contention' }).error.code
      ).toBe('INTERNAL');
    }
  );

  it('does not disclose even a recognized legacy cause beneath a database error', () => {
    const error = new ProjectDatabaseError('TRANSACTION_FAILED', 'Use explicit repair.', {
      cause: new ArtifactLockLeaseLostError('private-artifact-identity'),
    });
    const { stdout, stderr } = outputs();
    expect(() => emitError(error)).toThrow(CliExit);
    writeErrorLine(error);
    expect(stderr).toEqual(['Error: [TRANSACTION_FAILED] Use explicit repair.\n']);
    expect(stdout.join('')).not.toContain('private-artifact-identity');
  });

  it('preserves existing authored domain envelopes and human formatting', () => {
    const error = new OrcaopsError('INVALID_INPUT', 'Select an artifact.', 'artifact_id');
    expect(toErrorEnvelope(error)).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Select an artifact.', path: 'artifact_id' },
    });
    const { stderr } = outputs();
    writeErrorLine(error);
    expect(stderr).toEqual(['Error: Select an artifact.\n']);
  });
});
