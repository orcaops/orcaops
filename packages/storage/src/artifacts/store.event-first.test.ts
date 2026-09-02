import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor } from './paths.js';
import { ArtifactStore } from './store.js';
import { appendEvent, readEventLog } from '../events/event-log.js';
import { loadEventsWithPayloads, rebuildCheckpointFromEvents } from '../events/rebuilders.js';
import { type Config, getDefaultConfig } from '../schema/config.js';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
} from '../schema/diff-fingerprint.js';
import type { SummaryInput } from '../schema/summary.js';

const passingPrePrReview = (headSha: string) => ({
  head_sha: headSha,
  outcome: 'passed' as const,
  evaluator_set_fingerprint: 'a'.repeat(64),
  review_context_fingerprint: 'b'.repeat(64),
  run_ids: [],
});

/**
 * Every mutating capture writes an event line BEFORE
 * the projection, the projection's `source_event_id` matches the latest
 * relevant event, `artifact.json` is maintained, and replay/conflict on
 * artifact-scoped idempotency keys behaves correctly.
 */
describe('ArtifactStore — event-first writes', () => {
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

  // ── plan ─────────────────────────────────────────────────────────

  describe('writePlan', () => {
    it('appends a plan_captured event line with payload + checksum', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(log.events).toHaveLength(1);
      expect(log.events[0].type).toBe('plan_captured');
      expect(log.events[0].idempotency_key).toBe('plan-init-1');
      expect(log.corrupt).toEqual([]);
    });

    it('returns the appended plan_captured event_id', async () => {
      const res = await writePlan('plan-init-ev');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(res.event_id).toBe(log.events[0].event_id);
    });

    it('writes plan.json with source_event_id pointing at the appended event', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const planJson = JSON.parse(await readFile(paths.planJson, 'utf8')) as {
        source_event_id?: string;
      };
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(planJson.source_event_id).toBe(log.events[0].event_id);
    });

    it('round-trips plan.md through the strict parser when non_goals and decisions are empty', async () => {
      await writePlan('plan-md-roundtrip');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const parsed = await ArtifactStore.parsePlanMarkdown(paths.planMd);
      expect(parsed.artifact_id).toBe(artifactId);
      expect(parsed.non_goals).toEqual([]);
      expect(parsed.decisions).toEqual([]);
    });

    it('writes artifact.json (state=planned, lineage=created, checkpoint_count=0)', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      expect(artifactJson).toMatchObject({
        schema_version: 1,
        id: artifactId,
        state: 'planned',
        checkpoint_count: 0,
      });
      expect(artifactJson.branch_lineage).toHaveLength(1);
      expect(artifactJson.branch_lineage[0].event).toBe('created');
    });

    it('a second writePlan under the same idempotency key replays instead of appending', async () => {
      const first = await writePlan('plan-idem-1');
      const second = await writePlan('plan-idem-1');
      // Initial capture is once-only, so a second plan_captured is never the
      // right answer — rebuildPlanFromEvents refuses the artifact outright.
      expect(second.event_id).toBe(first.event_id);

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(log.events.filter((e) => e.type === 'plan_captured')).toHaveLength(1);
    });

    it('a plan replay repairs a torn projection + cache from the durable event', async () => {
      const first = await writePlan('plan-idem-torn');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const lineageBefore = lineageRows();
      // The crash window: plan event durable, cache write never reached.
      await rm(paths.planJson);
      await rm(paths.planMd);
      await rm(paths.artifactJson);
      store.store.db.prepare('DELETE FROM artifacts WHERE id = ?').run(artifactId);
      store.store.db
        .prepare('DELETE FROM lineage_by_latest_sha WHERE artifact_id = ?')
        .run(artifactId);
      store.store.db.prepare('DELETE FROM lineage_branches WHERE artifact_id = ?').run(artifactId);
      expect(store.store.getArtifact(artifactId)).toBeNull();

      const healed = await writePlan('plan-idem-torn');
      expect(healed.event_id).toBe(first.event_id);
      expect(store.store.getArtifact(artifactId)).not.toBeNull();
      expect(store.store.getLatestPlanRevision(artifactId)?.steps.length).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(paths.artifactJson, 'utf8')).state).toBe('planned');
      await expect(readFile(paths.planJson, 'utf8')).resolves.toContain('"artifact_id"');
      // Lineage is the half of the cache a `latest_lineage_sha` lookup and the
      // gc scanner read; a repair that skips it drops the artifact from both.
      expect(lineageBefore.byLatestSha).toHaveLength(1);
      expect(lineageRows()).toEqual(lineageBefore);
    });
  });

  // ── source plan pin ──────────────────────────────────────────────

  describe('writePlan — source plan pin', () => {
    const pin = {
      source_ref: { kind: 'local' as const, locator: 'plans/rate-limit.md' },
      content: '# rate-limit slice\n\n- add middleware\n- structured non_goals\n',
      hash: 'a'.repeat(64),
      baseline: null,
    };

    it('projects the pinned source plan onto artifact.json (set-once at capture)', async () => {
      await store.writePlan(planInput(), { idempotencyKey: 'plan-src-1', sourcePlan: pin });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      expect(artifactJson.source_plan).toEqual({ ...pin, baseline: null });
    });

    it('does not leak the pin into the plan projection (non-strict PlanSchema drops it)', async () => {
      await store.writePlan(planInput(), { idempotencyKey: 'plan-src-2', sourcePlan: pin });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const planJson = JSON.parse(await readFile(paths.planJson, 'utf8'));
      expect(planJson).not.toHaveProperty('source_plan');
    });

    it('leaves source_plan null when no pin is supplied (opt-in no-op)', async () => {
      await writePlan('plan-src-3');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      expect(artifactJson.source_plan).toBeNull();
    });
  });

  // ── checkpoint ───────────────────────────────────────────────────

  describe('writeCheckpoint', () => {
    it('appends checkpoint_opened + checkpoint_closed events + bumps artifact.json to active', async () => {
      await writePlan('plan-init-1');
      const result = await writeCheckpoint('cp-1', { n: 1, summary: 'one' });
      expect(result.outcome).toBe('created');

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(log.events).toHaveLength(3);
      // plan + open + close events present.
      const cpEvents = log.events.filter(
        (e) => e.type === 'checkpoint_opened' || e.type === 'checkpoint_closed'
      );
      expect(cpEvents).toHaveLength(2);
      expect(cpEvents[0].type).toBe('checkpoint_opened');
      expect(cpEvents[1].type).toBe('checkpoint_closed');

      const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      expect(artifactJson.state).toBe('active');
      expect(artifactJson.checkpoint_count).toBe(1);

      const cpJson = JSON.parse(await readFile(paths.checkpointJson(1), 'utf8'));
      // The closed projection's source_event_id points at the close
      // event (the latest event folded into the projection).
      expect(cpJson.source_event_id).toBe(log.events[2].event_id);
    });

    it('returns outcome=replay on a second call with the same key + same intent', async () => {
      await writePlan('plan-init-1');
      const first = await writeCheckpoint('cp-replay-1', { n: 1, summary: 'one' });
      expect(first.outcome).toBe('created');

      const second = await writeCheckpoint('cp-replay-1', { n: 1, summary: 'one' });
      expect(second.outcome).toBe('replay');
      if (second.outcome !== 'replay') throw new Error('expected replay');
      if (second.checkpoint.status !== 'closed') throw new Error('expected closed');
      expect(second.checkpoint.summary).toBe('one');

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      // Replay does NOT append a second checkpoint event.
      expect(log.events.filter((e) => e.type === 'checkpoint_closed')).toHaveLength(1);
    });

    it('returns outcome=conflict on a second call with the same key + DIFFERENT intent', async () => {
      await writePlan('plan-init-1');
      const first = await writeCheckpoint('cp-conflict-1', { n: 1, summary: 'first' });
      expect(first.outcome).toBe('created');

      const second = await writeCheckpoint('cp-conflict-1', { n: 1, summary: 'CHANGED' });
      expect(second.outcome).toBe('conflict');
      if (second.outcome !== 'conflict') throw new Error('expected conflict');
      // Conflict does not carry priorEventId; the same-key
      // committed event is queryable via the event log directly.

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      // Conflict does NOT append a second checkpoint event.
      expect(log.events.filter((e) => e.type === 'checkpoint_closed')).toHaveLength(1);
    });

    it('counts cp.n=1 only once even with replay (artifact.json.checkpoint_count stays at 1)', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'one' });
      await writeCheckpoint('cp-1', { n: 1, summary: 'one' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      expect(artifactJson.checkpoint_count).toBe(1);
    });

    it('both readers of a committed open reject the same incomplete payload', async () => {
      const plan = await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      // Planted directly so the committed-replay reader in the store and the
      // projection rebuilder meet the identical event: one missing a
      // launch-required key must not replay through one and throw in the other.
      const openEvent = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-incomplete-open',
          payload: {
            artifact_id: artifactId,
            n: 1,
            declared_step_ids: [STEP_ID],
            plan_revision_id: null,
            open_plan_revision_event_id: plan.event_id,
            opened_at: '2026-04-26T12:00:00.000Z',
            head_sha: 'cafef00d',
            open_snapshot: buildDefaultSkippedSnapshotBoundary(),
          },
        },
        { eventLogPath: paths.eventsNdjson, sidecarsDir: paths.sidecarsDir }
      );

      const issuePaths = (err: unknown): string[] =>
        ((err as { issues?: { path: unknown[] }[] } | null)?.issues ?? []).map((i) =>
          i.path.join('.')
        );

      const loaded = await loadEventsWithPayloads([openEvent], {
        sidecarsDir: paths.sidecarsDir,
      });
      let rebuildError: unknown = null;
      try {
        rebuildCheckpointFromEvents(loaded, 1);
      } catch (err) {
        rebuildError = err;
      }
      expect(issuePaths(rebuildError)).toContain('policy_exceptions');

      const replayError = await store
        .writeCheckpointOpened(
          { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
          { idempotencyKey: 'cp-incomplete-open', headSha: 'cafef00d' }
        )
        .then(
          () => null,
          (err: unknown) => err
        );
      expect(issuePaths(replayError)).toContain('policy_exceptions');
    });

    it('a close replay repairs a torn checkpoint projection + cache row', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-torn-close', { n: 1, summary: 'closed once' });
      const paths = artifactPathsFor(repo.path, config, artifactId);

      // The crash window: checkpoint_closed durable, projection + cache row
      // never written, so the cached status still reads `open` — and
      // writeSummary's completion gate reads exactly that cache.
      await writeFile(
        paths.checkpointJson(1),
        JSON.stringify(
          { ...JSON.parse(await readFile(paths.checkpointJson(1), 'utf8')), status: 'open' },
          null,
          2
        ) + '\n'
      );
      // The row's CHECK constraint keeps an open checkpoint's close-only
      // fields empty, so roll the whole lifecycle back, not just the status.
      store.store.db
        .prepare(
          `UPDATE checkpoints SET status = 'open', closed_at = NULL, summary = NULL,
             files_changed = '[]', decisions = '[]', uncertainty = '[]',
             done_criteria = '[]', completed_step_ids = '[]'
           WHERE artifact_id = ? AND n = 1`
        )
        .run(artifactId);
      store.store.db
        .prepare("DELETE FROM search_idx WHERE artifact_id = ? AND source = 'checkpoint:1'")
        .run(artifactId);
      expect(store.store.getOpenCheckpoints(artifactId)).toHaveLength(1);

      const replayed = await writeCheckpoint('cp-torn-close', { n: 1, summary: 'closed once' });
      expect(replayed.outcome).toBe('replay');
      expect(store.store.getOpenCheckpoints(artifactId)).toHaveLength(0);
      expect(JSON.parse(await readFile(paths.checkpointJson(1), 'utf8')).status).toBe('closed');
      expect(store.store.hasSearchEntry(artifactId, 'checkpoint:1')).toBe(true);

      // The summary that the stale cached status would have refused.
      const summarized = await writeSummary('sum-after-repair', 'shipped');
      expect(summarized.outcome).toBe('created');
    });

    it('a close replay repairs a search entry lost after the cache row landed', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-torn-index', { n: 1, summary: 'indexed once' });
      // replaceSearchEntry is the LAST write of the close commit group, so a
      // crash can land with the row already closed and only the entry missing.
      // Gating the repair on the row alone reads that as a finished group.
      store.store.db
        .prepare("DELETE FROM search_idx WHERE artifact_id = ? AND source = 'checkpoint:1'")
        .run(artifactId);

      const replayed = await writeCheckpoint('cp-torn-index', { n: 1, summary: 'indexed once' });
      expect(replayed.outcome).toBe('replay');
      expect(store.store.hasSearchEntry(artifactId, 'checkpoint:1')).toBe(true);
      expect(store.store.search('indexed').map((r) => r.source)).toContain('checkpoint:1');
    });

    it('an abandon replay adds no search entry, matching its commit path', async () => {
      await writePlan('plan-init-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-abandon-open', headSha: 'cafef00d' }
      );
      const abandonInput = { artifact_id: artifactId, n: 1, reason: 'scope released' };
      await store.writeCheckpointAbandoned(abandonInput, { idempotencyKey: 'cp-abandon' });
      expect(store.store.hasSearchEntry(artifactId, 'checkpoint:1')).toBe(false);

      // Tear the row so the replay actually reaches the reprojection — an
      // untorn replay returns at the gate and would pass no matter what the
      // reprojection does.
      store.store.db
        .prepare(
          `UPDATE checkpoints SET status = 'open', abandoned_at = NULL, reason = NULL
           WHERE artifact_id = ? AND n = 1`
        )
        .run(artifactId);

      const replayed = await store.writeCheckpointAbandoned(abandonInput, {
        idempotencyKey: 'cp-abandon',
      });
      expect(replayed.outcome).toBe('replay');
      expect(store.store.getCheckpoints(artifactId)[0].status).toBe('abandoned');
      expect(store.store.hasSearchEntry(artifactId, 'checkpoint:1')).toBe(false);
    });

    it('an ordinary close replay leaves the checkpoint projection untouched', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-inert-close', { n: 1, summary: 'closed once' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const before = await stat(paths.checkpointJson(1));

      const replayed = await writeCheckpoint('cp-inert-close', { n: 1, summary: 'closed once' });
      expect(replayed.outcome).toBe('replay');
      expect((await stat(paths.checkpointJson(1))).mtimeMs).toBe(before.mtimeMs);
    });

    // ── default replay extractor (asymmetric default-payload regression) ──
    it('storage-direct close replay with no replayPayload + no extractor returns replay (not conflict)', async () => {
      await writePlan('plan-init-1');
      // First call uses the defaults — neither replayPayload nor
      // extractReplayShape is supplied. The persisted close event
      // includes `head_sha` + `ts`; the default extractor must strip
      // them so canonicalJson hashes match on the second call.
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-defaults-open', headSha: 'cafef00d' }
      );
      const closeInput = {
        artifact_id: artifactId,
        n: 1,
        summary: 'close with defaults',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_ID],
        head_sha: 'cafef00d',
      };
      const first = await store.writeCheckpointClosed(closeInput, {
        idempotencyKey: 'cp-defaults-close',
      });
      expect(first.outcome).toBe('created');
      const second = await store.writeCheckpointClosed(closeInput, {
        idempotencyKey: 'cp-defaults-close',
      });
      expect(second.outcome).toBe('replay');
    });

    it('storage-direct abandon replay with no replayPayload + no extractor returns replay', async () => {
      await writePlan('plan-init-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-abandon-defaults-open', headSha: 'cafef00d' }
      );
      const abandonInput = {
        artifact_id: artifactId,
        n: 1,
        reason: 'subagent timed out',
      };
      const first = await store.writeCheckpointAbandoned(abandonInput, {
        idempotencyKey: 'cp-abandon-defaults',
      });
      expect(first.outcome).toBe('created');
      const second = await store.writeCheckpointAbandoned(abandonInput, {
        idempotencyKey: 'cp-abandon-defaults',
      });
      expect(second.outcome).toBe('replay');
    });

    // ── snapshot + fingerprint callbacks ───────────────────────────

    it('open without callbacks produces deliberate-skip open_snapshot (error_reason: null)', async () => {
      await writePlan('plan-cb-skip-1');
      const result = await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-cb-skip-open', headSha: 'cafef00d' }
      );
      if (result.outcome !== 'created') throw new Error('expected created');
      expect(result.checkpoint.open_snapshot).toEqual({
        snapshot_ref: null,
        tree_sha: null,
        snapshot_commit_sha: null,
        snapshot_error_reason: null,
      });
    });

    it('open with stub callback round-trips the boundary onto the projection', async () => {
      await writePlan('plan-cb-stub-1');
      const stubBoundary = {
        snapshot_ref: 'refs/orcaops/snap/abc/1/open',
        tree_sha: '0123456789abcdef0123456789abcdef01234567',
        snapshot_commit_sha: 'fedcba9876543210fedcba9876543210fedcba98',
        snapshot_error_reason: null,
      };
      const result = await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        {
          idempotencyKey: 'cp-cb-stub-open',
          headSha: 'cafef00d',
          snapshotCallbacks: {
            captureOpenSnapshot: async () => ({ boundary: stubBoundary }),
          },
        }
      );
      if (result.outcome !== 'created') throw new Error('expected created');
      expect(result.checkpoint.open_snapshot).toEqual(stubBoundary);
    });

    it('open with callback that throws produces unknown error_reason (defense-in-depth)', async () => {
      await writePlan('plan-cb-throw-1');
      const result = await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        {
          idempotencyKey: 'cp-cb-throw-open',
          headSha: 'cafef00d',
          snapshotCallbacks: {
            captureOpenSnapshot: async () => {
              throw new Error('intentional callback failure');
            },
          },
        }
      );
      if (result.outcome !== 'created') throw new Error('expected created');
      expect(result.checkpoint.open_snapshot.snapshot_error_reason).toBe('unknown');
      // Distinct from the absent-callback case (null error_reason).
      expect(result.checkpoint.open_snapshot.tree_sha).toBeNull();
    });

    it('close with stub callback round-trips boundary + summary + manifest onto the projection', async () => {
      await writePlan('plan-cb-close-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-cb-close-open', headSha: 'cafef00d' }
      );
      const stubBoundary = {
        snapshot_ref: 'refs/orcaops/snap/abc/1/close',
        tree_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        snapshot_commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        snapshot_error_reason: null,
      };
      const stubSummary = {
        status: 'captured' as const,
        hunk_count: 3,
        captured_hunk_count: 3,
        truncated: false,
        fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2' as const,
        manifest_hash: 'aabbccddeeff00112233445566778899',
        manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1' as const,
        error_reason: null,
      };
      const result = await store.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: 1,
          summary: 'with callback',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'pnpm test', exit_code: 0 }],
          completed_step_ids: [STEP_ID],
          head_sha: 'cafef00d',
        },
        {
          idempotencyKey: 'cp-cb-close',
          snapshotCallbacks: {
            captureCloseFingerprint: async () => ({
              boundary: stubBoundary,
              summary: stubSummary,
              manifest: null,
            }),
          },
        }
      );
      if (result.outcome !== 'created') throw new Error('expected created');
      expect(result.checkpoint.close_snapshot).toEqual(stubBoundary);
      expect(result.checkpoint.diff_fingerprint_summary).toEqual(stubSummary);
    });

    it('committed-replay close: callback NOT invoked even with different output', async () => {
      await writePlan('plan-cb-replay-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-cb-replay-open', headSha: 'cafef00d' }
      );
      const closeInput = {
        artifact_id: artifactId,
        n: 1,
        summary: 'identical',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_ID],
        head_sha: 'cafef00d',
      };
      let callbackInvocations = 0;
      const firstCloseSummary = {
        status: 'captured' as const,
        hunk_count: 1,
        captured_hunk_count: 1,
        truncated: false,
        fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2' as const,
        manifest_hash: 'first-manifest-hash',
        manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1' as const,
        error_reason: null,
      };
      const first = await store.writeCheckpointClosed(closeInput, {
        idempotencyKey: 'cp-cb-replay-close',
        snapshotCallbacks: {
          captureCloseFingerprint: async () => {
            callbackInvocations += 1;
            return {
              boundary: buildDefaultSkippedSnapshotBoundary(),
              summary: firstCloseSummary,
              manifest: null,
            };
          },
        },
      });
      if (first.outcome !== 'created') throw new Error('expected created');
      expect(callbackInvocations).toBe(1);
      // Same intent + same idempotency key + DIFFERENT callback output.
      const second = await store.writeCheckpointClosed(closeInput, {
        idempotencyKey: 'cp-cb-replay-close',
        snapshotCallbacks: {
          captureCloseFingerprint: async () => {
            callbackInvocations += 1;
            return {
              boundary: buildDefaultSkippedSnapshotBoundary(),
              summary: { ...firstCloseSummary, manifest_hash: 'DIFFERENT' },
              manifest: null,
            };
          },
        },
      });
      expect(second.outcome).toBe('replay');
      // Replay extractors strip runtime-derived fields, so the second
      // call's "different manifest_hash" doesn't trigger conflict; the
      // committed prior payload is returned unchanged. Callback is not
      // invoked on the replay path.
      expect(callbackInvocations).toBe(1);
    });

    it('real intent conflict: callback NOT reached when summaries differ on the same key', async () => {
      await writePlan('plan-cb-conflict-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-cb-conflict-open', headSha: 'cafef00d' }
      );
      const baseInput = {
        artifact_id: artifactId,
        n: 1,
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_ID],
        head_sha: 'cafef00d',
      };
      let callbackInvocations = 0;
      const opts = {
        snapshotCallbacks: {
          captureCloseFingerprint: async () => {
            callbackInvocations += 1;
            return {
              boundary: buildDefaultSkippedSnapshotBoundary(),
              summary: buildDefaultSkippedFingerprintSummary(),
              manifest: null,
            };
          },
        },
      };
      const first = await store.writeCheckpointClosed(
        { ...baseInput, summary: 'first' },
        { idempotencyKey: 'cp-cb-conflict-close', ...opts }
      );
      expect(first.outcome).toBe('created');
      expect(callbackInvocations).toBe(1);
      // Same key, DIFFERENT summary (intent change).
      const second = await store.writeCheckpointClosed(
        { ...baseInput, summary: 'CHANGED' },
        { idempotencyKey: 'cp-cb-conflict-close', ...opts }
      );
      expect(second.outcome).toBe('conflict');
      // Conflict fires before the callback insertion point.
      expect(callbackInvocations).toBe(1);
    });
  });

  // ── summary ──────────────────────────────────────────────────────

  describe('invoking-agent attribution (runtime provenance on write options)', () => {
    it('stamps open/close attribution from opts.invokedByAgent onto payloads + projection', async () => {
      await writePlan('plan-init-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-attr-open', headSha: 'cafef00d', invokedByAgent: 'claude-code' }
      );
      const result = await store.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: 1,
          summary: 'closed by another agent',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'pnpm test', exit_code: 0 }],
          completed_step_ids: [STEP_ID],
          head_sha: 'cafef00d',
        },
        { idempotencyKey: 'cp-attr-close', invokedByAgent: 'codex' }
      );
      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('expected created');
      expect(result.checkpoint.agent).toBe('claude-code');
      expect(result.checkpoint.closed_by_agent).toBe('codex');

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      const open = log.events.find((e) => e.type === 'checkpoint_opened');
      const close = log.events.find((e) => e.type === 'checkpoint_closed');
      const openPayload = open && 'payload' in open ? open.payload : undefined;
      const closePayload = close && 'payload' in close ? close.payload : undefined;
      expect((openPayload as { agent?: string }).agent).toBe('claude-code');
      expect((closePayload as { closed_by_agent?: string }).closed_by_agent).toBe('codex');
    });

    it('replays (never conflicts) when the same key retries from a DIFFERENT agent', async () => {
      await writePlan('plan-init-1');
      const openInput = { artifact_id: artifactId, declared_step_ids: [STEP_ID] };
      const first = await store.writeCheckpointOpened(openInput, {
        idempotencyKey: 'cp-cross-agent-retry',
        headSha: 'cafef00d',
        invokedByAgent: 'claude-code',
      });
      expect(first.outcome).toBe('created');
      const second = await store.writeCheckpointOpened(openInput, {
        idempotencyKey: 'cp-cross-agent-retry',
        headSha: 'cafef00d',
        invokedByAgent: 'cursor',
      });
      // Attribution is provenance, not intent: same intent from another
      // shell/agent must replay, and the ORIGINAL attribution wins.
      expect(second.outcome).toBe('replay');
      if (second.outcome !== 'replay') throw new Error('expected replay');
      expect(second.checkpoint.agent).toBe('claude-code');
    });

    it('stamps abandoned_by_agent on abandon', async () => {
      await writePlan('plan-init-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-attr-abandon-open', headSha: 'cafef00d', invokedByAgent: 'codex' }
      );
      const result = await store.writeCheckpointAbandoned(
        { artifact_id: artifactId, n: 1, reason: 'handed off' },
        { idempotencyKey: 'cp-attr-abandon', invokedByAgent: 'opencode' }
      );
      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('expected created');
      expect(result.checkpoint.agent).toBe('codex');
      expect(result.checkpoint.abandoned_by_agent).toBe('opencode');
    });

    it('attributes storage-direct open and close callers to other', async () => {
      await writePlan('plan-init-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-no-attr-open', headSha: 'cafef00d' }
      );
      const result = await store.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: 1,
          summary: 'closed without a runtime agent',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'pnpm test', exit_code: 0 }],
          completed_step_ids: [STEP_ID],
          head_sha: 'cafef00d',
        },
        { idempotencyKey: 'cp-no-attr-close' }
      );
      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('expected created');
      expect(result.checkpoint.agent).toBe('other');
      expect(result.checkpoint.closed_by_agent).toBe('other');
      expect(result.checkpoint.agent_session_id).toBeUndefined();

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      const open = log.events.find((e) => e.type === 'checkpoint_opened');
      const close = log.events.find((e) => e.type === 'checkpoint_closed');
      const openPayload = open && 'payload' in open ? open.payload : undefined;
      const closePayload = close && 'payload' in close ? close.payload : undefined;
      expect((openPayload as { agent: string }).agent).toBe('other');
      expect((closePayload as { closed_by_agent: string }).closed_by_agent).toBe('other');
      const cpJson = JSON.parse(await readFile(paths.checkpointJson(1), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(cpJson.agent).toBe('other');
      expect(cpJson.closed_by_agent).toBe('other');
      expect(cpJson.agent_session_id).toBeUndefined();
    });

    it('attributes storage-direct abandon callers to other', async () => {
      await writePlan('plan-init-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp-no-attr-abandon-open', headSha: 'cafef00d' }
      );
      const result = await store.writeCheckpointAbandoned(
        { artifact_id: artifactId, n: 1, reason: 'stopped' },
        { idempotencyKey: 'cp-no-attr-abandon' }
      );
      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('expected created');
      expect(result.checkpoint.agent).toBe('other');
      expect(result.checkpoint.abandoned_by_agent).toBe('other');
      expect(result.checkpoint.head_sha).toBe('cafef00d');
      expect(result.checkpoint.agent_session_id).toBeUndefined();

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      const abandon = log.events.find((e) => e.type === 'checkpoint_abandoned');
      const abandonPayload = abandon && 'payload' in abandon ? abandon.payload : undefined;
      expect(
        (abandonPayload as { abandoned_by_agent: string; head_sha: string }).abandoned_by_agent
      ).toBe('other');
      expect((abandonPayload as { head_sha: string }).head_sha).toBe('cafef00d');
    });

    it('stamps revised_by_agent on plan revise from opts.invokedByAgent (null when absent)', async () => {
      await writePlan('plan-init-1');
      const revised = await store.revisePlan(
        {
          idempotency_key: 'revise-attr-1',
          artifact_id: artifactId,
          label: 'do-thing-r1',
          plan_steps: [
            {
              step_id: STEP_ID,
              text: 'step 1',
              label: 's1',
              acceptance_criteria: [],
            },
            { text: 'step 2', label: 's2', acceptance_criteria: [] },
          ],
          rationale: 'scope grew',
          prior_plan_event_id: null,
          touched_scope: [],
          non_goals: [],
          decisions: [],
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
        },
        { idempotencyKey: 'revise-attr-1', invokedByAgent: 'github-copilot' }
      );
      expect(revised.outcome).toBe('created');
      if (revised.outcome !== 'created') throw new Error('expected created');
      expect(revised.plan.revised_by_agent).toBe('github-copilot');
      // The authoring agent is untouched by revise attribution.
      expect(revised.plan.agent).toBe('claude-code');

      const again = await store.revisePlan(
        {
          idempotency_key: 'revise-attr-2',
          artifact_id: artifactId,
          label: 'do-thing-r2',
          plan_steps: [{ step_id: STEP_ID, text: 'step 1', label: 's1', acceptance_criteria: [] }],
          rationale: 'trimmed back',
          prior_plan_event_id: null,
          touched_scope: [],
          non_goals: [],
          decisions: [],
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
        },
        { idempotencyKey: 'revise-attr-2' }
      );
      expect(again.outcome).toBe('created');
      if (again.outcome !== 'created') throw new Error('expected created');
      // Storage-direct revise without attribution: null, never carried
      // from the prior revision.
      expect(again.plan.revised_by_agent).toBeNull();
    });

    it('carries git-import origin through plan revision and artifact projection rebuilds', async () => {
      const origin = {
        kind: 'git-import' as const,
        imported_at: '2026-04-26T13:00:00.000Z',
        tool_version: '0.0.5',
        source_range: 'main~1..main',
        authors: ['dev@example.com'],
        enriched_at: null,
      };
      await store.writePlan({ ...planInput(), origin }, { idempotencyKey: 'plan-origin' });
      const revised = await store.revisePlan(
        {
          idempotency_key: 'revise-origin',
          artifact_id: artifactId,
          label: 'do-thing-imported',
          plan_steps: [{ step_id: STEP_ID, text: 'step 1', label: 's1', acceptance_criteria: [] }],
          rationale: 'sharpen label',
          prior_plan_event_id: null,
          touched_scope: [],
          non_goals: [],
          decisions: [],
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
        },
        { idempotencyKey: 'revise-origin' }
      );
      expect(revised.outcome).toBe('created');
      if (revised.outcome !== 'created') throw new Error('expected created');
      expect(revised.plan.origin).toEqual(origin);
      expect((await store.readArtifact(artifactId))?.origin).toEqual(origin);
      expect(store.store.getArtifact(artifactId)?.origin_kind).toBe('git-import');
    });
  });

  describe('backdated checkpoint timestamps', () => {
    it('persists caller-supplied open and close timestamps', async () => {
      await writePlan('plan-backdated');
      const openedAt = '2020-01-02T03:04:05.000Z';
      const open = await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'open-backdated', headSha: 'cafef00d', openedAt }
      );
      expect(open.outcome).toBe('created');
      if (open.outcome !== 'created') throw new Error('expected created');
      expect(open.checkpoint.opened_at).toBe(openedAt);

      const close = await store.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: 1,
          summary: 'historic work',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'pnpm test', exit_code: 0 }],
          completed_step_ids: [STEP_ID],
          head_sha: 'cafef00d',
        },
        {
          idempotencyKey: 'close-backdated',
          closedAt: openedAt,
          skipWallClockOverlapScan: true,
        }
      );
      expect(close.outcome).toBe('created');
      if (close.outcome !== 'created') throw new Error('expected created');
      expect(close.checkpoint.closed_at).toBe(openedAt);
      expect('window_overlap' in close.checkpoint).toBe(false);
    });

    it('rejects malformed or backwards timestamps before appending the event', async () => {
      await writePlan('plan-invalid-time');
      await expect(
        store.writeCheckpointOpened(
          { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
          { idempotencyKey: 'open-invalid-time', headSha: 'cafef00d', openedAt: 'yesterday' }
        )
      ).rejects.toThrow();

      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        {
          idempotencyKey: 'open-valid-time',
          headSha: 'cafef00d',
          openedAt: '2020-01-02T03:04:05.000Z',
        }
      );
      await expect(
        store.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: 1,
            summary: 'historic work',
            files_changed: [],
            decisions: [],
            uncertainty: [],
            done_criteria: [],
            verification: [{ command: 'pnpm test', exit_code: 0 }],
            completed_step_ids: [STEP_ID],
            head_sha: 'cafef00d',
          },
          { idempotencyKey: 'close-backwards', closedAt: '2020-01-02T03:04:04.000Z' }
        )
      ).rejects.toThrow(/precedes its open timestamp/);
      expect((await store.readCheckpoint(artifactId, 1))?.status).toBe('open');
    });
  });

  describe('writeSummary', () => {
    it('persists an exact complete warning acceptance', async () => {
      await writePlan('plan-warning-acceptance');
      const review = await writeWarningReview(['run-warning-a', 'run-warning-b']);
      const accepted_warnings = review.runIds.map((runId, index) => ({
        review_id: review.reviewId,
        run_id: runId,
        evaluator_ref: `test/warning-${index}`,
        reason: `reviewed warning ${index}`,
      }));
      const result = await store.writeSummary(
        summaryInput({ accepted_warnings: [...accepted_warnings].reverse() }),
        {
          idempotencyKey: 'summary-with-accepted-warnings',
        }
      );
      expect(result.outcome).toBe('created');
      expect(result.summary.accepted_warnings).toEqual(accepted_warnings);
      const replay = await store.writeSummary(summaryInput({ accepted_warnings }), {
        idempotencyKey: 'summary-with-accepted-warnings',
      });
      expect(replay.outcome).toBe('replay');
    });

    it('rejects partial and cross-attempt warning acceptance', async () => {
      await writePlan('plan-stale-warning-acceptance');
      const first = await writeWarningReview(['run-warning-a', 'run-warning-b']);
      await expect(
        store.writeSummary(
          summaryInput({
            accepted_warnings: [
              {
                review_id: first.reviewId,
                run_id: first.runIds[0]!,
                evaluator_ref: 'test/warning-0',
                reason: 'only one warning reviewed',
              },
            ],
          }),
          { idempotencyKey: 'partial-warning-acceptance' }
        )
      ).rejects.toMatchObject({ code: 'WARNING_ACCEPTANCE_INVALID' });

      await writeWarningReview(['run-warning-current']);
      await expect(
        store.writeSummary(
          summaryInput({
            accepted_warnings: first.runIds.map((runId, index) => ({
              review_id: first.reviewId,
              run_id: runId,
              evaluator_ref: `test/warning-${index}`,
              reason: 'reviewed before a newer attempt',
            })),
          }),
          { idempotencyKey: 'stale-warning-acceptance' }
        )
      ).rejects.toMatchObject({ code: 'WARNING_ACCEPTANCE_INVALID' });
    });

    it('treats a changed accepted-warning set as an idempotency conflict', async () => {
      await writePlan('plan-warning-replay');
      const review = await writeWarningReview(['run-warning-a']);
      const accepted = {
        review_id: review.reviewId,
        run_id: review.runIds[0]!,
        evaluator_ref: 'test/warning-0',
        reason: 'reviewed and accepted',
      };
      const first = await store.writeSummary(summaryInput({ accepted_warnings: [accepted] }), {
        idempotencyKey: 'warning-replay-key',
      });
      expect(first.outcome).toBe('created');
      const changed = await store.writeSummary(
        summaryInput({ accepted_warnings: [{ ...accepted, reason: 'different reason' }] }),
        { idempotencyKey: 'warning-replay-key' }
      );
      expect(changed.outcome).toBe('conflict');
    });

    it('does not allow acceptance of a warning evaluator error', async () => {
      await writePlan('plan-warning-error');
      await store.writeEvaluatorRunPayload(
        artifactId,
        {
          schema: 'orcaops.evaluator_run/v1',
          run_id: 'run-warning-error',
          artifact_id: artifactId,
          evaluator_ref: 'test/warning-error',
          package_id: 'test',
          evaluator_id: 'warning-error',
          phase: 'pre-pr',
          severity: 'warn',
          run_status: 'error',
          verdict: null,
          body: 'ERROR (TIMEOUT)',
          error: { code: 'TIMEOUT', message: 'review timed out' },
          ts: '2026-04-26T12:55:00.000Z',
        },
        { idempotencyKey: 'record-warning-error' }
      );
      const review = await store.writePrePrChecked(artifactId, {
        head_sha: 'def456',
        outcome: 'needs_attention',
        evaluator_set_fingerprint: 'a'.repeat(64),
        review_context_fingerprint: 'b'.repeat(64),
        run_ids: ['run-warning-error'],
      });
      await expect(
        store.writeSummary(
          summaryInput({
            accepted_warnings: [
              {
                review_id: review.event_id,
                run_id: 'run-warning-error',
                evaluator_ref: 'test/warning-error',
                reason: 'try to accept infrastructure failure',
              },
            ],
          }),
          { idempotencyKey: 'accept-warning-error' }
        )
      ).rejects.toMatchObject({ code: 'WARNING_ACCEPTANCE_INVALID' });
    });

    it('appends summary_captured + flips artifact.json.state to summarized', async () => {
      await writePlan('plan-init-1');
      const result = await writeSummary('sum-1', 'shipped');
      expect(result.outcome).toBe('created');

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(log.events.find((e) => e.type === 'summary_captured')).toBeDefined();

      const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      expect(artifactJson.state).toBe('summarized');

      const sumJson = JSON.parse(await readFile(paths.summaryJson, 'utf8'));
      expect(sumJson.outcome).toBe('shipped');
    });

    it('replay returns prior summary; no second summary_captured event', async () => {
      await writePlan('plan-init-1');
      const first = await writeSummary('sum-1', 'shipped');
      expect(first.outcome).toBe('created');

      const second = await writeSummary('sum-1', 'shipped');
      expect(second.outcome).toBe('replay');

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(log.events.filter((e) => e.type === 'summary_captured')).toHaveLength(1);
    });

    // ── default replay shape (asymmetric default-payload regression) ──
    // Without a default shape, `payload: undefined` reaches canonicalJson.
    it('storage-direct summary replay with no replayPayload + no extractor returns replay', async () => {
      await writePlan('plan-init-1');
      const summaryInput = {
        schema_version: 1 as const,
        artifact_id: artifactId,
        outcome: 'shipped with defaults',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'def456',
        ts: '2026-04-26T13:00:00.000Z',
      };
      const first = await store.writeSummary(summaryInput, { idempotencyKey: 'sum-defaults' });
      expect(first.outcome).toBe('created');

      const second = await store.writeSummary(summaryInput, { idempotencyKey: 'sum-defaults' });
      expect(second.outcome).toBe('replay');
    });

    it('a summary replay repairs a torn projection + cache from the durable event', async () => {
      await writePlan('plan-init-1');
      const summaryInput = {
        schema_version: 1 as const,
        artifact_id: artifactId,
        outcome: 'shipped before the tear',
        tests_written: [],
        tests_run: [],
        open_items: ['follow up on the retry path'],
        deferred_decisions: [],
        head_sha: 'def456',
        ts: '2026-04-26T13:00:00.000Z',
      };
      await store.writeSummary(summaryInput, { idempotencyKey: 'sum-torn' });

      const paths = artifactPathsFor(repo.path, config, artifactId);
      await tearSummaryCommitGroup(paths);
      expect(store.store.getSummary(artifactId)).toBeNull();

      const healed = await store.writeSummary(summaryInput, { idempotencyKey: 'sum-torn' });
      expect(healed.outcome).toBe('replay');

      const cached = store.store.getSummary(artifactId);
      expect(cached?.outcome).toBe('shipped before the tear');
      expect(store.store.getArtifact(artifactId)?.status).toBe('complete');
      const sumJson = JSON.parse(await readFile(paths.summaryJson, 'utf8'));
      expect(sumJson.outcome).toBe('shipped before the tear');
      expect(JSON.parse(await readFile(paths.artifactJson, 'utf8')).state).toBe('summarized');
      await expect(readFile(paths.summaryMd, 'utf8')).resolves.toContain('shipped before the tear');
    });

    it('an ordinary summary replay leaves the projection files untouched', async () => {
      await writePlan('plan-init-1');
      const summaryInput = {
        schema_version: 1 as const,
        artifact_id: artifactId,
        outcome: 'shipped',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'def456',
        ts: '2026-04-26T13:00:00.000Z',
      };
      await store.writeSummary(summaryInput, { idempotencyKey: 'sum-inert' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const before = await stat(paths.summaryJson);
      // A sentinel the reprojection would overwrite, in a column no tear
      // witness reads — so it survives an inert replay and only an inert one.
      store.store.db
        .prepare("UPDATE summaries SET outcome = 'sentinel' WHERE artifact_id = ?")
        .run(artifactId);

      const replayed = await store.writeSummary(summaryInput, { idempotencyKey: 'sum-inert' });
      expect(replayed.outcome).toBe('replay');
      expect((await stat(paths.summaryJson)).mtimeMs).toBe(before.mtimeMs);
      expect(store.store.getSummary(artifactId)?.outcome).toBe('sentinel');
    });

    it('a summary replay repairs a search entry lost after the cache row landed', async () => {
      await writePlan('plan-init-1');
      const summaryInput = {
        schema_version: 1 as const,
        artifact_id: artifactId,
        outcome: 'shipped with the index torn off',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'def456',
        ts: '2026-04-26T13:00:00.000Z',
      };
      await store.writeSummary(summaryInput, { idempotencyKey: 'sum-torn-index' });
      // The summary row and both files are intact — only the index write,
      // last in the commit group, never landed.
      store.store.db
        .prepare("DELETE FROM search_idx WHERE artifact_id = ? AND source = 'summary'")
        .run(artifactId);

      const healed = await store.writeSummary(summaryInput, { idempotencyKey: 'sum-torn-index' });
      expect(healed.outcome).toBe('replay');
      expect(store.store.hasSearchEntry(artifactId, 'summary')).toBe(true);
      expect(store.store.search('torn').map((r) => r.source)).toContain('summary');
    });

    it('a repairing replay takes the durable event over a disagreeing retry input', async () => {
      await writePlan('plan-init-1');
      const shared = {
        schema_version: 1 as const,
        artifact_id: artifactId,
        outcome: 'shipped',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
      };
      await store.writeSummary(
        { ...shared, head_sha: 'def456', ts: '2026-04-26T13:00:00.000Z' },
        { idempotencyKey: 'sum-authority' }
      );
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await tearSummaryCommitGroup(paths);

      // Same replay-shape fields, different runtime-derived ones: the retry
      // must not be able to rewrite when the summary happened.
      const healed = await store.writeSummary(
        { ...shared, head_sha: 'aaaa111', ts: '2027-01-01T00:00:00.000Z' },
        { idempotencyKey: 'sum-authority' }
      );
      expect(healed.outcome).toBe('replay');
      expect(healed.summary.ts).toBe('2026-04-26T13:00:00.000Z');
      expect(store.store.getSummary(artifactId)?.ts).toBe('2026-04-26T13:00:00.000Z');
      expect(JSON.parse(await readFile(paths.summaryJson, 'utf8')).head_sha).toBe('def456');
    });
  });

  // ── evaluator run + disposition writers ──────────────────────────

  describe('writeEvaluatorRunPayload', () => {
    it('appends an evaluator_run_recorded event and rebuilds the V2 projection', async () => {
      await writePlan('plan-init-1');
      const result = await store.writeEvaluatorRunPayload(
        artifactId,
        makeRunPayload({ run_id: 'run-1' }),
        { idempotencyKey: 'ev-run-1' }
      );
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const log = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(log.events.filter((e) => e.type === 'evaluator_run_recorded')).toHaveLength(1);
      expect(result.outcome).toBe('created');
      expect(result.log.runs).toHaveLength(1);
      expect(result.log.runs[0].run_id).toBe('run-1');
      expect(result.log.runs[0].disposition).toBe('unresolved');
    });

    it('mirrors the materialized run into SQLite with the correct disposition + order_key', async () => {
      await writePlan('plan-init-1');
      await store.writeEvaluatorRunPayload(artifactId, makeRunPayload({ run_id: 'run-1' }), {
        idempotencyKey: 'ev-run-1',
      });
      const rows = store.store.listEvaluatorRuns(artifactId);
      expect(rows).toHaveLength(1);
      expect(rows[0].run_id).toBe('run-1');
      expect(rows[0].disposition).toBe('unresolved');
      expect(rows[0].source_event_index).toBeGreaterThanOrEqual(0);
      expect(rows[0].local_kind_rank).toBe(0);
    });

    it('a passing run leaves disposition=null in both projection and SQLite', async () => {
      await writePlan('plan-init-1');
      const passing = makeRunPayload({
        run_id: 'run-pass',
        verdict: 'pass',
        body: 'PASS',
      });
      await store.writeEvaluatorRunPayload(artifactId, passing, { idempotencyKey: 'ev-pass-1' });
      const log = await store.readEvaluatorLog(artifactId);
      expect(log!.runs[0].disposition).toBeNull();
      const rows = store.store.listEvaluatorRuns(artifactId);
      expect(rows[0].disposition).toBeNull();
    });

    it('the rebuilt artifact.json moves to state=blocked', async () => {
      await writePlan('plan-init-1');
      await store.writeEvaluatorRunPayload(artifactId, makeRunPayload({ run_id: 'run-1' }), {
        idempotencyKey: 'ev-run-1',
      });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const json = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      expect(json.state).toBe('blocked');
    });

    it('a block-severity evaluator error prevents summary until a passing rerun', async () => {
      await writePlan('plan-init-error-block');
      await store.writeEvaluatorRunPayload(
        artifactId,
        {
          ...makeRunPayload({
            run_id: 'run-error',
            phase: 'pre-pr',
            run_status: 'error',
            verdict: null,
            body: '',
          }),
          error: { code: 'ENGINE_FAILED', message: 'runner unavailable' },
        },
        { idempotencyKey: 'ev-error' }
      );

      await expect(writeSummary('sum-blocked-by-error', 'done')).rejects.toMatchObject({
        code: 'BLOCKED',
        blockingEvaluators: ['core/api-stability'],
      });

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const beforeDisposition = await readFile(paths.eventsNdjson, 'utf8');
      await expect(
        store.writeEvaluatorDisposition(
          artifactId,
          makeDispositionPayload({ run_id: 'run-error' }),
          { idempotencyKey: 'cannot-disposition-error' }
        )
      ).rejects.toThrow(/Evaluator errors must be rerun successfully/);
      expect(await readFile(paths.eventsNdjson, 'utf8')).toBe(beforeDisposition);

      await store.writeEvaluatorRunPayload(
        artifactId,
        makeRunPayload({
          run_id: 'run-pass-after-error',
          phase: 'pre-pr',
          verdict: 'pass',
          body: 'PASS',
        }),
        { idempotencyKey: 'ev-pass-after-error' }
      );
      await expect(writeSummary('sum-after-error-cleared', 'done')).resolves.toMatchObject({
        outcome: 'created',
      });
    });
  });

  describe('writeEvaluatorDisposition', () => {
    it('appends an evaluator_disposition_recorded event and flips disposition to acknowledged', async () => {
      await writePlan('plan-init-1');
      await store.writeEvaluatorRunPayload(artifactId, makeRunPayload({ run_id: 'run-1' }), {
        idempotencyKey: 'ev-run-1',
      });
      await store.writeEvaluatorDisposition(
        artifactId,
        makeDispositionPayload({ run_id: 'run-1', disposition: 'acknowledged' }),
        { idempotencyKey: 'ev-dis-1' }
      );

      const paths = artifactPathsFor(repo.path, config, artifactId);
      const evLog = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      expect(evLog.events.filter((e) => e.type === 'evaluator_disposition_recorded')).toHaveLength(
        1
      );

      const log = await store.readEvaluatorLog(artifactId);
      expect(log!.runs[0].disposition).toBe('acknowledged');
      expect(log!.dispositions).toHaveLength(1);

      // Atomic disposition column update at the SQLite layer.
      const rows = store.store.listEvaluatorRuns(artifactId);
      expect(rows[0].disposition).toBe('acknowledged');
    });

    it('artifact.json transitions back to non-blocked once the violation is acknowledged', async () => {
      await writePlan('plan-init-1');
      await store.writeEvaluatorRunPayload(artifactId, makeRunPayload({ run_id: 'run-1' }), {
        idempotencyKey: 'ev-run-1',
      });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      let json = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      expect(json.state).toBe('blocked');

      await store.writeEvaluatorDisposition(
        artifactId,
        makeDispositionPayload({ run_id: 'run-1', disposition: 'acknowledged' }),
        { idempotencyKey: 'ev-dis-1' }
      );
      json = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
      expect(json.state).not.toBe('blocked');
    });
  });

  // ── recovery-on-read ─────────────────────────────────────────────

  describe('recovery-on-read', () => {
    it('serves a rebuilt plan without recreating a deleted projection', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      await fs.rm(paths.planJson);

      const recovered = await store.readPlan(artifactId);
      expect(recovered?.task).toBe('do the thing');
      await expect(stat(paths.planJson)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('serves a rebuilt checkpoint without recreating a deleted projection', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      await fs.rm(paths.checkpointJson(1));

      const recovered = await store.readCheckpoint(artifactId, 1);
      if (recovered?.status !== 'closed') throw new Error('expected closed');
      expect(recovered.summary).toBe('first');
      await expect(stat(paths.checkpointJson(1))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses to rebuild past a rotted close instead of serving a silent rollback', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_closed"');
      const fs = await import('node:fs/promises');
      await fs.rm(paths.checkpointJson(1));

      // The open event survives; rebuilding from it alone would serve the
      // checkpoint as still open — a silent rollback of the acknowledged
      // close. Recovery must refuse instead.
      await expect(store.readCheckpoint(artifactId, 1)).rejects.toThrow(/corrupt event-log line/);
    });

    it('refuses the plan read when its backing line rots — artifact-level, no projection trust', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await corruptEventLine(paths.eventsNdjson, '"plan_captured"');

      await expect(store.readPlan(artifactId)).rejects.toThrow(/corrupt event-log line/);
    });

    it('a rotted close refuses the plural read even when the projection survives (no trust)', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_closed"');

      // checkpoint-1.json survives and names the rotted close — the v1
      // contract refuses rather than trusting an unauthenticated
      // projection over lost history.
      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
    });

    it('plural read refuses loudly — with artifact id and next step — instead of listing a rotted close as open', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_closed"');
      const fs = await import('node:fs/promises');
      await fs.rm(paths.checkpointJson(1));

      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(
        new RegExp(`artifact ${artifactId} is unreadable[\\s\\S]*orcaops doctor`)
      );
    });

    it('refuses the checkpoint list when a fully lost checkpoint would be silently omitted', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_opened"');
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_closed"');
      const fs = await import('node:fs/promises');
      await fs.rm(paths.checkpointJson(1));

      // Every event of cp 1 is lost and its projection is gone: nothing
      // discovers n=1 — the artifact-level refusal covers it.
      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
    });

    it('rejects a tampered list where an open cp declares a step a closed cp claimed', async () => {
      const STEP_2 = '01HX0K8N6ZQF8M5R2V8DZ7T3ZZ';
      await store.writePlan(
        {
          ...planInput(),
          plan_steps: [
            ...planInput().plan_steps,
            { step_id: STEP_2, text: 'step 2', label: 's2', acceptance_criteria: [] },
          ],
        },
        { idempotencyKey: 'plan-init-1' }
      );
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' }); // closes STEP_ID
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_2] },
        { idempotencyKey: 'cp2-open', headSha: 'cafef00d' }
      );
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      const cp2 = JSON.parse(await fs.readFile(paths.checkpointJson(2), 'utf8')) as {
        declared_step_ids: string[];
      };
      cp2.declared_step_ids = [STEP_ID];
      await fs.writeFile(paths.checkpointJson(2), JSON.stringify(cp2, null, 2), 'utf8');

      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(
        /declared by open cp #2 but already claimed by closed cp #1/
      );
    });

    it('a rotted plan line refuses the checkpoint list too — the contract is artifact-level', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await corruptEventLine(paths.eventsNdjson, '"plan_captured"');

      // v1 makes NO cross-projection loss attribution: any non-tail
      // corruption anywhere makes the artifact unreadable. The
      // availability cost is a recorded owner decision.
      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
    });

    it('a closed checkpoint whose own OPEN rotted refuses — fail-closed, singular and plural agree', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_opened"');

      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
      await expect(store.readCheckpoint(artifactId, 1)).rejects.toThrow(/corrupt event-log line/);
    });

    it('a corrupt line reusing a surviving close id cannot hide an invisible checkpoint', async () => {
      const STEP_2 = '01HX0K8N6ZQF8M5R2V8DZ7T3ZZ';
      await store.writePlan(
        {
          ...planInput(),
          plan_steps: [
            ...planInput().plan_steps,
            { step_id: STEP_2, text: 'step 2', label: 's2', acceptance_criteria: [] },
          ],
        },
        { idempotencyKey: 'plan-init-1' }
      );
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_2] },
        { idempotencyKey: 'cp2-open', headSha: 'cafef00d' }
      );

      // Rot cp 2's open line and rewrite its id field to collide with cp
      // 1's surviving close id, then delete cp 2's projection: nothing
      // legitimate discovers n=2, and the spoofed id must not count as
      // attribution.
      const fs = await import('node:fs/promises');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const closeId = (
        JSON.parse(await fs.readFile(paths.checkpointJson(1), 'utf8')) as {
          source_event_id: string;
        }
      ).source_event_id;
      const lines = (await fs.readFile(paths.eventsNdjson, 'utf8')).split('\n');
      const i = lines.findIndex((l) => l.includes('"cp2-open"'));
      if (i === -1) throw new Error('cp2 open line not found');
      const rec = JSON.parse(lines[i]) as { event_id: string };
      rec.event_id = closeId;
      lines[i] = JSON.stringify(rec); // checksum now wrong: checksum_mismatch, id preserved
      await fs.writeFile(paths.eventsNdjson, lines.join('\n'), 'utf8');
      await fs.rm(paths.checkpointJson(2));

      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
    });

    it('serves past a garbled plan projection without overwriting the witness', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      await fs.writeFile(paths.planJson, '{definitely not json', 'utf8');

      const recovered = await store.readPlan(artifactId);
      expect(recovered?.task).toBe('do the thing');
      expect(await fs.readFile(paths.planJson, 'utf8')).toBe('{definitely not json');
    });

    it('rebuilds a strict-rejected projection from the intact event log instead of surfacing a ZodError', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      const onDisk = JSON.parse(await fs.readFile(paths.planJson, 'utf8')) as Record<
        string,
        unknown
      >;
      delete onDisk.task; // strict PlanSchema now rejects this file
      await fs.writeFile(paths.planJson, JSON.stringify(onDisk, null, 2), 'utf8');

      const recovered = await store.readPlan(artifactId);
      expect(recovered?.task).toBe('do the thing');
    });

    it('refuses to roll a plan back to a checksum-valid duplicate of its event', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      const { createHash } = await import('node:crypto');
      const { canonicalJson } = await import('../events/canonical-json.js');
      const line = (await fs.readFile(paths.eventsNdjson, 'utf8')).split('\n')[0];
      const original = JSON.parse(line) as Record<string, unknown>;
      // A tampered copy reusing the id with a freshly recomputed checksum:
      // without duplicate-id rejection this becomes the "latest" plan
      // event and recovery persists the rollback.
      const copy: Record<string, unknown> = {
        event_id: original.event_id,
        type: original.type,
        ts: '2026-04-26T13:00:00.000Z',
        schema_version: 1,
        idempotency_key: 'replayed',
        payload: { ...(original.payload as Record<string, unknown>), task: 'rolled back' },
      };
      copy.checksum = createHash('sha256').update(canonicalJson(copy), 'utf8').digest('hex');
      await fs.appendFile(paths.eventsNdjson, `${JSON.stringify(copy)}\n`, 'utf8');

      await expect(store.readPlan(artifactId)).rejects.toThrow(/unrecoverable/);
    });

    it('a strict-invalid plan.json cannot bless a lost checkpoint line into attribution', async () => {
      await writePlan('plan-init-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'cp1-open', headSha: 'cafef00d' }
      );
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      // Rot the sole checkpoint event and delete its projection: cp 1 is
      // now invisible to enumeration.
      const lines = (await fs.readFile(paths.eventsNdjson, 'utf8')).split('\n');
      const i = lines.findIndex((l) => l.includes('"checkpoint_opened"'));
      const openId = (JSON.parse(lines[i]) as { event_id: string }).event_id;
      lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
      await fs.writeFile(paths.eventsNdjson, lines.join('\n'), 'utf8');
      await fs.rm(paths.checkpointJson(1));
      // Forge a strict-INVALID plan.json whose source_event_id names the
      // lost line — attribution must not trust an unvalidated projection.
      const planOnDisk = JSON.parse(await fs.readFile(paths.planJson, 'utf8')) as Record<
        string,
        unknown
      >;
      delete planOnDisk.task;
      planOnDisk.source_event_id = openId;
      await fs.writeFile(paths.planJson, JSON.stringify(planOnDisk, null, 2), 'utf8');

      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
    });

    it('refuses to WRITE over a lossy history instead of baking the loss into projections', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      // Rot the close line: an ordinary follow-up capture would rebuild
      // projections from the survivors and stamp them with a fresh source
      // id, laundering the loss past the read-side completeness rule.
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_closed"');

      await expect(
        store.writeSummary(
          {
            schema_version: 1,
            artifact_id: artifactId,
            outcome: 'done',
            tests_written: [],
            tests_run: [],
            open_items: [],
            deferred_decisions: [],
            head_sha: 'cafef00d',
            ts: '2026-04-26T14:00:00.000Z',
          },
          { idempotencyKey: 'sum-over-rot' }
        )
      ).rejects.toThrow(
        new RegExp(`artifact ${artifactId}[\\s\\S]*writes refuse on a lossy history`)
      );
    });

    it('a refused write leaves the event log byte-identical (no append before the preflight)', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await corruptEventLine(paths.eventsNdjson, '"plan_captured"');
      const fs = await import('node:fs/promises');
      const before = await fs.readFile(paths.eventsNdjson, 'utf8');

      // writePrePrChecked appends through appendAndMirror with no prior
      // fold — the preflight must refuse BEFORE the append lands.
      await expect(
        store.writePrePrChecked(artifactId, passingPrePrReview('cafef00d'), {})
      ).rejects.toThrow(/writes refuse on a lossy history/);
      const after = await fs.readFile(paths.eventsNdjson, 'utf8');
      expect(after).toBe(before);
    });

    it('a garbled projection with no backing events refuses loudly instead of vanishing', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      // Double fault: the log is gone and the checkpoint projection is
      // garbled — more damage must not read quieter than less.
      await fs.writeFile(paths.checkpointJson(1), '{garbled', 'utf8');
      await fs.rm(paths.eventsNdjson);

      const err = await store.readCheckpoints(artifactId).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err?.message).toMatch(/cannot be parsed/);
      // The refusal names the unparseable FILE, and does not point at
      // doctor (whose event-log check would report all-clean here).
      expect(err?.message).toContain('checkpoint-1.json');
      expect(err?.message).not.toContain('orcaops doctor');
    });

    it('append-preflight refusals carry the typed class and shape (never a bare Error)', async () => {
      const { EventLogAppendRefusedError } = await import('./errors.js');
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);

      await corruptEventLine(paths.eventsNdjson, '"plan_captured"');
      const lossyErr = await store
        .writePrePrChecked(artifactId, passingPrePrReview('cafef00d'), {})
        .then(
          () => null,
          (e: unknown) => e
        );
      expect(lossyErr).toBeInstanceOf(EventLogAppendRefusedError);
      expect((lossyErr as InstanceType<typeof EventLogAppendRefusedError>).shape).toBe('lossy');
    });

    it('an unreadable event log refuses the append preflight with the typed unreadable shape', async () => {
      if (process.getuid?.() === 0) return;
      const { EventLogAppendRefusedError } = await import('./errors.js');
      const fs = await import('node:fs/promises');
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await fs.chmod(paths.eventsNdjson, 0o000);
      try {
        const err = await store
          .writePrePrChecked(artifactId, passingPrePrReview('cafef00d'), {})
          .then(
            () => null,
            (e: unknown) => e
          );
        expect(err).toBeInstanceOf(EventLogAppendRefusedError);
        expect((err as InstanceType<typeof EventLogAppendRefusedError>).shape).toBe('unreadable');
      } finally {
        await fs.chmod(paths.eventsNdjson, 0o644);
      }
    });

    it('refuses to capture over a crash-truncated tail, leaving the log byte-identical', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      // Crash residue: an unterminated partial line. Appending would merge
      // the new event into it — the preflight must refuse first.
      await fs.appendFile(paths.eventsNdjson, '{"event_id":"partial', 'utf8');
      const before = await fs.readFile(paths.eventsNdjson, 'utf8');

      const { EventLogAppendRefusedError } = await import('./errors.js');
      const err = await store
        .writePrePrChecked(artifactId, passingPrePrReview('cafef00d'), {})
        .then(
          () => null,
          (e: unknown) => e
        );
      expect(err).toBeInstanceOf(EventLogAppendRefusedError);
      expect((err as InstanceType<typeof EventLogAppendRefusedError>).shape).toBe('truncated_tail');
      expect((err as Error).message).toMatch(/unterminated partial write/);
      const after = await fs.readFile(paths.eventsNdjson, 'utf8');
      expect(after).toBe(before);
    });

    it('a later-corrupt-line refusal carries the doctor pointer (structured, not prose-matched)', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      // Unknown-type rot AFTER plan.json's source line: the dominant
      // real shape — the refusal must still point at doctor.
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_closed"');

      const err = await store.readPlan(artifactId).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err?.message).toMatch(/corrupt event-log line/);
      expect(err?.message).toContain('orcaops doctor');
    });

    it('rot on one checkpoint refuses the whole artifact — no per-checkpoint attribution', async () => {
      const STEP_2 = '01HX0K8N6ZQF8M5R2V8DZ7T3ZZ';
      await store.writePlan(
        {
          ...planInput(),
          plan_steps: [
            ...planInput().plan_steps,
            { step_id: STEP_2, text: 'step 2', label: 's2', acceptance_criteria: [] },
          ],
        },
        { idempotencyKey: 'plan-init-1' }
      );
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_2] },
        { idempotencyKey: 'cp2-open', headSha: 'cafef00d' }
      );
      const paths = artifactPathsFor(repo.path, config, artifactId);
      // Rot cp 2's open line: v1 refuses the WHOLE artifact — no
      // per-checkpoint loss attribution exists to keep cp 1 readable.
      const fs = await import('node:fs/promises');
      const lines = (await fs.readFile(paths.eventsNdjson, 'utf8')).split('\n');
      const i = lines.findIndex((l) => l.includes('"cp2-open"'));
      lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
      await fs.writeFile(paths.eventsNdjson, lines.join('\n'), 'utf8');

      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
      await expect(store.readCheckpoint(artifactId, 1)).rejects.toThrow(/corrupt event-log line/);
    });

    it('a forged sibling claim on a lost close refuses — and rewrites neither projection', async () => {
      const STEP_2 = '01HX0K8N6ZQF8M5R2V8DZ7T3ZZ';
      await store.writePlan(
        {
          ...planInput(),
          plan_steps: [
            ...planInput().plan_steps,
            { step_id: STEP_2, text: 'step 2', label: 's2', acceptance_criteria: [] },
          ],
        },
        { idempotencyKey: 'plan-init-1' }
      );
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_2] },
        { idempotencyKey: 'cp2-open', headSha: 'cafef00d' }
      );
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      // Rot cp 1's close line (id X preserved), then corrupt cp 2's
      // projection source field to ALSO claim X — a conflicting forged
      // ownership claim over lost history.
      const closeId = (
        JSON.parse(await fs.readFile(paths.checkpointJson(1), 'utf8')) as {
          source_event_id: string;
        }
      ).source_event_id;
      const lines = (await fs.readFile(paths.eventsNdjson, 'utf8')).split('\n');
      const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
      lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
      await fs.writeFile(paths.eventsNdjson, lines.join('\n'), 'utf8');
      const cp2 = JSON.parse(await fs.readFile(paths.checkpointJson(2), 'utf8')) as Record<
        string,
        unknown
      >;
      cp2.source_event_id = closeId;
      await fs.writeFile(paths.checkpointJson(2), JSON.stringify(cp2, null, 2), 'utf8');

      // v1 refuses the whole artifact on any loss, so the forged claim
      // never gets adjudicated — and the refusal must not rewrite either
      // projection (no-clobber).
      const cp1Before = await fs.readFile(paths.checkpointJson(1), 'utf8');
      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
      expect(await fs.readFile(paths.checkpointJson(1), 'utf8')).toBe(cp1Before);
      const cp2After = JSON.parse(await fs.readFile(paths.checkpointJson(2), 'utf8')) as {
        source_event_id: string;
      };
      expect(cp2After.source_event_id).toBe(closeId);
    });

    it('a gate-audited open shared with evaluators.json refuses on rot — no trust exception', async () => {
      await writePlan('plan-init-1');
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
        {
          idempotencyKey: 'cp1-open-gated',
          headSha: 'cafef00d',
          evaluatorContext: async () => ({
            fingerprint: 'f'.repeat(64),
            validatePolicyExceptions: () => {},
            preAppend: async () => ({
              ok: true as const,
              gate_audit: {
                runs: [
                  {
                    run_id: 'gate-run-1',
                    evaluator_ref: 'core/checkpoint-scope-density',
                    phase: 'checkpoint-open',
                    severity: 'warn',
                    run_status: 'completed',
                    verdict: 'pass',
                    body: 'PASS',
                    ts: '2026-04-26T12:00:00.000Z',
                  },
                ],
                dispositions: [],
              } as never,
            }),
          }),
        }
      );
      const paths = artifactPathsFor(repo.path, config, artifactId);
      // The one gate-audited open sources BOTH checkpoint-1.json and
      // evaluators.json. Rot that line: shared sourcing earns no trust
      // exception — the artifact refuses like any other loss.
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_opened"');

      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
    });

    it('a rotted close refuses even when evaluators.json names the same event — no exception', async () => {
      await writePlan('plan-init-1');
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      // Plant the evaluator-less projection returned by recovery. Reads no
      // longer persist it themselves, but a surviving projection with the
      // same source claim still must not earn a corruption exception.
      const evalLog = await store.readEvaluatorLog(artifactId);
      await fs.writeFile(paths.evaluatorsJson, JSON.stringify(evalLog, null, 2) + '\n');
      const closeId = (
        JSON.parse(await fs.readFile(paths.checkpointJson(1), 'utf8')) as {
          source_event_id: string;
        }
      ).source_event_id;
      expect(evalLog?.source_event_id).toBe(closeId); // the trap is real
      await corruptEventLine(paths.eventsNdjson, '"checkpoint_closed"');
      await fs.rm(paths.checkpointJson(1));

      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
    });

    it('serves a pin displacement without rewriting the stale artifact projection', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      const before = JSON.parse(await fs.readFile(paths.artifactJson, 'utf8')) as {
        source_event_id: string;
      };
      const { event_id } = await store.writePinDisplaced(artifactId, {
        displaced_by_artifact_id: '01999999-9999-7000-8000-00000000dddd',
        shell_key: { kind: 'tty', value: 'tty-1' },
        reason: 'explicit-checkout',
      });

      const served = await store.readArtifact(artifactId);
      expect(served?.source_event_id).toBe(event_id);
      expect(served?.source_event_id).not.toBe(before.source_event_id);
      const onDisk = JSON.parse(await fs.readFile(paths.artifactJson, 'utf8')) as {
        source_event_id: string;
      };
      expect(onDisk.source_event_id).toBe(before.source_event_id);
    });

    it('a clean suffix truncation refuses and preserves the projection bytes (no-clobber)', async () => {
      const STEP_2 = '01HX0K8N6ZQF8M5R2V8DZ7T3ZZ';
      await store.writePlan(
        {
          ...planInput(),
          plan_steps: [
            ...planInput().plan_steps,
            { step_id: STEP_2, text: 'step 2', label: 's2', acceptance_criteria: [] },
          ],
        },
        { idempotencyKey: 'plan-init-1' }
      );
      await writeCheckpoint('cp-1', { n: 1, summary: 'first' });
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      // Remove the final acknowledged line CLEANLY — no corruption
      // markers, the log parses green, but checkpoint-1.json still
      // names the removed close as its source.
      const lines = (await fs.readFile(paths.eventsNdjson, 'utf8'))
        .split('\n')
        .filter((l) => l.length > 0);
      await fs.writeFile(paths.eventsNdjson, lines.slice(0, -1).join('\n') + '\n', 'utf8');
      const before = await fs.readFile(paths.checkpointJson(1), 'utf8');

      await expect(store.readCheckpoints(artifactId)).rejects.toThrow(
        /absent from the intact event log/
      );
      await expect(store.readCheckpoint(artifactId, 1)).rejects.toThrow(
        /absent from the intact event log/
      );
      // The projection is the only remaining witness — never overwrite.
      expect(await fs.readFile(paths.checkpointJson(1), 'utf8')).toBe(before);

      // The WRITE path must protect the witness too: an ordinary append
      // rebuilds artifact.json, which would bake the truncated history
      // in — the preflight refuses on the missing source instead.
      const artifactBefore = await fs.readFile(paths.artifactJson, 'utf8');
      await expect(
        store.writeCheckpointOpened(
          { artifact_id: artifactId, declared_step_ids: [STEP_2] },
          { idempotencyKey: 'cp2-open-after-truncation', headSha: 'cafef00d' }
        )
      ).rejects.toThrow(/absent from the intact event log/);
      expect(await fs.readFile(paths.artifactJson, 'utf8')).toBe(artifactBefore);
    });

    it('names irrecoverable event-log damage when the backing line is destroyed beyond attribution', async () => {
      await writePlan('plan-init-1');
      const paths = artifactPathsFor(repo.path, config, artifactId);
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(paths.eventsNdjson, 'utf8');
      const lines = raw.split('\n');
      const i = lines.findIndex((l) => l.includes('"plan_captured"'));
      // Structural destruction: no event_id survives, so the loss is
      // unattributable. The newline stays so this is a lost line, not a
      // truncated tail.
      lines[i] = '{"garbage';
      await fs.writeFile(paths.eventsNdjson, lines.join('\n'), 'utf8');

      const err = await store.readPlan(artifactId).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/corrupt event-log line/);
      expect(err?.message).not.toMatch(/pre-event-first/);
      expect(err?.message).toContain(artifactId);
    });
  });

  // ── idempotency-key auto-mint (partial-opts round-trip) ──────────

  // The seven auto-mint writers resolve `opts.idempotencyKey ?? uuidv7()`
  // at the write boundary. Calling each via its partial-opts path WITHOUT
  // an idempotencyKey is the exact shape that originally produced a
  // keyless event (silently dropped on read). Assert each instead mints a
  // non-empty key and the event re-reads cleanly.
  describe('auto-mint key on partial opts (no idempotencyKey supplied)', () => {
    const pin = {
      source_ref: { kind: 'local' as const, locator: 'plans/rate-limit.md' },
      content: '# slice\n',
      hash: 'a'.repeat(64),
      baseline: null,
    };

    const cases: Array<{ name: string; eventType: string; run: () => Promise<void> }> = [
      {
        name: 'writePlan',
        eventType: 'plan_captured',
        run: async () => {
          // partial opts: sourcePlan pin, NO idempotencyKey
          await store.writePlan(planInput(), { sourcePlan: pin });
        },
      },
      {
        name: 'writeSummary',
        eventType: 'summary_captured',
        run: async () => {
          await writePlan('seed-plan');
          // partial opts: replayPayload, NO idempotencyKey
          await store.writeSummary(
            {
              schema_version: 1,
              artifact_id: artifactId,
              outcome: 'shipped',
              tests_written: [],
              tests_run: [],
              open_items: [],
              deferred_decisions: [],
              head_sha: 'def456',
              ts: '2026-04-26T13:00:00.000Z',
            },
            { replayPayload: { artifact_id: artifactId, outcome: 'shipped' } }
          );
        },
      },
      {
        name: 'writeEvaluatorRunPayload',
        eventType: 'evaluator_run_recorded',
        run: async () => {
          await writePlan('seed-plan');
          await store.writeEvaluatorRunPayload(artifactId, makeRunPayload({ run_id: 'run-1' }), {});
        },
      },
      {
        name: 'writeEvaluatorDisposition',
        eventType: 'evaluator_disposition_recorded',
        run: async () => {
          await writePlan('seed-plan');
          // FK: the targeted run must exist in SQLite first — seed it with
          // an explicit key, then take the disposition path with no key.
          await store.writeEvaluatorRunPayload(artifactId, makeRunPayload({ run_id: 'run-1' }), {
            idempotencyKey: 'seed-run',
          });
          await store.writeEvaluatorDisposition(
            artifactId,
            makeDispositionPayload({ run_id: 'run-1', disposition: 'acknowledged' }),
            {}
          );
        },
      },
      {
        name: 'appendBranchLineage',
        eventType: 'branch_lineage_updated',
        run: async () => {
          await writePlan('seed-plan');
          await store.appendBranchLineage(
            artifactId,
            {
              branch: 'feat/y',
              head_sha: 'beadfeed',
              ts: '2026-04-26T14:00:00.000Z',
              event: 'rebased',
            },
            {}
          );
        },
      },
      {
        name: 'writePrePrChecked',
        eventType: 'pre_pr_checked',
        run: async () => {
          await writePlan('seed-plan');
          await store.writePrePrChecked(artifactId, passingPrePrReview('beadfeed'), {});
        },
      },
      {
        name: 'writePinDisplaced',
        eventType: 'pin_displaced',
        run: async () => {
          await writePlan('seed-plan');
          await store.writePinDisplaced(
            artifactId,
            {
              displaced_by_artifact_id: '01999999-9999-7000-8000-000000000002',
              shell_key: { kind: 'cloud' },
              reason: 'auto-on-capture-plan',
            },
            {}
          );
        },
      },
    ];

    it.each(cases)(
      '$name mints a non-empty idempotency_key and round-trips through readEventLog',
      async ({ eventType, run }) => {
        await run();
        const paths = artifactPathsFor(repo.path, config, artifactId);
        const log = await readEventLog({
          eventLogPath: paths.eventsNdjson,
          sidecarsDir: paths.sidecarsDir,
        });
        expect(log.corrupt).toEqual([]);
        const target = log.events.filter((e) => e.type === eventType);
        expect(target).toHaveLength(1);
        expect(typeof target[0].idempotency_key).toBe('string');
        expect(target[0].idempotency_key.length).toBeGreaterThan(0);
      }
    );
  });

  // ── helpers ──────────────────────────────────────────────────────

  // Stable step_id for the single-step plans in this fixture. The
  // helpers below open and close checkpoints declaring this id.
  const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';

  function planInput() {
    return {
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
    };
  }

  async function writePlan(idempotencyKey: string): Promise<{ event_id: string }> {
    return store.writePlan(planInput(), { idempotencyKey });
  }

  function lineageRows(): { byLatestSha: unknown[]; branches: unknown[] } {
    return {
      byLatestSha: store.store.db
        .prepare('SELECT * FROM lineage_by_latest_sha WHERE artifact_id = ?')
        .all(artifactId),
      branches: store.store.db
        .prepare('SELECT * FROM lineage_branches WHERE artifact_id = ? ORDER BY branch_name')
        .all(artifactId),
    };
  }

  /**
   * Rot the first event-log line containing `marker` by zeroing its
   * checksum: the line stays valid JSON with a valid schema, so
   * readEventLog reports it as a checksum mismatch with the event_id
   * preserved — the same shape real disk rot produces.
   */
  async function corruptEventLine(eventLogPath: string, marker: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(eventLogPath, 'utf8');
    const lines = raw.split('\n');
    const i = lines.findIndex((l) => l.includes(marker));
    if (i === -1) throw new Error(`no event line contains ${marker}`);
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await fs.writeFile(eventLogPath, lines.join('\n'), 'utf8');
  }

  /**
   * Open + close a checkpoint at the given n. Returns the close result
   * for assertions on `outcome` / `checkpoint`.
   */
  async function writeCheckpoint(
    idempotencyKey: string,
    over: { n: number; summary: string }
  ): Promise<Awaited<ReturnType<ArtifactStore['writeCheckpointClosed']>>> {
    // The open is keyed off `${idempotencyKey}-open` so the same higher-level
    // key lets the test assert close-side replay/conflict semantics
    // independently of open-side dedup.
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
      { idempotencyKey: `${idempotencyKey}-open`, headSha: 'cafef00d' }
    );
    return store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: over.n,
        summary: over.summary,
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_ID],
        head_sha: 'cafef00d',
      },
      // Storage defaults strip head_sha + ts so same input replays
      // correctly without a custom replayPayload/extractReplayShape.
      { idempotencyKey }
    );
  }

  /**
   * Reproduce a `kill -9` landing between the durable summary_captured append
   * and the projection + cache writes. No signal needed: the projections are
   * pure functions of the log prefix, so removing the ones the last write
   * would have added leaves provably the same bytes a crash would.
   */
  async function tearSummaryCommitGroup(paths: {
    summaryJson: string;
    summaryMd: string;
    artifactJson: string;
  }): Promise<void> {
    await rm(paths.summaryJson);
    await rm(paths.summaryMd);
    const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
    artifactJson.state = 'active';
    await writeFile(paths.artifactJson, JSON.stringify(artifactJson, null, 2) + '\n');
    store.store.db.prepare('DELETE FROM summaries WHERE artifact_id = ?').run(artifactId);
    store.store.db
      .prepare("UPDATE artifacts SET status = 'active', completed_at = NULL WHERE id = ?")
      .run(artifactId);
  }

  async function writeSummary(
    idempotencyKey: string,
    outcome: string
  ): Promise<Awaited<ReturnType<ArtifactStore['writeSummary']>>> {
    return store.writeSummary(
      {
        schema_version: 1,
        artifact_id: artifactId,
        outcome,
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'def456',
        ts: '2026-04-26T13:00:00.000Z',
      },
      {
        idempotencyKey,
        replayPayload: {
          artifact_id: artifactId,
          outcome,
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
        },
        extractReplayShape: (prior) => {
          const p = prior as Record<string, unknown>;
          return {
            artifact_id: p.artifact_id,
            outcome: p.outcome,
            tests_written: p.tests_written,
            tests_run: p.tests_run,
            open_items: p.open_items,
            deferred_decisions: p.deferred_decisions,
          };
        },
      }
    );
  }

  function summaryInput(overrides: Partial<SummaryInput> = {}): SummaryInput {
    return {
      schema_version: 1 as const,
      artifact_id: artifactId,
      outcome: 'shipped',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'def456',
      ts: '2026-04-26T13:00:00.000Z',
      ...overrides,
    };
  }

  async function writeWarningReview(runIds: string[]) {
    for (const [index, runId] of runIds.entries()) {
      await store.writeEvaluatorRunPayload(
        artifactId,
        {
          schema: 'orcaops.evaluator_run/v1',
          run_id: runId,
          artifact_id: artifactId,
          evaluator_ref: `test/warning-${index}`,
          package_id: 'test',
          evaluator_id: `warning-${index}`,
          phase: 'pre-pr',
          severity: 'warn',
          run_status: 'completed',
          verdict: 'violation',
          body: `warning ${index}`,
          ts: '2026-04-26T12:55:00.000Z',
        },
        { idempotencyKey: `record-${runId}` }
      );
    }
    const marker = await store.writePrePrChecked(artifactId, {
      head_sha: 'def456',
      outcome: 'needs_attention',
      evaluator_set_fingerprint: 'a'.repeat(64),
      review_context_fingerprint: 'b'.repeat(64),
      run_ids: runIds,
    });
    return { reviewId: marker.event_id, runIds };
  }

  function makeRunPayload(
    overrides: Partial<{
      run_id: string;
      evaluator_ref: string;
      package_id: string;
      evaluator_id: string;
      phase: 'post-plan' | 'post-plan-revision' | 'checkpoint-open' | 'checkpoint-close' | 'pre-pr';
      severity: 'info' | 'warn' | 'block';
      run_status: 'completed' | 'error' | 'skipped';
      verdict: 'pass' | 'violation' | 'info' | null;
      body: string;
      ts: string;
    }> = {}
  ) {
    const base = {
      schema: 'orcaops.evaluator_run/v1' as const,
      run_id: 'run-default',
      artifact_id: artifactId,
      evaluator_ref: 'core/api-stability',
      package_id: 'core',
      evaluator_id: 'api-stability',
      phase: 'checkpoint-close' as const,
      severity: 'block' as const,
      run_status: 'completed' as const,
      verdict: 'violation' as 'pass' | 'violation' | 'info' | null,
      body: 'VIOLATION\n\nbreaks API',
      ts: '2026-04-26T12:30:00.000Z',
    };
    return { ...base, ...overrides };
  }

  function makeDispositionPayload(
    overrides: Partial<{
      disposition_id: string;
      run_id: string;
      evaluator_ref: string;
      disposition: 'acknowledged' | 'dismissed' | 'policy-excepted';
      reason: string;
      ts: string;
    }> = {}
  ) {
    const base = {
      schema: 'orcaops.evaluator_disposition/v1' as const,
      disposition_id: 'dis-default',
      artifact_id: artifactId,
      run_id: 'run-default',
      evaluator_ref: 'core/api-stability',
      disposition: 'acknowledged' as const,
      reason: 'breaking change deliberate; see ADR-014',
      agent_session_id: null as string | null,
      ts: '2026-04-26T12:35:00.000Z',
    };
    return { ...base, ...overrides };
  }
});
