import { createHash } from 'node:crypto';

import type { ReviewPullRecord } from '@orcaops/storage';

import type {
  PlanReviewPersistence,
  RefAlias,
} from '../../src/commands/plan/review/persistence.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export function createMemoryPlanReviewPersistence(): PlanReviewPersistence {
  const candidates = new Map<string, ReviewPullRecord>();
  const proposals = new Map<string, ReviewPullRecord>();
  const aliases = new Map<string, RefAlias[]>();
  return {
    preflight: async () => undefined,
    readCandidate: async (externalId) => structuredClone(candidates.get(externalId) ?? null),
    readProposal: async (externalId, proposalId) => {
      const record = proposals.get(proposalId);
      return record?.external_id === externalId ? structuredClone(record) : null;
    },
    writeRecord: async (record) => {
      if (record.target === 'candidate')
        candidates.set(record.external_id, structuredClone(record));
      else proposals.set(record.proposal_id!, structuredClone(record));
    },
    // Newest first, so a caller taking the first entry rather than the newest
    // `pulledAt` is caught rather than flattered.
    readRefAliases: async (ref) => [...(aliases.get(ref) ?? [])].reverse(),
    writeRefAlias: async ({ ref, externalId, pulledAt }) => {
      const recorded = aliases.get(ref) ?? [];
      const seen = recorded.find((alias) => alias.externalId === externalId);
      if (seen === undefined) aliases.set(ref, [...recorded, { externalId, pulledAt }]);
      else if (pulledAt > seen.pulledAt) seen.pulledAt = pulledAt;
    },
  };
}

export interface SeedCandidateOpts {
  versionId: string;
  versionNumber: number;
  externalId?: string;
  baseUrl?: string;
  orgId?: string;
  body?: string;
  pulledAt?: string;
}

/** Seed a candidate review-pull record so the propose/push CAS base resolves. */
export async function seedCandidate(
  persistence: PlanReviewPersistence,
  opts: SeedCandidateOpts
): Promise<void> {
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
    pulled_at: opts.pulledAt ?? '2026-06-09T00:00:00.000Z',
  };
  await persistence.writeRecord(record);
}

export interface SeedProposalOpts {
  proposalId: string;
  externalId?: string;
  baseUrl?: string;
  orgId?: string;
  body?: string;
}

/** Seed a proposal review-pull record so `comment --proposal` can target it. */
export async function seedProposal(
  persistence: PlanReviewPersistence,
  opts: SeedProposalOpts
): Promise<void> {
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
  await persistence.writeRecord(record);
}
