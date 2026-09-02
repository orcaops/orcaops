import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { ArtifactStore } from './store.js';
import { type Config, getDefaultConfig } from '../schema/config.js';
import { containsForbiddenControlChars } from '../text/control-chars.js';

/**
 * Per-source local-cleanliness: evaluator runs + dispositions reach SQLite +
 * the FTS5 index from text that BYPASSES the capture-input schemas (evaluator
 * `body`/`raw` is generated LLM output; the disposition `reason` is a CLI flag).
 * Both are sanitized at the storage write site (`writeEvaluatorRunPayload` /
 * `writeEvaluatorDisposition`). A "grep events.ndjson" test would miss a dirty
 * SQLite/FTS row, so assert the materialized rows + a search query are NUL-free.
 */
const NUL = String.fromCharCode(0x00);

/** Deep "no forbidden control char anywhere" assertion over an arbitrary value. */
function expectClean(value: unknown): void {
  expect(containsForbiddenControlChars(JSON.stringify(value) ?? '')).toBe(false);
}

describe('ArtifactStore — control-char sanitization (per source)', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/x';
  const artifactId = '01999999-9999-7000-8000-0000000000c1';
  const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
    await store.writePlan(
      {
        schema_version: 4 as const,
        artifact_id: artifactId,
        branch,
        base_sha: 'abc123',
        agent: 'claude-code' as const,
        agent_session_id: null,
        task: 'do the thing',
        label: 'do-thing',
        plan_steps: [{ step_id: STEP_ID, text: 'step 1', label: 's1', acceptance_criteria: [] }],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-04-26T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'plan-cc-1' }
    );
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  it('strips a NUL in evaluator body + nested raw before SQLite + FTS', async () => {
    await store.writeEvaluatorRunPayload(
      artifactId,
      {
        schema: 'orcaops.evaluator_run/v1' as const,
        run_id: 'run-cc-1',
        artifact_id: artifactId,
        evaluator_ref: 'core/api-stability',
        package_id: 'core',
        evaluator_id: 'api-stability',
        phase: 'checkpoint-close' as const,
        severity: 'warn' as const,
        run_status: 'completed' as const,
        verdict: 'pass' as const,
        body: `findings about slidingwindow${NUL} rate limiting`,
        raw: { output: `nested${NUL}value`, items: [`a${NUL}`, 'b'] },
        ts: '2026-04-26T12:30:00.000Z',
      },
      { idempotencyKey: 'ev-cc-1' }
    );

    const rows = store.store.listEvaluatorRuns(artifactId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('findings about slidingwindow rate limiting');
    expectClean(rows[0]); // body + the stringified raw column are NUL-free

    // FTS index is NUL-free and the cleaned token is findable.
    const hits = store.store.search('slidingwindow');
    expect(hits.map((r) => r.artifact_id)).toContain(artifactId);
    for (const hit of hits) expectClean(hit);
  });

  it('strips a NUL in a disposition reason before SQLite + FTS', async () => {
    await store.writeEvaluatorRunPayload(
      artifactId,
      {
        schema: 'orcaops.evaluator_run/v1' as const,
        run_id: 'run-cc-2',
        artifact_id: artifactId,
        evaluator_ref: 'core/api-stability',
        package_id: 'core',
        evaluator_id: 'api-stability',
        phase: 'checkpoint-close' as const,
        severity: 'block' as const,
        run_status: 'completed' as const,
        verdict: 'violation' as const,
        body: 'VIOLATION',
        ts: '2026-04-26T12:31:00.000Z',
      },
      { idempotencyKey: 'ev-cc-2' }
    );

    await store.writeEvaluatorDisposition(
      artifactId,
      {
        schema: 'orcaops.evaluator_disposition/v1' as const,
        disposition_id: '01999999-9999-7000-8000-0000000000d1',
        artifact_id: artifactId,
        run_id: 'run-cc-2',
        evaluator_ref: 'core/api-stability',
        disposition: 'acknowledged' as const,
        reason: `accepted${NUL} the risk for now`,
        agent_session_id: null,
        ts: '2026-04-26T12:32:00.000Z',
      },
      { idempotencyKey: 'ev-dispo-cc-1' }
    );

    const rows = store.store.listEvaluatorRuns(artifactId);
    for (const row of rows) expectClean(row);
    const hits = store.store.search('accepted');
    for (const hit of hits) expectClean(hit);
  });
});
