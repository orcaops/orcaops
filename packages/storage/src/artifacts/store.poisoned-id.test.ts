import { existsSync, readdirSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor, usageLedgerPath } from './paths.js';
import { ArtifactStore } from './store.js';
import { PathContainmentError } from '../paths/containment.js';
import { type Config, getDefaultConfig } from '../schema/config.js';

const ARTIFACT_ID = '01999999-9999-7000-8000-0000000000a1';

function planFor(artifactId: string) {
  return {
    schema_version: 4 as const,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'abc123',
    agent: 'codex' as const,
    agent_session_id: null,
    task: 'exercise resolved containment',
    label: 'resolved containment',
    plan_steps: [
      {
        step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
        text: 'write a contained artifact',
        label: 'contained artifact',
        acceptance_criteria: [],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-01-01T00:00:00.000Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  };
}

/**
 * An artifact id is a path segment, and it does not always arrive from a
 * validated CLI argument — gc, cloud sync, and the active-artifact resolver
 * all take ids from STORED ROWS. A row can be poisoned by anything that ever
 * wrote to the database, so the write paths those ids reach have to refuse a
 * traversal-bearing id before touching the filesystem.
 *
 * `assertSafePathSegment` is unit-tested on its own; these assert that the
 * store's write paths actually route through it, which is the property that
 * would break if a caller built a path by hand.
 */
describe('ArtifactStore — traversal-bearing ids are refused before any filesystem effect', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const POISONED = ['../escape', '..', 'nested/child', '/absolute', 'back\\slash'] as const;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  /** Everything that exists under the repo root, so an escape is visible. */
  function repoEntries(): string[] {
    return readdirSync(repo.path).sort();
  }

  it.each(POISONED)('deleteArtifact(%j) refuses rather than removing anything', async (id) => {
    // The gc path: `orcaops gc` reads candidate ids out of SQLite and hands
    // them straight to deleteArtifact, whose `rm` is recursive.
    const before = repoEntries();

    await expect(store.deleteArtifact(id)).rejects.toThrow(PathContainmentError);

    expect(repoEntries()).toEqual(before);
  });

  it.each(POISONED)('appendBranchLineage(%j) refuses rather than writing', async (id) => {
    // The cloud-sync path: lineage entries are appended for ids resolved from
    // stored rows, not from user input.
    const before = repoEntries();

    await expect(
      store.appendBranchLineage(id, {
        branch: 'feat/x',
        head_sha: 'a'.repeat(40),
        ts: '2026-01-01T00:00:00.000Z',
        event: 'rebased',
      })
    ).rejects.toThrow(PathContainmentError);

    expect(repoEntries()).toEqual(before);
  });

  it.each(POISONED)('readArtifact(%j) refuses rather than reading outside', async (id) => {
    // The resolver path: `resolveActiveArtifactId` returns a row id that every
    // downstream read then resolves to a directory.
    await expect(store.readArtifact(id)).rejects.toThrow(PathContainmentError);
  });

  it('a well-formed id still works, so the guard is not simply rejecting everything', async () => {
    const id = '01999999-9999-7000-8000-0000000000a1';
    await store.writePlan(
      {
        schema_version: 4 as const,
        artifact_id: id,
        branch: 'feat/x',
        base_sha: 'abc123',
        agent: 'claude-code' as const,
        agent_session_id: null,
        task: 'exercise the happy path',
        label: 'happy path',
        plan_steps: [
          {
            step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
            text: 'step 1',
            label: 's1',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-01-01T00:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: '01999999-9999-7000-8000-0000000000b1' }
    );

    expect(existsSync(path.join(repo.path, '.orcaops', 'artifacts', id))).toBe(true);
    await expect(store.deleteArtifact(id)).resolves.toEqual({ deleted: true });
  });
});

describe('ArtifactStore resolved containment', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore | undefined;
  let outside: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    outside = await mkdtemp(path.join(tmpdir(), 'orcaops-storage-outside-'));
  });

  afterEach(async () => {
    store?.close();
    await repo.cleanup();
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses a configured artifacts directory redirected outside the repository', async () => {
    const artifactsPath = path.join(repo.path, config.artifacts.path);
    await mkdir(path.dirname(artifactsPath), { recursive: true });
    await symlink(outside, artifactsPath);
    const sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'unchanged', 'utf8');
    store = new ArtifactStore({ repoRoot: repo.path, config });

    await expect(store.deleteArtifact(ARTIFACT_ID)).rejects.toThrow(PathContainmentError);
    await expect(
      store.writePlan(planFor(ARTIFACT_ID), {
        idempotencyKey: '01999999-9999-7000-8000-0000000000b1',
      })
    ).rejects.toThrow(PathContainmentError);
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
  });

  it('preserves construction when the usage directory is redirected outside the repository', async () => {
    const usagePath = path.join(repo.path, '.orcaops', 'usage');
    await mkdir(path.dirname(usagePath), { recursive: true });
    await symlink(outside, usagePath);

    store = new ArtifactStore({ repoRoot: repo.path, config });
    expect(() => usageLedgerPath(repo.path)).toThrow(PathContainmentError);
  });

  it('refuses an artifact directory symlink to another repository directory', async () => {
    const artifactsPath = path.join(repo.path, config.artifacts.path);
    const sentinelDir = path.join(repo.path, 'source-sentinel');
    const sentinel = path.join(sentinelDir, 'keep.txt');
    await mkdir(artifactsPath, { recursive: true });
    await mkdir(sentinelDir);
    await writeFile(sentinel, 'unchanged', 'utf8');
    await symlink(sentinelDir, path.join(artifactsPath, ARTIFACT_ID));
    store = new ArtifactStore({ repoRoot: repo.path, config });

    await expect(store.deleteArtifact(ARTIFACT_ID)).rejects.toThrow(PathContainmentError);
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
  });

  it('refuses an artifact directory redirected outside before recursive deletion', async () => {
    const artifactsPath = path.join(repo.path, config.artifacts.path);
    await mkdir(artifactsPath, { recursive: true });
    await symlink(outside, path.join(artifactsPath, ARTIFACT_ID));
    const sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'unchanged', 'utf8');
    store = new ArtifactStore({ repoRoot: repo.path, config });

    await expect(store.deleteArtifact(ARTIFACT_ID)).rejects.toThrow(PathContainmentError);
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
  });

  it.each(['', '-wal', '-shm', '-journal'])(
    'refuses a dangling SQLite cache%s symlink before creating its target',
    async (suffix) => {
      const dbPath = path.join(repo.path, config.cache.path);
      const outsideTarget = path.join(outside, `future${suffix || '.db'}`);
      await mkdir(path.dirname(dbPath), { recursive: true });
      await symlink(outsideTarget, `${dbPath}${suffix}`);

      expect(() => new ArtifactStore({ repoRoot: repo.path, config })).toThrow(
        PathContainmentError
      );
      await expect(access(outsideTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('refuses a projection symlink to another repository file before reading it', async () => {
    store = new ArtifactStore({ repoRoot: repo.path, config });
    await store.writePlan(planFor(ARTIFACT_ID), {
      idempotencyKey: '01999999-9999-7000-8000-0000000000b1',
    });
    const paths = artifactPathsFor(repo.path, config, ARTIFACT_ID);
    const repositoryFile = path.join(repo.path, 'source.json');
    await writeFile(repositoryFile, '{"secret":"unchanged"}\n', 'utf8');
    await unlink(paths.planJson);
    await symlink(repositoryFile, paths.planJson);

    await expect(store.readPlan(ARTIFACT_ID)).rejects.toThrow(PathContainmentError);
    expect(await readFile(repositoryFile, 'utf8')).toBe('{"secret":"unchanged"}\n');
  });
});
