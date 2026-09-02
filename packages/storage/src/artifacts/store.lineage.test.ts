import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor } from './paths.js';
import { ArtifactStore } from './store.js';
import { readEventLog } from '../events/event-log.js';
import { type Config, getDefaultConfig } from '../schema/config.js';

/**
 * branch_lineage_updated events fold into
 * artifact.json.branch_lineage on top of the seed `created` entry,
 * readArtifact rebuilds when the projection is stale, and re-issuing
 * the same lineage entry is a no-op (idempotent sync).
 */
describe('ArtifactStore — branch lineage', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/x';
  const artifactId = '01999999-9999-7000-8000-000000000001';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  async function writePlan(): Promise<void> {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
      branch,
      base_sha: 'sha-base',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lineage-plan',
      plan_steps: [
        { step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX', text: 's', label: 's', acceptance_criteria: [] },
      ],
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
    });
  }

  // ── readArtifact ────────────────────────────────────────────────

  describe('readArtifact', () => {
    it('returns null for an unknown artifact (no events on disk)', async () => {
      expect(await store.readArtifact('does-not-exist')).toBeNull();
    });

    it('returns the projection after a writePlan (state=planned, seed lineage)', async () => {
      await writePlan();
      const artifact = await store.readArtifact(artifactId);
      expect(artifact).not.toBeNull();
      expect(artifact!.state).toBe('planned');
      expect(artifact!.branch_lineage).toHaveLength(1);
      expect(artifact!.branch_lineage[0]).toMatchObject({
        branch: 'feat/x',
        head_sha: 'sha-base',
        event: 'created',
      });
    });

    it('serves a rebuilt artifact without recreating a deleted projection', async () => {
      await writePlan();
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      await fs.rm(paths.artifactJson);

      const artifact = await store.readArtifact(artifactId);
      expect(artifact).not.toBeNull();
      expect(artifact!.id).toBe(artifactId);
      await expect(fs.stat(paths.artifactJson)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  // ── appendBranchLineage ─────────────────────────────────────────

  describe('appendBranchLineage', () => {
    it('appends a rebased entry on top of the seed created entry', async () => {
      await writePlan();
      const result = await store.appendBranchLineage(artifactId, {
        branch: 'feat/x',
        head_sha: 'sha-rebased',
        ts: '2026-04-26T13:00:00.000Z',
        event: 'rebased',
      });
      expect(result.outcome).toBe('created');
      expect(result.artifact.branch_lineage).toHaveLength(2);
      expect(result.artifact.branch_lineage[1]).toMatchObject({
        head_sha: 'sha-rebased',
        event: 'rebased',
      });
      expect(result.artifact.updated_at).toBe('2026-04-26T13:00:00.000Z');
    });

    it('appends a merged entry pointing at the merge commit on the target branch', async () => {
      await writePlan();
      await store.appendBranchLineage(artifactId, {
        branch: 'main',
        head_sha: 'sha-merge',
        ts: '2026-04-26T14:00:00.000Z',
        event: 'merged',
      });
      const artifact = await store.readArtifact(artifactId);
      expect(artifact!.branch_lineage).toHaveLength(2);
      expect(artifact!.branch_lineage[1]).toMatchObject({
        branch: 'main',
        event: 'merged',
      });
    });

    it('writes one branch_lineage_updated event per call to events.ndjson', async () => {
      await writePlan();
      await store.appendBranchLineage(artifactId, {
        branch: 'feat/x',
        head_sha: 'sha-rebased',
        ts: '2026-04-26T13:00:00.000Z',
        event: 'rebased',
      });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      const lineageEvents = log.events.filter((e) => e.type === 'branch_lineage_updated');
      expect(lineageEvents).toHaveLength(1);
    });

    it('is idempotent on the projection: re-issuing the same entry does NOT duplicate the row', async () => {
      await writePlan();
      const entry = {
        branch: 'feat/x',
        head_sha: 'sha-rebased',
        ts: '2026-04-26T13:00:00.000Z',
        event: 'rebased' as const,
      };
      await store.appendBranchLineage(artifactId, entry);
      await store.appendBranchLineage(artifactId, entry);

      const artifact = await store.readArtifact(artifactId);
      // Two events, but only one new lineage row past the seed.
      expect(artifact!.branch_lineage).toHaveLength(2);
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      const lineageEvents = log.events.filter((e) => e.type === 'branch_lineage_updated');
      expect(lineageEvents).toHaveLength(2);
    });
  });
});
