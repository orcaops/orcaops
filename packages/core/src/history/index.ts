export { BOOTSTRAP_CHECKOUT_LOCATIONS } from './presence.js';
export { readSelectedHistoryCatalog } from './presence.js';
export type { BootstrapPresence, BootstrapPresenceCheck, HistoryCatalog } from './presence.js';

export { createHistoryRepo } from './repository.js';
export { ProvenanceRepository } from './provenance-target.js';
export type {
  ProvenanceTarget,
  ProvenanceTargetInput,
  ProvenanceReachability,
} from './provenance-target.js';
export { createCanonicalCloudClient } from '../cloud/canonical-client.js';

export { collectRetainedProvenanceCandidates } from './provenance-candidates.js';
export type {
  ProvenanceCandidate,
  ProvenanceCandidates,
  ProvenanceIssue,
  ProvenancePlanSupport,
  RetainedProvenanceArtifact,
  RetainedProvenanceSource,
} from './provenance-candidates.js';
export { resolveProvenance } from './provenance-resolver.js';
export type { ProvenanceMatch, ProvenanceResolution } from './provenance-resolver.js';
export { provenanceSeedGuidance } from './provenance-guidance.js';
export type { ProvenanceCoverage } from './provenance-guidance.js';

export { inspectManagedGitRefs } from './managed-git-ref-inspection.js';
export type { ManagedGitRefObservation } from './managed-git-ref-inspection.js';
