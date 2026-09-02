import {
  type ArtifactStore,
  type ArtifactStorePreparationResult,
  prepareArtifactStoreForRead,
} from '@orcaops/storage';

export class ReviewProjectionIncompleteError extends Error {
  readonly code = 'REVIEW_PROJECTION_INCOMPLETE';

  constructor(
    readonly operation: 'review scope' | 'claim ledger',
    readonly preparation: ArtifactStorePreparationResult
  ) {
    const detail = preparation.issue
      ? `${preparation.issue.kind}: ${preparation.issue.message}`
      : `projection health is ${preparation.projectionHealth}`;
    super(
      `${operation} requires a complete artifact projection (${detail}). ` +
        'Run `orcaops doctor`, repair or explicitly remove unreadable durable sources, ' +
        'then run `orcaops rebuild` before retrying.'
    );
    this.name = 'ReviewProjectionIncompleteError';
  }
}

export async function requireCompleteArtifactStore(
  store: ArtifactStore,
  operation: 'review scope' | 'claim ledger'
): Promise<ArtifactStorePreparationResult> {
  const preparation = await prepareArtifactStoreForRead({ store });
  if (preparation.issue !== null || preparation.projectionHealth !== 'healthy') {
    throw new ReviewProjectionIncompleteError(operation, preparation);
  }
  return preparation;
}
