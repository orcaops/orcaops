import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import { inventory } from '../helpers/database-history.js';
import {
  closeWithFindings,
  damageArtifact,
  insightFixture,
  parseOk,
  summarize,
} from '../helpers/database-insights.js';

describe('orcaops loose-ends', { timeout: 30_000 }, () => {
  it('shows current findings even when the selected artifact started months earlier', async () => {
    const f = await insightFixture();
    await closeWithFindings(f);
    await summarize(f);
    const result = parseOk(
      await f.agent.runRaw([
        'loose-ends',
        '--since',
        '2026-01-01',
        '--until',
        '2026-01-01',
        '--json',
      ])
    );
    expect(result.window_semantics).toBe('selects-artifacts-only');
    expect(result.results[0]).toMatchObject({
      artifact_id: f.id,
      open_items: [expect.objectContaining({ text: 'Still owed' })],
      deferred_decisions: [expect.objectContaining({ text: 'Deferred choice' })],
      uncertainty: [
        expect.objectContaining({ checkpoint_n: 1, entries: ['Confirm future integration'] }),
      ],
      uncovered_steps: [expect.any(Object)],
      no_summary: false,
    });
  });

  it('omits a completed summarized artifact but retains unfinished work', async () => {
    const f = await insightFixture();
    await closeWithFindings(f, f.id, true);
    await summarize(f, f.id, true);
    const open = await f.capture();
    const result = parseOk(await f.agent.runRaw(['loose-ends', '--json']));
    expect(result.results.map((row: { artifact_id: string }) => row.artifact_id)).toEqual([open]);
    expect(result.results[0].no_summary).toBe(true);
  });

  it.each([false, true])(
    'discloses damaged history without inventing current findings (tail removal: %s)',
    async (removeTail) => {
      const f = await insightFixture();
      await closeWithFindings(f, f.id, true);
      await summarize(f, f.id, true);
      damageArtifact(f, f.id, removeTail);
      const before = await inventory(f.temporary);
      const result = parseOk(await f.agent.runRaw(['loose-ends', '--json']));
      expect(result.results).toEqual([]);
      expect(result.completeness).toMatchObject({
        complete: false,
        issues: [expect.objectContaining({ project_id: f.authority.projectId })],
      });
      expect(result.origin_counts.matching).toEqual({ captured: null, imported: null });
      expect(await inventory(f.temporary)).toEqual(before);
    }
  );

  it('detects lost history before a summary was ever captured', async () => {
    const f = await insightFixture();
    await closeWithFindings(f);
    damageArtifact(f, f.id, true);
    const result = parseOk(await f.agent.runRaw(['loose-ends', '--json']));
    expect(result.results).toEqual([]);
    expect(result.completeness.complete).toBe(false);
  });

  it('selects an exact artifact and rejects ineffective window flags', async () => {
    const f = await insightFixture();
    await f.capture(uuidv7());
    const result = parseOk(await f.agent.runRaw(['loose-ends', '--artifact', f.id, '--json']));
    expect(result.results.map((row: { artifact_id: string }) => row.artifact_id)).toEqual([f.id]);
    const rejected = await f.agent.runRaw([
      'loose-ends',
      '--artifact',
      f.id,
      '--since',
      '2026-01-01',
      '--json',
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout).error.code).toBe('INVALID_INPUT');
  });
});
