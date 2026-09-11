import { describe, expect, it } from 'vitest';

import { artifactOperationId } from './artifact-operation-id.js';
import { UuidV7Schema } from '../ids/uuidv7.js';

const artifactId = '01999999-9999-7000-8000-0000000000ab';

describe('artifact operation identity', () => {
  it('maps original keys deterministically and keeps event families distinct', () => {
    const opened = artifactOperationId(artifactId, 'old/non-uuid', 'checkpoint_opened');
    expect(opened).toBe(artifactOperationId(artifactId, 'old/non-uuid', 'checkpoint_opened'));
    expect(opened).not.toBe(artifactOperationId(artifactId, 'old/non-uuid', 'checkpoint_closed'));
    expect(UuidV7Schema.parse(opened)).toBe(opened);
  });

  it('refuses invalid artifact and empty scope inputs', () => {
    expect(() => artifactOperationId('not-an-artifact', 'key', 'family')).toThrow();
    expect(() => artifactOperationId(artifactId, '', 'family')).toThrow(/scope and key/u);
    expect(() => artifactOperationId(artifactId, 'key', '')).toThrow(/scope and key/u);
  });
});
