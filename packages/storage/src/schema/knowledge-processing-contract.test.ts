import { expect, it } from 'vitest';

import { InterpretationQualitySchema } from './knowledge-processing-contract.js';

const counts = { statements: 1, corrections: 0, links: 0, uncertainties: 0 };

it('reads saved interpretation quality without alternative counters', () => {
  expect(
    InterpretationQualitySchema.safeParse({
      schema: 'orcaops.interpretation_quality/v1',
      outcome: 'accepted',
      proposed: counts,
      accepted: counts,
      held_back: { ...counts, statements: 0 },
      rejected: { ...counts, statements: 0 },
      diagnostics: [],
      diagnostics_total: 0,
      diagnostics_omitted: 0,
    }).success
  ).toBe(true);
});

it('includes alternatives when deriving a partial outcome', () => {
  expect(
    InterpretationQualitySchema.safeParse({
      schema: 'orcaops.interpretation_quality/v1',
      outcome: 'partial',
      proposed: { ...counts, alternatives: 1 },
      accepted: { ...counts, alternatives: 0 },
      held_back: { ...counts, statements: 0, alternatives: 0 },
      rejected: { ...counts, statements: 0, alternatives: 1 },
      diagnostics: [],
      diagnostics_total: 0,
      diagnostics_omitted: 0,
    }).success
  ).toBe(true);
});
