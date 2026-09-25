import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { publishProjectRelationship } from '@orcaops/storage/history/database';

import {
  knowledgeConsequencesAction,
  type KnowledgeConsequencesOptions,
  type KnowledgeConsequencesReport,
} from '../../src/commands/knowledge/consequences.js';
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

const consequences = (value: Fixture, opts: KnowledgeConsequencesOptions) =>
  run(value, () => knowledgeConsequencesAction({ ...opts, json: true }));

const reportOf = (payload: Record<string, unknown>) =>
  payload as unknown as KnowledgeConsequencesReport & { ok: true };

const keysOf = (report: KnowledgeConsequencesReport, at = 0) =>
  (report.answers[at]?.affected ?? []).map((entry) => entry.key);

/**
 * A rule the project adopted, a decision that depends on it, a task that recorded a use of the
 * rule, and code that task touched.
 */
async function history(value: Fixture) {
  const projectId = value.authority.projectId;
  const adopted = await adoptedRequirement(value.writer, { projectId, statement: OFFLINE });
  const dependent = await recordedRequirement(value.writer, { statement: QUEUE });
  const relationshipId = uuidv7();
  await publishProjectRelationship(value.writer, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: relationshipId,
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
    relationshipId,
    artifactId,
    planEventId,
    boundary: writeSequenceOf(value.writer),
  };
}

describe('orcaops knowledge consequences', { timeout: 180_000 }, () => {
  it('names the downstream work a changed rule reaches, with a reason and a full path', async () => {
    const value = await project();
    const held = await history(value);

    const { payload, failed } = await consequences(value, {
      identity: `requirement:${held.adopted.requirementId}`,
    });

    expect(failed).toBe(false);
    const report = reportOf(payload);
    expect(report.basis.knowledge_boundary).toBeGreaterThanOrEqual(held.boundary);
    expect(report.answers).toHaveLength(1);
    expect(keysOf(report)).toEqual(
      expect.arrayContaining([
        `plan_event:${held.planEventId}`,
        `artifact:${held.artifactId}`,
        `code_path:${TOUCHED}`,
        `requirement:${held.dependent.requirementId}`,
      ])
    );
    for (const entry of report.answers[0]!.affected) {
      expect(entry.reason).not.toBe('');
      expect(entry.paths.length).toBeGreaterThan(0);
    }
    const dependent = report.answers[0]!.affected.find(
      (entry) => entry.key === `requirement:${held.dependent.requirementId}`
    )!;
    expect(dependent.basis).toBe('explicit');
    expect(dependent.paths[0]![0]).toMatchObject({
      relation: 'depends_on',
      basis: 'explicit',
      standing: 'established',
      record_id: held.relationshipId,
    });
  });

  it('claims no complete impact coverage, and says what it followed instead', async () => {
    const value = await project();
    const held = await history(value);

    const report = reportOf(
      (await consequences(value, { identity: `requirement:${held.adopted.requirementId}` })).payload
    );

    expect(report.answers[0]!.coverage.statement).toContain('it is not complete impact coverage');
    expect(report.answers[0]!.coverage.statement).toContain(
      'Reaching an item is not a finding that the item is wrong'
    );
    expect(report.coverage.processing).toMatchObject({
      enabled: false,
      claim: 'not_processed',
      completed_through: null,
    });
  });

  it('names the exact revision the caller asked about', async () => {
    const value = await project();
    const held = await history(value);

    const report = reportOf(
      (
        await consequences(value, {
          revision: `requirement:${held.adopted.requirementId}@${held.adopted.revisionId}`,
        })
      ).payload
    );

    expect(report.answers[0]!.change).toMatchObject({
      kind: 'revision',
      identity: { kind: 'requirement', entity_id: held.adopted.requirementId },
      revision_id: held.adopted.revisionId,
    });
    expect(report.answers[0]!.start).toEqual([
      {
        kind: 'identity',
        target: { kind: 'requirement', entity_id: held.adopted.requirementId },
        revision_id: held.adopted.revisionId,
      },
    ]);
  });

  it('reaches the work a changed file was planned for', async () => {
    const value = await project();
    const held = await history(value);

    const report = reportOf((await consequences(value, { touching: TOUCHED })).payload);

    expect(report.answers[0]!.start).toEqual([{ kind: 'code_path', path: TOUCHED }]);
    expect(keysOf(report)).toEqual(
      expect.arrayContaining([
        `artifact:${held.artifactId}`,
        `plan_event:${held.planEventId}`,
        `requirement:${held.adopted.requirementId}`,
      ])
    );
  });

  it('reports a file no artifact touched as a limit rather than as no consequence', async () => {
    const value = await project();
    await history(value);

    const report = reportOf(
      (await consequences(value, { touching: 'packages/sync/src/absent.ts' })).payload
    );

    expect(report.answers[0]!.affected).toEqual([]);
    const limit = report.answers[0]!.limits.find((entry) => entry.kind === 'no_code_association');
    expect(limit?.detail).toContain('not the same as nothing depending on it');
  });

  it('traverses every identity whose standing moved after a boundary', async () => {
    const value = await project();
    const before = writeSequenceOf(value.writer);
    const held = await history(value);

    const report = reportOf((await consequences(value, { since: String(before) })).payload);

    expect(report.answers.length).toBeGreaterThan(0);
    expect(
      report.answers.map((answer) =>
        answer.change.kind === 'revision' ? answer.change.identity.entity_id : null
      )
    ).toContain(held.adopted.requirementId);
    expect(report.answers.every((answer) => answer.change.kind === 'revision')).toBe(true);
    expect(report.limits.map((limit) => limit.kind)).toContain('standing_sweep_unindexed');
  });

  it('spends the depth bound and names what it did not follow', async () => {
    const value = await project();
    const held = await history(value);

    const report = reportOf(
      (
        await consequences(value, {
          identity: `requirement:${held.adopted.requirementId}`,
          depth: '1',
        })
      ).payload
    );

    expect(report.basis.bounds.maxDepth).toBe(1);
    expect(report.answers[0]!.affected.every((entry) => entry.depth === 1)).toBe(true);
    expect(keysOf(report)).not.toContain(`artifact:${held.artifactId}`);
    expect(report.answers[0]!.limits.map((limit) => limit.kind)).toContain('depth_bound');
  });

  it('writes nothing, repairs nothing and starts no worker', async () => {
    const value = await project();
    const held = await history(value);
    const before = await inventory(value.root);

    await consequences(value, { identity: `requirement:${held.adopted.requirementId}` });
    await consequences(value, { touching: TOUCHED });
    await consequences(value, { since: '0' });

    expect(await inventory(value.root)).toEqual(before);
    await expect(
      access(path.join(path.dirname(value.writer.databasePath), WORKER_LOG_FILE))
    ).rejects.toThrow();
  });

  it('renders the path indented under each item, with explicit marked apart from inferred', async () => {
    const value = await project();
    const held = await history(value);

    const { text } = await run(value, () =>
      knowledgeConsequencesAction({ identity: `requirement:${held.adopted.requirementId}` })
    );

    expect(text).toContain('Consequences read at write sequence');
    expect(text).toContain(`requirement:${held.dependent.requirementId} — explicit`);
    expect(text).toContain('Path 1 (explicit throughout):');
    expect(text).toMatch(/ {8}1\. → /u);
    expect(text).toContain('Coverage:');
    expect(text).toContain('Processing coverage: not processed.');
  });

  it('asks for exactly one change to trace', async () => {
    const value = await project();
    await history(value);

    const none = await consequences(value, {});
    const both = await consequences(value, { identity: 'requirement:x', touching: TOUCHED });

    for (const result of [none, both]) {
      expect(result.failed).toBe(true);
      expect(result.payload).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(String((none.payload.error as { message: string }).message)).toContain(
      'Ask about one change'
    );
  });
});
