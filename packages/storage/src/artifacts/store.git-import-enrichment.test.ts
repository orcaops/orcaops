import { readFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { RecoveryRefusedError } from './errors.js';
import { artifactPathsFor } from './paths.js';
import { ArtifactStore } from './store.js';
import { loadArtifactThreadFromPaths } from '../archive/read.js';
import { appendEvent, readEventLog } from '../events/event-log.js';
import {
  type EventWithPayload,
  loadEventsWithPayloads,
  rebuildArtifactJsonFromEvents,
  rebuildCheckpointFromEvents,
  rebuildPlanFromEvents,
  rebuildSummaryFromEvents,
} from '../events/rebuilders.js';
import { type Config, getDefaultConfig } from '../schema/config.js';
import { type ArtifactOrigin, computeMemberShasHash } from '../schema/origin.js';
import { rebuildCache } from '../store/rebuild.js';

const ARTIFACT_ID = '01999999-9999-7000-8000-0000000000e1';
const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
const MEMBER_SHAS = ['a'.repeat(40), 'b'.repeat(40)];
const MEMBER_HASH = computeMemberShasHash(MEMBER_SHAS);
const CLUSTER_KEY = 'c'.repeat(64);

describe('ArtifactStore git import enrichment', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  async function writeThread(origin: ArtifactOrigin | null = currentOrigin()) {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: ARTIFACT_ID,
        branch: 'main',
        base_sha: '0'.repeat(40),
        agent: 'other',
        agent_session_id: null,
        task: 'Imported task',
        label: 'Imported label',
        plan_steps: [
          {
            step_id: STEP_ID,
            text: 'Imported step',
            label: 'Imported step',
            acceptance_criteria: [],
          },
        ],
        touched_scope: ['src/cache.ts'],
        non_goals: [],
        decisions: [],
        ...(origin ? { origin } : {}),
        started_at: '2026-01-01T00:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'plan' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: ARTIFACT_ID, declared_step_ids: [STEP_ID] },
      { idempotencyKey: 'open', headSha: MEMBER_SHAS[0]! }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: ARTIFACT_ID,
        n: 1,
        summary: 'Imported checkpoint',
        files_changed: ['src/cache.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'test', exit_code: 0 }],
        completed_step_ids: [STEP_ID],
        head_sha: MEMBER_SHAS[1]!,
      },
      { idempotencyKey: 'close' }
    );
    await store.writeSummary(
      {
        schema_version: 1,
        artifact_id: ARTIFACT_ID,
        agent: 'other',
        outcome: 'Imported outcome',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: MEMBER_SHAS[1]!,
        ts: '2026-01-01T01:00:00.000Z',
      },
      { idempotencyKey: 'summary' }
    );
  }

  function currentOrigin() {
    return {
      kind: 'git-import' as const,
      imported_at: '2026-01-01T00:00:00.000Z',
      tool_version: 'test',
      source_range: `${'0'.repeat(40)}..${MEMBER_SHAS[1]}`,
      authors: ['dev@example.com'],
      enriched_at: null,
      cluster_key: CLUSTER_KEY,
      member_shas: MEMBER_SHAS,
      member_shas_hash: MEMBER_HASH,
    };
  }

  function enrichment(overrides: Record<string, unknown> = {}) {
    return {
      provenance_version: 1 as const,
      artifact_id: ARTIFACT_ID,
      cluster_key: CLUSTER_KEY,
      member_shas_hash: MEMBER_HASH,
      enriched_at: '2026-02-01T00:00:00.000Z',
      prior_enrichment_event_id: null,
      label: 'Enriched label',
      task: 'Enriched task',
      steps: [{ label: 'Enriched step', text: 'Enriched step text' }],
      checkpoint_summaries: [{ n: 1, summary: 'Enriched checkpoint' }],
      outcome: 'Enriched outcome',
      decisions: { mode: 'preserve' as const },
      ...overrides,
    };
  }

  async function readThreadEvents(): Promise<EventWithPayload[]> {
    const paths = artifactPathsFor(repo.path, config, ARTIFACT_ID);
    const log = await readEventLog({
      eventLogPath: paths.eventsNdjson,
      sidecarsDir: paths.sidecarsDir,
      containmentRoot: repo.path,
    });
    expect(log.corrupt).toEqual([]);
    return loadEventsWithPayloads(log.events, {
      sidecarsDir: paths.sidecarsDir,
      containmentRoot: repo.path,
    });
  }

  it('appends one strict aggregate event for a complete imported thread', async () => {
    await writeThread();
    const decisions = {
      mode: 'replace' as const,
      decisions: [
        {
          decision: 'Use Redis',
          reason: 'It survives restarts',
          revision_n: 0 as const,
          evidence: {
            kind: 'git-commit' as const,
            commit_sha: MEMBER_SHAS[0]!,
            quote: 'Use Redis instead of memory',
          },
        },
      ],
    };
    const payload = enrichment({ decisions });
    const result = await store.writeGitImportEnrichment(payload, {
      idempotencyKey: 'enrich-1',
    });
    expect(result.outcome).toBe('created');

    const paths = artifactPathsFor(repo.path, config, ARTIFACT_ID);
    const records = (await readFile(paths.eventsNdjson, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: unknown });
    expect(records.at(-1)).toMatchObject({
      type: 'git_import_enriched',
      payload,
    });

    const plan = await store.readPlan(ARTIFACT_ID);
    const checkpoints = await store.readCheckpoints(ARTIFACT_ID);
    const summary = await store.readSummary(ARTIFACT_ID);
    const artifact = await store.readArtifact(ARTIFACT_ID);
    expect(plan).toMatchObject({
      label: 'Enriched label',
      task: 'Enriched task',
      origin: { ...currentOrigin(), enriched_at: '2026-02-01T00:00:00.000Z' },
      decisions: decisions.decisions,
    });
    expect(plan?.plan_steps[0]).toMatchObject({
      step_id: STEP_ID,
      label: 'Enriched step',
      text: 'Enriched step text',
      acceptance_criteria: [],
    });
    expect(checkpoints[0]).toMatchObject({
      n: 1,
      summary: 'Enriched checkpoint',
      files_changed: ['src/cache.ts'],
    });
    expect(summary).toMatchObject({ outcome: 'Enriched outcome', tests_run: [] });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('expected a created enrichment event');
    expect(artifact).toMatchObject({
      state: 'summarized',
      checkpoint_count: 1,
      source_event_id: result.event_id,
      origin: { ...currentOrigin(), enriched_at: '2026-02-01T00:00:00.000Z' },
    });
    expect(store.store.search('Enriched label')).toHaveLength(1);
    expect(store.store.search('Use Redis instead of memory')).toHaveLength(1);
    expect(store.store.listPlanRevisions(ARTIFACT_ID)[0]?.plan.source_event_id).toBe(
      checkpoints[0]?.open_plan_revision_event_id
    );
  });

  it('recovers every amended projection and archive view from the event log', async () => {
    await writeThread();
    const result = await store.writeGitImportEnrichment(enrichment(), {
      idempotencyKey: 'recoverable',
    });
    if (result.outcome !== 'created') throw new Error(result.outcome);
    const paths = artifactPathsFor(repo.path, config, ARTIFACT_ID);
    const originalProjections = {
      plan: JSON.parse(await readFile(paths.planJson, 'utf8')),
      checkpoint: JSON.parse(await readFile(paths.checkpointJson(1), 'utf8')),
      summary: JSON.parse(await readFile(paths.summaryJson, 'utf8')),
      artifact: JSON.parse(await readFile(paths.artifactJson, 'utf8')),
    };

    await rm(paths.planJson);
    const rebuiltPlan = await store.readPlan(ARTIFACT_ID);
    expect(rebuiltPlan).toMatchObject({
      label: 'Enriched label',
      source_event_id: result.event_id,
    });
    await rm(paths.checkpointJson(1));
    const rebuiltCheckpoint = await store.readCheckpoint(ARTIFACT_ID, 1);
    expect(rebuiltCheckpoint).toMatchObject({
      summary: 'Enriched checkpoint',
      source_event_id: result.event_id,
    });
    await rm(paths.summaryJson);
    const rebuiltSummary = await store.readSummary(ARTIFACT_ID);
    expect(rebuiltSummary).toMatchObject({
      outcome: 'Enriched outcome',
      source_event_id: result.event_id,
    });
    await rm(paths.artifactJson);
    const rebuiltArtifact = await store.readArtifact(ARTIFACT_ID);
    expect(rebuiltArtifact).toMatchObject({
      source_event_id: result.event_id,
      origin: { enriched_at: '2026-02-01T00:00:00.000Z' },
    });
    expect(JSON.stringify(rebuiltPlan)).toBe(JSON.stringify(originalProjections.plan));
    expect(JSON.stringify(rebuiltCheckpoint)).toBe(JSON.stringify(originalProjections.checkpoint));
    expect(JSON.stringify(rebuiltSummary)).toBe(JSON.stringify(originalProjections.summary));
    expect(JSON.stringify(rebuiltArtifact)).toBe(JSON.stringify(originalProjections.artifact));

    const archived = await loadArtifactThreadFromPaths(
      ARTIFACT_ID,
      paths.eventsNdjson,
      paths.sidecarsDir,
      repo.path
    );
    expect(archived.plan).toMatchObject({ label: 'Enriched label' });
    expect(archived.checkpoints[0]).toMatchObject({ summary: 'Enriched checkpoint' });
    expect(archived.summary).toMatchObject({ outcome: 'Enriched outcome' });
    expect(archived.artifactJson).toMatchObject({ source_event_id: result.event_id });

    await rebuildCache({ repoRoot: repo.path, config, store: store.store });
    expect(store.store.search('Enriched label')).toHaveLength(1);
    expect(store.store.search('Imported label')).toHaveLength(0);
    expect(store.store.search('Enriched checkpoint')).toHaveLength(1);
    expect(store.store.search('Enriched outcome')).toHaveLength(1);
  });

  it.each([
    {
      invariant: 'exact-member provenance',
      expected: /requires immutable exact-member provenance/u,
      mutate(events: EventWithPayload[]) {
        const plan = events.find((event) => event.record.type === 'plan_captured')!;
        const payload = plan.payload as { origin: { member_shas: string[] } };
        payload.origin.member_shas = [...payload.origin.member_shas, 'd'.repeat(40)];
      },
    },
    {
      invariant: 'artifact identity',
      expected: /does not match the imported artifact identity/u,
      mutate(events: EventWithPayload[]) {
        const event = events.find((candidate) => candidate.record.type === 'git_import_enriched')!;
        (event.payload as { cluster_key: string }).cluster_key = 'd'.repeat(64);
      },
    },
    {
      invariant: 'complete-thread ordering',
      expected: /must follow a complete imported thread/u,
      mutate(events: EventWithPayload[]) {
        const index = events.findIndex((event) => event.record.type === 'summary_captured');
        events.push(...events.splice(index, 1));
      },
    },
    {
      invariant: 'prior-event chaining',
      expected: /has a stale prior_enrichment_event_id/u,
      mutate(events: EventWithPayload[]) {
        const event = events.find((candidate) => candidate.record.type === 'git_import_enriched')!;
        (event.payload as { prior_enrichment_event_id: string | null }).prior_enrichment_event_id =
          '01999999-9999-7000-8000-000000000099';
      },
    },
    {
      invariant: 'step and checkpoint shape',
      expected: /does not cover the imported step and checkpoint shape/u,
      mutate(events: EventWithPayload[]) {
        const event = events.find((candidate) => candidate.record.type === 'git_import_enriched')!;
        (event.payload as { steps: unknown[] }).steps = [];
      },
    },
    {
      invariant: 'member-bound evidence',
      expected: /cites a commit outside the imported member set/u,
      mutate(events: EventWithPayload[]) {
        const event = events.find((candidate) => candidate.record.type === 'git_import_enriched')!;
        (event.payload as Record<string, unknown>).decisions = {
          mode: 'replace',
          decisions: [
            {
              decision: 'Use an external commit',
              reason: 'It looked relevant',
              revision_n: 0,
              evidence: {
                kind: 'git-commit',
                commit_sha: 'f'.repeat(40),
                quote: 'external evidence',
              },
            },
          ],
        };
      },
    },
    {
      invariant: 'payload schema',
      expected: /has an invalid payload/u,
      mutate(events: EventWithPayload[]) {
        const event = events.find((candidate) => candidate.record.type === 'git_import_enriched')!;
        (event.payload as { label: string }).label = '';
      },
    },
    {
      invariant: 'structural finalization',
      expected: /must follow a complete imported thread/u,
      mutate(events: EventWithPayload[]) {
        const index = events.findIndex((event) => event.record.type === 'plan_captured');
        events.push(...events.splice(index, 1));
      },
    },
  ])(
    'rejects invalid $invariant through every projection rebuilder',
    async ({ mutate, expected }) => {
      await writeThread();
      await store.writeGitImportEnrichment(enrichment(), { idempotencyKey: 'malformed-chain' });
      const malformed = structuredClone(await readThreadEvents());
      mutate(malformed);

      const projectionRebuilders = [
        () => rebuildPlanFromEvents(malformed),
        () => rebuildCheckpointFromEvents(malformed, 1),
        () => rebuildSummaryFromEvents(malformed),
        () => rebuildArtifactJsonFromEvents(malformed),
      ];
      for (const rebuild of projectionRebuilders) {
        expect(rebuild).toThrow(RecoveryRefusedError);
        expect(rebuild).toThrow(expected);
        try {
          rebuild();
        } catch (error) {
          expect(error).toMatchObject({
            code: 'RECOVERY_REFUSED',
            artifactId: ARTIFACT_ID,
          });
        }
      }
    }
  );

  it('requires a current imported origin with exact persisted membership', async () => {
    await writeThread(null);
    await expect(
      store.writeGitImportEnrichment(enrichment(), { idempotencyKey: 'live' })
    ).rejects.toMatchObject({ code: 'GIT_IMPORT_ENRICHMENT_INVALID_TARGET' });

    store.close();
    await repo.cleanup();
    repo = await createTempRepo({ initialBranch: 'main' });
    store = new ArtifactStore({ repoRoot: repo.path, config });
    const legacy: ArtifactOrigin = {
      ...currentOrigin(),
      member_shas: undefined,
    };
    await writeThread(legacy);
    await expect(
      store.writeGitImportEnrichment(enrichment(), { idempotencyKey: 'legacy' })
    ).rejects.toMatchObject({ code: 'GIT_IMPORT_ENRICHMENT_LEGACY' });
  });

  it('refuses malformed enrichment during archive and cache rebuilds', async () => {
    await writeThread();
    const paths = artifactPathsFor(repo.path, config, ARTIFACT_ID);
    await appendEvent(
      {
        type: 'git_import_enriched',
        ts: '2026-02-01T00:00:00.000Z',
        idempotency_key: 'direct-invalid-enrichment',
        payload: enrichment({
          decisions: {
            mode: 'replace',
            decisions: [
              {
                decision: 'Use an external commit',
                reason: 'It looked relevant',
                revision_n: 0,
                evidence: {
                  kind: 'git-commit',
                  commit_sha: 'f'.repeat(40),
                  quote: 'external evidence',
                },
              },
            ],
          },
        }),
      },
      {
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
        containmentRoot: repo.path,
      }
    );

    await expect(
      loadArtifactThreadFromPaths(ARTIFACT_ID, paths.eventsNdjson, paths.sidecarsDir, repo.path)
    ).rejects.toMatchObject({
      code: 'RECOVERY_REFUSED',
      artifactId: ARTIFACT_ID,
      message: expect.stringContaining('commit outside the imported member set'),
    });
    const rebuilt = await rebuildCache({ repoRoot: repo.path, config, store: store.store });
    expect(rebuilt.skipped_artifacts).toBe(1);
    expect(store.store.search('external evidence')).toEqual([]);
  });

  it('rejects mismatched identity and evidence outside the member set', async () => {
    await writeThread();
    await expect(
      store.writeGitImportEnrichment(enrichment({ member_shas_hash: 'd'.repeat(64) }), {
        idempotencyKey: 'wrong-hash',
      })
    ).rejects.toMatchObject({ code: 'GIT_IMPORT_ENRICHMENT_INVALID' });

    const decisions = {
      mode: 'replace' as const,
      decisions: [
        {
          decision: 'Use Redis',
          reason: 'It survives restarts',
          revision_n: 0 as const,
          evidence: {
            kind: 'git-commit' as const,
            commit_sha: 'f'.repeat(40),
            quote: 'Use Redis instead of memory',
          },
        },
      ],
    };
    await expect(
      store.writeGitImportEnrichment(enrichment({ decisions }), { idempotencyKey: 'outside' })
    ).rejects.toMatchObject({ code: 'GIT_IMPORT_ENRICHMENT_INVALID' });
  });

  it('rejects origin membership whose stored hash is not self-consistent', async () => {
    await writeThread({
      ...currentOrigin(),
      member_shas: [...MEMBER_SHAS, 'd'.repeat(40)],
    });

    await expect(
      store.writeGitImportEnrichment(enrichment(), { idempotencyKey: 'poisoned-membership' })
    ).rejects.toMatchObject({ code: 'GIT_IMPORT_ENRICHMENT_INVALID' });
  });

  it('replays identical content and conflicts on changed content for the same key', async () => {
    await writeThread();
    const first = await store.writeGitImportEnrichment(enrichment(), {
      idempotencyKey: 'stable-key',
    });
    if (first.outcome !== 'created') throw new Error(first.outcome);
    const paths = artifactPathsFor(repo.path, config, ARTIFACT_ID);
    await rm(paths.planJson);
    await rm(paths.checkpointJson(1));
    await rm(paths.summaryJson);
    await rm(paths.artifactJson);
    const replay = await store.writeGitImportEnrichment(
      enrichment({ enriched_at: '2026-02-02T00:00:00.000Z' }),
      { idempotencyKey: 'stable-key' }
    );
    expect(replay).toMatchObject({ outcome: 'replay', priorEventId: first.event_id });
    expect(JSON.parse(await readFile(paths.planJson, 'utf8'))).toMatchObject({
      label: 'Enriched label',
      source_event_id: first.event_id,
    });
    const conflict = await store.writeGitImportEnrichment(enrichment({ label: 'Changed label' }), {
      idempotencyKey: 'stable-key',
    });
    expect(conflict).toMatchObject({ outcome: 'conflict', priorEventId: first.event_id });
  });

  it('reports a committed event when projection refresh fails', async () => {
    await writeThread();
    const project = vi
      .spyOn(
        store as unknown as {
          projectGitImportEnrichment: (...args: unknown[]) => Promise<void>;
        },
        'projectGitImportEnrichment'
      )
      .mockRejectedValueOnce(new Error('forced projection failure'));

    await expect(
      store.writeGitImportEnrichment(enrichment(), { idempotencyKey: 'projection-failure' })
    ).rejects.toMatchObject({
      code: 'GIT_IMPORT_ENRICHMENT_PROJECTION_INCOMPLETE',
      artifactId: ARTIFACT_ID,
      enrichmentEventId: expect.any(String),
    });
    await expect(
      store.writeGitImportEnrichment(enrichment(), { idempotencyKey: 'projection-failure' })
    ).resolves.toMatchObject({ outcome: 'replay' });
    project.mockRestore();

    const events = await readThreadEvents();
    expect(events.filter((event) => event.record.type === 'git_import_enriched')).toHaveLength(1);
    expect(await store.readPlan(ARTIFACT_ID)).toMatchObject({ label: 'Enriched label' });
  });

  it('requires each repeated amendment to supersede the latest event', async () => {
    await writeThread();
    const decisions = {
      mode: 'replace' as const,
      decisions: [
        {
          decision: 'Keep the durable cache',
          reason: 'It survives restarts',
          revision_n: 0 as const,
          evidence: {
            kind: 'git-commit' as const,
            commit_sha: MEMBER_SHAS[0]!,
            quote: 'Keep the durable cache',
          },
        },
      ],
    };
    const first = await store.writeGitImportEnrichment(enrichment({ decisions }), {
      idempotencyKey: 'first',
    });
    if (first.outcome !== 'created') throw new Error(first.outcome);

    await expect(
      store.writeGitImportEnrichment(enrichment({ label: 'Second label' }), {
        idempotencyKey: 'unguarded-second',
      })
    ).rejects.toMatchObject({
      code: 'STALE_GIT_IMPORT_ENRICHMENT',
      latestEnrichmentEventId: first.event_id,
    });
    const second = await store.writeGitImportEnrichment(
      enrichment({
        label: 'Second label',
        task: 'Second task',
        checkpoint_summaries: [{ n: 1, summary: 'Second checkpoint' }],
        outcome: 'Second outcome',
        prior_enrichment_event_id: first.event_id,
      }),
      { idempotencyKey: 'second' }
    );
    if (second.outcome !== 'created') throw new Error(second.outcome);
    expect(await store.readPlan(ARTIFACT_ID)).toMatchObject({
      label: 'Second label',
      task: 'Second task',
      decisions: decisions.decisions,
    });
    expect(await store.readCheckpoint(ARTIFACT_ID, 1)).toMatchObject({
      summary: 'Second checkpoint',
    });
    expect(await store.readSummary(ARTIFACT_ID)).toMatchObject({ outcome: 'Second outcome' });
    await expect(
      store.writeGitImportEnrichment(enrichment({ decisions }), {
        idempotencyKey: 'first',
      })
    ).rejects.toMatchObject({
      code: 'STALE_GIT_IMPORT_ENRICHMENT',
      latestEnrichmentEventId: second.event_id,
    });
    await expect(
      store.writeGitImportEnrichment(
        enrichment({
          label: 'Third label',
          prior_enrichment_event_id: first.event_id,
        }),
        { idempotencyKey: 'stale-third' }
      )
    ).rejects.toMatchObject({
      code: 'STALE_GIT_IMPORT_ENRICHMENT',
      latestEnrichmentEventId: second.event_id,
    });
  });
});
