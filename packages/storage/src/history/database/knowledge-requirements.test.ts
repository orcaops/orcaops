import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import {
  createProjectRequirement,
  publishProjectRequirementRevision,
  readProjectRequirement,
} from './knowledge-requirements.js';
import {
  AGENT,
  captureFieldSource,
  capturePlan,
  counters,
  discardKnowledgeStores,
  knowledgeStore,
  OWNER,
  plannedKnowledgeStore,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-17T12:00:00.000Z';
const PASSAGE = 'a'.repeat(64);
const DETECTOR = { kind: 'detector', detector: 'knowledge-processor' } as const;
const BY_OWNER = { kind: 'actor', actor: OWNER } as const;
const BY_AGENT = { kind: 'actor', actor: AGENT } as const;

async function store() {
  const { handle, plan } = await plannedKnowledgeStore(2);
  const sourceId = await captureFieldSource(handle, plan);
  return { handle, plan, sourceId, criterion: plan.steps[0]!.criteria };
}

const revision = (
  requirementId: string,
  sourceId: string,
  previous: string | null = null,
  statement = 'Local capture works with no Cloud connection.'
) => ({
  requirement_id: requirementId,
  revision_id: uuidv7(),
  previous_revision_id: previous,
  statement,
  rationale: 'Captures must never depend on network availability.',
  subject: null,
  applicability: { all_of: [] },
  duration: { kind: 'continuing' },
  source_ids: [sourceId],
  passages: [],
  source_standing: 'explicit_instruction',
  recorded_at: AT,
});

const promotedCriterion = (
  plan: { artifactId: string; planEventId: string },
  criterionId: string
) => ({
  requirement_id: criterionId,
  origin: {
    kind: 'promoted_criterion',
    criterion: {
      artifact_id: plan.artifactId,
      plan_event_id: plan.planEventId,
      criterion_id: criterionId,
    },
  },
});

const promotedPassage = (sourceId: string, requirementId = uuidv7()) => ({
  requirement_id: requirementId,
  origin: {
    kind: 'promoted_source',
    passage: { source_id: sourceId, location: 'paragraph 3', passage_sha256: PASSAGE },
    promoted_at: AT,
  },
});

const requirement = (handle: Parameters<typeof rowCount>[0], requirementId: string) =>
  read(handle, (view) => readProjectRequirement(view, requirementId));

it('creates a promoted criterion identity with its first revision in one intent change', async () => {
  const { handle, plan, sourceId, criterion } = await store();
  const identity = promotedCriterion(plan, criterion[0]!.criterionId);
  const first = revision(identity.requirement_id, sourceId);
  const before = counters(handle);
  const created = await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: first,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  expect(created.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  expect(created.value.published).toBe(true);
  const retained = requirement(handle, identity.requirement_id)!;
  expect(retained.originKind).toBe('promoted_criterion');
  expect(retained.firstRevisionId).toBe(first.revision_id);
  const identityBytes = Buffer.from(retained.recordHex, 'hex');
  expect(digest(identityBytes)).toBe(retained.recordSha256);
  expect(JSON.parse(identityBytes.toString())).toEqual(identity);
  const revisionBytes = Buffer.from(retained.revisions[0]!.recordHex, 'hex');
  expect(digest(revisionBytes)).toBe(retained.revisions[0]!.recordSha256);
  expect(JSON.parse(revisionBytes.toString())).toEqual({ ...first, attributed_to: BY_OWNER });
});

/** A criterion an origin names, wherever in the origin it names one. */
interface StoredCriterion {
  artifact_id: string;
  plan_event_id: string;
  criterion_id: string;
}

/** Where a requirement identity says it came from, as the row's origin columns copy it. */
type StoredOrigin =
  | { kind: 'promoted_criterion'; criterion: StoredCriterion }
  | {
      kind: 'promoted_source';
      passage: { source_id: string; location: string; passage_sha256: string };
    }
  | { kind: 'derived'; derived_from: { kind: string; criterion: StoredCriterion } };

it('keeps every origin column of an identity agreeing with the record beside it', async () => {
  const { handle, plan, sourceId, criterion } = await store();
  const promotions = [
    promotedCriterion(plan, criterion[0]!.criterionId),
    promotedPassage(sourceId),
    {
      requirement_id: uuidv7(),
      origin: {
        kind: 'derived',
        derived_from: {
          kind: 'criterion',
          criterion: {
            artifact_id: plan.artifactId,
            plan_event_id: plan.planEventId,
            criterion_id: criterion[1]!.criterionId,
          },
        },
        explanation: 'The obligation the criterion states for every device.',
        source_id: sourceId,
        derived_at: AT,
      },
    },
  ];
  for (const identity of promotions)
    await createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity,
      revision: revision(identity.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    });

  // Every column the writer kept beside the payload says what the payload says.
  for (const promoted of promotions) {
    const row = read(handle, (view) =>
      view.get<Record<string, unknown>>(
        `SELECT origin_kind, derived_from_kind, criterion_artifact_id, criterion_plan_event_id,
           criterion_id, expectation_kind, expectation_id, expectation_revision_id,
           passage_source_id, passage_location, passage_sha256,
           CAST(record_bytes AS TEXT) AS payload
         FROM requirements WHERE requirement_id=?`,
        promoted.requirement_id
      )
    )!;
    const origin = (JSON.parse(row.payload as string) as { origin: StoredOrigin }).origin;
    const named =
      origin.kind === 'promoted_criterion'
        ? origin.criterion
        : origin.kind === 'derived'
          ? origin.derived_from.criterion
          : null;
    const passage = origin.kind === 'promoted_source' ? origin.passage : null;
    expect(row, origin.kind).toMatchObject({
      origin_kind: origin.kind,
      derived_from_kind: origin.kind === 'derived' ? origin.derived_from.kind : null,
      criterion_artifact_id: named?.artifact_id ?? null,
      criterion_plan_event_id: named?.plan_event_id ?? null,
      criterion_id: named?.criterion_id ?? null,
      expectation_kind: null,
      expectation_id: null,
      expectation_revision_id: null,
      passage_source_id: passage?.source_id ?? null,
      passage_location: passage?.location ?? null,
      passage_sha256: passage?.passage_sha256 ?? null,
    });
  }
});

it('leaves the intent counter alone for a candidate a detector derived', async () => {
  const { handle, sourceId } = await store();
  const identity = promotedPassage(sourceId);
  const before = counters(handle);
  const created = await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: {
      ...revision(identity.requirement_id, sourceId),
      source_standing: 'extracted_candidate',
    },
    attributedTo: DETECTOR,
    secretAllow: [],
  });
  expect(created.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  expect(requirement(handle, identity.requirement_id)!.revisions[0]!.attribution).toEqual({
    kind: 'detector',
    name: DETECTOR.detector,
    basis: null,
  });
});

it('returns the requirement a passage already has, and writes nothing when it does', async () => {
  const { handle, sourceId } = await store();
  const identity = promotedPassage(sourceId);
  const first = revision(identity.requirement_id, sourceId);
  const created = await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: first,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const before = counters(handle);
  const receipts = rowCount(handle, 'operations');
  const again = await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: first,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  expect(again).toEqual({
    value: { ...created.value, published: false },
    replayed: true,
    counters: before,
  });
  expect(rowCount(handle, 'requirements')).toBe(1);
  expect(rowCount(handle, 'requirement_revisions')).toBe(1);
  expect(rowCount(handle, 'operations')).toBe(receipts);
});

it('refuses a second promotion of one passage that authored something else, by name', async () => {
  const { handle, sourceId } = await store();
  const identity = promotedPassage(sourceId);
  const created = await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: revision(identity.requirement_id, sourceId),
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const before = counters(handle);
  const second = promotedPassage(sourceId);
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: second,
      revision: revision(second.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
    message: expect.stringContaining(created.value.requirementId),
  });
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity,
      revision: {
        ...revision(identity.requirement_id, sourceId),
        revision_id: created.value.revisionId,
        statement: 'A different statement under the same ids.',
      },
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(counters(handle)).toEqual(before);
  expect(rowCount(handle, 'requirements')).toBe(1);
});

it('refuses promoting a criterion id that the plans of two artifacts both hold', async () => {
  const { handle, plan, sourceId, criterion } = await store();
  const shared = criterion[0]!.criterionId;
  await capturePlan(handle, {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [{ stepId: uuidv7(), criteria: [{ criterionId: shared, text: 'The same condition' }] }],
  });
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: promotedCriterion(plan, shared),
      revision: revision(shared, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'requirements')).toBe(0);
});

it('refuses an identity that a criterion or a requirement already holds', async () => {
  const { handle, plan, sourceId, criterion } = await store();
  const taken = { ...promotedPassage(sourceId), requirement_id: criterion[1]!.criterionId };
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: taken,
      revision: revision(taken.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  const promoted = promotedCriterion(plan, criterion[0]!.criterionId);
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: promoted,
    revision: revision(promoted.requirement_id, sourceId),
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: promoted,
      revision: revision(promoted.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'requirements')).toBe(1);
});

it('refuses a competing copy of a criterion and a derived obligation under its source identity', async () => {
  const { handle, plan, sourceId, criterion } = await store();
  const competing = {
    ...promotedCriterion(plan, criterion[0]!.criterionId),
    requirement_id: uuidv7(),
  };
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: competing,
      revision: revision(competing.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const sharing = {
    requirement_id: criterion[0]!.criterionId,
    origin: {
      kind: 'derived',
      derived_from: {
        kind: 'criterion',
        criterion: {
          artifact_id: plan.artifactId,
          plan_event_id: plan.planEventId,
          criterion_id: criterion[0]!.criterionId,
        },
      },
      explanation: 'The regression test protects the obligation; it is not the obligation.',
      source_id: sourceId,
      derived_at: AT,
    },
  };
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: sharing,
      revision: revision(sharing.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'requirements')).toBe(0);
});

it('refuses an origin whose criterion, expectation or source this history does not hold', async () => {
  const { handle, plan, sourceId, criterion } = await store();
  const elsewhere = {
    ...promotedCriterion(plan, criterion[0]!.criterionId),
    origin: {
      kind: 'promoted_criterion',
      criterion: {
        artifact_id: plan.artifactId,
        plan_event_id: uuidv7(),
        criterion_id: criterion[0]!.criterionId,
      },
    },
  };
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: elsewhere,
      revision: revision(elsewhere.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  const derived = {
    requirement_id: uuidv7(),
    origin: {
      kind: 'derived',
      derived_from: {
        kind: 'expectation',
        expectation: { kind: 'requirement', entity_id: uuidv7(), revision_id: uuidv7() },
      },
      explanation: 'A distinct proposition with its own identity.',
      source_id: sourceId,
      derived_at: AT,
    },
  };
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: derived,
      revision: revision(derived.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  const unsourced = promotedPassage(uuidv7());
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: unsourced,
      revision: revision(unsourced.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'requirements')).toBe(0);
  expect(rowCount(handle, 'requirement_revisions')).toBe(0);
});

it('keeps two sibling revisions and refuses a second root, a foreign predecessor and a reused id', async () => {
  const { handle, plan, sourceId, criterion } = await store();
  const identity = promotedCriterion(plan, criterion[0]!.criterionId);
  const root = revision(identity.requirement_id, sourceId);
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: root,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const other = promotedPassage(sourceId);
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: other,
    revision: revision(other.requirement_id, sourceId),
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const tighter = revision(
    identity.requirement_id,
    sourceId,
    root.revision_id,
    'Capture and search work offline.'
  );
  const looser = revision(
    identity.requirement_id,
    sourceId,
    root.revision_id,
    'Capture works offline.'
  );
  await publishProjectRequirementRevision(handle, {
    operationId: uuidv7(),
    revision: tighter,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  await publishProjectRequirementRevision(handle, {
    operationId: uuidv7(),
    revision: looser,
    attributedTo: BY_AGENT,
    secretAllow: [],
  });
  expect(requirement(handle, identity.requirement_id)!.revisions.map((r) => r.revisionId)).toEqual([
    root.revision_id,
    tighter.revision_id,
    looser.revision_id,
  ]);

  const before = rowCount(handle, 'requirement_revisions');
  await expect(
    publishProjectRequirementRevision(handle, {
      operationId: uuidv7(),
      revision: revision(identity.requirement_id, sourceId),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectRequirementRevision(handle, {
      operationId: uuidv7(),
      revision: revision(
        identity.requirement_id,
        sourceId,
        requirement(handle, other.requirement_id)!.firstRevisionId
      ),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectRequirementRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...revision(identity.requirement_id, sourceId, root.revision_id),
        revision_id: tighter.revision_id,
      },
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'requirement_revisions')).toBe(before);
});

it('refuses a revision of a requirement this history does not hold', async () => {
  const { handle, sourceId } = await store();
  await expect(
    publishProjectRequirementRevision(handle, {
      operationId: uuidv7(),
      revision: revision(uuidv7(), sourceId, uuidv7()),
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'requirement_revisions')).toBe(0);
});

it('replays the original creation and refuses a changed authored field under one operation id', async () => {
  const { handle, plan, sourceId, criterion } = await store();
  const operationId = uuidv7();
  const identity = promotedCriterion(plan, criterion[0]!.criterionId);
  const first = revision(identity.requirement_id, sourceId);
  const created = await createProjectRequirement(handle, {
    operationId,
    identity,
    revision: first,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const other = promotedPassage(sourceId);
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: other,
    revision: revision(other.requirement_id, sourceId),
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  expect(
    await createProjectRequirement(handle, {
      operationId,
      identity,
      revision: first,
      attributedTo: BY_OWNER,
      secretAllow: [],
    })
  ).toEqual({ ...created, replayed: true });

  const before = rowCount(handle, 'requirement_revisions');
  for (const changed of [
    {
      identity,
      revision: { ...first, rationale: 'A different reason' },
      attributedTo: BY_OWNER,
      secretAllow: [],
    },
    { identity, revision: first, attributedTo: BY_AGENT, secretAllow: [] },
    {
      identity: {
        ...identity,
        origin: {
          ...identity.origin,
          criterion: { ...identity.origin.criterion, criterion_id: identity.requirement_id },
        },
      },
      revision: { ...first, duration: { kind: 'unknown' } },
      attributedTo: BY_OWNER,
      secretAllow: [],
    },
  ])
    await expect(
      createProjectRequirement(handle, { operationId, ...changed })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'requirement_revisions')).toBe(before);
});

it('publishes a further revision as one change of intent for an actor', async () => {
  const { handle, plan, sourceId, criterion } = await store();
  const identity = promotedCriterion(plan, criterion[0]!.criterionId);
  const root = revision(identity.requirement_id, sourceId);
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: root,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const before = counters(handle);
  const next = await publishProjectRequirementRevision(handle, {
    operationId: uuidv7(),
    revision: revision(identity.requirement_id, sourceId, root.revision_id),
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  expect(next.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  const candidate = await publishProjectRequirementRevision(handle, {
    operationId: uuidv7(),
    revision: {
      ...revision(identity.requirement_id, sourceId, root.revision_id),
      source_standing: 'extracted_candidate',
    },
    attributedTo: DETECTOR,
    secretAllow: [],
  });
  expect(candidate.counters.intentChangeCounter).toBe(next.counters.intentChangeCounter);
});

it('gives two processes that both promote one passage one requirement and one change of intent', async () => {
  const { handle, authority } = await knowledgeStore();
  const plan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: 'Offline capture' }] }],
  };
  await capturePlan(handle, plan);
  const sourceId = await captureFieldSource(handle, plan);
  const identity = promotedPassage(sourceId);
  const first = revision(identity.requirement_id, sourceId);
  const before = counters(handle);
  const candidate = fileURLToPath(new URL('../../../../../', import.meta.url));
  const script = path.join(candidate, 'packages/storage/tests/promoted-passage-race.mjs');
  const racers = [uuidv7(), uuidv7()].map(
    (operationId) =>
      new Promise<{ ok: boolean; published?: boolean; requirementId?: string; code?: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              script,
              candidate,
              JSON.stringify({
                authority,
                operationId,
                identity,
                revision: first,
                attributedTo: BY_OWNER,
              }),
            ],
            { stdio: ['ignore', 'pipe', 'inherit'] }
          );
          let out = '';
          child.stdout.on('data', (chunk) => (out += chunk));
          child.on('error', reject);
          child.on('close', () => resolve(JSON.parse(out || '{"ok":false,"code":"NO_OUTPUT"}')));
        }
      )
  );
  const results = await Promise.all(racers);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(results.filter((result) => result.published)).toHaveLength(1);
  expect(new Set(results.map((result) => result.requirementId))).toEqual(
    new Set([identity.requirement_id])
  );
  expect(rowCount(handle, 'requirements')).toBe(1);
  expect(counters(handle).intentChangeCounter).toBe(before.intentChangeCounter + 1);
});
