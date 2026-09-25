import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  projectKnowledgeContext,
  publishProjectAuthorization,
  publishProjectConflictAnswer,
  publishProjectRequirementRevision,
  publishProjectRevocation,
  publishProjectSelection,
} from '@orcaops/storage/history/database';

import type { KnowledgeLookupAnswer } from '../../../src/commands/knowledge/lookup.js';
import {
  consequenceProject,
  orcaops,
  orcaopsWithDocument,
} from '../../helpers/consequences-acceptance.js';
import { adoptedRequirement, AT, OWNER } from '../../helpers/knowledge-records.js';

const BY_OWNER = { kind: 'actor', actor: OWNER } as const;

const lookup = (payload: Record<string, unknown>) => payload as unknown as KnowledgeLookupAnswer;

async function conflictingRequirement(
  project: Awaited<ReturnType<typeof consequenceProject>>,
  statement: string,
  alternative: string,
  scope: { kind: 'project'; project_id: string } | { kind: 'artifact'; artifact_id: string }
) {
  const adopted = await adoptedRequirement(project.writer, {
    projectId: project.authority.projectId,
    statement,
  });
  const revisionId = uuidv7();
  await publishProjectRequirementRevision(project.writer, {
    operationId: uuidv7(),
    revision: {
      requirement_id: adopted.requirementId,
      revision_id: revisionId,
      previous_revision_id: adopted.revisionId,
      statement: alternative,
      rationale: 'The alternative uses remote storage instead of the local queue.',
      subject: null,
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [adopted.sourceId],
      passages: [
        {
          source_id: adopted.sourceId,
          location: 'bytes:0-' + String(Buffer.byteLength(alternative, 'utf8')),
          passage_sha256: createHash('sha256').update(alternative, 'utf8').digest('hex'),
        },
      ],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const later = {
    kind: 'requirement' as const,
    entity_id: adopted.requirementId,
    revision_id: revisionId,
  };
  const earlier = {
    kind: 'requirement' as const,
    entity_id: adopted.requirementId,
    revision_id: adopted.revisionId,
  };
  const selectionScope = {
    kind: 'project' as const,
    project_id: project.authority.projectId,
  };
  await publishProjectSelection(project.writer, {
    operationId: uuidv7(),
    selection: {
      selection_id: uuidv7(),
      kind: 'accepted',
      target: later,
      scope: selectionScope,
      designation: 'adopted',
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: adopted.instructionId,
        acknowledged: [earlier],
        scope: selectionScope,
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
  return { adopted, earlier, later, scope };
}

async function answerConflict(
  project: Awaited<ReturnType<typeof consequenceProject>>,
  held: Awaited<ReturnType<typeof conflictingRequirement>>,
  outcome: 'authorized' | 'declined'
) {
  let authorizationId: string | null = null;
  if (outcome === 'authorized') {
    authorizationId = uuidv7();
    await publishProjectAuthorization(project.writer, {
      operationId: uuidv7(),
      authorization: {
        authorization_id: authorizationId,
        instruction: {
          kind: 'informed_instruction',
          instruction_source_id: held.adopted.instructionId,
          acknowledged: [held.earlier, held.later],
          scope: held.scope,
        },
        adopts: [],
        departs_from: [held.earlier, held.later].map((rule) => ({
          rule,
          how: 'stands_beside',
          exception_id: null,
          replaced_by: null,
        })),
        restates: [],
        context: null,
        recorded_at: AT,
      },
      grantedBy: OWNER,
      secretAllow: [],
    });
  }
  const answerIds: string[] = [];
  for (const rule of [held.earlier, held.later]) {
    const answerId = uuidv7();
    await publishProjectConflictAnswer(project.writer, {
      operationId: uuidv7(),
      answer: {
        answer_id: answerId,
        rule,
        outcome,
        context: { all_of: [] },
        scope: held.scope,
        source_id: held.adopted.instructionId,
        answered_at: AT,
        authorization_id: authorizationId,
      },
      answeredBy: OWNER,
      secretAllow: [],
    });
    answerIds.push(answerId);
  }
  return { answerIds: answerIds.sort(), authorizationId };
}

const conflictAction = (answer: KnowledgeLookupAnswer) =>
  answer.conflicts[0]?.conflict.disposition?.action;

describe('prior informed authorization', { timeout: 180_000 }, () => {
  it('renders the exact rule, rationale and consequence, distinguishing a rule change from another implementation', async () => {
    const project = await consequenceProject();
    const held = await conflictingRequirement(
      project,
      'Captures remain on this device.',
      'Captures are sent to remote storage.',
      { kind: 'project', project_id: project.authority.projectId }
    );

    const result = await orcaops(project, [
      'knowledge',
      'lookup',
      '--identity',
      `requirement:${held.adopted.requirementId}`,
    ]);

    expect(result.stdout).toContain('Captures remain on this device.');
    expect(result.stdout).toContain(
      'The alternative uses remote storage instead of the local queue.'
    );
    expect(result.stdout).toContain('change the rule');
    expect(result.stdout).toContain('another implementation');
  });

  it('reuses that exact authorization in a later session and asks again outside its scope through domain writers', async () => {
    const project = await consequenceProject();
    const firstArtifact = await project.capture();
    const secondArtifact = await project.capture();
    const held = await conflictingRequirement(
      project,
      'Captures remain on this device.',
      'Captures are sent to remote storage.',
      { kind: 'artifact', artifact_id: firstArtifact }
    );
    const before = lookup(
      (
        await orcaops(
          project,
          [
            'knowledge',
            'lookup',
            '--identity',
            `requirement:${held.adopted.requirementId}`,
            '--scope',
            `artifact:${firstArtifact}`,
            '--json',
          ],
          'first-session'
        )
      ).payload
    );
    expect(conflictAction(before)).toBe('ask_once');

    const answer = await answerConflict(project, held, 'authorized');
    const reused = lookup(
      (
        await orcaops(
          project,
          [
            'knowledge',
            'lookup',
            '--identity',
            `requirement:${held.adopted.requirementId}`,
            '--scope',
            `artifact:${firstArtifact}`,
            '--json',
          ],
          'later-session'
        )
      ).payload
    );
    expect(reused.conflicts[0]?.conflict.disposition).toMatchObject({
      action: 'reuse_authorization',
      answer_ids: answer.answerIds,
    });

    const elsewhere = lookup(
      (
        await orcaops(project, [
          'knowledge',
          'lookup',
          '--identity',
          `requirement:${held.adopted.requirementId}`,
          '--scope',
          `artifact:${secondArtifact}`,
          '--json',
        ])
      ).payload
    );
    expect(conflictAction(elsewhere)).toBe('ask_once');

    for (const answerId of answer.answerIds)
      await publishProjectRevocation(project.writer, {
        operationId: uuidv7(),
        revocation: {
          revocation_id: uuidv7(),
          revokes: { kind: 'conflict_answer', id: answerId },
          scope: held.scope,
          source_id: held.adopted.instructionId,
          instruction: {
            kind: 'explicit_instruction',
            instruction_source_id: held.adopted.instructionId,
            scope: held.scope,
          },
          recorded_at: AT,
        },
        revokedBy: OWNER,
        secretAllow: [],
      });
    const afterRevocation = lookup(
      (
        await orcaops(project, [
          'knowledge',
          'lookup',
          '--identity',
          `requirement:${held.adopted.requirementId}`,
          '--scope',
          `artifact:${firstArtifact}`,
          '--json',
        ])
      ).payload
    );
    expect(conflictAction(afterRevocation)).toBe('ask_once');
  });

  it('rests on an assignment only for its responsible party, while a declined answer still says comply through domain writers', async () => {
    const project = await consequenceProject();
    const scope = { kind: 'project' as const, project_id: project.authority.projectId };
    const assigned = await conflictingRequirement(
      project,
      'Upload retries preserve order.',
      'Upload retries may reorder equal-priority work.',
      scope
    );
    const responsible = { identity: userInfo().username, basis: 'other_assertion' };
    const assignment = await orcaopsWithDocument(
      project,
      ['knowledge', 'assignment', 'open', '--json'],
      {
        objective: 'Choose retry ordering for the upload queue.',
        inherited: [assigned.earlier, assigned.later],
        delegated: {
          adopts: [],
          departs_from: [
            {
              rule: assigned.earlier,
              how: 'stands_beside',
              exception_id: null,
              replaced_by: null,
            },
            {
              rule: assigned.later,
              how: 'stands_beside',
              exception_id: null,
              replaced_by: null,
            },
          ],
          restates: [],
        },
        allowed_changes: ['Retry ordering inside the upload queue.'],
        escalation_conditions: ['Any change to what a capture contains.'],
        responsible,
        source_id: assigned.adopted.instructionId,
        scope,
        authorization: {
          kind: 'informed_instruction',
          instruction_source_id: assigned.adopted.instructionId,
          acknowledged: [assigned.earlier, assigned.later],
          scope,
        },
        valid_until: null,
      }
    );
    expect(assignment.exitCode, assignment.stdout + assignment.stderr).toBe(0);

    const forResponsible = lookup(
      (
        await orcaops(project, [
          'knowledge',
          'lookup',
          '--identity',
          `requirement:${assigned.adopted.requirementId}`,
          '--json',
        ])
      ).payload
    );
    expect(forResponsible.conflicts[0]?.conflict.disposition).toMatchObject({
      action: 'rest_on_assignment',
      assignment_ids: [assignment.payload.assignment_id],
    });

    const forSomeoneElse = project.writer.read(
      (view) =>
        projectKnowledgeContext(view, {
          projectId: project.authority.projectId,
          scope,
          boundary: 'now',
          mode: 'current',
          subject: {
            kind: 'identities',
            targets: [{ kind: 'requirement', entity_id: assigned.adopted.requirementId }],
          },
          acting: {
            kind: 'actor',
            actor: { identity: 'somebody-else', basis: 'other_assertion' },
          },
          assignments: true,
        }).entries[0]!.resolved
    ).value;
    expect(forSomeoneElse.conflicts[0]?.disposition?.action).toBe('ask_once');

    const declined = await conflictingRequirement(
      project,
      'Offline captures remain encrypted.',
      'Offline captures may remain plaintext on trusted devices.',
      scope
    );
    await answerConflict(project, declined, 'declined');
    const refused = lookup(
      (
        await orcaops(project, [
          'knowledge',
          'lookup',
          '--identity',
          `requirement:${declined.adopted.requirementId}`,
          '--json',
        ])
      ).payload
    );
    expect(conflictAction(refused)).toBe('comply');
  });
});
