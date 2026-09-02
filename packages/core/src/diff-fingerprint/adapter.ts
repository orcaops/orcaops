// Thin curated re-export over `@orcaops/diff-fingerprint`.
//
// The vendored package exposes a wide surface (parser internals, hash
// primitives, length-prefix helpers, the JCS canonicalize wrapper, every
// Zod schema). This adapter narrows that surface to just the pieces the
// CLI needs at runtime: the manifest builder + parser + hash + summary
// projector, plus the algorithm-string named constants and the inferred
// types for callers that need to type values without owning the schema.
//
// Curation rationale:
//   * The checkpoint-close storage callback uses
//     `buildDiffFingerprintManifest` / `fingerprintUnifiedDiff` and
//     consumes `DiffFingerprintManifest` / `DiffFingerprintSummary`
//     types on the result.
//   * `summarizeManifest` is the projection helper the storage layer
//     uses to turn a full manifest into the wire / projection summary.
//   * The 7 algorithm-string constants pin the on-disk schema literals
//     that storage's `DiffFingerprintManifestSchema` validates against.
//   * `computeDiffFingerprintManifestHash` is the contract value the
//     cloud re-derives to validate received payloads — surfaced for any
//     CLI-side equivalent verification.
//   * `parseUnifiedDiff` lives here because the CLI's git layer hands a
//     `Uint8Array` of `git diff` output to the manifest builder; tests
//     and any future debug command may want to drive the parser
//     directly.
//
// Deliberately omitted:
//   * Zod `*Schema` runtime values — re-exporting them through the
//     top-level `@orcaops/core` barrel would widen the surface that
//     consumers depend on. Storage imports the schemas directly from
//     `@orcaops/protocol` (or `@orcaops/diff-fingerprint`) when it needs
//     them for validation.
//   * `SnapshotPhase` / `SnapshotFailureReason` types.
//     `packages/core/src/git/index.ts` already exposes those names as
//     `@orcaops/core`'s canonical snapshot types. Re-surfacing them here would
//     collide at the top-level barrel re-export and TypeScript would
//     report TS2308 on `export *` from both `git` and
//     `diff-fingerprint`. The runtime API (`buildDiffFingerprintManifest`,
//     `fingerprintUnifiedDiff`) does not take `SnapshotPhase` as a
//     parameter, so callers reach those types through the git barrel.
//   * Hash primitives (`blake3Bytes`, `patchHash`,
//     `hunkHeaderHash`, `hunkIdentifier`, `encodeBase64UrlNoPad`),
//     length-prefix helpers (`u32BE`, `lenPrefix`, `lenPrefixUtf8`),
//     the header-normalization helper (`normalizeHunkHeaderContext`),
//     the JCS wrapper (`canonicalizeJcs`), the
//     domain-prefix constants (`DOMAIN_*`), the bit-width constants
//     (`*_HASH_BITS`), and the `DIFF_FINGERPRINT_ALGORITHMS` aggregate
//     object — all internal to the manifest-building pipeline. CLI
//     callers should not reach into them.
//
// Deliberate surface WIDENING (two names promoted out of the
// "deliberately omitted" set above): `lineHash` + `normalizeLineBody` are
// re-exported for the local attribution matcher's line-membership check
// (`packages/core/src/attribution/line-match.ts`) — hashing a live source
// line with the exact capture-time recipe is the only way membership in a
// manifest's `added_line_hashes` is meaningful. They remain
// manifest-pipeline primitives: do NOT reach for them outside attribution
// code.
//
// The narrowed-barrel pattern + surface gate test convention here
// mirrors `packages/core/src/git/index.ts` + `index.test.ts`.

export {
  buildDiffFingerprintManifest,
  computeDiffFingerprintManifestHash,
  DIFF_ALGORITHM,
  fingerprintUnifiedDiff,
  HASH_ENCODING,
  HUNK_HEADER_HASH_ALGORITHM,
  LINE_HASH_ALGORITHM,
  // Line-membership primitives for the attribution matcher
  // (see the surface-widening rationale in the docblock above).
  lineHash,
  LINE_NORMALIZATION_VERSION,
  MANIFEST_HASH_ALGORITHM,
  normalizeLineBody,
  parseUnifiedDiff,
  PATCH_HASH_ALGORITHM,
  summarizeManifest,
} from '@orcaops/diff-fingerprint';

export type {
  CheckpointSnapshotBoundary,
  DiffFingerprintFailureReason,
  DiffFingerprintHunk,
  DiffFingerprintManifest,
  DiffFingerprintStatus,
  DiffFingerprintSummary,
  NormalizedHunk,
} from '@orcaops/diff-fingerprint';
