// Synthesize a parented commit lineage from the
// chain's ordered boundary trees, then blame it to compute each changed line's
// owning segment — forward blame at the tip for ADDED lines (the tip's tree
// equals the pinned target, so final-line numbers align with the review diff's
// new-file numbers), and REVERSE blame over base..tip for DELETED lines (the
// reported sha is the last commit still containing the line; its CHILD in the
// linear chain is the segment that deleted it). Every changed line resolves to
// exactly one segment (checkpoint or gap); base-owned adds drop out, and lines
// the reverse blame can't place degrade to unowned — never a wrong owner.

import { lineHash } from '@orcaops/review-core';
import type { Chain, LineOwner } from '@orcaops/review-core';

import {
  type BlameCache,
  blameKey,
  type BlameSide,
  loadBlameCache,
  renameInvolvedPaths,
  type SegmentNameStatus,
  touchingSegShas,
} from './blameCache.js';
import { type DiffLinePosition, parseDiffLinePositions } from './diffLines.js';
import {
  blameFile,
  blameFileReverse,
  type BlameResult,
  commitTree,
  nameStatus,
  revParseBlob,
} from './git.js';

export interface LineageResult {
  lineOwners: LineOwner[];
  /** The synthesized tip commit's tree — must equal the pinned target tree. */
  tipTree: string;
  /**
   * True when ANY per-file forward/reverse blame command failed (git exit != 0),
   * even though lineage synthesis itself succeeded. A failed blame leaves a
   * file's lines unowned — a recoverable degradation the whole-floor and blame
   * caches must not persist. Distinct from a thrown `commit-tree` failure, which
   * the caller catches as `lineageFailed`.
   */
  blameFailed: boolean;
  /**
   * The blame cache to persist after this build (reused + newly computed entries),
   * or null to leave the on-disk cache UNTOUCHED — null when caching wasn't
   * requested (no `blameCacheDir`) OR a segment name-status failed (an incomplete
   * classification could misclassify a rename-involved path, so the whole cache is
   * disabled for the build rather than risk a wrong owner). The caller installs it
   * atomically inside the commit lock; blameLineage never writes the filesystem.
   */
  nextBlameCache: BlameCache | null;
}

const encoder = new TextEncoder();

async function hashBody(pos: DiffLinePosition): Promise<string> {
  return lineHash(pos.side, encoder.encode(pos.body));
}

/**
 * Build the synthesized lineage and blame it into per-line owners for the
 * review diff's added AND deleted lines. Pure git work; throws only if
 * `commit-tree` fails (a missing tree object) so the caller can degrade +
 * disclose.
 *
 * When `blameCacheDir` is given, per-file blame is memoized across builds: each
 * file's blame is keyed on its side-specific blob plus the ordered synthesized
 * commits of the segments that touch it, so a file unchanged since the last build
 * — even after an appended checkpoint — reuses its cached blame instead of paying
 * the git-blame cost again. Rename/copy-involved paths conservatively bypass the
 * cache (exact-path membership is unsafe across renames), and a failed blame is
 * never cached. The returned `nextBlameCache` is installed by the caller.
 */
export async function blameLineage(
  cwd: string,
  chain: Chain,
  reviewDiff: Uint8Array,
  blameCacheDir?: string
): Promise<LineageResult> {
  // 1. Synthesize base → …segments… as a parented commit chain, keeping the
  //    ordered commit list: delete-side resolution maps "last commit containing
  //    the line" to its child, so chain POSITION matters, not just membership.
  //    When caching, also capture each segment's hermetic name-status paired with
  //    its synthesized commit sha (the "which segments touch a path" signal).
  const wantCache = blameCacheDir !== undefined;
  const commitToSegment = new Map<string, number | 'base'>();
  const chainCommits: string[] = [];
  const segNameStatus: SegmentNameStatus[] = [];
  let nameStatusFailed = false;
  let parent = await commitTree(cwd, chain.base, null, 'seg:base');
  commitToSegment.set(parent, 'base');
  chainCommits.push(parent);
  for (const seg of chain.segments) {
    const commit = await commitTree(cwd, seg.closeTree, parent, `seg:${seg.id}`);
    commitToSegment.set(commit, seg.index);
    chainCommits.push(commit);
    if (wantCache) {
      const ns = await nameStatus(cwd, seg.openTree, seg.closeTree);
      if (!ns.ok) nameStatusFailed = true;
      segNameStatus.push({ commitSha: commit, entries: ns.entries });
    }
    parent = commit;
  }
  const tip = parent;
  const base = chainCommits[0];
  const positionOfCommit = new Map(chainCommits.map((c, i) => [c, i] as const));

  const positions = parseDiffLinePositions(reviewDiff);
  const added = positions.filter((p) => p.side === 'add');
  const deleted = positions.filter((p) => p.side === 'delete');
  const lineOwners: LineOwner[] = [];
  let blameFailed = false;

  // The cache is usable only when opted in AND every segment's name-status
  // parsed — an incomplete classification could misclassify a rename-involved
  // path as stable. When disabled, `next` stays null so the caller leaves
  // the existing on-disk cache untouched rather than overwriting it with nothing.
  const cacheEnabled = wantCache && !nameStatusFailed;
  const prev: BlameCache = cacheEnabled ? await loadBlameCache(blameCacheDir) : new Map();
  const next: BlameCache | null = cacheEnabled ? new Map() : null;
  const renameInvolved = cacheEnabled ? renameInvolvedPaths(segNameStatus) : new Set<string>();

  // Blame `file`, reusing/recording the content-addressed cache when eligible.
  // `anchorCommit` is the commit whose tree the keying blob is read from: the tip
  // for adds (the path exists there), the base for deletes (a deleted/renamed old
  // path exists only at base). A rename/copy-involved path, an unresolvable blob,
  // or a failed blame all fall back to (and never cache) a plain blame.
  const cachedBlame = async (
    side: BlameSide,
    file: string,
    anchorCommit: string,
    run: () => Promise<BlameResult>
  ): Promise<Map<number, string>> => {
    if (next === null || renameInvolved.has(file)) {
      const r = await run();
      if (!r.ok) blameFailed = true;
      return r.map;
    }
    const blob = await revParseBlob(cwd, anchorCommit, file);
    if (blob === null) {
      const r = await run();
      if (!r.ok) blameFailed = true;
      return r.map;
    }
    const key = await blameKey(side, base, file, blob, touchingSegShas(file, segNameStatus));
    const hit = prev.get(key);
    if (hit !== undefined) {
      next.set(key, hit);
      return hit;
    }
    const r = await run();
    if (!r.ok) {
      blameFailed = true;
      return r.map; // a failed blame is never cached
    }
    next.set(key, r.map);
    return r.map;
  };

  // 2. ADDED lines: forward-blame the tip once per changed file (the tip tree
  //    == target tree, so blame's final-line numbers match the diff).
  const blameByFile = new Map<string, Map<number, string>>();
  for (const file of new Set(added.map((p) => p.file))) {
    blameByFile.set(file, await cachedBlame('add', file, tip, () => blameFile(cwd, tip, file)));
  }
  for (const pos of added) {
    const sha = blameByFile.get(pos.file)?.get(pos.line);
    if (sha === undefined) continue;
    const segment = commitToSegment.get(sha);
    if (segment === undefined || segment === 'base') continue;
    lineOwners.push({
      file: pos.coverageFile,
      side: 'add',
      line: pos.line,
      segment,
      lineHash: await hashBody(pos),
    });
  }

  // 3. DELETED lines: reverse-blame base..tip once per OLD path (delete
  //    positions carry old-file numbering and the old path; a rename's blame
  //    needs that old path while coverage keys the hunk by the NEW one —
  //    hence `coverageFile` on the emitted owner). Skipping rules:
  //      · no blame row           → blame failed/misaligned; leave unowned
  //      · sha not a chain commit → defensive; leave unowned
  //      · sha is the tip         → the line SURVIVES; nothing deleted it
  //      · child at position 0    → unreachable ('base' is position 0), typed out
  if (deleted.length > 0 && chainCommits.length > 1) {
    const reverseByFile = new Map<string, Map<number, string>>();
    for (const file of new Set(deleted.map((p) => p.file))) {
      reverseByFile.set(
        file,
        await cachedBlame('delete', file, base, () => blameFileReverse(cwd, base, tip, file))
      );
    }
    for (const pos of deleted) {
      const sha = reverseByFile.get(pos.file)?.get(pos.line);
      if (sha === undefined) continue;
      const at = positionOfCommit.get(sha);
      if (at === undefined) continue;
      if (at + 1 >= chainCommits.length) continue; // survived to tip — not a deletion
      const segment = commitToSegment.get(chainCommits[at + 1]);
      if (segment === undefined || segment === 'base') continue;
      lineOwners.push({
        file: pos.coverageFile,
        side: 'delete',
        line: pos.line,
        segment,
        lineHash: await hashBody(pos),
      });
    }
  }

  // tipTree is chain.worktree by construction (last segment's closeTree).
  return { lineOwners, tipTree: chain.worktree, blameFailed, nextBlameCache: next };
}
