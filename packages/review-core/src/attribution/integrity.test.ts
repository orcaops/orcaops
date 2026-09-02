import { describe, expect, it } from 'vitest';

import { verifyManifest, verifyManifests } from './integrity.js';

describe('verifyManifest', () => {
  it('returns null when nothing was captured to compare', () => {
    const r = verifyManifest({
      artifact: 'a',
      cp: 1,
      storedManifestHash: null,
      derivedManifestHash: 'X',
    });
    expect(r.verified).toBeNull();
    expect(r.disclosure).toBeUndefined();
  });

  it('verifies when derived reproduces stored', () => {
    const r = verifyManifest({
      artifact: 'a',
      cp: 1,
      storedManifestHash: 'H',
      derivedManifestHash: 'H',
    });
    expect(r.verified).toBe(true);
    expect(r.disclosure).toBeUndefined();
  });

  it('flags drift with an integrity_mismatch disclosure', () => {
    const r = verifyManifest({
      artifact: 'a',
      cp: 1,
      storedManifestHash: 'H',
      derivedManifestHash: 'DRIFT',
    });
    expect(r.verified).toBe(false);
    expect(r.disclosure?.code).toBe('integrity_mismatch');
    expect(r.disclosure).toMatchObject({ artifact: 'a', cp: 1 });
  });
});

describe('verifyManifest — cannot-check is not the same as mismatch', () => {
  // `verified: false` has a specific, accusatory meaning: DRIFT. It says the tree
  // no longer reproduces what was captured. Reporting it when we simply could not
  // run the check would tell a reviewer their history was tampered with because a
  // sidecar file went missing. "I cannot tell" needs its own answer.
  const unavailable = {
    artifact: 'a1',
    cp: 1,
    storedManifestHash: 'stored-hash',
    derivedManifestHash: null,
    unavailableReason: 'a manifest_hash is recorded but its manifest could not be loaded',
  };

  it('returns verified:null — NOT false — when the check could not be run', () => {
    const r = verifyManifest(unavailable);
    expect(r.verified).toBeNull();
    expect(r.verified).not.toBe(false);
  });

  it('discloses integrity_unavailable, never integrity_mismatch', () => {
    const r = verifyManifest(unavailable);
    expect(r.disclosure?.code).toBe('integrity_unavailable');
    expect(r.disclosure?.code).not.toBe('integrity_mismatch');
    expect(r.disclosure?.artifact).toBe('a1');
    expect(r.disclosure?.cp).toBe(1);
  });

  it('says plainly that no drift is being claimed', () => {
    const r = verifyManifest(unavailable);
    expect(r.disclosure?.message).toContain('could not be checked');
    expect(r.disclosure?.message).toContain('NOT a mismatch');
    expect(r.disclosure?.message).toContain('unverified');
  });

  it('still reports real drift as a mismatch when the check DID run', () => {
    // The escape hatch must not swallow genuine tampering: with no
    // unavailableReason, a differing derived hash is still drift.
    const r = verifyManifest({
      artifact: 'a1',
      cp: 1,
      storedManifestHash: 'stored-hash',
      derivedManifestHash: 'different-hash',
    });
    expect(r.verified).toBe(false);
    expect(r.disclosure?.code).toBe('integrity_mismatch');
  });
});

describe('verifyManifests', () => {
  it('aggregates results and collects only the mismatch disclosures', () => {
    const { results, disclosures } = verifyManifests([
      { artifact: 'a', cp: 1, storedManifestHash: 'H', derivedManifestHash: 'H' },
      { artifact: 'a', cp: 2, storedManifestHash: 'H2', derivedManifestHash: 'DRIFT' },
      { artifact: 'a', cp: 3, storedManifestHash: null, derivedManifestHash: null },
    ]);
    expect(results.map((r) => r.verified)).toEqual([true, false, null]);
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toMatchObject({ code: 'integrity_mismatch', cp: 2 });
  });
});
