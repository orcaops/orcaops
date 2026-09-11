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

import { type DiffLinePosition, parseDiffLinePositions } from './diffLines.js';
import { blameFile, blameFileReverse, commitTree } from './git.js';

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
 */
export async function blameLineage(
  cwd: string,
  chain: Chain,
  reviewDiff: Uint8Array
): Promise<LineageResult> {
  // 1. Synthesize base → …segments… as a parented commit chain, keeping the
  //    ordered commit list: delete-side resolution maps "last commit containing
  //    the line" to its child, so chain POSITION matters, not just membership.
  const commitToSegment = new Map<string, number | 'base'>();
  const chainCommits: string[] = [];
  let parent = await commitTree(cwd, chain.base, null, 'seg:base');
  commitToSegment.set(parent, 'base');
  chainCommits.push(parent);
  for (const seg of chain.segments) {
    const commit = await commitTree(cwd, seg.closeTree, parent, `seg:${seg.id}`);
    commitToSegment.set(commit, seg.index);
    chainCommits.push(commit);
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

  // 2. ADDED lines: forward-blame the tip once per changed file (the tip tree
  //    == target tree, so blame's final-line numbers match the diff).
  const blameByFile = new Map<string, Map<number, string>>();
  for (const file of new Set(added.map((p) => p.file))) {
    const result = await blameFile(cwd, tip, file);
    if (!result.ok) blameFailed = true;
    blameByFile.set(file, result.map);
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
      const result = await blameFileReverse(cwd, base, tip, file);
      if (!result.ok) blameFailed = true;
      reverseByFile.set(file, result.map);
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
  return { lineOwners, tipTree: chain.worktree, blameFailed };
}
