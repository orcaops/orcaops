// Manifest integrity cross-check.
//
// Each boundary re-diff must re-fingerprint to the stored `manifest_hash`. The
// re-diff + rebuild is git work the sidecar does (mirroring the CLI's
// fingerprint-derive path); the engine only compares the two hashes, exactly as
// derive does: verified = derived === stored, and null when nothing was
// captured to compare against. A mismatch is a loud disclosure, never a silent
// trust downgrade.

import { type Disclosure, DISCLOSURE_CODE } from '../schema.js';

export interface ManifestIntegrityInput {
  artifact: string;
  cp: number;
  /** `diff_fingerprint_summary.manifest_hash` (null when capture skipped the fingerprint). */
  storedManifestHash: string | null;
  /** Hash of the sidecar's fresh boundary re-diff + rebuild (null when it couldn't derive). */
  derivedManifestHash: string | null;
  /**
   * Set when a hash IS stored but the check could not be PERFORMED — the manifest
   * sidecar won't load, or it records capture options this engine cannot reproduce.
   * Carries the human reason. Distinct from a null derived hash on a healthy
   * manifest (a transient git failure), because this one is a durable state a
   * reviewer must be told about rather than a retry.
   */
  unavailableReason?: string;
}

export interface IntegrityResult {
  artifact: string;
  cp: number;
  /** true = reproduced; false = drift; null = nothing stored to compare. */
  verified: boolean | null;
  disclosure?: Disclosure;
}

/** Compare one checkpoint's stored vs derived manifest hash. */
export function verifyManifest(input: ManifestIntegrityInput): IntegrityResult {
  const { artifact, cp } = input;
  if (input.storedManifestHash === null) {
    // Capture-time fingerprint was skipped — nothing to compare; the derive is
    // fresh output, not a mismatch.
    return { artifact, cp, verified: null };
  }
  if (input.unavailableReason !== undefined) {
    // A hash is stored, but we could not run the check. `verified: false` would be
    // a lie with teeth — it means DRIFT, i.e. it accuses the tree of having changed
    // out from under the capture. The honest answer is null plus a loud disclosure.
    return {
      artifact,
      cp,
      verified: null,
      disclosure: {
        code: DISCLOSURE_CODE.INTEGRITY_UNAVAILABLE,
        artifact,
        cp,
        message: `manifest integrity could not be checked — ${input.unavailableReason}; this is NOT a mismatch (no drift is claimed), but this checkpoint's capture is unverified`,
      },
    };
  }
  if (input.derivedManifestHash === input.storedManifestHash) {
    return { artifact, cp, verified: true };
  }
  return {
    artifact,
    cp,
    verified: false,
    disclosure: {
      code: DISCLOSURE_CODE.INTEGRITY_MISMATCH,
      artifact,
      cp,
      message:
        'derived manifest_hash does not reproduce the stored hash — content drift between the pinned trees and the capture-time manifest',
    },
  };
}

export interface IntegritySummary {
  results: IntegrityResult[];
  disclosures: Disclosure[];
}

/** Cross-check every checkpoint's manifest, collecting the mismatch disclosures. */
export function verifyManifests(inputs: readonly ManifestIntegrityInput[]): IntegritySummary {
  const results = inputs.map(verifyManifest);
  const disclosures = results
    .map((r) => r.disclosure)
    .filter((d): d is Disclosure => d !== undefined);
  return { results, disclosures };
}
