import { expect, it } from 'vitest';

import { PullCacheRecordSchema, ReviewPullRecordSchema } from './records.js';

const approved = {
  schema_version: 1 as const,
  external_id: 'plan-1',
  slug: 'plan',
  version_number: 3,
  title: 'Plan',
  body: '# Plan\n',
  content_hash: 'a'.repeat(64),
  source_ref: null,
  base_url: 'https://cloud.example',
  org_id: 'organization',
  pulled_at: '2026-09-09T00:00:00.000Z',
};

const candidate = {
  schema_version: 1 as const,
  target: 'candidate' as const,
  external_id: 'plan-1',
  version_id: 'version-1',
  version_number: 3,
  proposal_id: null,
  base_version_number: null,
  content_hash: 'a'.repeat(64),
  body: '# Candidate\n',
  base_url: 'https://cloud.example',
  org_id: 'organization',
  pulled_at: '2026-09-09T00:00:00.000Z',
};

const proposal = {
  ...candidate,
  target: 'proposal' as const,
  version_id: null,
  version_number: null,
  proposal_id: 'proposal-1',
  base_version_number: 3,
};

it('preserves the approved record shape used by project history', () => {
  expect(PullCacheRecordSchema.parse(approved)).toEqual(approved);
});

it.each([
  ['candidate version id', { ...candidate, version_id: null }],
  ['candidate version number', { ...candidate, version_number: null }],
  ['candidate proposal id', { ...candidate, proposal_id: 'proposal-1' }],
  ['proposal id', { ...proposal, proposal_id: null }],
  ['proposal version id', { ...proposal, version_id: 'version-1' }],
  ['proposal version number', { ...proposal, version_number: 3 }],
])('refuses a review record with invalid %s', (_name, value) => {
  expect(ReviewPullRecordSchema.safeParse(value).success).toBe(false);
});

it('preserves candidate and proposal record shapes used by project history', () => {
  expect(ReviewPullRecordSchema.parse(candidate)).toEqual(candidate);
  expect(ReviewPullRecordSchema.parse(proposal)).toEqual(proposal);
});
