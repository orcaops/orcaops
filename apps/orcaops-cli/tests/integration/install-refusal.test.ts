import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('instruction install refusal boundary', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('init refuses a foreign instruction symlink before writing anything', async () => {
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    const claudePath = path.join(repo.path, 'CLAUDE.md');
    await writeFile(agentsPath, 'user agents prose\n', 'utf8');
    await writeFile(path.join(repo.path, 'notes.md'), 'foreign target\n', 'utf8');
    await symlink('notes.md', claudePath);

    const result = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Refusing to replace foreign instruction symlink/);
    expect(await readFile(agentsPath, 'utf8')).toBe('user agents prose\n');
    expect(await readlink(claudePath)).toBe('notes.md');
    await expect(access(path.join(repo.path, '.orcaops'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('init refuses malformed markers before creating any install footprint', async () => {
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    const claudePath = path.join(repo.path, 'CLAUDE.md');
    const malformed =
      '# user prefix\n<!-- orcaops:start v=0.0.1 -->\nbody\n<!-- orcaops:end -->\n<!-- orcaops:start v=0.0.2 -->\nuser tail\n';
    const claude = '# independent user instructions\n';
    await writeFile(agentsPath, malformed, 'utf8');
    await writeFile(claudePath, claude, 'utf8');

    const result = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/managed-block markers are malformed or ambiguous/);
    expect(await readFile(agentsPath, 'utf8')).toBe(malformed);
    expect(await readFile(claudePath, 'utf8')).toBe(claude);
    await expect(access(path.join(repo.path, '.orcaops'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('update refuses a foreign instruction symlink without refreshing other install files', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    const claudePath = path.join(repo.path, 'CLAUDE.md');
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-capture', 'SKILL.md');
    const skill = await readFile(skillPath, 'utf8');
    const staleSkill = skill.replace(/orcaops@[^"]+/, 'orcaops@0.0.0-refusal');
    await writeFile(skillPath, staleSkill, 'utf8');
    await rm(claudePath);
    await writeFile(path.join(repo.path, 'notes.md'), 'foreign target\n', 'utf8');
    await symlink('notes.md', claudePath);
    const agentsBefore = await readFile(agentsPath, 'utf8');
    const manifestBefore = await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8');
    const localManifestBefore = await readFile(
      path.join(repo.path, '.orcaops', 'install.local.json'),
      'utf8'
    );

    const result = await agent.runRaw(['update']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Refusing to replace foreign instruction symlink/);
    expect(await readFile(skillPath, 'utf8')).toBe(staleSkill);
    expect(await readFile(agentsPath, 'utf8')).toBe(agentsBefore);
    expect(await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')).toBe(
      manifestBefore
    );
    expect(await readFile(path.join(repo.path, '.orcaops', 'install.local.json'), 'utf8')).toBe(
      localManifestBefore
    );
    expect(await readlink(claudePath)).toBe('notes.md');
  });

  it('doctor --fix refuses a foreign instruction symlink without applying another repair', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const claudePath = path.join(repo.path, 'CLAUDE.md');
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md');
    const skill = await readFile(skillPath, 'utf8');
    const staleSkill = skill.replace(/orcaops@[^"]+/, 'orcaops@0.0.0-refusal');
    await writeFile(skillPath, staleSkill, 'utf8');
    await rm(claudePath);
    await writeFile(path.join(repo.path, 'notes.md'), 'foreign target\n', 'utf8');
    await symlink('notes.md', claudePath);

    const result = await agent.runRaw(['doctor', '--fix', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/Refusing to replace foreign instruction symlink/);
    expect(await readFile(skillPath, 'utf8')).toBe(staleSkill);
    expect(await readlink(claudePath)).toBe('notes.md');
  });

  it('doctor --fix refuses malformed markers without refreshing skills or manifests', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    const claudePath = path.join(repo.path, 'CLAUDE.md');
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md');
    const staleSkill = (await readFile(skillPath, 'utf8')).replace(
      /orcaops@[^"]+/,
      'orcaops@0.0.0-refusal'
    );
    await writeFile(skillPath, staleSkill, 'utf8');
    const malformed =
      '# user prefix\n<!-- orcaops:start v=0.0.1 -->\nbody\n<!-- orcaops:end -->\n<!-- orcaops:start v=0.0.2 -->\nuser tail\n';
    await writeFile(agentsPath, malformed, 'utf8');
    const installBefore = await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8');
    const localBefore = await readFile(
      path.join(repo.path, '.orcaops', 'install.local.json'),
      'utf8'
    );
    const secondaryTarget = await readlink(claudePath);

    const result = await agent.runRaw(['doctor', '--fix', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/managed-block markers are malformed or ambiguous/);
    expect(await readFile(agentsPath, 'utf8')).toBe(malformed);
    expect(await readFile(skillPath, 'utf8')).toBe(staleSkill);
    expect(await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')).toBe(
      installBefore
    );
    expect(await readFile(path.join(repo.path, '.orcaops', 'install.local.json'), 'utf8')).toBe(
      localBefore
    );
    expect(await readlink(claudePath)).toBe(secondaryTarget);
  });

  it('update preserves an unterminated block unless --force explicitly repairs it', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    const malformed =
      '# User prose\n\n<!-- orcaops:start v=0.0.5 -->\nmanaged-looking text\nuser tail\n';
    await writeFile(agentsPath, malformed, 'utf8');
    const installBefore = await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8');
    const localBefore = await readFile(
      path.join(repo.path, '.orcaops', 'install.local.json'),
      'utf8'
    );
    const secondaryTarget = await readlink(path.join(repo.path, 'CLAUDE.md'));

    const refused = await agent.runRaw(['update']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/managed-block markers are malformed or ambiguous/);
    expect(await readFile(agentsPath, 'utf8')).toBe(malformed);
    expect(await readFile(path.join(repo.path, '.orcaops', 'install.json'), 'utf8')).toBe(
      installBefore
    );
    expect(await readFile(path.join(repo.path, '.orcaops', 'install.local.json'), 'utf8')).toBe(
      localBefore
    );
    expect(await readlink(path.join(repo.path, 'CLAUDE.md'))).toBe(secondaryTarget);

    const repaired = await agent.runRaw(['update', '--force']);
    expect(repaired.exitCode).toBe(0);
    expect(await readFile(agentsPath, 'utf8')).toContain('<!-- orcaops:end -->');
    expect(await readFile(agentsPath, 'utf8')).not.toContain('user tail');
    expect((await lstat(path.join(repo.path, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
  });

  it('link requires --yes to re-point a foreign symlink and then applies exactly that change', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const claudePath = path.join(repo.path, 'CLAUDE.md');
    const notesPath = path.join(repo.path, 'notes.md');
    await rm(claudePath);
    await writeFile(notesPath, 'foreign target\n', 'utf8');
    await symlink('notes.md', claudePath);

    const refused = await agent.runRaw(['link', '--json']);

    expect(refused.exitCode).toBe(1);
    const refusal = JSON.parse(refused.stdout) as {
      confirmation_required: boolean;
      would_repoint: Array<{ path: string; from: string; to: string }>;
    };
    expect(refusal.confirmation_required).toBe(true);
    expect(refusal.would_repoint).toEqual([
      { path: 'CLAUDE.md', from: 'notes.md', to: 'AGENTS.md' },
    ]);
    expect(await readlink(claudePath)).toBe('notes.md');
    expect(await readFile(notesPath, 'utf8')).toBe('foreign target\n');

    const applied = await agent.runRaw(['link', '--yes', '--json']);

    expect(applied.exitCode).toBe(0);
    const success = JSON.parse(applied.stdout) as {
      applied: boolean;
      repointed: Array<{ path: string; from: string; to: string }>;
    };
    expect(success.applied).toBe(true);
    expect(success.repointed).toEqual([{ path: 'CLAUDE.md', from: 'notes.md', to: 'AGENTS.md' }]);
    expect(await readlink(claudePath)).toBe('AGENTS.md');
    expect(await readFile(notesPath, 'utf8')).toBe('foreign target\n');
  });
});

describe('instruction refusal boundary — personal CLAUDE.local.md path', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let globalRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-refusal-personal-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_GLOBAL_ROOT: globalRoot },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(globalRoot, { recursive: true, force: true });
  });

  it('personal init preserves a pre-existing CLAUDE.local.md symlink unchanged, with the warning', async () => {
    // The invisible default drives the block at CLAUDE.local.md. With the
    // whole single-file set occupied by a symlink there is no canonical
    // candidate, so the placement takes its deliberate preserve-and-warn
    // early return: nothing adopted, nothing deleted, warning surfaced —
    // the same never-adopt posture as the multi-file refusal, minus the
    // hard stop it reserves for replacing a foreign link.
    await writeFile(path.join(repo.path, 'notes.md'), 'foreign target\n', 'utf8');
    await symlink('notes.md', path.join(repo.path, 'CLAUDE.local.md'));

    const result = await agent.runRaw(['init', '--personal', '--no-llm', '--agents-md', '--json']);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as {
      agents_md: Array<{ path: string; action: string }>;
      warnings: string[];
    };
    expect(out.agents_md).toEqual([{ path: 'CLAUDE.local.md', action: 'unchanged' }]);
    expect(out.warnings.join(' ')).toMatch(/preserving existing links unchanged/i);
    // The link and its target are byte-untouched; no block was adopted.
    expect(await readFile(path.join(repo.path, 'notes.md'), 'utf8')).toBe('foreign target\n');
    const linkStat = await lstat(path.join(repo.path, 'CLAUDE.local.md'));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it('personal update refuses malformed CLAUDE.local.md markers unless --force repairs them', async () => {
    await agent.runRaw(['init', '--personal', '--no-llm', '--agents-md']);
    const local = path.join(repo.path, 'CLAUDE.local.md');
    const healthy = await readFile(local, 'utf8');
    // Drop the end marker: the managed block becomes ambiguous.
    expect(healthy).toContain('<!-- orcaops:end -->');
    await writeFile(local, healthy.replace('<!-- orcaops:end -->', ''), 'utf8');

    const refused = await agent.runRaw(['update']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/managed-block markers are malformed or ambiguous/);

    const repaired = await agent.runRaw(['update', '--force']);
    expect(repaired.exitCode).toBe(0);
    expect(await readFile(local, 'utf8')).toContain('<!-- orcaops:end -->');
  });
});
