// Floor orchestrator: scope → chain → synthesized-lineage blame → engine →
// outline / citations / plan-coverage / landmarks → a schema-valid Floor. All
// the git + store work is in scope.ts / lineage.ts; this file is the assembly.

import { performance } from 'node:perf_hooks';

import {
  attribute,
  type AttributionLine,
  buildChain,
  type CheckpointDescriptor,
  checkpointRef,
  type CheckpointRungInput,
  type CoverageItem,
  type Disclosure,
  DISCLOSURE_CODE,
  type Floor,
  FLOOR_SCHEMA_VERSION,
  floorSchema,
  type LineOwner,
  type ManifestIntegrityInput,
  type OverlapSegment,
  type SliceRef,
  stableHash64,
  type UnassignedWork,
} from '@orcaops/review-core';

import type { BlameCache } from './blameCache.js';
import { buildCitations } from './citations.js';
import { buildLandmarks } from './landmarks.js';
import { blameLineage } from './lineage.js';
import { type AssemblyInput, orderedCheckpoints } from './model.js';
import { buildThreads } from './outline.js';
import { buildPlanCoverage } from './planCoverage.js';
import { integrityUnavailableReason, resolveScope, type ScopeInputs } from './scope.js';

export interface BuildFloorOptions {
  root: string;
  branch: string;
  base?: string;
  /**
   * Preamble snapshot captured for this build attempt. Supplying it avoids a
   * second store/config/worktree/base pass while the caller retains the first.
   */
  scopeInputs?: ScopeInputs;
  /** ISO timestamp for `generated_at` (injected so assembly stays deterministic in tests). */
  now: string;
  /**
   * Directory holding the persistent blame cache (`.orcaops/reviews/<slug>/`).
   * When set, per-file blame is memoized across builds and the returned
   * `nextBlameCache` should be persisted by the caller inside the commit lock.
   * Omitted → no blame caching (direct callers pay full blame; the on-disk cache
   * is left untouched).
   */
  blameCacheDir?: string;
  /** Optional cold-build diagnostic sink; omitted in normal production runs. */
  onStageTiming?: (timing: FloorBuildStageTiming) => void;
}

export type FloorBuildStage =
  | 'scope_diff_manifest'
  | 'lineage_blame'
  | 'attribution'
  | 'outline'
  | 'assembly';

export interface FloorBuildStageTiming {
  stage: FloorBuildStage;
  durationMs: number;
}

async function timeBuildStage<T>(
  opts: BuildFloorOptions,
  stage: FloorBuildStage,
  run: () => T | Promise<T>
): Promise<T> {
  if (opts.onStageTiming === undefined) return run();
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    opts.onStageTiming({ stage, durationMs: performance.now() - startedAt });
  }
}

/**
 * Recoverable-degradation signals for a whole build. When ANY is set the build
 * is NOT cacheable (see the health gate in `run.ts`): a transient git/object
 * glitch would otherwise be blessed with a valid marker and reused indefinitely.
 * A deterministic skip (a truncated diff, a checkpoint with no stored manifest,
 * a genuinely empty diff) is NOT degradation and stays cacheable.
 */
export interface FloorCacheHealth {
  reviewDiffOk: boolean;
  truncationStatsFailed: boolean;
  manifestDeriveFailed: boolean;
  lineageFailed: boolean;
  blameFailed: boolean;
}

/** A build is cacheable only when every degradation signal is clear. */
export function isFloorCacheHealthClean(h: FloorCacheHealth): boolean {
  return (
    h.reviewDiffOk &&
    !h.truncationStatsFailed &&
    !h.manifestDeriveFailed &&
    !h.lineageFailed &&
    !h.blameFailed
  );
}

/**
 * The floor plus the raw review diff it was derived from. The floor carries only
 * hunk *metadata* (keys, positions, counts); the Walk's diff pane needs the
 * actual patch text, so `review data` persists this diff beside `floor.json` and
 * the UI position-matches floor hunks to it. Byte-for-byte the `base→pinned`
 * unified diff the attribution engine parsed, so the `@@` headers align exactly.
 */
export interface BuildFloorResult {
  floor: Floor;
  reviewDiff: Uint8Array;
  reviewDiffTruncated: boolean;
  /**
   * The full per-line attribution table (~175 bytes/line, linear in diff
   * size) — persisted by `review data` as the cold `attribution.ndjson`
   * sibling, never inlined in the floor; the hot consumer is the per-hunk
   * slice partition in `coverage.items[].units`.
   */
  attributionLines: AttributionLine[];
  /**
   * The cache fingerprint of the inputs THIS build was actually assembled over
   * (either captured by the caller or resolved inside `buildFloor`). The caller
   * installs the marker under this and rechecks current inputs at commit time,
   * so a floor can never be installed under a marker for a different snapshot.
   */
  fingerprint: string;
  /** Whether this build is safe to bless into the whole-floor cache marker. */
  cacheHealth: FloorCacheHealth;
  /**
   * The blame cache to persist (reused + newly computed entries), or null to
   * leave the on-disk cache untouched (no `blameCacheDir`, a disabled cache, or a
   * thrown lineage failure). The caller writes it atomically inside the commit lock.
   */
  nextBlameCache: BlameCache | null;
}

/** Add/delete row counts of a slice, from its (contiguous) per-side ranges. */
function sliceSideRows(unit: {
  add_range: { start: number; end: number } | null;
  del_range: { start: number; end: number } | null;
}): {
  added: number;
  removed: number;
} {
  return {
    added: unit.add_range === null ? 0 : unit.add_range.end - unit.add_range.start + 1,
    removed: unit.del_range === null ? 0 : unit.del_range.end - unit.del_range.start + 1,
  };
}

/**
 * The unassigned-work surface: every gap/unowned slice (band 1) and every
 * concurrent-window ambiguous hunk (band 2). Slice-grain — a gap run inside a
 * checkpoint-dominated hunk is visible here, which no parent-verdict-grain
 * rollup could ever show.
 */
function buildUnassigned(items: readonly CoverageItem[]): UnassignedWork {
  const gapRefs: SliceRef[] = [];
  const gapByFile = new Map<
    string,
    { slice_count: number; added_rows: number; removed_rows: number }
  >();
  const ambiguousKeys: string[] = [];
  const ambiguousByFile = new Map<string, { hunk_count: number; added: number; removed: number }>();

  for (const item of items) {
    for (const unit of item.units) {
      if (unit.kind === 'gap_slice') {
        gapRefs.push({ hunkKey: item.hunkKey, slice: unit.slice });
        const entry = gapByFile.get(item.file) ?? {
          slice_count: 0,
          added_rows: 0,
          removed_rows: 0,
        };
        const rows = sliceSideRows(unit);
        entry.slice_count += 1;
        entry.added_rows += rows.added;
        entry.removed_rows += rows.removed;
        gapByFile.set(item.file, entry);
      } else if (unit.kind === 'ambiguous_hunk') {
        ambiguousKeys.push(item.hunkKey);
        const entry = ambiguousByFile.get(item.file) ?? { hunk_count: 0, added: 0, removed: 0 };
        entry.hunk_count += 1;
        entry.added += item.added_lines;
        entry.removed += item.removed_lines;
        ambiguousByFile.set(item.file, entry);
      }
    }
  }

  const byFileSorted = <T>(map: Map<string, T>): Array<{ file: string } & T> =>
    [...map.entries()]
      .map(([file, s]) => ({ file, ...s }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return {
    gap: { sliceRefs: gapRefs, files: byFileSorted(gapByFile) },
    ambiguous: { hunkKeys: ambiguousKeys, files: byFileSorted(ambiguousByFile) },
  };
}

// A gap this large is not hand-uncaptured work — it's a rebase/merge/import.
const LARGE_GAP_MIN_LINES = 500;
const LARGE_GAP_MIN_FILES = 30;

function checkpointFilesUnion(input: AssemblyInput): Set<string> {
  const files = new Set<string>();
  for (const a of input.artifacts) {
    for (const cp of a.checkpoints) for (const f of cp.filesChanged) files.add(f);
  }
  return files;
}

/**
 * Flag gap segments that own a large span outside the checkpoints' own files —
 * a likely branch import/rebase, not sloppy capture. The code states the
 * observation (`large_uncaptured_gap`); the message grades the interpretation by
 * how much of the gap sits outside any checkpoint.
 */
function detectLargeGaps(
  items: readonly CoverageItem[],
  checkpointFiles: ReadonlySet<string>
): Disclosure[] {
  // Slice grain: sum each gap segment's own add-side rows. Mixed hunks no
  // longer inflate the count (the old parent-grain pass charged a segment the
  // whole hunk's added_lines whenever it happened to dominate).
  const bySegment = new Map<string, { files: Set<string>; lines: number }>();
  for (const item of items) {
    for (const unit of item.units) {
      if (unit.kind !== 'gap_slice' || unit.owner === null) continue;
      const entry = bySegment.get(unit.owner.segment) ?? { files: new Set(), lines: 0 };
      entry.files.add(item.file);
      entry.lines += sliceSideRows(unit).added;
      bySegment.set(unit.owner.segment, entry);
    }
  }

  const disclosures: Disclosure[] = [];
  for (const [segment, e] of bySegment) {
    if (e.lines < LARGE_GAP_MIN_LINES && e.files.size < LARGE_GAP_MIN_FILES) continue;
    const outside = [...e.files].filter((f) => !checkpointFiles.has(f)).length;
    const likelyImport = e.files.size > 0 && outside / e.files.size >= 0.8;
    const tail = likelyImport
      ? `likely a branch import/rebase (${outside}/${e.files.size} files outside any checkpoint)`
      : 'a large uncaptured span';
    disclosures.push({
      code: DISCLOSURE_CODE.LARGE_UNCAPTURED_GAP,
      message: `gap ${segment} owns ${e.lines} added line(s) across ${e.files.size} file(s) — ${tail}`,
    });
  }
  return disclosures.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
}

/**
 * The Story-content identity (NOT the cache fingerprint — see
 * `computeFloorFingerprint`). A Story installed against these inputs stays
 * fresh; anything that changes what a reviewer would SEE must move this hash.
 *
 * `retainedHunkKeys` is the truncation gate. Pass null whenever the review diff
 * was NOT truncated: the trees already determine the diff content exactly, so
 * there is nothing further to hash and the result stays byte-identical to what
 * it has always been — no untruncated repo gets a spuriously stale Story from
 * the cap split. Only when the cap actually cut the diff does the retained content
 * become an independent input, and then it is the hunk IDENTITY that matters
 * (hunkKey = filePath + patch_hash + occurrence, so it captures hunk CONTENT),
 * not the raw bytes. Hashing bytes instead would be wrong twice over: it would
 * stale every installed Story in every repo for nothing, and it would move the
 * hash again when complete-hunk normalization shortens a truncated patch — even
 * though normalization provably removes only bytes the floor already ignored.
 */
export async function computeInputHash(
  input: AssemblyInput,
  retainedHunkKeys: readonly string[] | null
): Promise<string> {
  const parts: string[] = [input.branch, input.baseTreeSha, input.pinnedTreeSha];
  const cpParts: string[] = [];
  for (const a of input.artifacts) {
    cpParts.push(`artifact:${a.id}`);
    for (const cp of a.checkpoints) {
      if (cp.status === 'closed') {
        cpParts.push(`${a.id}:cp${cp.n}:${cp.closeTreeSha}:${cp.manifestHash}`);
      }
    }
  }
  // Deliberately empty (not a placeholder) on the untruncated path, so the hash
  // inputs are exactly what they were before the cap split.
  const truncParts = retainedHunkKeys === null ? [] : ['truncated', ...retainedHunkKeys];
  // Domain v2 = the slice-native projection: every Story installed against a
  // v1 floor reads STALE through the current pointer's floor input hash and
  // requires a fresh routine run. Older Stories used the dominant-owner
  // projection and may omit newly visible checkpoint work.
  return stableHash64('orcaops.review.floor_input.v2', [
    ...parts,
    ...cpParts.sort(),
    ...truncParts,
  ]);
}

/**
 * Bumped whenever floor ASSEMBLY logic changes in a way that alters output for
 * unchanged inputs. It is part of the cache fingerprint's domain, so an engine
 * upgrade invalidates every prior floor-cache marker even when the inputs match
 * — a schema_version:1 floor built by an older engine can never be served.
 *
 * 5 — the threadKey recipe. This bump is load-bearing, not hygiene: neither
 * `computeInputHash` nor `computeFloorFingerprint` hashes the OUTLINE, so a v2
 * floor on disk fingerprints IDENTICALLY to the v3 floor built from the same
 * inputs. Without the bump, the only thing standing between a stale v2 floor and
 * being served is `readCachedFloor`'s `floorSchema.parse`. That gate does hold
 * (the renamed fields are required, so the parse fails) — but relying on a shape
 * check to do a version check's job is exactly how the next rename gets missed.
 *
 * 8 — alternative citations carry `parent`, the id of the decision they were
 * rejected against. Also load-bearing: the field was OPTIONAL at this producer
 * so then-current floors still parsed (the optionality ended with the strict v4
 * cut at 11 below), and the consumer now attaches alternatives by `parent`
 * alone, so a cached pre-8 floor would serve every alternative as
 * unattributable. The bump forces the rebuild that restores the link instead.
 *
 * 9 — the citation table now carries three categories of captured provenance
 * nothing had ever read out of storage: plan-time decisions with their rejected
 * alternatives (PLAN_DECISION / PLAN_ALTERNATIVE), done-criteria evidence
 * (CRITERION_EVIDENCE), and verified-close records (CHECKPOINT_VERIFICATION).
 * Load-bearing for the same reason as 8: the new citations are ADDITIVE, so a
 * pre-9 floor still parses cleanly against `FLOOR_SCHEMA_VERSION` 3 and would be
 * served from cache missing every one of them — silently, and indistinguishably
 * from a branch that captured none.
 *
 * 10 — acceptance-criterion citations carry `parent`, the plan-step citation
 * they belong to. The link was optional at this producer so then-current
 * floors still parsed (the optionality ended with the strict v4 cut at 11
 * below), but the hierarchical account renderer deliberately refuses to
 * guess a missing relationship. Rebuilding cached floors is what gives new
 * schema-4 dossiers exact plan nesting instead of the labelled legacy
 * fallback.
 *
 * 11 — floor schema v4 makes the complete tree strict, removes the vestigial
 * inline attribution-lines array, and makes citation variants exact. The
 * producer bump explicitly invalidates every v3 cache marker.
 */
export const FLOOR_PRODUCER_VERSION = '11';

/**
 * Canonical, ORDER-PRESERVING JSON. Recursively sorts object keys but keeps every
 * array's order exactly. Arrays in AssemblyInput are semantically ordered — plan
 * steps, acceptance criteria, decisions, alternatives, uncertainty, evaluator
 * runs, checkpoints, artifacts — and their positions drive citation IDs
 * (`citations.ts` hashes by running per-checkpoint index) and rendered order, so
 * sorting any array would let two differently-ordered inputs (which produce
 * DIFFERENT floors) collide on one fingerprint → a false hit. `undefined` object
 * properties are omitted consistently. No array is reordered solely for hashing.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

/**
 * Project the AssemblyInput for fingerprinting: strip the two fields that must
 * NOT enter the key. `worktreeHead` is the deliberately-live staleness anchor —
 * including it would force a MISS whenever HEAD advances without a tree change
 * (e.g. committing already-dirty work), defeating the HIT-plus-refresh path. Each
 * checkpoint's `derivedManifestHash` is populated only by the derive pass the
 * preamble SKIPS, so a preamble value (null) would never match a full build's.
 */
function projectFingerprintInput(input: AssemblyInput): unknown {
  return {
    branch: input.branch,
    branchSlug: input.branchSlug,
    baseSha: input.baseSha,
    baseTreeSha: input.baseTreeSha,
    pinnedTreeSha: input.pinnedTreeSha,
    defaultBranch: input.defaultBranch,
    artifacts: input.artifacts.map((a) => ({
      ...a,
      checkpoints: a.checkpoints.map((cp) => {
        const clone: Record<string, unknown> = { ...cp };
        delete clone.derivedManifestHash;
        return clone;
      }),
    })),
  };
}

/**
 * The complete, producer-versioned whole-floor cache fingerprint. Hashes the
 * projected AssemblyInput (every normalized assembly input), BOTH runtime caps
 * (each changes truncation → coverage, on its own axis), and the pre-diff
 * topology disclosures, under a producer-version domain. Computable from
 * `resolveScopeInputs` ALONE, so a cache hit-check pays none of the
 * diff/derive/blame cost. Deliberately excludes worktreeHead + generated_at
 * (live) and reviewDiff/truncation state (deterministic products of trees + caps,
 * guarded by the health gate). Distinct from `computeInputHash`, which is the
 * narrower content identity for current Story staleness.
 *
 * The two caps participate under DISTINCT field names, so changing either forces
 * a miss independently. This is load-bearing, not tidiness: on a HIT
 * `serveCachedFloor` rewrites only `floor.json` and leaves `diff.patch` in place,
 * so an unfingerprinted review cap would serve a patch still cut at the old cap.
 */
export async function computeFloorFingerprint(scopeInputs: ScopeInputs): Promise<string> {
  const canonical = canonicalJson({
    input: projectFingerprintInput(scopeInputs.input),
    fingerprintMaxDiffBytes: scopeInputs.fingerprintMaxDiffBytes,
    reviewMaxDiffBytes: scopeInputs.reviewMaxDiffBytes,
    reviewIncludedUntracked: scopeInputs.reviewIncludedUntracked,
    disclosures: scopeInputs.disclosures,
  });
  return stableHash64(`orcaops.review.floor_cache.${FLOOR_PRODUCER_VERSION}`, [canonical]);
}

export async function buildFloor(opts: BuildFloorOptions): Promise<BuildFloorResult> {
  const scope = await timeBuildStage(opts, 'scope_diff_manifest', () =>
    resolveScope({
      root: opts.root,
      branch: opts.branch,
      base: opts.base,
      scopeInputs: opts.scopeInputs,
    })
  );
  const { input } = scope;

  // The fingerprint of the inputs THIS build actually saw. Computed from the
  // build's resolved scope (the projection deep-strips derivedManifestHash, so a
  // populated full-build value hashes identically to the preamble's null), so it
  // equals what resolveScopeInputs produced for this captured tree state.
  const fingerprint = await computeFloorFingerprint({
    input: scope.input,
    fingerprintMaxDiffBytes: scope.fingerprintMaxDiffBytes,
    reviewMaxDiffBytes: scope.reviewMaxDiffBytes,
    reviewIncludedUntracked: scope.reviewIncludedUntracked,
    disclosures: scope.disclosures,
  });

  // Chain over all checkpoints on the branch.
  const descriptors: CheckpointDescriptor[] = input.artifacts.flatMap((a) =>
    a.checkpoints.map((cp) => ({
      artifact: cp.artifact,
      n: cp.n,
      openTreeSha: cp.openTreeSha,
      closeTreeSha: cp.closeTreeSha,
      closedAt: cp.closedAt,
      status: cp.status,
    }))
  );
  const chain = buildChain({
    base: input.baseTreeSha,
    worktree: input.pinnedTreeSha,
    checkpoints: descriptors,
  });

  // Synthesize the lineage and blame it (degrade + disclose on a missing tree).
  let lineOwners: LineOwner[] = [];
  let lineageFailed = false;
  let blameFailed = false;
  // null leaves the on-disk blame cache untouched — the default on a thrown
  // lineage failure, so a transient glitch never wipes accumulated entries.
  let nextBlameCache: BlameCache | null = null;
  await timeBuildStage(opts, 'lineage_blame', async () => {
    try {
      const lineage = await blameLineage(opts.root, chain, scope.reviewDiff, opts.blameCacheDir);
      lineOwners = lineage.lineOwners;
      blameFailed = lineage.blameFailed;
      nextBlameCache = lineage.nextBlameCache;
    } catch {
      lineageFailed = true;
    }
  });

  const rungInputs: CheckpointRungInput[] = input.artifacts.flatMap((a) =>
    orderedCheckpoints(a).map((cp) => ({
      artifact: a.id,
      cp: cp.n,
      hasBoundaryTrees: !lineageFailed && cp.openTreeSha !== null && cp.closeTreeSha !== null,
      hasManifest: cp.manifestHash !== null,
      hasFilesChanged: cp.filesChanged.length > 0,
      manifestTruncated: cp.manifestTruncated,
    }))
  );

  // Integrity feed: stored-vs-derived manifest hashes per closed cp. A cp
  // whose re-derive failed (stored hash present, derived null) is SKIPPED —
  // the comparison would fabricate a mismatch out of a git hiccup. Stored-null
  // cps flow through as verified:null (nothing captured to compare).
  const integrity: ManifestIntegrityInput[] = [];
  // Overlap feed: capture-time window-overlap adjudication, read from the
  // store's persisted evidence (ambiguous + mixed-segment paths).
  const overlapSegments: OverlapSegment[] = [];
  for (const a of input.artifacts) {
    for (const cp of a.checkpoints) {
      if (cp.status !== 'closed') continue;
      // Three outcomes, and the middle one is easy to miss:
      //  (a) DURABLY uncheckable (corrupt sidecar, unreproducible capture options)
      //      → feed it through WITH a reason so the floor says "unverified", not
      //      "verified" and not "mismatch". Same predicate the derive skipped on.
      //  (b) transiently underived (a git hiccup; hash stored, derive null) → skip.
      //      The build is already non-cacheable and will retry; disclosing a hiccup
      //      would cry wolf.
      //  (c) normal → compare stored vs derived.
      const unavailable =
        cp.manifestHash !== null ? integrityUnavailableReason(cp.capturedFingerprint) : undefined;
      if (unavailable !== undefined) {
        integrity.push({
          artifact: a.id,
          cp: cp.n,
          storedManifestHash: cp.manifestHash,
          derivedManifestHash: null,
          unavailableReason: unavailable,
        });
      } else if (!(cp.manifestHash !== null && cp.derivedManifestHash === null)) {
        integrity.push({
          artifact: a.id,
          cp: cp.n,
          storedManifestHash: cp.manifestHash,
          derivedManifestHash: cp.derivedManifestHash,
        });
      }
      if (cp.overlapAmbiguousFiles.length > 0) {
        overlapSegments.push({ kind: 'concurrent', changedFiles: cp.overlapAmbiguousFiles });
      }
    }
  }

  const result = await timeBuildStage(opts, 'attribution', () =>
    attribute({
      chain,
      reviewDiff: scope.reviewDiff,
      reviewDiffTruncated: scope.reviewDiffTruncated,
      reviewMaxDiffBytes: scope.reviewMaxDiffBytes,
      truncationDetail: scope.truncationDetail ?? undefined,
      truncationDiscardedBytes: scope.truncationDiscardedBytes,
      lineOwners,
      rungInputs,
      overlapSegments,
      integrity,
    })
  );

  const { citations, sections } = await timeBuildStage(opts, 'outline', async () => {
    const builtCitations = buildCitations(input.artifacts);

    // Link each checkpoint's OWNED SLICES into its outline checkpoint — a parent
    // hunk may contribute slices to several chapters.
    const sliceRefsByCp = new Map<string, SliceRef[]>();
    for (const item of result.coverage.items) {
      for (const unit of item.units) {
        if (unit.kind !== 'owned_slice') continue;
        const ref = checkpointRef(unit.owner.artifact, unit.owner.cp);
        const refs = sliceRefsByCp.get(ref) ?? [];
        refs.push({ hunkKey: item.hunkKey, slice: unit.slice });
        sliceRefsByCp.set(ref, refs);
      }
    }

    return {
      citations: builtCitations.citations,
      sections: await buildThreads(input.artifacts, {
        sliceRefsByCp,
        citationIdsByCp: builtCitations.byCheckpoint,
      }),
    };
  });

  const parsedFloor = await timeBuildStage(opts, 'assembly', async () => {
    const disclosure = [...result.disclosures, ...scope.disclosures];
    if (lineageFailed) {
      disclosure.push({
        code: DISCLOSURE_CODE.ATTRIBUTION_RUNG_DOWNGRADE,
        message:
          'synthesized-lineage blame failed (a boundary tree object is missing) — per-line attribution degraded to UNEXPLAINED',
      });
    }
    disclosure.push(...detectLargeGaps(result.coverage.items, checkpointFilesUnion(input)));

    // Live-diff truncation is a BLOCKING disclosure (coverageState): the review
    // diff exceeded review.max_diff_bytes and coverage is partial. Emitting it
    // here is what makes silent partial coverage impossible — the two-lane
    // routine surface refuses to mint a payload over a truncated floor.
    if (scope.reviewDiffTruncated) {
      disclosure.push({
        code: DISCLOSURE_CODE.LIVE_DIFF_TRUNCATED,
        message:
          `the live base→pinned review diff exceeded review.max_diff_bytes (${scope.reviewMaxDiffBytes}) ` +
          `and was normalized to a complete-hunk boundary` +
          `${scope.truncationDetail !== null && scope.truncationDetail !== undefined ? ` — ${scope.truncationDetail}` : ''}` +
          `${scope.truncationDiscardedBytes > 0 ? ` (${scope.truncationDiscardedBytes} trailing bytes discarded)` : ''}` +
          ` — review coverage is partial`,
      });
    }

    const floor: Floor = {
      schema_version: FLOOR_SCHEMA_VERSION,
      // Truncation-gated: only a CUT diff makes the retained hunk set an input the
      // trees don't already determine. Untruncated ⇒ null ⇒ hash unchanged.
      input_hash: await computeInputHash(
        input,
        scope.reviewDiffTruncated ? result.coverage.items.map((i) => i.hunkKey) : null
      ),
      generated_at: opts.now,
      scope: {
        branch: input.branch,
        branch_slug: input.branchSlug,
        base_sha: input.baseSha,
        pinned_tree_sha: input.pinnedTreeSha,
        // Passive staleness anchor (NOT in the input hash): the TUI compares this
        // against the live worktree HEAD on the throttled tick to flag a moved
        // worktree, no per-tick write-tree.
        head_sha: input.worktreeHead,
        default_branch: input.defaultBranch,
        artifact_ids: input.artifacts.map((a) => a.id),
        threads: input.artifacts.map((a) => ({
          artifact: a.id,
          branch: a.branch,
          label: a.label,
          first_activity_at: a.firstActivityAt,
        })),
      },
      coverage: result.coverage,
      attribution: {
        active_rung: result.attribution.activeRung,
      },
      integrity: result.integrity.map((r) => ({
        artifact: r.artifact,
        cp: r.cp,
        verified: r.verified,
      })),
      outline: {
        threads: sections,
        unassigned: buildUnassigned(result.coverage.items),
      },
      plan_coverage: buildPlanCoverage(input.artifacts),
      citations,
      landmarks: buildLandmarks(input.artifacts, result.coverage.items),
      disclosure,
    };

    // Schema-valid by construction — parse is the guarantee.
    return floorSchema.parse(floor);
  });

  return {
    floor: parsedFloor,
    reviewDiff: scope.reviewDiff,
    reviewDiffTruncated: scope.reviewDiffTruncated,
    attributionLines: result.attribution.lines,
    fingerprint,
    cacheHealth: {
      reviewDiffOk: scope.cacheHealth.reviewDiffOk,
      truncationStatsFailed: scope.cacheHealth.truncationStatsFailed,
      manifestDeriveFailed: scope.cacheHealth.manifestDeriveFailed,
      lineageFailed,
      blameFailed,
    },
    nextBlameCache,
  };
}
