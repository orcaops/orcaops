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

describe('orcaops decisions', { timeout: 30_000 }, () => {
  it('retains plan, checkpoint and summary decision provenance through the registered command', async () => {
    const f = await insightFixture();
    await closeWithFindings(f);
    await summarize(f);
    const before = await inventory(f.temporary);
    const result = parseOk(await f.agent.runRaw(['decisions', '--json']));
    expect(result.results[0]).toMatchObject({
      artifact_id: f.id,
      project_id: f.authority.projectId,
      records: expect.arrayContaining([
        expect.objectContaining({
          source: 'plan',
          decision: 'Use retained records',
          revision_n: 0,
          ts: '2026-01-01T00:00:00.000Z',
        }),
        expect.objectContaining({
          source: 'checkpoint',
          decision: 'Use checkpoint evidence',
          checkpoint_n: 1,
          ts: expect.any(String),
        }),
        expect.objectContaining({
          source: 'summary_deferred',
          decision: 'Deferred choice',
          ts: '2026-09-01T00:00:00.000Z',
        }),
      ]),
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('fixes exact artifact selection while filtering only decision dates', async () => {
    const f = await insightFixture();
    await summarize(f);
    const result = parseOk(
      await f.agent.runRaw([
        'decisions',
        '--artifact',
        f.id,
        '--since',
        '2026-09-01',
        '--until',
        '2026-09-01',
        '--json',
      ])
    );
    expect(result.results[0].records).toEqual([
      expect.objectContaining({ source: 'summary_deferred', decision: 'Deferred choice' }),
    ]);
    expect(result.record_window).toEqual({
      lower: '2026-09-01T00:00:00.000Z',
      upper: '2026-09-01T23:59:59.999Z',
    });
  });

  it('discloses corrupt selected history without returning unverified decisions or repairing it', async () => {
    const f = await insightFixture();
    await summarize(f);
    damageArtifact(f);
    const before = await inventory(f.temporary);
    const result = parseOk(await f.agent.runRaw(['decisions', '--json']));
    expect(result.results).toEqual([]);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ project_id: f.authority.projectId })],
    });
    expect(result.page.ranking_complete).toBe(false);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reports an unknown exact artifact without initializing replacement history', async () => {
    const f = await insightFixture();
    const before = await inventory(f.temporary);
    const result = await f.agent.runRaw(['decisions', '--artifact', uuidv7(), '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('UNKNOWN_ARTIFACT');
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
