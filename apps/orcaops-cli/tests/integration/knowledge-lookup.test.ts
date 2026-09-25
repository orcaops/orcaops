import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type RecordRevisionRef, uuidv7 } from '@orcaops/storage';
import { runProjectOperation } from '@orcaops/storage/history/database';

import {
  knowledgeLookupAction,
  type KnowledgeLookupAnswer,
} from '../../src/commands/knowledge/lookup.js';
import { CliExit } from '../../src/io/exit.js';
import { WORKER_LOG_FILE } from '../../src/knowledge-worker/start.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture, inventory } from '../helpers/database-history.js';
import {
  adoptedRequirement,
  OWNER,
  recordedRequirement,
  replaceRequirement,
  withdrawRequirement,
} from '../helpers/knowledge-records.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const OFFLINE = 'Local capture works with no Cloud connection.';
const REPLACEMENT =
  'Local capture works with no Cloud connection, and says when it cannot reach one.';

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

async function lookup(
  value: Fixture,
  opts: Parameters<typeof knowledgeLookupAction>[0]
): Promise<{ payload: Record<string, unknown>; failed: boolean }> {
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
      () => knowledgeLookupAction({ ...opts, json: true })
    );
  } catch (err) {
    if (!(err instanceof CliExit)) throw err;
    failed = true;
  }
  return { payload: JSON.parse(stdout.join('')) as Record<string, unknown>, failed };
}

const answerOf = (payload: Record<string, unknown>) =>
  payload as unknown as KnowledgeLookupAnswer & { ok: true };

async function importReplacements(
  value: Fixture,
  edges: readonly { from: RecordRevisionRef; to: RecordRevisionRef }[]
): Promise<string[]> {
  const ids = edges.map(() => uuidv7());
  // Imported graphs may contain cycles that the normal authoring writer refuses.
  await runProjectOperation(
    value.writer,
    {
      operationId: uuidv7(),
      kind: 'knowledge.imported.relationship.graph',
      target: { relationshipIds: ids },
      payload: { edges: [...edges] },
      expectedState: null,
      intentChange: false,
    },
    (transaction, operation) => {
      edges.forEach(({ from, to }, index) => {
        transaction.run(
          `INSERT INTO record_relationships (relationship_id, relation, from_entity_kind,
             from_entity_id, from_revision_id, to_entity_kind, to_entity_id, to_revision_id,
             scope_kind, scope_value, attributed_kind, attributed_to, attributed_basis, standing,
             explanation, source_refs_json, operation_id)
           VALUES (?,'supersedes',?,?,?,?,?,?,'project',NULL,'author',?,'unknown',
             'established',NULL,'[]',?)`,
          ids[index]!,
          from.kind,
          from.entity_id,
          from.revision_id,
          to.kind,
          to.entity_id,
          to.revision_id,
          OWNER.identity,
          operation.operationId
        );
      });
      return { imported: ids.length };
    }
  );
  return ids;
}

/** The same read, rendered for a person rather than as JSON. */
async function lookupText(
  value: Fixture,
  opts: Parameters<typeof knowledgeLookupAction>[0]
): Promise<{ text: string }> {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
    () => knowledgeLookupAction(opts)
  );
  return { text: stdout.join('') };
}

describe('orcaops knowledge lookup', { timeout: 120_000 }, () => {
  it('returns a relationship requested by identity when its endpoint lookup reaches it', async () => {
    const value = await project();
    const source = await recordedRequirement(value.writer, {
      statement: 'Keep original event identifiers.',
    });
    const dependent = await recordedRequirement(value.writer, {
      statement: 'Export every original event identifier.',
    });
    const [relationshipId] = await importReplacements(value, [
      {
        from: {
          kind: 'requirement',
          entity_id: dependent.requirementId,
          revision_id: dependent.revisionId,
        },
        to: {
          kind: 'requirement',
          entity_id: source.requirementId,
          revision_id: source.revisionId,
        },
      },
    ]);

    const endpoint = answerOf(
      (await lookup(value, { identity: [`requirement:${source.requirementId}`] })).payload
    );
    const { payload, failed } = await lookup(value, {
      identity: [`relationship:${relationshipId}`],
    });
    const direct = answerOf(payload);

    expect(failed).toBe(false);
    expect(endpoint.entries[0]!.resolved.relationships).toMatchObject([
      { relationship_id: relationshipId, standing: 'established' },
    ]);
    expect(direct.entries.map((entry) => entry.key)).toEqual([`relationship:${relationshipId}`]);
    expect(direct.entries[0]!.resolved.relationships).toMatchObject([
      { relationship_id: relationshipId, standing: 'established' },
    ]);
    expect(direct.limits.map((limit) => limit.kind)).not.toContain('no_record_at_boundary');
  });

  it('qualifies plan coverage when statement bytes omit an applicable rule', async () => {
    const value = await project();
    const artifactId = await value.capture();
    const rule = await adoptedRequirement(value.writer, {
      projectId: value.authority.projectId,
      statement: 'Persist the original event timestamp. '.repeat(2_000),
    });
    const options = {
      identity: [`requirement:${rule.requirementId}`],
      scope: `artifact:${artifactId}`,
    };
    const { payload, failed } = await lookup(value, options);
    expect(failed).toBe(false);
    const answer = answerOf(payload);
    expect(answer.applicable_not_selected.plan_event_id).not.toBeNull();
    expect(answer.limits.map((limit) => limit.kind)).toContain('statement_bytes');
    expect(answer.applicable_not_selected.entries).toEqual([]);
    expect(answer.applicable_not_selected.statement).toContain('incomplete');
    const { text } = await lookupText(value, options);
    expect(text).toContain('incomplete');
    expect(text).not.toContain('nothing this plan could miss');
    expect(text).not.toContain('selected every one');
  });

  it('renders an imported replacement cycle without applying its edges', async () => {
    const value = await project();
    const records = [];
    for (const statement of [
      'Keep original timestamps.',
      'Keep event identifiers.',
      'Keep source bytes.',
    ])
      records.push(await recordedRequirement(value.writer, { statement }));
    const revisions = records.map((record) => ({
      kind: 'requirement' as const,
      entity_id: record.requirementId,
      revision_id: record.revisionId,
    }));
    const ids = await importReplacements(
      value,
      revisions.map((from, index) => ({ from, to: revisions[(index + 1) % revisions.length]! }))
    );
    const options = { identity: [`requirement:${revisions[0]!.entity_id}`] };
    const { payload, failed } = await lookup(value, options);
    expect(failed).toBe(false);
    const answer = answerOf(payload);
    expect(answer.unresolved).toContainEqual({
      about: 'relationship',
      record_ids: ids.sort(),
      reason: 'replacement_cycle',
    });
    expect(answer.entries[0]!.resolved.relationships).toHaveLength(3);
    expect(answer.entries[0]!.resolved.relationships.every((edge) => !edge.applied)).toBe(true);
    const { text } = await lookupText(value, options);
    expect(text).toContain('replacement_cycle');
    expect(text).not.toContain('Unresolved (0)');
  });

  it('renders graph exhaustion as unresolved without applying uncertain replacements', async () => {
    const value = await project();
    const original = await recordedRequirement(value.writer, {
      statement: 'Keep original events.',
    });
    const replacement = await recordedRequirement(value.writer, {
      statement: 'Keep exported events.',
    });
    const edge = {
      from: {
        kind: 'requirement' as const,
        entity_id: replacement.requirementId,
        revision_id: replacement.revisionId,
      },
      to: {
        kind: 'requirement' as const,
        entity_id: original.requirementId,
        revision_id: original.revisionId,
      },
    };
    await importReplacements(
      value,
      Array.from({ length: 10_001 }, () => edge)
    );
    const options = { identity: [`requirement:${original.requirementId}`] };
    const { payload, failed } = await lookup(value, options);
    expect(failed).toBe(false);
    const answer = answerOf(payload);
    expect(answer.unresolved).toContainEqual(
      expect.objectContaining({ reason: 'replacement_graph_incomplete' })
    );
    expect(answer.entries[0]!.resolved.relationships).toHaveLength(10_000);
    expect(answer.entries[0]!.resolved.relationships.every((entry) => !entry.applied)).toBe(true);
    const { text } = await lookupText(value, options);
    expect(text).toContain('replacement_graph_incomplete');
    expect(text).not.toContain('Unresolved (0)');
  });

  it('puts an adopted rule that applies first, with the boundary it read at', async () => {
    const value = await project();
    const adopted = await adoptedRequirement(value.writer, {
      projectId: value.authority.projectId,
      statement: OFFLINE,
    });

    const { payload, failed } = await lookup(value, {
      identity: [`requirement:${adopted.requirementId}`],
    });

    expect(failed).toBe(false);
    const answer = answerOf(payload);
    expect((payload as { task_selection: unknown }).task_selection).toEqual({ kind: 'absent' });
    expect(answer.basis.knowledge_boundary).toBeGreaterThanOrEqual(adopted.boundary);
    expect(answer.basis.mode).toBe('current');
    expect(answer.applicable).toEqual([`requirement:${adopted.requirementId}`]);
    expect(answer.background).toEqual([]);
    expect(answer.entries[0]!.revisions[0]).toMatchObject({
      standing: 'adopted',
      designation: 'adopted',
      statement: OFFLINE,
    });
    expect(answer.entries[0]!.reason).toContain('Adopted in the project');
    expect(answer.entries[0]!.references.map((reference) => reference.sourceId)).toContain(
      adopted.sourceId
    );
  });

  it('reproduces what stood at a past boundary, with the later correction only in the annotations', async () => {
    const value = await project();
    const projectId = value.authority.projectId;
    const adopted = await adoptedRequirement(value.writer, { projectId, statement: OFFLINE });
    const replacement = await replaceRequirement(value.writer, {
      projectId,
      adopted,
      statement: REPLACEMENT,
    });
    const withdrawal = await withdrawRequirement(value.writer, {
      projectId,
      adopted,
      revisionId: replacement.revisionId,
      selectionId: replacement.selectionId,
    });

    const then = answerOf(
      (
        await lookup(value, {
          identity: [`requirement:${adopted.requirementId}`],
          atBoundary: String(adopted.boundary),
        })
      ).payload
    );
    const now = answerOf(
      (await lookup(value, { identity: [`requirement:${adopted.requirementId}`] })).payload
    );

    expect(then.basis).toMatchObject({ knowledge_boundary: adopted.boundary, mode: 'historical' });
    expect(then.entries[0]!.revisions.map((revision) => revision.statement)).toEqual([OFFLINE]);
    expect(then.applicable).toEqual([`requirement:${adopted.requirementId}`]);
    expect(then.later_annotations.map((later) => later.record_id)).toContain(withdrawal.actionId);
    // The correction is separately dated and never enters the basis it annotates.
    expect(then.entries[0]!.resolved.governing_state.correction_action_ids).not.toContain(
      withdrawal.actionId
    );

    expect(now.basis.knowledge_boundary).toBe(withdrawal.boundary);
    expect(now.applicable).toEqual([]);
    expect(now.later_annotations).toEqual([]);
  });

  it('reads not processed with processing off, writes nothing and starts no worker', async () => {
    const value = await project();
    const adopted = await adoptedRequirement(value.writer, {
      projectId: value.authority.projectId,
      statement: OFFLINE,
    });
    const before = await inventory(value.root);

    const answer = answerOf(
      (await lookup(value, { identity: [`requirement:${adopted.requirementId}`] })).payload
    );

    expect(answer.coverage.processing).toMatchObject({
      enabled: false,
      claim: 'not_processed',
      completed_through: null,
    });
    expect(answer.coverage.processing?.statement).toContain('claims no completeness');
    expect(await inventory(value.root)).toEqual(before);
    await expect(
      access(path.join(path.dirname(value.writer.databasePath), WORKER_LOG_FILE))
    ).rejects.toThrow();
  });

  it('spends --limit on background before an adopted rule that applies, and names what it cut', async () => {
    const value = await project();
    const projectId = value.authority.projectId;
    // The background one is minted FIRST, so its key sorts first: a cap that cut by key order
    // rather than by placement would keep it and drop the rule the work has to meet.
    const background = await recordedRequirement(value.writer, {
      statement: 'Every capture names the operation that wrote it.',
    });
    const adopted = await adoptedRequirement(value.writer, { projectId, statement: OFFLINE });
    expect(background.requirementId < adopted.requirementId).toBe(true);
    const asked = [
      `requirement:${adopted.requirementId}`,
      `requirement:${background.requirementId}`,
    ];

    const both = answerOf((await lookup(value, { identity: asked })).payload);
    expect(both.applicable).toEqual([`requirement:${adopted.requirementId}`]);
    expect(both.background).toEqual([`requirement:${background.requirementId}`]);

    const capped = answerOf((await lookup(value, { identity: asked, limit: '1' })).payload);

    expect(capped.applicable).toEqual([`requirement:${adopted.requirementId}`]);
    expect(capped.background).toEqual([]);
    const left = capped.limits.find((limit) => limit.kind === 'identity_count');
    expect(left?.detail).toContain(`requirement:${background.requirementId}`);
    expect(left?.detail).toContain('background before applicable');

    const { text } = await lookupText(value, { identity: asked, limit: '1' });
    expect(text).toContain('Applicable (1)');
    expect(text).toContain(`requirement:${background.requirementId}`);
  });

  it('says there is no such record rather than showing an identity it holds nothing for', async () => {
    const value = await project();
    const adopted = await adoptedRequirement(value.writer, {
      projectId: value.authority.projectId,
      statement: OFFLINE,
    });
    const nothing = `decision:${randomUUID()}`;

    const answer = answerOf(
      (await lookup(value, { identity: [`requirement:${adopted.requirementId}`, nothing] })).payload
    );

    expect(answer.entries.map((entry) => entry.key)).toEqual([
      `requirement:${adopted.requirementId}`,
    ]);
    expect(answer.background).toEqual([]);
    const left = answer.limits.find((limit) => limit.kind === 'no_record_at_boundary');
    expect(left?.detail).toContain(nothing);
    expect(left?.detail).toContain('no such record at this boundary');
  });

  it('refuses a question about affected code, and says what to run instead', async () => {
    const value = await project();

    const { payload, failed } = await lookup(value, { touching: 'src/app.ts' });

    expect(failed).toBe(true);
    expect(payload).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(String((payload.error as { message: string }).message)).toContain(
      'orcaops list --touching'
    );
  });
});
