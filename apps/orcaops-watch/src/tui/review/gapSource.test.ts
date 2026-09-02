import { describe, expect, it } from 'vitest';

import type { FileSourceFetcher, FileSourceSide } from '@orcaops/diff-render';

import { applyFileGaps, type GapStores } from './gapSource';
import { SourceTooLargeError } from '../../data/treeSource';

const EMPTY: GapStores = { expandedGaps: new Map(), sourceStatusByFile: new Map() };

/** A fetcher that COUNTS its calls — "exactly once" is the whole contract here. */
function fetcher(result: () => Promise<string | null>): FileSourceFetcher & { calls: number } {
  const spy = {
    calls: 0,
    getFullText(_side: FileSourceSide): Promise<string | null> {
      spy.calls += 1;
      return result();
    },
  };
  return spy;
}

/** Drive one expansion, recording every store the app was asked to render. */
async function open(
  input: {
    stores?: GapStores;
    gaps: string[];
    opened?: boolean;
    fetch?: FileSourceFetcher;
    isCurrent?: () => boolean;
  } = { gaps: [] }
): Promise<{ frames: GapStores[]; errors: string[]; last: GapStores }> {
  const frames: GapStores[] = [];
  const errors: string[] = [];
  await applyFileGaps({
    stores: input.stores ?? EMPTY,
    file: 'src/a.ts',
    gaps: new Set(input.gaps),
    opened: input.opened ?? true,
    fetcher: input.fetch,
    side: 'new',
    onStores: (next) => frames.push(next),
    onError: (message) => errors.push(message),
    isCurrent: input.isCurrent,
  });
  return { frames, errors, last: frames[frames.length - 1] ?? input.stores ?? EMPTY };
}

describe('expanding a gap', () => {
  it('writes the whole gap set once, then fetches the source exactly once', async () => {
    const source = fetcher(() => Promise.resolve('one\ntwo\n'));

    // The Z case: twenty gaps open together. It must not be twenty writes and
    // twenty fetches — `setFileGaps` exists precisely so the bulk open is ONE
    // store write, and the status map dedups the fetch.
    const gaps = Array.from({ length: 20 }, (_unused, i) => `before:${i}`);
    const { frames, last } = await open({ gaps, fetch: source });

    expect(source.calls).toBe(1);
    expect(last.expandedGaps.get('src/a.ts')?.size).toBe(20);
    // Three frames: the gap write, `loading`, then `loaded`. Not twenty-two.
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.sourceStatusByFile.get('src/a.ts'))).toEqual([
      undefined,
      { kind: 'loading' },
      { kind: 'loaded', text: 'one\ntwo\n' },
    ]);
  });

  it('does not refetch a file whose source is already loaded', async () => {
    const source = fetcher(() => Promise.resolve('body\n'));
    const first = await open({ gaps: ['before:0'], fetch: source });
    expect(source.calls).toBe(1);

    const { last } = await open({
      stores: first.last,
      gaps: ['before:0', 'before:1'],
      fetch: source,
    });

    expect(source.calls).toBe(1); // still one — the cached status short-circuits it
    expect(last.sourceStatusByFile.get('src/a.ts')).toEqual({ kind: 'loaded', text: 'body\n' });
    expect(last.expandedGaps.get('src/a.ts')?.size).toBe(2);
  });

  it('retries after a failure, because an error is not a cached answer', async () => {
    let attempt = 0;
    const source = fetcher(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('pin pruned')) : Promise.resolve('back\n');
    });

    const failed = await open({ gaps: ['before:0'], fetch: source });
    expect(failed.last.sourceStatusByFile.get('src/a.ts')).toEqual({ kind: 'error' });
    expect(failed.errors).toEqual(['pin pruned']); // the reviewer is told why

    const retried = await open({
      stores: failed.last,
      gaps: ['before:0', 'before:1'],
      fetch: source,
    });
    expect(source.calls).toBe(2);
    expect(retried.last.sourceStatusByFile.get('src/a.ts')).toEqual({
      kind: 'loaded',
      text: 'back\n',
    });
  });

  it('maps the size cap to a quiet too-large status, with no notice', async () => {
    // The status row already says "too large" in place. A modal notice on top of
    // it would be the app saying the same thing twice.
    const source = fetcher(() => Promise.reject(new SourceTooLargeError(9_000_000, 1_048_576)));
    const { last, errors } = await open({ gaps: ['before:0'], fetch: source });

    expect(last.sourceStatusByFile.get('src/a.ts')).toEqual({ kind: 'error', reason: 'too-large' });
    expect(errors).toEqual([]);
  });

  it('treats a missing side as an error, not as empty context', async () => {
    // getFullText resolves null when the side has no file (a pure add or delete).
    // Rendering that as zero lines of context would be a lie about the source.
    const source = fetcher(() => Promise.resolve(null));
    const { last } = await open({ gaps: ['before:0'], fetch: source });

    expect(last.sourceStatusByFile.get('src/a.ts')).toEqual({ kind: 'error' });
  });
});

describe('what must NOT fetch', () => {
  it('closing a gap never fetches', async () => {
    const source = fetcher(() => Promise.resolve('body\n'));
    const { last } = await open({ gaps: [], opened: false, fetch: source });

    expect(source.calls).toBe(0);
    expect(last.expandedGaps.has('src/a.ts')).toBe(false); // empty set drops the entry
  });

  it('a review with no pinned source writes the gap set and stays silent', async () => {
    // No fetcher at all. The store still records what the reviewer opened, so the
    // expansion rows render their own "no source" state instead of nothing.
    const { frames, last, errors } = await open({ gaps: ['before:0'], fetch: undefined });

    expect(frames).toHaveLength(1);
    expect(last.expandedGaps.get('src/a.ts')).toEqual(new Set(['before:0']));
    expect(last.sourceStatusByFile.size).toBe(0);
    expect(errors).toEqual([]);
  });

  it('drops a settle that lands after the review reloaded underneath it', async () => {
    // The fetch is async; a reload can land first. Applying the stale text would
    // paint one review's source into another's diff.
    const source = fetcher(() => Promise.resolve('stale\n'));
    const { frames } = await open({
      gaps: ['before:0'],
      fetch: source,
      isCurrent: () => false,
    });

    // The gap write and `loading` are synchronous and already on screen; only the
    // settle is discarded.
    expect(frames).toHaveLength(2);
    expect(frames.at(-1)!.sourceStatusByFile.get('src/a.ts')).toEqual({ kind: 'loading' });
  });

  it('drops a stale fetch error and its notice after the review reloads', async () => {
    const source = fetcher(() => Promise.reject(new Error('old review failure')));
    const { frames, errors } = await open({
      gaps: ['before:0'],
      fetch: source,
      isCurrent: () => false,
    });

    expect(frames).toHaveLength(2);
    expect(frames.at(-1)!.sourceStatusByFile.get('src/a.ts')).toEqual({ kind: 'loading' });
    expect(errors).toEqual([]);
  });
});
