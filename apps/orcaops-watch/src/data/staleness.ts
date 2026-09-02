// Passive staleness probe for the review TUI's Brief. A floor is a snapshot of
// the worktree at build time; between builds the reviewer's worktree can move
// (HEAD advances, files change) and the floor silently goes stale. This module
// gives the throttled live tick a CHEAP, READ-ONLY way to notice — `git
// rev-parse HEAD` + `git status --porcelain` only, NEVER a write-tree, so the
// passive banner mints zero git objects per tick (the active `R` rebuild is
// the only path that re-pins the tree).
//
// A review's own journal/comment writes cannot self-trigger the dirty signal:
// they land under `.orcaops/reviews/<slug>/`, which
// `.gitignore` ignores — the managed `.orcaops/reviews/` line plus the
// `**/.orcaops/` glob (see apps/orcaops-cli/src/lib/gitignore.ts
// ORCAOPS_BASE_GITIGNORE, mirrored into the repo-root .gitignore). `git status
// --porcelain` never reports ignored paths, and the pinned tree came from
// `add -A` (which also skips ignored paths), so a review writing its own ledger
// can never self-trigger the dirty signal — the tree and `git status` agree on
// `.orcaops/reviews/` by construction. We use `-unormal` (the default), NOT
// `-uno`: the pinned tree includes untracked files, so a brand-new untracked
// source file DID change the tree and must count as dirty (`-uno` would go
// silent on exactly that case).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeProbe {
  /** `git rev-parse HEAD`, or null when unresolvable (unborn/detached/not a repo). */
  headSha: string | null;
  /** sha1 of `git status --porcelain -unormal` output ('' when the probe failed). */
  porcelainDigest: string;
}

/**
 * Read-only worktree probe: the current HEAD commit + a digest of the working
 * tree's dirty state. Both spawns read only (no write-tree). A failed probe
 * degrades to `{ headSha: null, porcelainDigest: '' }` — the banner simply does
 * not fire rather than crashing the review.
 */
export async function readWorktreeProbe(root: string): Promise<WorktreeProbe> {
  const [headSha, porcelainDigest] = await Promise.all([
    revParseHead(root),
    porcelainStatusDigest(root),
  ]);
  return { headSha, porcelainDigest };
}

async function revParseHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

async function porcelainStatusDigest(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-unormal'], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
    });
    return createHash('sha1').update(stdout).digest('hex');
  } catch {
    return '';
  }
}

/**
 * A client-side, disclosure-SHAPED staleness row. Its `code` is NOT a floor
 * DISCLOSURE_CODE — it is synthesized in the TUI, appended to the Brief's TRUST
 * band alongside the persisted `floor.disclosure` rows, and NEVER written back
 * to the floor.
 */
export interface StalenessRow {
  code: 'floor_stale';
  message: string;
}

export interface StalenessInput {
  /**
   * The floor's build-time HEAD (`floor.scope.head_sha`). The floor schema
   * requires the key; null means the producer could not resolve HEAD
   * (detached/unborn) — never an absent field.
   */
  floorHeadSha: string | null;
  /** The live worktree HEAD from `readWorktreeProbe`. */
  currentHeadSha: string | null;
  /** The porcelain digest captured at floor-LOAD time (the dirty-state baseline). */
  loadDigest: string | null;
  /** The live porcelain digest from `readWorktreeProbe`. */
  currentDigest: string | null;
}

/**
 * Pure staleness verdict from the two cheap signals. Returns a disclosure-shaped
 * ⚠ row for the Brief's TRUST band, or null when nothing moved. Each signal is
 * gated on BOTH sides being known, so a null head_sha (unresolvable HEAD at
 * build time) or a failed probe degrades to "not stale" rather than a false
 * alarm:
 *   1. HEAD moved  — floor's build-time HEAD vs the live worktree HEAD.
 *   2. tree moved  — the load-time porcelain digest vs the live one (the floor
 *                    stores no dirty digest, so the baseline is captured at load).
 */
export function computeFloorStaleness(input: StalenessInput): StalenessRow | null {
  const headMoved =
    input.floorHeadSha != null &&
    input.currentHeadSha != null &&
    input.floorHeadSha !== input.currentHeadSha;
  const treeMoved =
    input.loadDigest != null &&
    input.currentDigest != null &&
    input.loadDigest !== input.currentDigest;
  if (!headMoved && !treeMoved) return null;
  const what =
    headMoved && treeMoved
      ? 'HEAD moved and the working tree changed'
      : headMoved
        ? 'HEAD moved'
        : 'the working tree changed';
  return {
    code: 'floor_stale',
    message: `${what} since this review was built — press R to rebuild`,
  };
}
