import { expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { assertExecutionMutation, initializeUnboundExecution } from '../execution.js';
import { HistoryPersistenceError } from '../persistence-error.js';
import { ProjectDatabaseError } from './errors.js';
import { translateExecutionFailure } from './execution-errors.js';

it('translates a real domain refusal to typed actionable guidance while retaining its diagnostic cause', () => {
  const state = initializeUnboundExecution({
    artifactId: uuidv7(),
    operationId: uuidv7(),
    reason: 'imported',
    ts: '2026-06-01T00:00:00.000Z',
  });
  let original: unknown;
  try {
    assertExecutionMutation({ state, expectedGeneration: 0, context: null, operation: 'task' });
  } catch (cause) {
    original = cause;
  }
  expect(original).toBeInstanceOf(HistoryPersistenceError);
  const translated = translateExecutionFailure(original);
  expect(translated).toBeInstanceOf(ProjectDatabaseError);
  expect(translated).toMatchObject({ code: 'IMPORTED_READ_ONLY', cause: original });
  expect(translated.message).toContain('Select authored active work');
});
it('does not accept a forged domain code or an unknown legacy protocol condition as public guidance', () => {
  const forged = Object.assign(new Error('private payload'), { code: 'OPEN_CHECKPOINTS' });
  const unknown = new HistoryPersistenceError('RETIRED_FILE_PROTOCOL', 'private legacy context');
  for (const cause of [forged, unknown]) {
    const translated = translateExecutionFailure(cause);
    expect(translated).toMatchObject({ code: 'TRANSACTION_FAILED', cause });
    expect(translated.message).not.toContain('private');
    expect(translated.reason).toBeUndefined();
  }
});
it('preserves an existing typed cancellation without changing its identity or retry classification', () => {
  const original = new ProjectDatabaseError('CANCELLED', 'Operation cancelled before commit');
  expect(translateExecutionFailure(original)).toBe(original);
});
