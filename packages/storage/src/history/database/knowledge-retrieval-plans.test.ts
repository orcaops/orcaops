// Every lookup bounded retrieval makes reaches its rows through an index, except the two named
// below. Retrieval runs on the dispatch path of every background job, and it follows a source to
// its records through several tables, so an unindexed lookup here is paid for on every job.
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { type ProjectReadView } from './connection.js';
import { retrieveRelatedKnowledge } from './knowledge-retrieval.js';
import { registerSearchFunctions } from './search-functions.js';
import { retrievalStore, SOURCE_TEXT } from '../../../tests/knowledge-retrieval-store.js';
import { discardKnowledgeStores } from '../../../tests/knowledge-store.js';

afterEach(discardKnowledgeStores);

interface Executed {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const recording = (view: ProjectReadView, executed: Executed[]): ProjectReadView => ({
  all: (sql, ...parameters) => {
    executed.push({ sql, parameters });
    return view.all(sql, ...parameters);
  },
  get: (sql, ...parameters) => {
    executed.push({ sql, parameters });
    return view.get(sql, ...parameters);
  },
});

it('reaches every row through an index on every query bounded retrieval runs', async () => {
  const store = await retrievalStore();
  const executed: Executed[] = [];
  store.handle.read((real) => {
    retrieveRelatedKnowledge(recording(real, executed), {
      source: {
        artifactId: store.plan.artifactId,
        eventId: store.sourceEventId,
        planEventId: store.plan.planEventId,
        text: SOURCE_TEXT,
      },
      projectId: store.authority.projectId,
      scope: store.artifact,
      boundary: store.boundary,
      bounds: {
        maxIdentities: 24,
        maxStatementBytes: 16_384,
        maxSearchTerms: 12,
        maxSearchHits: 50,
        maxSourcesFollowed: 64,
      },
    });
    return null;
  });
  expect(executed.length).toBeGreaterThan(10);
  const database = new Database(store.handle.databasePath, { readonly: true });
  // The search match function lives on the connection, not in the file, so a second reader has to
  // register it before it can plan a query that calls it.
  registerSearchFunctions(database);
  try {
    const scanned: string[] = [];
    for (const { sql, parameters } of executed) {
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as {
        detail: string;
      }[];
      if (plan.some((step) => /^SCAN (?!.*USING)/.test(step.detail)))
        scanned.push(sql.replace(/\s+/g, ' ').trim());
    }
    // One scan, named rather than hidden, and not one this retrieval could avoid by indexing
    // something: `artifacts` is the search index's validity check, one row per artifact, which is
    // the same check and the same shape `queryProjectSearch` runs before every search. Retrieval
    // reports a stale projection as a coverage limit where search refuses outright, and it already
    // reads every search row, so the check adds no order of work to what the second way costs.
    expect([...new Set(scanned)].map((sql) => /FROM (\w+)/.exec(sql)?.[1]).sort()).toEqual([
      'artifacts',
    ]);
  } finally {
    database.close();
  }
});
