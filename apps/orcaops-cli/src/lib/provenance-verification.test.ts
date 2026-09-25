import { expect, it } from 'vitest';

import type { Explanation } from './provenance-explanations.js';
import { verificationSummary } from './provenance-verification.js';

it('keeps unapproved status and absent evidence in a reported summary', () => {
  const item: Explanation = {
    id: 'check',
    kind: 'context',
    form: 'unapproved_interpretation',
    authority: 'unapproved_interpretation',
    account: { wording: 'TypeScript passed.', reason: null },
    source: {
      artifact_id: 'artifact',
      event_id: 'event',
      field_path: 'verification.0.output_digest',
    },
    relevance: { basis: 'candidate_event', target: { kind: 'candidate_context', terms: [] } },
    temporal: 'historical_body',
    reference: 'check-reference',
    verification: true,
    context: [
      {
        id: 'claim:check',
        kind: 'claim',
        placement: 'background',
        accounts: [],
        sources: [],
        reference: 'context-reference',
        unresolved: [{ about: 'evidence', reason: 'evidence_not_attached', record_ids: [] }],
      },
    ],
  };
  expect(
    verificationSummary([item, { ...item, id: 'another-check', reference: 'another-reference' }])
  ).toMatchObject({
    status: 'reported',
    reported_records: 2,
    groups: [
      { authority: 'unapproved_interpretation', evidence: 'not_attached', reported_records: 2 },
    ],
    omitted_status_records: 0,
    omitted_references: 0,
  });
  const many = verificationSummary(
    Array.from({ length: 9 }, (_, i) => ({
      ...item,
      reference: `reference-${i}`,
      authority: `status-${i}`,
    }))
  );
  expect(many.groups).toHaveLength(4);
  expect(many.omitted_status_records).toBe(5);
  expect(many.references).toHaveLength(3);
  expect(many.omitted_references).toBe(7);
  const planned = { ...item, verification: undefined, planned_verification: true as const };
  expect(verificationSummary([], [planned])).toMatchObject({
    status: 'planned',
    reported_records: 0,
    groups: [],
    planned: { status: 'planned', records: 1 },
  });
  expect(verificationSummary([item], [planned])).toMatchObject({
    status: 'reported',
    reported_records: 1,
    planned: { status: 'planned', records: 1 },
  });
});
