import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * No shipped skill declares `requires: ['archive']`: plan-critique is
 * ungated and default-on, and the cross-project paths degrade in-body.
 * These tests pin the ungated posture with archive OFF (plan-critique
 * installed and enabled under empty capabilities; resume's cold-start
 * prose present, degrading in-body) and the archive-ON regeneration
 * story (recap's cross-project paragraph ships through update).
 */

interface SkillRow {
  id: string;
  effective: boolean;
  capability_satisfied: boolean;
  requires: string[];
  installed: Record<string, boolean>;
}

describe('archive capability + skills', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'orcaops-skl-data-')),
        XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-skl-cache-')),
      },
    });
    const init = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents-md',
    ]);
    expect(init.exitCode).toBe(0);
  }, 60_000);

  afterEach(async () => {
    await repo.cleanup();
  });

  async function skillRows(): Promise<SkillRow[]> {
    const r = await agent.runRaw(['skills', 'list', '--json']);
    expect(r.exitCode).toBe(0);
    return (JSON.parse(r.stdout) as { skills: SkillRow[] }).skills;
  }

  async function setArchiveEnabled(enabled: boolean): Promise<void> {
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.archive = { enabled, redact_secrets: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  it('archive off: plan-critique is installed and ENABLED (no archive gate); resume keeps ungated cold-start prose', async () => {
    const rows = await skillRows();
    const critique = rows.find((s) => s.id === 'plan-critique');
    expect(critique).toBeDefined();
    expect(critique?.effective).toBe(true);
    expect(critique?.requires).toEqual([]);
    expect(critique?.installed['claude-code']).toBe(true);
    // An enabled skill with a blockTriggerLine contributes its routing
    // trigger to the managed block.
    const block = await readFile(path.join(repo.path, 'CLAUDE.md'), 'utf8');
    expect(block).toContain('orcaops-plan-critique');
    // The body degrades in-body: cross-project mode is archive-conditional prose.
    const critiqueBody = await readFile(
      path.join(repo.path, '.claude', 'skills', 'orcaops-plan-critique', 'SKILL.md'),
      'utf8'
    );
    expect(critiqueBody).toContain('archive.enabled');
    expect(critiqueBody).toMatch(/never block\s+planning on missing history/u);
    // Search's cross-project curiosity path is likewise in-body conditional.
    const searchBody = await readFile(
      path.join(repo.path, '.claude', 'skills', 'orcaops-search', 'SKILL.md'),
      'utf8'
    );
    expect(searchBody).toContain('--all-projects');
    expect(searchBody).toContain('Cross-project curiosity');
    // resume must NOT declare a `requires` — its handoff prose installs
    // even with archive off, degrading in-body.
    const resume = rows.find((s) => s.id === 'resume');
    expect(resume?.requires ?? []).toEqual([]);
    expect(resume?.effective).toBe(true);
    const resumeBody = await readFile(
      path.join(repo.path, '.claude', 'skills', 'orcaops-resume', 'SKILL.md'),
      'utf8'
    );
    expect(resumeBody).toContain('Cold-start in a fresh worktree');
    expect(resumeBody).toContain('if the archive is enabled');
  });

  it('enabling archive + update regenerates bodies (recap cross-project, capture pre-step)', async () => {
    await setArchiveEnabled(true);
    const update = await agent.runRaw(['update', '--json']);
    expect(update.exitCode).toBe(0);

    // The capture skill body carries the plan-critique pre-step reference,
    // and the recap body's cross-project paragraph ships via the regen
    // machinery.
    const capture = await readFile(
      path.join(repo.path, '.claude', 'skills', 'orcaops-capture', 'SKILL.md'),
      'utf8'
    );
    expect(capture).toContain('orcaops-plan-critique');
    const recap = await readFile(
      path.join(repo.path, '.claude', 'skills', 'orcaops-recap', 'SKILL.md'),
      'utf8'
    );
    expect(recap).toContain('--all-projects');
    expect(recap).toContain('Cross-project mode');
  });
});
