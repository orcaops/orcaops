import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { publishProjectRelationship } from '@orcaops/storage/history/database';

import type {
  ReconsiderationListReport,
  ReconsiderationOpenReport,
} from '../../../src/commands/knowledge/reconsider.js';
import {
  consequenceProject,
  orcaops,
  rowCounts,
  tableRows,
} from '../../helpers/consequences-acceptance.js';
import {
  adoptedRequirement,
  AT,
  OWNER,
  planEventOf,
  recordedRequirement,
  replaceRequirement,
  writeSequenceOf,
} from '../../helpers/knowledge-records.js';

const OFFLINE = 'Local capture works with no Cloud connection.';
const REVISED = 'Local capture works with no Cloud connection, and says so in the summary.';
const QUEUE = 'Unsent captures wait in a local queue.';

const opened = (payload: Record<string, unknown>) =>
  payload as unknown as ReconsiderationOpenReport & { ok: true };
const listed = (payload: Record<string, unknown>) =>
  payload as unknown as ReconsiderationListReport & { ok: true };

describe('a changed assumption', { timeout: 180_000 }, () => {
  it('suggests reconsideration without a defect through the public CLI and domain relationship writer', async () => {
    const project = await consequenceProject();
    const adopted = await adoptedRequirement(project.writer, {
      projectId: project.authority.projectId,
      statement: OFFLINE,
    });
    const dependent = await recordedRequirement(project.writer, { statement: QUEUE });
    await publishProjectRelationship(project.writer, {
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
        scope: { kind: 'project', project_id: project.authority.projectId },
        standing: 'established',
        authorization: null,
        source_ids: [adopted.sourceId],
        explanation: 'The queue exists because capture must work offline.',
      },
      attributedTo: { kind: 'actor', actor: OWNER },
      secretAllow: [],
    });
    const artifactId = await project.capture();
    const planEventId = planEventOf(project.writer, artifactId);
    const use = await orcaops(project, [
      'task',
      'uses',
      'record',
      '--artifact',
      artifactId,
      '--plan-event',
      planEventId,
      '--identity',
      `requirement:${adopted.requirementId}`,
      '--revision',
      adopted.revisionId,
      '--role',
      'preserve',
      '--discovered-at',
      AT,
      '--discovered-by',
      'owner',
      '--json',
    ]);
    expect(use.exitCode, use.stdout + use.stderr).toBe(0);
    await replaceRequirement(project.writer, {
      projectId: project.authority.projectId,
      adopted,
      statement: REVISED,
    });

    const before = rowCounts(project.writer);
    const result = await orcaops(project, [
      'knowledge',
      'reconsider',
      'open',
      '--revision',
      `requirement:${adopted.requirementId}@${adopted.revisionId}`,
      '--json',
    ]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const report = opened(result.payload);
    expect(report.opened).toBe(report.items.length);
    expect(report.retained).toBe(0);
    expect(
      report.items.map((entry) => `${entry.affected.kind}:${entry.affected.id}`).sort()
    ).toEqual(
      [
        `artifact:${artifactId}`,
        `plan_event:${planEventId}`,
        `requirement:${dependent.requirementId}`,
      ].sort()
    );
    expect(
      Object.keys(rowCounts(project.writer))
        .filter((table) => rowCounts(project.writer)[table] !== before[table])
        .sort()
    ).toEqual(['operations', 'reconsideration_items']);
    expect(rowCounts(project.writer)).toMatchObject({
      reconsideration_dispositions: 0,
      assignments: before.assignments,
      processing_jobs: before.processing_jobs,
      requirement_revisions: before.requirement_revisions,
    });

    const afterOpen = rowCounts(project.writer);
    const repeated = opened(
      (
        await orcaops(project, [
          'knowledge',
          'reconsider',
          'open',
          '--revision',
          `requirement:${adopted.requirementId}@${adopted.revisionId}`,
          '--json',
        ])
      ).payload
    );
    expect(repeated).toMatchObject({ opened: 0, retained: report.opened });
    expect(rowCounts(project.writer)).toEqual(afterOpen);

    const itemId = report.items[0]!.item_id;
    const itemBefore = tableRows(project.writer, ['reconsideration_items']);
    const boundary = writeSequenceOf(project.writer);
    const disposed = await orcaops(project, [
      'knowledge',
      'reconsider',
      'dispose',
      itemId,
      '--decline',
      'The affected work already accounts for the revised rule.',
      '--at',
      AT,
      '--json',
    ]);
    expect(disposed.exitCode, disposed.stdout + disposed.stderr).toBe(0);
    expect(tableRows(project.writer, ['reconsideration_items'])).toEqual(itemBefore);

    const now = listed(
      (await orcaops(project, ['knowledge', 'reconsider', 'list', '--all', '--json'])).payload
    );
    const retained = now.items.find((item) => item.itemId === itemId)!;
    expect(retained.dispositions).toEqual([
      expect.objectContaining({
        disposition: 'declined',
        reason: 'The affected work already accounts for the revised rule.',
        disposedAt: AT,
      }),
    ]);
    expect(retained.dispositions[0]!.disposedBy).not.toBeNull();

    const then = listed(
      (
        await orcaops(project, [
          'knowledge',
          'reconsider',
          'list',
          '--all',
          '--at-boundary',
          String(boundary),
          '--json',
        ])
      ).payload
    );
    expect(then.items.find((item) => item.itemId === itemId)!.dispositions).toEqual([]);
  });
});
