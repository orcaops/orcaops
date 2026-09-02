import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

interface UpdateJson {
  ok: true;
  prefix_changed: { from: string; to: string } | null;
  dry_run: boolean;
  pruned: string[];
  removed_dirs: string[];
}

interface DoctorReport {
  ok: true;
  overall: string;
  checks: { name: string; status: string }[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safe prefix CHANGE on `orcaops update`. A prefix change is a
 * manifest-tracked rename: the prior install.json's naming_prefix vs the new
 * config.naming.prefix detects it; planInstallMutations regenerates `<new>-*`,
 * planOrphanPrune hash-guard-deletes the old `<old>-*`, the block re-renders, and
 * rmdir cleans the old empty dirs. No `<old>-*` residue across paths, dir names,
 * command names, the managed block, AND skill bodies.
 */
describe('orcaops update --prefix', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { CLAUDE_SESSION_ID: 'test-update-prefix' } });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const p = (...s: string[]): string => path.join(repo.path, ...s);

  async function blockRefCheck(): Promise<string> {
    const doc = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(doc.stdout) as DoctorReport;
    return report.checks.find((c) => c.name === 'block-skill-refs')?.status ?? 'missing';
  }

  it('update --prefix oo renames the install with no orcaops-* residue, doctor green', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const res = await agent.runRaw(['update', '--prefix', 'oo', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as UpdateJson;
    expect(r.prefix_changed).toEqual({ from: 'orcaops', to: 'oo' });

    // new prefix materialized (skills + command namespace)
    expect(await exists(p('.claude/skills/oo-capture/SKILL.md'))).toBe(true);
    expect(await exists(p('.claude/commands/oo/status.md'))).toBe(true);

    // old prefix fully pruned — files AND dirs (no residue)
    expect(await exists(p('.claude/skills/orcaops-capture/SKILL.md'))).toBe(false);
    expect(await exists(p('.claude/skills/orcaops-capture'))).toBe(false);
    expect(await exists(p('.claude/commands/orcaops'))).toBe(false);
    expect(r.removed_dirs).toContain('.claude/commands/orcaops');

    // manifest records the new prefix (rename complete → next update is a no-op rename)
    const manifest = JSON.parse(await readFile(p('.orcaops/install.json'), 'utf8')) as {
      naming_prefix: string;
    };
    expect(manifest.naming_prefix).toBe('oo');

    // managed block re-rendered + skill BODY cross-refs re-prefixed
    const agents = await readFile(p('AGENTS.md'), 'utf8');
    expect(agents).toContain('oo-capture');
    expect(agents).not.toContain('orcaops-capture');
    const digestBody = await readFile(p('.claude/skills/oo-digest/SKILL.md'), 'utf8');
    expect(digestBody).toContain('oo-finish');
    expect(digestBody).not.toContain('orcaops-finish');

    // doctor prefix-consistency check is green
    expect(await blockRefCheck()).toBe('pass');
  });

  it('a hand-edited config prefix + bare update yields the same residue-free rename', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const cfgPath = p('.orcaops/config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as { naming?: Record<string, unknown> };
    cfg.naming = { ...(cfg.naming ?? {}), prefix: 'zz' };
    await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    const res = await agent.runRaw(['update', '--json']); // bare update — no --prefix flag
    const r = JSON.parse(res.stdout) as UpdateJson;
    expect(r.prefix_changed).toEqual({ from: 'orcaops', to: 'zz' });
    expect(await exists(p('.claude/skills/zz-capture/SKILL.md'))).toBe(true);
    expect(await exists(p('.claude/skills/orcaops-capture'))).toBe(false);
    expect(await exists(p('.claude/commands/orcaops'))).toBe(false);
    expect(await blockRefCheck()).toBe('pass');
  });

  it('rejects an invalid prefix and writes nothing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const res = await agent.runRaw(['update', '--prefix', 'OO', '--json']); // uppercase = invalid
    expect(res.exitCode).not.toBe(0);
    const r = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(r.error.code).toBe('INVALID_INPUT');
    // untouched
    expect(await exists(p('.claude/skills/orcaops-capture/SKILL.md'))).toBe(true);
    expect(await exists(p('.claude/skills/OO-capture'))).toBe(false);
  });

  it('update --prefix oo --dry-run previews the rename and writes nothing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const res = await agent.runRaw(['update', '--prefix', 'oo', '--dry-run', '--json']);
    const r = JSON.parse(res.stdout) as UpdateJson;
    expect(r.dry_run).toBe(true);
    expect(r.prefix_changed).toEqual({ from: 'orcaops', to: 'oo' });
    // nothing written: old present, new absent, config + manifest unchanged
    expect(await exists(p('.claude/skills/orcaops-capture/SKILL.md'))).toBe(true);
    expect(await exists(p('.claude/skills/oo-capture'))).toBe(false);
    const cfg = JSON.parse(await readFile(p('.orcaops/config.json'), 'utf8')) as {
      naming?: { prefix: string };
    };
    // Minimal-delta config: the default prefix is simply absent.
    expect(cfg.naming?.prefix ?? 'orcaops').toBe('orcaops');
    const manifest = JSON.parse(await readFile(p('.orcaops/install.json'), 'utf8')) as {
      naming_prefix: string;
    };
    expect(manifest.naming_prefix).toBe('orcaops');
  });
});
