// Standing-aware search over the retrieval-baseline corpus: what a hit found through wording the
// history has since rewritten says about the wording that stands now.
import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WORKER_LOG_FILE } from '../../src/knowledge-worker/start.js';
import type { readCanonicalSearch } from '../../src/lib/history-search.js';
import { retrievalCases } from '../fixtures/retrieval-corpus/cases.js';
import { buildRetrievalCorpus, type RetrievalCorpus } from '../support/retrieval-corpus.js';
import {
  publishCorpusKnowledge,
  type PublishedCorpusKnowledge,
} from '../support/retrieval-knowledge.js';

type SearchEnvelope = Awaited<ReturnType<typeof readCanonicalSearch>>;

let corpus: RetrievalCorpus;

/** A phrase both the plan and its revision carry, so one query returns both of their events. */
const SHARED_TASK = 'Throttle upload traffic from each device';

async function search(query: string, extra: string[] = []): Promise<SearchEnvelope> {
  const raw = await corpus.agent.runRaw([
    'search',
    query,
    '--scope',
    'project',
    '--origin',
    'captured',
    ...extra,
    '--json',
  ]);
  if (raw.exitCode !== 0) throw new Error(`search "${query}" failed: ${raw.stdout}${raw.stderr}`);
  return JSON.parse(raw.stdout) as SearchEnvelope;
}

const recordsOf = (envelope: SearchEnvelope, key: string) =>
  envelope.results.flatMap((row) =>
    (row.knowledge?.records ?? []).filter((record) => record.group === key)
  );

const groupOf = (envelope: SearchEnvelope, key: string) =>
  envelope.knowledge.groups.find((group) => group.key === key);

const stated = (envelope: SearchEnvelope, key: string) => {
  const group = groupOf(envelope, key);
  return (group?.revisions ?? [])
    .filter((revision) => group!.governing.includes(revision.revision_id))
    .map((revision) => revision.statement);
};

beforeAll(async () => {
  corpus = await buildRetrievalCorpus();
}, 240_000);

afterAll(async () => {
  await corpus?.cleanup();
});

describe('search over captures nothing has interpreted', { timeout: 120_000 }, () => {
  it('returns raw hits and claims no completeness for what processing has covered', async () => {
    const envelope = await search('at most 100 upload requests per minute per device');

    expect(envelope.schema_version).toBe(4);
    expect(envelope.results.length).toBeGreaterThan(0);
    expect(envelope.results.every((row) => row.knowledge === null)).toBe(true);
    expect(envelope.knowledge.groups).toEqual([]);
    expect(envelope.knowledge.coverage.processing).toMatchObject({
      enabled: false,
      claim: 'not_processed',
      completed_through: null,
    });
    expect(envelope.knowledge.coverage.processing?.statement).toContain('claims no completeness');
  });

  it('writes nothing to the project it reads and starts no worker', async () => {
    const before = await corpus.openDatabase();
    const sequenceBefore = before.read(() => null).counters.writeSequence;
    const databaseDirectory = path.dirname(before.databasePath);
    before.close();

    await search(SHARED_TASK);

    const after = await corpus.openDatabase();
    try {
      expect(after.read(() => null).counters.writeSequence).toBe(sequenceBefore);
    } finally {
      after.close();
    }
    await expect(access(path.join(databaseDirectory, WORKER_LOG_FILE))).rejects.toThrow();
  });
});

describe('search over captures with continuing records published', { timeout: 120_000 }, () => {
  let published: PublishedCorpusKnowledge;

  beforeAll(async () => {
    published = await publishCorpusKnowledge(corpus);
  }, 120_000);

  it('answers obsolete wording with the replacing revision and the standing it has now', async () => {
    const rewritten = published.rules.find((rule) => rule.name === 'upload request ceiling')!;

    const envelope = await search(rewritten.supersededWording);

    const records = recordsOf(envelope, rewritten.key);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]).toMatchObject({ wording: 'superseded', standing: 'not_standing' });
    expect(stated(envelope, rewritten.key)).toEqual([rewritten.standingWording]);
    expect(groupOf(envelope, rewritten.key)!.placement).toBe('applicable');
    expect(groupOf(envelope, rewritten.key)!.replaced).toContain(records[0]!.revision_id);
  });

  it('answers the wording of a removed requirement by saying it was withdrawn', async () => {
    const removed = published.rules.find((rule) => rule.name === 'throttling banner')!;

    const envelope = await search(removed.supersededWording);

    const records = recordsOf(envelope, removed.key);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]!.wording).toBe('withdrawn');
    expect(stated(envelope, removed.key)).toEqual([]);
    expect(groupOf(envelope, removed.key)!.corrections.map((entry) => entry.effect)).toContain(
      'withdrawn'
    );
  });

  it('gives several hits of one record a single entry', async () => {
    const envelope = await search(SHARED_TASK);

    const hits = envelope.results.filter((row) =>
      published.decision.events.includes(row.source_event_id ?? '')
    );
    expect(hits.length).toBe(2);
    expect(
      hits.every((row) =>
        (row.knowledge?.records ?? []).some((record) => record.group === published.decision.key)
      )
    ).toBe(true);
    expect(
      envelope.knowledge.groups.filter((group) => group.key === published.decision.key)
    ).toHaveLength(1);
    expect(stated(envelope, published.decision.key)).toEqual([published.decision.wordings[1]]);
  });

  it('reports an entry the budget cannot carry whole instead of cutting it down', async () => {
    const rewritten = published.rules.find((rule) => rule.name === 'upload request ceiling')!;

    const envelope = await search(rewritten.supersededWording, ['--knowledge-bytes', '1']);

    expect(envelope.knowledge.groups).toEqual([]);
    expect(envelope.knowledge.budget).toMatchObject({ bytes: 1, spent: 0 });
    expect(envelope.knowledge.budget.entries_omitted).toBeGreaterThan(0);
    const incomplete = envelope.results.flatMap((row) => row.knowledge?.incomplete ?? []);
    expect(incomplete.map((entry) => entry.identity)).toContain(rewritten.key);
    expect(incomplete[0]!.reason).toContain('--knowledge-bytes');
    // Nothing of the entry leaks out in pieces: no hit claims a standing it could not carry.
    expect(envelope.results.flatMap((row) => row.knowledge?.records ?? [])).toEqual([]);
  });

  it('leaves a hit no continuing record cites as a first-class result', async () => {
    const envelope = await search('SQLite');

    expect(envelope.results.length).toBeGreaterThan(0);
    expect(envelope.results.some((row) => row.knowledge === null)).toBe(true);
  });

  it('carries standing on the superseded hits the deterministic baseline left bare', async () => {
    const successors = new Map(
      Object.values(corpus.artifacts).flatMap((artifact) =>
        artifact.events.flatMap((event) =>
          event.supersededBy === null ? [] : [[event.eventId, event.supersededBy] as const]
        )
      )
    );
    let bare = 0;
    let carrying = 0;
    for (const query of retrievalCases.flatMap((retrievalCase) => retrievalCase.queries)) {
      const envelope = await search(query);
      const returned = new Set(
        envelope.results
          .filter((row) => row.source_kind !== 'digest')
          .map((row) => row.source_event_id)
      );
      const orphans = envelope.results.filter((row) => {
        const successor =
          row.source_event_id === null ? undefined : successors.get(row.source_event_id);
        return successor !== undefined && !returned.has(successor);
      });
      if (orphans.length === 0) continue;
      bare += 1;
      if (orphans.some((row) => (row.knowledge?.records.length ?? 0) > 0)) carrying += 1;
    }
    // The baseline pins seven such queries; the corpus's own criterion lineage and plan decisions
    // are what a deterministic reader can carry standing for, and this is how many of them it does.
    expect(bare).toBe(7);
    expect(carrying).toBe(5);
  });
});
