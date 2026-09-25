// Every query these readers run reaches its rows through an index. A scan over record_bytes, or an
// unindexed JSON extract, is a defect: these readers are on the path of every surface that asks
// what stands, and each one resolves an identity per record it reports.
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { type ProjectReadView } from './connection.js';
import { listProjectAssignments, readProjectAssignment } from './knowledge-assignments.js';
import { projectKnowledgeContext } from './knowledge-context.js';
import { publishInterpretedKnowledge } from './knowledge-interpretation.js';
import { readProjectApprovalAtBoundary } from './knowledge-read-bindings.js';
import { knowledgeReadRequest } from './knowledge-read-boundary.js';
import { readProjectGoverningState } from './knowledge-read-governing.js';
import { readProjectLineageTips } from './knowledge-read-lineage.js';
import { readProjectTaskUsesAtBoundary } from './knowledge-read-task-uses.js';
import { AT, type AuthorityStore } from '../../../tests/knowledge-authority-store.js';
import { requirementThatMoved } from '../../../tests/knowledge-read-store.js';
import { DETECTOR, discardKnowledgeStores, OWNER } from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import {
  type KnowledgeInterpretation,
  knowledgeInterpretationId,
} from '../../schema/knowledge-contract.js';
import { interpretationSegmentId } from '../../schema/knowledge-processing-contract.js';
import { prepareInterpretationText } from '../../text/interpretation-preparation.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

interface Executed {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function scansRetainedRows(sql: string, plan: readonly { detail: string }[]): boolean {
  const jsonInputs = [...sql.matchAll(/json_each\(([^)]*)\)/g)].map((match) => match[1]!.trim());
  const readsOnlySelectors = jsonInputs.length > 0 && jsonInputs.every((input) => input === '?');
  return plan.some((step) => {
    if (!/^SCAN (?!.*USING)/.test(step.detail)) return false;
    if (/^SCAN (json_each|route_target).* VIRTUAL TABLE/.test(step.detail) && readsOnlySelectors)
      return false;
    return true;
  });
}

const recording = (view: ProjectReadView, executed: Executed[]): ProjectReadView => ({
  all: (sql, ...parameters) => {
    executed.push({ sql, parameters });
    return view.all(sql, ...parameters);
  },
  get: (sql, ...parameters) => {
    executed.push({ sql, parameters });
    return view.get(sql, ...parameters);
  },
});

async function publishInterpretation(store: AuthorityStore) {
  const text = 'Keep local capture working offline';
  const prepared = prepareInterpretationText(text);
  const sourceId = `${store.plan.planEventId}#task#0`;
  const occurrence = {
    kind: 'capture_field' as const,
    artifact_id: store.plan.artifactId,
    event_id: store.plan.planEventId,
    field_path: 'task',
    position: 0,
  };
  const segmentIdentity = {
    source_id: sourceId,
    occurrence,
    role: 'task' as const,
    purpose: 'primary' as const,
    original_sha256: prepared.originalSha256,
    prepared_sha256: prepared.preparedSha256,
    mapping_version: prepared.mappingVersion,
    mapping_sha256: prepared.mappingSha256,
    prepared_range: { start: 0, end: Buffer.byteLength(prepared.prepared) },
    mapping: [...prepared.mapping],
  };
  const segment = { segment_id: interpretationSegmentId(segmentIdentity), ...segmentIdentity };
  const identity: Omit<KnowledgeInterpretation, 'interpretation_id' | 'recorded_at'> = {
    source_origin: {
      source_id: sourceId,
      task: { artifact_id: store.plan.artifactId, plan_event_id: store.plan.planEventId },
    },
    wording: 'Capturing work does not require a connection.',
    source_form: 'stated_obligation',
    proposed_record: 'requirement',
    intended_scope: { kind: 'project' },
    rationale: { kind: 'unknown' },
    uncertainties: [],
    evidence: [
      {
        source_id: sourceId,
        segment_id: segment.segment_id,
        mapping_version: prepared.mappingVersion,
        mapping_sha256: prepared.mappingSha256,
        prepared_sha256: prepared.preparedSha256,
        prepared_start_utf8: 0,
        prepared_end_utf8: Buffer.byteLength(text),
        original_ranges: [{ start: 0, end: Buffer.byteLength(text) }],
        quote: text,
        passage_sha256: digest(Buffer.from(text)),
      },
    ],
    canonical_outcome: { kind: 'proposed_equivalence', target: store.target },
    attributed_to: DETECTOR,
  };
  const record = {
    ...identity,
    interpretation_id: knowledgeInterpretationId('knowledge-interpretation@2', identity),
    recorded_at: AT,
  };
  const { attributed_to: _attributedTo, ...interpretation } = record;
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    sources: [
      {
        source_id: sourceId,
        occurrence,
        source_author: OWNER,
        interpreted_by: DETECTOR,
        access_restriction: null,
      },
    ],
    segments: [segment],
    processorContract: 'knowledge-interpretation@2',
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: store.artifact,
    records: [{ kind: 'interpretation', interpretation, restsOn: [] }],
    secretAllow: [],
  });
}

it('reaches every row through an index on every reader’s query', async () => {
  const moved = await requirementThatMoved();
  await publishInterpretation(moved.store);
  const { handle, authority, project, requirementId } = moved.store;
  const executed: Executed[] = [];
  handle.read((real) => {
    const view = recording(real, executed);
    const request = knowledgeReadRequest(view, {
      scope: project,
      mode: 'current',
      boundary: 'now',
    });
    const target = { kind: 'requirement' as const, entity_id: requirementId };
    readProjectGoverningState(view, target, authority.projectId, request);
    readProjectLineageTips(view, target, authority.projectId, request);
    readProjectLineageTips(
      view,
      { kind: 'decision', entity_id: uuidv7() },
      authority.projectId,
      request
    );
    readProjectLineageTips(
      view,
      { kind: 'claim', entity_id: uuidv7() },
      authority.projectId,
      request
    );
    readProjectTaskUsesAtBoundary(view, moved.store.plan.planEventId, authority.projectId, request);
    readProjectAssignment(view, authority.projectId, uuidv7(), request);
    for (const input of [
      {},
      { responsible: 'claude-code' },
      { identity: { kind: 'requirement' as const, entityId: requirementId } },
    ])
      listProjectAssignments(view, authority.projectId, request, input);
    readProjectApprovalAtBoundary(
      view,
      { sourcePlanRef: 'cloud:example-plan', version: '2', planContentSha256: 'a'.repeat(64) },
      authority.projectId,
      request
    );
    // The composed read, which runs the readers above plus the task-use, source and wording
    // lookups it adds. Its retrieval path is covered by `knowledge-retrieval-plans.test.ts`,
    // which names the one scan bounded retrieval is allowed.
    for (const subject of [
      { kind: 'identities' as const, targets: [target] },
      { kind: 'adopted' as const },
      { kind: 'task' as const, artifactIds: [moved.store.plan.artifactId] },
      { kind: 'subject' as const, subjectId: uuidv7() },
      { kind: 'captured_event' as const, eventId: moved.store.plan.planEventId },
    ])
      for (const assessments of [false, true])
        projectKnowledgeContext(view, {
          projectId: authority.projectId,
          scope: project,
          boundary: 'now',
          mode: 'current',
          subject,
          assessments,
          assignments: assessments,
        });
    return null;
  });
  expect(executed.length).toBeGreaterThan(10);
  expect(
    scansRetainedRows('SELECT value FROM json_each(record_bytes)', [
      { detail: 'SCAN json_each VIRTUAL TABLE INDEX 1:' },
    ])
  ).toBe(true);
  const database = new Database(handle.databasePath, { readonly: true });
  try {
    const scanned: string[] = [];
    let exactTargetQueries = 0;
    for (const { sql, parameters } of executed) {
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as {
        detail: string;
      }[];
      if (
        sql.includes(
          'CROSS JOIN knowledge_interpretations i INDEXED BY knowledge_interpretation_target'
        )
      ) {
        exactTargetQueries += 1;
        expect(plan).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              detail: expect.stringMatching(
                /^SEARCH i USING INDEX knowledge_interpretation_target \(outcome_kind=\? AND target_kind=\? AND target_id=\? AND target_revision_id=\?\)$/
              ),
            }),
          ])
        );
      }
      // Iterating a bound selector is independent of retained size; retained rows still need an
      // index, and JSON derived from retained columns must never inherit this exception.
      if (scansRetainedRows(sql, plan)) scanned.push(sql.replace(/\s+/g, ' ').trim());
    }
    expect(exactTargetQueries).toBeGreaterThan(1);
    expect([...new Set(scanned)]).toEqual([]);
  } finally {
    database.close();
  }
});
