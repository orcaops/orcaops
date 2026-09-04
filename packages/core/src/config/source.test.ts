import { execFileSync } from 'node:child_process';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLinkedWorktree, createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { loadConfig, loadReadOnlyProjectConfig } from './load.js';
import {
  clearCommonDirCache,
  commonConfigLocation,
  configLocationForScope,
  resolveCommonDir,
  resolveConfigSource,
  worktreeConfigLocation,
} from './source.js';
import { Repo } from '../git/repo.js';

const personalConfig = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify(
    {
      schema_version: 6,
      install: { agents: ['claude-code'], scope: 'personal' },
      bootstrap: 'manual',
      session_hooks: { enabled: true, payload: 'static', entries: 'none' },
      ...extra,
    },
    null,
    2
  )}\n`;

const projectConfig = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify(
    { schema_version: 6, install: { agents: ['codex'], scope: 'project' }, ...extra },
    null,
    2
  )}\n`;

async function writeCommonConfig(worktreeRoot: string, body: string): Promise<string> {
  const location = await commonConfigLocation(worktreeRoot);
  await mkdir(path.dirname(location.configPath), { recursive: true });
  await writeFile(location.configPath, body, 'utf8');
  return location.configPath;
}

async function writeWorktreeConfig(worktreeRoot: string, body: string): Promise<string> {
  const location = worktreeConfigLocation(worktreeRoot);
  await mkdir(path.dirname(location.configPath), { recursive: true });
  await writeFile(location.configPath, body, 'utf8');
  return location.configPath;
}

describe('resolveConfigSource', () => {
  let main: TempRepo;
  let linked: TempRepo;

  beforeEach(async () => {
    clearCommonDirCache();
    main = await createTempRepo();
    linked = await createLinkedWorktree(main.path);
  });
  afterEach(async () => {
    await linked.cleanup();
    await main.cleanup();
    clearCommonDirCache();
  });

  it('reports an uninitialized repository when no config exists anywhere', async () => {
    const source = await resolveConfigSource(linked.path);
    expect(source.kind).toBe('none');
    expect(source.raw).toBeUndefined();
  });

  it('throws ENOENT for a missing config when allowMissing is false', async () => {
    await expect(resolveConfigSource(linked.path, { allowMissing: false })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('places the shared config in the common dir, where git-path would not', async () => {
    const repo = new Repo(linked.path);
    const commonDir = await repo.getCommonDirAbsolute();
    const location = await commonConfigLocation(linked.path);
    expect(location.configPath).toBe(path.join(commonDir, 'orcaops', 'config.json'));
    expect(location.containmentRoot).toBe(commonDir);

    // The reason this resolver exists: git only maps paths it knows to the
    // common dir. An unknown one lands in the LINKED worktree's own git dir,
    // which would give every worktree a private copy of the "shared" config.
    const viaGitPath = await repo.getGitPathAbsolute(path.join('orcaops', 'config.json'));
    expect(viaGitPath).not.toBe(location.configPath);
    expect(viaGitPath.startsWith(path.join(commonDir, 'worktrees'))).toBe(true);
  });

  it('resolves the same common dir from the main worktree and a linked one', async () => {
    expect(await resolveCommonDir(linked.path)).toBe(await resolveCommonDir(main.path));
  });

  it('reuses validated main, linked, and nested cache entries without another Git probe', async () => {
    const nested = path.join(linked.path, 'nested');
    await mkdir(nested);
    const roots = [main.path, linked.path, nested];
    const commonDirs = await Promise.all(roots.map((root) => resolveCommonDir(root)));
    const commonDirProbe = vi.spyOn(Repo.prototype, 'getCommonDirAbsolute');
    const gitDirProbe = vi.spyOn(Repo.prototype, 'getGitDirAbsolute');

    try {
      await expect(Promise.all(roots.map((root) => resolveCommonDir(root)))).resolves.toEqual(
        commonDirs
      );
      expect(commonDirProbe).not.toHaveBeenCalled();
      expect(gitDirProbe).not.toHaveBeenCalled();
    } finally {
      commonDirProbe.mockRestore();
      gitDirProbe.mockRestore();
    }
  });

  it('revalidates a cached worktree path after it joins a different repository', async () => {
    const reusedPath = linked.path;
    const firstCommonDir = await resolveCommonDir(reusedPath);
    const staleGitDir = await new Repo(reusedPath).getGitDirAbsolute();
    await rm(reusedPath, { recursive: true, force: true });
    expect((await lstat(staleGitDir)).isDirectory()).toBe(true);
    const replacement = await createTempRepo();
    try {
      await mkdir(path.dirname(reusedPath), { recursive: true });
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'replacement-cache', reusedPath], {
        cwd: replacement.path,
      });

      const replacementCommonDir = await resolveCommonDir(replacement.path);
      expect(replacementCommonDir).not.toBe(firstCommonDir);
      expect(await resolveCommonDir(reusedPath)).toBe(replacementCommonDir);
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', reusedPath], {
        cwd: replacement.path,
      });
      await replacement.cleanup();
    }
  });

  it('lets a subdirectory root inherit the repository personal config', async () => {
    await writeCommonConfig(main.path, personalConfig());
    const nested = path.join(main.path, 'nested', 'root');
    await mkdir(nested, { recursive: true });

    const source = await resolveConfigSource(nested);

    expect(source.kind).toBe('common');
    expect(source.worktreeRoot).toBe(nested);
    expect(source.configPath).toBe((await commonConfigLocation(main.path)).configPath);
  });

  it('loads a common personal config from a linked worktree', async () => {
    const configPath = await writeCommonConfig(linked.path, personalConfig());
    const source = await resolveConfigSource(linked.path);
    expect(source.kind).toBe('common');
    expect(source.configPath).toBe(configPath);
    // Containment is the common dir, not the worktree: the common dir sits
    // outside every linked worktree, so checking against the worktree root
    // would reject the file the user just installed.
    expect(source.containmentRoot).toBe(await resolveCommonDir(linked.path));
    expect(source.worktreeRoot).toBe(path.resolve(linked.path));

    const config = await loadConfig(linked.path);
    expect(config.install.scope).toBe('personal');
    expect(config.install.agents).toEqual(['claude-code']);
  });

  it('serves one common personal config to every worktree of the repo', async () => {
    await writeCommonConfig(main.path, personalConfig());
    for (const root of [main.path, linked.path]) {
      const source = await resolveConfigSource(root);
      expect(source.kind).toBe('common');
      expect(source.worktreeRoot).toBe(path.resolve(root));
    }
  });

  it('lets a worktree project config win over the shared personal one', async () => {
    await writeCommonConfig(linked.path, personalConfig());
    const worktreePath = await writeWorktreeConfig(linked.path, projectConfig());

    const source = await resolveConfigSource(linked.path);
    expect(source.kind).toBe('worktree');
    expect(source.configPath).toBe(worktreePath);
    expect((await loadConfig(linked.path)).install.agents).toEqual(['codex']);

    // The sibling still sees the shared config — project scope belongs to the
    // checked-out branch, not the repository.
    expect((await resolveConfigSource(main.path)).kind).toBe('common');
  });

  it('falls back to the shared config once the project config disappears', async () => {
    await writeCommonConfig(linked.path, personalConfig());
    await writeWorktreeConfig(linked.path, projectConfig());
    expect((await resolveConfigSource(linked.path)).kind).toBe('worktree');

    await rm(path.join(linked.path, '.orcaops', 'config.json'));
    expect((await resolveConfigSource(linked.path)).kind).toBe('common');
  });

  it('refuses a worktree config claiming personal scope, naming the recovery', async () => {
    const configPath = await writeWorktreeConfig(linked.path, personalConfig());
    await expect(resolveConfigSource(linked.path)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      path: 'install.scope',
      message: expect.stringContaining(configPath),
    });
    await expect(resolveConfigSource(linked.path)).rejects.toThrow(/init --personal/);
  });

  it('refuses a common config that does not declare personal scope', async () => {
    await writeCommonConfig(linked.path, projectConfig());
    await expect(resolveConfigSource(linked.path)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      path: 'install.scope',
      message: expect.stringContaining('"project"'),
    });
  });

  it('refuses a common config that omits the scope rather than defaulting it', async () => {
    await writeCommonConfig(
      linked.path,
      `${JSON.stringify({ schema_version: 6, install: { agents: ['claude-code'] } })}\n`
    );
    await expect(resolveConfigSource(linked.path)).rejects.toThrow(/\(absent\)/);
  });

  it('fails closed on a malformed worktree config instead of using the shared one', async () => {
    await writeCommonConfig(linked.path, personalConfig());
    await writeWorktreeConfig(linked.path, '{ not json');
    await expect(resolveConfigSource(linked.path)).rejects.toThrow(/is not valid JSON/);
  });

  it('reports uninitialized outside a git repository', async () => {
    const outside = await createTempRepo();
    try {
      await rm(path.join(outside.path, '.git'), { recursive: true, force: true });
      expect((await resolveConfigSource(outside.path)).kind).toBe('none');
    } finally {
      await outside.cleanup();
    }
  });

  it('does not leak a personal install into an unrelated repository', async () => {
    await writeCommonConfig(linked.path, personalConfig());
    const unrelated = await createTempRepo();
    try {
      expect((await resolveConfigSource(unrelated.path)).kind).toBe('none');
    } finally {
      await unrelated.cleanup();
    }
  });
});

describe('configLocationForScope', () => {
  let main: TempRepo;

  beforeEach(async () => {
    clearCommonDirCache();
    main = await createTempRepo();
  });
  afterEach(async () => {
    await main.cleanup();
    clearCommonDirCache();
  });

  it('targets the common dir for personal and the worktree for project/global', async () => {
    const commonDir = await resolveCommonDir(main.path);
    const personal = await configLocationForScope(main.path, 'personal');
    expect(personal.configPath).toBe(path.join(commonDir, 'orcaops', 'config.json'));
    expect(personal.evaluatorsPath).toBe(path.join(commonDir, 'orcaops', 'evaluators.yaml'));

    for (const scope of ['project', 'global'] as const) {
      const location = await configLocationForScope(main.path, scope);
      expect(location.configPath).toBe(path.join(main.path, '.orcaops', 'config.json'));
      expect(location.containmentRoot).toBe(path.resolve(main.path));
    }
  });
});

describe('loadReadOnlyProjectConfig', () => {
  let main: TempRepo;
  let linked: TempRepo;

  beforeEach(async () => {
    clearCommonDirCache();
    main = await createTempRepo();
    linked = await createLinkedWorktree(main.path);
  });
  afterEach(async () => {
    await linked.cleanup();
    await main.cleanup();
    clearCommonDirCache();
  });

  it('reads the same source as loadConfig, keeping the projected leaves', async () => {
    await writeCommonConfig(
      linked.path,
      personalConfig({
        artifacts: { path: 'custom/artifacts' },
        cache: { path: 'custom/cache' },
        capture: { exclude: ['vendor/**'] },
        redact: { allow: ['NOT_A_SECRET'] },
      })
    );

    const projected = await loadReadOnlyProjectConfig(linked.path);
    expect(projected.artifacts.path).toBe('custom/artifacts');
    expect(projected.cache.path).toBe('custom/cache');
    expect(projected.capture.exclude).toEqual(['vendor/**']);
    expect(projected.redact.allow).toEqual(['NOT_A_SECRET']);
  });

  it('stays non-version-gated on the shared source', async () => {
    await writeCommonConfig(
      linked.path,
      `${JSON.stringify({
        schema_version: 999,
        install: { scope: 'personal' },
        artifacts: { path: 'ahead/artifacts' },
      })}\n`
    );
    // loadConfig refuses a version it does not know; the read-only projection
    // deliberately does not, so watch and the review floor keep working across
    // worktrees written by different Orcaops versions.
    await expect(loadConfig(linked.path)).rejects.toThrow();
    expect((await loadReadOnlyProjectConfig(linked.path)).artifacts.path).toBe('ahead/artifacts');
  });
});
