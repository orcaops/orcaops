// An adopted requirement about a published subject, so a question asked by subject reaches a
// record. The requirements `knowledge-records.ts` publishes name no subject, and a question by
// subject over a store that holds none measures a read that resolves nothing.
import { createHash } from 'node:crypto';

import { uuidv7 } from '@orcaops/storage';
import {
  createProjectRequirement,
  type ProjectDatabase,
  publishProjectSelection,
  publishProjectSubject,
} from '@orcaops/storage/history/database';

import { AT, instructionSource, OWNER } from './knowledge-records.js';

const BY_OWNER = { kind: 'actor', actor: OWNER } as const;

export interface SubjectRequirement {
  subjectId: string;
  requirementId: string;
  revisionId: string;
}

export async function adoptedRequirementAboutASubject(
  handle: ProjectDatabase,
  input: { projectId: string; statement: string; subjectLabel: string }
): Promise<SubjectRequirement> {
  const sourceId = await instructionSource(handle, input.statement);
  const subjectId = uuidv7();
  const subjectRevisionId = uuidv7();
  await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision: {
      subject_id: subjectId,
      revision_id: subjectRevisionId,
      previous_revision_id: null,
      label: input.subjectLabel,
      kind: 'capability',
      description: `What ${input.subjectLabel} does on this machine.`,
      source_ids: [sourceId],
      recorded_at: AT,
    },
    authoredBy: OWNER,
    secretAllow: [],
  });

  const requirementId = uuidv7();
  const revisionId = uuidv7();
  const passage = {
    source_id: sourceId,
    location: `bytes:0-${Buffer.byteLength(input.statement, 'utf8')}`,
    passage_sha256: createHash('sha256').update(input.statement, 'utf8').digest('hex'),
  };
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: requirementId,
      origin: { kind: 'promoted_source', passage, promoted_at: AT },
    },
    revision: {
      requirement_id: requirementId,
      revision_id: revisionId,
      previous_revision_id: null,
      statement: input.statement,
      rationale: 'Recorded so a question about the subject can find it.',
      subject: { subject_id: subjectId, subject_revision_id: subjectRevisionId },
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [sourceId],
      passages: [passage],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });

  const instructionId = await instructionSource(
    handle,
    `Adopt for the project: ${input.statement}`
  );
  const scope = { kind: 'project' as const, project_id: input.projectId };
  await publishProjectSelection(handle, {
    operationId: uuidv7(),
    selection: {
      selection_id: uuidv7(),
      kind: 'accepted',
      target: { kind: 'requirement', entity_id: requirementId, revision_id: revisionId },
      scope,
      designation: 'adopted',
      authorization: { kind: 'explicit_instruction', instruction_source_id: instructionId, scope },
      expected_state: { kind: 'initial' },
    },
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });

  return { subjectId, requirementId, revisionId };
}
