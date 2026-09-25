// Continuing records in a CLI fixture's project database, published through their own writers so
// the surfaces under test read what a real store holds rather than hand-inserted rows.
import { createHash } from 'node:crypto';

import { uuidv7 } from '@orcaops/storage';
import {
  appendProjectCorrection,
  createProjectRequirement,
  type ProjectDatabase,
  publishProjectKnowledgeSource,
  publishProjectRelationship,
  publishProjectRequirementRevision,
  publishProjectSelection,
} from '@orcaops/storage/history/database';

export const AT = '2026-09-17T10:00:00.000Z';
export const OWNER = { identity: 'owner', basis: 'other_assertion' } as const;
const BY_OWNER = { kind: 'actor', actor: OWNER } as const;

export const writeSequenceOf = (handle: ProjectDatabase): number =>
  handle.read(() => null).counters.writeSequence;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** A retained user instruction, which is what an act embedding an instruction cites. */
export async function instructionSource(handle: ProjectDatabase, text: string): Promise<string> {
  const bytes = Buffer.from(text, 'utf8');
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'user_instruction',
        retention: { kind: 'bytes', content_sha256: sha256(bytes) },
        location: 'session transcript, turn 1',
        source_time: AT,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: OWNER,
    retainedBytes: bytes,
    secretAllow: [],
  });
  return published.value.sourceId;
}

const revisionOf = (
  requirementId: string,
  sourceId: string,
  statement: string,
  previousRevisionId: string | null,
  passage: { source_id: string; location: string; passage_sha256: string }
) => ({
  requirement_id: requirementId,
  revision_id: uuidv7(),
  previous_revision_id: previousRevisionId,
  statement,
  rationale: 'Recorded so a later task can find it.',
  subject: null,
  applicability: { all_of: [] },
  duration: { kind: 'continuing' as const },
  source_ids: [sourceId],
  passages: [passage],
  source_standing: 'explicit_instruction' as const,
  recorded_at: AT,
});

export interface AdoptedRequirement {
  requirementId: string;
  revisionId: string;
  sourceId: string;
  instructionId: string;
  selectionId: string;
  statement: string;
  /** The write sequence the adoption committed at. */
  boundary: number;
}

/**
 * A requirement promoted from a retained instruction and never adopted, so nothing makes it
 * stand: background, whatever a task does with it.
 */
export async function recordedRequirement(
  handle: ProjectDatabase,
  input: { statement: string }
): Promise<{ requirementId: string; revisionId: string; sourceId: string }> {
  const sourceId = await instructionSource(handle, input.statement);
  const requirementId = uuidv7();
  const passage = {
    source_id: sourceId,
    location: 'bytes:0-' + String(Buffer.byteLength(input.statement, 'utf8')),
    passage_sha256: sha256(Buffer.from(input.statement, 'utf8')),
  };
  const revision = revisionOf(requirementId, sourceId, input.statement, null, passage);
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: requirementId,
      origin: { kind: 'promoted_source', passage, promoted_at: AT },
    },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return { requirementId, revisionId: revision.revision_id, sourceId };
}

/**
 * A requirement promoted from a passage and adopted for the project. Without `promotedFrom` the
 * passage is a retained instruction minted here; a caller that wants the requirement reachable
 * from a captured event names that event's published source instead.
 */
export async function adoptedRequirement(
  handle: ProjectDatabase,
  input: {
    projectId: string;
    statement: string;
    promotedFrom?: { sourceId: string; location: string };
  }
): Promise<AdoptedRequirement> {
  const sourceId =
    input.promotedFrom?.sourceId ?? (await instructionSource(handle, input.statement));
  const instructionId = await instructionSource(
    handle,
    `Adopt for the project: ${input.statement}`
  );
  const requirementId = uuidv7();
  const passage = {
    source_id: sourceId,
    location:
      input.promotedFrom?.location ??
      'bytes:0-' + String(Buffer.byteLength(input.statement, 'utf8')),
    passage_sha256: sha256(Buffer.from(input.statement, 'utf8')),
  };
  const revision = revisionOf(requirementId, sourceId, input.statement, null, passage);
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: requirementId,
      origin: { kind: 'promoted_source', passage, promoted_at: AT },
    },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const scope = { kind: 'project' as const, project_id: input.projectId };
  const selectionId = uuidv7();
  await publishProjectSelection(handle, {
    operationId: uuidv7(),
    selection: {
      selection_id: selectionId,
      kind: 'accepted',
      target: {
        kind: 'requirement' as const,
        entity_id: requirementId,
        revision_id: revision.revision_id,
      },
      scope,
      designation: 'adopted',
      authorization: {
        kind: 'explicit_instruction',
        instruction_source_id: instructionId,
        scope,
      },
      expected_state: { kind: 'initial' },
    },
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  return {
    requirementId,
    revisionId: revision.revision_id,
    sourceId,
    instructionId,
    selectionId,
    statement: input.statement,
    boundary: writeSequenceOf(handle),
  };
}

/** A successor revision of an adopted requirement, itself adopted on an informed instruction. */
export async function replaceRequirement(
  handle: ProjectDatabase,
  input: { projectId: string; adopted: AdoptedRequirement; statement: string }
): Promise<{ revisionId: string; selectionId: string; boundary: number }> {
  const { adopted } = input;
  const passage = {
    source_id: adopted.sourceId,
    location: 'bytes:0-' + String(Buffer.byteLength(input.statement, 'utf8')),
    passage_sha256: sha256(Buffer.from(input.statement, 'utf8')),
  };
  const revision = revisionOf(
    adopted.requirementId,
    adopted.sourceId,
    input.statement,
    adopted.revisionId,
    passage
  );
  await publishProjectRequirementRevision(handle, {
    operationId: uuidv7(),
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const scope = { kind: 'project' as const, project_id: input.projectId };
  const target = {
    kind: 'requirement' as const,
    entity_id: adopted.requirementId,
    revision_id: revision.revision_id,
  };
  const selectionId = uuidv7();
  await publishProjectSelection(handle, {
    operationId: uuidv7(),
    selection: {
      selection_id: selectionId,
      kind: 'accepted',
      target,
      scope,
      designation: 'adopted',
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: adopted.instructionId,
        acknowledged: [
          {
            kind: 'requirement' as const,
            entity_id: adopted.requirementId,
            revision_id: adopted.revisionId,
          },
        ],
        scope,
      },
      expected_state: {
        kind: 'observed',
        selection_ids: [adopted.selectionId],
        correction_action_ids: [],
      },
    },
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  // The established replacement is what actually stops the older revision standing; adopting the
  // successor beside it would only add a conflict.
  await publishProjectRelationship(handle, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: uuidv7(),
      relation: 'supersedes',
      from: target,
      to: {
        kind: 'requirement' as const,
        entity_id: adopted.requirementId,
        revision_id: adopted.revisionId,
      },
      scope,
      standing: 'established',
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: adopted.instructionId,
        acknowledged: [
          {
            kind: 'requirement' as const,
            entity_id: adopted.requirementId,
            revision_id: adopted.revisionId,
          },
        ],
        scope,
      },
      source_ids: [adopted.instructionId],
      explanation: 'The newer revision replaces the older one.',
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  return { revisionId: revision.revision_id, selectionId, boundary: writeSequenceOf(handle) };
}

/** A withdrawal of one revision, appended through the correction writer. */
export async function withdrawRequirement(
  handle: ProjectDatabase,
  input: {
    projectId: string;
    adopted: AdoptedRequirement;
    revisionId: string;
    selectionId: string;
  }
): Promise<{ actionId: string; boundary: number }> {
  const scope = { kind: 'project' as const, project_id: input.projectId };
  const target = {
    kind: 'requirement' as const,
    entity_id: input.adopted.requirementId,
    revision_id: input.revisionId,
  };
  const published = await appendProjectCorrection(handle, {
    operationId: uuidv7(),
    action: {
      action_id: uuidv7(),
      kind: 'withdrawal',
      targets: [target],
      scope,
      source_id: input.adopted.instructionId,
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: input.adopted.instructionId,
        acknowledged: [target],
        scope,
      },
      expected_state: {
        kind: 'observed',
        selection_ids: [input.selectionId],
        correction_action_ids: [],
      },
      reason: 'The rule is no longer a product promise.',
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  return { actionId: published.value.actionId, boundary: writeSequenceOf(handle) };
}

/** The plan event of a captured artifact, which is what a task use is keyed to. */
export function planEventOf(handle: ProjectDatabase, artifactId: string): string {
  return handle.read((view) => {
    const row = view.get<{ event_id: string }>(
      "SELECT event_id FROM artifact_events WHERE artifact_id=? AND event_type='plan_captured' ORDER BY ordinal",
      artifactId
    );
    if (row === null) throw new Error('The fixture artifact has no captured plan event');
    return row.event_id;
  }).value;
}
