import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_SCHEMA_VERSION } from '@orcaops/storage';
import { createRepoTemplate, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * `orcaops update` on a PRE-consolidation
 * install prunes the old skill directories via planOrphanPrune (the
 * manifest-driven, hash-guarded delete path) and materializes the new
 * surface.
 *
 * The fixture simulates the same-machine upgrade: the old CLI left
 * generated files for since-renamed/merged ids recorded in BOTH
 * install.json (committed entries) and install.local.json (per-entry
 * hash guard). The new CLI's plan no longer contains those paths →
 * orphans → deleted while on-disk matches the recorded hash.
 */

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const OLD_IDS = ['orcaops-standup', 'orcaops-sdd-bridge', 'orcaops-plan-review'];

describe('orcaops update — pre-consolidation prune', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--agents-md',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const p = (...s: string[]): string => path.join(repo.path, ...s);
  const exists = async (rel: string): Promise<boolean> => {
    try {
      await stat(p(rel));
      return true;
    } catch {
      return false;
    }
  };

  it('prunes old skill dirs, keeps the new surface, doctor stays green', async () => {
    // Plant the pre-consolidation footprint: old-id skill files recorded
    // as created/hash-guarded, exactly as the old install left them.
    const plantedPaths: string[] = [];
    const localEntries: Array<Record<string, unknown>> = [];
    for (const oldId of OLD_IDS) {
      const rel = ['.claude', 'skills', oldId, 'SKILL.md'].join('/');
      const body = `---\nname: "${oldId}"\n---\n<!-- orcaops:generatedBy=0.0.1 -->\nold body\n`;
      await mkdir(path.dirname(p(rel)), { recursive: true });
      await writeFile(p(rel), body, 'utf8');
      plantedPaths.push(rel);
      localEntries.push({
        kind: 'generated-file',
        path: rel,
        expectedHash: sha256Hex(body),
        provenance: 'created',
        deleteMode: 'hash',
      });
    }
    const installPath = p('.orcaops', 'install.json');
    const install = JSON.parse(await readFile(installPath, 'utf8')) as {
      entries: Array<{ kind: string; path: string }>;
    };
    install.entries.push(
      ...plantedPaths.map((rel) => ({ kind: 'generated-file' as const, path: rel }))
    );
    await writeFile(installPath, JSON.stringify(install, null, 2) + '\n', 'utf8');

    const localPath = p('.orcaops', 'install.local.json');
    const local = JSON.parse(await readFile(localPath, 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    local.entries.push(...localEntries);
    await writeFile(localPath, JSON.stringify(local, null, 2) + '\n', 'utf8');

    // The config stays at the current version because pruning keys off the
    // install manifests alone.
    const update = await agent.runRaw(['update', '--json']);
    expect(update.exitCode).toBe(0);
    const result = JSON.parse(update.stdout) as { pruned: string[] };
    for (const rel of plantedPaths) {
      expect(result.pruned).toContain(rel);
      expect(await exists(rel)).toBe(false);
    }
    // Directories fully gone — no residue.
    for (const oldId of OLD_IDS) {
      expect(await exists(path.join('.claude', 'skills', oldId))).toBe(false);
    }

    // The consolidated surface is (still) materialized.
    // plan-approval is cloud-gated and this suite runs with no credentials.
    for (const newId of ['orcaops-recap', 'orcaops-plan-critique', 'orcaops-capture']) {
      expect(await exists(path.join('.claude', 'skills', newId, 'SKILL.md'))).toBe(true);
    }
    // And no old-id references linger in the managed block.
    const block = await readFile(p('CLAUDE.md'), 'utf8');
    expect(block).not.toContain('orcaops-standup');
    expect(block).not.toContain('orcaops-sdd-bridge');
    expect(block).not.toContain('orcaops-plan-review');
    expect(block).toContain('orcaops-recap');

    // The init-written current config is untouched by the prune.
    const after = JSON.parse(await readFile(p('.orcaops', 'config.json'), 'utf8')) as {
      schema_version: number;
    };
    expect(after.schema_version).toBe(CONFIG_SCHEMA_VERSION);

    const doctor = await agent.runRaw(['doctor', '--json']);
    expect(doctor.exitCode).toBe(0);
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; status: string }>;
    };
    const installChecks = report.checks.filter((c) =>
      ['agent-skills', 'block-skill-refs', 'install-manifest'].includes(c.name)
    );
    for (const c of installChecks) {
      expect(c.status, c.name).toBe('pass');
    }
  });

  it('preserves a user-edited old-id file (hash guard) while still pruning untouched ones', async () => {
    const editedRel = '.claude/skills/orcaops-standup/SKILL.md';
    const cleanRel = '.claude/skills/orcaops-sdd-bridge/SKILL.md';
    const editedOriginal = `---\nname: "orcaops-standup"\n---\nold body\n`;
    const cleanBody = `---\nname: "orcaops-sdd-bridge"\n---\nold body\n`;
    for (const [rel, body] of [
      [editedRel, editedOriginal],
      [cleanRel, cleanBody],
    ] as const) {
      await mkdir(path.dirname(p(rel)), { recursive: true });
      await writeFile(p(rel), body, 'utf8');
    }
    const installPath = p('.orcaops', 'install.json');
    const install = JSON.parse(await readFile(installPath, 'utf8')) as {
      entries: Array<{ kind: string; path: string }>;
    };
    install.entries.push(
      { kind: 'generated-file', path: editedRel },
      { kind: 'generated-file', path: cleanRel }
    );
    await writeFile(installPath, JSON.stringify(install, null, 2) + '\n', 'utf8');
    const localPath = p('.orcaops', 'install.local.json');
    const local = JSON.parse(await readFile(localPath, 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    local.entries.push(
      {
        kind: 'generated-file',
        path: editedRel,
        expectedHash: sha256Hex(editedOriginal),
        provenance: 'created',
        deleteMode: 'hash',
      },
      {
        kind: 'generated-file',
        path: cleanRel,
        expectedHash: sha256Hex(cleanBody),
        provenance: 'created',
        deleteMode: 'hash',
      }
    );
    await writeFile(localPath, JSON.stringify(local, null, 2) + '\n', 'utf8');

    // The user edited the standup file after the old install.
    await writeFile(p(editedRel), `${editedOriginal}\nMY CUSTOM NOTES\n`, 'utf8');

    const update = await agent.runRaw(['update', '--json']);
    expect(update.exitCode).toBe(0);
    // Untouched orphan pruned; edited orphan preserved (hash mismatch).
    expect(await exists(cleanRel)).toBe(false);
    expect(await exists(editedRel)).toBe(true);
    expect(await readFile(p(editedRel), 'utf8')).toContain('MY CUSTOM NOTES');
  });
});
