import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import type { ProjectDatabase } from '@orcaops/storage/history/database';

import {
  type AssignmentListReport,
  knowledgeAssignmentListAction,
  type KnowledgeAssignmentListOptions,
  knowledgeAssignmentOpenAction,
  knowledgeAssignmentRevokeAction,
} from '../../src/commands/knowledge/assignment.js';
import { knowledgeLookupAction } from '../../src/commands/knowledge/lookup.js';
import { CliExit } from '../../src/io/exit.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture } from '../helpers/database-history.js';
import { adoptedRequirement, writeSequenceOf } from '../helpers/knowledge-records.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const OFFLINE = 'Local capture works with no Cloud connection.';
const RESPONSIBLE = { identity: 'retry-team', basis: 'other_assertion' };

let stdout: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  stdout = [];
});

async function project(): Promise<Fixture> {
  const value = await fixture();
  await mkdir(path.join(value.main, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(value.main, '.orcaops', 'config.json'),
    JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm: { tool: 'none' } }),
    'utf8'
  );
  return value;
}

async function run(
  value: Fixture,
  action: () => Promise<void>
): Promise<{ text: string; payload: Record<string, unknown>; failed: boolean }> {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let failed = false;
  try {
    await runInInvocationContext(
      {
        cwd: value.main,
        env: {
          ...process.env,
          ORCAOPS_ROOT: value.main,
          ORCAOPS_DATA_DIR: value.root,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      },
      action
    );
  } catch (err) {
    if (!(err instanceof CliExit)) throw err;
    failed = true;
  }
  const text = stdout.join('');
  const payload = text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { text, payload, failed };
}

/** Every table's row count, so a write a passive verb should not have made is visible. */
const rowCounts = (writer: ProjectDatabase): Record<string, number> =>
  writer.read((view) =>
    Object.fromEntries(
      view
        .all<{
          name: string;
        }>(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .map(({ name }) => [
          name,
          view.get<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`)!.n,
        ])
    )
  ).value;

const projectCounters = (writer: ProjectDatabase) =>
  writer.read((view) =>
    view.get<{ write_sequence: number; intent_change_counter: number }>(
      'SELECT write_sequence, intent_change_counter FROM project_counters WHERE singleton=1'
    )
  ).value;

const listed = (payload: Record<string, unknown>) =>
  payload as unknown as AssignmentListReport & { ok: true };

async function openAssignment(
  value: Fixture,
  document: Record<string, unknown>,
  name = 'assignment.json'
) {
  const file = path.join(value.main, name);
  await writeFile(file, JSON.stringify(document), 'utf8');
  return run(value, () => knowledgeAssignmentOpenAction({ input: file, json: true }));
}

const list = (value: Fixture, opts: KnowledgeAssignmentListOptions = {}) =>
  run(value, () => knowledgeAssignmentListAction({ ...opts, json: true }));

/** An adopted rule, and an assignment delegating a departure from it to the retry team. */
async function history(value: Fixture) {
  const projectId = value.authority.projectId;
  const adopted = await adoptedRequirement(value.writer, { projectId, statement: OFFLINE });
  const rule = {
    kind: 'requirement',
    entity_id: adopted.requirementId,
    revision_id: adopted.revisionId,
  };
  const scope = { kind: 'project', project_id: projectId };
  return {
    adopted,
    rule,
    scope,
    document: {
      objective: 'Make upload retries idempotent.',
      inherited: [rule],
      delegated: {
        adopts: [],
        departs_from: [{ rule, how: 'withdraws', exception_id: null, replaced_by: null }],
        restates: [],
      },
      allowed_changes: ['Retry scheduling and backoff inside the upload queue.'],
      escalation_conditions: ['Any change to what is captured while offline.'],
      responsible: RESPONSIBLE,
      source_id: adopted.instructionId,
      scope,
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: adopted.instructionId,
        acknowledged: [rule],
        scope,
      },
      valid_until: null,
    },
  };
}

describe('orcaops knowledge assignment', { timeout: 180_000 }, () => {
  it.each(['generated', 'explicit'] as const)(
    'replays an assignment with a %s identity and refuses changed content',
    async (identity) => {
      const value = await project();
      const held = await history(value);
      const assignmentId = uuidv7();
      const document = {
        ...held.document,
        operation_id: uuidv7(),
        ...(identity === 'explicit' ? { assignment_id: assignmentId } : {}),
      };
      const first = await openAssignment(value, document);
      expect(first.failed).toBe(false);
      if (identity === 'explicit') expect(first.payload.assignment_id).toBe(assignmentId);
      const before = rowCounts(value.writer);
      const counters = projectCounters(value.writer);

      const replayed = await openAssignment(value, document);

      expect(replayed.failed).toBe(false);
      expect(replayed.payload.assignment_id).toBe(first.payload.assignment_id);
      expect(replayed.payload.counters).toEqual(first.payload.counters);
      expect(rowCounts(value.writer)).toEqual(before);
      expect(projectCounters(value.writer)).toEqual(counters);

      const changed = await openAssignment(value, { ...document, objective: 'Change the scope.' });
      expect(changed.failed).toBe(true);
      expect(changed.payload).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect(rowCounts(value.writer)).toEqual(before);
      expect(projectCounters(value.writer)).toEqual(counters);
    }
  );

  it('opens an assignment, lists it with what it delegates, and writes nothing else', async () => {
    const value = await project();
    const held = await history(value);
    const before = rowCounts(value.writer);

    const opened = await openAssignment(value, held.document);
    expect(opened.failed).toBe(false);
    const assignmentId = opened.payload.assignment_id as string;
    expect(opened.payload).toMatchObject({
      responsible: RESPONSIBLE.identity,
      record_sha256: expect.any(String),
    });
    const after = rowCounts(value.writer);
    const moved = Object.keys(after).filter((table) => after[table] !== before[table]);
    expect(moved.sort()).toEqual(['assignment_members', 'assignments', 'operations'].sort());

    const shown = await list(value);
    expect(shown.failed).toBe(false);
    expect(listed(shown.payload).assignments).toEqual([
      expect.objectContaining({
        assignment_id: assignmentId,
        objective: 'Make upload retries idempotent.',
        responsible: RESPONSIBLE,
        standing: 'valid',
        inherited: 1,
        delegates: { adopts: 0, departs_from: 1, restates: 0 },
        escalation_conditions: ['Any change to what is captured while offline.'],
      }),
    ]);
  });

  it('refuses an assignment that delegates more than its assigner holds, and writes nothing', async () => {
    const value = await project();
    const held = await history(value);
    const before = rowCounts(value.writer);
    const other = {
      kind: 'requirement',
      entity_id: held.adopted.requirementId,
      revision_id: held.adopted.revisionId,
    };
    const beyond = await openAssignment(value, {
      ...held.document,
      authorization: {
        kind: 'explicit_instruction',
        instruction_source_id: held.adopted.instructionId,
        scope: held.scope,
      },
      delegated: {
        adopts: [],
        departs_from: [{ rule: other, how: 'withdraws', exception_id: null, replaced_by: null }],
        restates: [],
      },
    });
    expect(beyond.failed).toBe(true);
    expect(rowCounts(value.writer)).toEqual(before);
  });

  it('revokes an assignment, keeps it readable, and shows it as it stood before', async () => {
    const value = await project();
    const held = await history(value);
    const opened = await openAssignment(value, held.document);
    const assignmentId = opened.payload.assignment_id as string;
    const boundary = writeSequenceOf(value.writer);

    const revoked = await run(value, () =>
      knowledgeAssignmentRevokeAction(assignmentId, {
        reason: 'The retry work is finished.',
        json: true,
      })
    );
    expect(revoked.failed).toBe(false);
    expect(revoked.payload.revokes).toEqual({ kind: 'assignment', id: assignmentId });

    const now = listed((await list(value)).payload);
    expect(now.assignments[0]).toMatchObject({
      assignment_id: assignmentId,
      standing: 'revoked',
      revoked_by: [revoked.payload.revocation_id],
    });
    const then = listed((await list(value, { atBoundary: String(boundary) })).payload);
    expect(then.assignments[0]).toMatchObject({ standing: 'valid', revoked_by: [] });
  });

  it('writes nothing when an assignment is already revoked', async () => {
    const value = await project();
    const held = await history(value);
    const opened = await openAssignment(value, held.document);
    const assignmentId = opened.payload.assignment_id as string;
    const first = await run(value, () =>
      knowledgeAssignmentRevokeAction(assignmentId, {
        reason: 'The retry work is finished.',
        json: true,
      })
    );
    expect(first.failed).toBe(false);
    const before = rowCounts(value.writer);
    const beforeCounters = projectCounters(value.writer);

    const duplicate = await run(value, () =>
      knowledgeAssignmentRevokeAction(assignmentId, {
        reason: 'A second reason must not be retained.',
        json: true,
      })
    );

    expect(duplicate.failed).toBe(true);
    expect(rowCounts(value.writer)).toEqual(before);
    expect(projectCounters(value.writer)).toEqual(beforeCounters);
  });

  it('lists by responsible party, by identity, and reads nothing when neither matches', async () => {
    const value = await project();
    const held = await history(value);
    await openAssignment(value, held.document);
    const before = rowCounts(value.writer);

    expect(
      listed((await list(value, { responsible: RESPONSIBLE.identity })).payload).assignments
    ).toHaveLength(1);
    expect(
      listed((await list(value, { responsible: 'somebody-else' })).payload).assignments
    ).toEqual([]);
    expect(
      listed((await list(value, { identity: `requirement:${held.adopted.requirementId}` })).payload)
        .assignments
    ).toHaveLength(1);
    // A passive read: listing writes no row and moves no counter.
    expect(rowCounts(value.writer)).toEqual(before);
  });

  it('names the assignment an act may rest on in the lookup, in JSON and for a person', async () => {
    const value = await project();
    const held = await history(value);
    const opened = await openAssignment(value, held.document);
    const assignmentId = opened.payload.assignment_id as string;
    const before = rowCounts(value.writer);

    const answer = await run(value, () =>
      knowledgeLookupAction({
        identity: [`requirement:${held.adopted.requirementId}`],
        json: true,
      })
    );
    expect(answer.failed).toBe(false);
    const payload = answer.payload as unknown as {
      entries: { assignments?: { assignment_id: string; standing: string }[] }[];
      assignments: { count: number; statement: string } | null;
    };
    expect(payload.entries[0]?.assignments).toEqual([
      expect.objectContaining({ assignment_id: assignmentId, standing: 'valid' }),
    ]);
    expect(payload.assignments).toMatchObject({ count: 1 });

    const human = await run(value, () =>
      knowledgeLookupAction({ identity: [`requirement:${held.adopted.requirementId}`] })
    );
    expect(human.text).toContain('Assignments (1)');
    expect(human.text).toContain(assignmentId);
    expect(human.text).toContain('claimed and not authenticated');
    // The lookup stays a passive read with assignments in view.
    expect(rowCounts(value.writer)).toEqual(before);
  });
});
