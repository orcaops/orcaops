import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, resolveConfig } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

interface InstallManifest {
  manifest_version: number;
  install_agents: string[];
  entries: Array<{ kind: string; path: string }>;
}
interface LocalManifest {
  manifest_version: number;
  entries: Array<{
    kind: string;
    path: string;
    expectedHash: string | null;
    provenance: string;
    deleteMode: string;
  }>;
}

describe('orcaops init writes the install manifest', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('writes install.json (committed, churn-free) + install.local.json (gitignored guards)', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--no-llm',
      '--json',
      '--agents-md',
    ]);
    expect(res.exitCode).toBe(0);

    const install = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')
    ) as InstallManifest;
    expect(install.manifest_version).toBe(1);
    expect(install.install_agents).toEqual(['claude-code']);
    const kinds = new Set(install.entries.map((e) => e.kind));
    expect(kinds.has('generated-file')).toBe(true);
    expect(kinds.has('injected-block')).toBe(true);
    expect(kinds.has('gitignore-entry')).toBe(true);
    // committed manifest is churn-free: no per-file hashes
    expect(JSON.stringify(install)).not.toContain('expectedHash');
    expect(JSON.stringify(install)).not.toMatch(/[0-9a-f]{64}/);

    const local = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'install.local.json'), 'utf8')
    ) as LocalManifest;
    const skill = local.entries.find((e) => e.kind === 'generated-file');
    expect(skill?.provenance).toBe('created');
    expect(skill?.deleteMode).toBe('hash');
    expect(skill?.expectedHash).toMatch(/^[0-9a-f]{64}$/);

    // install.local.json is gitignored (so the per-machine state never commits)
    const gi = await readFile(path.join(repo.path, '.gitignore'), 'utf8');
    expect(gi).toContain('.orcaops/install.local.json');
  });

  it('--dry-run writes no manifest files', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--dry-run', '--no-llm', '--json']);
    expect(await exists(path.join(repo.path, '.orcaops', 'install.json'))).toBe(false);
    expect(await exists(path.join(repo.path, '.orcaops', 'install.local.json'))).toBe(false);
  });

  it('completes a config-only interrupted initialization through the documented force retry', async () => {
    const configDir = path.join(repo.path, '.orcaops');
    const configPath = path.join(configDir, 'config.json');
    const config = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
    await mkdir(configDir);
    await writeFile(configPath, config, 'utf8');

    const refused = await agent.runRaw(['init', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      error: { code: 'ALREADY_INITIALIZED' },
    });

    const retried = await agent.runRaw(['init', '--force', '--json']);
    expect(retried.exitCode).toBe(0);
    // The preserving retry keeps every VALUE and re-minimizes the file: a
    // seeded all-defaults config collapses to the anchor keys, resolving back
    // to the identical configuration.
    const retriedRaw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(resolveConfig(retriedRaw)).toEqual(resolveConfig(DEFAULT_CONFIG));
    expect(await exists(path.join(repo.path, '.orcaops', 'install.json'))).toBe(true);
    expect(
      await exists(path.join(repo.path, '.claude', 'skills', 'orcaops-capture', 'SKILL.md'))
    ).toBe(true);
  });
});
