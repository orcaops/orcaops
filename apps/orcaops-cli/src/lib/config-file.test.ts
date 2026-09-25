import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearCommonDirCache, commonConfigLocation, Repo } from '@orcaops/core';
import { CONFIG_SCHEMA_VERSION } from '@orcaops/storage';
import { createLinkedWorktree, createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  displayConfigPath,
  openConfigForScope,
  openEffectiveConfig,
  refuseTrackedPersonalTransition,
  trackedProjectInstallPaths,
  writeConfigDocument,
  writeKnowledgeProcessingSection,
} from './config-file.js';

const personal = JSON.stringify({
  schema_version: 6,
  install: { agents: ['claude-code'], scope: 'personal' },
});

describe('config-file', () => {
  let main: TempRepo;
  let linked: TempRepo;

  beforeEach(async () => {
    clearCommonDirCache();
    main = await createTempRepo({ initialBranch: 'main' });
    linked = await createLinkedWorktree(main.path);
  });
  afterEach(async () => {
    await linked.cleanup();
    await main.cleanup();
    clearCommonDirCache();
  });

  it('shows a worktree config repo-relative and the shared one absolute', async () => {
    const shared = await commonConfigLocation(linked.path);
    expect(displayConfigPath(shared, linked.path)).toBe(shared.configPath);
    expect(path.isAbsolute(displayConfigPath(shared, linked.path))).toBe(true);
    const worktree = await openConfigForScope(main.path, 'project').catch(() => null);
    expect(worktree).toBeNull();
    expect(
      displayConfigPath(
        { ...shared, origin: 'worktree', configPath: path.join(main.path, '.orcaops/config.json') },
        main.path
      )
    ).toBe(path.join('.orcaops', 'config.json'));
  });

  it('opens the shared config from a linked worktree and writes it back in place', async () => {
    const shared = await commonConfigLocation(linked.path);
    await mkdir(path.dirname(shared.configPath), { recursive: true });
    await writeFile(shared.configPath, personal, 'utf8');

    const document = await openEffectiveConfig(linked.path);
    expect(document.location.origin).toBe('common');
    // Containment is the common dir: a worktree-rooted check would refuse
    // the file the resolver just selected.
    expect(document.location.containmentRoot).toBe(shared.containmentRoot);
    document.raw.archive = { enabled: false };
    await writeConfigDocument(document);

    const after = JSON.parse(await readFile(shared.configPath, 'utf8')) as {
      archive: { enabled: boolean };
      install: { scope: string };
    };
    expect(after.archive.enabled).toBe(false);
    expect(after.install.scope).toBe('personal');
  });

  it('reports an uninitialized repository as UNINITIALIZED', async () => {
    await expect(openEffectiveConfig(linked.path)).rejects.toMatchObject({
      code: 'UNINITIALIZED',
    });
  });

  it('targets the destination scope, not the effective source', async () => {
    const shared = await commonConfigLocation(main.path);
    await mkdir(path.dirname(shared.configPath), { recursive: true });
    await writeFile(shared.configPath, personal, 'utf8');
    // Effective source is the shared personal config; a project destination
    // is still the (absent) worktree file.
    await expect(openConfigForScope(main.path, 'project')).rejects.toMatchObject({
      code: 'UNINITIALIZED',
    });
    expect((await openConfigForScope(main.path, 'personal')).location.origin).toBe('common');
  });

  it('names only the tracked install files, and points the refusal at update', async () => {
    await mkdir(path.join(main.path, '.orcaops'), { recursive: true });
    await writeFile(path.join(main.path, '.orcaops', 'config.json'), '{}', 'utf8');
    await writeFile(path.join(main.path, '.orcaops', 'install.json'), '{}', 'utf8');
    execFileSync('git', ['add', '.orcaops/config.json'], { cwd: main.path });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'cfg'], {
      cwd: main.path,
    });

    const tracked = await trackedProjectInstallPaths(new Repo(main.path), [
      path.join('.orcaops', 'config.json'),
      path.join('.orcaops', 'install.json'),
    ]);
    expect(tracked).toEqual([path.join('.orcaops', 'config.json')]);

    const err = refuseTrackedPersonalTransition(tracked);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('.orcaops/config.json');
    expect(err.message).toContain('orcaops update --scope personal');
  });
});

describe('the schema version a config write stamps', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    clearCommonDirCache();
    repo = await createTempRepo({ initialBranch: 'main' });
  });
  afterEach(async () => {
    await repo.cleanup();
    clearCommonDirCache();
  });

  const configPath = () => path.join(repo.path, '.orcaops', 'config.json');
  const writeProjectConfig = async ({
    schema_version,
    ...rest
  }: Record<string, unknown>): Promise<string> => {
    const document = { schema_version, install: { agents: [], scope: 'project' }, ...rest };
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    await mkdir(path.dirname(configPath()), { recursive: true });
    await writeFile(configPath(), raw, 'utf8');
    return raw;
  };
  const readProjectConfig = async () =>
    JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, unknown>;

  it.each([5, 6, 7])('stays %i when a per-key write touches another key', async (version) => {
    await writeProjectConfig({ schema_version: version });

    const document = await openEffectiveConfig(repo.path);
    document.raw.skills = { enabled: { digest: false } };
    await writeConfigDocument(document);

    expect(await readProjectConfig()).toMatchObject({
      schema_version: version,
      skills: { enabled: { digest: false } },
    });
  });

  it.each([5, 6, 7])(
    'moves from %i to version 8 in the write that first adds knowledge_processing',
    async (version) => {
      await writeProjectConfig({ schema_version: version, naming: { prefix: 'oo' } });

      const plan = await writeKnowledgeProcessingSection(await openEffectiveConfig(repo.path), {
        enabled: true,
        max_calls_per_hour: 30,
      });

      expect(plan.versionChange).toEqual({ from: version, to: 8 });
      expect(plan.config.knowledge_processing).toMatchObject({
        enabled: true,
        max_calls_per_hour: 30,
      });
      const written = await readProjectConfig();
      expect(Object.keys(written)[0]).toBe('schema_version');
      expect(written).toEqual({
        schema_version: 8,
        install: { agents: [], scope: 'project' },
        naming: { prefix: 'oo' },
        knowledge_processing: { enabled: true, max_calls_per_hour: 30 },
      });
    }
  );

  it.each([[{ enabled: false }], [{}], [{ enabled: false, max_attempts: 3, model: 'inherit' }]])(
    'leaves a version 6 file without the section untouched by the edit %j',
    async (settings) => {
      const raw = await writeProjectConfig({ schema_version: 6, naming: { prefix: 'oo' } });

      const plan = await writeKnowledgeProcessingSection(
        await openEffectiveConfig(repo.path),
        settings
      );

      expect(plan.changed).toBe(false);
      expect(plan.versionChange).toBeNull();
      expect(plan.config.knowledge_processing.enabled).toBe(false);
      expect(plan.document.raw).not.toHaveProperty('knowledge_processing');
      expect(await readFile(configPath(), 'utf8')).toBe(raw);
    }
  );

  it('still writes and stamps when the first edit enables processing', async () => {
    await writeProjectConfig({ schema_version: 6 });

    const plan = await writeKnowledgeProcessingSection(await openEffectiveConfig(repo.path), {
      enabled: true,
    });

    expect(plan.changed).toBe(true);
    expect(plan.versionChange).toEqual({ from: 6, to: 8 });
    expect(await readProjectConfig()).toMatchObject({
      schema_version: 8,
      knowledge_processing: { enabled: true },
    });
  });

  it('moves a version 7 file to 8 when restricted Codex access is selected', async () => {
    await writeProjectConfig({ schema_version: 7, workflow: { commit_inside_window: false } });

    const plan = await writeKnowledgeProcessingSection(await openEffectiveConfig(repo.path), {
      tool_access: 'codex_restricted',
    });

    expect(plan.versionChange).toEqual({ from: 7, to: CONFIG_SCHEMA_VERSION });
    expect(await readProjectConfig()).toMatchObject({
      schema_version: CONFIG_SCHEMA_VERSION,
      workflow: { commit_inside_window: false },
      knowledge_processing: { tool_access: 'codex_restricted' },
    });
  });

  it('writes a first edit that sets an optional limit and nothing else', async () => {
    await writeProjectConfig({ schema_version: 6 });

    const plan = await writeKnowledgeProcessingSection(await openEffectiveConfig(repo.path), {
      max_cost_usd_per_day: 5,
    });

    expect(plan.changed).toBe(true);
    expect((await readProjectConfig()).knowledge_processing).toEqual({ max_cost_usd_per_day: 5 });
  });

  it('writes a disable over a section that enabled processing', async () => {
    await writeProjectConfig({
      schema_version: CONFIG_SCHEMA_VERSION,
      knowledge_processing: { enabled: true },
    });

    const plan = await writeKnowledgeProcessingSection(await openEffectiveConfig(repo.path), {
      enabled: false,
    });

    expect(plan.changed).toBe(true);
    expect((await readProjectConfig()).knowledge_processing).toEqual({ enabled: false });
  });

  it('does not rewrite a file whose section already says the same', async () => {
    const raw = await writeProjectConfig({
      schema_version: CONFIG_SCHEMA_VERSION,
      knowledge_processing: { enabled: true },
    });
    const compact = JSON.stringify(JSON.parse(raw));
    await writeFile(configPath(), compact, 'utf8');

    const plan = await writeKnowledgeProcessingSection(await openEffectiveConfig(repo.path), {
      enabled: true,
    });

    expect(plan.changed).toBe(false);
    expect(await readFile(configPath(), 'utf8')).toBe(compact);
  });

  it('edits only the named keys of an existing section, and removes one given as undefined', async () => {
    await writeProjectConfig({
      schema_version: CONFIG_SCHEMA_VERSION,
      knowledge_processing: { enabled: true, model: 'claude-opus', max_cost_usd_per_day: 5 },
    });

    const plan = await writeKnowledgeProcessingSection(await openEffectiveConfig(repo.path), {
      enabled: false,
      max_cost_usd_per_day: undefined,
    });

    expect(plan.versionChange).toBeNull();
    expect((await readProjectConfig()).knowledge_processing).toEqual({
      enabled: false,
      model: 'claude-opus',
    });
  });

  it('writes nothing when the section would not load', async () => {
    const raw = await writeProjectConfig({ schema_version: 6 });

    await expect(
      writeKnowledgeProcessingSection(await openEffectiveConfig(repo.path), {
        enabled: true,
        max_attempts: 99,
      })
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      path: 'knowledge_processing.max_attempts',
    });
    expect(await readFile(configPath(), 'utf8')).toBe(raw);
  });

  it('writes nothing over a file ahead of this build', async () => {
    const raw = await writeProjectConfig({ schema_version: CONFIG_SCHEMA_VERSION + 1 });
    const document = await openConfigForScope(repo.path, 'project');

    await expect(writeKnowledgeProcessingSection(document, { enabled: true })).rejects.toThrow(
      /Upgrade orcaops/
    );
    expect(await readFile(configPath(), 'utf8')).toBe(raw);
  });
});
