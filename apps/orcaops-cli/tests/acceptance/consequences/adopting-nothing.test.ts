import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  readProjectArtifact,
  recordProjectTaskUses,
  resolveProjectKnowledge,
} from '@orcaops/storage/history/database';

import {
  consequenceProject,
  orcaops,
  orcaopsWithDocument,
  tableRows,
} from '../../helpers/consequences-acceptance.js';
import { commitFile } from '../../helpers/database-fingerprint.js';
import { git } from '../../helpers/database-history.js';
import { adoptedRequirement, AT, OWNER, planEventOf } from '../../helpers/knowledge-records.js';

const OFFLINE = 'Local capture works with no Cloud connection.';
const DECIDING_TABLES = [
  'adoptions',
  'record_relationships',
  'correction_actions',
  'knowledge_exceptions',
  'knowledge_authorizations',
  'assignments',
  'assignment_members',
  'knowledge_revocations',
  'task_uses',
];

function answer(project: Awaited<ReturnType<typeof consequenceProject>>, requirementId: string) {
  const { basis: _basis, ...resolved } = project.writer.read((view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: requirementId },
      project.authority.projectId,
      { kind: 'project', project_id: project.authority.projectId },
      {}
    )
  ).value;
  return resolved;
}

const intent = (project: Awaited<ReturnType<typeof consequenceProject>>) =>
  project.writer.read(() => null).counters.intentChangeCounter;

describe('repository and task movement', { timeout: 300_000 }, () => {
  it('adopts nothing across lineage, checkout, plan revision, reassignment, sync and import through public commands', async () => {
    const project = await consequenceProject();
    const artifactId = await project.capture();
    const linkedArtifact = await project.capture(undefined, { cwd: project.linked });
    const planEventId = planEventOf(project.writer, artifactId);
    const plan = readProjectArtifact(project.writer, artifactId)!.thread.plan!;
    const stepId = plan.plan_steps[0]!.step_id;
    const adopted = await adoptedRequirement(project.writer, {
      projectId: project.authority.projectId,
      statement: OFFLINE,
    });
    await recordProjectTaskUses(project.writer, {
      operationId: uuidv7(),
      uses: [
        {
          artifact_id: artifactId,
          plan_event_id: planEventId,
          target: {
            kind: 'requirement',
            entity_id: adopted.requirementId,
            revision_id: adopted.revisionId,
          },
          role: 'implement',
          local: { step_id: stepId, criterion_id: null },
          exception_id: null,
        },
      ],
      discovery: { discovered_at: AT, discovered_by: { kind: 'actor', actor: OWNER } },
      secretAllow: [],
    });
    const expectedAnswer = answer(project, adopted.requirementId);
    const expectedRecords = tableRows(project.writer, DECIDING_TABLES);
    const unchanged = () => {
      expect(answer(project, adopted.requirementId)).toEqual(expectedAnswer);
      expect(tableRows(project.writer, DECIDING_TABLES)).toEqual(expectedRecords);
    };

    await commitFile(project, 'lineage.ts', 'export const lineage = true;\n');
    let beforeIntent = intent(project);
    const lineage = await orcaops(project, ['lineage', '--json']);
    expect(lineage.exitCode, lineage.stdout + lineage.stderr).toBe(0);
    expect([
      ...(lineage.payload.updated as unknown[]),
      ...(lineage.payload.merged as unknown[]),
    ]).toEqual(expect.arrayContaining([expect.anything(), expect.anything()]));
    unchanged();
    expect(intent(project)).toBe(beforeIntent);

    const other = await project.capture();
    const afterCaptureRecords = tableRows(project.writer, DECIDING_TABLES);
    beforeIntent = intent(project);
    const checkout = await orcaops(project, ['checkout', other, '--json']);
    expect(checkout.exitCode, checkout.stdout + checkout.stderr).toBe(0);
    expect(answer(project, adopted.requirementId)).toEqual(expectedAnswer);
    expect(tableRows(project.writer, DECIDING_TABLES)).toEqual(afterCaptureRecords);
    expect(intent(project)).toBe(beforeIntent);

    beforeIntent = intent(project);
    const revised = await orcaopsWithDocument(project, ['capture', 'plan', 'revise', '--no-llm'], {
      idempotency_key: `revise-${randomUUID()}`,
      artifact_id: artifactId,
      prior_plan_event_id: planEventId,
      rationale: 'Give the task a clearer label.',
      label: 'A clearer label',
      plan_steps: plan.plan_steps,
      touched_scope: plan.touched_scope,
      non_goals: plan.non_goals,
    });
    expect(revised.exitCode, revised.stdout + revised.stderr).toBe(0);
    unchanged();
    expect(intent(project)).toBeGreaterThan(beforeIntent);

    beforeIntent = intent(project);
    const opened = await orcaopsWithDocument(
      project,
      ['capture', 'checkpoint', 'open', '--no-llm'],
      {
        idempotency_key: `open-${randomUUID()}`,
        artifact_id: artifactId,
        agent_session_id: 'another-session',
        declared_step_ids: [stepId],
      }
    );
    expect(opened.exitCode, opened.stdout + opened.stderr).toBe(0);
    const closed = await orcaopsWithDocument(
      project,
      ['capture', 'checkpoint', 'close', '--no-llm'],
      {
        idempotency_key: `close-${randomUUID()}`,
        artifact_id: artifactId,
        n: opened.payload.n,
        summary: 'Another session completed no decision-bearing work.',
        files_changed: [],
        completed_step_ids: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
      }
    );
    expect(closed.exitCode, closed.stdout + closed.stderr).toBe(0);
    unchanged();
    expect(intent(project)).toBe(beforeIntent);

    beforeIntent = intent(project);
    const resync = await orcaops(project, ['resync', '--json']);
    expect(resync.payload).toBeTruthy();
    unchanged();
    expect(intent(project)).toBe(beforeIntent);

    await git(project.main, ['checkout', '-q', 'main']);
    await commitFile(project, 'seeded.ts', 'export const seeded = true;\n');
    beforeIntent = intent(project);
    const seeded = await orcaops(project, [
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);
    expect(seeded.exitCode, seeded.stdout + seeded.stderr).toBe(0);
    unchanged();
    expect(intent(project)).toBeGreaterThanOrEqual(beforeIntent);

    expect(linkedArtifact).not.toBe(artifactId);
  });
});
