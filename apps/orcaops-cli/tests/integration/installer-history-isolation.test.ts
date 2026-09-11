import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { getDefaultConfig } from '@orcaops/storage';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(async () => 'discard'),
  isCancel: () => false,
}));

async function configuredRepository() {
  const f = await fixture();
  const config = getDefaultConfig();
  config.llm.tool = 'none';
  config.install.scope = 'project';
  config.install.agents = ['claude-code'];
  await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
  await writeFile(path.join(f.main, '.orcaops', 'config.json'), JSON.stringify(config));
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_ROOT: f.main, ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  return { ...f, agent };
}

describe('installer commands and project history', () => {
  it('discards settings without changing files when registered history is missing', async () => {
    const f = await configuredRepository();
    f.writer.close();
    await rm(f.writer.databasePath);
    const before = await inventory(f.temporary);
    const stdoutTty = process.stdout.isTTY;
    const stdinTty = process.stdin.isTTY;
    const ci = process.env.CI;
    try {
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      delete process.env.CI;
      const result = await f.agent.runRaw(['configure']);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('No changes written.');
    } finally {
      process.stdout.isTTY = stdoutTty;
      process.stdin.isTTY = stdinTty;
      if (ci === undefined) delete process.env.CI;
      else process.env.CI = ci;
    }
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('previews and updates installation files without replacing missing history', async () => {
    const f = await configuredRepository();
    f.writer.close();
    await rm(f.writer.databasePath);
    const before = await inventory(f.temporary);
    const preview = await f.agent.runRaw(['update', '--prefix', 'project', '--dry-run', '--json']);
    expect(preview.exitCode, preview.stdout + preview.stderr).toBe(0);
    expect(await inventory(f.temporary)).toEqual(before);

    const history = await inventory(f.root);
    const result = await f.agent.runRaw(['update', '--prefix', 'project', '--json']);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(
      JSON.parse(await readFile(path.join(f.main, '.orcaops', 'config.json'), 'utf8'))
    ).toMatchObject({ naming: { prefix: 'project' } });
    await expect(
      stat(path.join(f.main, '.claude/skills/project-capture/SKILL.md'))
    ).resolves.toMatchObject({});
    await expect(stat(f.writer.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const relative of ['.orcaops/cache', '.orcaops/artifacts', '.orcaops/tmp/locks'])
      await expect(stat(path.join(f.main, relative))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await inventory(f.root)).toEqual(history);
  });
});
