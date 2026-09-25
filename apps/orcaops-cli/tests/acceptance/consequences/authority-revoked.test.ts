import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  publishProjectException,
  publishProjectRevocation,
  readProjectArtifact,
  recordProjectTaskUses,
} from '@orcaops/storage/history/database';

import {
  consequenceProject,
  orcaops,
  orcaopsWithDocument,
  tableRows,
} from '../../helpers/consequences-acceptance.js';
import {
  adoptedRequirement,
  AT,
  OWNER,
  planEventOf,
  replaceRequirement,
} from '../../helpers/knowledge-records.js';

const OFFLINE = 'Local capture works with no Cloud connection.';
const REVISED = 'Local capture works with no Cloud connection, and says so in the summary.';

async function taskUsing(project: Awaited<ReturnType<typeof consequenceProject>>) {
  const artifactId = await project.capture();
  const planEventId = planEventOf(project.writer, artifactId);
  const stepId = readProjectArtifact(project.writer, artifactId)!.thread.plan!.plan_steps[0]!
    .step_id;
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
    discovery: {
      discovered_at: AT,
      discovered_by: { kind: 'actor', actor: OWNER },
    },
    secretAllow: [],
  });
  return { artifactId, planEventId, stepId, adopted };
}

async function assignedException(
  project: Awaited<ReturnType<typeof consequenceProject>>,
  held: Awaited<ReturnType<typeof taskUsing>>
) {
  const identity = userInfo().username;
  const scope = { kind: 'project' as const, project_id: project.authority.projectId };
  const rule = {
    kind: 'requirement' as const,
    entity_id: held.adopted.requirementId,
    revision_id: held.adopted.revisionId,
  };
  const exceptionId = uuidv7();
  const assignment = await orcaopsWithDocument(
    project,
    ['knowledge', 'assignment', 'open', '--json'],
    {
      objective: 'Let upload retries except the offline promise while the queue is reworked.',
      inherited: [],
      delegated: {
        adopts: [],
        departs_from: [{ rule, how: 'excepts', exception_id: exceptionId, replaced_by: null }],
        restates: [],
      },
      allowed_changes: ['Retry scheduling inside the upload queue.'],
      escalation_conditions: ['Any change to what is captured while offline.'],
      responsible: { identity, basis: 'other_assertion' },
      source_id: held.adopted.instructionId,
      scope,
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: held.adopted.instructionId,
        acknowledged: [rule],
        scope,
      },
      valid_until: null,
    }
  );
  expect(assignment.exitCode, assignment.stdout + assignment.stderr).toBe(0);
  const assignmentId = assignment.payload.assignment_id as string;
  await publishProjectException(project.writer, {
    operationId: uuidv7(),
    exception: {
      exception_id: exceptionId,
      expectation: rule,
      context: {
        all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['upload-retry'] }],
      },
      scope,
      rationale: 'Retries may re-send a capture the queue already holds.',
      source_id: held.adopted.instructionId,
      authorization: { kind: 'assignment', assignment_id: assignmentId },
      ends: { kind: 'until_revoked' },
      end_behavior: 'expectation_applies_again',
      expected_state: {
        kind: 'observed',
        selection_ids: [held.adopted.selectionId],
        correction_action_ids: [],
      },
    },
    grantedBy: { identity, basis: 'other_assertion' },
    secretAllow: [],
  });
  return { assignmentId, exceptionId, identity, rule, scope };
}

const prePr = (project: Awaited<ReturnType<typeof consequenceProject>>) =>
  orcaopsWithDocument(project, ['capture', 'pre-pr-check', '--no-llm'], {});

const finish = (project: Awaited<ReturnType<typeof consequenceProject>>) =>
  orcaopsWithDocument(project, ['finish', '--no-llm'], {
    idempotency_key: `finish-${randomUUID()}`,
    outcome: 'The retry work is recorded.',
    tests_written: [],
    tests_run: [],
    open_items: [],
    deferred_decisions: [],
  });

const markers = (project: Awaited<ReturnType<typeof consequenceProject>>, artifactId: string) =>
  readProjectArtifact(project.writer, artifactId)!.thread.events.filter(
    (event) => event.record.type === 'pre_pr_checked'
  );

const lifecycleCount = (project: Awaited<ReturnType<typeof consequenceProject>>) =>
  project.writer.read(
    (view) => view.get<{ n: number }>('SELECT count(*) AS n FROM artifact_lifecycle_revisions')!.n
  ).value;

const retainedAuthorityBytes = (
  project: Awaited<ReturnType<typeof consequenceProject>>,
  rested: Awaited<ReturnType<typeof assignedException>>
) =>
  project.writer.read((view) => ({
    assignment: view.get<{ bytes: string }>(
      'SELECT hex(record_bytes) AS bytes FROM assignments WHERE assignment_id=?',
      rested.assignmentId
    )!.bytes,
    exception: view.get<{ bytes: string }>(
      'SELECT hex(record_bytes) AS bytes FROM knowledge_exceptions WHERE exception_id=?',
      rested.exceptionId
    )!.bytes,
  })).value;

describe('authority revoked before integration', { timeout: 240_000 }, () => {
  it('requires the old act to end before valid replacement authority permits integration', async () => {
    const project = await consequenceProject({ configure: false });
    const held = await taskUsing(project);
    const rested = await assignedException(project, held);
    const oldBytes = retainedAuthorityBytes(project, rested);
    const revoked = await orcaops(project, [
      'knowledge',
      'assignment',
      'revoke',
      rested.assignmentId,
      '--reason',
      'The retry work moved to another team.',
      '--json',
    ]);
    expect(revoked.exitCode, revoked.stdout + revoked.stderr).toBe(0);
    const before = tableRows(project.writer, [
      'knowledge_exceptions',
      'assignments',
      'knowledge_revocations',
    ]);
    const lifecyclesBefore = lifecycleCount(project);

    for (const refused of [await prePr(project), await finish(project)]) {
      expect(refused.exitCode).not.toBe(0);
      const error = refused.payload.error as { code: string; message: string };
      expect(error.code).toBe('AUTHORITY_REVOKED');
      expect(error.message).toContain(rested.exceptionId);
      expect(error.message).toContain(rested.assignmentId);
      expect(error.message).toContain(revoked.payload.revocation_id as string);
      expect(error.message).toContain(rested.identity);
      expect(error.message).toMatch(/ at \d{4}-\d{2}-\d{2}T/u);
    }
    expect(lifecycleCount(project)).toBe(lifecyclesBefore + 2);
    expect(
      tableRows(project.writer, ['knowledge_exceptions', 'assignments', 'knowledge_revocations'])
    ).toEqual(before);
    expect(markers(project, held.artifactId)).toEqual([]);

    await assignedException(project, held);
    const replacementAlone = await prePr(project);
    expect(replacementAlone.exitCode).not.toBe(0);
    expect(replacementAlone.payload.error).toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect((replacementAlone.payload.error as { message: string }).message).toContain(
      rested.exceptionId
    );
    expect(markers(project, held.artifactId)).toEqual([]);

    await publishProjectRevocation(project.writer, {
      operationId: uuidv7(),
      revocation: {
        revocation_id: uuidv7(),
        revokes: { kind: 'exception', id: rested.exceptionId },
        scope: rested.scope,
        source_id: held.adopted.instructionId,
        instruction: {
          kind: 'explicit_instruction',
          instruction_source_id: held.adopted.instructionId,
          scope: rested.scope,
        },
        recorded_at: AT,
      },
      revokedBy: OWNER,
      secretAllow: [],
    });

    const prePrPassed = await prePr(project);
    expect(prePrPassed.exitCode, prePrPassed.stdout + prePrPassed.stderr).toBe(0);
    expect(prePrPassed.payload.pre_pr_outcome).toBe('passed');
    const finishPassed = await finish(project);
    expect(finishPassed.exitCode, finishPassed.stdout + finishPassed.stderr).toBe(0);
    expect(readProjectArtifact(project.writer, held.artifactId)!.thread.summary).not.toBeNull();
    expect(markers(project, held.artifactId).at(-1)!.payload).toMatchObject({
      outcome: 'passed',
      authority: { moved: [], revoked: [] },
    });
    expect(retainedAuthorityBytes(project, rested)).toEqual(oldBytes);
  });

  it('reports a moved obligation and proceeds only after the recorded plan use is updated through public and domain operations', async () => {
    const project = await consequenceProject({ configure: false });
    const held = await taskUsing(project);
    const successor = await replaceRequirement(project.writer, {
      projectId: project.authority.projectId,
      adopted: held.adopted,
      statement: REVISED,
    });

    const paused = await finish(project);
    expect(paused.exitCode, paused.stdout + paused.stderr).toBe(0);
    expect(paused.payload).toMatchObject({ status: 'needs_attention', acceptance_allowed: false });
    expect(paused.payload.action).toContain('orcaops task uses record');
    expect(readProjectArtifact(project.writer, held.artifactId)!.thread.summary).toBeNull();

    const plan = readProjectArtifact(project.writer, held.artifactId)!.thread.plan!;
    const revised = await orcaopsWithDocument(project, ['capture', 'plan', 'revise', '--no-llm'], {
      idempotency_key: `revise-${randomUUID()}`,
      artifact_id: held.artifactId,
      prior_plan_event_id: plan.source_event_id,
      rationale: 'Use the revision that now governs.',
      label: plan.label,
      plan_steps: plan.plan_steps,
      touched_scope: plan.touched_scope,
      non_goals: plan.non_goals,
    });
    expect(revised.exitCode, revised.stdout + revised.stderr).toBe(0);
    const recorded = await orcaops(project, [
      'task',
      'uses',
      'record',
      '--artifact',
      held.artifactId,
      '--plan-event',
      revised.payload.plan_event_id as string,
      '--identity',
      `requirement:${held.adopted.requirementId}`,
      '--revision',
      successor.revisionId,
      '--role',
      'implement',
      '--step',
      held.stepId,
      '--discovered-at',
      AT,
      '--discovered-by',
      'owner',
      '--json',
    ]);
    expect(recorded.exitCode, recorded.stdout + recorded.stderr).toBe(0);

    const passed = await finish(project);
    expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0);
    expect(passed.payload.status).not.toBe('needs_attention');
    expect(readProjectArtifact(project.writer, held.artifactId)!.thread.summary).not.toBeNull();
  });
});
