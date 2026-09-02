import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

/** generated_files git switch + first-run nudge. */
describe('orcaops generated_files', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const gitignore = (): Promise<string> => readFile(path.join(repo.path, '.gitignore'), 'utf8');

  it('default (commit) keeps the base lines and does NOT gitignore the generated trees', async () => {
    const agent = makeAgent({ cwd: repo.path });
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
    const gi = await gitignore();
    expect(gi).toContain('.orcaops/artifacts/'); // base lines unchanged
    expect(gi).not.toContain('.claude/skills/orcaops-*/'); // trees stay committed
  });

  it('init --generated-files ignore adds adapter-derived globs + persists the mode', async () => {
    const agent = makeAgent({ cwd: repo.path });
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--generated-files',
      'ignore',
      '--no-llm',
      '--json',
    ]);
    const gi = await gitignore();
    expect(gi).toContain('.claude/skills/orcaops-*/'); // derived skill glob
    expect(gi).toContain('.claude/commands/orcaops/'); // derived command glob
    expect(gi).toContain('.orcaops/artifacts/'); // base lines still present

    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as {
      generated_files: string;
    };
    expect(cfg.generated_files).toBe('ignore');
  });

  it('a prefix change under ignore prunes the old globs and adds the new', async () => {
    const agent = makeAgent({ cwd: repo.path });
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--generated-files',
      'ignore',
      '--no-llm',
      '--json',
    ]);
    await agent.runRaw(['update', '--prefix', 'oo', '--json']);
    const gi = await gitignore();
    expect(gi).toContain('.claude/skills/oo-*/'); // new prefix glob added
    expect(gi).not.toContain('.claude/skills/orcaops-*/'); // old prefix glob pruned
  });

  it('bare orcaops nudges a fresh clone (committed install.json, absent trees) and still prints help', async () => {
    const agent = makeAgent({ cwd: repo.path });
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--generated-files',
      'ignore',
      '--no-llm',
      '--json',
    ]);
    // Simulate a fresh clone: drop the gitignored generated trees + local manifest,
    // keep the committed install.json.
    await rm(path.join(repo.path, '.claude'), { recursive: true, force: true });
    await rm(path.join(repo.path, '.orcaops', 'install.local.json'), { force: true });

    // CI='' forces the advisory branch regardless of the test runner's real env.
    const bare = makeAgent({ cwd: repo.path, env: { CI: '' } });
    const res = await bare.runRaw([]);
    expect(res.stderr).toMatch(/aren't materialized/); // the nudge
    expect(res.stdout).toMatch(/Usage:|Commands:/); // help still printed
    // advisory only — nothing materialized
    expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
      false
    );
  });

  it.each(['contained', 'external'] as const)(
    'bare orcaops reports a generated file replaced by a %s symlink as missing',
    async (targetLocation) => {
      const agent = makeAgent({ cwd: repo.path });
      await agent.runRaw([
        'init',
        '--scope',
        'project',
        '--generated-files',
        'ignore',
        '--no-llm',
        '--json',
      ]);
      const managed = path.join(repo.path, '.claude', 'skills', 'orcaops-capture', 'SKILL.md');
      const body = await readFile(managed, 'utf8');
      const targetDir =
        targetLocation === 'external'
          ? await mkdtemp(path.join(tmpdir(), 'orcaops-generated-file-'))
          : repo.path;
      const target = path.join(targetDir, `replacement-${targetLocation}.md`);
      await writeFile(target, body, 'utf8');
      await rm(managed);
      await symlink(target, managed);

      try {
        const bare = makeAgent({ cwd: repo.path, env: { CI: '' } });
        const res = await bare.runRaw([]);
        expect(res.stderr).toMatch(/aren't materialized/);
        expect(await readFile(target, 'utf8')).toBe(body);
      } finally {
        if (targetLocation === 'external') {
          await rm(targetDir, { recursive: true, force: true });
        }
      }
    }
  );

  it('bare orcaops under CI auto-runs update to materialize the trees', async () => {
    const agent = makeAgent({ cwd: repo.path });
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--generated-files',
      'ignore',
      '--no-llm',
      '--json',
    ]);
    await rm(path.join(repo.path, '.claude'), { recursive: true, force: true });
    await rm(path.join(repo.path, '.orcaops', 'install.local.json'), { force: true });

    const ci = makeAgent({ cwd: repo.path, env: { CI: '1' } });
    await ci.runRaw([]);
    expect(await exists(path.join(repo.path, '.claude/skills/orcaops-capture/SKILL.md'))).toBe(
      true
    );
  });
});
