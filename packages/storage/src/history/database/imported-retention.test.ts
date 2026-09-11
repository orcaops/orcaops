import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { prepareArtifactDraft } from '../../artifacts/draft-preparation.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { buildDefaultSkippedFingerprintSummary } from '../../schema/diff-fingerprint.js';
import { normalizeHistoryRoot } from '../paths.js';
import { readProjectArtifact } from './artifacts.js';
import {
  beginProjectImportedArtifactRetention,
  settleProjectImportedArtifactRetention,
} from './capture-retention.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { readProjectExecution } from './execution-records.js';
import { type PendingCaptureInput, readProjectPendingCapture } from './pending-capture.js';
import { prepareProjectGitRetention } from './retention-input.js';
import { readProjectGitRetention } from './retention-records.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-imported-retention-')),
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
  const artifactId = uuidv7(),
    stepId = uuidv7(),
    openPublicationId = uuidv7(),
    closePublicationId = uuidv7();
  const openRef = `refs/orcaops/snap/${artifactId}/1/open-${openPublicationId}`;
  const closeRef = `refs/orcaops/snap/${artifactId}/1/close-${closePublicationId}`;
  const draft = await prepareArtifactDraft(
    {
      artifactId,
      priorEvents: [],
      authoredPayload: { source: 'git-import' },
      secretAllow: [],
      idempotencyBlocks: [],
    },
    async (semantics) => {
      const plan = await semantics.writePlan(
        {
          schema_version: 4,
          artifact_id: artifactId,
          branch: 'main',
          base_sha: 'a'.repeat(40),
          agent: 'other',
          agent_session_id: null,
          task: 'Imported work',
          label: 'Imported work',
          plan_steps: [
            {
              step_id: stepId,
              text: 'Import change',
              label: 'Import change',
              acceptance_criteria: [],
            },
          ],
          touched_scope: ['src/a.ts'],
          non_goals: [],
          decisions: [],
          origin: {
            kind: 'git-import',
            imported_at: '2026-09-01T00:00:00.000Z',
            tool_version: 'test',
            source_range: `${'a'.repeat(40)}..${'b'.repeat(40)}`,
            authors: ['dev@example.test'],
            enriched_at: null,
            cluster_key: '1'.repeat(64),
            member_shas: ['b'.repeat(40)],
            member_shas_hash: 'c'.repeat(64),
          },
          started_at: '2026-09-01T00:00:00.000Z',
          revision_n: 0,
          revised_at: null,
          rationale: null,
          step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
          criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
          prior_plan_event_id: null,
        },
        { idempotencyKey: 'import:plan' }
      );
      const opened = await semantics.writeCheckpointOpened(
        {
          artifact_id: artifactId,
          declared_step_ids: [stepId],
          policy_exceptions: [],
          plan_revision_id: plan.event_id,
        },
        {
          headSha: 'a'.repeat(40),
          openedAt: '2026-09-01T00:00:00.000Z',
          idempotencyKey: 'import:open',
          invokedByAgent: 'other',
          snapshotCallbacks: {
            captureOpenSnapshot: async () => ({
              boundary: {
                snapshot_ref: openRef,
                tree_sha: 'd'.repeat(40),
                snapshot_commit_sha: 'a'.repeat(40),
                snapshot_error_reason: null,
              },
            }),
          },
        }
      );
      if (!('checkpoint' in opened)) throw new Error('fixture checkpoint did not open');
      await semantics.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: opened.checkpoint.n,
          summary: 'Imported change',
          files_changed: ['src/a.ts'],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          completed_step_ids: [stepId],
          head_sha: 'b'.repeat(40),
        },
        {
          closedAt: '2026-09-01T00:00:00.000Z',
          idempotencyKey: 'import:close',
          invokedByAgent: 'other',
          skipWallClockOverlapScan: true,
          snapshotCallbacks: {
            captureCloseFingerprint: async () => ({
              boundary: {
                snapshot_ref: closeRef,
                tree_sha: 'e'.repeat(40),
                snapshot_commit_sha: 'b'.repeat(40),
                snapshot_error_reason: null,
              },
              summary: buildDefaultSkippedFingerprintSummary(),
              manifest: null,
            }),
          },
        }
      );
      await semantics.writeSummary(
        {
          schema_version: 1,
          artifact_id: artifactId,
          agent: 'other',
          outcome: 'Imported work',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          head_sha: 'b'.repeat(40),
          ts: '2026-09-01T00:00:00.000Z',
        },
        { idempotencyKey: 'import:summary' }
      );
    }
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  const operationId = uuidv7();
  const capture: PendingCaptureInput = {
    artifactId,
    operationId,
    expectedRevision: null,
    eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
    sidecarPayloads: [],
    secretAllow: [],
    execution: {
      kind: 'create',
      context: {
        repository_instance_id: authority.repositoryInstanceId,
        worktree_id: uuidv7(),
        git_context: { branch: 'main', head_sha: 'b'.repeat(40) },
      },
      ts: '2026-09-01T00:00:00.000Z',
    },
  };
  const openEvent = draft.events.find((event) => event.record.type === 'checkpoint_opened')!;
  const closeEvent = draft.events.find((event) => event.record.type === 'checkpoint_closed')!;
  const preparedTransitionId = uuidv7();
  const retention = prepareProjectGitRetention({
    operationId,
    admissionOperationId: uuidv7(),
    preparedTransitionId,
    repositoryInstanceId: authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:00:00.000Z',
    target: {
      kind: 'capture',
      artifactId,
      expectedRevision: null,
      expectedExecutionVersion: null,
      expectedBindingGeneration: null,
      expectedBaselinePublicationId: null,
    },
    publications: [
      {
        publicationId: openPublicationId,
        role: 'checkpoint',
        targetId: openEvent.record.event_id,
        checkpointNumber: 1,
        checkpointPhase: 'open',
        objectOid: 'a'.repeat(40),
        treeOid: 'd'.repeat(40),
      },
      {
        publicationId: closePublicationId,
        role: 'checkpoint',
        targetId: closeEvent.record.event_id,
        checkpointNumber: 1,
        checkpointPhase: 'close',
        objectOid: 'b'.repeat(40),
        treeOid: 'e'.repeat(40),
      },
    ],
    secretAllow: [],
  });
  return { handle, artifactId, capture, retention, preparedTransitionId };
}

it('settles an admitted imported artifact with unbound execution and exact ref bindings', async () => {
  const f = await fixture();
  await beginProjectImportedArtifactRetention(f.handle, {
    capture: f.capture,
    retention: f.retention,
  });
  expect(readProjectArtifact(f.handle, f.artifactId)).toBeNull();
  expect(readProjectPendingCapture(f.handle, f.capture.operationId).value?.mode).toBe('import');
  const selected = await settleProjectImportedArtifactRetention(f.handle, {
    originalOperationId: f.capture.operationId,
    expectedTransitionId: f.preparedTransitionId,
    selectedTransitionId: uuidv7(),
  });
  expect(selected.value.state).toBe('selected');
  expect(readProjectArtifact(f.handle, f.artifactId)?.thread.summary?.outcome).toBe(
    'Imported work'
  );
  expect(readProjectExecution(f.handle, f.artifactId)?.state).toMatchObject({
    origin_kind: 'git-import',
    lifecycle: 'completed',
    current_binding: null,
    null_reason: 'completed',
  });
  expect(readProjectGitRetention(f.handle, f.capture.operationId).value?.current.kind).toBe(
    'selected'
  );
  expect(
    f.handle.read((view) =>
      view.all('SELECT publication_id FROM artifact_retention_selections ORDER BY publication_id')
    ).value
  ).toHaveLength(2);
});
