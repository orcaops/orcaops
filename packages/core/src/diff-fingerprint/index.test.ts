import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as diffFingerprintBarrel from './index.js';

/**
 * Surface tests for the `packages/core/src/diff-fingerprint/` barrel.
 *
 * Mirrors the four-gate convention from `packages/core/src/git/index.test.ts`:
 *
 *   1. **Runtime gate** — `Object.keys(barrel)` matches the expected
 *      value-export set EXACTLY. Catches any function / constant /
 *      class that slipped in.
 *
 *   2. **Internal-absence gate** — the documented vendored-package
 *      internals (Zod `*Schema` runtime values, hash primitives, JCS
 *      helper, length-prefix helpers, normalization helpers, DOMAIN_*
 *      prefixes, *_HASH_BITS constants, the
 *      DIFF_FINGERPRINT_ALGORITHMS aggregate) must NOT appear in
 *      barrel keys. Defense-in-depth on top of the runtime gate's
 *      exact match.
 *
 *   3. **Source-level regex** — reads `adapter.ts` AND `index.ts` and
 *      asserts neither uses `export *` (or its type-only `export type *`
 *      variant) from the upstream module. This is the only way to
 *      catch type-only leaks, which are erased at runtime and
 *      invisible to the keys check. Both files are gated because
 *      either can reopen the surface — adapter.ts's upstream is
 *      `@orcaops/diff-fingerprint` (the vendored package); index.ts's
 *      upstream is `./adapter.js`.
 *
 *   4. **Sanity gate** — source must literally contain each curated
 *      re-export name. Guards against a deletion of the explicit list
 *      that would silently shrink the surface.
 *
 * If you find yourself updating these tests: a public-surface change
 * is happening. Update the curation rationale in `adapter.ts` and any
 * documentation that names the contract.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXPECTED_PUBLIC_VALUE_EXPORTS = [
  // 5 functions
  'buildDiffFingerprintManifest',
  'computeDiffFingerprintManifestHash',
  'fingerprintUnifiedDiff',
  'parseUnifiedDiff',
  'summarizeManifest',
  // Line-membership primitives, deliberately promoted out of
  // the internal set for the attribution matcher (adapter.ts rationale).
  'lineHash',
  'normalizeLineBody',
  // 7 algorithm-string named constants (mirrored from @orcaops/protocol;
  // pinned literals that storage's DiffFingerprintManifestSchema validates
  // against)
  'DIFF_ALGORITHM',
  'HASH_ENCODING',
  'HUNK_HEADER_HASH_ALGORITHM',
  'LINE_HASH_ALGORITHM',
  'LINE_NORMALIZATION_VERSION',
  'MANIFEST_HASH_ALGORITHM',
  'PATCH_HASH_ALGORITHM',
].sort();

const EXPECTED_PUBLIC_TYPE_EXPORTS = [
  // 7 type-only re-exports (inferred from the protocol Zod schemas)
  'CheckpointSnapshotBoundary',
  'DiffFingerprintFailureReason',
  'DiffFingerprintHunk',
  'DiffFingerprintManifest',
  'DiffFingerprintStatus',
  'DiffFingerprintSummary',
  'NormalizedHunk',
];

const INTERNAL_VALUE_NAMES_THAT_MUST_NOT_LEAK = [
  // The 8 Zod *Schema runtime values intentionally omitted from this
  // adapter — storage imports them directly from
  // @orcaops/protocol or @orcaops/diff-fingerprint when needed.
  'CheckpointSnapshotBoundarySchema',
  'DiffFingerprintFailureReasonSchema',
  'DiffFingerprintHunkSchema',
  'DiffFingerprintManifestSchema',
  'DiffFingerprintStatusSchema',
  'DiffFingerprintSummarySchema',
  'SnapshotFailureReasonSchema',
  'SnapshotPhaseSchema',
  // Hash primitives — internal to the manifest-building pipeline.
  // (`lineHash` + `normalizeLineBody` are PUBLIC for the attribution
  // matcher — see adapter.ts.)
  'blake3Bytes',
  'encodeBase64UrlNoPad',
  'patchHash',
  'hunkHeaderHash',
  'hunkIdentifier',
  // JCS canonicalization wrapper — internal.
  'canonicalizeJcs',
  // Length-prefix framing helpers — internal.
  'lenPrefix',
  'lenPrefixUtf8',
  'u32BE',
  // Normalization helpers — internal (except `normalizeLineBody`, which
  // is public; see adapter.ts).
  'normalizeHunkHeaderContext',
  // Domain-prefix constants for the hash recipes — internal.
  'DOMAIN_LINE',
  'DOMAIN_PATCH',
  'DOMAIN_HUNK_HEADER',
  'DOMAIN_MANIFEST',
  // Bit-width constants for each hash dimension — internal.
  'LINE_HASH_BITS',
  'PATCH_HASH_BITS',
  'HUNK_HEADER_HASH_BITS',
  'HUNK_ID_HASH_BITS',
  'MANIFEST_HASH_BITS',
  // The aggregate algorithms object — internal.
  'DIFF_FINGERPRINT_ALGORITHMS',
];

describe('packages/core/src/diff-fingerprint barrel — public surface', () => {
  it('exposes EXACTLY the documented public value exports at runtime', () => {
    const actual = Object.keys(diffFingerprintBarrel).sort();
    expect(actual).toEqual(EXPECTED_PUBLIC_VALUE_EXPORTS);
  });

  it('does not leak any of the documented internal value names through the barrel', () => {
    const actual = new Set(Object.keys(diffFingerprintBarrel));
    for (const internalName of INTERNAL_VALUE_NAMES_THAT_MUST_NOT_LEAK) {
      expect(
        actual.has(internalName),
        `${internalName} must not be in the diff-fingerprint barrel`
      ).toBe(false);
    }
  });

  it('adapter.ts does NOT use `export * from "@orcaops/diff-fingerprint"` (source-level; catches type-only leaks)', async () => {
    const src = await readFile(path.join(__dirname, 'adapter.ts'), 'utf8');
    const forbiddenStar = /^\s*export\s+\*\s+from\s+['"]@orcaops\/diff-fingerprint['"]/m;
    const forbiddenTypeStar = /^\s*export\s+type\s+\*\s+from\s+['"]@orcaops\/diff-fingerprint['"]/m;
    expect(forbiddenStar.test(src)).toBe(false);
    expect(forbiddenTypeStar.test(src)).toBe(false);
  });

  it('index.ts does NOT use `export * from "./adapter.js"` (source-level; catches type-only leaks)', async () => {
    const src = await readFile(path.join(__dirname, 'index.ts'), 'utf8');
    const forbiddenStar = /^\s*export\s+\*\s+from\s+['"]\.\/adapter\.js['"]/m;
    const forbiddenTypeStar = /^\s*export\s+type\s+\*\s+from\s+['"]\.\/adapter\.js['"]/m;
    expect(forbiddenStar.test(src)).toBe(false);
    expect(forbiddenTypeStar.test(src)).toBe(false);
  });

  it('adapter.ts contains an explicit re-export list referencing each public name', async () => {
    const src = await readFile(path.join(__dirname, 'adapter.ts'), 'utf8');
    for (const name of [...EXPECTED_PUBLIC_VALUE_EXPORTS, ...EXPECTED_PUBLIC_TYPE_EXPORTS]) {
      expect(src, `${name} must appear in adapter.ts's explicit re-export list`).toContain(name);
    }
  });

  it('index.ts contains an explicit re-export list referencing each public name', async () => {
    const src = await readFile(path.join(__dirname, 'index.ts'), 'utf8');
    for (const name of [...EXPECTED_PUBLIC_VALUE_EXPORTS, ...EXPECTED_PUBLIC_TYPE_EXPORTS]) {
      expect(src, `${name} must appear in index.ts's explicit re-export list`).toContain(name);
    }
  });
});
