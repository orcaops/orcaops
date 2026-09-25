import { afterEach, expect, it } from 'vitest';

import {
  publishProjectContinuingClaimRevision,
  readProjectContinuingClaim,
} from './knowledge-claims.js';
import { publishProjectSubject } from './knowledge-subjects.js';
import {
  agentReportedObservation,
  BY_AGENT,
  BY_OWNER,
  captureFieldSource,
  counters,
  DETECTOR,
  discardKnowledgeStores,
  OWNER,
  plannedKnowledgeStore,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-17T14:00:00.000Z';
const PASSAGE = 'c'.repeat(64);
const LOCATION = 'checkpoint 3 / findings[0]';
const OTHER_LOCATION = 'checkpoint 4 / findings[0]';

async function store() {
  const { handle, plan } = await plannedKnowledgeStore();
  const sourceId = await captureFieldSource(handle, plan);
  return { handle, plan, sourceId };
}

const finding = (
  claimId: string,
  sourceId: string,
  previous: string | null = null,
  statement = 'Retrying an upload after a gateway error uploads the file twice.'
) => ({
  claim_id: claimId,
  revision_id: uuidv7(),
  previous_revision_id: previous,
  statement,
  subject: null,
  applicability: { all_of: [] },
  source_ids: [sourceId],
  passages: [
    { source_id: sourceId, location: LOCATION, passage_sha256: PASSAGE },
    { source_id: sourceId, location: OTHER_LOCATION, passage_sha256: PASSAGE },
  ],
  source_standing: 'agent_proposal',
  observation_ids: [],
  verification: {
    provenance: 'agent_reported',
    account: 'Ran the upload smoke twice and saw two stored objects.',
    reported_by: OWNER,
  },
  recorded_at: AT,
});

const atItsPassage = (sourceId: string) => ({ source_id: sourceId, location: LOCATION });

const claimOf = (handle: Parameters<typeof rowCount>[0], claimId: string) =>
  read(handle, (view) => readProjectContinuingClaim(view, claimId));

it('publishes a first finding with its occurrence, standing and reported verification', async () => {
  const { handle, sourceId } = await store();
  const first = finding(uuidv7(), sourceId);
  const before = counters(handle);
  const published = await publishProjectContinuingClaimRevision(handle, {
    operationId: uuidv7(),
    revision: first,
    attributedTo: BY_AGENT,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  expect(published.value.occurrence).toEqual({ sourceId, location: LOCATION, position: 0 });
  const claim = claimOf(handle, first.claim_id)!;
  expect(claim.firstRevisionId).toBe(first.revision_id);
  const [row] = claim.revisions;
  expect(row).toMatchObject({
    occurrence: { sourceId, location: LOCATION, position: 0 },
    sourceStanding: 'agent_proposal',
    subject: null,
    attribution: { kind: 'actor', name: BY_AGENT.actor.identity, basis: BY_AGENT.actor.basis },
    verificationProvenance: 'agent_reported',
  });
  const bytes = Buffer.from(row!.recordHex, 'hex');
  expect(digest(bytes)).toBe(row!.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...first, attributed_to: BY_AGENT });
});

it('keeps two sibling accounts and refuses a second root, a foreign predecessor and a reused id', async () => {
  const { handle, sourceId } = await store();
  const root = finding(uuidv7(), sourceId);
  const other = finding(uuidv7(), sourceId);
  for (const first of [root, other])
    await publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision: first,
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    });
  const narrower = finding(root.claim_id, sourceId, root.revision_id, 'Only the first retry does.');
  const wider = finding(root.claim_id, sourceId, root.revision_id, 'Every retry does.');
  for (const sibling of [narrower, wider])
    await publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision: sibling,
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    });
  expect(claimOf(handle, root.claim_id)!.revisions.map((row) => row.revisionId)).toEqual([
    root.revision_id,
    narrower.revision_id,
    wider.revision_id,
  ]);
  expect(claimOf(handle, root.claim_id)!.revisions.map((row) => row.occurrence.position)).toEqual([
    0, 2, 3,
  ]);

  const before = rowCount(handle, 'claim_revisions');
  for (const refused of [
    finding(root.claim_id, sourceId),
    finding(root.claim_id, sourceId, other.revision_id),
  ])
    await expect(
      publishProjectContinuingClaimRevision(handle, {
        operationId: uuidv7(),
        revision: refused,
        attributedTo: BY_AGENT,
        secretAllow: [],
        occurrence: atItsPassage(sourceId),
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...finding(root.claim_id, sourceId, root.revision_id),
        revision_id: narrower.revision_id,
      },
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'claim_revisions')).toBe(before);
});

it('keeps a detector out of the intent counter, and lets it verify nothing', async () => {
  const { handle, sourceId } = await store();
  const before = counters(handle);
  const candidate = {
    ...finding(uuidv7(), sourceId),
    source_standing: 'extracted_candidate',
    verification: null,
  };
  const published = await publishProjectContinuingClaimRevision(handle, {
    operationId: uuidv7(),
    revision: candidate,
    attributedTo: DETECTOR,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  expect(claimOf(handle, candidate.claim_id)!.revisions[0]).toMatchObject({
    sourceStanding: 'extracted_candidate',
    attribution: { kind: 'detector', name: DETECTOR.detector, basis: null },
    verificationProvenance: null,
  });

  const refused = rowCount(handle, 'claim_revisions');
  for (const revision of [
    { ...finding(uuidv7(), sourceId), source_standing: 'extracted_candidate' },
    { ...finding(uuidv7(), sourceId), verification: null },
  ])
    await expect(
      publishProjectContinuingClaimRevision(handle, {
        operationId: uuidv7(),
        revision,
        attributedTo: DETECTOR,
        secretAllow: [],
        occurrence: atItsPassage(sourceId),
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'claim_revisions')).toBe(refused);
});

it('names the observations a finding rests on, in order, and none when it rests on none', async () => {
  const { handle, sourceId } = await store();
  const observations = [
    await agentReportedObservation(handle, sourceId, 'pnpm vitest run upload-retry'),
    await agentReportedObservation(handle, sourceId, 'pnpm vitest run upload-retry --repeat 2'),
    await agentReportedObservation(handle, sourceId, 'curl -X PUT https://example.test/upload'),
  ];
  const observed = { ...finding(uuidv7(), sourceId), observation_ids: observations };
  const bare = finding(uuidv7(), sourceId);
  for (const revision of [observed, bare])
    await publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision,
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    });
  expect(claimOf(handle, observed.claim_id)!.revisions[0]!.observationIds).toEqual(observations);
  expect(claimOf(handle, bare.claim_id)!.revisions[0]!.observationIds).toEqual([]);
  expect(rowCount(handle, 'claim_revision_observations')).toBe(observations.length);
  // The payload says the same thing the lookup rows do.
  const bytes = Buffer.from(claimOf(handle, observed.claim_id)!.revisions[0]!.recordHex, 'hex');
  expect(JSON.parse(bytes.toString()).observation_ids).toEqual(observations);
});

it('refuses a finding that rests on an observation this history does not hold', async () => {
  const { handle, sourceId } = await store();
  const retained = await agentReportedObservation(handle, sourceId);
  await expect(
    publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...finding(uuidv7(), sourceId),
        observation_ids: [retained, uuidv7()],
      },
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'claim_revisions')).toBe(0);
  expect(rowCount(handle, 'claim_revision_observations')).toBe(0);
});

it('records the subject a released row never had and refuses one this history lacks', async () => {
  const { handle, sourceId } = await store();
  const subject = {
    subject_id: uuidv7(),
    revision_id: uuidv7(),
    previous_revision_id: null,
    label: 'Upload retries',
    kind: 'workflow' as const,
    description: 'Retrying an upload that failed at the gateway.',
    source_ids: [sourceId],
    recorded_at: AT,
  };
  await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision: subject,
    authoredBy: OWNER,
    secretAllow: [],
  });
  const about = {
    ...finding(uuidv7(), sourceId),
    subject: { subject_id: subject.subject_id, subject_revision_id: subject.revision_id },
  };
  await publishProjectContinuingClaimRevision(handle, {
    operationId: uuidv7(),
    revision: about,
    attributedTo: BY_AGENT,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  expect(claimOf(handle, about.claim_id)!.revisions[0]!.subject).toEqual({
    subjectId: subject.subject_id,
    subjectRevisionId: subject.revision_id,
  });

  await expect(
    publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...finding(uuidv7(), sourceId),
        subject: { subject_id: uuidv7(), subject_revision_id: uuidv7() },
      },
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
});

it('refuses a cited source this history does not hold, and an occurrence at no passage', async () => {
  const { handle, plan, sourceId } = await store();
  const unheld = uuidv7();
  await expect(
    publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision: finding(uuidv7(), unheld),
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(unheld),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  const other = await captureFieldSource(
    handle,
    plan,
    'plan_steps[0].acceptance_criteria[0].text',
    1
  );
  for (const occurrence of [
    { source_id: sourceId, location: 'checkpoint 9 / findings[0]' },
    { source_id: other, location: LOCATION },
  ])
    await expect(
      publishProjectContinuingClaimRevision(handle, {
        operationId: uuidv7(),
        revision: finding(uuidv7(), sourceId),
        attributedTo: BY_AGENT,
        secretAllow: [],
        occurrence,
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision: { ...finding(uuidv7(), sourceId), passages: [] },
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'claim_revisions')).toBe(0);
});

it('replays the original result and refuses a changed authored field under one operation id', async () => {
  const { handle, sourceId } = await store();
  const operationId = uuidv7();
  const first = finding(uuidv7(), sourceId);
  const published = await publishProjectContinuingClaimRevision(handle, {
    operationId,
    revision: first,
    attributedTo: BY_AGENT,
    secretAllow: [],
    occurrence: atItsPassage(sourceId),
  });
  expect(
    await publishProjectContinuingClaimRevision(handle, {
      operationId,
      revision: first,
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).toEqual({ ...published, replayed: true });

  const before = rowCount(handle, 'claim_revisions');
  for (const changed of [
    {
      revision: { ...first, statement: 'Something else happened.' },
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    },
    {
      revision: first,
      attributedTo: BY_OWNER,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    },
    {
      revision: first,
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: { ...atItsPassage(sourceId), location: OTHER_LOCATION },
    },
  ])
    await expect(
      publishProjectContinuingClaimRevision(handle, { operationId, ...changed })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'claim_revisions')).toBe(before);
});

it('refuses an acting attribution named inside the record', async () => {
  const { handle, sourceId } = await store();
  await expect(
    publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision: { ...finding(uuidv7(), sourceId), attributed_to: BY_OWNER },
      attributedTo: BY_AGENT,
      secretAllow: [],
      occurrence: atItsPassage(sourceId),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'claim_revisions')).toBe(0);
});
