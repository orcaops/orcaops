import { afterEach, describe, expect, it } from 'vitest';

import {
  type DatabaseHistoryScope,
  resolveDatabaseHistoryScope,
} from '@orcaops/project-scope/history/database';
import {
  queryProjectArtifacts,
  readProjectUsageAccounting,
} from '@orcaops/storage/history/database';

import {
  type HistoryDatabaseFixture,
  historyDatabaseFixture,
} from './support/history-database-fixture.js';

const fixtures: HistoryDatabaseFixture[] = [];
const scopes: DatabaseHistoryScope[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) scope.close();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

describe('history database fixture', { timeout: 60_000 }, () => {
  it('registers the checkout and appends artifacts, usage, reviews and a second project', async () => {
    const f = await historyDatabaseFixture();
    fixtures.push(f);
    const id = await f.add({ branch: 'topic' });
    await f.checkpoint(id, { open: true });
    const other = await f.add();
    await f.checkpoint(other, { summary: 'Closed retained work' });
    await f.summarize(other);
    await f.usage(id, { sessionId: 'watch-session', tokens: 12 });
    await f.review('topic', ['First observation', 'Second observation']);
    const sibling = await f.addProject();
    await f.add({ writer: sibling.writer, branch: 'sibling' });

    const scope = await resolveDatabaseHistoryScope({
      root: f.root,
      cwd: f.cwd,
      selector: { scope: 'all-projects' },
    });
    scopes.push(scope);
    expect(scope.completeness).toEqual({ complete: true, issues: [] });
    expect(scope.gitContext?.branch).toBe('main');
    expect(scope.projects.map((project) => project.projectId).sort()).toEqual(
      [f.authority.projectId, sibling.authority.projectId].sort()
    );
    const registered = scope.projects.find(
      (project) => project.projectId === f.authority.projectId
    )!;
    const rows = queryProjectArtifacts(registered.database!, { profile: 'watch' }).rows;
    expect(rows.map((row) => [row.artifactId, row.state, row.openCheckpointCount]).sort()).toEqual(
      [
        [id, 'planned', 1],
        [other, 'summarized', 0],
      ].sort()
    );
    expect(JSON.parse(rows.find((row) => row.artifactId === other)!.watchJson!)).toMatchObject({
      currentLine: 'Closed retained work',
      lastClosed: { hasSummary: true, uncertaintyCount: 1 },
    });
    const accounting = readProjectUsageAccounting(registered.database!, { artifactIds: [id] });
    expect(accounting.events.map((event) => event.record.type)).toEqual([
      'agent_usage_snapshot_recorded',
    ]);
    const reviews = registered.database!.read((view) => ({
      reviews: view.all<{ review_id: string; branch: string }>(
        'SELECT review_id, branch FROM reviews'
      ),
      comments: view.get<{ n: number }>('SELECT count(*) AS n FROM review_comments')!.n,
    }));
    expect(reviews.value.reviews).toHaveLength(1);
    expect(reviews.value.reviews[0]!.branch).toBe('topic');
    expect(reviews.value.comments).toBe(2);
    const siblingRows = queryProjectArtifacts(
      scope.projects.find((project) => project.projectId === sibling.authority.projectId)!
        .database!,
      { profile: 'watch' }
    ).rows;
    expect(siblingRows.map((row) => row.branch)).toEqual(['sibling']);
  });
});
