import { describe, expect, it } from 'vitest';

import { classifyCloudSync } from './run-capture.js';

describe('classifyCloudSync — honest cloud_sync precedence', () => {
  it('this artifact landed → ok', () => {
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: false,
        artifactSynced: true,
        consecutiveFailures: 0,
        lastErrorKind: null,
        drainReason: undefined,
        pending: 0,
      })
    ).toEqual({ status: 'ok' });
  });

  it('a recorded push failure → paused/push_failed', () => {
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 2,
        lastErrorKind: 'network',
        drainReason: undefined,
        pending: 1,
      })
    ).toEqual({ status: 'paused', reason: 'push_failed', pending: 1 });
  });

  it('ANTI-REGRESSION: a recorded failure under DISABLE_DRAIN still surfaces (not silenced)', () => {
    // The eager push runs even when the drain is disabled; a failure must win
    // over the benign drain_disabled skip reason (failures-first precedence).
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 1,
        lastErrorKind: 'network',
        drainReason: 'disabled-by-env',
        pending: 3,
      })
    ).toEqual({ status: 'paused', reason: 'push_failed', pending: 3 });
  });

  it('CONTENT-INVALID: a deterministic content fault → paused/content_invalid (not push_failed)', () => {
    // Outranks the generic failure counter: it is NOT retryable, so it must
    // steer to scrub+rebuild, never `resync --force`.
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 2,
        lastErrorKind: 'content-invalid',
        drainReason: undefined,
        pending: 1,
      })
    ).toEqual({ status: 'paused', reason: 'content_invalid', pending: 1 });
  });

  it('UPGRADE-REQUIRED: a below-minimum rejection → paused/upgrade_required (not push_failed)', () => {
    // Deterministic for this binary: retrying without upgrading fails
    // identically, so it must steer to an upgrade, never a bare retry.
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 2,
        lastErrorKind: 'upgrade-required',
        drainReason: undefined,
        pending: 1,
      })
    ).toEqual({ status: 'paused', reason: 'upgrade_required', pending: 1 });
  });

  it('SERVER-BEHIND stays retryable → paused/push_failed (resync retries after the deploy lands)', () => {
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 1,
        lastErrorKind: 'server-behind',
        drainReason: undefined,
        pending: 1,
      })
    ).toEqual({ status: 'paused', reason: 'push_failed', pending: 1 });
  });

  it('CONTENT-INVALID wins even under a disabled drain (precedence over push_failed)', () => {
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 3,
        lastErrorKind: 'content-invalid',
        drainReason: 'disabled-by-env',
        pending: 2,
      })
    ).toEqual({ status: 'paused', reason: 'content_invalid', pending: 2 });
  });

  it('pending, not-connected with a base URL → paused/not_authenticated', () => {
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 0,
        lastErrorKind: null,
        drainReason: 'not-connected',
        pending: 1,
      })
    ).toEqual({ status: 'paused', reason: 'not_authenticated', pending: 1 });
  });

  it('pending, missing git remote → skipped/missing_remote (benign)', () => {
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 0,
        lastErrorKind: null,
        drainReason: 'missing-remote',
        pending: 1,
      })
    ).toEqual({ status: 'skipped', reason: 'missing_remote', pending: 1 });
  });

  it('pending, drain disabled, no failure → skipped/drain_disabled (benign)', () => {
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 0,
        lastErrorKind: null,
        drainReason: 'disabled-by-env',
        pending: 1,
      })
    ).toEqual({ status: 'skipped', reason: 'drain_disabled', pending: 1 });
  });

  it('pending after a clean drain (e.g. replay of a still-pending artifact) → paused/push_failed', () => {
    expect(
      classifyCloudSync({
        hasCloudCredentials: true,
        artifactPending: true,
        artifactSynced: false,
        consecutiveFailures: 0,
        lastErrorKind: null,
        drainReason: undefined,
        pending: 1,
      })
    ).toEqual({ status: 'paused', reason: 'push_failed', pending: 1 });
  });
});

describe('classifyCloudSync — a machine with no cloud at all', () => {
  const noCloud = {
    hasCloudCredentials: false,
    artifactPending: true,
    artifactSynced: false,
    consecutiveFailures: 0,
    lastErrorKind: null,
    drainReason: undefined,
    pending: 3,
  } as const;

  it('is benign/skipped rather than paused — there is nothing to sync TO', () => {
    expect(classifyCloudSync(noCloud)).toEqual({
      status: 'skipped',
      reason: 'no_cloud_configured',
      pending: 3,
    });
  });

  it('outranks a STALE failure counter left behind by a previous session', () => {
    // cloud_sync_state persists consecutiveFailures across a logout.
    expect(
      classifyCloudSync({ ...noCloud, consecutiveFailures: 4, lastErrorKind: 'network' })
    ).toEqual({ status: 'skipped', reason: 'no_cloud_configured', pending: 3 });
  });

  it('does NOT outrank a content fault, which is repaired offline', () => {
    // The remedy is scrub + `orcaops rebuild` — no cloud, no credentials. A
    // machine with no session is precisely the one that can still fix it, so
    // suppressing this would hide a permanent local corruption.
    expect(classifyCloudSync({ ...noCloud, lastErrorKind: 'content-invalid' })).toEqual({
      status: 'paused',
      reason: 'content_invalid',
      pending: 3,
    });
  });

  it('outranks an upgrade-required fault, whose remedy needs the cloud', () => {
    expect(classifyCloudSync({ ...noCloud, lastErrorKind: 'upgrade-required' })).toEqual({
      status: 'skipped',
      reason: 'no_cloud_configured',
      pending: 3,
    });
  });

  it('outranks every cloud-directed reason', () => {
    const cloudDirected = [
      { consecutiveFailures: 4, lastErrorKind: 'network' as const },
      { drainReason: 'not-connected' as const },
      { drainReason: 'missing-remote' as const },
      { drainReason: 'disabled-by-env' as const },
      {},
    ];
    for (const over of cloudDirected) {
      expect(classifyCloudSync({ ...noCloud, ...over })).toEqual({
        status: 'skipped',
        reason: 'no_cloud_configured',
        pending: 3,
      });
    }
  });

  it('reports skipped, not ok, for a never-synced not-pending artifact', () => {
    // `ok` asserts THIS artifact reached the cloud. Not-pending alone conflates
    // "landed" with "never eligible" — local-only and imported rows are
    // excluded from the drain outright — so on a machine that never logged in
    // `ok` reads as "synced" when nothing ever was.
    expect(classifyCloudSync({ ...noCloud, artifactPending: false })).toEqual({
      status: 'skipped',
      reason: 'no_cloud_configured',
      pending: 3,
    });
  });

  it('still reports ok when the artifact did land (a since-revoked session)', () => {
    // The landed fact is per-artifact and monotonic; revoking the session that
    // uploaded it does not un-sync it, and `no_cloud_configured` would be false
    // about an artifact already on the cloud.
    expect(classifyCloudSync({ ...noCloud, artifactPending: false, artifactSynced: true })).toEqual(
      { status: 'ok' }
    );
  });

  it('still reports ok for a landed artifact once credentials are present', () => {
    expect(
      classifyCloudSync({
        ...noCloud,
        hasCloudCredentials: true,
        artifactPending: false,
        artifactSynced: true,
      })
    ).toEqual({ status: 'ok' });
  });

  it('reports skipped for a local-only artifact that never entered the drain', () => {
    // A credentialed machine holding an imported (`git-import`) artifact: the
    // pending predicate excludes it outright, and it never uploaded, so `ok`
    // would claim a push that never happened. No existing reason describes
    // local-only truthfully, so this skipped carries none.
    expect(
      classifyCloudSync({
        ...noCloud,
        hasCloudCredentials: true,
        artifactPending: false,
        artifactSynced: false,
      })
    ).toEqual({ status: 'skipped', pending: 3 });
  });
});
