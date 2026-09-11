import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { prepareArtifactDraft } from '../../artifacts/draft-preparation.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { PlanInputSchema } from '../../schema/plan.js';
import { containsForbiddenControlChars } from '../../text/control-chars.js';
import { normalizeHistoryRoot } from '../paths.js';
import { appendProjectArtifactEvents, readProjectArtifact } from './artifacts.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { queryProjectSearch } from './search.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function expectClean(value: unknown): void {
  if (typeof value === 'string') expect(containsForbiddenControlChars(value)).toBe(false);
  else if (value && typeof value === 'object') Object.values(value).forEach(expectClean);
}

it.each([false, true])(
  'cleans evaluator text and disposition=%s before retention and search',
  async (withDisposition) => {
    const root = await normalizeHistoryRoot({
      root: await mkdtemp(path.join(tmpdir(), 'artifact-sanitization-')),
    });
    roots.push(root.resolvedRoot);
    const authority = {
      ...root,
      projectId: uuidv7(),
      storeInstanceId: uuidv7(),
      repositoryInstanceId: uuidv7(),
    };
    await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
    const handle = await initializeProjectDatabase({
      authority,
      initializationOperationId: uuidv7(),
      initializedAt: '2026-09-01T00:00:00.000Z',
      authorize() {},
    });
    handles.push(handle);
    const artifactId = uuidv7();
    const nul = String.fromCharCode(0);
    const run = {
      schema: 'orcaops.evaluator_run/v1' as const,
      run_id: uuidv7(),
      artifact_id: artifactId,
      evaluator_ref: 'test/api-stability',
      package_id: 'test',
      evaluator_id: 'api-stability',
      phase: 'checkpoint-close' as const,
      severity: 'block' as const,
      run_status: 'completed' as const,
      verdict: withDisposition ? ('violation' as const) : ('pass' as const),
      body: `findings about slidingwindow${nul} rate limiting`,
      raw: { output: `nested${nul}value`, items: [`a${nul}`, 'b'] },
      ts: '2026-09-01T00:01:00.000Z',
    };
    const disposition = {
      schema: 'orcaops.evaluator_disposition/v1' as const,
      disposition_id: uuidv7(),
      artifact_id: artifactId,
      run_id: run.run_id,
      evaluator_ref: run.evaluator_ref,
      disposition: 'acknowledged' as const,
      reason: `accepted${nul} the risk for now`,
      agent_session_id: null,
      ts: '2026-09-01T00:02:00.000Z',
    };
    const prepared = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: [],
        authoredPayload: { run, disposition },
        secretAllow: [],
        idempotencyBlocks: [],
      },
      async (semantics) => {
        await semantics.writePlan(
          PlanInputSchema.parse({
            schema_version: 4,
            artifact_id: artifactId,
            branch: 'main',
            base_sha: 'a'.repeat(40),
            agent: 'codex',
            agent_session_id: null,
            task: 'Retain clean evaluator text',
            label: 'Evaluator text',
            plan_steps: [
              {
                step_id: uuidv7(),
                text: 'Inspect output',
                label: 'Inspect',
                acceptance_criteria: [],
              },
            ],
            touched_scope: [],
            non_goals: [],
            decisions: [],
            started_at: '2026-09-01T00:00:00.000Z',
            revision_n: 0,
            revised_at: null,
            rationale: null,
            step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
            criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
            prior_plan_event_id: null,
          })
        );
        await semantics.writeEvaluatorRunPayload(artifactId, run);
        if (withDisposition) await semantics.writeEvaluatorDisposition(artifactId, disposition);
      }
    );
    if (prepared.evaluation.kind === 'threw') throw prepared.evaluation.error;
    await appendProjectArtifactEvents(handle, {
      artifactId,
      operationId: uuidv7(),
      expectedRevision: null,
      eventBytes: Buffer.concat(prepared.events.map((event) => event.eventBytes)),
      sidecarPayloads: prepared.events.flatMap((event) =>
        event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
      ),
      secretAllow: [],
    });
    const retained = readProjectArtifact(handle, artifactId)!;
    const retainedRun = retained.thread.evaluatorLog!.runs[0];
    expect(retainedRun.body).toBe('findings about slidingwindow rate limiting');
    expect(retainedRun.raw).toEqual({ output: 'nestedvalue', items: ['a', 'b'] });
    expectClean(retained.thread.events);
    if (withDisposition) {
      const event = retained.thread.events.find(
        (event) => event.record.type === 'evaluator_disposition_recorded'
      );
      expect(event?.payload).toMatchObject({ reason: 'accepted the risk for now' });
    }
    const hits = queryProjectSearch(handle, {
      query: [withDisposition ? 'accepted' : 'slidingwindow'],
      sourceKinds: [withDisposition ? 'block-resolution' : 'evaluator'],
      limit: 10,
    });
    expect(hits.rows.map((row) => row.artifact_id)).toEqual([artifactId]);
    for (const row of hits.rows) expectClean(JSON.parse(row.payload_json));
  }
);
