import { describe, expect, it } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { getDefaultConfig } from '@orcaops/storage';

import {
  readDatabaseDecisions,
  readDatabaseLooseEnds,
  validateDatabaseInsight,
} from '../../src/lib/database-insights.js';
import { inventory } from '../helpers/database-history.js';
import {
  closeWithFindings,
  damageArtifact,
  insightFixture,
  parseOk,
  summarize,
} from '../helpers/database-insights.js';

describe('database insight command boundaries', { timeout: 30_000 }, () => {
  it.each(['project', 'all-projects'] as const)(
    'retains recent decisions on old artifacts in %s collections',
    async (scope) => {
      const f = await insightFixture();
      await summarize(f);
      const before = await inventory(f.temporary);
      const exact = parseOk(
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
      const collection = parseOk(
        await f.agent.runRaw([
          'decisions',
          '--scope',
          scope,
          '--since',
          '2026-09-01',
          '--until',
          '2026-09-01',
          '--json',
        ])
      );
      expect(exact.results[0].records).toEqual([
        expect.objectContaining({ source: 'summary_deferred', decision: 'Deferred choice' }),
      ]);
      expect(collection.completeness.complete).toBe(true);
      expect(await inventory(f.temporary)).toEqual(before);
      expect(collection.results).toEqual(exact.results);
    }
  );

  it('discloses a damaged completed artifact alongside healthy project findings', async () => {
    const f = await insightFixture();
    await closeWithFindings(f, f.id, true);
    await summarize(f, f.id, true);
    const other = await insightFixture(f.root);
    damageArtifact(f);
    const before = await inventory(f.temporary);
    const result = parseOk(
      await other.agent.runRaw(['loose-ends', '--scope', 'all-projects', '--json'])
    );
    expect(result.results.map((item: { artifact_id: string }) => item.artifact_id)).toEqual([
      other.id,
    ]);
    expect(result.completeness.complete).toBe(false);
    expect(result.completeness.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ project_id: f.authority.projectId })])
    );
    expect(result.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(result.page).toMatchObject({
      next_offset: null,
      truncated: true,
      ranking_complete: false,
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('redacts incomplete scope diagnostics for both content reports without changing retained inputs', async () => {
    const f = await insightFixture();
    const scope = await resolveDatabaseHistoryScope({
      root: f.root,
      cwd: f.main,
      profile: 'collection',
      selector: {},
    });
    const token = 'ghp_' + 'aB9cD8eF7gH6jK5mN4pQ3rS2tU1vW0xY9zA8';
    const message = 'Unavailable credential ' + token;
    scope.completeness.issues.push({ code: 'HISTORY_INACCESSIBLE', project_id: null, message });
    try {
      const context = { scope, config: getDefaultConfig() };
      const before = await inventory(f.temporary);
      for (const [kind, read] of [
        ['decisions', readDatabaseDecisions],
        ['loose-ends', readDatabaseLooseEnds],
      ] as const) {
        const result = read(context, validateDatabaseInsight(kind, {}));
        expect(result.completeness.complete).toBe(false);
        expect(JSON.stringify(result)).not.toContain(token);
      }
      expect(scope.completeness.issues.at(-1)?.message).toBe(message);
      expect(await inventory(f.temporary)).toEqual(before);
    } finally {
      scope.close();
    }
  });
});
