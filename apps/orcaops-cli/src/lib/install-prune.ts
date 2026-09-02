import type { Stats } from 'node:fs';
import { lstat, readFile, readlink, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { extractStamp, isVersionAhead, type PlannedFile } from '@orcaops/adapters';
import { assertCanonicalRelativePath, assertResolvedWithin, sha256Hex } from '@orcaops/storage';

import {
  diffInstallManifests,
  type InstallEntry,
  type InstallManifest,
  type LocalEntry,
  type LocalManifest,
  type OwnershipKind,
  reconstructLocalManifest,
} from './install-manifest.js';
import { deleteMutation, type PlannedMutation } from './mutations.js';

export interface PlanOrphanPruneInput {
  repoRoot: string;
  prefix: string;
  /** Prior committed manifest — orphan candidates are `prev − next`. Null = nothing to diff. */
  prevInstall: InstallManifest | null;
  /** Freshly-planned committed manifest (the new desired path set). */
  nextInstall: InstallManifest;
  /** Prior local manifest, or null → reconstruct before applying guards. */
  prevLocal: LocalManifest | null;
  /** Freshly-planned generated files — the reconstruct fallback's current generation. */
  genFiles: PlannedFile[];
  currentVersion: string;
}

export type PrunePreservedReason =
  | 'user-edited'
  | 'pre-existing'
  | 'unverifiable'
  | 'managed-block';

export interface PrunePreserved {
  path: string;
  kind: OwnershipKind;
  reason: PrunePreservedReason;
}

export interface PruneResult {
  /** Delete mutations for orphans that passed the deleteMode/hash guard. */
  mutations: PlannedMutation[];
  /** Repo-relative paths the prune will remove. */
  deleted: string[];
  /** Orphans left in place, with the reason (surfaced in output). */
  preserved: PrunePreserved[];
  /**
   * The preserved orphans whose stamp is NEWER than this CLI — reported as
   * `pre-existing` in `preserved` (ownership unproven) and surfaced here so
   * the caller's `preserved_ahead` output carries the upgrade advice.
   */
  preservedAhead: { path: string; stampedVersion: string }[];
}

const entryKey = (kind: OwnershipKind, p: string): string => `${kind} ${p}`;

/**
 * The disposition of one owned manifest entry under the per-entry `deleteMode`
 * guard, independent of WHO is removing it. `prune` maps `confirm` → leave +
 * report; `uninstall` collects `confirm` for explicit confirmation (`--force`).
 * `absent` means the on-disk artifact is already gone — nothing to do.
 */
export type GuardDisposition =
  | { kind: 'delete'; mutation: PlannedMutation }
  | { kind: 'preserve'; reason: PrunePreservedReason }
  | { kind: 'confirm' }
  | { kind: 'absent' };

/**
 * Decide whether a single owned manifest entry is safe to delete — the shared
 * delete-safety guard behind BOTH orphan-prune and uninstall, so the two can
 * never diverge. The caller skips `gitignore-entry` kinds (their removal
 * is structural, not hash-guarded). Rules:
 *
 *   - no local entry → preserve `unverifiable` (can't prove ownership);
 *   - a real `injected-block` (materialization !== 'symlink') → preserve
 *     `managed-block` — the block lives inside a user file, so excising it is
 *     the instruction layer's job, never a host-file delete;
 *   - `deleteMode 'never'` → preserve (`pre-existing` or `user-edited`);
 *   - `deleteMode 'confirm'` (unverifiable reconstructed ownership) → `confirm`, unless
 *     a generated file was replaced by a non-file entry;
 *   - `deleteMode 'hash'`: a symlink is deletable only while it still points at
 *     its recorded target; a file only when on-disk == `expectedHash`; an
 *     already-gone path is `absent`;
 *   - a generated file stamped NEWER than `currentVersion` → preserve
 *     `pre-existing`, regardless of deleteMode: a NEWER CLI's own manifest
 *     records hashes its bytes match, so hash-match (or forced confirmation)
 *     alone must never grant an older CLI deletion authority over ahead state.
 */
export async function evaluateEntryDeleteGuard(
  repoRoot: string,
  entry: InstallEntry,
  le: LocalEntry | undefined,
  currentVersion: string
): Promise<GuardDisposition> {
  if (!le) return { kind: 'preserve', reason: 'unverifiable' };

  // A real managed block lives inside a user file — never rm the host.
  if (entry.kind === 'injected-block' && le.materialization !== 'symlink') {
    return { kind: 'preserve', reason: 'managed-block' };
  }

  if (le.deleteMode === 'never') {
    if (le.provenance === 'pre-existing') return { kind: 'preserve', reason: 'pre-existing' };
    // An adopted/never entry can hold AHEAD bytes (a newer CLI preserves a
    // same-version user edit as adopted/never): classify by stamp so the
    // report never calls ahead state user-edited.
    if (entry.kind === 'generated-file') {
      assertCanonicalRelativePath(entry.path, 'install entry path');
      const neverInspected = await inspectInstallEntry(repoRoot, entry.path);
      if (
        neverInspected.stats?.isFile() === true &&
        (await installEntryIsAhead(repoRoot, neverInspected.abs, entry.path, currentVersion))
      ) {
        return { kind: 'preserve', reason: 'pre-existing' };
      }
    }
    return { kind: 'preserve', reason: 'user-edited' };
  }
  assertCanonicalRelativePath(entry.path, 'install entry path');
  let inspected: { abs: string; stats: Stats | null } | null = null;
  if (le.deleteMode === 'confirm') {
    if (entry.kind !== 'generated-file') return { kind: 'confirm' };
    inspected = await inspectInstallEntry(repoRoot, entry.path);
    if (inspected.stats === null) return { kind: 'absent' };
    if (!inspected.stats.isFile()) return { kind: 'preserve', reason: 'user-edited' };
    if (await installEntryIsAhead(repoRoot, inspected.abs, entry.path, currentVersion)) {
      return { kind: 'preserve', reason: 'pre-existing' };
    }
    return { kind: 'confirm' };
  }

  // deleteMode === 'hash': delete only when on-disk matches the recorded state.
  inspected ??= await inspectInstallEntry(repoRoot, entry.path);
  const { abs, stats: st } = inspected;
  if (st === null) return { kind: 'absent' };

  if (le.materialization === 'symlink') {
    if (st.isSymbolicLink()) {
      const target = await readlink(abs).catch(() => null);
      // A null recorded target can NEVER authorize hash-mode deletion: with no
      // recorded target there is no ownership evidence to match, and treating
      // absence as a wildcard would let a corrupt or reconstructed entry
      // delete an arbitrary same-path symlink. Strict readers reject the
      // shape on disk, but in-memory reconstruction can still produce it.
      if (le.symlinkTarget != null && target === le.symlinkTarget) {
        return {
          kind: 'delete',
          mutation: deleteMutation(
            repoRoot,
            entry.path,
            { kind: 'symlink', target: le.symlinkTarget },
            true
          ),
        };
      }
    }
    // null-target / replaced by a real file / re-pointed → not ours to delete
    return { kind: 'preserve', reason: 'user-edited' };
  }

  if (st.isSymbolicLink() || !st.isFile()) {
    return { kind: 'preserve', reason: 'user-edited' };
  }
  const safeReadPath = assertResolvedWithin(abs, repoRoot, `install entry ${entry.path}`, {
    rejectSymlinks: true,
  });
  let onDisk: string | null;
  try {
    onDisk = await readFile(safeReadPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    onDisk = null;
  }
  if (onDisk === null) return { kind: 'absent' }; // already gone
  if (
    entry.kind === 'generated-file' &&
    isVersionAhead(extractStamp(onDisk).version, currentVersion)
  ) {
    return { kind: 'preserve', reason: 'pre-existing' };
  }
  if (le.expectedHash !== null && sha256Hex(onDisk) === le.expectedHash) {
    return {
      kind: 'delete',
      mutation: deleteMutation(repoRoot, entry.path, { kind: 'file', content: onDisk }, true),
    };
  }
  return { kind: 'preserve', reason: 'user-edited' };
}

/** True when the regular file at `abs` carries a stamp NEWER than `currentVersion`. */
async function installEntryIsAhead(
  repoRoot: string,
  abs: string,
  entryPath: string,
  currentVersion: string
): Promise<boolean> {
  const safeReadPath = assertResolvedWithin(abs, repoRoot, `install entry ${entryPath}`, {
    rejectSymlinks: true,
  });
  const onDisk = await readFile(safeReadPath, 'utf8').catch(() => null);
  return onDisk !== null && isVersionAhead(extractStamp(onDisk).version, currentVersion);
}

async function inspectInstallEntry(
  repoRoot: string,
  relativePath: string
): Promise<{ abs: string; stats: Stats | null }> {
  const declaredPath = path.join(repoRoot, relativePath);
  const parent = assertResolvedWithin(
    path.dirname(declaredPath),
    repoRoot,
    `install entry ${relativePath} parent`,
    { allowRoot: true, rejectSymlinks: true }
  );
  const abs = path.join(parent, path.basename(declaredPath));
  try {
    return { abs, stats: await lstat(abs) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { abs, stats: null };
  }
}

/**
 * Diff the prior committed manifest against the freshly-planned one and emit
 * hash-guarded delete mutations for the orphans (owned entries present before,
 * gone now). Reconstruct the local manifest first when it is absent (fresh clone
 * in `commit` mode has the committed manifest but no local one), then apply the
 * per-entry `deleteMode` guard:
 *
 *   - `hash` → delete only when on-disk == `expectedHash` (a symlink entry is
 *     removed only when it still points at its recorded target);
 *   - `never` (user-edited / pre-existing) and `confirm` (unverifiable
 *     reconstructed ownership) → leave + report, never auto-prune.
 *
 * A real `injected-block` lives INSIDE a user's instruction file, so it is NEVER
 * file-deleted here (excising the block is the instruction layer's job); only a
 * symlink-materialized instruction file is a whole-path delete. `gitignore-entry`
 * orphans are never pruned (that is uninstall's job).
 */
export async function planOrphanPrune(input: PlanOrphanPruneInput): Promise<PruneResult> {
  const { repoRoot, prevInstall, nextInstall, prevLocal, genFiles, currentVersion } = input;
  const result: PruneResult = { mutations: [], deleted: [], preserved: [], preservedAhead: [] };
  if (!prevInstall) return result;

  const { removed } = diffInstallManifests(prevInstall, nextInstall);
  if (removed.length === 0) return result;

  // Reconstruct-if-absent BEFORE the guards: a removed generated-file is absent
  // from `genFiles`, so reconstruction treats it as pre-existing and preserves it
  // because orcaops cannot prove ownership without a local hash.
  const local =
    prevLocal ?? (await reconstructLocalManifest(repoRoot, prevInstall, genFiles, currentVersion));
  const byKey = new Map<string, LocalEntry>(
    local.entries.map((e) => [entryKey(e.kind, e.path), e])
  );

  for (const entry of removed) {
    if (entry.kind === 'gitignore-entry') continue;

    // An ahead-stamped file is an "orphan" only to this older CLI's template
    // set, and a newer-CLI-written local manifest makes the hash guard below
    // pass — preserve what this binary cannot verify. Non-regular and
    // symlinked entries fall through to the guard's own classification.
    if (entry.kind === 'generated-file') {
      assertCanonicalRelativePath(entry.path, 'install entry path');
      const { abs, stats } = await inspectInstallEntry(repoRoot, entry.path);
      if (stats !== null && stats.isFile()) {
        const safeReadPath = assertResolvedWithin(abs, repoRoot, `install entry ${entry.path}`, {
          rejectSymlinks: true,
        });
        const onDisk = await readFile(safeReadPath, 'utf8').catch(() => null);
        const onDiskStamp = onDisk === null ? null : extractStamp(onDisk).version;
        if (onDiskStamp !== null && isVersionAhead(onDiskStamp, currentVersion)) {
          // `pre-existing`, not `unverifiable`: D3 reserves `unverifiable` for
          // missing fingerprints, and an ahead stamp is a KNOWN newer state
          // whose remedy (upgrade) travels via preservedAhead.
          result.preserved.push({ path: entry.path, kind: entry.kind, reason: 'pre-existing' });
          result.preservedAhead.push({ path: entry.path, stampedVersion: onDiskStamp });
          continue;
        }
      }
    }

    const le = byKey.get(entryKey(entry.kind, entry.path));
    const g = await evaluateEntryDeleteGuard(repoRoot, entry, le, currentVersion);
    switch (g.kind) {
      case 'delete':
        result.mutations.push(g.mutation);
        result.deleted.push(entry.path);
        break;
      case 'preserve':
        result.preserved.push({ path: entry.path, kind: entry.kind, reason: g.reason });
        break;
      case 'confirm':
        // Prune's historical disposition: leave + report as unverifiable.
        // (uninstall acts on a `confirm` entry under --force instead.)
        result.preserved.push({ path: entry.path, kind: entry.kind, reason: 'unverifiable' });
        break;
      case 'absent':
        break; // on-disk artifact already gone — nothing to do
    }
  }

  return result;
}

/**
 * After deletes land, remove now-empty prefix-scoped dirs: the per-skill dirs
 * `${skillsDir}/${prefix}-<id>` and the command namespace dir
 * `${commandRoot}/${prefix}`. Derived from the deleted paths' PARENT dirs and
 * filtered by the prefix predicate, non-recursive — so it can never remove
 * `${skillsDir}` / `${commandRoot}` themselves or any non-orcaops directory.
 * `ENOTEMPTY` (a user file still lives there) and `ENOENT` are ignored. Accepts
 * MULTIPLE prefixes so a prefix CHANGE cleans both the old `<old>-*`
 * dirs being pruned and the new `<new>-*` dirs in one pass.
 */
export async function rmdirEmptyManagedDirs(
  repoRoot: string,
  prefixes: string[],
  deletedPaths: string[]
): Promise<string[]> {
  const removed: string[] = [];
  const dirs = new Set<string>();
  for (const rel of deletedPaths) {
    const parent = path.dirname(rel);
    const base = path.basename(parent);
    if (prefixes.some((p) => base.startsWith(`${p}-`) || base === p)) dirs.add(parent);
  }
  for (const rel of dirs) {
    try {
      assertCanonicalRelativePath(rel, 'managed directory path');
      const target = assertResolvedWithin(
        path.join(repoRoot, rel),
        repoRoot,
        `managed directory ${rel}`,
        { rejectSymlinks: true }
      );
      await rmdir(target);
      removed.push(rel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw err;
    }
  }
  return removed;
}
