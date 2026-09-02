// Versioned review-state directory.
//
// WHY THIS EXISTS
//
// `.orcaops/reviews/<slug>/` holds two kinds of thing:
//
//   re-derivable  floor.json, diff.patch, attribution.ndjson, and derived caches
//   USER DATA     journal.ndjson (coverage, dispositions, lifecycle),
//                 comments.ndjson
//
// User data is keyed by identities minted from the floor, so every file must
// belong to the same current directory contract. Unsupported state is rejected.
// The explicit repair command resets the directory instead of preserving or
// interpreting any previous bytes.

import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { assertResolvedWithin, atomicWriteFile } from '@orcaops/storage';

/**
 * Version of the on-disk review STATE (the directory as a whole — user data
 * included), distinct from `FLOOR_SCHEMA_VERSION` which versions one file's
 * shape. Bump this whenever previously persisted reviewer state can no longer be
 * interpreted, which is exactly when a key recipe changes.
 *
 * Only the current value is supported. A different value is rejected and must
 * be reset explicitly.
 */
export const REVIEW_STATE_VERSION = 4;

const STATE_MARKER = 'review-state.json';

/** One branch-wide critical section for floor, Story, lifecycle, and repair. */
export function reviewStateLockKey(branchSlug: string): string {
  return `review-floor-${branchSlug}`;
}

export interface ReviewStateInitialization {
  initialized: boolean;
}

interface ReviewStateMarker {
  review_state_version: number;
}

export type ReviewStateVersionHealth =
  | { status: 'ABSENT'; path: string; reason: string }
  | { status: 'HEALTHY'; path: string; version: number }
  | {
      status: 'UNSUPPORTED_SCHEMA' | 'CORRUPT';
      path: string;
      reason: string;
      version: number | null;
    };

export class ReviewStateHealthError extends Error {
  constructor(readonly health: Exclude<ReviewStateVersionHealth, { status: 'HEALTHY' }>) {
    super(
      `${health.status}: ${health.reason}; run \`review state repair --branch <branch>\` to delete incompatible state and initialize current schema ${REVIEW_STATE_VERSION}`
    );
  }
}

async function writeMarker(dir: string, containmentRoot: string): Promise<void> {
  const marker: ReviewStateMarker = { review_state_version: REVIEW_STATE_VERSION };
  await atomicWriteFile(
    path.join(dir, STATE_MARKER),
    `${JSON.stringify(marker)}\n`,
    containmentRoot
  );
}

/** Inspect the directory contract without moving, rewriting, or parsing user state. */
export async function inspectReviewStateVersion(dir: string): Promise<ReviewStateVersionHealth> {
  const markerPath = path.join(dir, STATE_MARKER);
  const entries = await entriesOf(dir);
  if (entries === null || entries.length === 0) {
    return { status: 'ABSENT', path: markerPath, reason: 'review state is not initialized' };
  }
  let text: string;
  try {
    text = await readFile(markerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'UNSUPPORTED_SCHEMA',
        path: markerPath,
        reason: 'review state has no version marker',
        version: null,
      };
    }
    return {
      status: 'CORRUPT',
      path: markerPath,
      reason: error instanceof Error ? error.message : String(error),
      version: null,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      status: 'CORRUPT',
      path: markerPath,
      reason: `review-state marker is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      version: null,
    };
  }
  const version =
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as { review_state_version?: unknown }).review_state_version === 'number'
      ? (raw as { review_state_version: number }).review_state_version
      : null;
  if (version === null || !Number.isInteger(version)) {
    return {
      status: 'CORRUPT',
      path: markerPath,
      reason: 'review-state marker has no integer review_state_version',
      version,
    };
  }
  if (version !== REVIEW_STATE_VERSION) {
    return {
      status: 'UNSUPPORTED_SCHEMA',
      path: markerPath,
      reason: `review-state schema ${version} is unsupported by current schema ${REVIEW_STATE_VERSION}`,
      version,
    };
  }
  return { status: 'HEALTHY', path: markerPath, version };
}

/** Entries in `dir`, or null when it does not exist. */
async function entriesOf(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Bring a fresh directory to `REVIEW_STATE_VERSION`, or verify an existing one.
 * Unsupported/corrupt state is never changed implicitly. MUST be called under
 * the review lock before reads or writes.
 *
 * Throws a typed health error without changing the directory when it is not
 * current and healthy.
 */
export async function ensureReviewStateVersion(
  dir: string,
  containmentRoot: string
): Promise<ReviewStateInitialization> {
  let safeDir = assertResolvedWithin(dir, containmentRoot, 'review state directory', {
    rejectSymlinks: true,
  });
  const health = await inspectReviewStateVersion(safeDir);
  if (health.status === 'HEALTHY') return { initialized: false };
  if (health.status === 'ABSENT') {
    await mkdir(safeDir, { recursive: true });
    safeDir = assertResolvedWithin(dir, containmentRoot, 'review state directory', {
      rejectSymlinks: true,
    });
    await writeMarker(safeDir, containmentRoot);
    return { initialized: true };
  }
  throw new ReviewStateHealthError(health);
}

/** Require an existing current directory without initializing absent state. */
export async function requireReviewStateVersion(dir: string): Promise<void> {
  const health = await inspectReviewStateVersion(dir);
  if (health.status !== 'HEALTHY') throw new ReviewStateHealthError(health);
}

/**
 * Explicit destructive repair. No previous byte is parsed or preserved. If the
 * process stops after removal, the next normal ensure initializes fresh state.
 * The caller must hold the review lock.
 */
export async function resetReviewState(dir: string, containmentRoot: string): Promise<void> {
  let safeDir = assertResolvedWithin(dir, containmentRoot, 'review state reset directory', {
    rejectSymlinks: true,
  });
  await rm(safeDir, { recursive: true, force: true });
  await mkdir(safeDir, { recursive: true });
  safeDir = assertResolvedWithin(dir, containmentRoot, 'review state reset directory', {
    rejectSymlinks: true,
  });
  await writeMarker(safeDir, containmentRoot);
}
