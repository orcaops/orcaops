// The composed read, over real project databases whose history moves.
import { afterEach, expect, it } from 'vitest';

import { type ProjectReadView } from './connection.js';
import { type KnowledgeContextSubject, projectKnowledgeContext } from './knowledge-context.js';
import { appendProjectCorrection } from './knowledge-corrections.js';
import { revisionGoverningState } from './knowledge-read-boundary.js';
import { publishProjectRelationship } from './knowledge-relationships.js';
import { publishProjectRequirementRevision } from './knowledge-requirements.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { publishProjectSubject } from './knowledge-subjects.js';
import { recordProjectTaskUses } from './knowledge-task-uses.js';
import {
  acceptedSelection,
  AT,
  type AuthorityStore,
  authorityStore,
  BY_OWNER,
  importClaimWithUnreadableApplicability,
  informedBy,
  instructedBy,
  requirementRevision,
  successorRevision,
} from '../../../tests/knowledge-authority-store.js';
import { requirementThatMoved } from '../../../tests/knowledge-read-store.js';
import {
  OTHER_ARTIFACT_RULE,
  retrievalStore,
  SOURCE_TEXT,
} from '../../../tests/knowledge-retrieval-store.js';
import {
  BY_AGENT,
  counters,
  discardKnowledgeStores,
  OWNER,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { KnowledgeTarget } from '../../schema/knowledge-resolution.js';

afterEach(discardKnowledgeStores);

const BOUNDS = {
  maxIdentities: 24,
  maxStatementBytes: 16_384,
  maxSearchTerms: 12,
  maxSearchHits: 50,
  maxSourcesFollowed: 64,
};

const moved = async () => {
  const history = await requirementThatMoved();
  const target: KnowledgeTarget = {
    kind: 'requirement',
    entity_id: history.store.requirementId,
  };
  const at = (boundary: number | 'now', view?: ProjectReadView) => {
    const read = (inner: ProjectReadView) =>
      projectKnowledgeContext(inner, {
        projectId: history.store.authority.projectId,
        scope: history.store.project,
        boundary,
        mode: boundary === 'now' ? 'current' : 'historical',
        subject: { kind: 'identities', targets: [target] },
      });
    return view ? read(view) : history.store.handle.read(read).value;
  };
  return { ...history, target, at };
};

it('can leave interpretation selection to a caller without changing resolved authority', async () => {
  const history = await moved();
  const input = {
    projectId: history.store.authority.projectId,
    scope: history.store.project,
    boundary: 'now' as const,
    mode: 'current' as const,
    subject: { kind: 'adopted' as const },
  };
  const { full, separate } = history.store.handle.read((view) => ({
    full: projectKnowledgeContext(view, input),
    separate: projectKnowledgeContext(view, { ...input, interpretations: false }),
  })).value;
  expect(full.interpretationRead).toBeDefined();
  expect(separate.interpretationRead).toBeUndefined();
  expect(separate.entries).toEqual(full.entries);
  expect(separate.coverage).toEqual(full.coverage);
  expect(separate.omissions).toEqual(full.omissions);
});

it('limits identity resolution without describing omitted identities as absent', async () => {
  const history = await moved();
  const targets: KnowledgeTarget[] = [history.target, { kind: 'requirement', entity_id: uuidv7() }];
  const result = history.store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: history.store.authority.projectId,
      scope: history.store.project,
      boundary: 'now',
      mode: 'current',
      subject: { kind: 'identities', targets },
      interpretations: false,
      maxResolvedIdentities: 1,
    })
  ).value;
  expect(result.entries).toHaveLength(1);
  expect(result.absent).toEqual([]);
  expect(result.omissions).toContainEqual({
    kind: 'identity_count',
    detail: '1 selected identities were not resolved within the identity allowance.',
  });
});

it('names the boundary, the mode and the scope it read at, with a coverage that is never empty', async () => {
  const history = await moved();

  const answered = history.at(history.boundaries.adopted);

  expect(answered.request).toMatchObject({
    knowledge_boundary: history.boundaries.adopted,
    mode: 'historical',
    scope: history.store.project,
  });
  expect(answered.coverage).toMatchObject({
    boundary: history.boundaries.adopted,
    mode: 'historical',
    scope: history.store.project,
  });
  expect(answered.entries).toHaveLength(1);
  expect(answered.entries[0]!.resolved.basis.knowledge_boundary).toBe(history.boundaries.adopted);
});

it('answers the same question the same way twice', async () => {
  const history = await moved();

  expect(JSON.stringify(history.at(history.boundaries.replaced))).toBe(
    JSON.stringify(history.at(history.boundaries.replaced))
  );
});

it('reports a requested claim with unreadable applicability without crashing', async () => {
  const store = await authorityStore();
  const claim = await importClaimWithUnreadableApplicability(store);
  const answered = store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: store.authority.projectId,
      scope: store.project,
      boundary: 'now',
      mode: 'current',
      subject: {
        kind: 'identities',
        targets: [{ kind: 'claim', entity_id: claim.entity_id }],
      },
    })
  ).value;
  expect(answered.entries).toHaveLength(1);
  expect(answered.entries[0]!.resolved.revisions).toEqual([]);
  expect(answered.entries[0]!.tips.map((tip) => tip.revisionId)).toEqual([claim.revision_id]);
  expect(answered.coverage.unresolved).toContainEqual({
    about: 'revision',
    record_ids: [claim.revision_id],
    reason: 'revision_not_supplied',
  });
});

it('reproduces what stood at each boundary the history moved through', async () => {
  const history = await moved();
  const standing = (boundary: number, revisionId: string) =>
    revisionGoverningState(history.at(boundary).entries[0]!.resolved, revisionId).standing;

  expect(standing(history.boundaries.adopted, history.adopted.revision_id)).toBe('adopted');
  expect(standing(history.boundaries.replaced, history.adopted.revision_id)).toBe('not_standing');
  expect(standing(history.boundaries.replaced, history.replacement.revision_id)).toBe('adopted');
  expect(standing(history.boundaries.withdrawn, history.replacement.revision_id)).toBe(
    'not_standing'
  );
});

it('keeps a correction published later out of the basis and in the annotations', async () => {
  const history = await moved();

  const answered = history.at(history.boundaries.adopted);

  expect(answered.entries[0]!.revisions.map((revision) => revision.revisionId)).not.toContain(
    history.replacement.revision_id
  );
  expect(answered.coverage.later.map((later) => later.record_id)).toContain(history.withdrawalId);
  expect(answered.entries[0]!.resolved.later_annotations.map((later) => later.record_id)).toContain(
    history.withdrawalId
  );
});

it('carries the task uses of an identity in two lists, and the sources to drill into', async () => {
  const store = await retrievalStore();

  const answered = store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: store.authority.projectId,
      scope: store.project,
      boundary: store.boundary,
      mode: 'historical',
      subject: {
        kind: 'identities',
        targets: [{ kind: 'requirement', entity_id: store.planCriterion.entity_id }],
      },
    })
  ).value;

  const entry = answered.entries[0]!;
  expect(entry.selectedWithPlan).toHaveLength(0);
  expect(entry.connectedLater).toHaveLength(1);
  expect(entry.connectedLater[0]!.use.target.revisionId).toBe(store.planCriterion.revision_id);
  expect(entry.connectedLater[0]!.use.discoveredAt).not.toBeNull();
  expect(entry.criterion).toMatchObject({
    artifactId: store.plan.artifactId,
    planEventId: store.plan.planEventId,
  });
});

it('reaches the identities one captured event is cited by, and no other event of its artifact', async () => {
  const store = await retrievalStore();

  const answered = store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: store.authority.projectId,
      scope: store.project,
      boundary: store.boundary,
      mode: 'historical',
      subject: { kind: 'captured_event', eventId: store.sourceEventId },
    })
  ).value;

  // `offline` is promoted from a passage of this event; `storage` from another event of the same
  // artifact, which this question does not follow.
  expect(answered.entries.map((entry) => entry.target.entity_id)).toEqual([
    store.offline.entity_id,
  ]);
  expect(answered.entries[0]!.routes).toEqual(['source_reference']);
  expect(answered.entries[0]!.references[0]).toMatchObject({
    eventId: store.sourceEventId,
    revisionIds: [store.offline.revision_id],
  });
  // The confidential requirement's only source is restricted, so it is absent and said to be.
  expect(answered.omissions.map((omission) => omission.kind)).toContain('access_restricted');
  expect(answered.omissions.map((omission) => omission.detail).join(' ')).toContain(
    store.restriction
  );
});

it('reaches the records a text question is related to, and leaves later ones out', async () => {
  const store = await retrievalStore();

  const answered = store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: store.authority.projectId,
      scope: store.artifact,
      boundary: store.boundary,
      mode: 'historical',
      subject: { kind: 'text', text: SOURCE_TEXT },
      bounds: BOUNDS,
    })
  ).value;

  const statements = answered.entries.flatMap((entry) =>
    entry.statements.map((statement) => statement.text)
  );
  expect(statements).toContain(OTHER_ARTIFACT_RULE);
  expect(answered.entries.map((entry) => entry.target.entity_id)).not.toContain(
    store.late.entity_id
  );
  expect(answered.retrieval?.boundary).toBe(store.boundary);
});

it('resolves each identity once however many parts of the answer name it', async () => {
  const history = await moved();
  const resolutions: string[] = [];
  const counting = (view: ProjectReadView): ProjectReadView => ({
    all: (sql, ...parameters) => {
      if (sql.includes('FROM adoptions r')) resolutions.push(sql);
      return view.all(sql, ...parameters);
    },
    get: (sql, ...parameters) => view.get(sql, ...parameters),
  });

  history.store.handle.read((view) =>
    projectKnowledgeContext(counting(view), {
      projectId: history.store.authority.projectId,
      scope: history.store.project,
      boundary: 'now',
      mode: 'current',
      subject: {
        kind: 'identities',
        targets: [
          history.target,
          { kind: 'decision', entity_id: uuidv7() },
          { kind: 'claim', entity_id: uuidv7() },
        ],
      },
    })
  );

  expect(resolutions).toHaveLength(3);
});

it('names an identity it holds no record of rather than composing an empty entry', async () => {
  const history = await moved();
  const nothing = { kind: 'decision' as const, entity_id: uuidv7() };

  const answered = history.store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: history.store.authority.projectId,
      scope: history.store.project,
      boundary: 'now',
      mode: 'current',
      subject: { kind: 'identities', targets: [history.target, nothing] },
    })
  ).value;

  expect(answered.entries.map((entry) => entry.target.entity_id)).toEqual([
    history.store.requirementId,
  ]);
  expect(answered.absent).toEqual([nothing]);
});

it('reads an established relationship by its identity without admitting future or missing rows', async () => {
  const history = await moved();
  const target = { kind: 'relationship' as const, entity_id: history.relationshipId };
  const missing = { kind: 'relationship' as const, entity_id: uuidv7() };
  const read = (boundary: number) =>
    history.store.handle.read((view) =>
      projectKnowledgeContext(view, {
        projectId: history.store.authority.projectId,
        scope: history.store.project,
        boundary,
        mode: 'historical',
        subject: { kind: 'identities', targets: [target, missing] },
      })
    ).value;

  const direct = read(history.boundaries.replaced);

  expect(direct.entries).toHaveLength(1);
  expect(direct.entries[0]!.resolved.relationships).toMatchObject([
    {
      relationship_id: history.relationshipId,
      relation: 'supersedes',
      standing: 'established',
      scope: history.store.project,
    },
  ]);
  expect(direct.absent).toEqual([missing]);
  expect(read(history.boundaries.adopted)).toMatchObject({
    entries: [],
    absent: [target, missing],
  });
});

it('reads a relationship by its own identity only at a boundary and scope that reach it', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const before = counters(store.handle).writeSequence;
  const relationshipId = uuidv7();
  await publishProjectRelationship(store.handle, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: relationshipId,
      relation: 'depends_on',
      from: store.target,
      to: successor,
      scope: store.artifact,
      standing: 'suggested',
      authorization: null,
      source_ids: [store.instructionId],
      explanation: 'The original requirement depends on its later clarification.',
    },
    attributedTo: BY_AGENT,
    secretAllow: [],
  });
  const target = { kind: 'relationship' as const, entity_id: relationshipId };
  const read = (scope: AuthorityStore['project'], boundary: number | 'now') =>
    store.handle.read((view) =>
      projectKnowledgeContext(view, {
        projectId: store.authority.projectId,
        scope,
        boundary,
        mode: boundary === 'now' ? 'current' : 'historical',
        subject: { kind: 'identities', targets: [target] },
      })
    ).value;

  const reached = read(store.artifact, 'now');
  const endpoint = store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: store.authority.projectId,
      scope: store.artifact,
      boundary: 'now',
      mode: 'current',
      subject: {
        kind: 'identities',
        targets: [{ kind: 'requirement', entity_id: store.requirementId }],
      },
    })
  ).value;
  const endpointRelationship = endpoint.entries[0]!.resolved.relationships.find(
    (relationship) => relationship.relationship_id === relationshipId
  );
  expect(reached.absent).toEqual([]);
  expect(reached.entries).toHaveLength(1);
  expect(reached.entries[0]!.resolved.relationships).toEqual([endpointRelationship]);
  expect(reached.entries[0]!.references).toEqual([]);

  expect(read(store.artifact, before)).toMatchObject({ entries: [], absent: [target] });
  expect(read({ kind: 'artifact', artifact_id: uuidv7() }, 'now')).toMatchObject({
    entries: [],
    absent: [target],
  });
  expect(read(store.project, 'now')).toMatchObject({ entries: [], absent: [target] });
});

it('bounds what it reads, and never what the answer carries', async () => {
  const history = await moved();

  const answered = history.store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: history.store.authority.projectId,
      scope: history.store.project,
      boundary: 'now',
      mode: 'current',
      subject: { kind: 'identities', targets: [history.target] },
      bounds: { ...BOUNDS, maxIdentities: 0 },
    })
  ).value;

  // Dropping an entry needs to know whether it is an adopted rule that applies, which nothing
  // here knows: the read bounds are for retrieval, and the answer's own bound is spent in core.
  expect(answered.entries).toHaveLength(1);
  expect(answered.omissions.map((omission) => omission.kind)).not.toContain('identity_count');
});

it('refuses a boundary this history has not published', async () => {
  const history = await moved();

  expect(() => history.at(history.boundaries.withdrawn + 1)).toThrow(/knowledge boundary later/u);
});

/** The identities one subject question finds, at one boundary, keyed as the answer names them. */
const found = (store: AuthorityStore, subject: KnowledgeContextSubject, boundary: number | 'now') =>
  store.handle.read((view) => {
    const answered = projectKnowledgeContext(view, {
      projectId: store.authority.projectId,
      scope: store.project,
      boundary,
      mode: boundary === 'now' ? 'current' : 'historical',
      subject,
    });
    return {
      entries: answered.entries.map((entry) => `${entry.target.kind}:${entry.target.entity_id}`),
      absent: answered.absent.map((target) => `${target.kind}:${target.entity_id}`),
    };
  }).value;

it('finds no identity through an adoption published after the boundary', async () => {
  const store = await authorityStore();
  const before = counters(store.handle).writeSequence;
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      store.target,
      store.project,
      instructedBy(store.instructionId, store.project)
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });

  expect(found(store, { kind: 'adopted' }, before)).toEqual({ entries: [], absent: [] });
  expect(found(store, { kind: 'adopted' }, 'now').entries).toEqual([
    `requirement:${store.requirementId}`,
  ]);
});

it('finds an identity adopted by an accepted replacement', async () => {
  const store = await authorityStore();
  const replacement = await successorRevision(store);
  const before = counters(store.handle).writeSequence;
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: uuidv7(),
      kind: 'accepted_replacement',
      targets: [store.target],
      scope: store.project,
      source_id: store.instructionId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: { kind: 'initial' },
      replacement,
      designation: 'adopted',
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });

  expect(found(store, { kind: 'adopted' }, before)).toEqual({ entries: [], absent: [] });
  expect(found(store, { kind: 'adopted' }, 'now').entries).toContain(
    `requirement:${store.requirementId}`
  );
});

it('resolves a restored revision in adopted lookup without rewriting the withdrawn boundary', async () => {
  const store = await authorityStore();
  const replacement = await successorRevision(store);
  const append = (action: unknown) =>
    appendProjectCorrection(store.handle, {
      operationId: uuidv7(),
      action,
      attributedTo: BY_OWNER,
      recordedAt: AT,
      secretAllow: [],
    });
  const governingState = () =>
    store.handle.read((view) =>
      projectKnowledgeContext(view, {
        projectId: store.authority.projectId,
        scope: store.project,
        boundary: 'now',
        mode: 'current',
        subject: {
          kind: 'identities',
          targets: [{ kind: 'requirement', entity_id: store.requirementId }],
        },
      })
    ).value.entries[0]!.resolved.governing_state;
  const accepted = {
    action_id: uuidv7(),
    kind: 'accepted_replacement' as const,
    targets: [store.target],
    scope: store.project,
    source_id: store.instructionId,
    authorization: informedBy(store.instructionId, [store.target], store.project),
    expected_state: { kind: 'initial' as const },
    replacement,
    designation: 'adopted' as const,
  };
  await append(accepted);
  const withdrawal = {
    action_id: uuidv7(),
    kind: 'withdrawal' as const,
    targets: [replacement],
    scope: store.project,
    source_id: store.instructionId,
    authorization: informedBy(store.instructionId, [replacement], store.project),
    expected_state: { kind: 'observed' as const, ...governingState() },
    reason: 'The successor was withdrawn pending review.',
  };
  await append(withdrawal);
  const withdrawnBoundary = counters(store.handle).writeSequence;
  await append({
    action_id: uuidv7(),
    kind: 'reversal',
    targets: [replacement],
    reverses_action_id: withdrawal.action_id,
    resulting_selection: { kind: 'revision', revision: replacement, designation: 'adopted' },
    scope: store.project,
    source_id: store.instructionId,
    authorization: informedBy(store.instructionId, [replacement], store.project),
    expected_state: { kind: 'observed', ...governingState() },
  });
  const at = (boundary: number | 'now') =>
    store.handle.read((view) =>
      projectKnowledgeContext(view, {
        projectId: store.authority.projectId,
        scope: store.project,
        boundary,
        mode: boundary === 'now' ? 'current' : 'historical',
        subject: { kind: 'adopted' },
      })
    ).value.entries[0]!.resolved;

  expect(revisionGoverningState(at(withdrawnBoundary), replacement.revision_id).standing).toBe(
    'not_standing'
  );
  expect(revisionGoverningState(at('now'), replacement.revision_id).standing).toBe('adopted');
});

it('finds no identity through a task use recorded after the boundary', async () => {
  const store = await authorityStore();
  const before = counters(store.handle).writeSequence;
  await recordProjectTaskUses(store.handle, {
    operationId: uuidv7(),
    uses: [
      {
        artifact_id: store.plan.artifactId,
        plan_event_id: store.plan.planEventId,
        target: store.target,
        role: 'implement',
        local: null,
        exception_id: null,
      },
    ],
    discovery: { discovered_at: '2026-09-18T10:00:00.000Z', discovered_by: BY_AGENT },
    secretAllow: [],
  });
  const task = { kind: 'task', artifactIds: [store.plan.artifactId] } as const;

  expect(found(store, task, before)).toEqual({ entries: [], absent: [] });
  expect(found(store, task, 'now').entries).toEqual([`requirement:${store.requirementId}`]);
});

it('finds no identity through a revision naming the subject after the boundary', async () => {
  const store = await authorityStore();
  const subject = {
    subject_id: uuidv7(),
    revision_id: uuidv7(),
    previous_revision_id: null,
    label: 'Offline capture',
    kind: 'capability' as const,
    description: 'Recording an inspection with no network.',
    source_ids: [store.instructionId],
    recorded_at: AT,
  };
  await publishProjectSubject(store.handle, {
    operationId: uuidv7(),
    revision: subject,
    authoredBy: OWNER,
    secretAllow: [],
  });
  const before = counters(store.handle).writeSequence;
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision: {
      ...requirementRevision(store.requirementId, store.sourceId, {
        previousRevisionId: store.revisionId,
      }),
      subject: { subject_id: subject.subject_id, subject_revision_id: subject.revision_id },
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const asked = { kind: 'subject', subjectId: subject.subject_id } as const;

  expect(found(store, asked, before)).toEqual({ entries: [], absent: [] });
  expect(found(store, asked, 'now').entries).toEqual([`requirement:${store.requirementId}`]);
});
