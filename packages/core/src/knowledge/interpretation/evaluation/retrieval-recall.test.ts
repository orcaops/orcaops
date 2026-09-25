// What bounded retrieval finds for the fixed evaluation set, in a real project database, with no
// model anywhere. The asserted values are the regression baseline and change only with a
// deliberate remeasurement.
import { afterEach, expect, it } from 'vitest';

import {
  type RelatedKnowledgeRetrieval,
  retrieveRelatedKnowledge,
} from '@orcaops/storage/history/database';

import { INTERPRETATION_EVALUATION_SET } from './cases.js';
import { ARTIFACT, existingKnowledge } from './knowledge.js';
import {
  type CorpusCase,
  type RetrievalCorpus,
  retrievalCorpus,
} from './retrieval-corpus.test-support.js';
import { manifestFor } from '../fixture.test-support.js';
import { buildInterpretationManifest } from '../manifest.js';
import { manifestRelatedKnowledge, relatedKnowledgeBounds } from '../retrieval.js';
import { INTERPRETATION_DETECTOR } from '../versions.js';

/**
 * The misses are named one by one, so a change in what retrieval finds reads as a changed line
 * rather than as a moved number.
 */
const RECORDED = {
  cases_expecting_related: 15,
  expected_pairs: 17,
  found_pairs: 13,
  entries_carried: 88,
  unexpected_entries: 75,
  missed: [
    'a source with no plan event behind it → requirement-offline',
    'one passage two statements say they refine differently → decision-storage',
    'one passage two statements say they refine differently → requirement-offline',
    'the same sentence twice, the second copy linked to a decision → decision-storage',
  ],
  limits: ['wording_match_bounded'],
};

const BOUNDS = relatedKnowledgeBounds({ max_input_bytes: 40_000 });

const opened: RetrievalCorpus[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((corpus) => corpus.close()));
});

async function corpus(): Promise<RetrievalCorpus> {
  const built = await retrievalCorpus(INTERPRETATION_EVALUATION_SET);
  opened.push(built);
  return built;
}

const retrieveFor = (built: RetrievalCorpus, scenario: CorpusCase): RelatedKnowledgeRetrieval =>
  built.handle.read((view) =>
    retrieveRelatedKnowledge(view, {
      source: {
        artifactId: scenario.artifactId,
        eventId: scenario.eventId,
        planEventId: scenario.eventId,
        text: scenario.sourceText,
      },
      projectId: built.projectId,
      scope: scenario.source_scope ?? ARTIFACT,
      boundary: built.boundary,
      bounds: BOUNDS,
    })
  ).value;

interface CaseMeasurement {
  name: string;
  expected: readonly string[];
  found: readonly string[];
  unexpected: readonly string[];
  limits: readonly string[];
}

function measure(built: RetrievalCorpus): CaseMeasurement[] {
  return built.cases.map((scenario) => {
    const retrieval = retrieveFor(built, scenario);
    const carried = retrieval.entries.map((entry) => entry.target.entity_id);
    return {
      name: scenario.name,
      expected: scenario.expected,
      found: scenario.expected.filter((entity) => carried.includes(entity)),
      unexpected: carried.filter((entity) => !scenario.expected.includes(entity)),
      limits: retrieval.omissions.map((omission) => omission.kind),
    };
  });
}

it('finds the related revisions the set expects, as the recorded measurement says', async () => {
  const built = await corpus();
  const measured = measure(built);
  const withRelated = measured.filter((entry) => entry.expected.length > 0);
  expect({
    cases_expecting_related: withRelated.length,
    expected_pairs: withRelated.reduce((total, entry) => total + entry.expected.length, 0),
    found_pairs: withRelated.reduce((total, entry) => total + entry.found.length, 0),
    entries_carried: measured.reduce(
      (total, entry) => total + entry.found.length + entry.unexpected.length,
      0
    ),
    unexpected_entries: measured.reduce((total, entry) => total + entry.unexpected.length, 0),
    missed: withRelated
      .flatMap((entry) =>
        entry.expected
          .filter((entity) => !entry.found.includes(entity))
          .map((entity) => `${entry.name} → ${entity}`)
      )
      .sort(),
    limits: [...new Set(measured.flatMap((entry) => entry.limits))].sort(),
  }).toEqual(RECORDED);
});

it('carries the wording of every revision it found, in a manifest with no gap in its coverage', async () => {
  const built = await corpus();
  const found = built.cases.filter((scenario) => scenario.expected.length > 0);
  for (const scenario of found) {
    const retrieval = retrieveFor(built, scenario);
    const related = manifestRelatedKnowledge(retrieval);
    const manifest = buildInterpretationManifest({
      schedule_id: scenario.manifest.schedule_id,
      unit_id: scenario.manifest.unit_id,
      project_id: scenario.manifest.project_id,
      source_event_id: scenario.manifest.source_event_id,
      task_context: scenario.manifest.task_context,
      sources: scenario.manifest.sources.map((source) => ({
        source_id: source.source_id,
        text:
          scenario.manifest.segments.find((segment) => segment.source_ref === source.ref)?.text ??
          '',
      })),
      segments: scenario.manifest.segments.map(
        ({ ref: _ref, source_ref: _sourceRef, text: _text, ...segment }) => segment
      ),
      attributed_to: { kind: 'detector', detector: INTERPRETATION_DETECTOR },
      knowledge_boundary: retrieval.boundary,
      related_knowledge: related.related_knowledge,
      coverage_limits: related.coverage_limits,
    });
    // Every entry reaches the proposal as a ref, and every ref carries wording read from the store.
    expect(manifest.related_knowledge).toHaveLength(retrieval.entries.length);
    for (const revision of manifest.revisions) expect(revision.statement.length).toBeGreaterThan(0);
    expect(manifest.coverage_limits.some((limit) => limit.kind === 'retrieval_limit')).toBe(true);
    expect(
      manifest.coverage_limits.some((limit) =>
        limit.detail.includes('bounded retrieval is not attached')
      )
    ).toBe(false);
  }
});

it('retrieves a paraphrase target through shared wording and reports low-overlap limits honestly', async () => {
  const target = existingKnowledge({
    kind: 'requirement',
    entity_id: 'requirement-decimal-display',
    revision_id: 'requirement-decimal-display-r1',
    text: 'Display measurements to two decimal places.',
  });
  const shared = manifestFor({
    text: 'Show measurements to two digits after the decimal point.',
    related: [target],
  });
  const lowOverlap = manifestFor({
    text: 'Render numeric values with a pair of digits following the radix mark.',
    related: [target],
  });
  const built = await retrievalCorpus([
    {
      name: 'shared wording paraphrase',
      source_text: 'Show measurements to two digits after the decimal point.',
      manifest: shared,
      source_scope: ARTIFACT,
      expected: { published: [], reuse: [], restated: [], never_published: [] },
    },
    {
      name: 'low overlap paraphrase',
      source_text: 'Render numeric values with a pair of digits following the radix mark.',
      manifest: lowOverlap,
      source_scope: ARTIFACT,
      expected: { published: [], reuse: [], restated: [], never_published: [] },
    },
  ]);
  opened.push(built);

  const sharedResult = retrieveFor(built, built.cases[0]);
  expect(sharedResult.entries.map((entry) => entry.target.entity_id)).toContain(
    'requirement-decimal-display'
  );

  const lowOverlapResult = retrieveFor(built, built.cases[1]);
  expect(lowOverlapResult.entries.map((entry) => entry.target.entity_id)).not.toContain(
    'requirement-decimal-display'
  );
  expect(lowOverlapResult.omissions).toContainEqual(
    expect.objectContaining({ kind: 'wording_match_bounded' })
  );
});

it('reaches a record only through the search, never through the case’s own artifact', async () => {
  const built = await corpus();
  for (const scenario of built.cases)
    for (const entry of retrieveFor(built, scenario).entries)
      expect(entry.routes).toEqual(['search_hit']);
});
