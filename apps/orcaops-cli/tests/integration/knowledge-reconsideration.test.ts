import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';
import { uuidv7 } from '@orcaops/storage';
import {
  type ProjectDatabase,
  publishProjectRelationship,
} from '@orcaops/storage/history/database';

import { buildProgram } from '../../src/cli/program.js';
import {
  knowledgeReconsiderDisposeAction,
  type KnowledgeReconsiderDisposeOptions,
  knowledgeReconsiderListAction,
  type KnowledgeReconsiderListOptions,
  knowledgeReconsiderOpenAction,
  type KnowledgeReconsiderOpenOptions,
  type ReconsiderationListReport,
  type ReconsiderationOpenReport,
} from '../../src/commands/knowledge/reconsider.js';
import { taskUsesRecordAction } from '../../src/commands/task-uses.js';
import { CliExit } from '../../src/io/exit.js';
import { WORKER_LOG_FILE } from '../../src/knowledge-worker/start.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture, inventory } from '../helpers/database-history.js';
import {
  adoptedRequirement,
  AT,
  OWNER,
  planEventOf,
  recordedRequirement,
  writeSequenceOf,
} from '../helpers/knowledge-records.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const OFFLINE = 'Local capture works with no Cloud connection.';
const QUEUE = 'Unsent captures wait in a local queue.';
const TOUCHED = 'packages/sync/src/queue.ts';

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
  action: () => Promise<void>,
  env: NodeJS.ProcessEnv = process.env
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
          ...env,
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

const openItems = (value: Fixture, opts: KnowledgeReconsiderOpenOptions) =>
  run(value, () => knowledgeReconsiderOpenAction({ ...opts, json: true }));
const listItems = (value: Fixture, opts: KnowledgeReconsiderListOptions = {}) =>
  run(value, () => knowledgeReconsiderListAction({ ...opts, json: true }));
const dispose = (value: Fixture, item: string, opts: KnowledgeReconsiderDisposeOptions) =>
  run(value, () => knowledgeReconsiderDisposeAction(item, { ...opts, json: true }));

const opened = (payload: Record<string, unknown>) =>
  payload as unknown as ReconsiderationOpenReport & { ok: true };
const listed = (payload: Record<string, unknown>) =>
  payload as unknown as ReconsiderationListReport & { ok: true };

/** Every table's row count, so a write outside the two reconsideration tables is visible. */
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

/**
 * A rule the project adopted, a decision that depends on it, a task that recorded a use of the
 * rule, and code that task touched.
 */
async function history(value: Fixture) {
  const projectId = value.authority.projectId;
  const adopted = await adoptedRequirement(value.writer, { projectId, statement: OFFLINE });
  const dependent = await recordedRequirement(value.writer, { statement: QUEUE });
  await publishProjectRelationship(value.writer, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: uuidv7(),
      relation: 'depends_on',
      from: {
        kind: 'requirement',
        entity_id: dependent.requirementId,
        revision_id: dependent.revisionId,
      },
      to: {
        kind: 'requirement',
        entity_id: adopted.requirementId,
        revision_id: adopted.revisionId,
      },
      scope: { kind: 'project', project_id: projectId },
      standing: 'established',
      authorization: null,
      source_ids: [adopted.sourceId],
      explanation: 'The queue exists because capture must work offline.',
    },
    attributedTo: { kind: 'actor', actor: OWNER },
    secretAllow: [],
  });
  const artifactId = await value.capture();
  await value.recordFiles(artifactId, [TOUCHED]);
  const planEventId = planEventOf(value.writer, artifactId);
  const usePath = path.join(value.main, 'use.json');
  await writeFile(
    usePath,
    JSON.stringify({
      uses: [
        {
          artifact_id: artifactId,
          plan_event_id: planEventId,
          target: {
            kind: 'requirement',
            entity_id: adopted.requirementId,
            revision_id: adopted.revisionId,
          },
          role: 'preserve',
          local: null,
          exception_id: null,
        },
      ],
      discovery: {
        discovered_at: AT,
        discovered_by: { kind: 'actor', actor: { identity: 'the-cto', basis: 'authenticated' } },
      },
    }),
    'utf8'
  );
  const recorded = await run(value, () => taskUsesRecordAction({ input: usePath, json: true }));
  expect(recorded.failed).toBe(false);
  return {
    adopted,
    dependent,
    artifactId,
    planEventId,
    boundary: writeSequenceOf(value.writer),
  };
}

describe('orcaops knowledge reconsider', { timeout: 180_000 }, () => {
  it('retains the explicit supporting path and its reason when a shorter inferred path exists', async () => {
    const value = await project();
    const projectId = value.authority.projectId;
    const origin = await adoptedRequirement(value.writer, { projectId, statement: OFFLINE });
    const middle = await recordedRequirement(value.writer, { statement: QUEUE });
    const affected = await recordedRequirement(value.writer, {
      statement: 'Queued captures retain their original timestamps.',
    });
    const revision = (record: typeof middle) => ({
      kind: 'requirement' as const,
      entity_id: record.requirementId,
      revision_id: record.revisionId,
    });
    const inferredId = uuidv7();
    const firstId = uuidv7();
    const lastId = uuidv7();
    for (const edge of [
      { id: inferredId, from: origin, to: affected, standing: 'suggested' as const },
      { id: firstId, from: origin, to: middle, standing: 'established' as const },
      { id: lastId, from: middle, to: affected, standing: 'established' as const },
    ]) {
      await publishProjectRelationship(value.writer, {
        operationId: uuidv7(),
        relationship: {
          relationship_id: edge.id,
          relation: 'depends_on',
          from: revision(edge.from),
          to: revision(edge.to),
          scope: { kind: 'project', project_id: projectId },
          standing: edge.standing,
          authorization: null,
          source_ids: [origin.sourceId],
          explanation: 'Queued capture behavior depends on the linked requirement.',
        },
        attributedTo: { kind: 'actor', actor: OWNER },
        secretAllow: [],
      });
    }

    const opening = await openItems(value, { identity: `requirement:${origin.requirementId}` });
    expect(opening.failed).toBe(false);
    const result = await listItems(value);
    expect(result.failed).toBe(false);
    const item = listed(result.payload).items.find(
      (entry) =>
        entry.affected.kind === 'requirement' && entry.affected.id === affected.requirementId
    );
    expect(item).toBeDefined();
    expect(item!.source).toMatchObject({
      basis: 'explicit',
      path: [
        { record_id: firstId, basis: 'explicit', standing: 'established' },
        { record_id: lastId, basis: 'explicit', standing: 'established' },
      ],
    });
    const source = item!.source as { reason: string; path: { reason: string }[] };
    expect(source.reason).toBe(source.path.at(-1)!.reason);
    expect(source.reason).toContain(lastId);
    expect(source.reason).not.toContain(inferredId);
    expect(
      opened(opening.payload).items.find((entry) => entry.item_id === item!.itemId)?.reason
    ).toBe(source.reason);
    const rendered = await run(value, () => knowledgeReconsiderListAction({}));
    expect(rendered.failed).toBe(false);
    expect(rendered.text).toContain(source.reason);
  });

  it('opens one item per affected item and cause, with the reason and the owner', async () => {
    const value = await project();
    const held = await history(value);

    const { payload, failed } = await openItems(value, {
      identity: `requirement:${held.adopted.requirementId}`,
    });

    expect(failed).toBe(false);
    const report = opened(payload);
    expect(report.opened).toBeGreaterThan(0);
    expect(report.retained).toBe(0);
    expect(report.items.map((entry) => `${entry.affected.kind}:${entry.affected.id}`)).toEqual(
      expect.arrayContaining([
        `plan_event:${held.planEventId}`,
        `artifact:${held.artifactId}`,
        `requirement:${held.dependent.requirementId}`,
      ])
    );
    for (const entry of report.items) expect(entry.reason).not.toBe('');
    expect(report.coverage.statement).toContain('not a finding that the work is wrong');
  });

  it('leaves one item when the same signal is opened again', async () => {
    const value = await project();
    const held = await history(value);
    const first = opened(
      (await openItems(value, { identity: `requirement:${held.adopted.requirementId}` })).payload
    );

    const again = opened(
      (await openItems(value, { identity: `requirement:${held.adopted.requirementId}` })).payload
    );

    expect(again.opened).toBe(0);
    expect(again.retained).toBe(first.opened);
    expect(listed((await listItems(value)).payload).items).toHaveLength(first.opened);
  });

  it('writes items and nothing else: no requirement, assignment, job or evaluator run', async () => {
    const value = await project();
    const held = await history(value);
    const before = rowCounts(value.writer);

    await openItems(value, { identity: `requirement:${held.adopted.requirementId}` });

    const after = rowCounts(value.writer);
    const moved = Object.keys(after).filter((table) => after[table] !== before[table]);
    // The two item tables, the receipt that wrote them and the counters that receipt moved. A
    // requirement revision, a correction, a processing job or an evaluator run would show here.
    expect(moved.sort()).toEqual(['operations', 'reconsideration_items'].sort());
    expect(after.reconsideration_dispositions).toBe(0);
    await expect(
      access(path.join(path.dirname(value.writer.databasePath), WORKER_LOG_FILE))
    ).rejects.toThrow();
  });

  it('lists the items with their cause, owner and latest disposition', async () => {
    const value = await project();
    const held = await history(value);
    await openItems(value, { identity: `requirement:${held.adopted.requirementId}` });

    const report = listed((await listItems(value)).payload);

    expect(report.items.length).toBeGreaterThan(0);
    for (const item of report.items) {
      expect(item.causeKind).toBe('revision');
      expect(item.dispositions).toEqual([]);
      expect(item.open).toBe(true);
    }
    expect(report.coverage.statement).toContain('not a finding that the work is wrong');
    // `--open` is the default said out loud, and asking for both at once is asking two questions.
    expect(listed((await listItems(value, { open: true })).payload).items).toEqual(report.items);
    const both = await listItems(value, { open: true, all: true });
    expect(both.failed).toBe(true);
    expect(both.payload).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('writes nothing when it lists', async () => {
    const value = await project();
    const held = await history(value);
    await openItems(value, { identity: `requirement:${held.adopted.requirementId}` });
    const before = await inventory(value.root);

    await listItems(value);
    await listItems(value, { all: true });
    await listItems(value, { identity: `requirement:${held.dependent.requirementId}` });

    expect(await inventory(value.root)).toEqual(before);
  });

  it('appends a disposition and leaves the item’s own facts alone', async () => {
    const value = await project();
    const held = await history(value);
    const report = opened(
      (await openItems(value, { identity: `requirement:${held.adopted.requirementId}` })).payload
    );
    const itemId = report.items[0]!.item_id;
    const before = listed((await listItems(value)).payload).items.find(
      (item) => item.itemId === itemId
    )!;

    const acknowledged = await dispose(value, itemId, { acknowledge: true, at: AT });
    const declined = await dispose(value, itemId, {
      decline: 'the queue was removed in 0.3',
      at: AT,
    });

    expect(acknowledged.failed).toBe(false);
    expect(declined.failed).toBe(false);
    const after = listed((await listItems(value, { all: true })).payload).items.find(
      (item) => item.itemId === itemId
    )!;
    expect(after.recordSha256).toBe(before.recordSha256);
    expect(after.source).toEqual(before.source);
    expect(after.dispositions.map((entry) => entry.disposition)).toEqual([
      'acknowledged',
      'declined',
    ]);
    expect(after.dispositions[1]!.reason).toBe('the queue was removed in 0.3');
    // The local account, never `authenticated`: a local invocation carries no authentication.
    expect(after.dispositions[1]!.disposedByBasis).not.toBe('authenticated');
    expect(after.open).toBe(false);
    expect(listed((await listItems(value)).payload).items.map((item) => item.itemId)).not.toContain(
      itemId
    );
  });

  it('attributes a disposition to the agent named by --invoked-by-agent on the command line', async () => {
    const value = await project();
    const held = await history(value);
    const report = opened(
      (await openItems(value, { identity: `requirement:${held.adopted.requirementId}` })).payload
    );
    const itemId = report.items[0]!.item_id;
    const env = { ...process.env };
    delete env.ORCAOPS_INVOKED_BY_AGENT;

    const parsed = await run(
      value,
      async () => {
        const program = buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL });
        program.exitOverride();
        await program.parseAsync(
          [
            'knowledge',
            'reconsider',
            'dispose',
            itemId,
            '--acknowledge',
            '--invoked-by-agent',
            'claude-code',
            '--json',
          ],
          { from: 'user' }
        );
      },
      env
    );

    expect(parsed.failed).toBe(false);
    const after = listed((await listItems(value, { all: true })).payload).items.find(
      (item) => item.itemId === itemId
    )!;
    expect(after.dispositions.map((entry) => entry.disposedByBasis)).toEqual([
      'agent_reported_user_instruction',
    ]);
  });

  it('shows the item at an earlier boundary without the disposition that came later', async () => {
    const value = await project();
    const held = await history(value);
    const report = opened(
      (await openItems(value, { identity: `requirement:${held.adopted.requirementId}` })).payload
    );
    const itemId = report.items[0]!.item_id;
    const beforeDisposition = writeSequenceOf(value.writer);
    await dispose(value, itemId, { acknowledge: true, at: AT });

    const then = listed(
      (await listItems(value, { atBoundary: String(beforeDisposition), all: true })).payload
    );
    const now = listed((await listItems(value, { all: true })).payload);

    expect(then.basis.mode).toBe('historical');
    expect(then.items.find((item) => item.itemId === itemId)!.dispositions).toEqual([]);
    expect(now.items.find((item) => item.itemId === itemId)!.dispositions).toHaveLength(1);
  });

  it('asks for exactly one change to traverse and exactly one disposition', async () => {
    const value = await project();
    const held = await history(value);
    const report = opened(
      (await openItems(value, { identity: `requirement:${held.adopted.requirementId}` })).payload
    );

    const none = await openItems(value, {});
    const both = await dispose(value, report.items[0]!.item_id, {
      acknowledge: true,
      decline: 'and also this',
    });

    for (const result of [none, both]) {
      expect(result.failed).toBe(true);
      expect(result.payload).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(String((none.payload.error as { message: string }).message)).toContain(
      'Ask about one change'
    );
    expect(String((both.payload.error as { message: string }).message)).toContain(
      'Give one disposition'
    );
  });

  it('refuses a disposition of an item this history does not hold', async () => {
    const value = await project();
    await history(value);

    const result = await dispose(value, 'f'.repeat(64), { acknowledge: true });

    expect(result.failed).toBe(true);
    expect(result.payload).toMatchObject({ ok: false });
    expect(String((result.payload.error as { message: string }).message)).toContain(
      'not one this history holds'
    );
  });

  it('renders each item with its cause, reason and disposition for a person', async () => {
    const value = await project();
    const held = await history(value);
    await run(value, () =>
      knowledgeReconsiderOpenAction({ identity: `requirement:${held.adopted.requirementId}` })
    );

    const { text } = await run(value, () => knowledgeReconsiderListAction({}));

    expect(text).toContain('Reconsideration items read at write sequence');
    expect(text).toContain('Disposition: none yet; it is open.');
    expect(text).toContain('Cause: revision');
    expect(text).toContain('not a finding that the work is wrong');
  });
});
