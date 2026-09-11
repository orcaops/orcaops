import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverLegacyRepository } from './discovery.js';
import { materializeLegacyFixture, readLegacyFixture } from './legacy-fixture.js';
import { previewLegacyRepository, readLegacyPreviewSqlite } from './preview.js';
import { LEGACY_PRODUCER_VERSION, LEGACY_SOURCE_REVISION } from './profile.js';
import { inventoryLegacySource } from './source-files.js';
import { CANONICAL_PROJECT_DATABASE } from './source-omissions.js';

const directories: string[] = [];

async function materialize() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'orcaops-legacy-')));
  directories.push(directory);
  return materializeLegacyFixture({ directory });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('committed 0.2.0-rc.2 legacy fixture', { timeout: 120_000 }, () => {
  it('carries the frozen producer profile and a hash for every member', async () => {
    const fixture = await readLegacyFixture();
    expect(fixture.producer).toEqual({
      version: LEGACY_PRODUCER_VERSION,
      source_revision: LEGACY_SOURCE_REVISION,
    });
    const members = [...fixture.checkout_members, ...fixture.data_members];
    expect(members.length).toBeGreaterThan(100);
    for (const member of members)
      expect(
        createHash('sha256').update(Buffer.from(member.base64, 'base64')).digest('hex')
      ).toEqual(member.sha256);
    expect(new Set(members.map((member) => member.path)).size).toEqual(members.length);
  });

  it('materializes into a fresh repository whose refs and project identity match the record', async () => {
    const legacy = await materialize();
    expect(legacy.projectId).toEqual(legacy.fixture.project_id);
    const inventory = await discoverLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    expect(inventory.projectId).toEqual(legacy.projectId);
    expect(inventory.inventoryComplete).toBe(true);
    expect(inventory.gitResources.length).toBeGreaterThan(0);
    expect(inventory.gitResources.map((resource) => resource.ref)).toEqual(
      legacy.fixture.repository.refs
        .map((ref) => ref.ref)
        .filter((ref) => ref.startsWith('refs/orcaops/'))
        .sort()
    );
  });

  it('previews the whole fixture as complete with every retained family classified', async () => {
    const legacy = await materialize();
    const preview = await previewLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    expect(preview.issues).toEqual([]);
    expect(preview.unclassified).toEqual([]);
    expect(preview.contentComplete).toBe(true);
    expect(preview.verifiedEmpty).toBe(false);
    expect(preview.activationEligible).toBe(false);
    expect(preview.projectId).toEqual(legacy.projectId);
    expect(preview.producerEvidence).toEqual('unknown');
    const kinds = new Set(preview.resources.map((resource) => resource.kind));
    for (const kind of ['artifact', 'usage', 'sqlite', 'seed', 'seed-state', 'source-plan'])
      expect(kinds).toContain(kind);
    expect(preview.resources.every((resource) => resource.state === 'verified')).toBe(true);
    const artifacts = new Set(
      preview.resources.filter((resource) => resource.kind === 'artifact').map((r) => r.id)
    );
    for (const id of Object.values(legacy.fixture.artifacts)) expect(artifacts).toContain(id);
    expect(preview.representations.length).toBeGreaterThan(0);
    expect(preview.usageSelection?.records.length).toBeGreaterThan(0);
    expect(preview.usageSelection?.occurrences.length).toBeGreaterThan(0);
    expect(preview.retained.map((entry) => entry.family).sort()).toEqual([
      'evaluator-config',
      'installer',
      'installer',
    ]);
  });

  it('exposes the frozen baseline operational rows from the copied SQLite image', async () => {
    const legacy = await materialize();
    const preview = await previewLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    const images = readLegacyPreviewSqlite(preview);
    expect(images).toHaveLength(1);
    const { sqlite } = images[0]!;
    expect(sqlite.baselineVersion).toEqual(25);
    for (const table of [
      'artifacts',
      'cli_session_branch_state',
      'plan_idempotency',
      'idempotency_blocks',
      'source_plan_links',
      'usage_snapshots',
      'evaluator_lifecycles',
    ] as const)
      expect(sqlite.rows[table].length).toBeGreaterThan(0);
    expect(sqlite.rows.evaluator_lifecycles.length).toEqual(
      sqlite.tableCounts.evaluator_lifecycles
    );
  });

  it('discloses the omitted Task Review families without reading their payloads', async () => {
    const legacy = await materialize();
    const secret = 'reviewer narrative that conversion must never read';
    const reviews = path.join(legacy.cwd, '.orcaops', 'reviews', 'thread-1');
    await fs.mkdir(reviews, { recursive: true });
    await fs.writeFile(path.join(reviews, 'thread.json'), JSON.stringify({ note: secret }));
    const archived = path.join(legacy.root, 'projects', legacy.projectId, 'reviews');
    await fs.mkdir(archived, { recursive: true });
    await fs.writeFile(path.join(archived, 'mirror.json'), JSON.stringify({ note: secret }));
    const preview = await previewLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    expect(preview.contentComplete).toBe(true);
    expect(preview.omitted.map((entry) => entry.family).sort()).toEqual([
      'task-review',
      'task-review',
      'task-review-feedback',
      'task-review-refs',
    ]);
    expect(preview.omitted.every((entry) => entry.state === 'intentionally-not-inspected')).toBe(
      true
    );
    expect(JSON.stringify(preview)).not.toContain(secret);
  });

  it('reports canonical target presence outside the source manifest', async () => {
    const legacy = await materialize();
    const before = await discoverLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    expect(before.target).toEqual({
      database: {
        location: path.join(legacy.root, 'projects', legacy.projectId, CANONICAL_PROJECT_DATABASE),
        state: 'absent',
      },
      catalog: {
        location: path.join(legacy.root, 'projects', 'catalog', `${legacy.projectId}.json`),
        state: 'absent',
      },
      // Registration markers are the conversion's own output, named like the target database
      // and never read as legacy sources.
      repository: {
        location: path.join(legacy.cwd, '.git', 'orcaops', 'registration.json'),
        state: 'absent',
      },
      worktree: {
        location: path.join(legacy.cwd, '.git', 'orcaops', 'worktree.json'),
        state: 'absent',
      },
    });
    const database = before.target!.database.location;
    await fs.writeFile(database, 'SQLite format 3\0');
    await fs.writeFile(database + '-wal', '');
    const after = await discoverLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    expect(after.target?.database.state).toEqual('present');
    expect(after.manifestHash).toEqual(before.manifestHash);
    const preview = await previewLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    expect(preview.contentComplete).toBe(true);
    expect(preview.target?.database.state).toEqual('present');
  });

  it('reports its own registration markers as target presence, never as unclassified sources', async () => {
    const legacy = await materialize();
    const markers = path.join(legacy.cwd, '.git', 'orcaops');
    await fs.mkdir(markers, { recursive: true });
    await fs.writeFile(path.join(markers, 'registration.json'), '{"schema_version":1}');
    await fs.writeFile(path.join(markers, 'worktree.json'), '{"schema_version":1}');
    const after = await previewLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    expect(after.target?.repository.state).toEqual('present');
    expect(after.target?.worktree.state).toEqual('present');
    expect(after.unclassified).toEqual([]);
    // A registered repository is no longer a conversion source, and says so once.
    expect(after.contentComplete).toBe(false);
    expect(after.issues.map((issue) => issue.code)).toEqual(['SOURCE_CONFLICT']);
  });

  it('leaves the materialized sources byte-identical after a preview', async () => {
    const legacy = await materialize();
    const before = await inventoryLegacySource({ root: legacy.cwd });
    const archiveBefore = await inventoryLegacySource({ root: legacy.root });
    await previewLegacyRepository({ cwd: legacy.cwd, root: legacy.root, env: legacy.env });
    expect(await inventoryLegacySource({ root: legacy.cwd })).toEqual(before);
    expect(await inventoryLegacySource({ root: legacy.root })).toEqual(archiveBefore);
  });
});
