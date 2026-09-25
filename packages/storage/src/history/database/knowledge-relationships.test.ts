import { afterEach, expect, it } from 'vitest';

import { appendProjectCorrection } from './knowledge-corrections.js';
import {
  listProjectRelationships,
  publishProjectRelationship,
  readProjectRelationship,
} from './knowledge-relationships.js';
import { createProjectRequirement } from './knowledge-requirements.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { resolveProjectKnowledge } from './knowledge-standing.js';
import { runProjectOperation } from './transactions.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  findingRevision,
  importRelationship,
  informedBy,
  instructedBy,
  requirementRevision,
  successorRevision,
} from '../../../tests/knowledge-authority-store.js';
import {
  BY_AGENT,
  BY_OWNER,
  counters,
  DETECTOR,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { ExpectationRevisionRef, RecordRevisionRef } from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

type Store = Awaited<ReturnType<typeof authorityStore>>;

const authoredSha = (relationship: unknown, attributedTo: unknown) =>
  digest(
    Buffer.from(
      canonicalJson({ ...(relationship as object), attributed_to: attributedTo }) as string
    )
  );

const relationship = (
  store: Store,
  from: RecordRevisionRef,
  to: RecordRevisionRef,
  change: {
    id?: string;
    relation?: 'supersedes' | 'challenges' | 'depends_on' | 'motivates';
    standing?: 'suggested' | 'established';
    scope?: unknown;
    authorization?: unknown;
    explanation?: string;
    sourceIds?: string[];
  } = {}
) => {
  const standing = change.standing ?? 'suggested';
  const relation = change.relation ?? 'depends_on';
  const scope = change.scope ?? store.project;
  const replaces = standing === 'established' && relation === 'supersedes';
  return {
    relationship_id: change.id ?? uuidv7(),
    relation,
    from,
    to,
    scope,
    standing,
    authorization: Object.hasOwn(change, 'authorization')
      ? change.authorization
      : replaces
        ? informedBy(store.instructionId, [to as never], scope as never)
        : null,
    source_ids: change.sourceIds ?? [store.instructionId],
    explanation: change.explanation ?? 'The newer revision replaces the older one.',
  };
};

const publish = (store: Store, authored: unknown, attributedTo: unknown = BY_OWNER) =>
  publishProjectRelationship(store.handle, {
    operationId: uuidv7(),
    relationship: authored,
    attributedTo: attributedTo as never,
    recordedAt: (authored as { authorization: unknown }).authorization === null ? undefined : AT,
    secretAllow: [],
  });

it('records a suggested relationship with its endpoints, scope, explanation and sources', async () => {
  const store = await authorityStore();
  const beside = await successorRevision(store);
  const authored = relationship(store, store.target, beside, {
    explanation: 'The offline requirement rests on the later revision.',
  });
  const before = counters(store.handle);
  const published = await publish(store, authored, BY_AGENT);

  expect(published.value).toMatchObject({
    relationshipId: authored.relationship_id,
    standing: 'suggested',
    authorizationId: null,
  });
  expect(published.value.recordSha256).toBe(authoredSha(authored, BY_AGENT));
  // A suggestion designates nothing, so only the write sequence moves.
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const row = read(store.handle, (view) =>
    readProjectRelationship(view, authored.relationship_id)
  )!;
  expect(row).toMatchObject({
    relation: 'depends_on',
    from: { kind: 'requirement', entityId: store.requirementId, revisionId: store.revisionId },
    to: { kind: 'requirement', entityId: store.requirementId, revisionId: beside.revision_id },
    scope: { kind: 'project', value: null },
    standing: 'suggested',
    attributedTo: { kind: 'author', identity: 'claude-code', basis: 'source_attributed' },
    explanation: 'The offline requirement rests on the later revision.',
    sourceIds: [store.instructionId],
    authorizationJson: null,
    authorizationId: null,
  });
  expect(
    read(store.handle, (view) =>
      listProjectRelationships(view, { kind: 'requirement', entityId: store.requirementId })
    ).map((entry) => entry.relationshipId)
  ).toEqual([authored.relationship_id]);
});

it('establishes a replacement on an informed instruction and advances the intent counter', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const authored = relationship(store, successor, store.target, {
    relation: 'supersedes',
    standing: 'established',
  });
  const before = counters(store.handle);
  const published = await publish(store, authored);

  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  const row = read(store.handle, (view) =>
    readProjectRelationship(view, authored.relationship_id)
  )!;
  expect(row.standing).toBe('established');
  expect(JSON.parse(row.authorizationJson as string)).toEqual(authored.authorization);
  // The revision the replacement points at stops standing where the relationship reaches.
  const resolved = read(store.handle, (view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      store.project,
      {}
    )
  );
  expect(resolved.relationships[0]).toMatchObject({ standing: 'established', applied: true });
});

it('refuses an established replacement without an informed instruction, whatever else it cites', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const anotherRule = await successorRevision(store, 'Another rule entirely.');
  const before = counters(store.handle);
  for (const authorization of [
    null,
    instructedBy(store.instructionId, store.project),
    { kind: 'approval_binding', binding_id: uuidv7() },
    { kind: 'reused_authorization', authorization_id: uuidv7() },
    informedBy(store.instructionId, [anotherRule], store.project),
  ])
    await expect(
      publish(
        store,
        relationship(store, successor, store.target, {
          relation: 'supersedes',
          standing: 'established',
          authorization,
        })
      ),
      JSON.stringify(authorization)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'record_relationships')).toBe(0);
  expect(counters(store.handle).intentChangeCounter).toBe(before.intentChangeCounter);
});

it('refuses a publication time on an act that records no authorization of its own', async () => {
  const store = await authorityStore();
  const beside = await successorRevision(store);
  const before = counters(store.handle);
  for (const authorization of [null, { kind: 'reused_authorization', authorization_id: uuidv7() }])
    await expect(
      publishProjectRelationship(store.handle, {
        operationId: uuidv7(),
        relationship: relationship(store, store.target, beside, { authorization }),
        attributedTo: BY_OWNER,
        recordedAt: AT,
        secretAllow: [],
      }),
      JSON.stringify(authorization)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'record_relationships')).toBe(0);
  expect(counters(store.handle)).toEqual(before);
});

it('keeps a detector to a suggestion, whatever standing it asks for', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  await expect(
    publish(
      store,
      relationship(store, successor, store.target, {
        relation: 'supersedes',
        standing: 'established',
      }),
      DETECTOR
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'record_relationships')).toBe(0);

  const suggested = relationship(store, successor, store.target, { relation: 'supersedes' });
  const published = await publish(store, suggested, DETECTOR);
  expect(published.value.standing).toBe('suggested');
  expect(published.counters.intentChangeCounter).toBe(counters(store.handle).intentChangeCounter);
  const row = read(store.handle, (view) =>
    readProjectRelationship(view, suggested.relationship_id)
  )!;
  expect(row.attributedTo).toEqual({
    kind: 'detector',
    identity: 'knowledge-processor',
    basis: null,
  });
});

it('refuses a new replacement cycle while a cycle among retained rows stays readable', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  await publish(
    store,
    relationship(store, successor, store.target, {
      relation: 'supersedes',
      standing: 'established',
    })
  );
  const before = counters(store.handle);
  await expect(
    publish(
      store,
      relationship(store, store.target, successor, {
        relation: 'supersedes',
        standing: 'established',
        authorization: informedBy(store.instructionId, [successor], store.project),
      })
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(counters(store.handle)).toEqual(before);
  expect(rowCount(store.handle, 'record_relationships')).toBe(1);

  // A cycle a sync or an import delivered stays readable, and the answer says it is one.
  const closing = await importRelationship(store.handle, {
    from: store.target,
    to: successor,
    scope: store.project,
  });
  expect(read(store.handle, (view) => readProjectRelationship(view, closing))!.standing).toBe(
    'established'
  );
  const resolved = read(store.handle, (view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      store.project,
      {}
    )
  );
  expect(resolved.unresolved.some((point) => point.reason === 'replacement_cycle')).toBe(true);
  expect(resolved.relationships.every((entry) => entry.applied)).toBe(false);
});

it('refuses an identical relationship that still stands and accepts one after a withdrawal', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const first = relationship(store, successor, store.target, {
    relation: 'supersedes',
    standing: 'established',
  });
  await publish(store, first);
  const identical = () =>
    publish(
      store,
      relationship(store, successor, store.target, {
        relation: 'supersedes',
        standing: 'established',
      })
    );
  const before = counters(store.handle);
  await expect(identical()).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(counters(store.handle)).toEqual(before);

  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: uuidv7(),
      kind: 'withdrawal',
      targets: [
        {
          kind: 'relationship',
          entity_id: first.relationship_id,
          revision_id: first.relationship_id,
        },
      ],
      scope: store.project,
      source_id: store.instructionId,
      authorization: informedBy(store.instructionId, [successor], store.project),
      expected_state: { kind: 'initial' },
      reason: 'The successor was recorded against the wrong revision.',
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  expect((await identical()).value.standing).toBe('established');
  expect(rowCount(store.handle, 'record_relationships')).toBe(2);
});

it('refuses endpoints, a source and an acknowledged rule this history does not hold', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const absent = { ...store.target, revision_id: uuidv7() };
  for (const authored of [
    relationship(store, absent, successor),
    relationship(store, successor, absent),
    relationship(store, successor, store.target, { sourceIds: [uuidv7()] }),
    relationship(store, successor, store.target, {
      relation: 'supersedes',
      standing: 'established',
      authorization: informedBy(uuidv7(), [store.target], store.project),
    }),
  ])
    await expect(publish(store, authored)).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(store.handle, 'record_relationships')).toBe(0);
  expect(rowCount(store.handle, 'knowledge_authorizations')).toBe(0);
});

it('refuses a foreign project id, a branch scope and a relationship as an endpoint', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const retained = relationship(store, successor, store.target);
  await publish(store, retained);
  for (const authored of [
    relationship(store, successor, store.target, {
      scope: { kind: 'project', project_id: uuidv7() },
    }),
    relationship(store, successor, store.target, {
      scope: { kind: 'branch', branch: 'feature/retry' },
    }),
    relationship(store, successor, {
      kind: 'relationship',
      entity_id: retained.relationship_id,
      revision_id: retained.relationship_id,
    }),
  ])
    await expect(publish(store, authored)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'record_relationships')).toBe(1);
});

it('replays the original result under the same operation id and refuses a changed field', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const operationId = uuidv7();
  const authored = relationship(store, successor, store.target, {
    relation: 'supersedes',
    standing: 'established',
  });
  const input = {
    operationId,
    relationship: authored,
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  };
  const first = await publishProjectRelationship(store.handle, input);
  const before = counters(store.handle);
  expect(await publishProjectRelationship(store.handle, input)).toEqual({
    ...first,
    replayed: true,
  });
  expect(counters(store.handle)).toEqual(before);
  for (const changed of [
    { relationship: { ...authored, explanation: 'Another reason entirely.' } },
    { recordedAt: '2026-09-18T10:00:00.000Z' },
  ])
    await expect(
      publishProjectRelationship(store.handle, { ...input, ...changed })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'record_relationships')).toBe(1);
});

it('refuses a taken relationship id and a finding replaced by a requirement', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const finding = await findingRevision(store);
  const taken = relationship(store, successor, store.target);
  await publish(store, taken);
  await expect(
    publish(store, relationship(store, successor, finding, { id: taken.relationship_id }))
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    publish(
      store,
      relationship(store, successor, finding, {
        relation: 'supersedes',
        standing: 'established',
      })
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'record_relationships')).toBe(1);
});

it('refuses a project-wide replacement that closes a cycle with one an artifact holds', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  // The artifact keeps the older wording: inside it, the first revision replaces the successor.
  await publish(
    store,
    relationship(store, store.target, successor, {
      relation: 'supersedes',
      standing: 'established',
      scope: store.artifact,
      authorization: informedBy(store.instructionId, [successor], store.artifact),
    })
  );
  const before = counters(store.handle);
  // The other way round, project-wide: a read inside that artifact would see both and neither.
  await expect(
    publish(
      store,
      relationship(store, successor, store.target, {
        relation: 'supersedes',
        standing: 'established',
      })
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(counters(store.handle)).toEqual(before);
  expect(rowCount(store.handle, 'record_relationships')).toBe(1);
});

it('allows a project replacement when every effective scope stays acyclic', async () => {
  const store = await authorityStore();
  const first = store.target;
  const second = await successorRevision(store);
  const third = await successorRevision(store, 'A third rule.');
  await publish(
    store,
    relationship(store, second, third, {
      relation: 'supersedes',
      standing: 'established',
      scope: store.artifact,
    })
  );
  await publish(
    store,
    relationship(store, third, first, {
      relation: 'supersedes',
      standing: 'established',
      scope: { kind: 'artifact', artifact_id: uuidv7() },
    })
  );

  await expect(
    publish(
      store,
      relationship(store, first, second, {
        relation: 'supersedes',
        standing: 'established',
      })
    )
  ).resolves.toHaveProperty('value.standing', 'established');
});

it('reports an imported replacement cycle spanning three identities', async () => {
  const store = await authorityStore();
  const revisions: RecordRevisionRef[] = [store.target];
  for (const statement of ['A second rule.', 'A third rule.']) {
    const requirementId = uuidv7();
    const revision = requirementRevision(requirementId, store.instructionId, { statement });
    await createProjectRequirement(store.handle, {
      operationId: uuidv7(),
      identity: {
        requirement_id: requirementId,
        origin: { kind: 'authored', source_id: store.instructionId },
      },
      revision,
      attributedTo: BY_OWNER,
      secretAllow: [],
    });
    revisions.push({
      kind: 'requirement',
      entity_id: requirementId,
      revision_id: revision.revision_id,
    });
  }
  const relationshipIds: string[] = [];
  for (let index = 0; index < revisions.length; index += 1)
    relationshipIds.push(
      await importRelationship(store.handle, {
        from: revisions[index] as RecordRevisionRef,
        to: revisions[(index + 1) % revisions.length] as RecordRevisionRef,
        scope: store.project,
      })
    );

  const resolved = read(store.handle, (view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      store.project,
      {}
    )
  );
  expect(resolved.unresolved).toContainEqual({
    about: 'relationship',
    record_ids: [...relationshipIds].sort(),
    reason: 'replacement_cycle',
  });
  expect(resolved.relationships).toHaveLength(3);
  expect(resolved.relationships.every((entry) => !entry.applied)).toBe(true);
  expect(resolved.revisions.map((entry) => entry.revision.entity_id)).toEqual([
    store.requirementId,
  ]);
});

it('refuses a cycle-closing write after resolving a long path once per check', async () => {
  const store = await authorityStore();
  const recordBytes = Buffer.from('{}');
  const recordSha256 = '0'.repeat(64);
  let prior: ExpectationRevisionRef = store.target;
  await runProjectOperation(
    store.handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.imported.relationship.graph',
      target: { requirementId: store.requirementId },
      payload: { shape: 'chain', edges: 1_000 },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      for (let index = 0; index < 1_000; index += 1) {
        const requirementId = `cycle-path-requirement-${index}`;
        const revisionId = `cycle-path-revision-${index}`;
        transaction.run(
          `INSERT INTO requirements (requirement_id, first_revision_id, origin_kind, record_bytes,
             record_sha256, operation_id)
           VALUES (?,?,'authored',?,?,?)`,
          requirementId,
          revisionId,
          recordBytes,
          recordSha256,
          settling.operationId
        );
        transaction.run(
          `INSERT INTO requirement_revisions (revision_id, requirement_id, previous_revision_id,
             source_standing, duration_kind, attributed_kind, attributed_to, attributed_basis,
             record_bytes, record_sha256, operation_id)
           VALUES (?,?,NULL,'explicit_instruction','continuing','actor',NULL,'unknown',?,?,?)`,
          revisionId,
          requirementId,
          recordBytes,
          recordSha256,
          settling.operationId
        );
        transaction.run(
          `INSERT INTO record_relationships (relationship_id, relation, from_entity_kind,
             from_entity_id, from_revision_id, to_entity_kind, to_entity_id, to_revision_id,
             scope_kind, scope_value, attributed_kind, attributed_to, attributed_basis, standing,
             explanation, source_refs_json, operation_id)
           VALUES (?,'supersedes','requirement',?,?,'requirement',?,?,'project',NULL,
             'author',?,'unknown','established',NULL,'[]',?)`,
          `cycle-path-replacement-${index}`,
          requirementId,
          revisionId,
          prior.entity_id,
          prior.revision_id,
          OWNER.identity,
          settling.operationId
        );
        prior = { kind: 'requirement', entity_id: requirementId, revision_id: revisionId };
      }
      return { imported: 1_000 };
    }
  );

  await expect(
    publish(
      store,
      relationship(store, store.target, prior, {
        relation: 'supersedes',
        standing: 'established',
        authorization: informedBy(store.instructionId, [prior], store.project),
      })
    )
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('replace itself'),
  });
}, 15_000);

it('keeps a project-wide replacement reaching an adoption inside an artifact', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const published = await publish(
    store,
    relationship(store, successor, store.target, {
      relation: 'supersedes',
      standing: 'established',
    })
  );
  // The control for the cycle above: one replacement, and the revision it points at is not adopted
  // in the artifact the project rule reaches.
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(
        store.target,
        store.artifact,
        instructedBy(store.instructionId, store.artifact)
      ),
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining(published.value.relationshipId),
  });
});
