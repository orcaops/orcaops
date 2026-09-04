import { ArtifactStore } from './store.js';
import type { Config } from '../schema/index.js';
import { Store } from '../store/sqlite.js';

/**
 * An enabled worktree that has never captured is a valid, empty hot source.
 * Serving it through the normal constructor would CREATE the cache file, and
 * read preparation would create the locks directory — writes a read path
 * must not make in a checkout the user has not captured in. The empty
 * projection lives in memory instead; nothing on disk changes.
 */
export const EMPTY_PROJECTION_DB = ':memory:';

export function openEmptyArtifactStore(repoRoot: string, config: Config): ArtifactStore {
  return new ArtifactStore({
    repoRoot,
    config,
    store: new Store(EMPTY_PROJECTION_DB),
    ownsStore: true,
  });
}

/** True for a store opened by {@link openEmptyArtifactStore}: skip preparation, it has nothing to reconcile. */
export function isEmptyProjection(store: ArtifactStore): boolean {
  return store.store.dbPath === EMPTY_PROJECTION_DB;
}
