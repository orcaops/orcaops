import type { ArtifactState, ArtifactStatus } from '@orcaops/storage';

export function fallbackState(status: ArtifactStatus): ArtifactState {
  return status === 'complete' ? 'summarized' : 'active';
}
