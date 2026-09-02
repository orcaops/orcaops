import { readdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor } from './paths.js';
import { ArtifactStore } from './store.js';
import { appendEvent } from '../events/event-log.js';
import { type Config, getDefaultConfig } from '../schema/config.js';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  type DiffFingerprintManifest,
  type DiffFingerprintSummary,
} from '../schema/diff-fingerprint.js';

/**
 * Recovery-aware sync read helpers.
 *
 * `readCheckpointDiffFingerprint` loads the latest checkpoint_closed
 * manifest (inline or sidecar), returning null when the close event was
 * corrupt-dropped — the signal strict-sync needs.
 *
 * `readCheckpointsRecovered` mirrors the singular `readCheckpoint`'s
 * projection-backed recovery so a surviving checkpoint-N.json keeps the
 * cp `closed` even when its close-event sidecar is corrupt (the bug the
 * plain `readCheckpoints()` has).
 */
describe('ArtifactStore — fingerprint read helpers', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/x';
  const artifactId = '01999999-9999-7000-8000-0000000000f5';
  const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  // ── readCheckpointDiffFingerprint ────────────────────────────────

  it('returns the inline manifest of a closed cp', async () => {
    await writePlan('p-inline');
    await openCp('o-inline');
    await closeCp('c-inline', capturedManifest(1));

    const m = await store.readCheckpointDiffFingerprint(artifactId, 1);
    expect(m?.status).toBe('captured');
    expect(m?.hunk_count).toBe(1);
  });

  it('returns a sidecar-spilled manifest, resolved', async () => {
    await writePlan('p-spill');
    await openCp('o-spill');
    // ~900 line hashes → payload well past the 8 KB inline budget → sidecar.
    const big = capturedManifest(900);
    await closeCp('c-spill', big);

    const paths = artifactPathsFor(repo.path, config, artifactId);
    const closed = await store.readCheckpoint(artifactId, 1);
    const closedEventId = (closed as { source_event_ids?: { closed?: string } }).source_event_ids
      ?.closed;
    expect(closedEventId).toBeTruthy();
    // Prove it actually spilled (sidecar file exists for the close event).
    const sidecars = await readdir(paths.sidecarsDir);
    expect(sidecars).toContain(`${closedEventId}.json`);

    const m = await store.readCheckpointDiffFingerprint(artifactId, 1);
    expect(m?.hunk_count).toBe(1);
    expect(m?.hunks[0]?.added_line_hashes.length).toBe(900);
  });

  it('returns null for a skipped cp (no manifest field)', async () => {
    await writePlan('p-skip');
    await openCp('o-skip');
    await closeCp('c-skip', null, buildDefaultSkippedFingerprintSummary());

    expect(await store.readCheckpointDiffFingerprint(artifactId, 1)).toBeNull();
  });

  it('returns null for an open-only n (no close event)', async () => {
    await writePlan('p-open');
    await openCp('o-open');
    expect(await store.readCheckpointDiffFingerprint(artifactId, 1)).toBeNull();
  });

  it('returns null when the close-event sidecar is corrupt (strict-sync trigger)', async () => {
    await writePlan('p-corrupt');
    await openCp('o-corrupt');
    await closeCp('c-corrupt', capturedManifest(900)); // spills to sidecar

    const paths = artifactPathsFor(repo.path, config, artifactId);
    const closed = await store.readCheckpoint(artifactId, 1);
    const closedEventId = (closed as { source_event_ids?: { closed?: string } }).source_event_ids
      ?.closed as string;
    // Corrupt the sidecar — readEventLog's integrity check drops the
    // WHOLE checkpoint_closed event, so the scan finds no close for n=1.
    await writeFile(`${paths.sidecarsDir}/${closedEventId}.json`, '{"tampered":true}\n');

    expect(await store.readCheckpointDiffFingerprint(artifactId, 1)).toBeNull();
  });

  it('event-log behavior: when multiple checkpoint_closed events exist for one n, the scan keeps the last', async () => {
    // Not a public re-close lifecycle (storage gates forbid re-closing a
    // closed cp). This asserts the low-level append-order scan property by
    // appending a second checkpoint_closed line directly to the log.
    await writePlan('p-multi');
    await openCp('o-multi');
    await closeCp('c-multi', capturedManifest(1)); // first close: hunk_count 1

    const paths = artifactPathsFor(repo.path, config, artifactId);
    // Append a SECOND checkpoint_closed for n=1 through the real appendEvent
    // (valid per-line checksum, so readEventLog does NOT drop it) with a
    // 2-hunk manifest. readCheckpointDiffFingerprint only reads .n and
    // .diff_fingerprint_manifest, so a minimal payload exercises the scan.
    await appendEvent(
      {
        type: 'checkpoint_closed',
        ts: '2026-05-16T00:00:00.000Z',
        idempotency_key: 'multi-second-close',
        payload: { n: 1, diff_fingerprint_manifest: capturedManifest(1, 2) },
      },
      { eventLogPath: paths.eventsNdjson, sidecarsDir: paths.sidecarsDir }
    );

    const m = await store.readCheckpointDiffFingerprint(artifactId, 1);
    expect(m?.hunk_count).toBe(2); // last close in append order wins
  });

  // ── readCheckpointsRecovered ─────────────────────────────────────

  it('recovers a closed cp with its diff_fingerprint_summary intact', async () => {
    await writePlan('p-rec-ok');
    await openCp('o-rec-ok');
    await closeCp('c-rec-ok', capturedManifest(1));

    const cps = await store.readCheckpointsRecovered(artifactId);
    expect(cps).toHaveLength(1);
    const cp = cps[0]!;
    expect(cp.status).toBe('closed');
    if (cp.status !== 'closed') throw new Error('expected closed');
    expect(cp.diff_fingerprint_summary.status).toBe('captured');
    expect(cp.diff_fingerprint_summary.manifest_hash).toBeTruthy();
  });

  it('refuses the cp read when its close-event sidecar corrupts — even after a prior clean read', async () => {
    await writePlan('p-rec-corrupt');
    await openCp('o-rec-corrupt');
    await closeCp('c-rec-corrupt', capturedManifest(900)); // spills to sidecar

    const paths = artifactPathsFor(repo.path, config, artifactId);
    // A clean read FIRST: with no read cache, corruption that lands
    // afterwards must still refuse on the next read — nothing warmed
    // may bypass the artifact-level contract.
    const closed = await store.readCheckpoint(artifactId, 1);
    const closedEventId = (closed as { source_event_ids?: { closed?: string } }).source_event_ids
      ?.closed as string;
    await writeFile(`${paths.sidecarsDir}/${closedEventId}.json`, '{"tampered":true}\n');

    await expect(store.readCheckpoints(artifactId)).rejects.toThrow(/corrupt event-log line/);
    await expect(store.readCheckpointsRecovered(artifactId)).rejects.toThrow(
      /corrupt event-log line/
    );
    await expect(store.readCheckpoint(artifactId, 1)).rejects.toThrow(/corrupt event-log line/);
  });

  it('recovers an abandoned cp as abandoned', async () => {
    await writePlan('p-rec-aband');
    await openCp('o-rec-aband');
    await store.writeCheckpointAbandoned(
      { artifact_id: artifactId, n: 1, reason: 'rescoped' },
      { idempotencyKey: 'a-rec-aband' }
    );

    const cps = await store.readCheckpointsRecovered(artifactId);
    expect(cps).toHaveLength(1);
    expect(cps[0]?.status).toBe('abandoned');
  });

  // ── helpers ──────────────────────────────────────────────────────

  async function writePlan(idempotencyKey: string): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'abc123',
        agent: 'claude-code',
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
      { idempotencyKey }
    );
  }

  async function openCp(idempotencyKey: string): Promise<void> {
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
      { idempotencyKey, headSha: 'cafef00d' }
    );
  }

  async function closeCp(
    idempotencyKey: string,
    manifest: DiffFingerprintManifest | null,
    summaryOverride?: DiffFingerprintSummary
  ): Promise<void> {
    const summary: DiffFingerprintSummary =
      summaryOverride ??
      ({
        ...buildDefaultSkippedFingerprintSummary(),
        status: 'captured',
        hunk_count: manifest?.hunk_count ?? 0,
        captured_hunk_count: manifest?.captured_hunk_count ?? 0,
        truncated: false,
        fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2',
        manifest_hash: 'a'.repeat(43),
        manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
        error_reason: null,
      } satisfies DiffFingerprintSummary);
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'closed',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_ID],
        head_sha: 'cafef00d',
      },
      {
        idempotencyKey,
        snapshotCallbacks: {
          captureCloseFingerprint: async () => ({
            boundary: {
              ...buildDefaultSkippedSnapshotBoundary(),
              snapshot_ref: 'refs/orcaops/snap/x/1/close',
              tree_sha: 'c'.repeat(40),
              snapshot_commit_sha: 'd'.repeat(40),
            },
            summary,
            manifest,
          }),
        },
      }
    );
  }

  function capturedManifest(lineHashes: number, hunkCount = 1): DiffFingerprintManifest {
    const hunks = Array.from({ length: hunkCount }, (_, i) => ({
      hunk_index: i,
      file_before: null,
      file_after: `f${i}.ts`,
      change_type: 'add' as const,
      binary: false,
      old_start: null,
      old_lines: null,
      new_start: 1,
      new_lines: lineHashes,
      patch_hash: `ph${i}`,
      added_line_hashes: Array.from({ length: lineHashes }, (_, j) => `lh-${i}-${j}-padpadpad`),
      deleted_line_hashes: [],
      hunk_header_hash: null,
      added_line_count: lineHashes,
      deleted_line_count: 0,
    }));
    return {
      schema_version: 1,
      artifact_id: artifactId,
      checkpoint_n: 1,
      open_tree_sha: 'o'.repeat(40),
      close_tree_sha: 'c'.repeat(40),
      status: 'captured',
      hunk_count: hunkCount,
      captured_hunk_count: hunkCount,
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
      hunks,
    };
  }
});
