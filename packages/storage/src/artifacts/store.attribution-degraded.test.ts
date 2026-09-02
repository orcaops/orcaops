import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor } from './paths.js';
import {
  ArtifactStore,
  type CheckpointCloseCallbacks,
  type CheckpointSnapshotCallbacks,
} from './store.js';
import { AttributionDegradedSchema } from '../schema/checkpoint.js';
import { type Config, getDefaultConfig } from '../schema/config.js';
import type {
  CheckpointSnapshotBoundary,
  DiffFingerprintManifest,
  DiffFingerprintSummary,
} from '../schema/diff-fingerprint.js';

/**
 * Store integration for the unmerged-index degradation path: payload-only
 * `open_unmerged_paths` stamping, the open∪close union, post-partition
 * manifest exclusion with a consistent {manifest, summary} recompute,
 * conditional `attribution_degraded` stamping, and the clean-close
 * byte-stability pin. Synthetic snapshot evidence throughout — the store
 * never runs git.
 */

const ART = '01999999-9999-7000-8000-00000000013a';
const STEP_1 = '01HX0K8N6ZQF8M5R2V8DZ7T3L1';

let hunkSeq = 0;
function fileHunk(fileBefore: string | null, fileAfter: string | null) {
  hunkSeq += 1;
  return {
    hunk_index: hunkSeq,
    file_before: fileBefore,
    file_after: fileAfter,
    change_type: 'modify' as const,
    binary: false,
    old_start: 1,
    old_lines: 1,
    new_start: 1,
    new_lines: 1,
    patch_hash: `ph-${hunkSeq}`,
    added_line_hashes: [`lh-${hunkSeq}`],
    deleted_line_hashes: [],
    hunk_header_hash: null,
    added_line_count: 1,
    deleted_line_count: 0,
  };
}

function manifestOf(files: string[]): DiffFingerprintManifest {
  const hunks = files.map((f) => fileHunk(f, f));
  return {
    schema_version: 1,
    artifact_id: ART,
    checkpoint_n: 1,
    open_tree_sha: 'o'.repeat(40),
    close_tree_sha: 'c'.repeat(40),
    status: 'captured',
    hunk_count: hunks.length,
    captured_hunk_count: hunks.length,
    truncated: false,
    error_reason: null,
    normalization_version: 'orcaops-line-normalization-v1',
    diff_algorithm: 'git-diff-unified-v1',
    diff_options: { unified: 3, find_renames: true, no_ext_diff: true },
    limits: { max_diff_bytes: 1048576 },
    hash_encoding: 'base64url-nopad',
    line_hash_algorithm: 'blake3-xof-96-base64url-nopad-v2',
    patch_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
    hunk_header_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
    manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
    hunks,
  };
}

function summaryOf(manifest: DiffFingerprintManifest): DiffFingerprintSummary {
  return {
    status: manifest.status,
    hunk_count: manifest.hunk_count,
    captured_hunk_count: manifest.captured_hunk_count,
    truncated: manifest.truncated,
    fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2',
    manifest_hash: 'unfiltered-hash',
    manifest_hash_algorithm: manifest.manifest_hash_algorithm,
    error_reason: null,
  };
}

const successBoundary = (phase: string): CheckpointSnapshotBoundary => ({
  snapshot_ref: `refs/orcaops/snap/x/1/${phase}`,
  tree_sha: (phase === 'open' ? 'a' : 'c').repeat(40),
  snapshot_commit_sha: (phase === 'open' ? 'b' : 'd').repeat(40),
  snapshot_error_reason: null,
});

describe('ArtifactStore — unmerged-index degradation path', () => {
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

  async function writePlan(): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: ART,
        branch: 'feat/x',
        base_sha: 'abc123',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'unmerged fixture',
        label: 'unmerged-degraded',
        plan_steps: [{ step_id: STEP_1, text: 'step 1', label: 's1', acceptance_criteria: [] }],
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
      { idempotencyKey: `plan-${ART}` }
    );
  }

  async function openCp(openUnmerged?: string[], openProbeFailed?: boolean): Promise<void> {
    const callbacks: CheckpointSnapshotCallbacks = {
      captureOpenSnapshot: async () => ({
        boundary: successBoundary('open'),
        ...(openUnmerged !== undefined ? { unmerged_paths: openUnmerged } : {}),
        ...(openProbeFailed === true ? { unmerged_probe_failed: true } : {}),
      }),
    };
    await store.writeCheckpointOpened(
      { artifact_id: ART, declared_step_ids: [STEP_1] },
      { idempotencyKey: 'o1', headSha: 'cafef00d', snapshotCallbacks: callbacks }
    );
  }

  async function closeCp(spec: {
    manifest: DiffFingerprintManifest | null;
    closeUnmerged?: string[];
    closeProbeFailed?: boolean;
    closeCallbackThrows?: boolean;
    filesChanged?: string[];
  }) {
    const skippedSummary: DiffFingerprintSummary = {
      status: 'skipped',
      hunk_count: 0,
      captured_hunk_count: 0,
      truncated: false,
      fingerprint_algorithm: null,
      manifest_hash: null,
      manifest_hash_algorithm: null,
      error_reason: null,
    };
    const callbacks: CheckpointCloseCallbacks = {
      captureCloseFingerprint: async () => {
        if (spec.closeCallbackThrows === true) throw new Error('synthetic close-capture failure');
        return {
          boundary: successBoundary('close'),
          summary: spec.manifest ? summaryOf(spec.manifest) : skippedSummary,
          manifest: spec.manifest,
          ...(spec.closeUnmerged !== undefined ? { unmerged_paths: spec.closeUnmerged } : {}),
          ...(spec.closeProbeFailed === true ? { unmerged_probe_failed: true } : {}),
        };
      },
    };
    const result = await store.writeCheckpointClosed(
      {
        artifact_id: ART,
        n: 1,
        summary: 'cp1',
        files_changed: spec.filesChanged ?? ['kept.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_1],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: 'c1', snapshotCallbacks: callbacks }
    );
    if (result.outcome !== 'created') throw new Error(`close outcome: ${result.outcome}`);
    return result.checkpoint;
  }

  async function readEvents(): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
    const paths = artifactPathsFor(repo.path, config, ART);
    const log = await readFile(paths.eventsNdjson, 'utf8');
    return log
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
  }

  it('stamps open_unmerged_paths payload-only, and only when non-empty', async () => {
    await writePlan();
    await openCp(['conflict.txt']);
    const events = await readEvents();
    const open = events.find((e) => e.type === 'checkpoint_opened');
    expect(open?.payload.open_unmerged_paths).toEqual(['conflict.txt']);

    // Payload-only: the projection never carries it.
    const paths = artifactPathsFor(repo.path, config, ART);
    const projection = JSON.parse(await readFile(paths.checkpointJson(1), 'utf8')) as Record<
      string,
      unknown
    >;
    expect('open_unmerged_paths' in projection).toBe(false);
  });

  it('omits open_unmerged_paths on a clean open (byte-stability pin)', async () => {
    await writePlan();
    await openCp([]);
    const events = await readEvents();
    const open = events.find((e) => e.type === 'checkpoint_opened');
    expect(open).toBeDefined();
    expect('open_unmerged_paths' in (open?.payload ?? {})).toBe(false);
  });

  it('unions open- and close-side sets, filters the manifest, and recomputes the summary', async () => {
    await writePlan();
    await openCp(['open-conflict.txt']);
    const m = manifestOf(['open-conflict.txt', 'close-conflict.txt', 'kept.ts']);
    const cp = await closeCp({ manifest: m, closeUnmerged: ['close-conflict.txt'] });

    expect(cp.status).toBe('closed');
    if (cp.status !== 'closed') return;
    expect(cp.attribution_degraded).toEqual({
      unmerged_paths: ['close-conflict.txt', 'open-conflict.txt'],
    });
    expect(cp.diff_fingerprint_summary.hunk_count).toBe(1);
    expect(cp.diff_fingerprint_summary.captured_hunk_count).toBe(1);
    expect(cp.diff_fingerprint_summary.manifest_hash).not.toBe('unfiltered-hash');
    expect(cp.diff_fingerprint_summary.manifest_hash).not.toBeNull();

    const events = await readEvents();
    const close = events.find((e) => e.type === 'checkpoint_closed');
    const persisted = close?.payload.diff_fingerprint_manifest as DiffFingerprintManifest;
    expect(persisted.hunks.map((h) => h.file_after)).toEqual(['kept.ts']);
    expect(persisted.hunk_count).toBe(1);
  });

  it('stamps attribution_degraded even when the manifest is null', async () => {
    await writePlan();
    await openCp(['conflict.txt']);
    const cp = await closeCp({ manifest: null });
    expect(cp.status).toBe('closed');
    if (cp.status !== 'closed') return;
    expect(cp.attribution_degraded).toEqual({ unmerged_paths: ['conflict.txt'] });
  });

  it('clean close: no attribution_degraded key and a byte-identical manifest/summary', async () => {
    await writePlan();
    await openCp();
    const m = manifestOf(['kept.ts']);
    const cp = await closeCp({ manifest: m });

    expect(cp.status).toBe('closed');
    if (cp.status !== 'closed') return;
    expect('attribution_degraded' in cp).toBe(false);
    expect(cp.diff_fingerprint_summary.manifest_hash).toBe('unfiltered-hash');

    const events = await readEvents();
    const close = events.find((e) => e.type === 'checkpoint_closed');
    expect('attribution_degraded' in (close?.payload ?? {})).toBe(false);
  });

  it('a degraded union that touches no manifest hunk still passes the pair through untouched', async () => {
    await writePlan();
    await openCp(['resolved-before-any-change.txt']);
    const m = manifestOf(['kept.ts']);
    const cp = await closeCp({ manifest: m });

    expect(cp.status).toBe('closed');
    if (cp.status !== 'closed') return;
    // Disclosure still stamped — the window WAS degraded.
    expect(cp.attribution_degraded).toEqual({
      unmerged_paths: ['resolved-before-any-change.txt'],
    });
    // But the manifest/summary pass through byte-identical.
    expect(cp.diff_fingerprint_summary.manifest_hash).toBe('unfiltered-hash');
  });

  it('an open-side probe failure stamps payload-only and marks the close unverified', async () => {
    await writePlan();
    await openCp([], true);
    const events = await readEvents();
    const open = events.find((e) => e.type === 'checkpoint_opened');
    expect(open?.payload.open_unmerged_probe_failed).toBe(true);
    // Payload-only: the projection never carries it.
    const paths = artifactPathsFor(repo.path, config, ART);
    const projection = JSON.parse(await readFile(paths.checkpointJson(1), 'utf8')) as Record<
      string,
      unknown
    >;
    expect('open_unmerged_probe_failed' in projection).toBe(false);

    const m = manifestOf(['kept.ts']);
    const cp = await closeCp({ manifest: m });
    expect(cp.status).toBe('closed');
    if (cp.status !== 'closed') return;
    expect(cp.attribution_degraded).toEqual({ unmerged_paths: [], probe_failed: true });
    // The manifest/summary pass through byte-identical — nothing to filter.
    expect(cp.diff_fingerprint_summary.manifest_hash).toBe('unfiltered-hash');
  });

  it('a close-side probe failure marks the window unverified', async () => {
    await writePlan();
    await openCp();
    const cp = await closeCp({ manifest: manifestOf(['kept.ts']), closeProbeFailed: true });
    expect(cp.status).toBe('closed');
    if (cp.status !== 'closed') return;
    expect(cp.attribution_degraded).toEqual({ unmerged_paths: [], probe_failed: true });
  });

  it('a non-empty union and a failed probe compose on one record', async () => {
    await writePlan();
    await openCp(['conflict.txt'], false);
    const m = manifestOf(['conflict.txt', 'kept.ts']);
    const cp = await closeCp({ manifest: m, closeProbeFailed: true });
    expect(cp.status).toBe('closed');
    if (cp.status !== 'closed') return;
    expect(cp.attribution_degraded).toEqual({
      unmerged_paths: ['conflict.txt'],
      probe_failed: true,
    });
    // Filtering still ran for the named path.
    expect(cp.diff_fingerprint_summary.hunk_count).toBe(1);
    expect(cp.diff_fingerprint_summary.manifest_hash).not.toBe('unfiltered-hash');
  });

  it('a throwing close callback still stamps the open-side probe failure', async () => {
    await writePlan();
    await openCp([], true);
    const cp = await closeCp({ manifest: null, closeCallbackThrows: true });
    expect(cp.status).toBe('closed');
    if (cp.status !== 'closed') return;
    expect(cp.attribution_degraded).toEqual({ unmerged_paths: [], probe_failed: true });
    expect(cp.diff_fingerprint_summary.error_reason).toBe('unknown');
  });
});

describe('AttributionDegradedSchema', () => {
  it('parses legacy records (non-empty paths, no flag)', () => {
    expect(AttributionDegradedSchema.parse({ unmerged_paths: ['a.txt'] })).toEqual({
      unmerged_paths: ['a.txt'],
    });
  });

  it('rejects an empty-empty record (refinement)', () => {
    expect(AttributionDegradedSchema.safeParse({ unmerged_paths: [] }).success).toBe(false);
  });

  it('parses a probe-failed-only record', () => {
    expect(AttributionDegradedSchema.parse({ unmerged_paths: [], probe_failed: true })).toEqual({
      unmerged_paths: [],
      probe_failed: true,
    });
  });

  it('rejects probe_failed: false (literal true only)', () => {
    expect(
      AttributionDegradedSchema.safeParse({ unmerged_paths: ['a.txt'], probe_failed: false })
        .success
    ).toBe(false);
  });
});
