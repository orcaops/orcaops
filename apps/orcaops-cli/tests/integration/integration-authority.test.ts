// The authority a task's work rests on, compared at the boundary the pre-PR pass is made at.
//
// Real project databases and real writers, driven through the CLI, with no model: the acts are
// published by the same writers a person's verbs use, and the pass is the one `orcaops finish` and
// `orcaops capture pre-pr-check` share.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  appendProjectCorrection,
  type ProjectDatabase,
  publishProjectException,
  publishProjectRequirementRevision,
  publishProjectRevocation,
  publishProjectSelection,
  readProjectArtifact,
  recordProjectTaskUses,
} from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import * as lifecycle from '../../src/lib/database-evaluators.js';
import * as prePrPass from '../../src/lib/database-pre-pr-pass.js';
import {
  integrationActingIdentity,
  readIntegrationAuthority,
} from '../../src/lib/integration-authority-facts.js';
import { fixture, grantEvaluatorPack } from '../helpers/database-history.js';
import {
  adoptedRequirement,
  AT,
  planEventOf,
  replaceRequirement,
} from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const OFFLINE = 'Local capture works with no Cloud connection.';
const REVISED = 'Local capture works with no Cloud connection, and says so.';
const ENDED = '2020-01-01T00:00:00.000Z';
const WHILE_VALID = '2019-01-01T00:00:00.000Z';

afterEach(() => vi.restoreAllMocks());

const agent = (f: Fixture) =>
  makeAgent({
    cwd: f.main,
    timeoutMs: 120_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'authority-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: f.temporary + '/unused-state',
    },
  });

async function orcaops(f: Fixture, args: string[]) {
  const raw = await agent(f).runRaw(args);
  return { raw, result: JSON.parse(raw.stdout) as Record<string, unknown> };
}

/** The retained bytes of every record a refusal must leave exactly as it found them. */
const authorityRecords = (writer: ProjectDatabase) =>
  writer.read((view) =>
    Object.fromEntries(
      (
        [
          ['adoptions', 'SELECT * FROM adoptions ORDER BY adoption_id'],
          [
            'knowledge_exceptions',
            'SELECT exception_id, scope_kind, authorization_kind, hex(record_bytes) AS bytes, record_sha256 FROM knowledge_exceptions ORDER BY exception_id',
          ],
          [
            'assignments',
            'SELECT assignment_id, hex(record_bytes) AS bytes, record_sha256 FROM assignments ORDER BY assignment_id',
          ],
          [
            'knowledge_revocations',
            'SELECT revocation_id, revoked_kind, revoked_id, hex(record_bytes) AS bytes, record_sha256 FROM knowledge_revocations ORDER BY revocation_id',
          ],
          [
            'knowledge_authorizations',
            'SELECT authorization_id, hex(record_bytes) AS bytes, record_sha256 FROM knowledge_authorizations ORDER BY authorization_id',
          ],
        ] as const
      ).map(([table, query]) => [table, JSON.stringify(view.all(query))])
    )
  ).value;

const markers = (writer: ProjectDatabase, artifactId: string) =>
  readProjectArtifact(writer, artifactId)!.thread.events.filter(
    (event) => event.record.type === 'pre_pr_checked'
  );

const lifecycleCount = (writer: ProjectDatabase) =>
  writer.read(
    (view) => view.get<{ n: number }>('SELECT count(*) AS n FROM artifact_lifecycle_revisions')!.n
  ).value;

/** An adopted rule, a captured task, and the task's recorded use of the revision it selected. */
async function taskUsing(f: Fixture, role = 'implement') {
  const projectId = f.authority.projectId;
  const artifactId = await f.capture();
  const planEventId = planEventOf(f.writer, artifactId);
  const stepId = readProjectArtifact(f.writer, artifactId)!.thread.plan!.plan_steps[0]!.step_id;
  const adopted = await adoptedRequirement(f.writer, { projectId, statement: OFFLINE });
  await recordProjectTaskUses(f.writer, {
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
        role,
        local: { step_id: stepId, criterion_id: null },
        exception_id: null,
      },
    ],
    discovery: {
      discovered_at: AT,
      discovered_by: { kind: 'actor', actor: { identity: 'owner', basis: 'other_assertion' } },
    },
    secretAllow: [],
  });
  return { projectId, artifactId, planEventId, adopted };
}

/**
 * An exception resting on an assignment, for the identity this pass acts as.
 *
 * `checkAuthorization` requires an act under an assignment to be in the assignment's own scope and
 * to claim the identity it made responsible, so both are the account this invocation runs as —
 * which is also what makes the exception a project-scoped act of this task's own actor.
 */
async function exceptRestingOnAssignment(
  f: Fixture,
  held: Awaited<ReturnType<typeof taskUsing>>,
  options: { validUntil?: string | null } = {}
) {
  const identity = integrationActingIdentity();
  if (identity === null) throw new Error('this machine names no account for the pass to act as');
  const scope = { kind: 'project', project_id: held.projectId };
  const rule = {
    kind: 'requirement',
    entity_id: held.adopted.requirementId,
    revision_id: held.adopted.revisionId,
  };
  const exceptionId = uuidv7();
  // Written here rather than with `inputFile`, which injects an idempotency key the strict
  // assignment record refuses.
  const file = path.join(f.temporary, `assignment-${exceptionId}.json`);
  await writeFile(
    file,
    JSON.stringify({
      objective: 'Let the upload queue except the offline promise while retries are reworked.',
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
      valid_until: options.validUntil ?? null,
    }),
    'utf8'
  );
  const opened = await orcaops(f, ['knowledge', 'assignment', 'open', '--json', '--input', file]);
  expect(opened.raw.exitCode, opened.raw.stdout + opened.raw.stderr).toBe(0);
  const assignmentId = opened.result.assignment_id as string;
  await publishProjectException(f.writer, {
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
    // A delegation that has since ended still covered the act when it was published, which is the
    // only way to retain one: the store refuses an act its assignment does not cover at the time
    // the act is judged at.
    ...(options.validUntil === undefined ? {} : { work: { time: WHILE_VALID } }),
    secretAllow: [],
  });
  return { assignmentId, exceptionId, identity };
}

/**
 * The pass is driven through `orcaops finish`, which shares it with `orcaops capture
 * pre-pr-check`. The second verb hangs under the in-process harness for a reason that predates this
 * check — a bare capture with the check removed hangs the same way — so it is not driven here.
 */
const finish = (f: Fixture) =>
  orcaops(f, [
    'finish',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `finish-${randomUUID()}`,
        outcome: 'the retry work is recorded',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
      })
    ),
  ]);

async function movedWithWarning(f: Fixture) {
  const held = await taskUsing(f);
  await grantEvaluatorPack(f, {
    packageId: 'test-pack',
    packRoot: fileURLToPath(new URL('../fixtures/test-pack', import.meta.url)),
    enable: { 'test-pack/pre-pr-warn-stub': true },
  });
  await replaceRequirement(f.writer, {
    projectId: held.projectId,
    adopted: held.adopted,
    statement: REVISED,
  });
  const paused = await finish(f);
  const warning = (
    paused.result.evaluator_results as { run_id: string; evaluator_ref: string; verdict: string }[]
  ).find((run) => run.verdict === 'violation')!;
  return {
    held,
    paused,
    acceptedWarnings: [
      {
        review_id: paused.result.review_id as string,
        run_id: warning.run_id,
        evaluator_ref: warning.evaluator_ref,
        reason: 'Reviewed warning',
      },
    ],
  };
}

interface AuthorityField {
  moved: {
    key: string;
    selected_revision_id: string;
    governing_revision_ids: string[];
    moved_by: { effect: string }[];
    statement: string;
  }[];
  revoked: unknown[];
}

describe('the integration authority boundary', { timeout: 180_000 }, () => {
  it.each(['marker', 'summary'])(
    'rechecks a revocation immediately before %s publication',
    async (boundary) => {
      const f = await fixture();
      const held = await taskUsing(f);
      const rested = await exceptRestingOnAssignment(f, held);
      const revoke = async () => {
        const scope = { kind: 'project', project_id: held.projectId };
        await publishProjectRevocation(f.writer, {
          operationId: uuidv7(),
          revocation: {
            revocation_id: uuidv7(),
            revokes: { kind: 'assignment', id: rested.assignmentId },
            scope,
            source_id: held.adopted.instructionId,
            instruction: {
              kind: 'explicit_instruction',
              instruction_source_id: held.adopted.instructionId,
              scope,
            },
            recorded_at: AT,
          },
          revokedBy: { identity: integrationActingIdentity(), basis: 'other_assertion' },
          secretAllow: [],
        });
      };
      if (boundary === 'marker') {
        const run = lifecycle.runDatabaseLifecycleEvaluators;
        vi.spyOn(lifecycle, 'runDatabaseLifecycleEvaluators').mockImplementationOnce(
          async (...args) => {
            const result = await run(...args);
            await revoke();
            return result;
          }
        );
      } else {
        const run = prePrPass.runDatabasePrePrPass;
        vi.spyOn(prePrPass, 'runDatabasePrePrPass').mockImplementationOnce(async (...args) => {
          const result = await run(...args);
          await revoke();
          return result;
        });
      }
      const refused = await finish(f);
      expect(refused.raw.exitCode).not.toBe(0);
      expect(refused.result.error).toMatchObject({ code: 'AUTHORITY_REVOKED' });
      expect(markers(f.writer, held.artifactId)).toHaveLength(boundary === 'marker' ? 0 : 1);
      expect(readProjectArtifact(f.writer, held.artifactId)!.thread.summary).toBeNull();
    }
  );

  it.each(['summary', 'plan revision'])('refuses revoked authority through %s', async (route) => {
    const f = await fixture();
    const held = await taskUsing(f);
    const rested = await exceptRestingOnAssignment(f, held);
    const revoked = await orcaops(f, [
      'knowledge',
      'assignment',
      'revoke',
      rested.assignmentId,
      '--reason',
      'The delegation ended.',
      '--json',
    ]);
    expect(revoked.raw.exitCode).toBe(0);
    if (route === 'plan revision') {
      const plan = readProjectArtifact(f.writer, held.artifactId)!.thread.plan!;
      const revised = await orcaops(f, [
        'capture',
        'plan',
        'revise',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: held.artifactId,
            prior_plan_event_id: held.planEventId,
            rationale: 'Clarify the task label while retaining its obligations.',
            label: 'Clarified retry work',
            plan_steps: plan.plan_steps,
            touched_scope: plan.touched_scope,
            non_goals: plan.non_goals,
          })
        ),
      ]);
      expect(revised.raw.exitCode, revised.raw.stdout + revised.raw.stderr).toBe(0);
    }
    const refused =
      route === 'summary'
        ? await orcaops(f, [
            'capture',
            'summary',
            '--input',
            inputFile(
              JSON.stringify({
                outcome: 'Retry work recorded',
                tests_written: [],
                tests_run: [],
                open_items: [],
                deferred_decisions: [],
              })
            ),
          ])
        : await finish(f);
    expect(refused.raw.exitCode).not.toBe(0);
    expect(refused.result.error).toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(readProjectArtifact(f.writer, held.artifactId)!.thread.summary).toBeNull();
  });

  it('refuses warning acceptance after the assignment is revoked', async () => {
    const f = await fixture();
    const held = await taskUsing(f);
    const rested = await exceptRestingOnAssignment(f, held);
    await grantEvaluatorPack(f, {
      packageId: 'test-pack',
      packRoot: fileURLToPath(new URL('../fixtures/test-pack', import.meta.url)),
      enable: { 'test-pack/pre-pr-warn-stub': true },
    });
    const paused = await finish(f);
    expect(paused.result.status).toBe('needs_attention');
    expect(paused.result.acceptance_allowed).toBe(true);
    const offered = paused.result.accepted_warnings as Record<string, unknown>[];
    const revoked = await orcaops(f, [
      'knowledge',
      'assignment',
      'revoke',
      rested.assignmentId,
      '--reason',
      'The delegation ended.',
      '--json',
    ]);
    expect(revoked.raw.exitCode).toBe(0);
    const refused = await orcaops(f, [
      'finish',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          outcome: 'Retry work recorded',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          accepted_warnings: offered.map((warning) => ({ ...warning, reason: 'Reviewed warning' })),
        })
      ),
    ]);
    expect(refused.raw.exitCode).not.toBe(0);
    expect(refused.result.error).toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(readProjectArtifact(f.writer, held.artifactId)!.thread.summary).toBeNull();
  });

  it('does not offer warning acceptance while a selected obligation has moved', async () => {
    const f = await fixture();
    const { paused } = await movedWithWarning(f);

    expect(paused.result.status).toBe('needs_attention');
    expect((paused.result.authority as AuthorityField).moved).toHaveLength(1);
    expect(paused.result.acceptance_allowed).toBe(false);
    expect(paused.result.accepted_warnings).toBeUndefined();
    expect(paused.result.action).toContain('orcaops task uses record');
  });

  it.each(['finish', 'direct summary'])(
    'refuses forged warning acceptance through %s',
    async (route) => {
      const f = await fixture();
      const { held, acceptedWarnings } = await movedWithWarning(f);
      const body = inputFile(
        JSON.stringify({
          outcome: 'Retry work recorded',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          accepted_warnings: acceptedWarnings,
        })
      );
      const refused = await orcaops(
        f,
        route === 'finish'
          ? ['finish', '--no-llm', '--input', body]
          : ['capture', 'summary', '--input', body]
      );

      expect(refused.raw.exitCode).not.toBe(0);
      expect(refused.result.error).toMatchObject({ code: 'INVALID_INPUT' });
      expect((refused.result.error as { message: string }).message).toContain(
        'selected obligations moved'
      );
      expect(readProjectArtifact(f.writer, held.artifactId)!.thread.summary).toBeNull();
    }
  );

  it('refuses the pass when a revocation ended the assignment an act rested on, and writes nothing to it', async () => {
    const f = await fixture();
    const held = await taskUsing(f);
    const rested = await exceptRestingOnAssignment(f, held);
    const revoked = await orcaops(f, [
      'knowledge',
      'assignment',
      'revoke',
      rested.assignmentId,
      '--reason',
      'The retry work moved to another team.',
      '--json',
    ]);
    expect(revoked.raw.exitCode, revoked.raw.stdout + revoked.raw.stderr).toBe(0);
    const before = authorityRecords(f.writer);
    const lifecyclesBefore = lifecycleCount(f.writer);

    const refused = await finish(f);

    expect(refused.raw.exitCode).not.toBe(0);
    const error = refused.result.error as { code: string; message: string };
    expect(error.code).toBe('AUTHORITY_REVOKED');
    expect(error.message).toContain(rested.exceptionId);
    expect(error.message).toContain(rested.assignmentId);
    expect(error.message).toContain(revoked.result.revocation_id as string);
    // The phase ran, so its completion is recorded; nothing else is, and no marker is minted.
    expect(lifecycleCount(f.writer)).toBe(lifecyclesBefore + 1);
    expect(markers(f.writer, held.artifactId)).toEqual([]);
    expect(authorityRecords(f.writer)).toEqual(before);
  });

  it('refuses the pass when the assignment an act rested on no longer covers the time it is judged at', async () => {
    const f = await fixture();
    const held = await taskUsing(f);
    const rested = await exceptRestingOnAssignment(f, held, { validUntil: ENDED });

    const refused = await finish(f);

    expect(refused.raw.exitCode).not.toBe(0);
    const error = refused.result.error as { code: string; message: string };
    expect(error.code).toBe('AUTHORITY_REVOKED');
    expect(error.message).toContain(rested.assignmentId);
    expect(error.message).toContain('expired');
    expect(markers(f.writer, held.artifactId)).toEqual([]);
  });

  it('names only the ended rule when an authorization rests on multiple rules', async () => {
    const f = await fixture();
    const held = await taskUsing(f);
    const scope = { kind: 'project' as const, project_id: held.projectId };
    const first = {
      kind: 'requirement' as const,
      entity_id: held.adopted.requirementId,
      revision_id: held.adopted.revisionId,
    };
    const publishRevision = async (previousRevisionId: string, statement: string) => {
      const revisionId = uuidv7();
      await publishProjectRequirementRevision(f.writer, {
        operationId: uuidv7(),
        revision: {
          requirement_id: held.adopted.requirementId,
          revision_id: revisionId,
          previous_revision_id: previousRevisionId,
          statement,
          rationale: 'Recorded so a later task can find it.',
          subject: null,
          applicability: { all_of: [] },
          duration: { kind: 'continuing' },
          source_ids: [held.adopted.sourceId],
          passages: [],
          source_standing: 'explicit_instruction',
          recorded_at: AT,
        },
        attributedTo: { kind: 'actor', actor: { identity: 'owner', basis: 'other_assertion' } },
        secretAllow: [],
      });
      return {
        kind: 'requirement' as const,
        entity_id: held.adopted.requirementId,
        revision_id: revisionId,
      };
    };
    const second = await publishRevision(held.adopted.revisionId, REVISED);
    const secondSelectionId = uuidv7();
    await publishProjectSelection(f.writer, {
      operationId: uuidv7(),
      selection: {
        selection_id: secondSelectionId,
        kind: 'accepted',
        target: second,
        scope,
        designation: 'adopted',
        authorization: {
          kind: 'informed_instruction',
          instruction_source_id: held.adopted.instructionId,
          acknowledged: [first],
          scope,
        },
        expected_state: {
          kind: 'observed',
          selection_ids: [held.adopted.selectionId],
          correction_action_ids: [],
        },
      },
      selectedBy: { identity: 'owner', basis: 'other_assertion' },
      acceptedAt: AT,
      secretAllow: [],
    });
    const third = await publishRevision(second.revision_id, `${REVISED} Twice.`);
    const thirdSelectionId = uuidv7();
    await publishProjectSelection(f.writer, {
      operationId: uuidv7(),
      selection: {
        selection_id: thirdSelectionId,
        kind: 'accepted',
        target: third,
        scope,
        designation: 'adopted',
        authorization: {
          kind: 'informed_instruction',
          instruction_source_id: held.adopted.instructionId,
          acknowledged: [first, second],
          scope,
        },
        expected_state: {
          kind: 'observed',
          selection_ids: [held.adopted.selectionId, secondSelectionId],
          correction_action_ids: [],
        },
      },
      selectedBy: { identity: 'owner', basis: 'other_assertion' },
      acceptedAt: AT,
      secretAllow: [],
    });
    await appendProjectCorrection(f.writer, {
      operationId: uuidv7(),
      action: {
        action_id: uuidv7(),
        kind: 'withdrawal',
        targets: [first],
        scope,
        source_id: held.adopted.instructionId,
        authorization: {
          kind: 'informed_instruction',
          instruction_source_id: held.adopted.instructionId,
          acknowledged: [first],
          scope,
        },
        expected_state: {
          kind: 'observed',
          selection_ids: [held.adopted.selectionId, secondSelectionId, thirdSelectionId],
          correction_action_ids: [],
        },
        reason: 'The original rule no longer stands.',
      },
      attributedTo: {
        kind: 'actor',
        actor: { identity: 'owner', basis: 'other_assertion' },
      },
      recordedAt: AT,
      secretAllow: [],
    });

    const read = readIntegrationAuthority(f.writer, {
      projectId: held.projectId,
      artifactId: held.artifactId,
      judgedAt: AT,
    });
    const authority = read?.facts.acts.find((act) => act.id === thirdSelectionId)?.authority;
    expect(authority).toMatchObject({ standing: 'basis_ended' });
    expect(authority?.reason).toContain(`requirement:${first.entity_id}@${first.revision_id}`);
    expect(authority?.reason).not.toContain(
      `requirement:${second.entity_id}@${second.revision_id}`
    );
  });

  it('pauses on a revision the plan selected that was replaced, naming the one that governs and the remedy', async () => {
    const f = await fixture();
    const held = await taskUsing(f);
    const successor = await replaceRequirement(f.writer, {
      projectId: held.projectId,
      adopted: held.adopted,
      statement: REVISED,
    });

    const paused = await finish(f);

    expect(paused.raw.exitCode, paused.raw.stdout + paused.raw.stderr).toBe(0);
    expect(paused.result.status).toBe('needs_attention');
    const authority = paused.result.authority as AuthorityField;
    expect(authority.revoked).toEqual([]);
    expect(authority.moved).toHaveLength(1);
    expect(authority.moved[0]).toMatchObject({
      key: `requirement:${held.adopted.requirementId}`,
      selected_revision_id: held.adopted.revisionId,
      governing_revision_ids: [successor.revisionId],
    });
    expect(authority.moved[0]!.moved_by.map((reason) => reason.effect)).toContain(
      'superseded_by_relationship'
    );
    expect(authority.moved[0]!.statement).toContain(successor.revisionId);
    // No evaluator warning names a run for an acceptance, so the remedy is named instead.
    expect(paused.result.acceptance_allowed).toBe(false);
    expect(paused.result.action).toContain('orcaops task uses record');
    // The pause is a pause: no summary was captured.
    expect(readProjectArtifact(f.writer, held.artifactId)!.thread.summary).toBeNull();

    // The marker carries the finding by identity and reason, and none of the rule's wording.
    const marker = markers(f.writer, held.artifactId)[0]!;
    expect(marker.payload).toMatchObject({
      outcome: 'needs_attention',
      authority: {
        moved: [
          {
            key: `requirement:${held.adopted.requirementId}`,
            selected_revision_id: held.adopted.revisionId,
            governing_revision_ids: [successor.revisionId],
            role: 'implement',
            effects: ['superseded_by_relationship'],
          },
        ],
        revoked: [],
      },
    });
    expect(JSON.stringify(marker.payload)).not.toContain(REVISED);
  });

  it('passes with an empty finding when the revision the plan selected still governs', async () => {
    const f = await fixture();
    const held = await taskUsing(f);

    const passed = await finish(f);

    expect(passed.raw.exitCode, passed.raw.stdout + passed.raw.stderr).toBe(0);
    expect(passed.result.status).not.toBe('needs_attention');
    expect(markers(f.writer, held.artifactId)[0]!.payload).toMatchObject({
      outcome: 'passed',
      authority: { moved: [], revoked: [] },
    });
  });

  it('leaves a background use out of the comparison', async () => {
    const f = await fixture();
    const held = await taskUsing(f, 'background');
    await replaceRequirement(f.writer, {
      projectId: held.projectId,
      adopted: held.adopted,
      statement: REVISED,
    });

    const passed = await finish(f);

    expect(passed.raw.exitCode, passed.raw.stdout + passed.raw.stderr).toBe(0);
    expect(markers(f.writer, held.artifactId)[0]!.payload).toMatchObject({
      outcome: 'passed',
      authority: { moved: [] },
    });
  });
});
