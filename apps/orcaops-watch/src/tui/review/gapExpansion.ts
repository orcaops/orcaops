// Pure state helpers for gap expansion — per-file gap sets that `z` and clicks
// toggle, plus a tagged per-file source status — and the transitions ReviewApp's
// fetch path applies. Kept out of ReviewApp so the toggle/transition rules are
// headless-testable; the single-writer store itself stays in ReviewApp.

import { type FileSourceStatus, gapKey } from '@orcaops/diff-render';

import { SourceTooLargeError } from '../../data/treeSource';

/** file → the set of expanded gap keys (gapKey(position, hunkIndex) spellings). */
export type ExpandedGaps = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * PATCH space: one entry of `diff.metadata.hunks`, whose ARRAY POSITION *is* the
 * patch hunk index every gap key is spelled with.
 *
 * `space` is a discriminant, not data. A floor coverage item also carries a
 * `collapsedBefore`, so without it a floor array would satisfy this shape
 * structurally and mint gap keys against floor ordinals — keys that match no
 * row, so the expand silently does nothing. The discriminant makes the swap a
 * compile error instead.
 */
export interface PatchGapHunk {
  readonly space: 'patch';
  readonly collapsedBefore: number;
}

/** file → load status of that file's expansion-side full source text. */
export type SourceStatusByFile = ReadonlyMap<string, FileSourceStatus>;

/**
 * Toggle one gap. Only the touched file's set is replaced (empty sets are
 * dropped), so untouched files keep referential identity — the render memos
 * and geometry cache keys downstream lean on that.
 */
export function toggleFileGap(map: ExpandedGaps, file: string, gap: string): ExpandedGaps {
  const next = new Map(map);
  const gaps = new Set(map.get(file) ?? []);
  if (gaps.has(gap)) gaps.delete(gap);
  else gaps.add(gap);
  if (gaps.size === 0) next.delete(file);
  else next.set(file, gaps);
  return next;
}

/**
 * Replace one file's WHOLE gap set — the bulk (`Z`) write. `toggleFileGap` is a
 * toggle, so looping it to open N gaps would clone the map and re-measure the
 * checkpoint layout N times. Empty sets drop the entry, and untouched files keep
 * referential identity, exactly as the toggle does.
 */
export function setFileGaps(
  map: ExpandedGaps,
  file: string,
  gaps: ReadonlySet<string>
): ExpandedGaps {
  const next = new Map(map);
  if (gaps.size === 0) next.delete(file);
  else next.set(file, new Set(gaps));
  return next;
}

/**
 * Every gap key a file can offer, in patch space: a leading gap for each hunk
 * that hides context above it, plus the file's trailing gap on the LAST patch
 * hunk (the index `pierre.ts` actually stamps on that row).
 *
 * `resolvable` is the set of patch indices some rendered display hunk hosts. A
 * gap row only exists inside its hunk's body, so a gap on an index no display
 * hunk resolves to is unreachable — emitting its key would put inert state in
 * the store whose `sourceStatus` can never settle.
 */
export function allGapKeys(
  hunks: readonly PatchGapHunk[],
  hasTrailingGap: boolean,
  resolvable: ReadonlySet<number>
): ReadonlySet<string> {
  const keys = new Set<string>();
  hunks.forEach((hunk, index) => {
    if (hunk.collapsedBefore > 0 && resolvable.has(index)) keys.add(gapKey('before', index));
  });
  const last = hunks.length - 1;
  if (hasTrailingGap && last >= 0 && resolvable.has(last)) keys.add(gapKey('trailing', last));
  return keys;
}

/** Is this gap currently expanded? */
export function fileHasGap(map: ExpandedGaps, file: string, gap: string): boolean {
  return map.get(file)?.has(gap) ?? false;
}

/**
 * Should an expand kick off a fetch? Only from cold or after a failure —
 * `loading` has one in flight and `loaded` is cached (the fetcher memoizes
 * too; this guard just prevents status flicker back to `loading`).
 */
export function shouldFetchSource(status: FileSourceStatus | undefined): boolean {
  return status === undefined || status.kind === 'error';
}

/** A resolved fetch → status: null means the side has no file (added/deleted). */
export function settledSourceStatus(text: string | null): FileSourceStatus {
  return text === null ? { kind: 'error' } : { kind: 'loaded', text };
}

/** A rejected fetch → status: the size cap maps to the 'too-large' row copy. */
export function failedSourceStatus(error: unknown): FileSourceStatus {
  return error instanceof SourceTooLargeError
    ? { kind: 'error', reason: 'too-large' }
    : { kind: 'error' };
}

/** Replace one file's status, leaving the rest identity-stable. */
export function withSourceStatus(
  map: SourceStatusByFile,
  file: string,
  status: FileSourceStatus
): SourceStatusByFile {
  const next = new Map(map);
  next.set(file, status);
  return next;
}
