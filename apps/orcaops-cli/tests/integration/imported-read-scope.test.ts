import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHistoryRepo, type HistoryRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * Read surfaces against a store holding ONLY imported artifacts: every
 * branch-scoped arm either includes the imported corpus or discloses it via
 * the shared trailer — never a bare empty state.
 */
describe('imported-only store read surfaces', () => {
  let repo: HistoryRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeAll(async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish the service',
        files: { 'src/service.ts': 'export const service = true;\n' },
      },
      {
        type: 'commit',
        label: 'next',
        subject: 'fix: stabilize the service',
        files: { 'src/health.ts': 'export const healthy = true;\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const applied = await agent.runRaw([
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: 'applied',
      totals: { failed: 0 },
    });
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it('discloses imported hits withheld from list --touching and reaches them via --imported', async () => {
    const human = (await agent.runRaw(['list', '--touching', 'src/health.ts'])).stdout;
    expect(human).toContain('No closed checkpoints touched src/health.ts.');
    expect(human).toMatch(
      /… and 1 imported artifact — `orcaops list --touching src\/health\.ts --imported`/u
    );

    const json = JSON.parse(
      (await agent.runRaw(['list', '--touching', 'src/health.ts', '--json'])).stdout
    ) as { artifacts: unknown[]; imported_artifacts?: { count: number; hint: string } };
    expect(json.artifacts).toEqual([]);
    expect(json.imported_artifacts).toEqual({
      count: 1,
      hint: 'orcaops list --touching src/health.ts --imported',
    });

    const importedView = (await agent.runRaw(['list', '--touching', 'src/health.ts', '--imported']))
      .stdout;
    expect(importedView).toContain('[imported]');
    expect(importedView).toContain('Artifacts touching src/health.ts');
  });

  it('aligns the list --imported table under its own header', async () => {
    const stdout = (await agent.runRaw(['list', '--imported'])).stdout;
    const lines = stdout.split('\n');
    const header = lines.find((line) => line.startsWith('ID       STATE'))!;
    const rows = lines.filter((line) => line.includes('[imported]'));
    expect(rows.length).toBeGreaterThan(0);
    for (const column of ['STATE', 'CPS', 'BRANCH']) {
      const at = header.indexOf(column);
      // Every row must have a cell boundary where the header says one is: a
      // full 36-char id padded to 8 pushed every later column off its heading.
      for (const row of rows) expect(row[at - 1]).toBe(' ');
    }
  });

  it('attributes an unscoped diff --attribution against imported manifests', async () => {
    const result = await agent.runRaw([
      'diff',
      '--attribution',
      '--base',
      repo.shas.root!,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as { attribution_granularity: string };
    expect(envelope.attribution_granularity).not.toBe('none');
  });

  it('carries the imported trailer on the decisions empty state', async () => {
    const human = (await agent.runRaw(['decisions'])).stdout;
    expect(human).toContain('No decisions in scope.');
    expect(human).toMatch(/… and 1 imported artifact — `orcaops list --imported`/u);
    const json = JSON.parse((await agent.runRaw(['decisions', '--json'])).stdout) as {
      artifacts: unknown[];
      imported_artifacts?: { count: number; hint: string };
    };
    expect(json.artifacts).toEqual([]);
    expect(json.imported_artifacts).toEqual({ count: 1, hint: 'orcaops list --imported' });
  });

  it('carries the imported trailer on the loose-ends empty state', async () => {
    const human = (await agent.runRaw(['loose-ends'])).stdout;
    expect(human).toContain('No loose ends in scope.');
    expect(human).toMatch(/… and 1 imported artifact — `orcaops list --imported`/u);
    const json = JSON.parse((await agent.runRaw(['loose-ends', '--json'])).stdout) as {
      artifacts: unknown[];
      imported_artifacts?: { count: number; hint: string };
    };
    expect(json.artifacts).toEqual([]);
    expect(json.imported_artifacts).toEqual({ count: 1, hint: 'orcaops list --imported' });
  });

  it('carries the imported pointer on the loose-ends --all-branches empty state', async () => {
    // --all-branches reaches the imported rows, but they owe no loose ends,
    // so the view is empty — the pointer must still disclose the corpus.
    const human = (await agent.runRaw(['loose-ends', '--all-branches'])).stdout;
    expect(human).toContain('No loose ends in scope.');
    expect(human).toMatch(/… and 1 imported artifact — `orcaops list --imported`/u);
    const json = JSON.parse(
      (await agent.runRaw(['loose-ends', '--all-branches', '--json'])).stdout
    ) as {
      artifacts: unknown[];
      imported_artifacts?: { count: number; hint: string };
    };
    expect(json.artifacts).toEqual([]);
    expect(json.imported_artifacts).toEqual({ count: 1, hint: 'orcaops list --imported' });
  });

  it('explains the missing symbol lane when a non-file why target misses', async () => {
    const human = (await agent.runRaw(['why', 'resolveWidgetRegistry'])).stdout;
    expect(human).toContain('No matching captured artifact.');
    expect(human).toContain('the symbol lane has no imported coverage');
    expect(human).toContain('imported artifacts resolve by file:line');
    expect(human).not.toContain("not claimed in any checkpoint's files_changed");

    const json = JSON.parse(
      (await agent.runRaw(['why', 'resolveWidgetRegistry', '--json'])).stdout
    ) as { best: unknown; hint?: string };
    expect(json.best).toBeNull();
    expect(json.hint).toContain('the symbol lane has no imported coverage');

    // A target that IS a worktree file keeps the segment-attribution
    // framing on a miss — the symbol-lane wording is for non-files only.
    await writeFile(path.join(repo.path, 'notes.txt'), 'uncaptured\n', 'utf8');
    const fileMiss = (await agent.runRaw(['why', 'notes.txt:1'])).stdout;
    expect(fileMiss).toContain("not claimed in any checkpoint's files_changed");
    expect(fileMiss).not.toContain('the symbol lane has no imported coverage');
  });

  it('carries the imported trailer on the resume empty state', async () => {
    const human = (await agent.runRaw(['resume'])).stdout;
    expect(human).toContain('No in-flight artifacts on branch "main".');
    expect(human).toMatch(/… and 1 imported artifact — `orcaops list --imported`/u);
    const json = JSON.parse((await agent.runRaw(['resume', '--json'])).stdout) as {
      resolution_via: string;
      imported_artifacts?: { count: number; hint: string };
    };
    expect(json.resolution_via).toBe('no-active-artifacts');
    expect(json.imported_artifacts).toEqual({ count: 1, hint: 'orcaops list --imported' });
  });
});
