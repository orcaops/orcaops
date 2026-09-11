import { expect, it } from 'vitest';

import { DoneCriterionTextUnresolvableError } from './errors.js';

it('preserves history when an open-time plan revision is missing', () => {
  const error = new DoneCriterionTextUnresolvableError(
    '01HXART0000000000000000000',
    2,
    null,
    'open-revision-not-in-cache'
  );
  expect(error.message).toContain('Preserve the registered database and its companion files');
  expect(error.message).toContain('orcaops doctor');
  expect(error.message).toContain('rebuild` cannot recreate it');
  expect(error.message).not.toContain('retry the push');
});
