import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { assertSafePathSegment } from '../paths/containment.js';

/**
 * Archive path resolution. Two roots with different lifecycles:
 *
 * - **Data root** (precious): the append-only NDJSON archive + registry.
 *   `$ORCAOPS_DATA_DIR` → `$XDG_DATA_HOME/orcaops` → `~/.orcaops`.
 * - **Index root** (disposable): per-project SQLite indexes, lock dirs, and
 *   a `CACHEDIR.TAG` so backup tools skip it.
 *   `$XDG_CACHE_HOME/orcaops/archive-index` → `~/.orcaops/index-cache`.
 * - **Checkouts root** (disposable): scratch worktrees materialized
 *   from snapshot refs by `orcaops snapshots checkout`, `CACHEDIR.TAG`'d at
 *   the root (never inside a checkout — a checkout must mirror its pinned
 *   tree exactly). `$XDG_CACHE_HOME/orcaops/checkouts` → `~/.orcaops/checkouts-cache`.
 *
 * Every function takes `env` (+ optional `home`) parameters rather than
 * reading `process.env` — the pin-store convention — so the CLI threads
 * `getInvocationEnv()` through and tests stay hermetic by construction.
 */

/** Resolve the precious archive data root. */
export function archiveRoot(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const override = env.ORCAOPS_DATA_DIR?.trim();
  if (override) return override;
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return path.join(xdg, 'orcaops');
  return path.join(home, '.orcaops');
}

/** Resolve the disposable index/cache root (never inside the archive tree). */
export function indexRoot(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg) return path.join(xdg, 'orcaops', 'archive-index');
  return path.join(archiveRoot(env, home), 'index-cache');
}

/**
 * Resolve the disposable scratch-checkouts root (snapshot
 * materialization). Same tier chain as `indexRoot`: cache-classified under
 * `$XDG_CACHE_HOME` when set, else a clearly-disposable sibling inside the
 * data root. Never inside the live worktree — a materialized checkout must
 * not be swept into the next snapshot's tree.
 */
export function checkoutsRoot(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg) return path.join(xdg, 'orcaops', 'checkouts');
  return path.join(archiveRoot(env, home), 'checkouts-cache');
}

/** `<dataRoot>/projects.json` — the self-healing registry (hints, never keys). */
export function registryPath(dataRoot: string): string {
  return path.join(dataRoot, 'projects.json');
}

/** `<dataRoot>/projects/<project-id>` — one dir per minted project identity. */
export function archiveProjectDir(dataRoot: string, projectId: string): string {
  // Stored git-config values and CLI selectors both land here; a traversal
  // in the id must never move the project dir outside <dataRoot>/projects/.
  assertSafePathSegment(projectId, 'project id');
  return path.join(dataRoot, 'projects', projectId);
}

/**
 * Per-artifact archive paths. Mirrors the hot `ArtifactPaths` event-log
 * shape (events.ndjson + sidecars/) — repair is rsync-shaped by design —
 * plus `derivedDir` for cached `fingerprint derive` outputs, which
 * are checksummed files, NOT events.
 */
export interface ArchiveArtifactPaths {
  dir: string;
  eventsNdjson: string;
  sidecarsDir: string;
  derivedDir: string;
}

export function archiveArtifactPaths(projectDir: string, artifactId: string): ArchiveArtifactPaths {
  assertSafePathSegment(artifactId, 'artifact id');
  const dir = path.join(projectDir, 'artifacts', artifactId);
  return {
    dir,
    eventsNdjson: path.join(dir, 'events.ndjson'),
    sidecarsDir: path.join(dir, 'sidecars'),
    derivedDir: path.join(dir, 'derived'),
  };
}

/**
 * Per-review-thread archive paths. Review logs are namespaced by the complete
 * hot review-state version: event schemas are not backward-compatible, so an
 * older archive must never be replayed into a newer live directory.
 */
export interface ArchiveReviewPaths {
  dir: string;
  journalNdjson: string;
  commentsNdjson: string;
}

export function archiveReviewPaths(
  projectDir: string,
  reviewStateVersion: number,
  slug: string
): ArchiveReviewPaths {
  if (!Number.isInteger(reviewStateVersion) || reviewStateVersion < 1)
    throw new Error(`invalid review state version: ${reviewStateVersion}`);
  const dir = path.join(projectDir, 'reviews', `v${reviewStateVersion}`, slug);
  return {
    dir,
    journalNdjson: path.join(dir, 'journal.ndjson'),
    commentsNdjson: path.join(dir, 'comments.ndjson'),
  };
}

/** Per-project usage-ledger mirror paths (mirrors the hot `.orcaops/usage` layout). */
export interface ArchiveUsageLedgerPaths {
  ledgerNdjson: string;
  sidecarsDir: string;
}

export function archiveUsageLedgerPaths(projectDir: string): ArchiveUsageLedgerPaths {
  return {
    ledgerNdjson: path.join(projectDir, 'usage', 'ledger.ndjson'),
    sidecarsDir: path.join(projectDir, 'usage', 'sidecars'),
  };
}

/**
 * Archive-side lock dirs live under the DISPOSABLE index root, never the
 * precious tree — locks are ephemeral coordination state and must not be
 * carried by backups or file-sync of the archive.
 */
export function archiveLocksDir(indexRootDir: string, projectId: string): string {
  return path.join(indexRootDir, 'locks', projectId);
}

/** Per-project index DB + its incremental-refresh high-water sidecar. */
export function projectIndexDbPath(indexRootDir: string, projectId: string): string {
  return path.join(indexRootDir, `${projectId}.db`);
}

export function projectIndexMetaPath(indexRootDir: string, projectId: string): string {
  return path.join(indexRootDir, `${projectId}.meta.json`);
}

/**
 * mkdir -p with a 0700 posture. The mkdir `mode` is umask-masked (can only
 * narrow), so an explicit chmod follows — pre-existing loose dirs get
 * tightened rather than trusted. No-op chmod on win32 (mode bits are
 * meaningless there; doctor skips the perms check too).
 */
export async function ensureDir0700(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(dir, 0o700);
  }
}

/**
 * The canonical CACHEDIR.TAG payload (https://bford.info/cachedir/).
 * Written at the INDEX root only — the archive tree must never contain
 * one, or backup tools would skip the precious data.
 */
const CACHEDIR_TAG_CONTENT =
  'Signature: 8a477f597d28d172789f06886806bc55\n' +
  '# This file is a cache directory tag created by orcaops.\n' +
  '# For information about cache directory tags, see https://bford.info/cachedir/\n';

export async function writeCachedirTag(indexRootDir: string): Promise<void> {
  await ensureDir0700(indexRootDir);
  const tagPath = path.join(indexRootDir, 'CACHEDIR.TAG');
  // Idempotent-cheap: the tag content never changes, and this runs on
  // every archive-enabled invocation (lock dirs live under the index
  // root, so the root must be classified the moment it exists).
  try {
    await access(tagPath);
    return;
  } catch {
    // missing — write it
  }
  await writeFile(tagPath, CACHEDIR_TAG_CONTENT, { flag: 'w' });
}
