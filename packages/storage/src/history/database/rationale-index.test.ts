import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import {
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
  type ProjectReadView,
} from './connection.js';
import { rebuildProjectQueryMetadata } from './query-metadata-rebuild.js';
import { discoverRationaleAccounts, rationaleIndexStatus } from './rationale-index.js';
import { readProjectRationale } from './rationale-read.js';
import {
  capturePlan,
  discardKnowledgeStores,
  knowledgeStore,
} from '../../../tests/knowledge-store.js';
import { closeCapture, planCapture } from '../../../tests/rationale-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

it('rejects broad inventories before account limits and reserves discovery for change passages', async () => {
  const { handle } = await knowledgeStore();
  const seed = 'Keep native navigation history and the return band with independent tab stacks.';
  for (let i = 0; i < 36; i++) {
    await closeCapture(
      handle,
      await planCapture(handle, 'Archive inventory', []),
      [
        {
          decision: `Retain per-file ledger ${i} including src/navigation.ts.`,
          reason: 'Archive invoice and dependency hashes. '.repeat(600) + seed,
        },
      ],
      ['docs/archive.md']
    );
    await capturePlan(handle, plan(`${seed} Record variant ${i}.`));
  }
  const changed = plan(
    'Remove the return band; independent tab stacks still own navigation history.'
  );
  await capturePlan(handle, changed);
  const found = handle.read((view) => discoverRationaleAccounts(view, [seed], [])).value;
  expect(found.matches).toHaveLength(32);
  expect(found.matches.some((match) => match.eventId === changed.planEventId)).toBe(true);
  expect(found.diagnostics.rejected_accounts).toBeGreaterThanOrEqual(36);
});

it('rejects unrelated cleanup before reserving discovery for disconnected policy changes', async () => {
  const { handle } = await knowledgeStore();
  const seed =
    'Keep a durable delivery lease. Behavioral assertions and failure controls protect notification delivery.';
  for (let i = 0; i < 40; i++)
    await closeCapture(
      handle,
      await planCapture(handle, 'Archive cleanup', []),
      [
        {
          decision: `Retire obsolete archive paths ${i}.`,
          reason: 'Behavioral assertions and failure controls retain value.',
        },
      ],
      ['docs/archive.md']
    );
  const changed = plan(
    'Replace the delivery lease with a transactional outbox to prevent duplicate notification delivery.'
  );
  await capturePlan(handle, changed);
  const found = handle.read((view) => discoverRationaleAccounts(view, [seed], [])).value;
  expect(found.matches.map((match) => match.eventId)).toEqual([changed.planEventId]);
  expect(found.diagnostics.rejected_accounts).toBe(40);
});

const plan = (text: string) => ({
  artifactId: uuidv7(),
  planEventId: uuidv7(),
  steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text }] }],
});

it.each(['mobile signing', 'native symbols', 'navigation mesh', 'move ownership'])(
  'discovers a disconnected account about %s from its subject vocabulary',
  async (subject) => {
    const { handle } = await knowledgeStore();
    const relevant = plan(`Preserve ${subject}.`);
    await capturePlan(handle, relevant);
    await capturePlan(handle, plan(`Preserve ${subject.split(' ')[0]} metadata.`));
    const found = handle.read((view) => discoverRationaleAccounts(view, [subject], [])).value;
    expect(found.matches.map((match) => match.eventId)).toEqual([relevant.planEventId]);
  }
);

it('publishes searchable accounts atomically and keeps older matching events reachable', async () => {
  const { handle, authority } = await knowledgeStore();
  const earlier = plan(
    'Remove the navigation return band while preserving independent tab stacks.'
  );
  await capturePlan(handle, earlier);
  let calls = 0;
  const counted = new Proxy(
    { ...handle },
    {
      get(target, property) {
        if (property !== 'read') return Reflect.get(target, property, target);
        return (callback: Parameters<ProjectDatabase['read']>[0]) =>
          target.read((view) =>
            callback(
              new Proxy(
                { ...view },
                {
                  get(inner, method) {
                    if (method !== 'get' && method !== 'all')
                      return Reflect.get(inner, method, inner);
                    return (...args: Parameters<ProjectReadView['all']>) => {
                      calls++;
                      return Reflect.apply(inner[method], inner, args);
                    };
                  },
                }
              )
            )
          );
      },
    }
  );
  const rationale = () =>
    readProjectRationale(counted, {
      candidates: [{ artifactId: earlier.artifactId, eventId: earlier.planEventId }],
      boundary: 'now',
      observation: handle.read(() => null).counters.writeSequence,
    }).value;
  const original = rationale();
  const originalCalls = calls;
  for (let n = 0; n < 1001; n++)
    await capturePlan(handle, plan(`Update dependency lockfile package ${n}`));
  calls = 0;
  expect(rationale().items.map((item) => item.account)).toEqual(
    original.items.map((item) => item.account)
  );
  expect(calls).toBe(originalCalls);
  const inspection = new Database(projectDatabasePath(authority), { readonly: true });
  const access = inspection
    .prepare(
      'EXPLAIN QUERY PLAN SELECT event_id, field_path FROM rationale_terms WHERE term=? ORDER BY event_id, field_path LIMIT ?'
    )
    .all('navigation', 256) as Array<{ detail: string }>;
  inspection.close();
  expect(access.some((row) => /SEARCH.*INDEX/.test(row.detail))).toBe(true);
  expect(access.some((row) => /SCAN/.test(row.detail))).toBe(false);
  const query = () =>
    handle.read((view) =>
      discoverRationaleAccounts(
        view,
        ['Preserve independent navigation tab stacks with a return band'],
        []
      )
    ).value;
  const found = query();
  expect(found.matches.map((match) => match.eventId)).toContain(earlier.planEventId);
  expect(found.diagnostics.postings_examined).toBeLessThan(32);
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  try {
    expect(
      reader.read((view) =>
        discoverRationaleAccounts(
          view,
          ['Preserve independent navigation tab stacks with a return band'],
          []
        )
      ).value
    ).toEqual(found);
  } finally {
    reader.close();
  }
}, 60_000);

it('does not repair missing or stale lookup data during a read', async () => {
  const { handle, authority } = await knowledgeStore();
  const source = plan('Preserve navigator owned history and independent tab stacks');
  await capturePlan(handle, source);
  const raw = new Database(projectDatabasePath(authority));
  try {
    raw.exec('DELETE FROM rationale_index_state');
    expect(handle.read(rationaleIndexStatus).value).toBe('unavailable');
    expect(raw.prepare('SELECT * FROM rationale_index_state').all()).toEqual([]);
    const direct = readProjectRationale(handle, {
      candidates: [{ artifactId: source.artifactId, eventId: source.planEventId }],
      boundary: 'now',
      observation: handle.read(() => null).counters.writeSequence,
    }).value;
    expect(direct.diagnostics.discovery.status).toBe('unavailable');
    expect(
      direct.items.some((item) => item.account.wording === source.steps[0]!.criteria[0]!.text)
    ).toBe(true);
    await rebuildProjectQueryMetadata({ authority, authorize() {} });
    expect(handle.read(rationaleIndexStatus).value).toBe('available');
    raw.exec('UPDATE rationale_index_state SET version=99');
    expect(handle.read(rationaleIndexStatus).value).toBe('stale');
    await rebuildProjectQueryMetadata({ authority, authorize() {} });
    raw.exec('DELETE FROM rationale_events');
    expect(handle.read(rationaleIndexStatus).value).toBe('stale');
    await rebuildProjectQueryMetadata({ authority, authorize() {} });
    expect(handle.read(rationaleIndexStatus).value).toBe('available');
  } finally {
    raw.close();
  }
});

it('rolls back history and lookup publication together when indexing fails', async () => {
  const { handle, authority } = await knowledgeStore();
  const raw = new Database(projectDatabasePath(authority));
  try {
    raw.exec(
      "CREATE TRIGGER refuse_rationale BEFORE INSERT ON rationale_terms BEGIN SELECT RAISE(ABORT, 'index failure'); END;"
    );
    const before = handle.read(() => null).counters;
    await expect(capturePlan(handle, plan('Keep offline writes durable'))).rejects.toBeDefined();
    expect(handle.read(() => null).counters).toEqual(before);
    expect(raw.prepare('SELECT * FROM artifacts').all()).toEqual([]);
    expect(raw.prepare('SELECT * FROM rationale_events').all()).toEqual([]);
  } finally {
    raw.close();
  }
});

it('bounds posting reads before loading accounts and never creates a semantic relationship', async () => {
  const { handle } = await knowledgeStore();
  for (let n = 0; n < 270; n++)
    await capturePlan(handle, plan(`Retain WAL durability snapshot ${n}`));
  const found = handle.read((view) =>
    discoverRationaleAccounts(view, ['Retain WAL durability snapshot'], [])
  ).value;
  expect(found.diagnostics.saturated_terms).toBeGreaterThan(0);
  expect(found.diagnostics.postings_examined).toBeLessThanOrEqual(4096);
  expect(found.matches).toHaveLength(32);
  expect(handle.read((view) => view.all('SELECT * FROM record_relationships')).value).toEqual([]);
}, 30_000);
