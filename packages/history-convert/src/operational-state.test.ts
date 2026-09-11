import { describe, expect, it } from 'vitest';

import {
  reconcileCloudFacts,
  reconcileLifecycles,
  reconcilePlanIdempotency,
} from './operational-state.js';

const source = (locator: string) => ({
  identity: `image:${locator}`,
  locator,
  revisionId: null,
  eventId: null,
  operationId: null,
  sha256: null,
});

const cloud = (overrides: Record<string, unknown> = {}) => ({
  artifactId: '01a07e00-0000-7000-8000-000000000001',
  syncedAt: '2026-09-09T01:00:00.000Z',
  syncHash: 'clean',
  externalId: 'external',
  orgId: 'org',
  lastPushAttemptAt: '2026-09-09T01:00:00.000Z',
  lastPushErrorKind: null,
  lastPushErrorMessage: null,
  consecutiveFailures: 0,
  sourceLocation: '/worktrees/a/.orcaops/cache/orcaops.db',
  ...overrides,
});

describe('replicated operational state', () => {
  it('collapses identical plan mappings from copied caches', () => {
    const records = reconcilePlanIdempotency([
      {
        artifactId: '01a07e00-0000-7000-8000-000000000001',
        idempotencyKey: 'plan-key',
        createdAt: '2026-09-09T01:00:00.000Z',
        source: source('/worktrees/b/.orcaops/cache/orcaops.db'),
      },
      {
        artifactId: '01a07e00-0000-7000-8000-000000000001',
        idempotencyKey: 'plan-key',
        createdAt: '2026-09-09T01:00:00.000Z',
        source: source('/worktrees/a/.orcaops/cache/orcaops.db'),
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.source.locator).toContain('/worktrees/a/');
  });

  it('rejects contradictory plan mappings', () => {
    expect(() =>
      reconcilePlanIdempotency([
        {
          artifactId: '01a07e00-0000-7000-8000-000000000001',
          idempotencyKey: 'plan-key',
          createdAt: '2026-09-09T01:00:00.000Z',
          source: source('/worktrees/a/.orcaops/cache/orcaops.db'),
        },
        {
          artifactId: '01a07e00-0000-7000-8000-000000000002',
          idempotencyKey: 'plan-key',
          createdAt: '2026-09-09T01:00:00.000Z',
          source: source('/worktrees/b/.orcaops/cache/orcaops.db'),
        },
      ])
    ).toThrow('Replicated plan-key records disagree');
  });

  it('collapses identical lifecycle copies and orders distinct observations', () => {
    const lifecycle = (triggeredAt: string, locator: string) => ({
      artifactId: '01a07e00-0000-7000-8000-000000000001',
      bytes: Buffer.from(
        JSON.stringify({ fires_at: 'post-plan', cp_n: 0, triggered_at: triggeredAt })
      ),
      source: source(locator),
    });
    const records = reconcileLifecycles([
      lifecycle('2026-09-09T03:00:00.000Z', '/worktrees/c/.orcaops/cache/orcaops.db'),
      lifecycle('2026-09-09T01:00:00.000Z', '/worktrees/b/.orcaops/cache/orcaops.db'),
      lifecycle('2026-09-09T01:00:00.000Z', '/worktrees/a/.orcaops/cache/orcaops.db'),
    ]);

    expect(records).toHaveLength(2);
    expect(JSON.parse(Buffer.from(records[0]!.bytes).toString('utf8')).triggered_at).toBe(
      '2026-09-09T01:00:00.000Z'
    );
    expect(records[0]!.source.locator).toContain('/worktrees/a/');
    expect(JSON.parse(Buffer.from(records[1]!.bytes).toString('utf8')).triggered_at).toBe(
      '2026-09-09T03:00:00.000Z'
    );
  });

  it('selects the latest whole cloud-state observation', () => {
    const records = reconcileCloudFacts([
      cloud(),
      cloud({
        lastPushAttemptAt: '2026-09-09T02:00:00.000Z',
        lastPushErrorKind: 'timeout',
        lastPushErrorMessage: 'timed out',
        consecutiveFailures: 1,
        sourceLocation: '/worktrees/b/.orcaops/cache/orcaops.db',
      }),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      lastPushAttemptAt: '2026-09-09T02:00:00.000Z',
      lastPushErrorKind: 'timeout',
      consecutiveFailures: 1,
      sourceLocation: '/worktrees/b/.orcaops/cache/orcaops.db',
    });
  });

  it('rejects contradictory cloud state with no ordering evidence', () => {
    expect(() => reconcileCloudFacts([cloud(), cloud({ syncHash: 'different' })])).toThrow(
      'Replicated cloud-state records disagree'
    );
  });
});
