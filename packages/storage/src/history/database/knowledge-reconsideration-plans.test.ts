// Every lookup the reconsideration writers and readers make reaches its rows through an index.
// A status or a lookup asks about one identity per entry it carries, so an unindexed lookup here
// is paid for on every rule a surface shows.
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { type ProjectReadView } from './connection.js';
import { knowledgeReadRequest } from './knowledge-read-boundary.js';
import {
  openProjectReconsiderationItems,
  readProjectReconsiderationItem,
  readProjectReconsiderationItems,
} from './knowledge-reconsideration.js';
import { registerQueryFunctions } from './query-functions.js';
import { consequenceStore } from '../../../tests/knowledge-consequence-store.js';
import { discardKnowledgeStores } from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';

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

it('reaches every row through an index on every query a reconsideration read runs', async () => {
  const store = await consequenceStore();
  const written = await openProjectReconsiderationItems(store.handle, {
    operationId: uuidv7(),
    items: [
      {
        affected: { kind: 'requirement', id: store.requirement.entity_id },
        cause: {
          kind: 'revision',
          key: '{"kind":"revision"}',
          change: { kind: 'revision' },
        },
        reason: 'A task recorded a use of the revision that moved.',
        basis: 'explicit',
        path: [],
        owner: null,
        opened_at_boundary: store.boundaries.assessed,
      },
    ],
    secretAllow: [],
  });
  const itemId = written.value.items[0]!.itemId;

  const executed: Executed[] = [];
  store.handle.read((real) => {
    const view = recording(real, executed);
    const request = knowledgeReadRequest(view, {
      scope: store.store.project,
      mode: 'current',
      boundary: 'now',
    });
    readProjectReconsiderationItems(view, request);
    readProjectReconsiderationItems(view, request, {
      affected: { kind: 'requirement', id: store.requirement.entity_id },
      openOnly: false,
    });
    readProjectReconsiderationItem(view, itemId, request);
    return null;
  });

  expect(executed.length).toBeGreaterThan(4);
  const database = new Database(store.handle.databasePath, { readonly: true });
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
    expect(scanned).toEqual([]);
  } finally {
    database.close();
  }
});
