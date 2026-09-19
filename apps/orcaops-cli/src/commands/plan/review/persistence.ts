import type { ReviewPullRecord } from '@orcaops/storage';

export interface RefAlias {
  externalId: string;
  pulledAt: string;
}

export interface PlanReviewPersistence {
  preflight(): Promise<void>;
  readCandidate(externalId: string): Promise<ReviewPullRecord | null>;
  readProposal(externalId: string, proposalId: string): Promise<ReviewPullRecord | null>;
  writeRecord(record: ReviewPullRecord, options?: { preserveEquivalent?: boolean }): Promise<void>;
  /** Advisory — a damaged alias reads as absent. Order is meaningless; recency is `pulledAt`. */
  readRefAliases(ref: string): Promise<readonly RefAlias[]>;
  writeRefAlias(alias: RefAlias & { ref: string }): Promise<void>;
}
