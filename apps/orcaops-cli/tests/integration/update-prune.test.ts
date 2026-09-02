import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const ORPHAN = '.claude/skills/orcaops-legacy/SKILL.md';

interface UpdateJson {
  ok: true;
  dry_run: boolean;
  installed: string[];
  pruned: string[];
  preserved_orphans: Array<{ path: string; kind: string; reason: string }>;
  removed_dirs: string[];
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
}

/**
 * Seed an orphan: a generated-file that the prior install owned but the current
 * SKILL_TEMPLATES set no longer produces. We write the file + an `install.json`
 * ownership entry + a matching `install.local.json` guard entry, so the next
 * `update` sees it in `diff.removed`. `deleteMode` / on-disk content is the knob
 * each test varies.
 */
async function seedOrphan(
  repoPath: string,
  content: string,
  deleteMode: 'hash' | 'never' | 'confirm',
  provenance: 'created' | 'adopted' | 'pre-existing'
): Promise<void> {
  const abs = path.join(repoPath, ORPHAN);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');

  const ip = path.join(repoPath, '.orcaops', 'install.json');
  const install = (await readJson(ip)) as { entries: Array<{ kind: string; path: string }> };
  install.entries.push({ kind: 'generated-file', path: ORPHAN });
  await writeFile(ip, JSON.stringify(install, null, 2) + '\n', 'utf8');

  const lp = path.join(repoPath, '.orcaops', 'install.local.json');
  const local = (await readJson(lp)) as { entries: unknown[] };
  local.entries.push({
    kind: 'generated-file',
    path: ORPHAN,
    expectedHash: deleteMode === 'hash' ? sha256Hex(content) : null,
    provenance,
    deleteMode,
  });
  await writeFile(lp, JSON.stringify(local, null, 2) + '\n', 'utf8');
}

/**
 * Orphan prune on update. Owned files dropped from the plan are removed
 * hash-guarded; user-edited / pre-existing orphans are preserved + reported; the
 * empty prefix-scoped dir is rmdir'd; --dry-run previews and writes nothing.
 */
describe('orcaops update — orphan prune', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { CLAUDE_SESSION_ID: 'test-prune' } });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('removes an unmodified owned orphan and rmdirs its empty dir; prune is its own result', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await seedOrphan(repo.path, 'legacy body\n', 'hash', 'created');

    const res = await agent.runRaw(['update', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as UpdateJson;
    expect(r.pruned).toContain(ORPHAN);
    expect(r.removed_dirs).toContain('.claude/skills/orcaops-legacy');
    // The file and its now-empty dir are gone.
    await expect(readFile(path.join(repo.path, ORPHAN), 'utf8')).rejects.toThrow();
    // Delete semantics live in `pruned`, NOT folded into the GenerateResult tallies.
    expect(Array.isArray(r.installed)).toBe(true);
    expect(r).not.toHaveProperty('deleted');
    // The orphan is also dropped from the committed manifest.
    const install = (await readJson(path.join(repo.path, '.orcaops', 'install.json'))) as {
      entries: Array<{ path: string }>;
    };
    expect(install.entries.some((e) => e.path === ORPHAN)).toBe(false);
  });

  it('preserves a user-edited orphan (on-disk != expectedHash) and reports it', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    // expectedHash is computed for the ORIGINAL content, but we write edited bytes.
    const abs = path.join(repo.path, ORPHAN);
    await seedOrphan(repo.path, 'original\n', 'hash', 'created');
    await writeFile(abs, 'the user edited this\n', 'utf8');

    const r = JSON.parse((await agent.runRaw(['update', '--json'])).stdout) as UpdateJson;
    expect(r.pruned).not.toContain(ORPHAN);
    expect(r.preserved_orphans.some((p) => p.path === ORPHAN && p.reason === 'user-edited')).toBe(
      true
    );
    // The edit survives.
    expect(await readFile(abs, 'utf8')).toBe('the user edited this\n');
  });

  it('preserves a pre-existing (deleteMode never) orphan', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await seedOrphan(repo.path, 'not ours\n', 'never', 'pre-existing');

    const r = JSON.parse((await agent.runRaw(['update', '--json'])).stdout) as UpdateJson;
    expect(r.pruned).not.toContain(ORPHAN);
    expect(r.preserved_orphans.some((p) => p.path === ORPHAN && p.reason === 'pre-existing')).toBe(
      true
    );
    expect(await readFile(path.join(repo.path, ORPHAN), 'utf8')).toBe('not ours\n');
  });

  it('--dry-run previews the prune and writes nothing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await seedOrphan(repo.path, 'legacy body\n', 'hash', 'created');

    const r = JSON.parse(
      (await agent.runRaw(['update', '--dry-run', '--json'])).stdout
    ) as UpdateJson;
    expect(r.dry_run).toBe(true);
    expect(r.pruned).toContain(ORPHAN); // would-prune
    expect(r.removed_dirs).toEqual([]); // no rmdir in preview
    // Nothing was actually deleted.
    expect(await readFile(path.join(repo.path, ORPHAN), 'utf8')).toBe('legacy body\n');
  });

  it('a steady-state update prunes nothing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const r = JSON.parse((await agent.runRaw(['update', '--json'])).stdout) as UpdateJson;
    expect(r.pruned).toEqual([]);
    expect(r.preserved_orphans).toEqual([]);
    expect(r.removed_dirs).toEqual([]);
  });

  it('human output renders the Pruned section', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await seedOrphan(repo.path, 'legacy body\n', 'hash', 'created');
    const res = await agent.runRaw(['update']); // human mode
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/Pruned \(1\):/);
    expect(res.stdout).toContain(ORPHAN);
  });

  it('human output renders the Preserved orphans section with the reason', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await seedOrphan(repo.path, 'original\n', 'hash', 'created');
    await writeFile(path.join(repo.path, ORPHAN), 'user edit\n', 'utf8');
    const res = await agent.runRaw(['update']); // human mode
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/Preserved orphans \(1\):/);
    expect(res.stdout).toMatch(/user-edited/);
  });
});
