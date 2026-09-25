import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  appendProjectCorrection,
  openProjectDatabase,
  publishProjectRequirementRevision,
  publishProjectSelection,
} from '@orcaops/storage/history/database';

import type { KnowledgeLookupAnswer } from '../../../src/commands/knowledge/lookup.js';
import { consequenceProject, orcaops, rowCounts } from '../../helpers/consequences-acceptance.js';
import { adoptedRequirement, AT, OWNER } from '../../helpers/knowledge-records.js';

const BY_OWNER = { kind: 'actor', actor: OWNER } as const;

describe('concurrent writers', { timeout: 180_000 }, () => {
  it('lets one of two domain writers commit and refuses the stale write atomically with the current state', async () => {
    const project = await consequenceProject();
    const adopted = await adoptedRequirement(project.writer, {
      projectId: project.authority.projectId,
      statement: 'Local capture works with no Cloud connection.',
    });
    const target = {
      kind: 'requirement' as const,
      entity_id: adopted.requirementId,
      revision_id: adopted.revisionId,
    };
    const scope = { kind: 'project' as const, project_id: project.authority.projectId };
    const action = () => ({
      action_id: uuidv7(),
      kind: 'withdrawal' as const,
      targets: [target],
      scope,
      source_id: adopted.instructionId,
      authorization: {
        kind: 'informed_instruction' as const,
        instruction_source_id: adopted.instructionId,
        acknowledged: [target],
        scope,
      },
      expected_state: {
        kind: 'observed' as const,
        selection_ids: [adopted.selectionId],
        correction_action_ids: [],
      },
      reason: 'Offline capture is no longer a product promise.',
    });
    const second = await openProjectDatabase({ authority: project.authority, mode: 'writer' });
    const before = rowCounts(project.writer);
    try {
      const results = await Promise.allSettled(
        [project.writer, second].map((writer) =>
          appendProjectCorrection(writer, {
            operationId: uuidv7(),
            action: action(),
            attributedTo: BY_OWNER,
            recordedAt: AT,
            secretAllow: [],
          })
        )
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const stale = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(stale.reason).toMatchObject({
        code: 'STALE_CONTEXT',
        current: { selection_ids: [], correction_action_ids: [expect.any(String)] },
      });
      const after = rowCounts(project.writer);
      expect(after.correction_actions).toBe(before.correction_actions + 1);
      expect(after.operations).toBe(before.operations + 1);
    } finally {
      second.close();
    }
  });

  it('keeps two adopted revisions visible as a conflict with no arrival-time winner through domain writers and public lookup', async () => {
    const project = await consequenceProject();
    const adopted = await adoptedRequirement(project.writer, {
      projectId: project.authority.projectId,
      statement: 'Upload retries preserve order.',
    });
    const alternative = 'Upload retries may reorder equal-priority work.';
    const revisionId = uuidv7();
    await publishProjectRequirementRevision(project.writer, {
      operationId: uuidv7(),
      revision: {
        requirement_id: adopted.requirementId,
        revision_id: revisionId,
        previous_revision_id: adopted.revisionId,
        statement: alternative,
        rationale: 'The alternative may improve throughput.',
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
    const scope = { kind: 'project' as const, project_id: project.authority.projectId };
    await publishProjectSelection(project.writer, {
      operationId: uuidv7(),
      selection: {
        selection_id: uuidv7(),
        kind: 'accepted',
        target: later,
        scope,
        designation: 'adopted',
        authorization: {
          kind: 'informed_instruction',
          instruction_source_id: adopted.instructionId,
          acknowledged: [
            {
              kind: 'requirement',
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

    const result = await orcaops(project, [
      'knowledge',
      'lookup',
      '--identity',
      `requirement:${adopted.requirementId}`,
      '--json',
    ]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const report = result.payload as unknown as KnowledgeLookupAnswer;
    expect(report.conflicts).toHaveLength(1);
    expect(
      report.conflicts[0]!.conflict.revisions.map((revision) => revision.revision_id).sort()
    ).toEqual([adopted.revisionId, revisionId].sort());
    expect(report.conflicts[0]!.conflict.disposition?.action).toBe('ask_once');
    expect(report.entries[0]!.governing_state.selection_ids).toHaveLength(2);
    expect(
      report.entries[0]!.revisions.filter((revision) => revision.standing === 'adopted')
    ).toHaveLength(2);
  });

  it("stops here: a teammate's view after sync needs the Cloud repository", () => {
    expect('shared transport').not.toBe('local project database');
  });
});
