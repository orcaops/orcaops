import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as gitBarrel from './index.js';

/**
 * Surface tests for the `packages/core/src/git/` barrel.
 *
 * These guard against accidental re-exposure of snapshot internals
 * (`runGit`, `allocateTempIndex`, `snapshotRefName`, `parseSnapshotRefName`,
 * `classifySnapshotFailure`, plus the `RunGitOptions` / `RunGitResult`
 * type-only internals) through the `@orcaops/core` package barrel.
 * (`resolveRepoTopLevel` IS public surface — see `git/index.ts`.)
 *
 * Two complementary gates:
 *
 *   1. **Runtime check** — `Object.keys(gitBarrel)` returns the names
 *      of every VALUE export reachable from the barrel. Catches any
 *      function/constant/class that slipped in.
 *
 *   2. **Source-level check** — reads `index.ts` and asserts the file
 *      does NOT use `export * from './snapshots.js'` (or its type-only
 *      variant `export type *`). This is the only way to catch
 *      type-only exports, which are erased at runtime and invisible
 *      to the keys check.
 *
 * If you find yourself updating these tests: a public-surface change
 * is happening. Update the documentation in `snapshots.ts` and any
 * documentation that names the contract.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXPECTED_PUBLIC_VALUE_EXPORTS = [
  // From repo.js (kept as-is — `Repo` class is public surface).
  'Repo',
  // One-shot worktree probe for the session-start hook.
  'probeWorktree',
  // From snapshots.js — the documented public functions, plus the two
  // shared ref-selectors.
  'captureCheckpointSnapshot',
  'collectPrunableRefsForArtifact',
  // Truncation honesty: a numstat offender pass covers the truncated
  // review-diff path (the true patch size is unknowable at the cap).
  'diffSnapshotStats',
  'diffSnapshotTrees',
  'listRawSnapshotRefIdentities',
  'listRawSnapshotRefNames',
  'listSnapshotRefs',
  'pruneSnapshotRefs',
  'pruneSnapshotRefsIfUnchanged',
  // From snapshots.js — review-pin namespace (gc-on-prune of a stale review dir).
  'listRawReviewRefNames',
  'listRawReviewRefIdentities',
  'pruneReviewRefs',
  'pruneReviewRefsIfUnchanged',
  'REVIEW_REF_PREFIX',
  // From snapshots.js — the worktree-root resolver (public: the CLI
  // anchors `.orcaops` to the git worktree top through it).
  'resolveRepoTopLevel',
  // From snapshots.js — public constants for downstream consumers.
  'SNAPSHOT_REF_PREFIX',
  'SNAPSHOT_NESTED_ORCAOPS_EXCLUDE_PATHSPECS',
  'SNAPSHOT_ORCAOPS_EXCLUDE_DIRS',
  // From snapshots.js — baseline namespace (plan-time baseline ref).
  'baselineRefName',
  'BASELINE_REF_PREFIX',
  'captureBaselineSnapshot',
  'collectBaselineRefsForArtifact',
  'listRawBaselineRefNames',
  'listRawBaselineRefIdentities',
  'parseBaselineRefName',
  'pinBaselineTree',
  'pruneBaselineRefs',
  'pruneBaselineRefsIfUnchanged',
  // From snapshots.js — scratch-worktree materialization
  // (`orcaops snapshots checkout` is the caller).
  'listSensitiveTreePaths',
  'materializeSnapshotTree',
  // From snapshots.js — tree-only live capture for
  // attribution's live side (`orcaops diff --attribution`).
  'captureWorktreeTreeSha',
  // Review floors use a distinct tracked-only tree with explicit untracked opt-ins.
  'captureReviewWorktreeTreeSha',
].sort();

const INTERNAL_VALUE_NAMES_THAT_MUST_NOT_LEAK = [
  'runGit',
  'allocateTempIndex',
  'snapshotRefName',
  'parseSnapshotRefName',
  'classifySnapshotFailure',
  // The shared temp-index core is exported from snapshots.js for
  // colocated tests but is an internal detail, like runGit — it must NOT
  // surface through the barrel.
  'captureWorktreeTree',
];

describe('packages/core/src/git barrel — public surface', () => {
  it('exposes EXACTLY the documented public value exports at runtime', () => {
    const actual = Object.keys(gitBarrel).sort();
    expect(actual).toEqual(EXPECTED_PUBLIC_VALUE_EXPORTS);
  });

  it('does not leak any of the documented internal value names through the barrel', () => {
    const actual = new Set(Object.keys(gitBarrel));
    for (const internalName of INTERNAL_VALUE_NAMES_THAT_MUST_NOT_LEAK) {
      expect(actual.has(internalName), `${internalName} must not be in the git barrel`).toBe(false);
    }
  });

  it('does NOT use `export * from "./snapshots.js"` (source-level; catches type-only leaks)', async () => {
    const src = await readFile(path.join(__dirname, 'index.ts'), 'utf8');
    // Forbid both `export * from './snapshots.js'` and the type-only
    // form `export type * from './snapshots.js'`. Either would re-export
    // every (type or value) symbol from snapshots and reopen the surface.
    const forbiddenStar = /^\s*export\s+\*\s+from\s+['"]\.\/snapshots\.js['"]/m;
    const forbiddenTypeStar = /^\s*export\s+type\s+\*\s+from\s+['"]\.\/snapshots\.js['"]/m;
    expect(forbiddenStar.test(src)).toBe(false);
    expect(forbiddenTypeStar.test(src)).toBe(false);
  });

  it('source contains an explicit re-export list referencing each public name', async () => {
    // Sanity check that the explicit list is in place — guards against
    // a deletion of the explicit re-exports that would silently shrink
    // the surface (and break downstream slices that depend on it).
    const src = await readFile(path.join(__dirname, 'index.ts'), 'utf8');
    for (const name of [
      'captureCheckpointSnapshot',
      'collectPrunableRefsForArtifact',
      'diffSnapshotStats',
      'diffSnapshotTrees',
      'listRawSnapshotRefIdentities',
      'listRawSnapshotRefNames',
      'listSnapshotRefs',
      'pruneSnapshotRefs',
      'pruneSnapshotRefsIfUnchanged',
      'listRawReviewRefIdentities',
      'listRawReviewRefNames',
      'pruneReviewRefs',
      'pruneReviewRefsIfUnchanged',
      'REVIEW_REF_PREFIX',
      'resolveRepoTopLevel',
      'SNAPSHOT_REF_PREFIX',
      'SNAPSHOT_NESTED_ORCAOPS_EXCLUDE_PATHSPECS',
      'SNAPSHOT_ORCAOPS_EXCLUDE_DIRS',
      'DiffSnapshotResult',
      'DiffSnapshotStatsResult',
      'DiffStatEntry',
      'SnapshotFailureReason',
      'SnapshotPhase',
      'SnapshotRefEntry',
      'SnapshotResult',
      // Baseline namespace.
      'baselineRefName',
      'BASELINE_REF_PREFIX',
      'captureBaselineSnapshot',
      'collectBaselineRefsForArtifact',
      'listRawBaselineRefNames',
      'listRawBaselineRefIdentities',
      'parseBaselineRefName',
      'pinBaselineTree',
      'pruneBaselineRefs',
      'pruneBaselineRefsIfUnchanged',
      'BaselineSnapshotResult',
      // Materialization surface.
      'listSensitiveTreePaths',
      'materializeSnapshotTree',
      'SnapshotCheckoutResult',
      // Live-capture surface.
      'captureWorktreeTreeSha',
      'captureReviewWorktreeTreeSha',
      'ReviewWorktreeTreeResult',
      'ReviewUntrackedEvidenceDetail',
      'RefIdentity',
    ]) {
      expect(src, `${name} must appear in the explicit re-export list`).toContain(name);
    }
  });
});
