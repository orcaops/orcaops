import { afterEach, expect, it } from 'vitest';

import { type ProjectReadView } from './connection.js';
import {
  type RelatedKnowledgeBounds,
  type RelatedKnowledgeRetrieval,
  relatedKnowledgeSearchTerms,
  retrieveRelatedKnowledge,
} from './knowledge-retrieval.js';
import {
  findingRevision,
  importClaimWithUnreadableApplicability,
} from '../../../tests/knowledge-authority-store.js';
import {
  laterActsOfEveryKind,
  OTHER_ARTIFACT_RULE,
  restateThroughSource,
  restrictedFieldSource,
  type RetrievalStore,
  retrievalStore,
  SHARED_TERM,
  SOURCE_TEXT,
  UNREACHED_RULE,
} from '../../../tests/knowledge-retrieval-store.js';
import {
  captureCheckpoint,
  captureFieldSource,
  capturePlan,
  counters,
  discardKnowledgeStores,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

const BOUNDS: RelatedKnowledgeBounds = {
  maxIdentities: 24,
  maxStatementBytes: 16_384,
  maxSearchTerms: 12,
  maxSearchHits: 50,
  maxSourcesFollowed: 64,
};

function retrieve(
  store: RetrievalStore,
  change: { boundary?: number; bounds?: Partial<RelatedKnowledgeBounds>; text?: string } = {}
): RelatedKnowledgeRetrieval {
  return store.handle.read((view: ProjectReadView) =>
    retrieveRelatedKnowledge(view, {
      source: {
        artifactId: store.plan.artifactId,
        eventId: store.sourceEventId,
        planEventId: store.plan.planEventId,
        text: change.text ?? SOURCE_TEXT,
      },
      projectId: store.authority.projectId,
      scope: store.artifact,
      boundary: change.boundary ?? store.boundary,
      bounds: { ...BOUNDS, ...change.bounds },
    })
  ).value;
}

const identities = (retrieval: RelatedKnowledgeRetrieval) =>
  retrieval.entries.map((entry) => entry.target.entity_id);

const routeOf = (retrieval: RelatedKnowledgeRetrieval, entityId: string) =>
  retrieval.entries.find((entry) => entry.target.entity_id === entityId)?.routes;

const omission = (retrieval: RelatedKnowledgeRetrieval, kind: string) =>
  retrieval.omissions.find((entry) => entry.kind === kind);

it('draws its search terms from the source, longest first, without the stop list', () => {
  expect(relatedKnowledgeSearchTerms('The queue drains after a restart.', 10)).toEqual([
    'restart',
    'drains',
    'queue',
  ]);
  expect(relatedKnowledgeSearchTerms('The queue drains after a restart.', 2)).toEqual([
    'restart',
    'drains',
  ]);
  expect(relatedKnowledgeSearchTerms('a to the of', 10)).toEqual([]);
});

it('finds the exact references the source makes, each by the way it was reached', async () => {
  const store = await retrievalStore();
  const retrieval = retrieve(store);
  expect(routeOf(retrieval, store.planCriterion.entity_id)).toEqual(['task_use']);
  expect(routeOf(retrieval, store.offline.entity_id)).toEqual(['source_reference']);
  // One identity, however many ways reach it: the decision is cited by another event of this
  // artifact and that event's captured plan also matches the source's words.
  expect(routeOf(retrieval, store.storage.entity_id)).toEqual(['artifact_event', 'search_hit']);
  expect(identities(retrieval)).toHaveLength(new Set(identities(retrieval)).size);
  expect(
    retrieval.entries
      .flatMap((entry) => entry.statements)
      .every((statement) => statement.intended_scope === undefined)
  ).toBe(true);
});

it('finds a record of another artifact through the search over structured captures', async () => {
  const store = await retrievalStore();
  const retrieval = retrieve(store);
  expect(routeOf(retrieval, store.otherArtifact.entity_id)).toEqual(['search_hit']);
  expect(retrieval.counts.searchTerms).toBeGreaterThan(0);
  expect(retrieval.counts.searchHits).toBeGreaterThan(0);

  // Without the shared term in the source, no query reaches the other artifact at all.
  const unrelated = retrieve(store, { text: 'Checkpoint summary\n\nThe queue drains.\n' });
  expect(identities(unrelated)).not.toContain(store.otherArtifact.entity_id);
  expect(SOURCE_TEXT).toContain(SHARED_TERM);
});

it('carries and budgets the wording and reasons of every revision each answer names', async () => {
  const store = await retrievalStore();
  const entry = retrieve(store).entries.find(
    (candidate) => candidate.target.entity_id === store.offline.entity_id
  )!;
  expect(entry.statements.map((statement) => statement.text)).toEqual([
    'Inspection notes survive a device restart without being re-entered.',
  ]);
  expect(entry.statements[0]!.rationale).toEqual(expect.any(String));
  expect(entry.statementBytes).toBe(
    entry.statements.reduce(
      (total, statement) =>
        total + Buffer.byteLength(statement.text) + Buffer.byteLength(statement.rationale ?? ''),
      0
    )
  );
});

it('leaves out the wording of a revision whose record states nothing, and invents none', async () => {
  const store = await retrievalStore();
  const entry = retrieve(store).entries.find(
    (candidate) => candidate.target.entity_id === store.offline.entity_id
  )!;
  expect(entry.resolved.revisions.map((standing) => standing.revision.revision_id)).toContain(
    store.offlineWithoutStatement
  );
  expect(entry.statements.map((statement) => statement.revision.revision_id)).not.toContain(
    store.offlineWithoutStatement
  );
  expect(entry.statements).toHaveLength(1);
});

it('says wording match was bounded to the identities the other ways found', async () => {
  const store = await retrievalStore();
  const retrieval = retrieve(store);
  expect(omission(retrieval, 'wording_match_bounded')?.detail).toContain(
    'no index over revision statements'
  );
});

it('reads at the boundary it is given, and a later record is absent and counted', async () => {
  const store = await retrievalStore();
  const atBoundary = retrieve(store);
  expect(identities(atBoundary)).not.toContain(store.late.entity_id);
  expect(atBoundary.coverage.boundary).toBe(store.boundary);
  expect(omission(atBoundary, 'later_than_boundary')?.detail).toContain(
    `after write sequence ${store.boundary}`
  );

  const now = retrieve(store, { boundary: store.boundary + 2 });
  expect(identities(now)).toContain(store.late.entity_id);
  expect(omission(now, 'later_than_boundary')).toBeUndefined();
});

it('omits a record only an access-restricted source cites, and names the restriction', async () => {
  const store = await retrievalStore();
  const retrieval = retrieve(store);
  expect(identities(retrieval)).not.toContain(store.confidential.entity_id);
  expect(omission(retrieval, 'access_restricted')?.detail).toContain(store.restriction);
});

it('retrieves a published claim at its boundary without adopting it', async () => {
  const store = await retrievalStore();
  const sourceId = await captureFieldSource(
    store.handle,
    { artifactId: store.plan.artifactId, planEventId: store.sourceEventId },
    'summary',
    2
  );
  const claim = await findingRevision({ handle: store.handle, sourceId });
  const published = counters(store.handle).writeSequence;

  const historical = retrieve(store);
  expect(identities(historical)).not.toContain(claim.entity_id);
  expect(omission(historical, 'later_than_boundary')).toBeDefined();

  const entry = retrieve(store, { boundary: published }).entries.find(
    (candidate) => candidate.target.entity_id === claim.entity_id
  );
  expect(entry).toMatchObject({
    target: { kind: 'claim', entity_id: claim.entity_id },
    routes: ['source_reference'],
    statements: [{ revision: claim, text: expect.any(String) }],
    resolved: {
      governing_state: { selection_ids: [], correction_action_ids: [] },
      revisions: [
        expect.objectContaining({
          revision: claim,
          standing: 'unadopted',
          designation: null,
          stood_by: [],
        }),
      ],
    },
  });
});

it('does not retrieve a claim whose only source is access restricted', async () => {
  const store = await retrievalStore();
  const restriction = 'claim-private';
  const sourceId = await restrictedFieldSource(
    store.handle,
    store.plan.artifactId,
    store.sourceEventId,
    restriction,
    2
  );
  const claim = await findingRevision({ handle: store.handle, sourceId });
  const retrieval = retrieve(store, { boundary: counters(store.handle).writeSequence });
  expect(identities(retrieval)).not.toContain(claim.entity_id);
  expect(omission(retrieval, 'access_restricted')?.detail).toContain(restriction);
});

it('reports a cited claim with unreadable applicability without crashing retrieval', async () => {
  const store = await retrievalStore();
  const sourceId = await captureFieldSource(
    store.handle,
    { artifactId: store.plan.artifactId, planEventId: store.sourceEventId },
    'summary',
    3
  );
  const claim = await importClaimWithUnreadableApplicability({
    handle: store.handle,
    sourceId,
  });
  const retrieval = retrieve(store, { boundary: counters(store.handle).writeSequence });
  expect(identities(retrieval)).not.toContain(claim.entity_id);
  expect(retrieval.coverage.unresolved).toContainEqual({
    about: 'revision',
    record_ids: [claim.revision_id],
    reason: 'revision_not_supplied',
  });
});

it('leaves an identity out whole when the count bound is reached, and says how many', async () => {
  const store = await retrievalStore();
  const whole = retrieve(store);
  const bounded = retrieve(store, { bounds: { maxIdentities: 2 } });
  expect(bounded.entries).toHaveLength(2);
  expect(identities(bounded)).toEqual(identities(whole).slice(0, 2));
  expect(omission(bounded, 'identity_count')?.detail).toContain(
    `${whole.entries.length - 2} related identit`
  );
  for (const entry of bounded.entries)
    expect(entry.statements).toHaveLength(
      whole.entries.find((candidate) => candidate.target.entity_id === entry.target.entity_id)!
        .statements.length
    );
});

it('leaves an identity out whole when its statements do not fit the byte bound', async () => {
  const store = await retrievalStore();
  const whole = retrieve(store);
  const first = whole.entries[0]!;
  const bounded = retrieve(store, { bounds: { maxStatementBytes: first.statementBytes } });
  expect(identities(bounded)).toEqual([first.target.entity_id]);
  expect(bounded.entries[0]!.statements).toEqual(first.statements);
  expect(omission(bounded, 'statement_bytes')?.detail).toContain('left out whole');
});

/** The answer apart from what it says about records the boundary held back, which later acts grow. */
const answered = (retrieval: RelatedKnowledgeRetrieval) => ({
  ...retrieval,
  coverage: { ...retrieval.coverage, later: [] },
  entries: retrieval.entries.map((entry) => ({
    ...entry,
    resolved: { ...entry.resolved, later_annotations: [] },
  })),
  omissions: retrieval.omissions.filter((entry) => entry.kind !== 'later_than_boundary'),
});

const laterCount = (retrieval: RelatedKnowledgeRetrieval) =>
  Number(/^\d+/u.exec(omission(retrieval, 'later_than_boundary')?.detail ?? '0')?.[0] ?? '0');

it('answers a boundary the same after later acts of every kind it can publish', async () => {
  const store = await retrievalStore();
  const before = retrieve(store);
  await laterActsOfEveryKind(store);
  const after = retrieve(store);
  expect(answered(after)).toEqual(answered(before));
  expect(laterCount(after)).toBeGreaterThan(laterCount(before));
});

it('does not displace the one identity an earlier answer carried', async () => {
  const store = await retrievalStore();
  const bounds = { maxIdentities: 1 };
  const before = retrieve(store, { bounds });
  expect(identities(before)).toHaveLength(1);
  await laterActsOfEveryKind(store);
  expect(identities(retrieve(store, { bounds }))).toEqual(identities(before));
});

it('does not carry a restriction from a source retained after the boundary', async () => {
  const store = await retrievalStore();
  const before = retrieve(store);
  await restrictedFieldSource(
    store.handle,
    store.plan.artifactId,
    store.sourceEventId,
    'embargoed',
    1
  );
  const after = retrieve(store);
  expect(omission(after, 'access_restricted')?.detail).toBe(
    omission(before, 'access_restricted')?.detail
  );
  expect(omission(after, 'access_restricted')?.detail).not.toContain('embargoed');
});

it('does not reach an identity a restatement published after the boundary points at', async () => {
  const store = await retrievalStore();
  expect(identities(retrieve(store))).not.toContain(store.unreached.entity_id);
  // The passage is a source this read already follows, so only the restatement's own row is later.
  await restateThroughSource(store, store.unreachedSourceId, store.unreached, UNREACHED_RULE);
  expect(identities(retrieve(store))).not.toContain(store.unreached.entity_id);
  expect(identities(retrieve(store, { boundary: counters(store.handle).writeSequence }))).toContain(
    store.unreached.entity_id
  );
});

it('counts no search hit for a capture published after the boundary', async () => {
  const store = await retrievalStore();
  const before = retrieve(store);
  await capturePlan(store.handle, {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: OTHER_ARTIFACT_RULE }] }],
    task: `Report the ${SHARED_TERM} batch`,
  });
  const after = retrieve(store);
  expect(after.counts.searchHits).toBe(before.counts.searchHits);
  expect(laterCount(after)).toBeGreaterThan(laterCount(before));
});

it('follows none of the artifact events appended after the boundary', async () => {
  const store = await retrievalStore();
  const before = laterCount(retrieve(store));
  await captureCheckpoint(store.handle, store.plan, store.worktreeId, 2);
  expect(laterCount(retrieve(store))).toBe(before + 1);
});

it('refuses a boundary this history has not published', async () => {
  const store = await retrievalStore();
  expect(() => retrieve(store, { boundary: store.boundary + 10_000 })).toThrow(
    /has not published/u
  );
});

it('resolves each candidate identity once, for the manifest and for its lineage alike', async () => {
  const store = await retrievalStore();
  const resolved: string[] = [];

  const retrieval = store.handle.read((view: ProjectReadView) =>
    retrieveRelatedKnowledge(
      {
        all: (sql, ...parameters) => {
          if (sql.includes('FROM adoptions r')) resolved.push(JSON.stringify(parameters));
          return view.all(sql, ...parameters);
        },
        get: (sql, ...parameters) => view.get(sql, ...parameters),
      },
      {
        source: {
          artifactId: store.plan.artifactId,
          eventId: store.sourceEventId,
          planEventId: store.plan.planEventId,
          text: SOURCE_TEXT,
        },
        projectId: store.authority.projectId,
        scope: store.artifact,
        boundary: store.boundary,
        bounds: BOUNDS,
      }
    )
  ).value;

  // Every candidate the routes found is resolved — the routes find nothing past the boundary, so
  // each candidate reaches `entries` unless a bound cuts it — and each of them exactly once, for
  // the answer the manifest carries and for the lineage the resolver was not given alike.
  expect(resolved.length).toBeGreaterThanOrEqual(retrieval.entries.length);
  expect(resolved.length).toBeGreaterThan(0);
  expect(new Set(resolved).size).toBe(resolved.length);
});
