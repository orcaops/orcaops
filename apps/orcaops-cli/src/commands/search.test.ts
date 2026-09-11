import { expect, it } from 'vitest';

import { validateCanonicalSearch } from '../lib/history-search.js';
it('accepts explicit project collection filters and offset pagination', () => {
  expect(
    validateCanonicalSearch('project history', {
      scope: 'all-projects',
      touching: 'src/**',
      origin: 'captured',
      offset: 2,
      limit: 3,
    })
  ).toMatchObject({
    selector: { scope: 'all-projects' },
    filters: { touching: 'src/**', origin: 'captured' },
    offset: 2,
    limit: 3,
  });
});
