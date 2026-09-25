import { expect, it } from 'vitest';

import type { Explanation } from './provenance-explanations.js';
import { omittedExplanation } from './provenance-omissions.js';

it('preserves distinct correction states attached to different knowledge identities', () => {
  const item: Explanation = {
    id: 'account',
    kind: 'decision',
    form: 'recorded_capture',
    account: { wording: 'Retain the design.', reason: 'Complete reason.' },
    source: { artifact_id: 'artifact', event_id: 'event', field_path: 'decisions.0.decision' },
    relevance: { basis: 'candidate_event', target: { kind: 'candidate_context', terms: [] } },
    authority: 'recorded_account',
    temporal: 'historical_body',
    reference: 'account-reference',
    context: ['claim:one', 'claim:two'].map((id) => ({
      id,
      kind: 'claim',
      placement: 'background',
      accounts: [],
      reference: id,
    })),
  };
  const records = item.context.map((entry, index) => ({
    key: entry.id,
    reference: entry.id,
    discovery: [],
    relationships: [],
    omitted_corrections: 0,
    corrections: [
      {
        action_id: 'correction',
        status: index ? 'later_annotation' : 'proposed',
        kind: null,
        wording: null,
        source_id: null,
        reference: null,
        unavailable: true,
      },
    ],
  }));
  const omitted = omittedExplanation(item, { records });
  expect(omitted.corrections).toEqual([
    expect.objectContaining({ context_id: 'claim:one', status: 'proposed', unavailable: true }),
    expect.objectContaining({
      context_id: 'claim:two',
      status: 'later_annotation',
      unavailable: true,
    }),
  ]);
  expect(omitted).not.toHaveProperty('account');
});
