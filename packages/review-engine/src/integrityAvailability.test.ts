// `integrityUnavailableReason` is the single predicate answering "can this
// checkpoint's capture be verified at all?" — consulted by BOTH the re-derive (which
// skips) and the floor (which discloses). One function on purpose: two copies would
// eventually drift into the worst possible pairing, where the engine quietly skips a
// checkpoint and the floor reports it as fine.
//
// The distinction it draws is the whole point of the integrity contract:
//   verified: true  — reproduced.
//   verified: false — DRIFT. An accusation: the tree no longer matches the capture.
//   verified: null  — cannot tell.
// Collapsing the third case into the second is how a missing sidecar becomes a
// tampering allegation.

import { describe, expect, it } from 'vitest';

import type { CapturedFingerprintInputs } from './model.js';
import { integrityUnavailableReason } from './scope.js';

function captured(overrides: Partial<CapturedFingerprintInputs> = {}): CapturedFingerprintInputs {
  return {
    loadState: 'loaded',
    openTreeSha: 'open-tree',
    closeTreeSha: 'close-tree',
    maxDiffBytes: 2_000_000,
    diffOptions: { find_renames: true, no_ext_diff: true, unified: 3 },
    ...overrides,
  };
}

describe('integrityUnavailableReason', () => {
  it('a healthy manifest is checkable', () => {
    expect(integrityUnavailableReason(captured())).toBeUndefined();
  });

  it('a manifest that was never captured is not "unavailable" — there is nothing to verify', () => {
    // MANIFESTLESS_CHECKPOINT already covers this. Disclosing it a second time as
    // "integrity unavailable" would be noise, not honesty.
    const c = captured({
      loadState: 'not-captured',
      openTreeSha: null,
      closeTreeSha: null,
      maxDiffBytes: null,
      diffOptions: null,
    });
    expect(integrityUnavailableReason(c)).toBeUndefined();
  });

  it('a corrupt sidecar IS unavailable, and says so', () => {
    const reason = integrityUnavailableReason(captured({ loadState: 'corrupt' }));
    expect(reason).toBeDefined();
    expect(reason).toContain('could not be loaded');
  });

  it('a manifest with no recorded cap cannot be reproduced', () => {
    // The cap is hashed INTO the manifest, so without knowing which cap produced it
    // there is no way to rebuild the same hash. Guessing the live cap is exactly the
    // bug this predicate exists to prevent.
    const reason = integrityUnavailableReason(captured({ maxDiffBytes: null }));
    expect(reason).toContain('max_diff_bytes');
  });

  it('a manifest with no recorded boundary trees cannot be re-diffed', () => {
    expect(integrityUnavailableReason(captured({ openTreeSha: null }))).toContain('boundary trees');
    expect(integrityUnavailableReason(captured({ closeTreeSha: null }))).toContain(
      'boundary trees'
    );
  });

  it('a manifest captured under different git diff options is NOT silently re-derived', () => {
    // Same trees + same cap but `--unified=5` produces a different patch and thus a
    // different hash. Deriving anyway would manufacture a mismatch out of a settings
    // difference — the same class of bug as the cap, one level down. The options are
    // constant in the engine today, so this is a guard against a future foot-gun.
    for (const bad of [
      { find_renames: false, no_ext_diff: true, unified: 3 },
      { find_renames: true, no_ext_diff: false, unified: 3 },
      { find_renames: true, no_ext_diff: true, unified: 5 },
    ]) {
      const reason = integrityUnavailableReason(captured({ diffOptions: bad }));
      expect(reason).toContain('git diff options');
    }
  });
});
