// Tree-source fetcher for gap expansion: full file text read from the
// ref-pinned review trees the sidecar writes at `review data` time —
// refs/orcaops/review/<slug> (a commit wrapping the floor's pinned worktree
// tree) for the new side, `<slug>-base` for the old side. Renderer-free (the
// src/data rule) and git-spawning like reviewSource.resolveRoot. The degrade
// contract is split by failure kind: an absent PATH (added/deleted side)
// quietly resolves null, while a missing/pruned REF throws
// PinnedSourceUnavailableError — the loud end the ReviewApp surfaces verbatim.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { FileSourceFetcher, FileSourceSide } from '@orcaops/diff-render';

const execFileAsync = promisify(execFile);

/** The loud remediation line shown when a review ref (or its objects) is gone. */
export const PRUNED_SOURCE_MESSAGE = 'pinned tree pruned — re-run `orcaops review data`';

/** The review ref is missing or its objects are unreadable — re-pin to recover. */
export class PinnedSourceUnavailableError extends Error {
  constructor() {
    super(PRUNED_SOURCE_MESSAGE);
    this.name = 'PinnedSourceUnavailableError';
  }
}

/** The side's blob exceeds the fetch cap — maps to the 'too-large' status row. */
export class SourceTooLargeError extends Error {
  constructor(size: number, maxBytes: number) {
    super(`source is ${size} bytes — over the ${maxBytes}-byte expansion cap`);
    this.name = 'SourceTooLargeError';
  }
}

export interface TreeSourceOptions {
  /** Repo root the review refs live in. */
  root: string;
  /** The review's branch slug — the ref namespace key. */
  slug: string;
  /** New-side path (DiffFile.path). */
  path: string;
  /** Old-side path when the file was renamed (metadata.prevName). */
  prevPath?: string;
  /** Per-side byte cap; larger blobs reject with SourceTooLargeError. */
  maxBytes?: number;
}

/** Run git in the repo; stdout on exit 0, null on any non-zero exit. */
async function git(root: string, args: string[], maxBuffer: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer });
    return String(stdout);
  } catch {
    return null;
  }
}

/**
 * A FileSourceFetcher over the two ref-pinned review trees. Per-side results
 * are cached in the closure (the fetcher lives as long as its DiffFile);
 * failures stay uncached so a re-pin can succeed on the next attempt.
 */
export function createTreeSourceFetcher(opts: TreeSourceOptions): FileSourceFetcher {
  const { root, slug, path, prevPath, maxBytes = 1_000_000 } = opts;
  const cache = new Map<FileSourceSide, string | null>();

  async function fetchSide(side: FileSourceSide): Promise<string | null> {
    const ref = side === 'new' ? `refs/orcaops/review/${slug}` : `refs/orcaops/review/${slug}-base`;
    const target = side === 'new' ? path : (prevPath ?? path);
    // 1. The ref must peel to a tree. An older floor never pinned one, and a
    //    pruned/corrupt pin commit lands here too — both are the LOUD degrade.
    const tree = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], 4096);
    if (tree === null) throw new PinnedSourceUnavailableError();
    // 2. Size probe doubles as the existence check: an absent path (the old
    //    side of an added file, the new side of a deleted one) resolves null.
    const size = await git(root, ['cat-file', '-s', `${ref}:${target}`], 4096);
    if (size === null) return null;
    const bytes = Number(size.trim());
    if (bytes > maxBytes) throw new SourceTooLargeError(bytes, maxBytes);
    // 3. The ref resolved and the path exists, so an unreadable blob here is a
    //    pruned/corrupt object — loud, like the missing ref.
    const blob = await git(root, ['cat-file', 'blob', `${ref}:${target}`], maxBytes + 65_536);
    if (blob === null) throw new PinnedSourceUnavailableError();
    return blob;
  }

  return {
    async getFullText(side: FileSourceSide): Promise<string | null> {
      if (cache.has(side)) return cache.get(side) ?? null;
      const text = await fetchSide(side);
      cache.set(side, text);
      return text;
    },
  };
}
