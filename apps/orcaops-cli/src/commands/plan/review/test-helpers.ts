import { createHash } from 'node:crypto';

import { type ReviewPullRecord, sourcePlanCacheDir, writeReviewPullRecord } from '@orcaops/storage';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface SeedCandidateOpts {
  versionId: string;
  versionNumber: number;
  externalId?: string;
  baseUrl?: string;
  orgId?: string;
  body?: string;
}

/** Seed a candidate review-pull record so the propose/push CAS base resolves. */
export async function seedCandidate(repoRoot: string, opts: SeedCandidateOpts): Promise<void> {
  const body = opts.body ?? 'seed candidate body';
  const record: ReviewPullRecord = {
    schema_version: 1,
    target: 'candidate',
    external_id: opts.externalId ?? 'ext-1',
    version_id: opts.versionId,
    version_number: opts.versionNumber,
    proposal_id: null,
    base_version_number: null,
    content_hash: sha(body),
    body,
    base_url: opts.baseUrl ?? 'https://cloud.example',
    org_id: opts.orgId ?? 'org_1',
    pulled_at: '2026-06-09T00:00:00.000Z',
  };
  await writeReviewPullRecord(sourcePlanCacheDir(repoRoot), record);
}

export interface SeedProposalOpts {
  proposalId: string;
  externalId?: string;
  baseUrl?: string;
  orgId?: string;
  body?: string;
}

/** Seed a proposal review-pull record so `comment --proposal` can target it. */
export async function seedProposal(repoRoot: string, opts: SeedProposalOpts): Promise<void> {
  const body = opts.body ?? 'seed proposal body';
  const record: ReviewPullRecord = {
    schema_version: 1,
    target: 'proposal',
    external_id: opts.externalId ?? 'ext-1',
    version_id: null,
    version_number: null,
    proposal_id: opts.proposalId,
    base_version_number: 4,
    content_hash: sha(body),
    body,
    base_url: opts.baseUrl ?? 'https://cloud.example',
    org_id: opts.orgId ?? 'org_1',
    pulled_at: '2026-06-09T00:00:00.000Z',
  };
  await writeReviewPullRecord(sourcePlanCacheDir(repoRoot), record);
}
