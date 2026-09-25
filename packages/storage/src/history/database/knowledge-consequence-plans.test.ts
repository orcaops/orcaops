// Every lookup a consequence answer makes reaches its rows through an index, except the two named
// below. One answer resolves an identity per link it follows, so an unindexed lookup here is paid
// for on every hop of every traversal.
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { type ProjectReadView } from './connection.js';
import { knowledgeReadRequest } from './knowledge-read-boundary.js';
import {
  readProjectArtifactsTouching,
  readProjectAssessmentsNaming,
  readProjectAssumptionsNaming,
  readProjectFilesTouchedBy,
  readProjectIdentitiesSharingSubject,
  readProjectPlanEventsOf,
  readProjectRelationshipsOfIdentity,
  readProjectStandingMovedSince,
} from './knowledge-read-consequences.js';
import { registerQueryFunctions } from './query-functions.js';
import { consequenceStore, TOUCHED_FILE } from '../../../tests/knowledge-consequence-store.js';
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

it('reaches every row through an index on every query a consequence answer runs', async () => {
  const store = await consequenceStore();
  const executed: Executed[] = [];
  store.handle.read((real) => {
    const view = recording(real, executed);
    const request = knowledgeReadRequest(view, {
      scope: store.store.project,
      mode: 'current',
      boundary: 'now',
    });
    const identity = { kind: 'requirement' as const, entity_id: store.requirement.entity_id };
    readProjectRelationshipsOfIdentity(view, identity, request);
    readProjectAssumptionsNaming(
      view,
      { names: [identity.entity_id], decisionRevisionIds: [store.decision.revision_id] },
      request
    );
    readProjectAssessmentsNaming(
      view,
      {
        expectations: [store.requirement],
        inputs: [{ kind: 'file', identity: TOUCHED_FILE }],
      },
      request
    );
    readProjectArtifactsTouching(view, TOUCHED_FILE);
    readProjectArtifactsTouching(view, 'packages/sync/src/*.ts');
    readProjectFilesTouchedBy(view, [store.store.plan.artifactId]);
    readProjectPlanEventsOf(view, [store.store.plan.artifactId]);
    readProjectIdentitiesSharingSubject(view, [store.requirement, store.decision]);
    readProjectStandingMovedSince(view, 0, request, { maxMoves: 50 });
    return null;
  });
  expect(executed.length).toBeGreaterThan(10);
  const database = new Database(store.handle.databasePath, { readonly: true });
  // The path-matching function lives on the connection, not in the file, so a second reader has
  // to register it before it can plan a query that calls it.
  registerQueryFunctions(database);
  try {
    const scanned: string[] = [];
    for (const { sql, parameters } of executed) {
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as {
        detail: string;
      }[];
      if (plan.some((step) => /^SCAN (?!.*USING)/.test(step.detail)))
        scanned.push(sql.replace(/\s+/g, ' ').trim());
    }
    // Two scans, named rather than hidden, and neither is one this slice may fix by indexing
    // something: nothing indexes the write sequence an operation committed at, so the two acts
    // that move a revision's standing without a usable index of their own — an adoption and a
    // correction — are read in full and filtered. The reader reports that in a limit the answer
    // carries, and the sweep is bounded by the caller's own cap.
    expect([...new Set(scanned)].map((sql) => /FROM (\w+)/.exec(sql)?.[1]).sort()).toEqual([
      'adoptions',
      'correction_targets',
    ]);
  } finally {
    database.close();
  }
});
