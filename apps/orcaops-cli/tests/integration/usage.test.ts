import Database from 'better-sqlite3';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { projectDatabasePath } from '@orcaops/storage/history/database';

import type { readDatabaseUsage } from '../../src/lib/database-usage.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { tokens, usageObservation } from '../helpers/database-usage.js';
import { makeAgent } from '../support/test-agent.js';

async function usage(f: { main: string; root: string }, flags: string[] = []) {
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const raw = await agent.runRaw(['usage', '--json', ...flags]);
  expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
  return JSON.parse(raw.stdout) as ReturnType<typeof readDatabaseUsage>;
}
describe('registered database usage', { timeout: 30_000 }, () => {
  it('keeps exact session totals, model dimensions and checkpoint attribution separate', async () => {
    const f = await fixture();
    const id = await f.capture();
    await usageObservation(f.writer, id, 10);
    await usageObservation(f.writer, id, 20, {
      baseline_kind: 'checkpoint_open',
      delta_usage: tokens(10),
    });
    await usageObservation(f.writer, id, 30, {
      baseline_kind: 'checkpoint_open',
      delta_usage: tokens(20),
    });
    const before = await inventory(f.temporary);
    const result = await usage(f, ['--artifact', id.slice(0, 24)]);
    expect(result).toMatchObject({
      schema_version: 3,
      artifact_id: id,
      completeness: { complete: true },
      usage: {
        accounting: { status: 'exact', totals: tokens(30) },
        model_totals: [{ model: 'model', speed: 'fast', ...tokens(30) }],
        estimates: [
          {
            artifact_id: id,
            estimate: {
              kind: 'estimate',
              totals: tokens(20),
              checkpoints: [{ checkpoint_n: 1, deltas: tokens(20) }],
            },
          },
        ],
      },
    });
    expect(result.usage.projects[0].write_sequence).toBeGreaterThan(0);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('merges complete session observations across projects after literal branch selection', async () => {
    const a = await fixture();
    const b = await fixture(a.root);
    const first = await a.capture();
    await git(b.main, ['checkout', '-qb', 'other']);
    const second = await b.capture();
    await usageObservation(a.writer, first, 10);
    await usageObservation(b.writer, second, 20);
    await usageObservation(b.writer, second, 40, { agent: 'cursor' });
    const before = [await inventory(a.temporary), await inventory(b.temporary)];
    const result = await usage(a, ['--scope', 'all-projects', '--branch', 'main']);
    expect(result.usage.accounting).toMatchObject({ status: 'exact', totals: tokens(20) });
    expect(result.usage.accounting.sessions).toHaveLength(1);
    expect(result.usage.projects).toHaveLength(2);
    expect(
      (await usage(a, ['--scope', 'all-projects', '--branch', 'ma*'])).usage.accounting.totals
    ).toBeNull();
    expect([await inventory(a.temporary), await inventory(b.temporary)]).toEqual(before);
  });
  it('includes unassociated project usage and applies recorded touching before choosing sessions', async () => {
    const f = await fixture();
    const selected = await f.capture();
    await f.recordFiles(selected, ['src/usage.ts']);
    const other = await f.capture();
    await usageObservation(f.writer, selected, 10);
    await usageObservation(f.writer, other, 20);
    await usageObservation(f.writer, null, 40, { session_id: 'unassociated' });
    const before = await inventory(f.temporary);
    expect((await usage(f)).usage.accounting.totals).toEqual(tokens(60));
    expect((await usage(f, ['--origin', 'all'])).usage.accounting.totals).toEqual(tokens(60));
    expect((await usage(f, ['--touching', 'src/**'])).usage.accounting.totals).toEqual(tokens(20));
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('reports missing registered history without creating a replacement or exact zero', async () => {
    const f = await fixture();
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const result = await usage(f);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_MISSING' })],
    });
    expect(result.usage.accounting.totals).toBeNull();
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('discloses an unreadable selected session without repairing derived rows', async () => {
    const f = await fixture();
    const id = await f.capture();
    await usageObservation(f.writer, id, 10);
    const db = new Database(projectDatabasePath(f.authority));
    db.prepare("UPDATE usage_snapshots SET cumulative_json = '{}' ").run();
    db.close();
    const before = await inventory(f.temporary);
    const result = await usage(f);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })],
    });
    expect(result.usage.accounting.totals).toBeNull();
    expect(result.usage.model_totals).toBeNull();
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
