import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { type RemoteTransportScope } from './remote-transport-input.js';
import { readProjectRemoteCurrent, readProjectRemoteRequest } from './remote-transport-reader.js';
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scope: RemoteTransportScope = {
  target: { server_url: 'https://example.test', org_id: 'organization', account_id: 'account' },
  artifactId: null,
  method: 'captureThread.start',
  targetExternalId: 'original',
  idempotencyKey: 'key',
};
function read(handle: ProjectDatabase, kind: 'exact' | 'current') {
  return kind === 'exact'
    ? readProjectRemoteRequest(handle, uuidv7())
    : readProjectRemoteCurrent(handle, scope);
}
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'remote-read-boundary-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(handle);
  return handle;
}
it.each(['exact', 'current'] as const)(
  'rejects a fabricated handle before invoking its %s read',
  (kind) => {
    const reader = vi.fn(() => ({
      value: null,
      counters: { writeSequence: 0, intentChangeCounter: 0 },
    }));
    const fake = { read: reader } as unknown as ProjectDatabase;
    expect(() => read(fake, kind)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(reader).not.toHaveBeenCalled();
  }
);
it.each(['exact', 'current'] as const)(
  'preserves the closed genuine handle classification for %s reads',
  async (kind) => {
    const handle = await fixture();
    handle.close();
    expect(() => read(handle, kind)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INACCESSIBLE' })
    );
  }
);
it.each(['exact', 'current'] as const)(
  'returns absent history through a genuine %s reader without mutations',
  async (kind) => {
    const handle = await fixture(),
      before = handle.read(() => null).counters;
    expect(read(handle, kind)).toEqual({ value: null, counters: before });
    expect(handle.read(() => null).counters).toEqual(before);
  }
);
