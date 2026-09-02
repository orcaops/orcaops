import { describe, it } from 'vitest';

import { runConformance } from '@orcaops/diff-fingerprint/fixtures';

import { buildDiffFingerprintManifest, computeDiffFingerprintManifestHash } from './adapter.js';

/**
 * Adapter conformance test — the fixture-parity gate.
 *
 * The cloud-side `@orcaops/diff-fingerprint` package owns the fixture
 * corpus (16 unified-diff inputs + 32 expected manifest / manifest_hash
 * pairs + hash and canonical-manifest vector files) and exposes a
 * `runConformance(opts?)` helper that drives the corpus through caller-
 * supplied overrides. Every diff-fixture iteration runs three
 * independent assertions: canonicalize-fn vs `expected_canonical`,
 * `built.summary.manifest_hash` vs the expected hash, and recompute-fn
 * vs the expected hash. Hash and canonical-manifest vectors trigger
 * additional override-aware assertions when the caller supplies them.
 *
 * The CLI's load-bearing job here is to prove ITS adapter's
 * import path resolves to the same implementation as the package's own
 * fixtures expect. The MANDATORY primary test below passes the
 * adapter's re-exports as overrides — anything other than byte-identity
 * fails. Without overrides, `runConformance()` only tests the vendored
 * package against its own fixtures, which the cloud-side conformance
 * test already covers and which would not catch a CLI-side import
 * misroute.
 *
 * The secondary smoke test (no overrides) is a cheap insurance check
 * that `pnpm pack` + `pnpm install` did not strip the `./fixtures`
 * subpath export or drop the raw `fixtures/` directory from the
 * tarball — both regressions would surface here as a thrown
 * `ConformanceMismatchError` or a fixture-loading exception.
 */

describe('@orcaops/diff-fingerprint adapter conformance', () => {
  it('produces byte-identical canonical + hash output through the adapter import path', async () => {
    await runConformance({
      buildDiffFingerprintManifest,
      computeDiffFingerprintManifestHash,
    });
  });

  it('vendored package self-conforms after pack + install (smoke)', async () => {
    await runConformance();
  });
});
