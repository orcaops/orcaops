// The gap-expansion EFFECT: the store writes and the lazy source fetch that an
// expand kicks off.
//
// `gapExpansion.ts` is the pure store shape; `navigation.ts` decides WHICH gaps
// to open. This is the third piece — what happens when they open — and it lives
// apart from ReviewApp for one reason: the fetch is the part that can be wrong
// in ways a render assertion cannot see. "Expanding a gap fetches the file's
// source exactly once, transitions loading → loaded, and never refetches" is a
// statement about effects, not pixels, so the fetcher is a parameter and the
// test injects it.
//
// Keeping it out of ReviewApp is what makes that testable: an inline fetch inside
// the component can only be exercised through a render, which is exactly the
// assertion that cannot see it.

import type { FileSourceFetcher, FileSourceStatus } from '@orcaops/diff-render';

import {
  type ExpandedGaps,
  failedSourceStatus,
  setFileGaps,
  settledSourceStatus,
  shouldFetchSource,
  type SourceStatusByFile,
  withSourceStatus,
} from './gapExpansion';

/** The two expansion stores, moved as one so a caller cannot update half of them. */
export interface GapStores {
  readonly expandedGaps: ExpandedGaps;
  readonly sourceStatusByFile: SourceStatusByFile;
}

export interface ApplyFileGapsInput {
  stores: GapStores;
  file: string;
  /** The file's WHOLE next gap set — one write, whether one gap opened or twenty. */
  gaps: ReadonlySet<string>;
  /** True when this change OPENED at least one gap (a close never fetches). */
  opened: boolean;
  /** The file's source fetcher, or undefined when the review has no pinned tree. */
  fetcher: FileSourceFetcher | undefined;
  /** Which side of the diff the expansion reads context from. */
  side: 'old' | 'new';
  /** Applied synchronously for the store write, then again when the fetch settles. */
  onStores: (next: GapStores) => void;
  /** A fetch failure the reviewer must see. The size cap stays quiet — its own row says so. */
  onError?: (message: string) => void;
  /**
   * Guards against a settle landing after the review reloaded underneath it. The
   * caller compares its own epoch; a mismatch drops the update on the floor.
   */
  isCurrent?: () => boolean;
}

/**
 * Write the file's gap set, and — only when this OPENED something, only when a
 * fetcher exists, and only from cold or after a failure — fetch the expansion
 * side's full text once. `shouldFetchSource` is what makes a second `z` on the
 * same file free: `loading` already has one in flight and `loaded` is cached.
 *
 * Resolves when the fetch settles (or immediately when none was needed), so a
 * test can await the whole effect rather than poll for it.
 */
export async function applyFileGaps(input: ApplyFileGapsInput): Promise<void> {
  const { file, stores } = input;
  const afterWrite: GapStores = {
    expandedGaps: setFileGaps(stores.expandedGaps, file, input.gaps),
    sourceStatusByFile: stores.sourceStatusByFile,
  };
  input.onStores(afterWrite);

  if (
    !input.opened ||
    input.fetcher === undefined ||
    !shouldFetchSource(afterWrite.sourceStatusByFile.get(file))
  ) {
    return;
  }

  const loading: GapStores = {
    ...afterWrite,
    sourceStatusByFile: withSourceStatus(afterWrite.sourceStatusByFile, file, { kind: 'loading' }),
  };
  input.onStores(loading);

  const settle = (status: FileSourceStatus): void => {
    if (input.isCurrent?.() === false) return; // superseded by a reload
    input.onStores({
      expandedGaps: loading.expandedGaps,
      sourceStatusByFile: withSourceStatus(loading.sourceStatusByFile, file, status),
    });
  };

  try {
    settle(settledSourceStatus(await input.fetcher.getFullText(input.side)));
  } catch (error) {
    const status = failedSourceStatus(error);
    settle(status);
    if (input.isCurrent?.() === false) return;
    // The size cap already renders its own `too-large` row; anything else (a
    // pruned pin, an unreadable blob) carries a remediation message worth saying.
    if (!(status.kind === 'error' && status.reason === 'too-large')) {
      input.onError?.(error instanceof Error ? error.message : String(error));
    }
  }
}
