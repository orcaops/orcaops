// Every query the evidence readers and writers run reaches its rows through an index. Expectation
// lookup asks for a revision's assessments on the path of every answer about whether software
// meets an expectation, and a scan there is a scan per expectation shown.
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { type ProjectReadView } from './connection.js';
import {
  publishProjectKnowledgeAssessment,
  readProjectKnowledgeAssessment,
} from './knowledge-assessments.js';
import {
  listProjectClaimRevisionObservations,
  publishProjectObservation,
  readProjectObservation,
  unretainedObservations,
} from './knowledge-observations.js';
import { knowledgeReadRequest } from './knowledge-read-boundary.js';
import { readProjectExpectationAssessments } from './knowledge-read-evidence.js';
import { authorityStore } from '../../../tests/knowledge-authority-store.js';
import { AGENT, discardKnowledgeStores, OWNER } from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

interface Executed {
  readonly sql: string;
  readonly parameters: readonly unknown[];
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

it('reaches every row through an index on every evidence query', async () => {
  const { handle, sourceId, target, project } = await authorityStore();
  const observationId = uuidv7();
  await publishProjectObservation(handle, {
    operationId: uuidv7(),
    observation: {
      observation_id: observationId,
      source_id: sourceId,
      method: { name: 'vitest', configuration_sha256: null },
      execution: { kind: 'agent_reported', command: 'pnpm vitest run offline-capture' },
      input_basis: 'unknown',
      known_inputs: [],
      outcome: 'passed',
      detail: null,
      retained_artifacts: [],
      started_at: null,
      finished_at: null,
      limits: [],
    },
    observedBy: AGENT,
    secretAllow: [],
  });
  const assessmentId = uuidv7();
  await publishProjectKnowledgeAssessment(handle, {
    operationId: uuidv7(),
    assessment: {
      assessment_id: assessmentId,
      expectations: [target],
      exception_ids: [],
      implementation: {
        kind: 'selected',
        inputs: [{ kind: 'release', identity: '0.2.1' }],
        environment: null,
      },
      evidence: [
        {
          source: { kind: 'observation', observation_id: observationId },
          role: 'supports',
          limitations: null,
        },
      ],
      method: { name: 'release review', configuration_sha256: null },
      conclusions: [
        { expectation: target, conclusion: 'supported', reason: 'the offline smoke passed' },
      ],
      check_states: [],
      coverage_limits: [],
      observed_write_sequence: 0,
      observed_intent_counter: 0,
    },
    assessedBy: OWNER,
    secretAllow: [],
  });

  const executed: Executed[] = [];
  handle.read((real) => {
    const view = recording(real, executed);
    const request = knowledgeReadRequest(view, {
      scope: project,
      mode: 'current',
      boundary: 'now',
    });
    readProjectExpectationAssessments(view, target, request);
    readProjectKnowledgeAssessment(view, assessmentId);
    readProjectObservation(view, observationId);
    listProjectClaimRevisionObservations(view, uuidv7());
    unretainedObservations(view, [observationId]);
    return null;
  });
  expect(executed.length).toBeGreaterThan(6);
  const database = new Database(handle.databasePath, { readonly: true });
  try {
    const scanned: string[] = [];
    for (const { sql, parameters } of executed) {
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as {
        detail: string;
      }[];
      if (plan.some((step) => /^SCAN (?!.*USING)/.test(step.detail)))
        scanned.push(sql.replace(/\s+/g, ' ').trim());
    }
    expect([...new Set(scanned)]).toEqual([]);
  } finally {
    database.close();
  }
});
