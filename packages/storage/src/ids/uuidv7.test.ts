import { describe, expect, it } from 'vitest';

import { isUuidV7, UUID_V7_REGEX, uuidv7 } from './uuidv7.js';

describe('uuidv7', () => {
  describe('format', () => {
    it('returns a canonical-form UUIDv7 string', () => {
      const id = uuidv7();
      expect(id).toMatch(UUID_V7_REGEX);
    });

    it('puts version 7 in the third hex group', () => {
      const id = uuidv7();
      const parts = id.split('-');
      expect(parts[2][0]).toBe('7');
    });

    it('puts variant 10 (i.e., 8/9/a/b) in the fourth hex group', () => {
      // Run several times — the variant nibble high 2 bits are fixed but
      // the low 2 bits are random, so the leading char rotates through 8/9/a/b.
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        seen.add(uuidv7().split('-')[3][0]);
      }
      for (const c of seen) {
        expect(['8', '9', 'a', 'b']).toContain(c);
      }
    });

    it('isUuidV7 accepts the canonical form and rejects shape mismatches', () => {
      expect(isUuidV7(uuidv7())).toBe(true);
      // UUIDv4 (version nibble = 4) is not v7
      expect(isUuidV7('017f22e2-79b0-4cc3-98c4-dc0c0c07398f')).toBe(false);
      // Wrong variant nibble (top 2 bits != 10)
      expect(isUuidV7('017f22e2-79b0-7cc3-08c4-dc0c0c07398f')).toBe(false);
      // Wrong length
      expect(isUuidV7('017f22e2-79b0-7cc3-98c4')).toBe(false);
      // Uppercase — UUID_V7_REGEX is lowercase-only by design (we always emit lowercase)
      expect(isUuidV7('017F22E2-79B0-7CC3-98C4-DC0C0C07398F')).toBe(false);
    });
  });

  describe('timestamp encoding', () => {
    it('embeds the supplied millisecond timestamp in the first 12 hex chars', () => {
      const ts = 0x017f22e279b0; // 1645557742000 ms
      const id = uuidv7({ now: ts });
      expect(id.slice(0, 8) + id.slice(9, 13)).toBe(ts.toString(16).padStart(12, '0'));
    });

    it('uses Date.now() when no timestamp is supplied', () => {
      const before = Date.now();
      const id = uuidv7();
      const after = Date.now();
      const stamped = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
    });

    it('rejects negative timestamps', () => {
      expect(() => uuidv7({ now: -1 })).toThrow(/out of 48-bit range/);
    });

    it('rejects timestamps that exceed 48 bits', () => {
      expect(() => uuidv7({ now: Number(0xffff_ffff_ffffn) + 1 })).toThrow(/out of 48-bit range/);
    });
  });

  describe('sortability', () => {
    it('sorts lexicographically in chronological order across distinct ms', () => {
      const ids = [1700000000000, 1700000000001, 1700000000002, 1700000000003].map((t) =>
        uuidv7({ now: t })
      );
      const sorted = [...ids].sort();
      expect(sorted).toEqual(ids);
    });
  });

  describe('uniqueness + randomness', () => {
    it('returns distinct IDs across many calls within the same ms', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(uuidv7({ now: 1700000000000 }));
      }
      // 1000 IDs from the same timestamp; with 74 bits of randomness collisions
      // are essentially impossible. Asserting all-distinct catches a stuck RNG.
      expect(ids.size).toBe(1000);
    });

    it('falls back to a custom random source when injected', () => {
      const fakeRandom = (): Buffer =>
        Buffer.from([0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde]);
      const id = uuidv7({ now: 0x017f22e279b0, random: fakeRandom });
      // Determinism check: same now + same random source → same UUID.
      const id2 = uuidv7({ now: 0x017f22e279b0, random: fakeRandom });
      expect(id).toBe(id2);
      // And the version + variant nibbles are still correctly stamped.
      expect(id).toMatch(UUID_V7_REGEX);
    });

    it('rejects a random source that returns too few bytes', () => {
      expect(() => uuidv7({ random: () => Buffer.alloc(5) })).toThrow(/need >= 10/);
    });
  });
});
