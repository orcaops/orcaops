import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendEvent, type AppendEventOptions } from './event-log.js';
import {
  computeOpenBlocksByRef,
  loadEventsWithPayloads,
  rebuildArtifactJsonFromEvents,
  rebuildCheckpointFromEvents,
  rebuildEvaluatorLogFromEvents,
  rebuildPlanFromEvents,
  rebuildSummaryFromEvents,
} from './rebuilders.js';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
} from '../schema/diff-fingerprint.js';

/**
 * The rebuilders are pure functions, but the loader uses real disk for
 * sidecar payloads — so each test plants events via `appendEvent` and
 * then loads them back, mirroring the real recovery path.
 */
describe('rebuilders', () => {
  let tmpRoot: string;
  let opts: AppendEventOptions;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-rebuild-'));
    opts = {
      eventLogPath: path.join(tmpRoot, 'events.ndjson'),
      sidecarsDir: path.join(tmpRoot, 'sidecars'),
    };
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  // ── plan ─────────────────────────────────────────────────────────

  describe('rebuildPlanFromEvents', () => {
    it('returns null when the log has no plan_captured event', async () => {
      const events = await loadEventsWithPayloads([], { sidecarsDir: opts.sidecarsDir });
      expect(rebuildPlanFromEvents(events)).toBeNull();
    });

    it('reconstructs a Plan from a single plan_captured event', async () => {
      const planPayload = {
        schema_version: 4,
        artifact_id: '01999999-9999-7000-8000-000000000001',
        branch: 'feat/x',
        base_sha: 'abc',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'do the thing',
        label: 'thing-plan',
        plan_steps: [
          { step_id: 'step-1', text: 'step 1', label: 'step-1', acceptance_criteria: [] },
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
      };
      const ev = await appendEvent(
        {
          type: 'plan_captured',
          ts: planPayload.started_at,
          idempotency_key: 'plan-1',
          payload: planPayload,
        },
        opts
      );

      const loaded = await loadEventsWithPayloads([ev], { sidecarsDir: opts.sidecarsDir });
      const result = rebuildPlanFromEvents(loaded);
      expect(result).not.toBeNull();
      expect(result!.plan.task).toBe('do the thing');
      expect(result!.plan.source_event_id).toBe(ev.event_id);
      expect(result!.sourceEventId).toBe(ev.event_id);
      expect(result!.plan.decisions).toEqual([]);
    });

    it('takes the LATEST plan event (plan_captured | plan_revised)', async () => {
      const base = {
        schema_version: 4,
        artifact_id: '01999999-9999-7000-8000-000000000001',
        branch: 'feat/x',
        base_sha: 'abc',
        agent: 'claude-code',
        agent_session_id: null,
        label: 'first-try-plan',
        plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
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
      const e1 = await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: { ...base, task: 'first try' },
        },
        opts
      );
      // A plan_revised event with revision_n=1 supersedes the initial
      // plan_captured (latest plan event wins).
      const e2 = await appendEvent(
        {
          type: 'plan_revised',
          ts: '2026-04-26T12:01:00.000Z',
          idempotency_key: 'plan-r1',
          payload: {
            ...base,
            task: 'first try',
            revision_n: 1,
            revised_at: '2026-04-26T12:01:00.000Z',
            rationale: 'corrected the task description',
            plan_steps: [
              { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
            ],
            prior_plan_event_id: e1.event_id,
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1, e2], { sidecarsDir: opts.sidecarsDir });
      const result = rebuildPlanFromEvents(loaded);
      expect(result!.plan.revision_n).toBe(1);
      expect(result!.plan.rationale).toBe('corrected the task description');
      expect(result!.sourceEventId).toBe(e2.event_id);
      expect(result!.plan.decisions).toEqual([]);
    });
  });

  // ── checkpoint ───────────────────────────────────────────────────

  describe('rebuildCheckpointFromEvents', () => {
    it('returns null when the log has no opened cp with that n', async () => {
      const events = await openClosePair(opts, { n: 1, summary: 'sum' });
      const loaded = await loadEventsWithPayloads(events, { sidecarsDir: opts.sidecarsDir });
      expect(rebuildCheckpointFromEvents(loaded, 99)).toBeNull();
    });

    it('reconstructs the requested n from its events', async () => {
      const events = await openClosePair(opts, { n: 1, summary: 'first' });
      const loaded = await loadEventsWithPayloads(events, { sidecarsDir: opts.sidecarsDir });
      const result = rebuildCheckpointFromEvents(loaded, 1);
      expect(result).not.toBeNull();
      if (result!.checkpoint.status !== 'closed') throw new Error('expected closed');
      expect(result!.checkpoint.summary).toBe('first');
      expect(result!.checkpoint.source_event_id).toBe(events[1].event_id);
    });

    it('rejects duplicate close events for the requested n as corruption', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-1-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const e1 = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-1-a',
          payload: makeCheckpointPayload({ n: 1, summary: 'first try' }),
        },
        opts
      );
      const e2 = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:01:00.000Z',
          idempotency_key: 'cp-1-b',
          payload: makeCheckpointPayload({ n: 1, summary: 'corrected' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, e1, e2], {
        sidecarsDir: opts.sidecarsDir,
      });
      expect(() => rebuildCheckpointFromEvents(loaded, 1)).toThrow(
        'has 2 checkpoint_closed events; at most one is allowed'
      );
    });

    it('rejects duplicate open events for the requested n as corruption', async () => {
      const first = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-1-open-a',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const second = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-1-open-b',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([first, second], {
        sidecarsDir: opts.sidecarsDir,
      });

      expect(() => rebuildCheckpointFromEvents(loaded, 1)).toThrow(
        'has 2 checkpoint_opened events; exactly one is allowed'
      );
    });

    it('rejects close and abandon terminal events for the same checkpoint', async () => {
      const [open, close] = await openClosePair(opts, { n: 1 });
      const abandon = await appendEvent(
        {
          type: 'checkpoint_abandoned',
          ts: '2026-04-26T12:05:00.000Z',
          idempotency_key: 'cp-1-abandon',
          payload: {
            artifact_id: '01999999-9999-7000-8000-000000000001',
            n: 1,
            reason: 'cancelled',
            abandoned_at: '2026-04-26T12:05:00.000Z',
            abandoned_by_agent: 'other',
            head_sha: 'abc',
            abandon_snapshot: buildDefaultSkippedSnapshotBoundary(),
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, close, abandon], {
        sidecarsDir: opts.sidecarsDir,
      });

      expect(() => rebuildCheckpointFromEvents(loaded, 1)).toThrow(
        'has both checkpoint_closed and checkpoint_abandoned terminal events'
      );
    });

    it('rejects duplicate abandon events for the requested n as corruption', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-1-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const abandoned = (idempotency_key: string, abandoned_at: string) =>
        appendEvent(
          {
            type: 'checkpoint_abandoned',
            ts: abandoned_at,
            idempotency_key,
            payload: {
              artifact_id: '01999999-9999-7000-8000-000000000001',
              n: 1,
              reason: 'cancelled',
              abandoned_at,
              abandoned_by_agent: 'other',
              head_sha: 'abc',
              abandon_snapshot: buildDefaultSkippedSnapshotBoundary(),
            },
          },
          opts
        );
      const first = await abandoned('cp-1-abandon-a', '2026-04-26T12:05:00.000Z');
      const second = await abandoned('cp-1-abandon-b', '2026-04-26T12:06:00.000Z');
      const loaded = await loadEventsWithPayloads([open, first, second], {
        sidecarsDir: opts.sidecarsDir,
      });

      expect(() => rebuildCheckpointFromEvents(loaded, 1)).toThrow(
        'has 2 checkpoint_abandoned events; at most one is allowed'
      );
    });

    it('rejects an abandon event that omits its required head_sha', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-1-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const abandon = await appendEvent(
        {
          type: 'checkpoint_abandoned',
          ts: '2026-04-26T12:05:00.000Z',
          idempotency_key: 'cp-1-abandon',
          payload: {
            artifact_id: '01999999-9999-7000-8000-000000000001',
            n: 1,
            reason: 'cancelled',
            abandoned_at: '2026-04-26T12:05:00.000Z',
            abandoned_by_agent: 'other',
            abandon_snapshot: buildDefaultSkippedSnapshotBoundary(),
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, abandon], {
        sidecarsDir: opts.sidecarsDir,
      });

      expect(() => rebuildCheckpointFromEvents(loaded, 1)).toThrow(/head_sha/);
    });

    it('isolates n=1 vs n=2 (no cross-contamination)', async () => {
      const ev1 = await openClosePair(opts, { n: 1, summary: 'one' });
      const ev2 = await openClosePair(opts, { n: 2, summary: 'two' });
      const loaded = await loadEventsWithPayloads([...ev1, ...ev2], {
        sidecarsDir: opts.sidecarsDir,
      });
      const r1 = rebuildCheckpointFromEvents(loaded, 1);
      const r2 = rebuildCheckpointFromEvents(loaded, 2);
      if (r1!.checkpoint.status !== 'closed' || r2!.checkpoint.status !== 'closed') {
        throw new Error('expected closed');
      }
      expect(r1!.checkpoint.summary).toBe('one');
      expect(r2!.checkpoint.summary).toBe('two');
    });

    it('returns the open projection when no close has been written yet', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-1-open',
          payload: makeOpenPayload({ n: 1, declared: ['step-1', 'step-2'] }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open], { sidecarsDir: opts.sidecarsDir });
      const result = rebuildCheckpointFromEvents(loaded, 1);
      expect(result!.checkpoint.status).toBe('open');
      if (result!.checkpoint.status !== 'open') throw new Error('expected open');
      expect(result!.checkpoint.declared_step_ids).toEqual(['step-1', 'step-2']);
    });

    it('returns the abandoned projection when an abandon event follows the open', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-1-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const abandon = await appendEvent(
        {
          type: 'checkpoint_abandoned',
          ts: '2026-04-26T12:05:00.000Z',
          idempotency_key: 'cp-1-abandon',
          payload: {
            artifact_id: '01999999-9999-7000-8000-000000000001',
            n: 1,
            reason: 'subagent-c timed out',
            abandoned_at: '2026-04-26T12:05:00.000Z',
            abandoned_by_agent: 'other',
            head_sha: 'abc',
            // v4 required field.
            abandon_snapshot: buildDefaultSkippedSnapshotBoundary(),
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, abandon], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildCheckpointFromEvents(loaded, 1);
      if (result!.checkpoint.status !== 'abandoned') throw new Error('expected abandoned');
      expect(result!.checkpoint.reason).toBe('subagent-c timed out');
    });

    it('carries the open-time invoking agent into every projection variant', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-1-open',
          payload: makeOpenPayload({ n: 1, agent: 'claude-code' }),
        },
        opts
      );
      const openOnly = await loadEventsWithPayloads([open], { sidecarsDir: opts.sidecarsDir });
      const openResult = rebuildCheckpointFromEvents(openOnly, 1);
      if (openResult!.checkpoint.status !== 'open') throw new Error('expected open');
      expect(openResult!.checkpoint.agent).toBe('claude-code');

      // Cross-agent handoff: a DIFFERENT agent closes — the open-time
      // agent is carried forward, the close stamps its own attribution.
      const close = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-1-close',
          payload: makeCheckpointPayload({ n: 1, summary: 'sum', closedByAgent: 'codex' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, close], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildCheckpointFromEvents(loaded, 1);
      if (result!.checkpoint.status !== 'closed') throw new Error('expected closed');
      expect(result!.checkpoint.agent).toBe('claude-code');
      expect(result!.checkpoint.closed_by_agent).toBe('codex');
    });

    it('carries the abandon-time invoking agent onto the abandoned projection', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-1-open',
          payload: makeOpenPayload({ n: 1, agent: 'cursor' }),
        },
        opts
      );
      const abandon = await appendEvent(
        {
          type: 'checkpoint_abandoned',
          ts: '2026-04-26T12:05:00.000Z',
          idempotency_key: 'cp-1-abandon',
          payload: {
            artifact_id: '01999999-9999-7000-8000-000000000001',
            n: 1,
            reason: 'handed off',
            abandoned_at: '2026-04-26T12:05:00.000Z',
            abandoned_by_agent: 'github-copilot',
            head_sha: 'abc',
            abandon_snapshot: buildDefaultSkippedSnapshotBoundary(),
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, abandon], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildCheckpointFromEvents(loaded, 1);
      if (result!.checkpoint.status !== 'abandoned') throw new Error('expected abandoned');
      expect(result!.checkpoint.agent).toBe('cursor');
      expect(result!.checkpoint.abandoned_by_agent).toBe('github-copilot');
    });

    it('rejects an open event without invoking-agent attribution', async () => {
      const payload = makeOpenPayload({ n: 1 });
      delete payload.agent;
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-missing-open-agent',
          payload,
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open], { sidecarsDir: opts.sidecarsDir });
      expect(() => rebuildCheckpointFromEvents(loaded, 1)).toThrow(/agent/);
    });

    it('rejects a close event without invoking-agent attribution', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-missing-close-agent-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const payload = makeCheckpointPayload({ n: 1 });
      delete payload.closed_by_agent;
      const close = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-missing-close-agent',
          payload,
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, close], {
        sidecarsDir: opts.sidecarsDir,
      });
      expect(() => rebuildCheckpointFromEvents(loaded, 1)).toThrow(/closed_by_agent/);
    });

    it('rejects an abandon event without invoking-agent attribution', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-missing-abandon-agent-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const abandon = await appendEvent(
        {
          type: 'checkpoint_abandoned',
          ts: '2026-04-26T12:05:00.000Z',
          idempotency_key: 'cp-missing-abandon-agent',
          payload: {
            artifact_id: '01999999-9999-7000-8000-000000000001',
            n: 1,
            reason: 'cancelled',
            abandoned_at: '2026-04-26T12:05:00.000Z',
            head_sha: 'abc',
            abandon_snapshot: buildDefaultSkippedSnapshotBoundary(),
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, abandon], {
        sidecarsDir: opts.sidecarsDir,
      });
      expect(() => rebuildCheckpointFromEvents(loaded, 1)).toThrow(/abandoned_by_agent/);
    });

    it('rejects a v4 open payload missing a launch-required key with its exact field path', async () => {
      const payload = makeOpenPayload({ n: 1 });
      delete payload.policy_exceptions;
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-strict-open',
          payload,
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open], { sidecarsDir: opts.sidecarsDir });
      try {
        rebuildCheckpointFromEvents(loaded, 1);
        expect.unreachable('rebuild must reject the payload');
      } catch (err) {
        const issues = (err as { issues?: Array<{ path: unknown[] }> }).issues ?? [];
        expect(issues.map((i) => i.path.join('.'))).toContain('policy_exceptions');
      }
    });

    it('rejects a v4 close payload missing a launch-required key with its exact field path', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-strict-close-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const closePayload = makeCheckpointPayload({ n: 1, summary: 'strict' });
      delete closePayload.files_changed;
      const close = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-strict-close',
          payload: closePayload,
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, close], {
        sidecarsDir: opts.sidecarsDir,
      });
      try {
        rebuildCheckpointFromEvents(loaded, 1);
        expect.unreachable('rebuild must reject the payload');
      } catch (err) {
        const issues = (err as { issues?: Array<{ path: unknown[] }> }).issues ?? [];
        expect(issues.map((i) => i.path.join('.'))).toContain('files_changed');
      }
    });

    it('throws on a checkpoint_closed without a matching prior checkpoint_opened', async () => {
      const orphan = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-orphan',
          payload: makeCheckpointPayload({ n: 5, summary: 'orphan' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([orphan], { sidecarsDir: opts.sidecarsDir });
      expect(() => rebuildCheckpointFromEvents(loaded, 5)).toThrow(/log corruption/);
    });

    // ── v4 fingerprint manifest folding ────────────────────────────

    it('inline path: small close payload with explicit close_snapshot + summary round-trips', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-fp-inline-open',
          payload: { ...makeOpenPayload({ n: 1 }), head_sha: 'open-head' },
        },
        opts
      );
      const closePayload = makeCheckpointPayload({ n: 1, summary: 'inline cp' });
      // Override the default-skipped fields with explicit captured-status values.
      closePayload.close_snapshot = {
        snapshot_ref: 'refs/orcaops/snap/abc/1/close',
        tree_sha: '1111111111111111111111111111111111111111',
        snapshot_commit_sha: '2222222222222222222222222222222222222222',
        snapshot_error_reason: null,
      };
      closePayload.diff_fingerprint_summary = {
        status: 'captured',
        hunk_count: 2,
        captured_hunk_count: 2,
        truncated: false,
        fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2',
        manifest_hash: 'small-inline-manifest-hash',
        manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
        error_reason: null,
      };
      const close = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-fp-inline-close',
          payload: closePayload,
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open, close], { sidecarsDir: opts.sidecarsDir });
      const result = rebuildCheckpointFromEvents(loaded, 1);
      expect(result).not.toBeNull();
      if (!result || result.checkpoint.status !== 'closed') throw new Error('expected closed');
      expect(result.checkpoint.open_head_sha).toBe('open-head');
      expect(result.checkpoint.head_sha).toBe('abc');
      expect(result.checkpoint.close_snapshot.tree_sha).toBe(
        '1111111111111111111111111111111111111111'
      );
      expect(result.checkpoint.diff_fingerprint_summary.status).toBe('captured');
      expect(result.checkpoint.diff_fingerprint_summary.manifest_hash).toBe(
        'small-inline-manifest-hash'
      );
    });

    it('sidecar spill path: large diff_fingerprint_manifest payload reads back via loadEventPayload', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-fp-sidecar-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      // Build a synthetic ~50 KB manifest — well past the 8 KB inline budget.
      const bigHunks = Array.from({ length: 50 }, (_unused, i) => ({
        hunk_index: i,
        file_before: 'src/foo.ts',
        file_after: 'src/foo.ts',
        change_type: 'modify' as const,
        binary: false,
        old_start: i * 10,
        old_lines: 10,
        new_start: i * 10,
        new_lines: 10,
        patch_hash: `patch-hash-${i}`.padEnd(64, 'x'),
        added_line_hashes: Array.from({ length: 10 }, (_y, j) =>
          `add-hash-${i}-${j}`.padEnd(32, 'a')
        ),
        deleted_line_hashes: Array.from({ length: 10 }, (_y, j) =>
          `del-hash-${i}-${j}`.padEnd(32, 'd')
        ),
        hunk_header_hash: `header-${i}`.padEnd(32, 'h'),
        added_line_count: 10,
        deleted_line_count: 10,
      }));
      const closePayload = makeCheckpointPayload({ n: 1, summary: 'sidecar cp' });
      closePayload.diff_fingerprint_summary = {
        status: 'captured',
        hunk_count: bigHunks.length,
        captured_hunk_count: bigHunks.length,
        truncated: false,
        fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2',
        manifest_hash: 'large-sidecar-manifest-hash',
        manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
        error_reason: null,
      };
      closePayload.diff_fingerprint_manifest = {
        schema_version: 1,
        artifact_id: '01999999-9999-7000-8000-000000000001',
        checkpoint_n: 1,
        open_tree_sha: 'a'.repeat(40),
        close_tree_sha: 'b'.repeat(40),
        status: 'captured',
        hunk_count: bigHunks.length,
        captured_hunk_count: bigHunks.length,
        truncated: false,
        error_reason: null,
        normalization_version: 'orcaops-line-normalization-v1',
        diff_algorithm: 'git-diff-unified-v1',
        diff_options: { unified: 3, find_renames: true, no_ext_diff: true },
        limits: { max_diff_bytes: 2_000_000 },
        hash_encoding: 'base64url-nopad',
        line_hash_algorithm: 'blake3-xof-96-base64url-nopad-v2',
        patch_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
        hunk_header_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
        manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
        hunks: bigHunks,
      };
      // Sanity check: the synthetic payload exceeds the 8 KB inline budget.
      const payloadBytes = Buffer.byteLength(JSON.stringify(closePayload), 'utf8');
      expect(payloadBytes).toBeGreaterThan(8 * 1024);
      const close = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-fp-sidecar-close',
          payload: closePayload,
        },
        opts
      );
      // The event record itself should reference a sidecar (no inline payload).
      expect('sidecar_sha256' in close).toBe(true);
      const loaded = await loadEventsWithPayloads([open, close], { sidecarsDir: opts.sidecarsDir });
      const result = rebuildCheckpointFromEvents(loaded, 1);
      if (!result || result.checkpoint.status !== 'closed') throw new Error('expected closed');
      expect(result.checkpoint.diff_fingerprint_summary.manifest_hash).toBe(
        'large-sidecar-manifest-hash'
      );
    });

    it('corrupt sidecar: integrity check drops the close event, rebuilder degrades to open-only', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-fp-corrupt-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      // Build the same large close payload that spills to a sidecar.
      const closePayload = makeCheckpointPayload({ n: 1, summary: 'corrupt cp' });
      closePayload.diff_fingerprint_manifest = {
        schema_version: 1,
        artifact_id: '01999999-9999-7000-8000-000000000001',
        checkpoint_n: 1,
        open_tree_sha: 'a'.repeat(40),
        close_tree_sha: 'b'.repeat(40),
        status: 'captured',
        hunk_count: 1,
        captured_hunk_count: 1,
        truncated: false,
        error_reason: null,
        normalization_version: 'orcaops-line-normalization-v1',
        diff_algorithm: 'git-diff-unified-v1',
        diff_options: { unified: 3, find_renames: true, no_ext_diff: true },
        limits: { max_diff_bytes: 2_000_000 },
        hash_encoding: 'base64url-nopad',
        line_hash_algorithm: 'blake3-xof-96-base64url-nopad-v2',
        patch_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
        hunk_header_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
        manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
        // One enormous hunk so we definitely spill (lots of redundant data).
        hunks: [
          {
            hunk_index: 0,
            file_before: 'src/foo.ts',
            file_after: 'src/foo.ts',
            change_type: 'modify',
            binary: false,
            old_start: 1,
            old_lines: 100,
            new_start: 1,
            new_lines: 100,
            patch_hash: 'p'.repeat(64),
            added_line_hashes: Array.from({ length: 200 }, (_y, j) => `add-${j}`.padEnd(32, 'a')),
            deleted_line_hashes: Array.from({ length: 200 }, (_y, j) => `del-${j}`.padEnd(32, 'd')),
            hunk_header_hash: 'h'.repeat(32),
            added_line_count: 200,
            deleted_line_count: 200,
          },
        ],
      };
      const close = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'cp-fp-corrupt-close',
          payload: closePayload,
        },
        opts
      );
      // Mutate the sidecar on disk to corrupt the SHA-256 integrity check.
      expect('sidecar_sha256' in close).toBe(true);
      const sidecarPath = path.join(opts.sidecarsDir, `${close.event_id}.json`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(sidecarPath, '{"corrupted":true}', 'utf8');
      // readEventLog's integrity check drops the close event entirely.
      const { readEventLog } = await import('./event-log.js');
      const reloaded = await readEventLog({
        eventLogPath: opts.eventLogPath,
        sidecarsDir: opts.sidecarsDir,
      });
      const validRecords = reloaded.events.filter((r) => r.event_id !== close.event_id);
      const reloadedOpen = validRecords.find((r) => r.event_id === open.event_id);
      expect(reloadedOpen).toBeDefined();
      const corrupt = reloaded.corrupt.find((c) => c.event_id === close.event_id);
      expect(corrupt).toBeDefined();
      // Rebuilder degrades to open-only (the close is missing).
      const loaded = await loadEventsWithPayloads([open], { sidecarsDir: opts.sidecarsDir });
      const result = rebuildCheckpointFromEvents(loaded, 1);
      if (!result || result.checkpoint.status !== 'open') {
        throw new Error('expected open (close was corrupted)');
      }
      expect(result.checkpoint.status).toBe('open');
    });
  });

  // ── summary ──────────────────────────────────────────────────────

  describe('rebuildSummaryFromEvents', () => {
    it('returns null without a summary_captured event', async () => {
      const loaded = await loadEventsWithPayloads([], { sidecarsDir: opts.sidecarsDir });
      expect(rebuildSummaryFromEvents(loaded)).toBeNull();
    });

    it('reconstructs from the latest summary_captured event', async () => {
      const ev = await appendEvent(
        {
          type: 'summary_captured',
          ts: '2026-04-26T12:30:00.000Z',
          idempotency_key: 'sum-1',
          payload: {
            schema_version: 1,
            artifact_id: '01999999-9999-7000-8000-000000000001',
            outcome: 'shipped',
            tests_written: ['a.test.ts'],
            tests_run: ['a'],
            open_items: [],
            deferred_decisions: [],
            head_sha: 'def',
            ts: '2026-04-26T12:30:00.000Z',
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([ev], { sidecarsDir: opts.sidecarsDir });
      const result = rebuildSummaryFromEvents(loaded);
      expect(result!.summary.outcome).toBe('shipped');
      expect(result!.summary.source_event_id).toBe(ev.event_id);
    });
  });

  // ── evaluator log ────────────────────────────────────────────────

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
      error: { code: string; message: string };
    }> = {}
  ) {
    // Spread overrides last so callers can override individual
    // fields including with `null` for verdict — `??` would coalesce
    // through null and re-default to 'violation'.
    const base = {
      schema: 'orcaops.evaluator_run/v1' as const,
      run_id: `run-${Math.random().toString(36).slice(2, 10)}`,
      artifact_id: '01HXART0000000000000000000',
      evaluator_ref: 'core/api-stability',
      package_id: 'core',
      evaluator_id: 'api-stability',
      phase: 'checkpoint-close' as const,
      severity: 'block' as const,
      run_status: 'completed' as const,
      verdict: 'violation' as 'pass' | 'violation' | 'info' | null,
      body: 'VIOLATION\n\nbreaks API',
      ts: '2026-05-12T20:30:00.000Z',
    };
    return {
      ...base,
      ...overrides,
      ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    };
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
    return {
      schema: 'orcaops.evaluator_disposition/v1' as const,
      disposition_id: overrides.disposition_id ?? `dis-${Math.random().toString(36).slice(2, 10)}`,
      artifact_id: '01HXART0000000000000000000',
      run_id: overrides.run_id ?? 'run-1',
      evaluator_ref: overrides.evaluator_ref ?? 'core/api-stability',
      disposition: overrides.disposition ?? 'acknowledged',
      reason: overrides.reason ?? 'ack',
      agent_session_id: null,
      ts: overrides.ts ?? '2026-05-12T20:35:00.000Z',
    };
  }

  describe('rebuildEvaluatorLogFromEvents', () => {
    it('returns null with no evaluator-related events', async () => {
      const loaded = await loadEventsWithPayloads([], { sidecarsDir: opts.sidecarsDir });
      expect(rebuildEvaluatorLogFromEvents(loaded, 'a-1')).toBeNull();
    });

    it('folds standalone evaluator_run_recorded events into runs[] with order_key', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'run-1' }),
        },
        opts
      );
      const e2 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:31:00.000Z',
          idempotency_key: 'ev-2',
          payload: makeRunPayload({ run_id: 'run-2', evaluator_ref: 'core/plan-mentions' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1, e2], { sidecarsDir: opts.sidecarsDir });
      const r = rebuildEvaluatorLogFromEvents(loaded, 'a-1');
      expect(r).not.toBeNull();
      expect(r!.log.runs).toHaveLength(2);
      expect(r!.log.runs[0].source_event_index).toBe(0);
      expect(r!.log.runs[0].local_kind_rank).toBe(0);
      expect(r!.log.runs[1].source_event_index).toBe(1);
      expect(r!.sourceEventId).toBe(e2.event_id);
    });

    it('materializes disposition as `unresolved` for a blocking-eligible run with no disposition row', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'run-1' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1], { sidecarsDir: opts.sidecarsDir });
      const r = rebuildEvaluatorLogFromEvents(loaded, 'a-1');
      expect(r!.log.runs[0].disposition).toBe('unresolved');
    });

    it('materializes disposition as the disposition row when one targets the run', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'run-1' }),
        },
        opts
      );
      const e2 = await appendEvent(
        {
          type: 'evaluator_disposition_recorded',
          ts: '2026-05-12T20:35:00.000Z',
          idempotency_key: 'ev-2',
          payload: makeDispositionPayload({ run_id: 'run-1', disposition: 'acknowledged' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1, e2], { sidecarsDir: opts.sidecarsDir });
      const r = rebuildEvaluatorLogFromEvents(loaded, 'a-1');
      expect(r!.log.runs[0].disposition).toBe('acknowledged');
      expect(r!.log.dispositions).toHaveLength(1);
      expect(r!.log.dispositions[0].source_event_index).toBe(1);
      expect(r!.log.dispositions[0].local_kind_rank).toBe(1);
    });

    it('materializes disposition as null for non-blocking-eligible runs (pass)', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({
            run_id: 'run-1',
            verdict: 'pass',
            body: 'PASS',
          }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1], { sidecarsDir: opts.sidecarsDir });
      const r = rebuildEvaluatorLogFromEvents(loaded, 'a-1');
      expect(r!.log.runs[0].disposition).toBeNull();
    });

    it('materializes disposition as null for errored runs even with severity=block', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({
            run_id: 'run-1',
            run_status: 'error',
            verdict: null,
            body: 'ERROR',
            error: { code: 'TIMEOUT', message: 'engine.timeout_ms exceeded' },
          }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1], { sidecarsDir: opts.sidecarsDir });
      const r = rebuildEvaluatorLogFromEvents(loaded, 'a-1');
      expect(r!.log.runs[0].disposition).toBeNull();
    });

    it('unfolds checkpoint_opened.gate_audit.runs[] with order_key (i, 0, n)', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'cp-open',
          payload: {
            artifact_id: '01HXART0000000000000000000',
            n: 1,
            declared_step_ids: ['step-1'],
            opened_at: '2026-05-12T20:30:00.000Z',
            head_sha: 'deadbeef',
            gate_audit: {
              runs: [
                {
                  run_id: 'gate-run-1',
                  evaluator_ref: 'core/checkpoint-scope-density',
                  phase: 'checkpoint-open',
                  severity: 'block',
                  run_status: 'completed',
                  verdict: 'violation',
                  body: 'VIOLATION',
                  ts: '2026-05-12T20:30:00.000Z',
                },
                {
                  run_id: 'gate-run-2',
                  evaluator_ref: 'core/other',
                  phase: 'checkpoint-open',
                  severity: 'warn',
                  run_status: 'completed',
                  verdict: 'pass',
                  body: 'PASS',
                  ts: '2026-05-12T20:30:00.000Z',
                },
              ],
              dispositions: [
                {
                  disposition_id: 'gate-dis-1',
                  run_id: 'gate-run-1',
                  evaluator_ref: 'core/checkpoint-scope-density',
                  disposition: 'policy-excepted',
                  reason: 'intentional batching',
                  ts: '2026-05-12T20:30:00.000Z',
                },
              ],
            },
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open], { sidecarsDir: opts.sidecarsDir });
      const r = rebuildEvaluatorLogFromEvents(loaded, 'a-1');
      expect(r!.log.runs).toHaveLength(2);
      // local_index reflects the unfold position within gate_audit.runs[].
      expect(r!.log.runs[0].run_id).toBe('gate-run-1');
      expect(r!.log.runs[0].local_index).toBe(0);
      expect(r!.log.runs[1].run_id).toBe('gate-run-2');
      expect(r!.log.runs[1].local_index).toBe(1);
      // Parent-derived fields synthesized: checkpoint_n + package_id + evaluator_id.
      expect(r!.log.runs[0].checkpoint_n).toBe(1);
      expect(r!.log.runs[0].package_id).toBe('core');
      expect(r!.log.runs[0].evaluator_id).toBe('checkpoint-scope-density');
      // The policy-excepted disposition materializes on its target run.
      expect(r!.log.runs[0].disposition).toBe('policy-excepted');
      // The non-violation run (warn/pass) is not blocking-eligible.
      expect(r!.log.runs[1].disposition).toBeNull();
    });
  });

  // ── block-state derivation via the openBlockByRef walk ──────────────

  describe('computeOpenBlocksByRef', () => {
    it('an empty event log yields no open blocks', async () => {
      const loaded = await loadEventsWithPayloads([], { sidecarsDir: opts.sidecarsDir });
      expect(computeOpenBlocksByRef(loaded).size).toBe(0);
    });

    it('a violating run opens a block for its ref', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'r1' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1], { sidecarsDir: opts.sidecarsDir });
      expect(computeOpenBlocksByRef(loaded).has('core/api-stability')).toBe(true);
    });

    it('a subsequent pass run clears the block', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'r1' }),
        },
        opts
      );
      const e2 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:31:00.000Z',
          idempotency_key: 'ev-2',
          payload: makeRunPayload({ run_id: 'r2', verdict: 'pass', body: 'PASS' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1, e2], { sidecarsDir: opts.sidecarsDir });
      expect(computeOpenBlocksByRef(loaded).size).toBe(0);
    });

    it('an acknowledgement targeting the current run clears the block', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'r1' }),
        },
        opts
      );
      const e2 = await appendEvent(
        {
          type: 'evaluator_disposition_recorded',
          ts: '2026-05-12T20:35:00.000Z',
          idempotency_key: 'ev-2',
          payload: makeDispositionPayload({ run_id: 'r1', disposition: 'acknowledged' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1, e2], { sidecarsDir: opts.sidecarsDir });
      expect(computeOpenBlocksByRef(loaded).size).toBe(0);
    });

    it('a stale-targeted disposition does NOT clear the current block', async () => {
      // r1 violates → block. r2 violates (supersedes r1) → block still on.
      // Disposition targets r1 (stale): no effect on block state.
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'r1' }),
        },
        opts
      );
      const e2 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:31:00.000Z',
          idempotency_key: 'ev-2',
          payload: makeRunPayload({ run_id: 'r2' }),
        },
        opts
      );
      const e3 = await appendEvent(
        {
          type: 'evaluator_disposition_recorded',
          ts: '2026-05-12T20:35:00.000Z',
          idempotency_key: 'ev-3',
          payload: makeDispositionPayload({ run_id: 'r1', disposition: 'acknowledged' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1, e2, e3], {
        sidecarsDir: opts.sidecarsDir,
      });
      expect(computeOpenBlocksByRef(loaded).has('core/api-stability')).toBe(true);
    });

    it('a block evaluator error supersedes a violation and remains blocking through a skip', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'r1' }),
        },
        opts
      );
      const e2 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:31:00.000Z',
          idempotency_key: 'ev-2',
          payload: makeRunPayload({
            run_id: 'r2',
            run_status: 'error',
            verdict: null,
            body: 'ERROR',
            error: { code: 'TIMEOUT', message: 'timed out' },
          }),
        },
        opts
      );
      const e3 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:32:00.000Z',
          idempotency_key: 'ev-3',
          payload: makeRunPayload({
            run_id: 'r3',
            run_status: 'skipped',
            verdict: null,
            body: 'SKIPPED',
          }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1, e2, e3], {
        sidecarsDir: opts.sidecarsDir,
      });
      expect(computeOpenBlocksByRef(loaded).has('core/api-stability')).toBe(true);
    });

    it('a block evaluator error opens a block and a later pass clears it', async () => {
      const errorRun = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({
            run_id: 'r1',
            run_status: 'error',
            verdict: null,
            body: 'ERROR',
            error: { code: 'TIMEOUT', message: 'timed out' },
          }),
        },
        opts
      );
      const passingRun = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:31:00.000Z',
          idempotency_key: 'ev-2',
          payload: makeRunPayload({ run_id: 'r2', verdict: 'pass', body: 'PASS' }),
        },
        opts
      );

      const errored = await loadEventsWithPayloads([errorRun], {
        sidecarsDir: opts.sidecarsDir,
      });
      expect(computeOpenBlocksByRef(errored).has('core/api-stability')).toBe(true);

      const recovered = await loadEventsWithPayloads([errorRun, passingRun], {
        sidecarsDir: opts.sidecarsDir,
      });
      expect(computeOpenBlocksByRef(recovered).size).toBe(0);
    });

    it('a disposition cannot clear the current block evaluator error', async () => {
      const violationRun = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'r1' }),
        },
        opts
      );
      const errorRun = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:31:00.000Z',
          idempotency_key: 'ev-2',
          payload: makeRunPayload({
            run_id: 'r2',
            run_status: 'error',
            verdict: null,
            body: 'ERROR',
            error: { code: 'TIMEOUT', message: 'timed out' },
          }),
        },
        opts
      );
      const staleDisposition = await appendEvent(
        {
          type: 'evaluator_disposition_recorded',
          ts: '2026-05-12T20:32:00.000Z',
          idempotency_key: 'ev-3',
          payload: makeDispositionPayload({ run_id: 'r1', disposition: 'dismissed' }),
        },
        opts
      );

      const loaded = await loadEventsWithPayloads([violationRun, errorRun, staleDisposition], {
        sidecarsDir: opts.sidecarsDir,
      });
      expect(computeOpenBlocksByRef(loaded).has('core/api-stability')).toBe(true);
    });

    it('a non-block severity violation does NOT trigger a block', async () => {
      const e1 = await appendEvent(
        {
          type: 'evaluator_run_recorded',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'ev-1',
          payload: makeRunPayload({ run_id: 'r1', severity: 'warn' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([e1], { sidecarsDir: opts.sidecarsDir });
      expect(computeOpenBlocksByRef(loaded).size).toBe(0);
    });

    it('gate_audit unfold contributes to block state', async () => {
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'cp-open',
          payload: {
            artifact_id: '01HXART0000000000000000000',
            n: 1,
            declared_step_ids: ['step-1'],
            opened_at: '2026-05-12T20:30:00.000Z',
            head_sha: 'deadbeef',
            gate_audit: {
              runs: [
                {
                  run_id: 'gate-run-1',
                  evaluator_ref: 'core/scope-density',
                  phase: 'checkpoint-open',
                  severity: 'block',
                  run_status: 'completed',
                  verdict: 'violation',
                  body: 'VIOLATION',
                  ts: '2026-05-12T20:30:00.000Z',
                },
              ],
              dispositions: [],
            },
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open], { sidecarsDir: opts.sidecarsDir });
      expect(computeOpenBlocksByRef(loaded).has('core/scope-density')).toBe(true);
    });

    it('within one event, a gate_audit policy-exception (sorted AFTER runs) clears its target', async () => {
      // Same gate_audit: r1 violates + d1 (policy-excepted, run_id=r1).
      // order_key ordering puts runs first (local_kind_rank=0) then
      // dispositions (1), so the disposition sees r1 in
      // openBlockByRef and clears it.
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-05-12T20:30:00.000Z',
          idempotency_key: 'cp-open',
          payload: {
            artifact_id: '01HXART0000000000000000000',
            n: 1,
            declared_step_ids: ['step-1'],
            opened_at: '2026-05-12T20:30:00.000Z',
            head_sha: 'deadbeef',
            gate_audit: {
              runs: [
                {
                  run_id: 'gate-run-1',
                  evaluator_ref: 'core/scope-density',
                  phase: 'checkpoint-open',
                  severity: 'block',
                  run_status: 'completed',
                  verdict: 'violation',
                  body: 'VIOLATION',
                  ts: '2026-05-12T20:30:00.000Z',
                },
              ],
              dispositions: [
                {
                  disposition_id: 'gate-dis-1',
                  run_id: 'gate-run-1',
                  evaluator_ref: 'core/scope-density',
                  disposition: 'policy-excepted',
                  reason: 'intentional',
                  ts: '2026-05-12T20:30:00.000Z',
                },
              ],
            },
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([open], { sidecarsDir: opts.sidecarsDir });
      expect(computeOpenBlocksByRef(loaded).size).toBe(0);
    });
  });

  // ── artifact.json ────────────────────────────────────────────────

  describe('rebuildArtifactJsonFromEvents', () => {
    it('returns null when there is no plan_captured event', async () => {
      const loaded = await loadEventsWithPayloads([], { sidecarsDir: opts.sidecarsDir });
      expect(rebuildArtifactJsonFromEvents(loaded)).toBeNull();
    });

    it('seeds artifact metadata from plan_captured (state=planned, lineage=created)', async () => {
      const ev = await appendEvent(
        {
          type: 'plan_captured',
          ts: '2026-04-26T12:00:00.000Z',
          idempotency_key: 'plan-1',
          payload: {
            schema_version: 4,
            artifact_id: '01999999-9999-7000-8000-000000000001',
            branch: 'main',
            base_sha: 'abc123',
            agent: 'claude-code',
            agent_session_id: 'sess-1',
            task: 't',
            label: 'sess1-plan',
            plan_steps: [{ step_id: 'step-1', text: 's', label: 'step-1' }],
            touched_scope: [],
            started_at: '2026-04-26T12:00:00.000Z',
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([ev], { sidecarsDir: opts.sidecarsDir });
      const result = rebuildArtifactJsonFromEvents(loaded);
      expect(result!.json).toMatchObject({
        schema_version: 1,
        id: '01999999-9999-7000-8000-000000000001',
        state: 'planned',
        branch_lineage: [
          { branch: 'main', head_sha: 'abc123', ts: '2026-04-26T12:00:00.000Z', event: 'created' },
        ],
        created_by_session_id: 'sess-1',
        created_at: '2026-04-26T12:00:00.000Z',
        updated_at: '2026-04-26T12:00:00.000Z',
        checkpoint_count: 0,
      });
      expect(result!.json.source_event_id).toBe(ev.event_id);
    });

    const rebuildWithPin = async (sourcePlan: unknown) => {
      const ev = await appendPlanEvent(opts, '01999999-9999-7000-8000-000000000002', {
        source_plan: sourcePlan,
      });
      const loaded = await loadEventsWithPayloads([ev], { sidecarsDir: opts.sidecarsDir });
      return rebuildArtifactJsonFromEvents(loaded)!;
    };

    it('rejects a pin missing the persisted baseline field', async () => {
      await expect(
        rebuildWithPin({
          source_ref: { kind: 'local', locator: 'docs/plan.md' },
          content: 'plan text',
          hash: 'deadbeef',
        })
      ).rejects.toThrow(/baseline/);
    });

    it('projects a populated pin baseline intact', async () => {
      const baseline = {
        repo_url: 'https://github.com/acme/widgets',
        branch: 'main',
        head_sha: 'a'.repeat(40),
      };
      const result = await rebuildWithPin({
        source_ref: { kind: 'local', locator: 'docs/plan.md' },
        content: 'plan text',
        hash: 'deadbeef',
        baseline,
      });
      expect(result.json.source_plan!.baseline).toEqual(baseline);
    });

    it('rejects a wrong-typed persisted pin baseline', async () => {
      await expect(
        rebuildWithPin({
          source_ref: { kind: 'local', locator: 'docs/plan.md' },
          content: 'plan text',
          hash: 'deadbeef',
          baseline: 'main@abc',
        })
      ).rejects.toThrow(/baseline/);
    });

    it('rejects a partial persisted pin baseline', async () => {
      await expect(
        rebuildWithPin({
          source_ref: { kind: 'local', locator: 'docs/plan.md' },
          content: 'plan text',
          hash: 'deadbeef',
          baseline: { review_head_sha: 'abc123' },
        })
      ).rejects.toThrow(/baseline/);
    });

    it('rejects a persisted pin with a malformed anchor', async () => {
      await expect(
        rebuildWithPin({
          source_ref: { kind: 'local', locator: 'docs/plan.md' },
          content: 42,
          hash: 'deadbeef',
          baseline: null,
        })
      ).rejects.toThrow(/content/);
    });

    it('pre_pr_checked sets the passed-marker fields, pinned to the event id (current)', async () => {
      const planEv = await appendPlanEvent(opts, '01999999-9999-7000-8000-000000000001');
      const prePr = await appendEvent(
        {
          type: 'pre_pr_checked',
          ts: '2026-04-26T13:00:00.000Z',
          idempotency_key: 'prepr-1',
          payload: { head_sha: 'head-abc', ts: '2026-04-26T13:00:00.000Z' },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([planEv, prePr], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildArtifactJsonFromEvents(loaded)!;
      expect(result.json.pre_pr_checked_head_sha).toBe('head-abc');
      expect(result.json.pre_pr_checked_source_event_id).toBe(prePr.event_id);
      // Current: marker's source_event_id equals the projection's latest.
      expect(result.json.source_event_id).toBe(prePr.event_id);
    });

    it('retains a warning review without advancing the passed marker', async () => {
      const planEv = await appendPlanEvent(opts, '01999999-9999-7000-8000-000000000001');
      const prePr = await appendEvent(
        {
          type: 'pre_pr_checked',
          ts: '2026-04-26T13:00:00.000Z',
          idempotency_key: 'prepr-warn',
          payload: {
            head_sha: 'head-abc',
            ts: '2026-04-26T13:00:00.000Z',
            outcome: 'needs_attention',
            evaluator_set_fingerprint: 'a'.repeat(64),
            review_context_fingerprint: 'b'.repeat(64),
            run_ids: ['run-a', 'run-b'],
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([planEv, prePr], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildArtifactJsonFromEvents(loaded)!;
      expect(result.json.pre_pr_checked_head_sha).toBeNull();
      expect(result.json.pre_pr_checked_source_event_id).toBeNull();
      expect(result.json.source_event_id).toBe(prePr.event_id);
    });

    it('a later event makes the pre-pr marker stale (source_event_id moves past it)', async () => {
      const planEv = await appendPlanEvent(opts, '01999999-9999-7000-8000-000000000001');
      const prePr = await appendEvent(
        {
          type: 'pre_pr_checked',
          ts: '2026-04-26T13:00:00.000Z',
          idempotency_key: 'prepr-1',
          payload: { head_sha: 'head-abc', ts: '2026-04-26T13:00:00.000Z' },
        },
        opts
      );
      const later = await appendEvent(
        {
          type: 'branch_lineage_updated',
          ts: '2026-04-26T13:05:00.000Z',
          idempotency_key: 'lin-1',
          payload: {
            branch: 'main',
            head_sha: 'head-def',
            ts: '2026-04-26T13:05:00.000Z',
            event: 'rebased',
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([planEv, prePr, later], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildArtifactJsonFromEvents(loaded)!;
      // Marker stays pinned to the pre_pr_checked event...
      expect(result.json.pre_pr_checked_source_event_id).toBe(prePr.event_id);
      // ...but the projection advanced → stale.
      expect(result.json.source_event_id).toBe(later.event_id);
      expect(result.json.source_event_id).not.toBe(result.json.pre_pr_checked_source_event_id);
    });

    it('moves to state=active and increments checkpoint_count on checkpoint_closed', async () => {
      const planEv = await appendPlanEvent(opts, '01999999-9999-7000-8000-000000000001');
      const [open, close] = await openClosePair(opts, { n: 1, summary: 'one' });
      const loaded = await loadEventsWithPayloads([planEv, open, close], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildArtifactJsonFromEvents(loaded);
      expect(result!.json.state).toBe('active');
      expect(result!.json.checkpoint_count).toBe(1);
      expect(result!.json.updated_at).toBe(close.ts);
      expect(result!.json.source_event_id).toBe(close.event_id);
    });

    it('counts repeated cp.n only once (idempotent replay does not double-count)', async () => {
      const planEv = await appendPlanEvent(opts, '01999999-9999-7000-8000-000000000001');
      const open = await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-04-26T11:59:00.000Z',
          idempotency_key: 'cp-1-open',
          payload: makeOpenPayload({ n: 1 }),
        },
        opts
      );
      const cp1a = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:01:00.000Z',
          idempotency_key: 'cp-1-a',
          payload: makeCheckpointPayload({ n: 1, summary: 'first try' }),
        },
        opts
      );
      const cp1b = await appendEvent(
        {
          type: 'checkpoint_closed',
          ts: '2026-04-26T12:02:00.000Z',
          idempotency_key: 'cp-1-b',
          payload: makeCheckpointPayload({ n: 1, summary: 'amended' }),
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([planEv, open, cp1a, cp1b], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildArtifactJsonFromEvents(loaded);
      expect(result!.json.checkpoint_count).toBe(1);
    });

    it('appends branch_lineage_updated events to artifact.branch_lineage', async () => {
      const planEv = await appendPlanEvent(opts, '01999999-9999-7000-8000-000000000001');
      const lineageEv = await appendEvent(
        {
          type: 'branch_lineage_updated',
          ts: '2026-04-26T12:30:00.000Z',
          idempotency_key: 'sync-1',
          payload: {
            branch: 'main',
            head_sha: 'sha-merge',
            ts: '2026-04-26T12:30:00.000Z',
            event: 'merged',
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([planEv, lineageEv], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildArtifactJsonFromEvents(loaded);
      expect(result!.json.branch_lineage).toHaveLength(2);
      expect(result!.json.branch_lineage[1]).toMatchObject({
        branch: 'main',
        head_sha: 'sha-merge',
        event: 'merged',
      });
      expect(result!.json.source_event_id).toBe(lineageEv.event_id);
    });

    it('de-duplicates lineage entries with identical (branch, head_sha, event)', async () => {
      const planEv = await appendPlanEvent(opts, '01999999-9999-7000-8000-000000000001');
      const lineageEntry = {
        branch: 'feat/x',
        head_sha: 'sha-rebased',
        ts: '2026-04-26T12:30:00.000Z',
        event: 'rebased' as const,
      };
      const e1 = await appendEvent(
        {
          type: 'branch_lineage_updated',
          ts: lineageEntry.ts,
          idempotency_key: 'sync-1',
          payload: lineageEntry,
        },
        opts
      );
      const e2 = await appendEvent(
        {
          type: 'branch_lineage_updated',
          ts: '2026-04-26T12:31:00.000Z',
          idempotency_key: 'sync-2',
          payload: lineageEntry,
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([planEv, e1, e2], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildArtifactJsonFromEvents(loaded);
      // Two events, but only one row past the seed.
      expect(result!.json.branch_lineage).toHaveLength(2);
    });

    it('moves to state=summarized on summary_captured', async () => {
      const planEv = await appendPlanEvent(opts, '01999999-9999-7000-8000-000000000001');
      const sumEv = await appendEvent(
        {
          type: 'summary_captured',
          ts: '2026-04-26T13:00:00.000Z',
          idempotency_key: 'sum-1',
          payload: {
            schema_version: 1,
            artifact_id: '01999999-9999-7000-8000-000000000001',
            outcome: 'shipped',
            tests_written: [],
            tests_run: [],
            open_items: [],
            deferred_decisions: [],
            head_sha: 'def',
            ts: '2026-04-26T13:00:00.000Z',
          },
        },
        opts
      );
      const loaded = await loadEventsWithPayloads([planEv, sumEv], {
        sidecarsDir: opts.sidecarsDir,
      });
      const result = rebuildArtifactJsonFromEvents(loaded);
      expect(result!.json.state).toBe('summarized');
      expect(result!.json.updated_at).toBe('2026-04-26T13:00:00.000Z');
    });
  });
});

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Convenience helper that returns the close-event payload shape — most
 * tests want the close-time fields on the resulting projection. Tests
 * that need the open shape construct it inline.
 */
function makeCheckpointPayload(over: {
  n: number;
  summary?: string;
  completed?: string[];
  closedByAgent?: string;
}): Record<string, unknown> {
  return {
    artifact_id: '01999999-9999-7000-8000-000000000001',
    n: over.n,
    summary: over.summary ?? 'sum',
    files_changed: [],
    decisions: [],
    uncertainty: [],
    done_criteria: [],
    completed_step_ids: over.completed ?? [],
    closed_by_agent: over.closedByAgent ?? 'other',
    head_sha: 'abc',
    ts: '2026-04-26T12:00:00.000Z',
    // v4 required fields. Tests that don't supply real snapshot data
    // get the deliberate-skip representation (matches what the storage
    // write path injects when no snapshotCallbacks is supplied).
    close_snapshot: buildDefaultSkippedSnapshotBoundary(),
    diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
  };
}

function makeOpenPayload(over: {
  n: number;
  declared?: string[];
  agent?: string;
}): Record<string, unknown> {
  return {
    artifact_id: '01999999-9999-7000-8000-000000000001',
    n: over.n,
    declared_step_ids: over.declared ?? [`step-${over.n}`],
    agent: over.agent ?? 'other',
    policy_exceptions: [],
    plan_revision_id: null,
    open_plan_revision_event_id: 'evt-plan-0',
    opened_at: '2026-04-26T11:59:00.000Z',
    head_sha: 'abc',
    // v4 required field.
    open_snapshot: buildDefaultSkippedSnapshotBoundary(),
  };
}

/**
 * Test helper: append a `checkpoint_opened` + `checkpoint_closed` pair
 * for the given `n`. Returns both event records in append order.
 */
async function openClosePair(
  o: AppendEventOptions,
  spec: { n: number; summary?: string; declared?: string[]; completed?: string[] }
) {
  const open = await appendEvent(
    {
      type: 'checkpoint_opened',
      ts: '2026-04-26T11:59:00.000Z',
      idempotency_key: `cp-${spec.n}-open`,
      payload: makeOpenPayload({ n: spec.n, declared: spec.declared }),
    },
    o
  );
  const close = await appendEvent(
    {
      type: 'checkpoint_closed',
      ts: '2026-04-26T12:00:00.000Z',
      idempotency_key: `cp-${spec.n}-close`,
      payload: makeCheckpointPayload({
        n: spec.n,
        summary: spec.summary,
        completed: spec.completed,
      }),
    },
    o
  );
  return [open, close];
}

async function appendPlanEvent(
  opts: AppendEventOptions,
  artifactId: string,
  extra: Record<string, unknown> = {}
): Promise<Awaited<ReturnType<typeof appendEvent>>> {
  return appendEvent(
    {
      type: 'plan_captured',
      ts: '2026-04-26T12:00:00.000Z',
      idempotency_key: 'plan-1',
      payload: {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'main',
        base_sha: 'abc',
        agent: 'claude-code',
        agent_session_id: null,
        task: 't',
        label: 'helper-plan',
        plan_steps: [{ step_id: 'step-1', text: 's', label: 'step-1' }],
        touched_scope: [],
        started_at: '2026-04-26T12:00:00.000Z',
        ...extra,
      },
    },
    opts
  );
}
