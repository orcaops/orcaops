import { expect, it, vi } from 'vitest';

import {
  collectDatabaseHistory,
  resolveDatabaseHistoryScope,
} from '@orcaops/project-scope/history/database';
import { getDefaultConfig } from '@orcaops/storage';

import { readDatabaseDecisions, validateDatabaseInsight } from '../../src/lib/database-insights.js';
import { insightFixture } from '../helpers/database-insights.js';

const pausedSelection = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@orcaops/project-scope/history/database', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('@orcaops/project-scope/history/database')>();
  return {
    ...original,
    collectDatabaseHistory: (...args: Parameters<typeof original.collectDatabaseHistory>) =>
      pausedSelection.value ?? original.collectDatabaseHistory(...args),
  };
});

it('retains the membership observation stamp when a new artifact commits before hydration', async () => {
  const f = await insightFixture();
  const scope = await resolveDatabaseHistoryScope({
    root: f.root,
    cwd: f.main,
    profile: 'collection',
    selector: {},
  });
  try {
    const selected = collectDatabaseHistory(scope, {}, 'versions');
    const selectionSequence = selected.sources[0].counters.writeSequence;
    const added = await f.capture(undefined, {
      ts: '2026-09-01T00:00:00.000Z',
      decisions: [
        {
          decision: 'Newly committed choice',
          reason: 'Changes current collection membership',
          revision_n: 0,
        },
      ],
    });
    const latest = collectDatabaseHistory(scope, {}, 'versions');
    expect(latest.sources[0].counters.writeSequence).toBeGreaterThan(selectionSequence);
    expect(latest.entries.map((item) => item.row.artifactId)).toContain(added);
    pausedSelection.value = selected;
    const result = readDatabaseDecisions(
      { scope, config: getDefaultConfig() },
      validateDatabaseInsight('decisions', {})
    );
    expect(result.results.map((item) => item.artifact_id)).toEqual([f.id]);
    expect(result.sources[0].selection_write_sequence).toBe(selectionSequence);
    expect(result.sources[0].write_sequence).toBe(selectionSequence);
  } finally {
    pausedSelection.value = null;
    scope.close();
  }
}, 30_000);
