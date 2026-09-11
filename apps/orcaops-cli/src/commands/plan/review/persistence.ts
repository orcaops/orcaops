import type { ReviewPullRecord } from '@orcaops/storage';

export interface PlanReviewPersistence {
  preflight(): Promise<void>;
  readCandidate(externalId: string): Promise<ReviewPullRecord | null>;
  readProposal(externalId: string, proposalId: string): Promise<ReviewPullRecord | null>;
  writeRecord(record: ReviewPullRecord, options?: { preserveEquivalent?: boolean }): Promise<void>;
}
