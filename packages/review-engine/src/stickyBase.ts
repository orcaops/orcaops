// Sticky per-branch base. An operator who passes an explicit
// `--base <ref>` has made a scope decision for the branch; a later bare
// `review data` must not silently re-derive against the default branch and
// drift the session.
//
// Semantics, deliberately minimal:
// - Only an EXPLICIT `--base` is recorded. Auto-derived bases (merge-base /
//   oldest-artifact / fallback) stay live so they track branch topology.
// - A bare run reuses the record as the override and the floor carries a
//   `sticky_base_reused` disclosure naming the ref and how to change it.
// - `--base auto` clears the record and re-derives fresh.
// - An unresolvable sticky ref (rebased away, GC'd) is ignored with the same
//   disclosure code so a bare run never hard-fails on stale state.

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from '@orcaops/storage';

import { reviewDirPath } from './reviewPaths.js';

export const STICKY_BASE_AUTO_SENTINEL = 'auto';

export interface StickyBaseRecord {
  schema_version: 1;
  branch: string;
  /** The operator's ref exactly as passed (`--base <ref>`) — display + drift telltale. */
  baseRef: string;
  /**
   * The immutable sha the ref resolved to WHEN RECORDED. This is the
   * AUTHORITY a bare rebuild reuses: a symbolic ref (e.g. `main`) that later
   * advances must not silently move the base while the floor claims reuse.
   */
  pinnedSha: string;
  recordedAt: string;
}

function isStickyBaseRecord(value: unknown): value is StickyBaseRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema_version === 1 &&
    typeof record.branch === 'string' &&
    record.branch.length > 0 &&
    typeof record.baseRef === 'string' &&
    record.baseRef.length > 0 &&
    typeof record.pinnedSha === 'string' &&
    record.pinnedSha.length > 0 &&
    typeof record.recordedAt === 'string' &&
    record.recordedAt.length > 0
  );
}

function stickyBasePath(root: string, branchSlug: string): string {
  return path.join(reviewDirPath(root, branchSlug), 'sticky-base-v1.json');
}

/** Read the record; null on absence or any corruption (never throws). */
export async function readStickyBase(
  root: string,
  branchSlug: string
): Promise<StickyBaseRecord | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(stickyBasePath(root, branchSlug), 'utf8'));
    return isStickyBaseRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function writeStickyBase(
  root: string,
  branchSlug: string,
  record: StickyBaseRecord
): Promise<void> {
  await atomicWriteFile(
    stickyBasePath(root, branchSlug),
    `${JSON.stringify(record, null, 2)}\n`,
    root
  );
}

export async function clearStickyBase(root: string, branchSlug: string): Promise<void> {
  await rm(stickyBasePath(root, branchSlug), { force: true });
}
