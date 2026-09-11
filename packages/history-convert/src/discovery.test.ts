import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverLegacyRepository } from './discovery.js';
import * as observations from './source-files.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const exec = promisify(execFile);
const roots: string[] = [];
const projectId = '01900000-0000-7000-8000-000000000001';
const otherId = '01900000-0000-7000-8000-000000000002';
async function git(cwd: string, ...args: string[]) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key as keyof typeof env];
  return (await exec('git', ['-C', cwd, ...args], { env, encoding: 'utf8' })).stdout.trim();
}
async function fixture(linked = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'orcaops-convert-')));
  roots.push(directory);
  const main = path.join(directory, 'main');
  const sibling = path.join(directory, 'sibling');
  const data = path.join(directory, 'data');
  await fs.mkdir(main);
  await git(main, 'init', '-qb', 'main');
  await git(
    main,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'Initial'
  );
  if (linked) await git(main, 'worktree', 'add', '-qb', 'sibling', sibling);
  return { directory, main, sibling, data };
}
async function write(file: string, value: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('repository source discovery', { timeout: 30_000 }, () => {
  it('inspects every linked checkout without creating identity or source directories', async () => {
    const f = await fixture(true);
    const before = await observations.inventoryLegacySource({ root: f.directory });
    const result = await discoverLegacyRepository({ cwd: f.sibling, root: f.data });
    expect(result.inventoryComplete).toBe(true);
    expect(result.projectId).toBeNull();
    expect(result.worktrees.map((entry) => entry.worktreeRoot).sort()).toEqual([f.main, f.sibling]);
    expect(result.sources.every((source) => source.state === 'absent')).toBe(true);
    expect(result.gitResources).toEqual([]);
    expect(result.layouts).toHaveLength(2);
    expect(
      result.layouts.every(
        (layout) =>
          layout.artifacts === '.orcaops/artifacts' &&
          layout.sqlite === '.orcaops/cache/orcaops.db' &&
          layout.configuration === null
      )
    ).toBe(true);
    expect(await observations.inventoryLegacySource({ root: f.directory })).toEqual(before);
    expect((await discoverLegacyRepository({ cwd: f.sibling, root: f.data })).manifestHash).toBe(
      result.manifestHash
    );
  });

  it('locates configured sources and only the Git-established archive project', async () => {
    const f = await fixture(true);
    await git(f.main, 'config', '--local', 'orcaops.projectid', projectId);
    await write(
      path.join(f.main, '.orcaops/config.json'),
      JSON.stringify({
        schema_version: 5,
        artifacts: { path: '.retained/artifacts' },
        cache: { path: '.local/cache.sqlite' },
      })
    );
    await write(path.join(f.main, '.retained/artifacts/retained.json'), 'private artifact payload');
    await write(path.join(f.main, '.local/cache.sqlite'), 'unique operational bytes');
    await write(path.join(f.sibling, '.orcaops/reviews/retained.json'), 'private review payload');
    await write(
      path.join(f.data, `projects/${projectId}/retained.json`),
      'selected archive payload'
    );
    await write(path.join(f.data, `projects/${otherId}/private.json`), 'unrelated archive payload');
    await write(
      path.join(f.data, 'projects.json'),
      JSON.stringify({
        schema_version: 1,
        projects: {
          [projectId]: { last_seen_paths: [f.main] },
          [otherId]: { last_seen_paths: ['/unrelated/checkout'] },
        },
      })
    );
    await git(f.main, 'update-ref', 'refs/orcaops/snapshot/retained', 'HEAD');
    const opened = vi.spyOn(fs, 'open');
    const result = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(result.inventoryComplete).toBe(true);
    expect(result.projectId).toBe(projectId);
    expect(
      result.sources
        .filter((source) => source.kind === 'archive-project')
        .map((source) => source.relativePath)
    ).toEqual([`projects/${projectId}`]);
    expect(
      result.sources.filter((source) => source.root === f.main).map((source) => source.relativePath)
    ).toEqual([
      '.local/cache.sqlite',
      '.local/cache.sqlite-journal',
      '.local/cache.sqlite-shm',
      '.local/cache.sqlite-wal',
      '.local/seed',
      '.orcaops',
      '.retained/artifacts',
    ]);
    expect(opened.mock.calls.some(([file]) => String(file).includes(otherId))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(
      /private artifact payload|private review payload|selected archive payload|unrelated archive payload|unique operational bytes/
    );
    expect(result.gitResources).toEqual([
      {
        ref: 'refs/orcaops/snapshot/retained',
        oid: await git(f.main, 'rev-parse', 'HEAD'),
        symbolicTarget: null,
      },
    ]);
  });

  it('reports a foreign explicit checkout without inventorying its payloads', async () => {
    const f = await fixture();
    const foreign = await fixture();
    await write(path.join(foreign.main, '.orcaops/private.json'), 'unrelated content');
    const opened = vi.spyOn(fs, 'open');
    const result = await discoverLegacyRepository({
      cwd: f.main,
      root: f.data,
      additionalCheckouts: [foreign.main],
    });
    expect(result.inventoryComplete).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_CONFLICT', location: foreign.main })
    );
    expect(result.sources.some((source) => source.root === foreign.main)).toBe(false);
    expect(opened.mock.calls.some(([file]) => String(file).includes('private.json'))).toBe(false);
  });

  it('expands shared personal paths in each governed checkout and retains external cache companions', async () => {
    const f = await fixture(true);
    await write(
      path.join(f.main, '.git/orcaops/config.json'),
      JSON.stringify({
        schema_version: 6,
        install: { scope: 'personal' },
        artifacts: { path: '.retained/artifacts' },
        cache: { path: '.local/cache.sqlite' },
      })
    );
    await write(
      path.join(f.sibling, '.retained/artifacts/history.json'),
      'personal retained payload'
    );
    await write(path.join(f.sibling, '.local/cache.sqlite-wal'), 'unique committed WAL bytes');
    await write(path.join(f.sibling, '.local/seed/journal.json'), 'pending seed source');
    const before = await observations.inventoryLegacySource({ root: f.directory });
    const result = await discoverLegacyRepository({ cwd: f.sibling, root: f.data });
    expect(result.inventoryComplete).toBe(true);
    for (const checkout of [f.main, f.sibling])
      expect(result.sources).toContainEqual(
        expect.objectContaining({ root: checkout, relativePath: '.retained/artifacts' })
      );
    expect(
      result.layouts.map((layout) => ({
        root: layout.root,
        artifacts: layout.artifacts,
        seed: layout.seed,
        config: layout.configuration?.root,
      }))
    ).toEqual(
      expect.arrayContaining(
        [f.main, f.sibling].map((root) => ({
          root,
          artifacts: '.retained/artifacts',
          seed: '.local/seed',
          config: path.join(f.main, '.git'),
        }))
      )
    );
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        root: f.sibling,
        relativePath: '.local/cache.sqlite-wal',
        state: 'available',
      })
    );
    expect(result.sources).toContainEqual(
      expect.objectContaining({ root: f.sibling, relativePath: '.local/seed', state: 'available' })
    );
    expect(JSON.stringify(result)).not.toMatch(
      /personal retained payload|unique committed WAL bytes|pending seed source/
    );
    expect(await observations.inventoryLegacySource({ root: f.directory })).toEqual(before);
  });

  it('honors worktree configuration precedence without accepting a misplaced personal scope', async () => {
    const f = await fixture(true);
    await write(
      path.join(f.main, '.git/orcaops/config.json'),
      JSON.stringify({
        schema_version: 6,
        install: { scope: 'personal' },
        artifacts: { path: 'shared-history' },
      })
    );
    await write(
      path.join(f.main, '.orcaops/config.json'),
      JSON.stringify({
        schema_version: 6,
        artifacts: { path: 'local-history' },
      })
    );
    const result = await discoverLegacyRepository({ cwd: f.sibling, root: f.data });
    expect(result.inventoryComplete).toBe(true);
    expect(result.sources).toContainEqual(
      expect.objectContaining({ root: f.main, relativePath: 'local-history' })
    );
    expect(result.sources).not.toContainEqual(
      expect.objectContaining({ root: f.main, relativePath: 'shared-history' })
    );
    expect(result.sources).toContainEqual(
      expect.objectContaining({ root: f.sibling, relativePath: 'shared-history' })
    );
    await write(
      path.join(f.main, '.orcaops/config.json'),
      JSON.stringify({ schema_version: 6, install: { scope: 'personal' } })
    );
    const invalid = await discoverLegacyRepository({ cwd: f.sibling, root: f.data });
    expect(invalid.inventoryComplete).toBe(false);
    expect(invalid.issues).toContainEqual(
      expect.objectContaining({
        location: path.join(f.main, '.orcaops/config.json'),
        code: 'SOURCE_INTEGRITY',
      })
    );
    expect(invalid.layouts.some((layout) => layout.root === f.main)).toBe(false);
  });

  it('revalidates the governing shared config and rejects unattested additional paths without opening them', async () => {
    const f = await fixture(true);
    const file = path.join(f.main, '.git/orcaops/config.json');
    await write(file, JSON.stringify({ schema_version: 6, install: { scope: 'personal' } }));
    const inventory = observations.inventoryLegacySource;
    vi.spyOn(observations, 'inventoryLegacySource').mockImplementation(async (input) => {
      const result = await inventory(input);
      if (input.root.endsWith('.git/orcaops'))
        await write(
          file,
          JSON.stringify({
            schema_version: 6,
            install: { scope: 'personal' },
            artifacts: { path: 'changed' },
          })
        );
      return result;
    });
    await expect(discoverLegacyRepository({ cwd: f.sibling, root: f.data })).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
    vi.restoreAllMocks();
    const foreign = path.join(f.directory, 'unassociated.json');
    await write(foreign, 'unattested private bytes');
    const opened = vi.spyOn(fs, 'open');
    const result = await discoverLegacyRepository({
      cwd: f.sibling,
      root: f.data,
      additionalSourcePaths: [foreign],
    });
    expect(result.inventoryComplete).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ location: foreign, code: 'SOURCE_CONFLICT' })
    );
    expect(opened.mock.calls.some(([file]) => String(file) === foreign)).toBe(false);
  });

  it('keeps a deleted registered worktree explicitly unavailable', async () => {
    const f = await fixture(true);
    await fs.rm(f.sibling, { recursive: true });
    const result = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(result.inventoryComplete).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_UNAVAILABLE', location: f.sibling })
    );
  });

  it('does not let catalog hints mint or select a repository identity', async () => {
    const f = await fixture();
    await write(
      path.join(f.data, 'projects.json'),
      JSON.stringify({
        schema_version: 1,
        projects: { [projectId]: { last_seen_paths: [f.main] } },
      })
    );
    await write(path.join(f.data, `projects/${projectId}/private.json`), 'unproved history');
    const result = await discoverLegacyRepository({
      cwd: f.main,
      root: f.data,
      expectedProjectId: projectId,
    });
    expect(result.projectId).toBeNull();
    expect(result.inventoryComplete).toBe(false);
    expect(result.sources.some((source) => source.kind === 'archive-project')).toBe(false);
    expect(result.issues.filter((issue) => issue.code === 'SOURCE_CONFLICT')).toHaveLength(2);
    expect(await git(f.main, 'config', '--local', '--list')).not.toContain('orcaops.projectid');
  });

  it('refuses unsupported config and symlinked custom source parents', async () => {
    const f = await fixture();
    const outside = await fixture();
    await write(path.join(outside.main, 'retained/private.json'), 'outside bytes');
    await write(
      path.join(f.main, '.orcaops/config.json'),
      JSON.stringify({ schema_version: 6, artifacts: { path: 'linked/retained' } })
    );
    await fs.symlink(outside.main, path.join(f.main, 'linked'));
    const result = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(result.inventoryComplete).toBe(false);
    expect(result.sources.find((source) => source.relativePath === 'linked/retained')?.state).toBe(
      'unavailable'
    );
    await write(
      path.join(f.main, '.orcaops/config.json'),
      JSON.stringify({
        schema_version: 4,
        artifacts: { path: 'linked/retained' },
        llm: {
          default_session_max_cost_usd: 2,
          default_timeout_ms: 30_000,
          json_mode: 'auto',
          session: {
            persist: false,
            max_age_minutes: 120,
            invalidate_on_model_change: true,
          },
        },
        watch: {},
      })
    );
    const predecessor = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(predecessor.sources.find((source) => source.relativePath === 'linked/retained')).toEqual(
      expect.objectContaining({ state: 'unavailable' })
    );
    await write(
      path.join(f.main, '.orcaops/config.json'),
      JSON.stringify({
        schema_version: 4,
        llm: { session: { max_age_minutes: 0 } },
        artifacts: { path: 'linked/retained' },
      })
    );
    const malformedPredecessor = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(malformedPredecessor.issues).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_INTEGRITY' })
    );
    expect(
      malformedPredecessor.sources.some((source) => source.relativePath === 'linked/retained')
    ).toBe(false);
    await write(
      path.join(f.main, '.orcaops/config.json'),
      JSON.stringify({ schema_version: 4, watch: { theme: 'dark', unknown_location: 'history' } })
    );
    const unknownWatch = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(unknownWatch.issues).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_INTEGRITY' })
    );
    await write(
      path.join(f.main, '.orcaops/config.json'),
      JSON.stringify({ schema_version: 3, artifacts: { path: 'linked/retained' } })
    );
    const unsupported = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(unsupported.issues).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_INTEGRITY' })
    );
    expect(unsupported.sources.some((source) => source.relativePath === 'linked/retained')).toBe(
      false
    );
  });

  it('rejects a config mutation after custom source selection', async () => {
    const f = await fixture();
    const file = path.join(f.main, '.orcaops/config.json');
    await write(file, JSON.stringify({ schema_version: 6, artifacts: { path: '.first' } }));
    const inventory = observations.inventoryLegacySource;
    vi.spyOn(observations, 'inventoryLegacySource').mockImplementation(async (input) => {
      const result = await inventory(input);
      if (input.root.endsWith('.orcaops'))
        await write(file, JSON.stringify({ schema_version: 6, artifacts: { path: '.other' } }));
      return result;
    });
    await expect(discoverLegacyRepository({ cwd: f.main, root: f.data })).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
  });

  it('reports existing canonical format without treating it as a legacy import target', async () => {
    const f = await fixture();
    await git(f.main, 'config', '--local', 'orcaops.projectid', projectId);
    await write(path.join(f.data, `projects/${projectId}/history-format.json`), '{}');
    const result = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(result.inventoryComplete).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_CONFLICT', location: 'history-format.json' })
    );
  });

  it('reports expected missing archive history and probes installed markers without decoding them', async () => {
    const f = await fixture();
    await git(f.main, 'config', '--local', 'orcaops.projectid', projectId);
    await write(
      path.join(f.data, 'projects.json'),
      JSON.stringify({
        schema_version: 1,
        projects: { [projectId]: { last_seen_paths: [f.main] } },
      })
    );
    await write(
      path.join(f.main, '.claude/skills/orcaops-capture/SKILL.md'),
      'installed instruction payload'
    );
    const opened = vi.spyOn(fs, 'open');
    const result = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(result.inventoryComplete).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_UNAVAILABLE', location: `projects/${projectId}` })
    );
    expect(result.presenceChecks).toContainEqual(
      expect.objectContaining({
        relative_location: '.claude/skills/orcaops-capture/SKILL.md',
        state: 'present',
      })
    );
    expect(opened.mock.calls.some(([file]) => String(file).endsWith('SKILL.md'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('installed instruction payload');
  });
  it('refuses foreign registry hints through direct and symlink checkout paths without adopting them', async () => {
    const f = await fixture();
    await git(f.main, 'config', '--local', 'orcaops.projectid', projectId);
    const alias = path.join(f.directory, 'checkout-alias');
    await fs.symlink(f.main, alias, 'dir');
    for (const hint of [f.main, alias]) {
      await write(
        path.join(f.data, 'projects.json'),
        JSON.stringify({ schema_version: 1, projects: { [otherId]: { last_seen_paths: [hint] } } })
      );
      const before = await observations.inventoryLegacySource({ root: f.data });
      const result = await discoverLegacyRepository({ cwd: f.main, root: f.data });
      expect(result.inventoryComplete).toBe(false);
      expect(result.projectId).toBe(projectId);
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_CONFLICT' }));
      expect(result.sources.some((source) => source.relativePath === `projects/${otherId}`)).toBe(
        false
      );
      expect(await observations.inventoryLegacySource({ root: f.data })).toEqual(before);
    }
    await write(
      path.join(f.data, 'projects.json'),
      JSON.stringify({
        schema_version: 1,
        projects: { [otherId]: { last_seen_paths: [path.join(f.directory, 'absent')] } },
      })
    );
    const unrelated = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(unrelated.inventoryComplete).toBe(true);
    expect(unrelated.projectId).toBe(projectId);
  });
  it('keeps inaccessible registry hint resolution unavailable without creating source or target state', async () => {
    const f = await fixture();
    const hint = path.join(f.directory, 'unavailable');
    await write(
      path.join(f.data, 'projects.json'),
      JSON.stringify({ schema_version: 1, projects: { [otherId]: { last_seen_paths: [hint] } } })
    );
    const before = await observations.inventoryLegacySource({ root: f.directory });
    const resolve = fs.realpath;
    vi.spyOn(fs, 'realpath').mockImplementation(async (file, options) => {
      if (String(file) === hint)
        throw Object.assign(new Error('access refused'), { code: 'EACCES' });
      return resolve(file, options as never);
    });
    const result = await discoverLegacyRepository({ cwd: f.main, root: f.data });
    expect(result.inventoryComplete).toBe(false);
    expect(result.projectId).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
    expect(await observations.inventoryLegacySource({ root: f.directory })).toEqual(before);
  });
  it('rejects an alias target changed after the registry membership observation', async () => {
    const f = await fixture();
    const unrelated = path.join(f.directory, 'unrelated');
    await fs.mkdir(unrelated);
    const alias = path.join(f.directory, 'checkout-alias');
    await fs.symlink(unrelated, alias, 'dir');
    await write(
      path.join(f.data, 'projects.json'),
      JSON.stringify({ schema_version: 1, projects: { [otherId]: { last_seen_paths: [alias] } } })
    );
    const observe = observations.observeLegacySourceFile;
    let changed = false;
    vi.spyOn(observations, 'observeLegacySourceFile').mockImplementation(async (input) => {
      const result = await observe(input);
      if (input.relativePath === 'projects.json' && !input.includeBytes && !changed) {
        changed = true;
        await fs.unlink(alias);
        await fs.symlink(f.main, alias, 'dir');
      }
      return result;
    });
    await expect(discoverLegacyRepository({ cwd: f.main, root: f.data })).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
    expect(changed).toBe(true);
    expect(await fs.readdir(f.data)).toEqual(['projects.json']);
  });
});
