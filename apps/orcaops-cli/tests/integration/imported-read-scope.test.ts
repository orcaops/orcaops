import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHistoryRepo, type HistoryRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/** Read surfaces against a database holding only imported artifacts. */
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

  it('includes imported matches in the canonical touching result', async () => {
    const human = (await agent.runRaw(['list', '--touching', 'src/health.ts'])).stdout;
    expect(human).toContain('[imported]');
    expect(human).toContain('Returned: 0 captured, 1 imported.');

    const json = JSON.parse(
      (await agent.runRaw(['list', '--touching', 'src/health.ts', '--json'])).stdout
    ) as {
      results: Array<{ origin: string }>;
      origin_counts: { returned: { captured: number; imported: number } };
    };
    expect(json.results).toEqual([expect.objectContaining({ origin: 'git-import' })]);
    expect(json.origin_counts.returned).toEqual({ captured: 0, imported: 1 });
  });

  it('aligns imported rows under the canonical list header', async () => {
    const stdout = (await agent.runRaw(['list'])).stdout;
    const lines = stdout.split('\n');
    const header = lines.find((line) => line.startsWith('ID       PROJECT'))!;
    const rows = lines.filter((line) => line.includes('[imported]'));
    expect(rows.length).toBeGreaterThan(0);
    for (const column of ['PROJECT', 'STATE', 'CPS', 'BRANCH']) {
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

  it('reports an imported-only decisions selection without inventing records', async () => {
    const human = (await agent.runRaw(['decisions'])).stdout;
    expect(human).toContain('No decisions in available history.');
    expect(human).toContain('Inspected 1 artifact(s); returned 0 captured, 0 imported.');
    const json = JSON.parse((await agent.runRaw(['decisions', '--json'])).stdout) as {
      results: unknown[];
      page: { inspected: number };
      origin_counts: { returned: { captured: number; imported: number } };
    };
    expect(json.results).toEqual([]);
    expect(json.page.inspected).toBe(1);
    expect(json.origin_counts.returned).toEqual({ captured: 0, imported: 0 });
  });

  it('reports an imported-only loose-ends selection without inventing findings', async () => {
    const human = (await agent.runRaw(['loose-ends'])).stdout;
    expect(human).toContain('No loose ends in available history.');
    expect(human).toContain('Inspected 1 artifact(s); returned 0 captured, 0 imported.');
    const json = JSON.parse((await agent.runRaw(['loose-ends', '--json'])).stdout) as {
      results: unknown[];
      page: { inspected: number };
      origin_counts: { returned: { captured: number; imported: number } };
    };
    expect(json.results).toEqual([]);
    expect(json.page.inspected).toBe(1);
    expect(json.origin_counts.returned).toEqual({ captured: 0, imported: 0 });
  });

  it('reports a missing code path without claiming checkpoint attribution', async () => {
    const human = (await agent.runRaw(['why', 'resolveWidgetRegistry'])).stdout;
    expect(human).toContain('resolveWidgetRegistry — none');
    expect(human).toContain('CODE_PATH_ABSENT');
    expect(human).not.toContain("not claimed in any checkpoint's files_changed");

    const json = JSON.parse(
      (await agent.runRaw(['why', 'resolveWidgetRegistry', '--json'])).stdout
    ) as { best: unknown; target: { issues: string[] } };
    expect(json.best).toBeNull();
    expect(json.target.issues).toContain('CODE_PATH_ABSENT');

    // An untracked worktree file has no blame evidence and remains unattributed.
    await writeFile(path.join(repo.path, 'notes.txt'), 'uncaptured\n', 'utf8');
    const fileMiss = (await agent.runRaw(['why', 'notes.txt:1'])).stdout;
    expect(fileMiss).toContain('notes.txt:1 — none');
    expect(fileMiss).toContain('CODE_BLAME_UNAVAILABLE');
  });

  it('does not treat completed imported evidence as an implicit resumable task', async () => {
    const human = (await agent.runRaw(['resume'])).stdout;
    expect(human).toContain('No task selected: NO_ELIGIBLE_ARTIFACT.');
    expect(human).toContain('(ARTIFACT_COMPLETED)');
    const json = JSON.parse((await agent.runRaw(['resume', '--json'])).stdout) as {
      resolved: boolean;
      reason: string;
      candidates: Array<{ eligibility: { reason: string } }>;
    };
    expect(json.resolved).toBe(false);
    expect(json.reason).toBe('NO_ELIGIBLE_ARTIFACT');
    expect(json.candidates).toEqual([
      expect.objectContaining({
        eligibility: expect.objectContaining({ reason: 'ARTIFACT_COMPLETED' }),
      }),
    ]);
  });
});
