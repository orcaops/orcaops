import { describe, expect, it, vi } from 'vitest';

import { RecoveryRefusedError } from '@orcaops/storage';

import { readForEnumeration } from './enumeration-read.js';

describe('readForEnumeration', () => {
  it('degrades a recovery refusal to an unreadable row naming the artifact', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await readForEnumeration('rotted', 'status', () =>
        Promise.reject(new RecoveryRefusedError('projection unrecoverable', 'rotted'))
      );
      expect(result).toEqual({
        kind: 'unreadable',
        artifact_id: 'rotted',
        reason: 'projection unrecoverable',
      });
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/rotted.*status/);
    } finally {
      stderr.mockRestore();
    }
  });

  it('rethrows a non-recovery error instead of downgrading it', async () => {
    await expect(
      readForEnumeration('any', 'status', () => Promise.reject(new TypeError('boom')))
    ).rejects.toThrow(TypeError);
  });
});
