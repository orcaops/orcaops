import Database from 'better-sqlite3';
import { rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { Repo } from '@orcaops/core';
import { uuidv7 } from '@orcaops/storage';
import {
  projectDatabasePath,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';

import { commitFile } from '../helpers/database-fingerprint.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
function run(f: Fixture, extra: string[] = []) {
  return makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  }).runRaw(['lineage', '--json', ...extra]);
}
function execution(f: Fixture, id: string) {
  const value = readProjectExecution(f.writer, id);
  return value && { state: value.state, version: value.version };
}

describe('database lineage synchronization', () => {
  it.each(['empty', 'false-current'] as const)(
    'refuses a %s lineage projection without changing retained history',
    async (corruption) => {
      const f = await fixture();
      const id = await f.capture();
      await commitFile(f, 'changed.txt', 'advance HEAD');
      const retained = readProjectArtifact(f.writer, id)!;
      const database = new Database(projectDatabasePath(f.authority));
      try {
        const row = database
          .prepare('SELECT details_json FROM artifact_query_metadata WHERE artifact_id = ?')
          .get(id) as { details_json: string };
        const details = JSON.parse(row.details_json);
        details.branchLineage =
          corruption === 'empty'
            ? []
            : [
                {
                  ...retained.thread.artifactJson!.branch_lineage.at(-1),
                  head_sha: (await git(f.main, ['rev-parse', 'HEAD'])).stdout.trim(),
                },
              ];
        database
          .prepare('UPDATE artifact_query_metadata SET details_json = ? WHERE artifact_id = ?')
          .run(JSON.stringify(details), id);
      } finally {
        database.close();
      }
      const before = await inventory(f.temporary);
      const result = await run(f);
      expect(result.exitCode, result.stdout + result.stderr).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('HISTORY_INTEGRITY_REQUIRED');
      expect(await inventory(f.temporary)).toEqual(before);
    }
  );

  it('leaves empty and already-current history unchanged', async () => {
    const f = await fixture();
    let before = await inventory(f.temporary);
    const empty = await run(f);
    expect(empty.exitCode, empty.stdout + empty.stderr).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({ updated: [], skipped: [], merged: [] });
    expect(await inventory(f.temporary)).toEqual(before);
    const id = await f.capture();
    before = await inventory(f.temporary);
    const current = await run(f);
    expect(current.exitCode, current.stdout + current.stderr).toBe(0);
    expect(JSON.parse(current.stdout)).toMatchObject({
      updated: [],
      merged: [],
      skipped: [{ artifact_id: id, reason: 'already-current' }],
    });
    const otherBranch = await run(f, ['--branch', 'never-existed']);
    expect(otherBranch.exitCode).toBe(0);
    expect(JSON.parse(otherBranch.stdout)).toMatchObject({ updated: [], merged: [], skipped: [] });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it.each(['active', 'completed', 'imported'] as const)(
    'records moved HEAD for %s history without changing execution',
    async (kind) => {
      const f = await fixture();
      const id = await f.capture(undefined, kind === 'active' ? {} : { reason: kind });
      const owner = execution(f, id);
      const head = await commitFile(f, 'extra.ts', 'export const extra = 1;\n');
      const result = await run(f);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        updated: [{ artifact_id: id, prior_sha: f.context.headOid, new_sha: head }],
        merged: [],
      });
      expect(
        readProjectArtifact(f.writer, id)!.thread.artifactJson!.branch_lineage.at(-1)
      ).toMatchObject({ branch: 'main', head_sha: head, event: 'rebased' });
      expect(execution(f, id)).toEqual(owner);
      const before = await inventory(f.temporary);
      const repeated = await run(f);
      expect(repeated.exitCode).toBe(0);
      expect(JSON.parse(repeated.stdout)).toMatchObject({
        updated: [],
        merged: [],
        skipped: [{ artifact_id: id, reason: 'already-current' }],
      });
      expect(await inventory(f.temporary)).toEqual(before);
    }
  );

  it('records reachable other-branch ancestry without adopting its execution', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { cwd: f.linked });
    const owner = execution(f, id);
    const head = await commitFile(f, 'descendant.ts', 'export const descendant = true;\n');
    const result = await run(f);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      updated: [],
      merged: [
        { artifact_id: id, source_branch: 'linked', source_sha: f.context.headOid, new_sha: head },
      ],
    });
    expect(
      readProjectArtifact(f.writer, id)!.thread.artifactJson!.branch_lineage.at(-1)
    ).toMatchObject({ branch: 'main', event: 'merged' });
    expect(execution(f, id)).toEqual(owner);
  });

  it('does not overwrite a lineage change committed during preparation', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { reason: 'imported' });
    await f.mutate(id, {}, (semantics) =>
      semantics.appendBranchLineage(id, {
        branch: 'linked',
        head_sha: f.context.headOid!,
        ts: new Date().toISOString(),
        event: 'merged',
      })
    );
    const head = await commitFile(f, 'descendant.ts', 'export const descendant = true;\n');
    const original = Repo.prototype.checkReachability;
    const spy = vi
      .spyOn(Repo.prototype, 'checkReachability')
      .mockImplementationOnce(async function (this: Repo, ...args) {
        await f.mutate(id, {}, (semantics) =>
          semantics.appendBranchLineage(
            id,
            { branch: 'concurrent', head_sha: head, ts: new Date().toISOString(), event: 'merged' },
            { idempotencyKey: uuidv7() }
          )
        );
        return original.apply(this, args);
      });
    try {
      const result = await run(f);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('STALE_CONTEXT');
      expect(
        readProjectArtifact(f.writer, id)!.thread.artifactJson!.branch_lineage.at(-1)
      ).toMatchObject({ branch: 'concurrent', head_sha: head });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports unavailable ancestry instead of silently skipping it', async () => {
    const f = await fixture();
    await f.capture(undefined, { cwd: f.linked });
    await commitFile(f, 'descendant.ts', 'export const descendant = true;\n');
    const before = await inventory(f.temporary);
    const spy = vi.spyOn(Repo.prototype, 'checkReachability').mockResolvedValueOnce('unknown');
    try {
      const result = await run(f);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.message).toContain('unavailable Git evidence');
      expect(await inventory(f.temporary)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('names a contended write and cancels without publishing lineage', async () => {
    const f = await fixture();
    const id = await f.capture();
    await commitFile(f, 'extra.ts', 'export const extra = 1;\n');
    const prior = readProjectArtifact(f.writer, id)!.revision;
    const lock = new Database(projectDatabasePath(f.authority));
    lock.exec('BEGIN IMMEDIATE');
    const original = process.stderr.write.bind(process.stderr);
    let waits = 0;
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: unknown,
      ...args: unknown[]
    ) => {
      if (String(chunk).includes('Waiting for lineage synchronization')) {
        waits++;
        process.emit('SIGINT');
      }
      return (original as (...values: unknown[]) => boolean)(chunk, ...args);
    }) as typeof process.stderr.write);
    try {
      const result = await run(f);
      expect(result.exitCode).toBe(1);
      expect(waits).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('CANCELLED');
      expect(readProjectArtifact(f.writer, id)!.revision).toEqual(prior);
    } finally {
      spy.mockRestore();
      lock.exec('ROLLBACK');
      lock.close();
    }
  });

  it('refuses secret branch input without retaining it', async () => {
    const f = await fixture();
    await f.capture();
    const before = await inventory(f.temporary);
    const result = await run(f, ['--branch', `ghp_${'A'.repeat(36)}`]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('SECRET_IN_PAYLOAD');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('never replaces a missing registered database', async () => {
    const f = await fixture();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const result = await run(f);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('HISTORY_MISSING');
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
