import { expect, it } from 'vitest';

import { retainedRationale } from './knowledge-wording.js';

it('distinguishes an explicitly unknown decision reason from absent or unreadable information', () => {
  expect(retainedRationale('{"rationale":null}', 'decision')).toBeNull();
  expect(retainedRationale('{"rationale":"Works offline."}', 'decision')).toBe('Works offline.');
  for (const payload of ['{}', 'null', '[]', 'broken', '{"rationale":12}', '{"rationale":""}'])
    expect(retainedRationale(payload, 'decision')).toBeUndefined();
  expect(retainedRationale('{"rationale":null}', 'claim')).toBeUndefined();
});
