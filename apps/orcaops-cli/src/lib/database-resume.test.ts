import { describe, expect, it } from 'vitest';

import { validateDatabaseResume } from './database-resume.js';

describe('passive resume input', () => {
  it.each([
    null,
    [],
    new Date(),
    { format: 'yaml' },
    { copy: 'yes' },
    { acceptDefault: true },
    { artifact: () => 'changed' },
  ])('refuses malformed or retired selectors before opening history: %j', (value) => {
    expect(() => validateDatabaseResume(value as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });
  it('detaches selector and output choices from caller mutation', () => {
    const input = { branch: 'original', json: true, copy: false };
    const result = validateDatabaseResume(input);
    input.branch = 'changed';
    input.json = false;
    input.copy = true;
    expect(result.options).toEqual({ branch: 'original', json: true, copy: false });
    expect(result.selector.branch).toBe('original');
  });
});
