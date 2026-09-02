import { describe, expect, it } from 'vitest';

import {
  ArtifactOriginSchema,
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
} from '@orcaops/storage';
import type {
  ClosedCheckpoint,
  DiffFingerprintManifest,
  Plan,
  SessionModelBreakdownRow,
  SourcePlanPin,
  UsageSnapshotRow,
} from '@orcaops/storage';

import {
  type ArtifactSnapshot,
  type ArtifactUsageData,
  computeArtifactHash,
  computeUsageAnchor,
} from './hash.js';

const plan: Plan = {
  schema_version: 1,
  artifact_id: 'a1',
  branch: 'main',
  base_sha: 'abc123',
  agent: 'claude-code',
  agent_session_id: null,
  task: 'demo',
  plan_steps: ['step 1', 'step 2'],
  touched_scope: [],
  started_at: '2026-04-28T01:00:00.000Z',
} as unknown as Plan;

// Use a schema-valid CLOSED checkpoint (a concrete union member, no cast) so
// the relative hash assertions exercise a supported shape.
const cp1: ClosedCheckpoint = {
  schema_version: 4,
  artifact_id: 'a1',
  n: 1,
  declared_step_ids: ['01HX0K8N6ZQF8M5R2V8DZ7T3KX'],
  agent: 'other',
  policy_exceptions: [],
  plan_revision_id: null,
  open_plan_revision_event_id: 'evt-plan-0',
  opened_at: '2026-04-28T01:00:30.000Z',
  head_sha: 'abc124',
  open_snapshot: buildDefaultSkippedSnapshotBoundary(),
  status: 'closed',
  closed_at: '2026-04-28T01:01:00.000Z',
  closed_by_agent: 'other',
  summary: 'first',
  files_changed: [],
  decisions: [],
  uncertainty: [],
  done_criteria: [],
  completed_step_ids: [],
  close_snapshot: buildDefaultSkippedSnapshotBoundary(),
  diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
  source_event_ids: { opened: 'evt-open-1', closed: 'evt-close-1' },
  source_event_id: 'evt-close-1',
};

const cp2: ClosedCheckpoint = { ...cp1, n: 2, summary: 'second' };

/**
 * Build an ArtifactSnapshot, defaulting `fingerprintByN`. That field is
 * intentionally excluded from the digest, so a single empty-Map default
 * is correct for every assertion below.
 */
function snap(
  partial: Omit<ArtifactSnapshot, 'fingerprintByN' | 'source_plan' | 'usage'> & {
    source_plan?: ArtifactSnapshot['source_plan'];
    usage?: ArtifactSnapshot['usage'];
  }
): ArtifactSnapshot {
  return { source_plan: null, usage: null, ...partial, fingerprintByN: new Map() };
}

describe('computeArtifactHash', () => {
  it('is deterministic across calls with identical inputs', () => {
    const a = computeArtifactHash(
      snap({ plan, checkpoints: [cp1, cp2], summary: null, evaluators: null })
    );
    const b = computeArtifactHash(
      snap({ plan, checkpoints: [cp1, cp2], summary: null, evaluators: null })
    );
    expect(a).toBe(b);
  });

  it('is order-independent for checkpoints', () => {
    const a = computeArtifactHash(
      snap({ plan, checkpoints: [cp1, cp2], summary: null, evaluators: null })
    );
    const b = computeArtifactHash(
      snap({ plan, checkpoints: [cp2, cp1], summary: null, evaluators: null })
    );
    expect(a).toBe(b);
  });

  it('changes when a checkpoint is added', () => {
    const a = computeArtifactHash(
      snap({ plan, checkpoints: [cp1], summary: null, evaluators: null })
    );
    const b = computeArtifactHash(
      snap({ plan, checkpoints: [cp1, cp2], summary: null, evaluators: null })
    );
    expect(a).not.toBe(b);
  });

  it('changes when a checkpoint summary changes', () => {
    const a = computeArtifactHash(
      snap({ plan, checkpoints: [cp1], summary: null, evaluators: null })
    );
    const b = computeArtifactHash(
      snap({
        plan,
        checkpoints: [{ ...cp1, summary: 'edited' }],
        summary: null,
        evaluators: null,
      })
    );
    expect(a).not.toBe(b);
  });

  it('changes when the plan changes', () => {
    const a = computeArtifactHash(snap({ plan, checkpoints: [], summary: null, evaluators: null }));
    const b = computeArtifactHash(
      snap({
        plan: { ...plan, plan_steps: ['step 1', 'step 2', 'step 3'] } as unknown as Plan,
        checkpoints: [],
        summary: null,
        evaluators: null,
      })
    );
    expect(a).not.toBe(b);
  });

  it('produces a 64-char hex digest', () => {
    const h = computeArtifactHash(snap({ plan, checkpoints: [], summary: null, evaluators: null }));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps legacy plans origin-absent while hashing imported provenance as content', () => {
    expect('origin' in plan).toBe(false);
    const base = computeArtifactHash(
      snap({ plan, checkpoints: [], summary: null, evaluators: null })
    );
    const imported = computeArtifactHash(
      snap({
        plan: {
          ...plan,
          origin: {
            kind: 'git-import',
            imported_at: '2026-04-28T02:00:00.000Z',
            tool_version: '0.0.5',
            source_range: 'main~1..main',
            authors: ['dev@example.com'],
            enriched_at: null,
            cluster_key: 'a'.repeat(64),
            member_shas_hash: 'b'.repeat(64),
          },
        },
        checkpoints: [],
        summary: null,
        evaluators: null,
      })
    );
    expect(imported).not.toBe(base);
  });

  // The job key is optional-ABSENT: a schema parse (rebuild, archive replay)
  // must not inject it, or every artifact imported before the ledger existed
  // would re-hash to a new digest and read as tampered.
  it('leaves a job-less imported origin hashed as before and hashes the job when present', () => {
    const origin = {
      kind: 'git-import',
      imported_at: '2026-04-28T02:00:00.000Z',
      tool_version: '0.0.5',
      source_range: 'main~1..main',
      authors: ['dev@example.com'],
      enriched_at: null,
      cluster_key: 'a'.repeat(64),
      member_shas_hash: 'b'.repeat(64),
    } as const;
    expect('job' in origin).toBe(false);
    const hashWith = (value: unknown): string =>
      computeArtifactHash(
        snap({
          plan: { ...plan, origin: value } as Plan,
          checkpoints: [],
          summary: null,
          evaluators: null,
        })
      );

    const jobless = hashWith(origin);
    expect(hashWith(ArtifactOriginSchema.parse(origin))).toBe(jobless);
    expect(hashWith({ ...origin, job: { job_id: 'job-1', kind: 'initial' } })).not.toBe(jobless);
  });

  // ── fingerprint propagation + manifest-excluded-from-hash ──

  const fpCp = (manifestHash: string | null): ClosedCheckpoint => ({
    ...cp1,
    status: 'closed',
    diff_fingerprint_summary: {
      status: manifestHash === null ? 'skipped' : 'captured',
      hunk_count: 0,
      captured_hunk_count: 0,
      truncated: false,
      fingerprint_algorithm: manifestHash === null ? null : 'blake3-xof-96-base64url-nopad-v2',
      manifest_hash: manifestHash,
      manifest_hash_algorithm:
        manifestHash === null ? null : 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
      error_reason: null,
    },
  });

  it("changes when a checkpoint's diff_fingerprint_summary.manifest_hash changes (propagation)", () => {
    const a = computeArtifactHash(
      snap({ plan, checkpoints: [fpCp('h1')], summary: null, evaluators: null })
    );
    const b = computeArtifactHash(
      snap({ plan, checkpoints: [fpCp('h2')], summary: null, evaluators: null })
    );
    expect(a).not.toBe(b);
  });

  it('does NOT change when only fingerprintByN differs (full manifest excluded from the hash)', () => {
    const cp = fpCp('same-hash');
    const manifestA = { schema_version: 1, hunks: [] } as unknown as DiffFingerprintManifest;
    const manifestB = {
      schema_version: 1,
      hunks: [{ patch_hash: 'totally-different' }],
    } as unknown as DiffFingerprintManifest;
    const a = computeArtifactHash({
      plan,
      checkpoints: [cp],
      summary: null,
      evaluators: null,
      source_plan: null,
      usage: null,
      fingerprintByN: new Map([[1, manifestA]]),
    });
    const b = computeArtifactHash({
      plan,
      checkpoints: [cp],
      summary: null,
      evaluators: null,
      source_plan: null,
      usage: null,
      fingerprintByN: new Map([[1, manifestB]]),
    });
    expect(a).toBe(b);
  });
});

describe('computeArtifactHash — source_plan change-detection', () => {
  const localPin = (over: Partial<SourcePlanPin> = {}): SourcePlanPin => ({
    source_ref: { kind: 'local', locator: 'docs/p.md' },
    content: 'BODY',
    hash: 'h1',
    baseline: null,
    ...over,
  });
  const base = { plan, checkpoints: [], summary: null, evaluators: null };

  it('a pinned artifact hashes differently from an unpinned one (the pin joins detection)', () => {
    expect(computeArtifactHash(snap({ ...base, source_plan: null }))).not.toBe(
      computeArtifactHash(snap({ ...base, source_plan: localPin() }))
    );
  });

  it('null and absent source_plan produce the SAME digest (conditional spread → no pinless re-push)', () => {
    const withNull = computeArtifactHash(snap({ ...base, source_plan: null }));
    const absent = computeArtifactHash({
      ...base,
      fingerprintByN: new Map(),
    } as unknown as ArtifactSnapshot);
    expect(withNull).toBe(absent);
  });

  it('excludes uncapped content because its hash is the canonical body identity', () => {
    const a = computeArtifactHash(snap({ ...base, source_plan: localPin({ content: 'AAA' }) }));
    const b = computeArtifactHash(snap({ ...base, source_plan: localPin({ content: 'BBB' }) }));
    expect(a).toBe(b);
  });

  it('changes when the normalized born-pin baseline changes', () => {
    const a = computeArtifactHash(snap({ ...base, source_plan: localPin({ baseline: null }) }));
    const b = computeArtifactHash(
      snap({
        ...base,
        source_plan: localPin({
          baseline: { repo_url: 'https://github.com/acme/widgets', branch: 'main', head_sha: 'x' },
        }),
      })
    );
    expect(a).not.toBe(b);
  });

  it('changes when the pin hash changes', () => {
    expect(computeArtifactHash(snap({ ...base, source_plan: localPin({ hash: 'h1' }) }))).not.toBe(
      computeArtifactHash(snap({ ...base, source_plan: localPin({ hash: 'h2' }) }))
    );
  });

  it('changes when the source_ref changes (local vs cloud)', () => {
    const local = computeArtifactHash(snap({ ...base, source_plan: localPin() }));
    const cloud = computeArtifactHash(
      snap({
        ...base,
        source_plan: {
          source_ref: {
            kind: 'cloud',
            locator: 'ext',
            version: '1',
            base_url: 'https://c',
            org_id: 'o',
          },
          content: 'BODY',
          hash: 'h1',
          baseline: null,
        },
      })
    );
    expect(local).not.toBe(cloud);
  });
});

describe('computeArtifactHash — usage change-detection', () => {
  const base = { plan, checkpoints: [], summary: null, evaluators: null };
  // Only `anchor` enters the digest; the heavy rows are carried for the wire but
  // excluded. `sessionTag` varies a heavy row to prove it does NOT move the hash.
  const usage = (anchor: string, sessionTag = 's'): ArtifactUsageData => ({
    sessions: [{ session_id: sessionTag } as unknown as ArtifactUsageData['sessions'][number]],
    snapshots: [],
    modelBreakdowns: [],
    source_plan_links: [],
    anchor,
  });

  it('null and absent usage produce the SAME digest (no spurious re-push on upgrade)', () => {
    const withNull = computeArtifactHash(snap({ ...base, usage: null }));
    const absent = computeArtifactHash({
      ...base,
      source_plan: null,
      fingerprintByN: new Map(),
    } as unknown as ArtifactSnapshot);
    expect(withNull).toBe(absent);
  });

  it('a present usage anchor changes the digest (a usage-only update re-pushes)', () => {
    expect(computeArtifactHash(snap({ ...base, usage: null }))).not.toBe(
      computeArtifactHash(snap({ ...base, usage: usage('anchorA') }))
    );
  });

  it('the digest tracks ONLY the anchor — same anchor + different rows is stable, a new anchor flips it', () => {
    const a = computeArtifactHash(snap({ ...base, usage: usage('anchorA', 'rows-X') }));
    const sameAnchorOtherRows = computeArtifactHash(
      snap({ ...base, usage: usage('anchorA', 'rows-Y') })
    );
    const newAnchor = computeArtifactHash(snap({ ...base, usage: usage('anchorB', 'rows-X') }));
    expect(a).toBe(sameAnchorOtherRows); // heavy rows excluded — only the anchor enters
    expect(a).not.toBe(newAnchor);
  });
});

describe('computeUsageAnchor', () => {
  const s = (k: string, i: number): UsageSnapshotRow =>
    ({
      idempotency_key: k,
      cumulative_input_tokens: i,
      cumulative_output_tokens: 0,
      cumulative_cache_creation_input_tokens: 0,
      cumulative_cache_read_input_tokens: 0,
    }) as unknown as UsageSnapshotRow;
  const mb = (json: string): SessionModelBreakdownRow =>
    ({ agent: 'claude-code', session_id: 's1', model_breakdown: json }) as SessionModelBreakdownRow;
  const anchor = (over: Partial<Parameters<typeof computeUsageAnchor>[0]> = {}): string =>
    computeUsageAnchor({
      sessions: [],
      snapshots: [],
      modelBreakdowns: [],
      source_plan_links: [],
      ...over,
    });

  it('is order-independent over snapshots, and sensitive to a token change', () => {
    const a = anchor({ snapshots: [s('k1', 10), s('k2', 20)] });
    const reordered = anchor({ snapshots: [s('k2', 20), s('k1', 10)] });
    const changed = anchor({ snapshots: [s('k1', 11), s('k2', 20)] });
    expect(a).toBe(reordered); // byte-sorted by idempotency_key → insertion-order-independent
    expect(a).not.toBe(changed); // a single token delta flips the anchor
  });

  it('flips when the per-session model_breakdown changes (folded into the anchor)', () => {
    const base = anchor({ modelBreakdowns: [mb('[{"model":"opus","cumulative":{}}]')] });
    const resplit = anchor({ modelBreakdowns: [mb('[{"model":"sonnet","cumulative":{}}]')] });
    expect(base).not.toBe(resplit);
  });

  it('flips on a snapshot-dimensions-only change', () => {
    const withDim = (dim: string): UsageSnapshotRow =>
      ({ ...s('k1', 10), dimensions: dim }) as unknown as UsageSnapshotRow;
    const base = anchor({ snapshots: [withDim('{}')] });
    const changed = anchor({ snapshots: [withDim('{"web_search_requests":3}')] });
    expect(base).not.toBe(changed);
  });

  it('flips on a session-total-dimensions-only change', () => {
    const withDim = (dim: string): SessionModelBreakdownRow =>
      ({
        agent: 'claude-code',
        session_id: 's1',
        model_breakdown: '[]',
        dimensions: dim,
      }) as unknown as SessionModelBreakdownRow;
    const base = anchor({ modelBreakdowns: [withDim('{}')] });
    const changed = anchor({ modelBreakdowns: [withDim('{"cache_creation_1h_input_tokens":5}')] });
    expect(base).not.toBe(changed);
  });
});

describe('computeArtifactHash — verified-close verification', () => {
  it('a verification-less projection (key absent) hashes byte-identically to a projection without the key', () => {
    // cp1/cp2 above carry no `verification` key — the shape this pins.
    // Adding the key as undefined must not change the
    // canonical JSON either (canonicalJson sorts OWN enumerable keys;
    // an absent key is the contract, and this pins it).
    const before = computeArtifactHash(
      snap({ plan, checkpoints: [cp1, cp2], summary: null, evaluators: null })
    );
    const again = computeArtifactHash(
      snap({ plan, checkpoints: [{ ...cp1 }, { ...cp2 }], summary: null, evaluators: null })
    );
    expect(again).toBe(before);
  });

  it('citing verification on a close flips the hash (content changed — one honest re-push)', () => {
    const withVerification: ClosedCheckpoint = {
      ...cp1,
      verification: [{ command: 'pnpm test', exit_code: 0 }],
    };
    const base = computeArtifactHash(
      snap({ plan, checkpoints: [cp1], summary: null, evaluators: null })
    );
    const flipped = computeArtifactHash(
      snap({ plan, checkpoints: [withVerification], summary: null, evaluators: null })
    );
    expect(flipped).not.toBe(base);
  });
});
