// One project history, one identity that moved, four surfaces.
//
// `show`, `digest`, Watch's detail and the review account lane each render a thread's own captures
// and each now puts the same continuing knowledge beside them. They agree because they read one
// answer, not because four flattenings happen to line up today — so this test is the one that
// notices the day a surface starts deciding for itself.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { relatedKnowledgeBounds } from '@orcaops/core';
import { reviewKnowledge } from '@orcaops/review-engine';
import { type ArtifactDraftSemantics, prepareArtifactDraft, uuidv7 } from '@orcaops/storage';
import {
  appendProjectArtifactEvents,
  appendProjectCorrection,
  openProjectDatabase,
  publishProjectRequirementRevision,
  readProjectArtifact,
  recordProjectTaskUses,
  retrieveRelatedKnowledge,
} from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';
import { HistoryWatchEngine } from '@orcaops/watch-data';

import {
  defaultRunInputPolicy,
  prepareDatabaseReviewRunInputs,
} from '../../../../packages/review-engine/src/database/run-inputs.js';
import { capturedReviewFixture } from '../../../../packages/review-engine/tests/capturedReviewFixture.js';
import { readRetainedJobSource } from '../../src/knowledge-worker/job-source.js';
import { fixture, inventory } from '../helpers/database-history.js';
import {
  adoptedRequirement,
  AT,
  instructionSource,
  recordedRequirement,
  replaceRequirement,
  writeSequenceOf,
} from '../helpers/knowledge-records.js';
import { readArtifactExport } from '../support/artifact-export.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const ORIGINAL = 'Local capture works with no Cloud connection.';
const REPLACEMENT = 'Local capture works with no Cloud connection, and says so in its output.';
const PROJECT_RULE = 'Correction authority remains visible across every task surface.';
const LOCAL_EXCEPTION = 'Only the ledger task may abbreviate correction authority in its report.';
const LATER_RULE = 'Task surfaces retrieve newer correction authority before dispatch.';

const engines: HistoryWatchEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
});

function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 90_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'one-answer-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: f.temporary + '/unused-state',
    },
  });
}

async function run(f: Fixture, args: string[]) {
  const raw = await agent(f).runRaw(args);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout) as Record<string, never>;
}

interface Entry {
  key: string;
  governing_revision_ids: string[];
  revisions: { revision_id: string }[];
}
interface Block {
  basis: { knowledge_boundary: number; mode: string };
  entries: Entry[];
  applicable: string[];
  applicable_not_selected: {
    entries: { key: string; revision_ids: string[]; selected_revision_ids: string[] }[];
  };
  later_annotations: unknown[];
  coverage: { statement: string };
}

const entryOf = (block: Block, key: string): Entry =>
  block.entries.find((entry) => entry.key === key)!;

/** A repository install, which is how `digest` and `knowledge` reads resolve their project. */
async function installed(): Promise<Fixture> {
  const f = await fixture();
  await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(f.main, '.orcaops', 'config.json'),
    JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm: { tool: 'none' } }),
    'utf8'
  );
  return f;
}

const digest = (text: string): string =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

async function correctionAdoption(
  handle: Fixture['writer'],
  input: {
    projectId: string;
    scope: { kind: 'project'; project_id: string } | { kind: 'artifact'; artifact_id: string };
    statement: string;
  }
) {
  const draft = await recordedRequirement(handle, { statement: `Draft: ${input.statement}` });
  const sourceId = await instructionSource(handle, input.statement);
  const instructionId = await instructionSource(handle, `Adopt this rule: ${input.statement}`);
  const replacement = {
    requirement_id: draft.requirementId,
    revision_id: uuidv7(),
    previous_revision_id: draft.revisionId,
    statement: input.statement,
    rationale: 'The correction supplies the governing wording and adoption.',
    subject: null,
    applicability: { all_of: [] },
    duration: { kind: 'continuing' as const },
    source_ids: [sourceId],
    passages: [
      {
        source_id: sourceId,
        location: `bytes:0-${Buffer.byteLength(input.statement, 'utf8')}`,
        passage_sha256: digest(input.statement),
      },
    ],
    source_standing: 'explicit_instruction' as const,
    recorded_at: AT,
  };
  await publishProjectRequirementRevision(handle, {
    operationId: uuidv7(),
    revision: replacement,
    attributedTo: { kind: 'actor', actor: { identity: 'owner', basis: 'other_assertion' } },
    secretAllow: [],
  });
  const actionId = uuidv7();
  const target = {
    kind: 'requirement' as const,
    entity_id: draft.requirementId,
    revision_id: draft.revisionId,
  };
  await appendProjectCorrection(handle, {
    operationId: uuidv7(),
    action: {
      action_id: actionId,
      kind: 'accepted_replacement',
      targets: [target],
      scope: input.scope,
      source_id: instructionId,
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: instructionId,
        acknowledged: [target],
        scope: input.scope,
      },
      expected_state: { kind: 'initial' },
      replacement: {
        kind: 'requirement',
        entity_id: draft.requirementId,
        revision_id: replacement.revision_id,
      },
      designation: 'adopted',
    },
    attributedTo: { kind: 'actor', actor: { identity: 'owner', basis: 'other_assertion' } },
    recordedAt: AT,
    secretAllow: [],
  });
  return {
    requirementId: draft.requirementId,
    revisionId: replacement.revision_id,
    actionId,
  };
}

const knowledgeOf = (value: unknown): Block => (value as { knowledge: Block }).knowledge;

async function appendArtifactMutation<T>(
  handle: Fixture['writer'],
  artifactId: string,
  authoredPayload: unknown,
  mutate: (semantics: ArtifactDraftSemantics) => Promise<T>
): Promise<{ value: T; eventId: string }> {
  const retained = readProjectArtifact(handle, artifactId)!;
  const draft = await prepareArtifactDraft(
    {
      artifactId,
      priorEvents: retained.thread.events,
      authoredPayload,
      secretAllow: [],
      idempotencyBlocks: [],
    },
    mutate
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  if (draft.events.length !== 1 || draft.idempotencyChanges.length !== 0)
    throw new Error('The fixture mutation did not prepare exactly one new event');
  const event = draft.events[0]!;
  await appendProjectArtifactEvents(handle, {
    artifactId,
    operationId: uuidv7(),
    expectedRevision: retained.revision,
    eventBytes: event.eventBytes,
    sidecarPayloads: event.sidecar
      ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }]
      : [],
    secretAllow: [],
  });
  return { value: draft.evaluation.value, eventId: event.record.event_id };
}

describe('one answer, every surface', { timeout: 180_000 }, () => {
  it('reports one governing revision and one boundary for one identity, in show, digest, Watch and the dossier', async () => {
    const f = await installed();
    const projectId = f.authority.projectId;
    const adopted = await adoptedRequirement(f.writer, { projectId, statement: ORIGINAL });

    const captured = await run(f, [
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'Keep the recorded rules in view while the work runs',
          label: 'Rules in view',
          plan_steps: [
            { text: 'do the work', label: 'Do it', acceptance_criteria: [{ text: 'delivered' }] },
          ],
          touched_scope: [],
          non_goals: [],
          knowledge_uses: [
            {
              kind: 'requirement',
              entity_id: adopted.requirementId,
              revision_id: adopted.revisionId,
              role: 'implement',
            },
          ],
        })
      ),
    ]);
    const artifactId = captured.artifact_id as unknown as string;
    const selectedBoundary = writeSequenceOf(f.writer);

    const replaced = await replaceRequirement(f.writer, {
      projectId,
      adopted,
      statement: REPLACEMENT,
    });
    const key = `requirement:${adopted.requirementId}`;
    const before = await inventory(f.root);

    const shown = JSON.parse((await readArtifactExport(agent(f), artifactId)).stdout);
    const showBlock = (shown.artifact as unknown as { knowledge: Block }).knowledge;

    const digested = await run(f, ['digest', '--artifact', artifactId, '--json']);
    const digestBlock = digested.knowledge as unknown as Block;

    const engine = new HistoryWatchEngine({ scope: { root: f.root, cwd: f.main } });
    engines.push(engine);
    await engine.start(Date.now());
    const watched = engine
      .snapshot!.projects.flatMap((project) => project.threads)
      .find((thread) => thread.artifactId === artifactId)!;
    const watchBlock = watched.knowledge as unknown as Block;

    // A run reads at its floor's boundary; with no floor in view the lane reads where show does.
    const lane = reviewKnowledge(f.writer, {
      members: [readProjectArtifact(f.writer, artifactId)!.thread],
      boundary: 'now',
    });
    const laneKnowledge = lane.tasks[0]!.knowledge;

    // The one assertion the whole step is for: four surfaces, one governing revision, one boundary.
    for (const [name, block] of [
      ['show', showBlock],
      ['digest', digestBlock],
      ['watch', watchBlock],
    ] as const) {
      expect(entryOf(block, key).governing_revision_ids, name).toEqual([replaced.revisionId]);
      expect(block.basis.knowledge_boundary, name).toBe(showBlock.basis.knowledge_boundary);
      expect(block.applicable, name).toContain(key);
    }
    expect(laneKnowledge.entries.find((entry) => entry.key === key)!.governingRevisionIds).toEqual([
      replaced.revisionId,
    ]);
    expect(laneKnowledge.boundary).toBe(showBlock.basis.knowledge_boundary);

    // The plan selected the revision that used to govern, so the one that governs now is
    // applicable and not selected — the drift reads as drift, not as a rule nobody looked at.
    expect(showBlock.applicable_not_selected.entries).toEqual([
      expect.objectContaining({
        key,
        revision_ids: [replaced.revisionId],
        selected_revision_ids: [adopted.revisionId],
      }),
    ]);
    expect(laneKnowledge.applicableNotSelected).toEqual([
      { key, revisionIds: [replaced.revisionId] },
    ]);

    // Every one of those reads is passive.
    expect(await inventory(f.root)).toEqual(before);

    // At the earlier boundary the earlier revision governs, and the later one is dated beside the
    // answer rather than merged into it.
    const historical = JSON.parse(
      (await readArtifactExport(agent(f), artifactId, ['--at-boundary', String(selectedBoundary)]))
        .stdout
    );
    const past = (historical.artifact as unknown as { knowledge: Block }).knowledge;
    expect(past.basis).toMatchObject({ knowledge_boundary: selectedBoundary, mode: 'historical' });
    expect(entryOf(past, key).governing_revision_ids).toEqual([adopted.revisionId]);
    expect(entryOf(past, key).revisions.map((revision) => revision.revision_id)).not.toContain(
      replaced.revisionId
    );
    expect(past.later_annotations.length).toBeGreaterThan(0);
    expect(past.applicable_not_selected.entries).toEqual([]);

    // A digest rendered at that boundary names it in its own output.
    const pastDigest = await run(f, [
      'digest',
      '--artifact',
      artifactId,
      '--at-boundary',
      String(selectedBoundary),
      '--json',
    ]);
    expect((pastDigest.knowledge as unknown as Block).basis.knowledge_boundary).toBe(
      selectedBoundary
    );
    expect(pastDigest.markdown as unknown as string).toContain(
      `Knowledge read at write sequence ${selectedBoundary}`
    );

    expect(await inventory(f.root)).toEqual(before);
  });

  it('carries correction authority and a task-local exception through current and historical task surfaces and retained review input', async () => {
    const review = await capturedReviewFixture({
      artifacts: [
        {
          label: 'Retain correction authority',
          task: 'Retain correction authority across task surfaces',
          checkpoints: [
            {
              summary: 'Recorded correction authority in the ledger task.',
              changes: { 'src/ledger.ts': 'export const correctionAuthority = true;\n' },
            },
          ],
        },
        {
          label: 'Keep the neighboring task isolated',
          task: 'Keep task-local authority out of neighboring work',
          checkpoints: [
            {
              summary: 'Recorded the neighboring task.',
              changes: { 'src/neighbor.ts': 'export const neighboringTask = true;\n' },
            },
          ],
        },
      ],
    });
    await mkdir(path.join(review.gitRoot, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(review.gitRoot, '.orcaops', 'config.json'),
      JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm: { tool: 'none' } }),
      'utf8'
    );
    const writer = await openProjectDatabase({ authority: review.authority, mode: 'writer' });
    try {
      const first = review.artifacts[0]!;
      const second = review.artifacts[1]!;
      const projectRule = await correctionAdoption(writer, {
        projectId: review.projectId,
        scope: { kind: 'project', project_id: review.projectId },
        statement: PROJECT_RULE,
      });
      const localException = await correctionAdoption(writer, {
        projectId: review.projectId,
        scope: { kind: 'artifact', artifact_id: first.artifactId },
        statement: LOCAL_EXCEPTION,
      });
      const historicalBoundary = writeSequenceOf(writer);
      const original = readProjectArtifact(writer, first.artifactId)!.thread;
      const originalPlanEventId = original.plan!.source_event_id;
      const checkpointEventId = original.events.find(
        (event) => event.record.type === 'checkpoint_closed'
      )!.record.event_id;

      const reviewAgent = makeAgent({
        cwd: review.gitRoot,
        timeoutMs: 90_000,
        env: {
          ORCAOPS_ROOT: review.gitRoot,
          ORCAOPS_DATA_DIR: review.dataRoot,
          ORCAOPS_DISABLE_DRAIN: '1',
          CODEX_SESSION_ID: 'correction-surfaces-session',
          CLAUDE_SESSION_ID: '',
          CLAUDE_CODE_SESSION_ID: '',
          TMUX_PANE: '',
          STY: '',
          WINDOW: '',
          TTY: '',
          XDG_STATE_HOME: path.join(review.root, 'unused-state'),
        },
      });
      const invoke = async (args: string[]) => {
        const raw = await reviewAgent.runRaw(args);
        expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
        return JSON.parse(raw.stdout) as Record<string, unknown>;
      };
      const reviseKey = `revise-${randomUUID()}`;
      const revised = await appendArtifactMutation(
        writer,
        first.artifactId,
        { rationale: 'The task now records corrected authority.' },
        (semantics) =>
          semantics.revisePlan(
            {
              idempotency_key: reviseKey,
              artifact_id: first.artifactId,
              prior_plan_event_id: originalPlanEventId,
              rationale: 'The task now records corrected authority.',
              label: 'Retain corrected authority',
              plan_steps: original.plan!.plan_steps,
              touched_scope: ['src/ledger.ts'],
              non_goals: [],
              decisions: [],
              acknowledge_drops_completed_steps: [],
              acknowledge_criteria_changes: [],
            },
            { idempotencyKey: reviseKey }
          )
      );
      const revisedPlanEventId = revised.eventId;
      const summaryKey = `summary-${randomUUID()}`;
      const summarized = await appendArtifactMutation(
        writer,
        first.artifactId,
        { outcome: 'Correction authority is retained across the ledger task.' },
        (semantics) =>
          semantics.writeSummary(
            {
              schema_version: 1,
              artifact_id: first.artifactId,
              agent: 'codex',
              outcome: 'Correction authority is retained across the ledger task.',
              tests_written: [],
              tests_run: [],
              open_items: [],
              deferred_decisions: [],
              head_sha: review.headSha,
              ts: '2026-09-19T17:00:00.000Z',
            },
            { idempotencyKey: summaryKey }
          )
      );
      const summaryEventId = summarized.eventId;
      const later = await correctionAdoption(writer, {
        projectId: review.projectId,
        scope: { kind: 'project', project_id: review.projectId },
        statement: LATER_RULE,
      });
      const connectedLater = await recordProjectTaskUses(writer, {
        operationId: uuidv7(),
        uses: [
          {
            artifact_id: first.artifactId,
            plan_event_id: originalPlanEventId,
            target: {
              kind: 'requirement',
              entity_id: later.requirementId,
              revision_id: later.revisionId,
            },
            role: 'background',
            local: null,
            exception_id: null,
          },
        ],
        discovery: {
          discovered_at: '2026-09-19T17:30:00.000Z',
          discovered_by: {
            kind: 'actor',
            actor: { identity: 'owner', basis: 'other_assertion' },
          },
        },
        secretAllow: [],
      });
      expect(connectedLater.value.uses).toEqual([
        expect.objectContaining({
          planEventId: originalPlanEventId,
          targetRevisionId: later.revisionId,
          selectionKind: 'connected_later',
          published: true,
        }),
      ]);
      expect(connectedLater.value.uses[0]!.selectionKind).not.toBe('selected_with_plan');

      const correctionRows = writer.read((view) => ({
        direct: view.all<{ target_id: string }>(
          `SELECT target_id FROM adoptions WHERE target_id IN (?, ?, ?)`,
          projectRule.requirementId,
          localException.requirementId,
          later.requirementId
        ),
        corrected: view.all<{ adopted_revision_id: string | null }>(
          `SELECT adopted_revision_id FROM correction_actions WHERE action_id IN (?, ?, ?) ORDER BY action_id`,
          projectRule.actionId,
          localException.actionId,
          later.actionId
        ),
      })).value;
      expect(correctionRows.direct).toEqual([]);
      expect(correctionRows.corrected.map((row) => row.adopted_revision_id).sort()).toEqual(
        [projectRule.revisionId, localException.revisionId, later.revisionId].sort()
      );

      const firstKey = `requirement:${projectRule.requirementId}`;
      const localKey = `requirement:${localException.requirementId}`;
      const laterKey = `requirement:${later.requirementId}`;
      const shownFirst = JSON.parse(
        (await readArtifactExport(reviewAgent, first.artifactId)).stdout
      );
      const firstBlock = knowledgeOf(shownFirst.artifact);
      const shownSecond = JSON.parse(
        (await readArtifactExport(reviewAgent, second.artifactId)).stdout
      );
      const secondBlock = knowledgeOf(shownSecond.artifact);
      expect(firstBlock.applicable).toEqual(expect.arrayContaining([firstKey, localKey, laterKey]));
      expect(secondBlock.applicable).toEqual(expect.arrayContaining([firstKey, laterKey]));
      expect(secondBlock.applicable).not.toContain(localKey);

      const digested = await invoke(['digest', '--artifact', first.artifactId, '--json']);
      expect((digested.knowledge as Block).applicable).toEqual(
        expect.arrayContaining([firstKey, localKey, laterKey])
      );
      const engine = new HistoryWatchEngine({
        scope: { root: review.dataRoot, cwd: review.gitRoot },
      });
      engines.push(engine);
      // Watch's one-day window must not expire the fixed-date summary in this authority test.
      const observed = Date.parse(
        readProjectArtifact(writer, first.artifactId)!.thread.summary!.ts
      );
      await engine.start(observed);
      const watched = engine.snapshot!.projects.flatMap((project) => project.threads);
      const watchedFirst = watched.find((thread) => thread.artifactId === first.artifactId)!;
      expect(watchedFirst, JSON.stringify(engine.snapshot!.completeness)).toBeDefined();
      const watchedSecond = watched.find((thread) => thread.artifactId === second.artifactId)!;
      expect((watchedFirst.knowledge as unknown as Block).applicable).toEqual(
        expect.arrayContaining([firstKey, localKey, laterKey])
      );
      expect((watchedSecond.knowledge as unknown as Block).applicable).not.toContain(localKey);

      const lookup = await invoke([
        'knowledge',
        'lookup',
        '--adopted',
        '--scope',
        `artifact:${first.artifactId}`,
        '--json',
      ]);
      expect((lookup as unknown as Block).applicable).toEqual(
        expect.arrayContaining([firstKey, localKey, laterKey])
      );
      expect(lookup.task_selection).toEqual({
        kind: 'selected',
        artifact_id: first.artifactId,
        plan_event_id: revisedPlanEventId,
      });
      const historical = await invoke([
        'knowledge',
        'lookup',
        '--adopted',
        '--scope',
        `artifact:${first.artifactId}`,
        '--at-boundary',
        String(historicalBoundary),
        '--json',
      ]);
      expect((historical as unknown as Block).basis).toMatchObject({
        knowledge_boundary: historicalBoundary,
        mode: 'historical',
      });
      expect((historical as unknown as Block).applicable).toEqual(
        expect.arrayContaining([firstKey, localKey])
      );
      expect((historical as unknown as Block).applicable).not.toContain(laterKey);
      expect(historical.task_selection).toEqual({
        kind: 'selected',
        artifact_id: first.artifactId,
        plan_event_id: originalPlanEventId,
      });

      const why = await invoke(['why', 'src/ledger.ts:1', '--json']);
      const whyObligations = (value: unknown) =>
        (value as { knowledge: { obligations: Array<{ id: string }> } }).knowledge.obligations.map(
          (entry) => entry.id
        );
      expect(whyObligations(why)).toEqual(expect.arrayContaining([firstKey, localKey, laterKey]));
      const historicalWhy = await invoke([
        'why',
        'src/ledger.ts:1',
        '--at-boundary',
        String(historicalBoundary),
        '--json',
      ]);
      expect(
        (historicalWhy as { context: { historical_boundary: number } }).context.historical_boundary
      ).toBe(historicalBoundary);
      expect(whyObligations(historicalWhy)).not.toContain(laterKey);

      const source = (eventId: string) => {
        const read = readRetainedJobSource(writer, { artifactId: first.artifactId, eventId });
        expect(read.ok).toBe(true);
        if (!read.ok) throw new Error(read.detail);
        return read.source;
      };
      expect(source(originalPlanEventId).planEventId).toBe(originalPlanEventId);
      expect(source(checkpointEventId).planEventId).toBe(originalPlanEventId);
      expect(source(revisedPlanEventId).planEventId).toBe(revisedPlanEventId);
      expect(source(summaryEventId).planEventId).toBe(revisedPlanEventId);
      const dispatchSource = source(originalPlanEventId);
      const taskField = dispatchSource.fields.find(
        (field) => field.fieldPath === 'task' && field.position === 0
      );
      expect(taskField).toBeDefined();
      const retrieval = writer.read((view) =>
        retrieveRelatedKnowledge(view, {
          source: {
            artifactId: dispatchSource.artifactId,
            eventId: dispatchSource.eventId,
            planEventId: dispatchSource.planEventId,
            text: taskField!.originalText,
          },
          projectId: review.projectId,
          scope: { kind: 'artifact', artifact_id: first.artifactId },
          boundary: dispatchSource.knowledgeBoundary,
          bounds: relatedKnowledgeBounds({ max_input_bytes: 40_000 }),
        })
      ).value;
      expect(dispatchSource.planEventId).toBe(originalPlanEventId);
      expect(retrieval.boundary).toBeGreaterThan(historicalBoundary);
      expect(
        retrieval.entries.map((entry) => `${entry.target.kind}:${entry.target.entity_id}`)
      ).toContain(laterKey);
      expect(
        retrieval.entries.find(
          (entry) => `${entry.target.kind}:${entry.target.entity_id}` === laterKey
        )!.routes
      ).toContain('task_use');

      const floor = await review.publishFloor();
      const selection = writer.read((view) =>
        view.get<{
          membershipRevisionId: string;
          membershipVersion: number;
          baseRevisionId: string | null;
          baseVersion: number;
          floorVersion: number;
        }>(
          `SELECT membership_revision_id AS membershipRevisionId,
                  membership_version AS membershipVersion,
                  base_revision_id AS baseRevisionId,
                  base_version AS baseVersion,
                  floor_version AS floorVersion
             FROM review_selections WHERE review_id = ?`,
          floor.review_id
        )
      ).value!;
      const prepared = await prepareDatabaseReviewRunInputs({
        authority: review.authority,
        reviewId: floor.review_id,
        expected: { ...selection, floorPublicationId: floor.publication_id },
        policy: defaultRunInputPolicy(),
        generatedAt: '2026-09-19T18:00:00.000Z',
        secretAllow: [],
      });
      const account = prepared.members.find(
        (member) => member.name === 'account-projection-v1.json'
      )!;
      const forensic = prepared.members.find((member) => member.name === 'forensic-input-v1.json')!;
      const accountText = Buffer.from(account.bytes).toString('utf8');
      const forensicText = Buffer.from(forensic.bytes).toString('utf8');
      for (const statement of [PROJECT_RULE, LOCAL_EXCEPTION, LATER_RULE]) {
        expect(accountText).toContain(statement);
        expect(forensicText).not.toContain(statement);
      }
      expect(accountText).toContain('claims no completeness');
      const projection = prepared.values['account-projection-v1.json'] as {
        taskKnowledge: {
          tasks: {
            artifactId: string;
            planEventId: string | null;
            knowledge: { entries: { key: string; placement: string }[] };
          }[];
        };
      };
      const firstTask = projection.taskKnowledge.tasks.find(
        (task) => task.artifactId === first.artifactId
      )!;
      const secondTask = projection.taskKnowledge.tasks.find(
        (task) => task.artifactId === second.artifactId
      )!;
      expect(firstTask.planEventId).toBe(revisedPlanEventId);
      expect(firstTask.knowledge.entries.find((entry) => entry.key === localKey)?.placement).toBe(
        'applicable'
      );
      expect(
        secondTask.knowledge.entries.find((entry) => entry.key === localKey)?.placement
      ).not.toBe('applicable');
    } finally {
      writer.close();
    }
  }, 30_000);
});
