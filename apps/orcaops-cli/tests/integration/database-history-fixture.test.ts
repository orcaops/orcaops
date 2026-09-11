import { stat } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  queryProjectArtifacts,
  queryProjectSearch,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';

import { fixture, git, inventory } from '../helpers/database-history.js';

it('captures exact plans on main and linked registered worktrees', async () => {
  const f = await fixture();
  const criterion = { criterion_id: uuidv7(), text: 'Retain original fixture criterion' };
  const decisions = [
    { decision: 'Retain original fixture decision', reason: 'Original evidence', revision_n: 0 },
  ];
  const id = await f.capture(uuidv7(), {
    task: 'Search punctuation alpha/beta',
    touchedScope: ['fixture-scope'],
    decisions,
    criteria: [criterion],
  });
  const linked = await f.capture(uuidv7(), { cwd: f.linked });
  const original = readProjectArtifact(f.writer, id)!;
  expect(original.thread.plan).toMatchObject({
    task: 'Search punctuation alpha/beta',
    branch: 'main',
    decisions,
    touched_scope: ['fixture-scope'],
  });
  expect(original.thread.plan!.plan_steps[0].acceptance_criteria).toEqual([criterion]);
  expect(
    queryProjectArtifacts(f.writer, { branch: 'main' }).rows.map((row) => row.artifactId)
  ).toEqual([id]);
  expect(
    queryProjectArtifacts(f.writer, { branch: 'linked' }).rows.map((row) => row.artifactId)
  ).toEqual([linked]);
  const binding = readProjectExecution(f.writer, linked)!.state.current_binding!;
  expect(binding.worktree_id).not.toBe(f.registeredContext.binding.worktree_id);
  expect(binding.git_context.branch).toBe('linked');
  expect(
    queryProjectArtifacts(f.writer, { worktreeId: binding.worktree_id }).rows.map(
      (row) => row.artifactId
    )
  ).toEqual([linked]);
}, 20_000);

it('retains unknown and imported associations and completes through actual summary history', async () => {
  const f = await fixture();
  const unknown = await f.capture(uuidv7(), { reason: 'legacy_unknown' });
  const imported = await f.capture(uuidv7(), { reason: 'imported' });
  const completed = await f.capture(uuidv7(), { reason: 'completed' });
  expect(readProjectExecution(f.writer, unknown)).toBeNull();
  expect(readProjectExecution(f.writer, imported)).toBeNull();
  expect(readProjectArtifact(f.writer, imported)!.thread.plan?.origin?.kind).toBe('git-import');
  expect(readProjectArtifact(f.writer, completed)!.thread.summary?.outcome).toBe(
    'Completed fixture'
  );
  expect(readProjectExecution(f.writer, completed)!.state.lifecycle).toBe('completed');
  expect(
    queryProjectArtifacts(f.writer, { origin: 'imported' }).rows.map((row) => row.artifactId)
  ).toEqual([imported]);
  const rows = queryProjectArtifacts(f.writer, {}).rows;
  expect(rows.find((row) => row.artifactId === unknown)?.associationsUnknown).toBe(1);
}, 20_000);

it('searches real checkpoint file evidence without changing retained rows', async () => {
  const f = await fixture();
  const id = await f.capture();
  const original = readProjectArtifact(f.writer, id)!;
  const before = await inventory(f.root);
  await f.recordFiles(id, ['src/needle-module.ts']);
  const after = await inventory(f.root);
  expect(after).not.toEqual(before);
  const snapshot = readProjectArtifact(f.writer, id)!;
  expect(snapshot.thread.events[0]).toEqual(original.thread.events[0]);
  const checkpoint = snapshot.thread.checkpoints[0];
  expect(checkpoint.status).toBe('closed');
  if (checkpoint.status !== 'closed') throw new Error('Fixture checkpoint remained open');
  expect(checkpoint.files_changed).toEqual(['src/needle-module.ts']);
  const result = queryProjectSearch(f.writer, {
    query: ['recorded'],
    touching: 'src/needle-module.ts',
    limit: 20,
    sourceKinds: ['checkpoint'],
  });
  expect(result.rows.map((row) => row.artifact_id)).toContain(id);
  expect(
    queryProjectSearch(f.writer, { query: ['recorded'], touching: 'src/other.ts', limit: 20 }).rows
  ).toEqual([]);
  expect(await inventory(f.root)).toEqual(after);
  expect(Object.keys(after).some((name) => name.endsWith('-wal') || name.endsWith('-shm'))).toBe(
    false
  );
}, 20_000);

it('shares a history root without sharing project identity and closes writers before cleanup', async () => {
  const first = await fixture();
  const second = await fixture(first.root);
  expect(second.authority.projectId).not.toBe(first.authority.projectId);
  const id = await second.capture();
  const outcome = 'Mutated fixture ' + 'retained evidence '.repeat(600);
  await second.mutate(id, { outcome }, async (semantics) =>
    semantics.writeSummary({
      schema_version: 1,
      artifact_id: id,
      outcome,
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: (await git(second.main, ['rev-parse', 'HEAD'])).stdout.trim(),
      ts: '2026-09-05T00:01:00.000Z',
    })
  );
  expect(
    queryProjectSearch(second.writer, {
      query: ['mutated'],
      limit: 10,
      sourceKinds: ['summary'],
    }).rows.map((row) => row.artifact_id)
  ).toEqual([id]);
  const retained = readProjectArtifact(second.writer, id)!;
  expect(retained.thread.summary?.outcome).toBe(outcome);
  expect(retained.sidecarPayloads).toHaveLength(1);
  await first.cleanup();
  expect(() => first.writer.read((view) => view.all('SELECT * FROM operations'))).toThrow();
  expect(() => second.writer.read((view) => view.all('SELECT * FROM operations'))).toThrow();
  await expect(stat(first.temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  await second.cleanup();
  await expect(stat(second.temporary)).rejects.toMatchObject({ code: 'ENOENT' });
}, 20_000);
