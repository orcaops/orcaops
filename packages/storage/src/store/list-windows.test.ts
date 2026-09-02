import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from './sqlite.js';

/**
 * `listArtifacts` / `listArtifactsByLineageBranch` time windows.
 *
 * `since`/`until` bound `started_at`. `activeSince`/`activeUntil` use
 * INTERVAL-OVERLAP semantics: a checkpoint occupies
 * `[opened_at, COALESCE(closed_at, abandoned_at)]`, a NULL end = still open;
 * an artifact matches iff a checkpoint interval overlaps the window, OR its
 * summary `ts` falls inside it, OR its `started_at` does. The seeded
 * timestamps below pin exactly the cases the semantics were chosen for —
 * including the ones a live E2E repo cannot reproduce without backdating.
 */

// Three consecutive UTC days.
const D1 = '2026-06-29';
const D2 = '2026-06-30';
const D3 = '2026-07-01';
const dayStart = (d: string): string => `${d}T00:00:00.000Z`;
const dayEnd = (d: string): string => `${d}T23:59:59.999Z`;

describe('artifact list time windows', () => {
  let tmpRoot: string;
  let store: Store;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-list-windows-'));
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function seedArtifact(id: string, startedAt: string): void {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id,
      branch: 'main',
      task: `task ${id}`,
      agent: 'claude-code',
      base_sha: 'deadbeef',
      started_at: startedAt,
      completed_at: null,
      status: 'active',
    });
  }

  function seedClosedCp(artifactId: string, n: number, openedAt: string, closedAt: string): void {
    store.upsertCheckpoint({
      status: 'closed',
      artifact_id: artifactId,
      n,
      declared_step_ids: [`step-${artifactId}-${n}`],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: openedAt,
      closed_at: closedAt,
      summary: 'work',
      files_changed: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: 'cafef00d',
    });
  }

  function seedOpenCp(artifactId: string, n: number, openedAt: string): void {
    store.upsertCheckpoint({
      status: 'open',
      artifact_id: artifactId,
      n,
      declared_step_ids: [`step-${artifactId}-${n}`],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: openedAt,
      head_sha: 'cafef00d',
    });
  }

  function seedSummary(artifactId: string, ts: string): void {
    store.upsertSummary({
      artifact_id: artifactId,
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      ts,
    });
  }

  function ids(rows: Array<{ id: string }>): string[] {
    return rows.map((r) => r.id).sort();
  }

  describe('since/until (started_at bounds)', () => {
    it('filters lower, upper, and both-bounded', () => {
      seedArtifact('a-d1', `${D1}T10:00:00.000Z`);
      seedArtifact('a-d2', `${D2}T10:00:00.000Z`);
      seedArtifact('a-d3', `${D3}T10:00:00.000Z`);

      expect(ids(store.listArtifacts({ since: dayStart(D2) }))).toEqual(['a-d2', 'a-d3']);
      expect(ids(store.listArtifacts({ until: dayEnd(D2) }))).toEqual(['a-d1', 'a-d2']);
      expect(ids(store.listArtifacts({ since: dayStart(D2), until: dayEnd(D2) }))).toEqual([
        'a-d2',
      ]);
    });
  });

  describe('activeSince/activeUntil (interval overlap)', () => {
    it('started before the window but active within it → matches', () => {
      seedArtifact('a-old', `${D1}T08:00:00.000Z`);
      seedClosedCp('a-old', 1, `${D2}T10:00:00.000Z`, `${D2}T11:00:00.000Z`);

      const rows = store.listArtifacts({ activeSince: dayStart(D2), activeUntil: dayEnd(D2) });
      expect(ids(rows)).toEqual(['a-old']);
      // The same artifact is OUTSIDE the plain started_at window — the two
      // filters are genuinely different.
      expect(store.listArtifacts({ since: dayStart(D2), until: dayEnd(D2) })).toEqual([]);
    });

    it('active yesterday AND today → matches a yesterday-only window (interval spans both)', () => {
      // A MAX(activity)-bounds implementation would exclude this artifact:
      // its latest activity (D3) is outside the D2 window. The interval
      // [D2T10, D3T10] overlaps the D2 window, so it must match.
      seedArtifact('a-span', `${D1}T08:00:00.000Z`);
      seedClosedCp('a-span', 1, `${D2}T10:00:00.000Z`, `${D3}T10:00:00.000Z`);

      const rows = store.listArtifacts({ activeSince: dayStart(D2), activeUntil: dayEnd(D2) });
      expect(ids(rows)).toEqual(['a-span']);
    });

    it('checkpoint opened yesterday and STILL OPEN → matches a today-only window (null end)', () => {
      // The case a live E2E repo cannot reproduce without backdating: a
      // point-event EXISTS has no event inside the D3 window, but the open
      // interval [D2T10, ∞) overlaps it — in-flight work IS activity.
      seedArtifact('a-inflight', `${D1}T08:00:00.000Z`);
      seedOpenCp('a-inflight', 1, `${D2}T10:00:00.000Z`);

      const rows = store.listArtifacts({ activeSince: dayStart(D3), activeUntil: dayEnd(D3) });
      expect(ids(rows)).toEqual(['a-inflight']);
    });

    it('closed before the window → excluded', () => {
      seedArtifact('a-done', `${D1}T08:00:00.000Z`);
      seedClosedCp('a-done', 1, `${D1}T10:00:00.000Z`, `${D1}T11:00:00.000Z`);

      const rows = store.listArtifacts({ activeSince: dayStart(D2), activeUntil: dayEnd(D2) });
      expect(rows).toEqual([]);
    });

    it('summary ts inside the window → matches (no checkpoint in window)', () => {
      seedArtifact('a-summarized', `${D1}T08:00:00.000Z`);
      seedClosedCp('a-summarized', 1, `${D1}T10:00:00.000Z`, `${D1}T11:00:00.000Z`);
      seedSummary('a-summarized', `${D2}T12:00:00.000Z`);

      const rows = store.listArtifacts({ activeSince: dayStart(D2), activeUntil: dayEnd(D2) });
      expect(ids(rows)).toEqual(['a-summarized']);
    });

    it('started_at inside the window with no checkpoints → matches (plan capture is activity)', () => {
      seedArtifact('a-fresh', `${D2}T12:00:00.000Z`);

      const rows = store.listArtifacts({ activeSince: dayStart(D2), activeUntil: dayEnd(D2) });
      expect(ids(rows)).toEqual(['a-fresh']);
    });

    it('open-ended bounds: activeSince-only keeps open checkpoints; activeUntil-only bounds opens', () => {
      seedArtifact('a-open-old', `${D1}T08:00:00.000Z`);
      seedOpenCp('a-open-old', 1, `${D1}T09:00:00.000Z`);
      seedArtifact('a-closed-old', `${D1}T08:00:00.000Z`);
      seedClosedCp('a-closed-old', 1, `${D1}T09:00:00.000Z`, `${D1}T10:00:00.000Z`);

      // Lower bound only: the still-open interval [D1T09, ∞) reaches D3; the
      // closed one ended D1 and its artifact has no other D3 activity.
      expect(ids(store.listArtifacts({ activeSince: dayStart(D3) }))).toEqual(['a-open-old']);
      // Upper bound only: both opened before the D1 end → both match.
      expect(ids(store.listArtifacts({ activeUntil: dayEnd(D1) }))).toEqual([
        'a-closed-old',
        'a-open-old',
      ]);
    });

    it('abandoned_at terminates the interval like closed_at', () => {
      seedArtifact('a-abandoned', `${D1}T08:00:00.000Z`);
      store.upsertCheckpoint({
        status: 'abandoned',
        artifact_id: 'a-abandoned',
        n: 1,
        declared_step_ids: ['step-x'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: `${D1}T09:00:00.000Z`,
        abandoned_at: `${D1}T10:00:00.000Z`,
        reason: 'rescoped',
        head_sha: 'cafef00d',
      });

      expect(store.listArtifacts({ activeSince: dayStart(D2), activeUntil: dayEnd(D2) })).toEqual(
        []
      );
      expect(
        ids(store.listArtifacts({ activeSince: dayStart(D1), activeUntil: dayEnd(D1) }))
      ).toEqual(['a-abandoned']);
    });
  });

  describe('listArtifactsByLineageBranch mirrors the window semantics', () => {
    it('still-open checkpoint matches a today-only window; pre-window closed cp is excluded', () => {
      seedArtifact('a-br-open', `${D1}T08:00:00.000Z`);
      seedOpenCp('a-br-open', 1, `${D2}T10:00:00.000Z`);
      store.upsertLineageBranch({ artifact_id: 'a-br-open', branch_name: 'feat/x' });

      seedArtifact('a-br-done', `${D1}T08:00:00.000Z`);
      seedClosedCp('a-br-done', 1, `${D1}T09:00:00.000Z`, `${D1}T10:00:00.000Z`);
      store.upsertLineageBranch({ artifact_id: 'a-br-done', branch_name: 'feat/x' });

      const rows = store.listArtifactsByLineageBranch({
        branch: 'feat/x',
        activeSince: dayStart(D3),
        activeUntil: dayEnd(D3),
      });
      expect(ids(rows)).toEqual(['a-br-open']);

      // started_at windows thread through the same path.
      expect(store.listArtifactsByLineageBranch({ branch: 'feat/x', since: dayStart(D2) })).toEqual(
        []
      );
    });
  });
});
