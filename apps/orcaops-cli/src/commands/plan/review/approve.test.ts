import { describe, expect, it, vi } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';
import type { SourcePlanGetResult } from '@orcaops/sdk';

import { APPROVE_POLL_INTERVAL_MS, type ReviewApproveClient, runReviewApprove } from './approve.js';

function plan(over: Partial<SourcePlanGetResult> = {}): SourcePlanGetResult {
  return {
    externalId: 'ext-1',
    slug: 'fix-rate-limiter',
    title: 'Rate limiter hardening plan',
    status: 'IN_REVIEW',
    approvedVersionNumber: null,
    webUrl: 'https://app.cloud.example/plans/ext-1/review',
    captureThread: null,
    ...over,
  };
}

function client(get: ReviewApproveClient['sourcePlan']['get']): ReviewApproveClient {
  return { sourcePlan: { get } };
}

/** Fake clock: now advances by the slept amount, no real timers. */
function fakeDeps() {
  let t = 0;
  return {
    openUrl: vi.fn(async () => undefined),
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    now: () => t,
  };
}

const base = {
  externalId: 'ext-1',
  timeoutMs: 600_000,
  openBrowser: true,
  baseUrl: 'https://api.cloud.example',
};

describe('runReviewApprove (launcher)', () => {
  it('opens the cloud-owned webUrl and returns OPENED without waiting', async () => {
    const deps = fakeDeps();
    const result = await runReviewApprove({
      client: client(vi.fn(async () => plan())),
      ...base,
      wait: false,
      deps,
    });
    expect(deps.openUrl).toHaveBeenCalledExactlyOnceWith(
      'https://app.cloud.example/plans/ext-1/review'
    );
    expect(result).toEqual({
      status: 'OPENED',
      externalId: 'ext-1',
      url: 'https://app.cloud.example/plans/ext-1/review',
    });
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('--no-open skips the browser but the URL still comes back for printing', async () => {
    const deps = fakeDeps();
    const result = await runReviewApprove({
      client: client(vi.fn(async () => plan())),
      ...base,
      wait: false,
      openBrowser: false,
      deps,
    });
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(result.url).toBe('https://app.cloud.example/plans/ext-1/review');
  });

  it('fails with a clear skew message when a stale cloud returns no webUrl', async () => {
    const deps = fakeDeps();
    const err = await runReviewApprove({
      client: client(vi.fn(async () => ({ ...plan(), webUrl: undefined as unknown as string }))),
      ...base,
      wait: false,
      deps,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/no web URL.*check the deploy/i);
    expect(deps.openUrl).not.toHaveBeenCalled();
  });

  it('maps NOT_FOUND to a friendly NO_INPUT', async () => {
    const err = await runReviewApprove({
      client: client(
        vi.fn(async () => {
          throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
        })
      ),
      ...base,
      wait: false,
      deps: fakeDeps(),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
  });
});

describe('runReviewApprove --wait', () => {
  it('polls get until a NEW approved version appears, then returns the pin ref', async () => {
    const deps = fakeDeps();
    const get = vi
      .fn()
      .mockResolvedValueOnce(plan({ approvedVersionNumber: 3 }))
      .mockResolvedValueOnce(plan({ approvedVersionNumber: 3 }))
      .mockResolvedValueOnce(plan({ status: 'APPROVED', approvedVersionNumber: 4 }));
    const result = await runReviewApprove({ client: client(get), ...base, wait: true, deps });
    expect(result).toEqual({
      status: 'APPROVED',
      externalId: 'ext-1',
      url: 'https://app.cloud.example/plans/ext-1/review',
      approvedVersionNumber: 4,
      pinRef: 'cloud:ext-1@4',
    });
    expect(get).toHaveBeenCalledTimes(3);
    // Poll cadence: one sleep between each get.
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(APPROVE_POLL_INTERVAL_MS);
  });

  it('already-APPROVED-at-start does NOT count — success requires a new version', async () => {
    const deps = fakeDeps();
    const get = vi
      .fn()
      .mockResolvedValueOnce(plan({ status: 'APPROVED', approvedVersionNumber: 3 }))
      .mockResolvedValueOnce(plan({ status: 'APPROVED', approvedVersionNumber: 4 }));
    const result = await runReviewApprove({ client: client(get), ...base, wait: true, deps });
    expect(result.approvedVersionNumber).toBe(4);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('times out under the distinct REVIEW_APPROVE_TIMEOUT code', async () => {
    const deps = fakeDeps();
    const err = await runReviewApprove({
      client: client(vi.fn(async () => plan())),
      ...base,
      timeoutMs: 10_000,
      wait: true,
      deps,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'REVIEW_APPROVE_TIMEOUT' });
    expect((err as Error).message).toMatch(/Not approved yet/);
    // 10s budget at 4s cadence: polls at t=4s and t=8s, deadline hit at t=12s check.
    expect(deps.sleep).toHaveBeenCalledTimes(3);
  });

  it('maps a missing-procedure rejection during polling to the skew message', async () => {
    const deps = fakeDeps();
    const get = vi
      .fn()
      .mockResolvedValueOnce(plan())
      .mockRejectedValueOnce(
        new TrpcRequestError('anything', {
          code: 'NOT_FOUND',
          httpStatus: 404,
          appCode: 'UNKNOWN_PROCEDURE',
        })
      );
    const err = await runReviewApprove({ client: client(get), ...base, wait: true, deps }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/doesn't expose the plan-review surface/);
  });
});

describe('runReviewApprove web URL validation', () => {
  it.each([
    ['javascript:alert(1)', 'javascript'],
    ['file:///etc/passwd', 'file'],
    ['data:text/html,<script>alert(1)</script>', 'data'],
    ['blob:https://app.cloud.example/abc', 'blob'],
  ])('refuses a %s web URL without opening a browser', async (webUrl) => {
    const deps = fakeDeps();
    await expect(
      runReviewApprove({
        client: client(vi.fn(async () => plan({ webUrl }))),
        ...base,
        wait: false,
        deps,
      })
    ).rejects.toThrow(/unusable web URL/);
    expect(deps.openUrl).not.toHaveBeenCalled();
  });

  it('refuses a web URL carrying embedded credentials', async () => {
    const deps = fakeDeps();
    await expect(
      runReviewApprove({
        client: client(
          vi.fn(async () => plan({ webUrl: 'https://u:p@app.cloud.example/plans/x' }))
        ),
        ...base,
        wait: false,
        deps,
      })
    ).rejects.toThrow(/unusable web URL/);
    expect(deps.openUrl).not.toHaveBeenCalled();
  });

  it('refuses a foreign host even over https', async () => {
    const deps = fakeDeps();
    await expect(
      runReviewApprove({
        client: client(vi.fn(async () => plan({ webUrl: 'https://evil.example/plans/ext-1' }))),
        ...base,
        wait: false,
        deps,
      })
    ).rejects.toThrow(/unusable web URL/);
    expect(deps.openUrl).not.toHaveBeenCalled();
  });

  it('accepts a web surface on a sibling host of the API', async () => {
    const deps = fakeDeps();
    const result = await runReviewApprove({
      client: client(vi.fn(async () => plan({ webUrl: 'https://app.cloud.example/plans/ext-1' }))),
      ...base,
      wait: false,
      deps,
    });
    expect(deps.openUrl).toHaveBeenCalledExactlyOnceWith('https://app.cloud.example/plans/ext-1');
    expect(result.status).toBe('OPENED');
  });
});
