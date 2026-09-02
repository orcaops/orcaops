import type { RebuildPlanIdempotencyResult } from './rebuild-plan-idempotency.js';
import { rebuildCache, type RebuildResult } from './rebuild.js';
import type { ProjectionHealth } from './sqlite.js';
import {
  type ArtifactDeletionReconciliation,
  type ArtifactStore,
  reconcileArtifactDeletionStaging,
} from '../artifacts/store.js';

export type ArtifactStorePreparationIssueKind =
  | 'deletion_reconciliation_failed'
  | 'projection_rebuild_failed';

export interface ArtifactStorePreparationIssue {
  kind: ArtifactStorePreparationIssueKind;
  message: string;
  cause: unknown;
}

export interface ArtifactStorePreparationResult {
  projectionHealth: ProjectionHealth;
  reconciliation: ArtifactDeletionReconciliation | null;
  rebuild: RebuildResult | null;
  issue: ArtifactStorePreparationIssue | null;
}

export async function prepareArtifactStoreForRead(opts: {
  store: ArtifactStore;
  onPlanIdempotencyConflicts?: (conflicts: RebuildPlanIdempotencyResult['conflicts']) => void;
}): Promise<ArtifactStorePreparationResult> {
  const { store } = opts;
  let reconciliation: ArtifactDeletionReconciliation;
  try {
    reconciliation = await reconcileArtifactDeletionStaging({
      repoRoot: store.repoRoot,
      config: store.config,
      store: store.store,
    });
  } catch (error) {
    return resultWithIssue(store, null, null, 'deletion_reconciliation_failed', error);
  }

  let rebuild: RebuildResult | null = null;
  if (store.store.needsProjectionRebuild) {
    try {
      rebuild = await rebuildCache({
        repoRoot: store.repoRoot,
        config: store.config,
        store: store.store,
        onPlanIdempotencyConflicts: opts.onPlanIdempotencyConflicts,
      });
    } catch (error) {
      return resultWithIssue(store, reconciliation, null, 'projection_rebuild_failed', error);
    }
  }

  return {
    projectionHealth: store.store.projectionHealth,
    reconciliation,
    rebuild,
    issue: null,
  };
}

function resultWithIssue(
  store: ArtifactStore,
  reconciliation: ArtifactDeletionReconciliation | null,
  rebuild: RebuildResult | null,
  kind: ArtifactStorePreparationIssueKind,
  cause: unknown
): ArtifactStorePreparationResult {
  return {
    projectionHealth: store.store.projectionHealth,
    reconciliation,
    rebuild,
    issue: {
      kind,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    },
  };
}
