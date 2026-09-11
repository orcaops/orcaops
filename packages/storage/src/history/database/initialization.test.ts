import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { readProjectInitialization } from './initialization.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-initialization-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const initializationOperationId = uuidv7();
  const initializedAt = new Date().toISOString();
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const writer = await initializeProjectDatabase({
    authority,
    initializationOperationId,
    initializedAt,
    authorize() {},
  });
  handles.push(writer);
  return { authority, initializationOperationId, initializedAt, writer };
}

describe('committed project initialization', () => {
  it('reads exact original initialization through an existing readonly connection', async () => {
    const { authority, initializationOperationId, initializedAt, writer } = await fixture();
    const before = writer.read(() => null).counters;
    const reader = await openProjectDatabase({ authority, mode: 'reader' });
    handles.push(reader);
    expect(readProjectInitialization(reader)).toEqual({
      authority,
      initializationOperationId,
      initializedAt,
      state: 'active',
    });
    expect(writer.read((view) => view.all('SELECT * FROM operations'))).toEqual({
      value: [],
      counters: before,
    });
    reader.close();
    handles.splice(handles.indexOf(reader), 1);
  });

  it('rejects a fabricated handle without accepting its claimed initialization', () => {
    const read = vi.fn();
    expect(() => readProjectInitialization({ read } as unknown as ProjectDatabase)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses corrupt initialization time instead of certifying a marker', async () => {
    const { writer } = await fixture();
    const raw = new Database(writer.databasePath);
    try {
      raw.exec(
        "DROP TRIGGER activation_no_update; UPDATE activation SET initialized_at = 'invalid'"
      );
    } finally {
      raw.close();
    }
    expect(() => readProjectInitialization(writer)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  });
});
