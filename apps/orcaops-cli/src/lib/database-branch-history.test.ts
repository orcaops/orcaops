import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { projectDatabasePath } from '@orcaops/storage/history/database';

import {
  branchSelectionScope,
  collectBranchHistory,
  createContextRevalidator,
  hydrateHistoryThreads,
  inFlightEntries,
  liveEntries,
  requireRepositoryScope,
} from './database-branch-history.js';
import { commitFile } from '../../tests/helpers/database-fingerprint.js';
import { fixture, inventory } from '../../tests/helpers/database-history.js';

const readers = new Set<{ close(): void }>();
afterEach(() => {
  for (const reader of readers) reader.close();
  readers.clear();
});
async function openScope(
  f: Awaited<ReturnType<typeof fixture>>,
  profile: 'collection' | 'git-history' = 'collection',
  cwd = f.main
) {
  const scope = await resolveDatabaseHistoryScope({ root: f.root, cwd, profile, selector: {} });
  readers.add(scope);
  return scope;
}

describe('database branch history helpers', { timeout: 60_000 }, () => {
  it('selects the current branch newest first and separates in-flight and live rows', async () => {
    const f = await fixture();
    const older = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    const completed = await f.capture(undefined, {
      ts: '2026-09-02T00:00:00.000Z',
      reason: 'completed',
    });
    const imported = await f.capture(undefined, {
      ts: '2026-09-03T00:00:00.000Z',
      reason: 'imported',
    });
    const elsewhere = await f.capture(undefined, {
      ts: '2026-09-04T00:00:00.000Z',
      cwd: f.linked,
    });
    const before = await inventory(f.temporary);
    const scope = await openScope(f);
    expect(branchSelectionScope(scope).branch).toEqual({ value: 'main', source: 'current' });
    expect(branchSelectionScope(scope, 'linked').branch).toEqual({
      value: 'linked',
      source: 'explicit',
    });
    const current = collectBranchHistory(scope);
    expect(current.completeness.complete).toBe(true);
    expect(current.entries.map((entry) => entry.row.artifactId)).toEqual([
      imported,
      completed,
      older,
    ]);
    expect(inFlightEntries(current.entries).map((entry) => entry.row.artifactId)).toEqual([
      imported,
      older,
    ]);
    expect(liveEntries(current.entries).map((entry) => entry.row.artifactId)).toEqual([
      completed,
      older,
    ]);
    expect(
      collectBranchHistory(scope, { branch: 'linked' }).entries.map((entry) => entry.row.artifactId)
    ).toEqual([elsewhere]);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reports the current branch as unavailable outside a checkout instead of a complete empty result', async () => {
    const f = await fixture();
    await f.capture();
    const scope = await openScope(f);
    const detached = { ...scope, gitContext: null };
    expect(branchSelectionScope(detached).branch).toEqual({ value: null, source: 'unavailable' });
    const collection = collectBranchHistory(detached);
    expect(collection.entries).toEqual([]);
    expect(collection.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'BRANCH_SELECTION_UNAVAILABLE' })],
    });
  });

  it('revalidates the repository context and refuses after HEAD moves', async () => {
    const f = await fixture();
    await f.capture();
    const scope = await openScope(f, 'git-history');
    const { git, authority } = requireRepositoryScope(scope);
    expect(git.branch).toBe('main');
    expect(authority.projectId).toBe(f.authority.projectId);
    const revalidate = createContextRevalidator(scope);
    await expect(revalidate()).resolves.toBeUndefined();
    await commitFile(f, 'moved.txt', 'moved\n');
    await expect(revalidate()).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    expect(() => requireRepositoryScope({ ...scope, gitContext: null })).toThrow(
      expect.objectContaining({ code: 'GIT_CONTEXT_UNAVAILABLE' })
    );
  });

  it('skips only retained-source failures per artifact and refuses the batch otherwise', async () => {
    const f = await fixture();
    const healthy = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    const damaged = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    const raw = new Database(projectDatabasePath(f.authority));
    try {
      // The retained revision row is immutable by trigger; corrupting the ordered
      // hash is how a reader observes tampered retained history at all.
      const trigger = raw
        .prepare("SELECT sql FROM sqlite_schema WHERE name='artifact_revisions_no_update'")
        .get() as { sql: string };
      raw.exec('DROP TRIGGER artifact_revisions_no_update');
      raw
        .prepare('UPDATE artifact_revisions SET ordered_hash=? WHERE artifact_id=?')
        .run('0'.repeat(64), damaged);
      raw.exec(trigger.sql);
    } finally {
      raw.close();
    }
    const before = await inventory(f.temporary);
    const scope = await openScope(f);
    const entries = collectBranchHistory(scope, { profile: 'versions' }).entries;
    expect(entries.map((entry) => entry.row.artifactId)).toEqual([damaged, healthy]);
    const skipped = hydrateHistoryThreads(scope, entries, 'skip');
    expect(skipped.threads.map((thread) => thread.artifactId)).toEqual([healthy]);
    expect(skipped.skipped).toEqual([
      expect.objectContaining({ artifact_id: damaged, code: 'HISTORY_INTEGRITY_REQUIRED' }),
    ]);
    expect(() => hydrateHistoryThreads(scope, entries)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
