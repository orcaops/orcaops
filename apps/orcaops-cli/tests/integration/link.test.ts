import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('orcaops link (in-process)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    // Diverge: replace the CLAUDE.md symlink with a real, different file.
    // (writeFile follows a symlink, so the link must be removed first.)
    const claude = path.join(repo.path, 'CLAUDE.md');
    await rm(claude, { force: true });
    await writeFile(claude, 'CUSTOM claude content\n', 'utf8');
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const isLink = (rel: string) => lstat(path.join(repo.path, rel)).then((s) => s.isSymbolicLink());
  const read = (rel: string) => readFile(path.join(repo.path, rel), 'utf8');

  it('refuses a lossy consolidation without --yes (exit 1) and writes nothing', async () => {
    const res = await agent.runRaw(['link', '--json']);
    expect(res.exitCode).toBe(1);
    const out = JSON.parse(res.stdout) as {
      confirmation_required?: boolean;
      would_drop?: Array<{ path: string; size_bytes: number; preview: string }>;
    };
    expect(out.confirmation_required).toBe(true);
    expect((out.would_drop ?? []).map((d) => d.path)).toContain('CLAUDE.md');
    const claudeDrop = out.would_drop?.find((d) => d.path === 'CLAUDE.md');
    expect(claudeDrop?.size_bytes).toBeGreaterThan(0);
    expect(claudeDrop?.preview).toContain('CUSTOM claude content');
    // Nothing was changed: CLAUDE.md is still a real file with its unique content.
    expect(await isLink('CLAUDE.md')).toBe(false);
    expect(await read('CLAUDE.md')).toContain('CUSTOM claude content');
  });

  it('--dry-run previews the collapse and writes nothing (no --yes needed)', async () => {
    const res = await agent.runRaw(['link', '--dry-run']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/DRY RUN/);
    expect(await isLink('CLAUDE.md')).toBe(false);
    expect(await read('CLAUDE.md')).toContain('CUSTOM claude content');
  });

  it('--yes consolidates onto AGENTS.md, dropping the divergent CLAUDE.md content', async () => {
    const res = await agent.runRaw(['link', '--yes', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      canonical: string;
      dropped: Array<{ path: string; size_bytes: number; preview: string }>;
    };
    expect(out.canonical).toBe('AGENTS.md');
    expect(out.dropped.map((d) => d.path)).toContain('CLAUDE.md');
    expect(await isLink('CLAUDE.md')).toBe(true);
    const agents = await read('AGENTS.md');
    expect(await read('CLAUDE.md')).toBe(agents); // resolves through the symlink
    expect(agents).not.toContain('CUSTOM claude content'); // divergent content dropped
    // The local manifest now records CLAUDE.md as a symlink.
    const local = JSON.parse(await read('.orcaops/install.local.json')) as {
      entries: Array<{ path: string; materialization?: string }>;
    };
    expect(local.entries.find((e) => e.path === 'CLAUDE.md')?.materialization).toBe('symlink');
  });

  it('preserves non-regular instruction entries when none can be canonical', async () => {
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    const claudePath = path.join(repo.path, 'CLAUDE.md');
    await rm(agentsPath, { recursive: true, force: true });
    await rm(claudePath, { recursive: true, force: true });
    await mkdir(agentsPath);
    await mkdir(claudePath);
    const manifestBefore = await read('.orcaops/install.json');

    const res = await agent.runRaw(['link', '--yes', '--json']);

    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      applied: boolean;
      canonical: string;
      warnings: string[];
    };
    expect(out.applied).toBe(false);
    expect(out.canonical).toBe('');
    expect(out.warnings).toEqual([
      'AGENTS.md is not a regular file; preserving it unchanged.',
      'CLAUDE.md is not a regular file; preserving it unchanged.',
    ]);
    expect((await lstat(agentsPath)).isDirectory()).toBe(true);
    expect((await lstat(claudePath)).isDirectory()).toBe(true);
    expect(await read('.orcaops/install.json')).toBe(manifestBefore);
  });
});

describe('orcaops link preserves the configured prefix', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--prefix', 'oo']);
    // Diverge CLAUDE.md so the force-collapse re-renders + rewrites the canonical block.
    const claude = path.join(repo.path, 'CLAUDE.md');
    await rm(claude, { force: true });
    await writeFile(claude, 'CUSTOM claude content\n', 'utf8');
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('re-renders the consolidated block with the configured prefix, not the default', async () => {
    const res = await agent.runRaw(['link', '--yes', '--json']);
    expect(res.exitCode).toBe(0);
    const agents = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    // A re-render with the default prefix would revert oo-capture -> orcaops-capture.
    expect(agents).toContain('oo-capture');
    expect(agents).not.toContain('orcaops-capture');
    // CLAUDE.md resolves through the symlink to the same oo-prefixed content.
    expect(await readFile(path.join(repo.path, 'CLAUDE.md'), 'utf8')).toBe(agents);
  });
});
