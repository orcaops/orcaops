// Persistent per-file blame memo for the incremental review-floor rebuild.
// Content-addressed: a key encodes everything that determines a file's blame
// (side, base commit, path, that side's blob, and the ordered synthesized
// segment commits that touch the path), so a stale entry can never be served —
// a changed input yields a different key and simply misses. Colocated with the
// floor at .orcaops/reviews/<slug>/blame-cache.json and re-serialized wholesale
// each build, so it self-prunes to what the latest floor references.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { stableHash64 } from '@orcaops/review-core';
import { atomicWriteFile } from '@orcaops/storage';

import type { NameStatusEntry } from './git.js';

const BLAME_CACHE_VERSION = 'blame.v1';
const CACHE_FILE = 'blame-cache.json';
const SHA_RE = /^[0-9a-f]{40}$/;

export type BlameSide = 'add' | 'delete';

/** A per-file blame result: line number → owning-commit sha. */
export type BlameMap = Map<number, string>;

/**
 * Content-addressed key for one file's blame on one side. `touchingSegShas` are
 * the synthesized commit shas of the chain segments that touch `filePath`, in
 * chain order — the base commit plus that ordered set fully determine which
 * segment owns each line, so two different chains can never collide on one key.
 * The blob is side-specific: the tip blob for adds (the path exists at the tip),
 * the base blob for deletes (a deleted/renamed old path exists only at base).
 */
export function blameKey(
  side: BlameSide,
  baseCommit: string,
  filePath: string,
  blobSha: string,
  touchingSegShas: readonly string[]
): Promise<string> {
  return stableHash64(`orcaops.review.${BLAME_CACHE_VERSION}`, [
    side,
    baseCommit,
    filePath,
    blobSha,
    ...touchingSegShas,
  ]);
}

/** Per-segment name-status paired with that segment's synthesized commit sha. */
export interface SegmentNameStatus {
  commitSha: string;
  entries: readonly NameStatusEntry[];
}

/**
 * Every old/new path involved in a rename or copy anywhere in the chain. A path
 * in this set is NOT cacheable — exact-path segment membership is unsafe across
 * renames (a final path may have been touched earlier under another name), so
 * the caller recomputes its blame rather than risk a wrong owner.
 */
export function renameInvolvedPaths(segments: readonly SegmentNameStatus[]): Set<string> {
  const involved = new Set<string>();
  for (const seg of segments) {
    for (const e of seg.entries) {
      if (e.status === 'R' || e.status === 'C') {
        involved.add(e.path);
        if (e.oldPath !== null) involved.add(e.oldPath);
      }
    }
  }
  return involved;
}

/** Synthesized commit shas of the segments that touch `filePath`, in chain order. */
export function touchingSegShas(
  filePath: string,
  segments: readonly SegmentNameStatus[]
): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.entries.some((e) => e.path === filePath || e.oldPath === filePath)) {
      out.push(seg.commitSha);
    }
  }
  return out;
}

// ---- on-disk cache ----

/**
 * The in-memory blame cache: content-addressed key → blame map. Loaded from and
 * re-serialized to blame-cache.json wholesale each build.
 */
export type BlameCache = Map<string, BlameMap>;

interface BlameCacheFile {
  version: string;
  blame: Record<string, [number, string][]>;
}

/**
 * Read + structurally validate the on-disk cache. Absent, unreadable, wrong
 * version, or ANY structurally-invalid entry → an empty cache (never throws,
 * never trusts partial data). A single bad tuple discards the whole file: a
 * corrupt cache is not worth salvaging partially, and a full rebuild is cheap.
 */
export async function loadBlameCache(dir: string): Promise<BlameCache> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, CACHE_FILE), 'utf8'));
  } catch {
    return new Map();
  }
  if (
    raw === null ||
    typeof raw !== 'object' ||
    (raw as BlameCacheFile).version !== BLAME_CACHE_VERSION ||
    typeof (raw as BlameCacheFile).blame !== 'object' ||
    (raw as BlameCacheFile).blame === null
  ) {
    return new Map();
  }
  const out: BlameCache = new Map();
  for (const [key, rows] of Object.entries((raw as BlameCacheFile).blame)) {
    if (!Array.isArray(rows)) return new Map();
    const map: BlameMap = new Map();
    for (const row of rows) {
      if (
        !Array.isArray(row) ||
        row.length !== 2 ||
        typeof row[0] !== 'number' ||
        !Number.isInteger(row[0]) ||
        typeof row[1] !== 'string' ||
        !SHA_RE.test(row[1])
      ) {
        return new Map(); // structurally invalid → discard entirely
      }
      map.set(row[0], row[1]);
    }
    out.set(key, map);
  }
  return out;
}

/** Serialize the cache to blame-cache.json atomically. */
export async function saveBlameCache(
  dir: string,
  cache: BlameCache,
  containmentRoot: string
): Promise<void> {
  const blame: Record<string, [number, string][]> = {};
  for (const [key, map] of cache) {
    blame[key] = [...map.entries()];
  }
  const file: BlameCacheFile = { version: BLAME_CACHE_VERSION, blame };
  await atomicWriteFile(path.join(dir, CACHE_FILE), `${JSON.stringify(file)}\n`, containmentRoot);
}
