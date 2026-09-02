import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestArtifactThread } from './ingest.js';
import type { ArchivedArtifactThread } from './read.js';
import { PlanSchema } from '../schema/plan.js';
import { Store } from '../store/sqlite.js';

describe('archive artifact ingestion', () => {
  let root: string;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-archive-ingest-'));
    store = new Store(path.join(root, 'index.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('projects git-import origin into the archive project index', () => {
    const plan = PlanSchema.parse({
      schema_version: 4,
      artifact_id: 'imported-artifact',
      branch: 'main',
      base_sha: 'abc123',
      agent: 'other',
      agent_session_id: null,
      task: 'historic task',
      label: 'historic-task',
      plan_steps: [
        {
          step_id: 'historic-step',
          text: 'historic commit',
          label: 'commit',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      origin: {
        kind: 'git-import',
        imported_at: '2026-08-01T01:00:00.000Z',
        tool_version: '0.0.5',
        source_range: 'main~1..main',
        authors: ['dev@example.com'],
        enriched_at: null,
      },
      started_at: '2020-01-01T00:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
      source_event_id: 'plan-event',
    });
    const thread = {
      plan,
      checkpoints: [],
      summary: null,
      evaluatorLog: null,
      events: [],
    } as unknown as ArchivedArtifactThread;

    expect(ingestArtifactThread(store, thread)).toEqual({ indexed: true });
    expect(store.getArtifact('imported-artifact')?.origin_kind).toBe('git-import');
  });
});
