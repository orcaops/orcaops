import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateForTool, planGenerateForTool } from './generator.js';
import { claudeCodeAdapter } from './tools/claude-code.js';
import { codexAdapter } from './tools/codex.js';

describe('generateForTool', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-gen-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('installs all 26 skills and 8 commands on first run', async () => {
    const result = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    expect(result.installed).toHaveLength(34);
    expect(result.refreshed).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);

    // Spot-check files exist with frontmatter
    const skill = await readFile(
      path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md'),
      'utf8'
    );
    expect(skill).toMatch(/^---/);
    expect(skill).toMatch(/generatedBy: "orcaops@0\.0\.0"/);
    expect(skill).toMatch(/orcaops capture plan/);

    const command = await readFile(
      path.join(tmpRoot, '.claude/commands/orcaops/status.md'),
      'utf8'
    );
    expect(command).toMatch(/orcaops status --json/);
  });

  it('refuses generated-file reads and writes through an ancestor symlink', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-gen-outside-'));
    await mkdir(path.join(outside, 'skills'), { recursive: true });
    await symlink(outside, path.join(tmpRoot, '.claude'));

    try {
      await expect(
        generateForTool({
          repoRoot: tmpRoot,
          adapter: claudeCodeAdapter,
          generatedBy: '0.0.0',
        })
      ).rejects.toThrow(/must not contain symlinks/);
      expect(await readdir(path.join(outside, 'skills'))).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('preserves a final generated-file symlink even when force is enabled', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    const skillPath = path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-gen-outside-'));
    const external = path.join(outside, 'SKILL.md');
    const externalBody = 'external user content\n';
    await writeFile(external, externalBody, 'utf8');
    await rm(skillPath);
    await symlink(external, skillPath);

    try {
      const result = await generateForTool({
        repoRoot: tmpRoot,
        adapter: claudeCodeAdapter,
        generatedBy: '0.0.0',
        force: true,
      });

      expect(result.unchanged).toContain('.claude/skills/orcaops-capture/SKILL.md');
      expect((await lstat(skillPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(external, 'utf8')).toBe(externalBody);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports unchanged on a re-run with the same version', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    const second = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    expect(second.installed).toHaveLength(0);
    expect(second.unchanged).toHaveLength(34);
    expect(second.refreshed).toHaveLength(0);
  });

  it('refreshes files when generatedBy changes', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    const second = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.1.0',
    });
    expect(second.refreshed).toHaveLength(34);
    const skill = await readFile(
      path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md'),
      'utf8'
    );
    expect(skill).toMatch(/generatedBy: "orcaops@0\.1\.0"/);
  });

  it('respects user edits when generatedBy stamp matches current version', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });

    // Simulate a user edit to a skill file (preserving the stamp).
    const skillPath = path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    await (
      await import('node:fs/promises')
    ).writeFile(skillPath, original + '\n# CUSTOM USER ADDITION\n', 'utf8');

    const second = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    // The capture skill stayed unchanged because the stamp matches; user edit preserved.
    expect(second.unchanged).toContain('.claude/skills/orcaops-capture/SKILL.md');
    const after = await readFile(skillPath, 'utf8');
    expect(after).toMatch(/CUSTOM USER ADDITION/);
  });

  it('codex adapter installs only skills (no commands renderer); reports commands as skipped', async () => {
    const result = await generateForTool({
      repoRoot: tmpRoot,
      adapter: codexAdapter,
      generatedBy: '0.0.0',
    });
    // The full registry (the generator is enabled-set-agnostic; the CLI passes
    // the enabled subset), no commands (codex deprecated custom prompts)
    expect(result.installed).toHaveLength(26);
    for (const p of result.installed) {
      expect(p.startsWith('.agents/skills/')).toBe(true);
      expect(p.endsWith('/SKILL.md')).toBe(true);
    }
    expect(result.skipped).toEqual(['codex:commands (adapter does not support commands)']);

    // Spot-check a file lands at the Codex-canonical .agents path and has
    // the YAML frontmatter Codex requires (name + description).
    const skill = await readFile(
      path.join(tmpRoot, '.agents/skills/orcaops-capture/SKILL.md'),
      'utf8'
    );
    expect(skill).toMatch(/^---/);
    expect(skill).toMatch(/name: "/);
    expect(skill).toMatch(/description: "/);
    expect(skill).toMatch(/generatedBy: "orcaops@0\.0\.0"/);
  });

  it('refreshes when the template body changed at the same version (fingerprint mismatch)', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    const skillPath = path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md');
    const pristine = await readFile(skillPath, 'utf8');

    // Simulate a file generated by an OLDER template body at the SAME version:
    // same generatedBy, different recorded fingerprint, different body text.
    const olderRender = pristine
      .replace(/contentHash: "[0-9a-f]+"/, 'contentHash: "000000000000"')
      .replace('orcaops capture plan', 'orcaops capture plan-legacy');
    await writeFile(skillPath, olderRender, 'utf8');

    const second = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    expect(second.refreshed).toContain('.claude/skills/orcaops-capture/SKILL.md');
    expect(await readFile(skillPath, 'utf8')).toBe(pristine);
  });

  it('preserves a version-only stamped file unless force is explicit', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    const skillPath = path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md');
    const pristine = await readFile(skillPath, 'utf8');

    const versionOnly = pristine.replace(/\n {2}contentHash: "[0-9a-f]+"/, '');
    await writeFile(skillPath, versionOnly, 'utf8');

    const second = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    expect(second.unchanged).toContain('.claude/skills/orcaops-capture/SKILL.md');
    expect(await readFile(skillPath, 'utf8')).toBe(versionOnly);

    const forced = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
      force: true,
    });
    expect(forced.refreshed).toContain('.claude/skills/orcaops-capture/SKILL.md');
    expect(await readFile(skillPath, 'utf8')).toBe(pristine);
  });

  it('--force overwrites user edits', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    const skillPath = path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md');
    await (await import('node:fs/promises')).writeFile(skillPath, 'destroyed', 'utf8');
    const second = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
      force: true,
    });
    expect(second.refreshed).toContain('.claude/skills/orcaops-capture/SKILL.md');
    const after = await readFile(skillPath, 'utf8');
    expect(after).toMatch(/orcaops capture plan/);
  });

  it('preserves files stamped by a NEWER orcaops (ahead guard)', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '9.9.9',
    });
    const skillPath = path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md');
    const newerBytes = await readFile(skillPath, 'utf8');

    const older = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    expect(older.refreshed).toHaveLength(0);
    expect(older.unchanged).toHaveLength(34);
    expect(await readFile(skillPath, 'utf8')).toBe(newerBytes);

    const plan = await planGenerateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    const planned = plan.files.find((f) => f.path === '.claude/skills/orcaops-capture/SKILL.md');
    expect(planned?.action).toBe('unchanged');
    expect(planned?.reason).toBe('preserved-ahead');
    expect(planned?.onDiskVersion).toBe('9.9.9');
  });

  it('ahead guard holds for a pre-fingerprint ahead file, and even under blanket force', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '9.9.9',
    });
    const skillPath = path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md');
    // Strip the contentHash line: version-only ahead stamp.
    const stripped = (await readFile(skillPath, 'utf8')).replace(
      /\n {2}contentHash: "[0-9a-f]+"/,
      ''
    );
    await writeFile(skillPath, stripped, 'utf8');

    const second = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
      force: true,
    });
    expect(second.unchanged).toContain('.claude/skills/orcaops-capture/SKILL.md');
    expect(await readFile(skillPath, 'utf8')).toBe(stripped);
  });

  it('DOWNGRADES with overrideAhead — proving the guard, not luck, preserves ahead files', async () => {
    await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '9.9.9',
    });
    const skillPath = path.join(tmpRoot, '.claude/skills/orcaops-capture/SKILL.md');

    const plan = await planGenerateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
      force: true,
      overrideAhead: true,
    });
    const planned = plan.files.find((f) => f.path === '.claude/skills/orcaops-capture/SKILL.md');
    expect(planned?.action).toBe('replace');
    expect(planned?.reason).toBe('forced-downgrade');
    expect(planned?.onDiskVersion).toBe('9.9.9');

    const second = await generateForTool({
      repoRoot: tmpRoot,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
      force: true,
      overrideAhead: true,
    });
    expect(second.refreshed).toContain('.claude/skills/orcaops-capture/SKILL.md');
    expect(await readFile(skillPath, 'utf8')).toMatch(/generatedBy: "orcaops@0\.0\.0"/);
  });
});
