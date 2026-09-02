import { useEffect, useState } from 'react';

import type { SnapshotSource } from '../../data/snapshot';
import type { WatchSnapshot } from '../../data/types';

export interface SnapshotState {
  snapshot: WatchSnapshot | null;
  error: Error | null;
  /** True once at least one snapshot has arrived and the source is healthy. */
  connected: boolean;
}

/** Subscribe to a snapshot source, mirroring its output into React state. */
export function useSnapshot(source: SnapshotSource): SnapshotState {
  const [state, setState] = useState<SnapshotState>({
    snapshot: null,
    error: null,
    connected: false,
  });

  useEffect(() => {
    const stop = source.start({
      onSnapshot: (snapshot) => setState({ snapshot, error: null, connected: true }),
      onError: (error) =>
        setState((prev) => ({ snapshot: prev.snapshot, error, connected: false })),
    });
    return stop;
  }, [source]);

  return state;
}
