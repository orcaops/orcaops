// Moving work about is not deciding anything.
//
// Plan §10: merge, rebase, cherry-pick, rename, sync and task reassignment do not themselves adopt
// new intent. Each act below is driven for real on a project database holding an adopted rule and a
// plan that recorded a use of it, and after each one the same three things are checked: the
// resolver's answer for that identity is byte-identical, every table that carries a selection, an
// authority or a revocation is unchanged down to its record hashes, and no processing job was
// admitted for an event type that is not eligible for one.
//
// Cherry-pick and rename have no Orcaops act of their own — nothing in this product notices either
// — so the cherry-pick case shows the whole data root unchanged rather than a verb's output.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  admitsProcessingJob,
  type EventType,
  PROCESSING_ELIGIBLE_EVENT_TYPES,
  uuidv7,
} from '@orcaops/storage';
import {
  type ProjectDatabase,
  readProjectArtifact,
  recordProjectTaskUses,
  resolveProjectKnowledge,
} from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { commitFile } from '../helpers/database-fingerprint.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { adoptedRequirement, AT, planEventOf } from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const OFFLINE = 'Local capture works with no Cloud connection.';

/** The events these acts append, none of which is eligible for background processing. */
const INELIGIBLE_EVENTS = [
  'branch_lineage_updated',
  'pin_displaced',
  'git_import_enriched',
] as const satisfies readonly EventType[];

const agent = (f: Fixture) =>
  makeAgent({
    cwd: f.main,
    timeoutMs: 120_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'adopts-nothing',
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

/**
 * What the resolver says about the identity, without the basis.
 *
 * The basis names the write sequence the read was taken at, which every act moves whether or not it
 * decided anything; what must not move is the answer about the identity itself.
 */
function resolverAnswer(f: Fixture, requirementId: string): string {
  const { basis: _basis, ...answer } = f.writer.read((view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: requirementId },
      f.authority.projectId,
      { kind: 'project', project_id: f.authority.projectId },
      {}
    )
  ).value;
  return JSON.stringify(answer);
}

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

/**
 * Every row of every table that carries a selection, an authority or a revocation.
 *
 * Each column is quoted to text with its type, because a read boundary refuses to hand a blob back
 * whole and a record's own bytes are exactly the thing that must not move.
 */
const decidingRecords = (writer: ProjectDatabase) =>
  writer.read((view) =>
    Object.fromEntries(
      DECIDING_TABLES.map((table) => {
        const columns = view
          .all<{ name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid', table)
          .map(({ name }) => `typeof("${name}") || ':' || quote("${name}") AS "${name}"`);
        return [
          table,
          JSON.stringify({
            count: view.get<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`)!.n,
            rows: view
              .all(`SELECT ${columns.join(',')} FROM "${table}"`)
              .map((row) => JSON.stringify(row))
              .sort(),
          }),
        ];
      })
    )
  ).value;

const intentCounter = (f: Fixture) => f.writer.read(() => null).counters.intentChangeCounter;

/** The event type behind every admitted processing job, through the source each job names. */
const admittedForEventTypes = (f: Fixture): string[] =>
  f.writer
    .read((view) =>
      view.all<{ event_type: string }>(
        `SELECT e.event_type FROM processing_jobs j
         JOIN knowledge_sources s ON s.source_id=j.source_id
         JOIN artifact_events e ON e.artifact_id=s.artifact_id AND e.event_id=s.event_id`
      )
    )
    .value.map((row) => row.event_type)
    .sort();

const eventTypes = (f: Fixture, artifactId: string) =>
  readProjectArtifact(f.writer, artifactId)!.thread.events.map((event) => event.record.type);

/** An adopted rule, a captured task, and the task's recorded use of the revision it selected. */
async function history(f: Fixture) {
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
        role: 'implement',
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
  return { projectId, artifactId, planEventId, stepId, adopted };
}

interface Held {
  answer: string;
  records: Record<string, string>;
  intent: number;
}

const hold = (f: Fixture, requirementId: string): Held => ({
  answer: resolverAnswer(f, requirementId),
  records: decidingRecords(f.writer),
  intent: intentCounter(f),
});

/**
 * What every act below must leave alone. `movesIntent` is true only where the act IS a capture of
 * intent — a plan revision, and an import of Git history — which the counter records by event type;
 * what those acts still adopt is nothing, which is what the other checks say.
 *
 * Jobs are checked by the event type each one was admitted for, not by their number: a plan
 * revision and a closed checkpoint are eligible for one and admitting them is correct. What must
 * never appear is a job for an event type that is not eligible at all.
 */
function adoptedNothing(
  f: Fixture,
  requirementId: string,
  before: Held,
  options: { movesIntent?: boolean } = {}
) {
  expect(resolverAnswer(f, requirementId)).toBe(before.answer);
  expect(decidingRecords(f.writer)).toEqual(before.records);
  if (options.movesIntent !== true) expect(intentCounter(f)).toBe(before.intent);
  for (const type of admittedForEventTypes(f))
    expect(PROCESSING_ELIGIBLE_EVENT_TYPES as readonly string[]).toContain(type);
}

describe('acts that adopt nothing', { timeout: 300_000 }, () => {
  it('holds every event these acts append outside the types a processing job may be admitted for', () => {
    for (const type of INELIGIBLE_EVENTS) {
      expect(PROCESSING_ELIGIBLE_EVENT_TYPES as readonly string[]).not.toContain(type);
      expect(
        admitsProcessingJob({
          path: 'live_capture_settlement',
          origin_kind: 'captured',
          settled_event_types: [type],
          derived_by_processing: false,
        })
      ).toBe(false);
    }
  });

  it('adopts nothing when lineage records a moved HEAD after a rebase', async () => {
    const f = await fixture();
    const held = await history(f);
    await commitFile(f, 'rebased.ts', 'export const rebased = true;\n');
    const before = hold(f, held.adopted.requirementId);

    const lineage = await orcaops(f, ['lineage', '--json']);

    expect(lineage.raw.exitCode, lineage.raw.stdout + lineage.raw.stderr).toBe(0);
    expect(lineage.result.updated).toHaveLength(1);
    expect(eventTypes(f, held.artifactId)).toContain('branch_lineage_updated');
    adoptedNothing(f, held.adopted.requirementId, before);
  });

  it('adopts nothing when lineage records reachable ancestry from another branch', async () => {
    const f = await fixture();
    const projectId = f.authority.projectId;
    const artifactId = await f.capture(undefined, { cwd: f.linked });
    const adopted = await adoptedRequirement(f.writer, { projectId, statement: OFFLINE });
    await commitFile(f, 'merged.ts', 'export const merged = true;\n');
    const before = hold(f, adopted.requirementId);

    const lineage = await orcaops(f, ['lineage', '--json']);

    expect(lineage.raw.exitCode, lineage.raw.stdout + lineage.raw.stderr).toBe(0);
    expect(lineage.result.merged).toHaveLength(1);
    expect(eventTypes(f, artifactId)).toContain('branch_lineage_updated');
    adoptedNothing(f, adopted.requirementId, before);
  });

  it('adopts nothing when a checkout displaces the pin of another artifact', async () => {
    const f = await fixture();
    const held = await history(f);
    const other = await f.capture();
    const before = hold(f, held.adopted.requirementId);

    const checkout = await orcaops(f, ['checkout', other, '--json']);

    expect(checkout.raw.exitCode, checkout.raw.stdout + checkout.raw.stderr).toBe(0);
    adoptedNothing(f, held.adopted.requirementId, before);
  });

  it('adopts nothing when a label-only plan revision is captured', async () => {
    const f = await fixture();
    const held = await history(f);
    const plan = readProjectArtifact(f.writer, held.artifactId)!.thread.plan!;
    const before = hold(f, held.adopted.requirementId);

    const revised = await orcaops(f, [
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `revise-${randomUUID()}`,
          artifact_id: held.artifactId,
          prior_plan_event_id: held.planEventId,
          rationale: 'Give the task a clearer label.',
          label: 'A clearer label',
          plan_steps: plan.plan_steps,
          touched_scope: plan.touched_scope,
          non_goals: plan.non_goals,
        })
      ),
    ]);

    expect(revised.raw.exitCode, revised.raw.stdout + revised.raw.stderr).toBe(0);
    // A plan revision IS a capture of intent, which the counter records by event type; what the
    // revision adopts is still nothing.
    adoptedNothing(f, held.adopted.requirementId, before, { movesIntent: true });
  });

  it('adopts nothing when a checkpoint is opened and closed by another agent session', async () => {
    const f = await fixture();
    const held = await history(f);
    const before = hold(f, held.adopted.requirementId);

    const opened = await orcaops(f, [
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: held.artifactId,
          agent_session_id: 'another-session',
          declared_step_ids: [held.stepId],
        })
      ),
    ]);
    expect(opened.raw.exitCode, opened.raw.stdout + opened.raw.stderr).toBe(0);
    const closed = await orcaops(f, [
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: held.artifactId,
          n: opened.result.n,
          summary: 'Reassigned to another session, which decided nothing.',
          files_changed: [],
          completed_step_ids: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
        })
      ),
    ]);
    expect(closed.raw.exitCode, closed.raw.stdout + closed.raw.stderr).toBe(0);

    adoptedNothing(f, held.adopted.requirementId, before);
  });

  it('adopts nothing when resync runs with no Cloud connection', async () => {
    const f = await fixture();
    const held = await history(f);
    const before = hold(f, held.adopted.requirementId);

    const resync = await agent(f).runRaw(['resync', '--json']);

    expect(JSON.parse(resync.stdout)).toBeTruthy();
    adoptedNothing(f, held.adopted.requirementId, before);
  });

  it('adopts nothing when a seeded import writes artifacts from Git history', async () => {
    const f = await fixture();
    const held = await history(f);
    await commitFile(f, 'seeded.ts', 'export const seeded = true;\n');
    const before = hold(f, held.adopted.requirementId);

    const seeded = await orcaops(f, [
      'seed',
      '--since',
      '2020-01-01T00:00:00.000Z',
      '--yes',
      '--json',
    ]);

    expect(seeded.raw.exitCode, seeded.raw.stdout + seeded.raw.stderr).toBe(0);
    adoptedNothing(f, held.adopted.requirementId, before, { movesIntent: true });
  });

  it('changes nothing in the store when a cherry-pick carries a capture’s files across', async () => {
    const f = await fixture();
    const held = await history(f);
    await git(f.linked, ['checkout', '-qb', 'carried']);
    await writeFile(path.join(f.linked, 'carried.ts'), 'export const carried = true;\n', 'utf8');
    await git(f.linked, ['add', 'carried.ts']);
    await git(f.linked, ['commit', '-qm', 'A change to carry']);
    const carried = (await git(f.linked, ['rev-parse', 'HEAD'])).stdout.trim();
    const before = await inventory(f.root);
    const beforeAnswer = resolverAnswer(f, held.adopted.requirementId);

    await git(f.main, ['cherry-pick', carried]);

    // No Orcaops act of its own: nothing notices a cherry-pick, and nothing in the store moves
    // until a capture is recorded.
    expect(await inventory(f.root)).toEqual(before);
    expect(resolverAnswer(f, held.adopted.requirementId)).toBe(beforeAnswer);
  });
});
