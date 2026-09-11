import { beforeEach, describe, expect, it } from 'vitest';

import type { ArtifactDraftSemantics } from './draft-preparation.js';
import {
  createRetainedArtifactDraft,
  type RetainedArtifactDraft,
} from './retained-draft.test-support.js';

describe('artifact semantics — branch lineage', () => {
  let draft: RetainedArtifactDraft;
  let semantics: ArtifactDraftSemantics;

  const branch = 'feat/x';
  const artifactId = '01999999-9999-7000-8000-000000000001';

  beforeEach(() => {
    draft = createRetainedArtifactDraft(artifactId);
    semantics = draft.semantics;
  });

  async function writePlan(): Promise<void> {
    await semantics.writePlan({
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

  describe('readArtifact', () => {
    it('returns planned state and seed lineage after a plan capture', async () => {
      await writePlan();
      const artifact = await semantics.readArtifact(artifactId);
      expect(artifact).not.toBeNull();
      expect(artifact!.state).toBe('planned');
      expect(artifact!.branch_lineage).toHaveLength(1);
      expect(artifact!.branch_lineage[0]).toMatchObject({
        branch: 'feat/x',
        head_sha: 'sha-base',
        event: 'created',
      });
    });
  });

  describe('appendBranchLineage', () => {
    it('appends a rebased entry on top of the seed created entry', async () => {
      await writePlan();
      const result = await semantics.appendBranchLineage(artifactId, {
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
      await semantics.appendBranchLineage(artifactId, {
        branch: 'main',
        head_sha: 'sha-merge',
        ts: '2026-04-26T14:00:00.000Z',
        event: 'merged',
      });
      const artifact = await semantics.readArtifact(artifactId);
      expect(artifact!.branch_lineage).toHaveLength(2);
      expect(artifact!.branch_lineage[1]).toMatchObject({
        branch: 'main',
        event: 'merged',
      });
    });

    it('retains one branch_lineage_updated event per call', async () => {
      await writePlan();
      await semantics.appendBranchLineage(artifactId, {
        branch: 'feat/x',
        head_sha: 'sha-rebased',
        ts: '2026-04-26T13:00:00.000Z',
        event: 'rebased',
      });
      const lineageEvents = draft.events.filter(
        (event) => event.record.type === 'branch_lineage_updated'
      );
      expect(lineageEvents).toHaveLength(1);
    });

    it('does not duplicate rebuilt lineage when the same entry is reissued', async () => {
      await writePlan();
      const entry = {
        branch: 'feat/x',
        head_sha: 'sha-rebased',
        ts: '2026-04-26T13:00:00.000Z',
        event: 'rebased' as const,
      };
      await semantics.appendBranchLineage(artifactId, entry);
      await semantics.appendBranchLineage(artifactId, entry);

      const artifact = await semantics.readArtifact(artifactId);
      // Two events, but only one new lineage row past the seed.
      expect(artifact!.branch_lineage).toHaveLength(2);
      const lineageEvents = draft.events.filter(
        (event) => event.record.type === 'branch_lineage_updated'
      );
      expect(lineageEvents).toHaveLength(2);
    });
  });
});
