import { describe, expect, it } from 'vitest';

import { validateDatabaseUsage } from '../lib/database-usage.js';

describe('usage selection', () => {
  it('uses collection scope unless an exact artifact is requested', () => {
    expect(validateDatabaseUsage({}).profile).toBe('collection');
    expect(
      validateDatabaseUsage({
        artifact: 'retained',
        project: '01a070b8-9dc3-7b10-96b0-70136bd7fa6a',
      })
    ).toMatchObject({
      profile: 'exact',
      selector: { projectId: '01a070b8-9dc3-7b10-96b0-70136bd7fa6a' },
    });
  });
  it.each(['scope', 'branch', 'origin', 'state', 'touching'])(
    'rejects an exact artifact combined with %s before context resolution',
    (field) => {
      expect(() => validateDatabaseUsage({ artifact: 'retained', [field]: 'value' })).toThrow(
        expect.objectContaining({ code: 'SCOPE_CONFLICT' })
      );
    }
  );
  it.each([
    { since: '2026-09-01' },
    { allProjects: true },
    { artifact: '' },
    { touching: '../private' },
    { json: 'yes' },
    { state: 'unknown' },
  ])('rejects unsupported or malformed options %j', (input) => {
    expect(() => validateDatabaseUsage(input as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });
});
