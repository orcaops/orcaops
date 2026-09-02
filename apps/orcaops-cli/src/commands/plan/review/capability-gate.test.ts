import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These exercise the REAL `withReviewCloud` — the sibling action tests stub it
 * out, which is right for their purpose but means nothing there covers the
 * capability gate. Only the cloud client and the repo context are faked here,
 * so the ping-then-gate-then-operate ordering under test is the shipped one.
 */
const cloud: {
  handshake: unknown;
  /** Every sourcePlan procedure the fake client was asked to call. */
  called: string[];
  /** How many cli.ping requests the harness issued. */
  pings: number;
} = { handshake: null, called: [], pings: 0 };

vi.mock('@orcaops/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/core')>();
  return {
    ...actual,
    resolveCredentialStore: () => ({ kind: 'file', read: () => ({ orgId: 'org_1' }) }),
    resolveCloudTarget: () => 'https://cloud.example',
    createCloudClient: async () => ({
      client: {
        cli: {
          ping: async () => {
            cloud.pings += 1;
            return {
              ok: true,
              orgId: 'org_1',
              userId: 'user_1',
              handshake: cloud.handshake,
            };
          },
        },
        // Any procedure reached here is a request the gate failed to prevent.
        sourcePlan: new Proxy(
          {},
          {
            get: (_target, name) => async (): Promise<never> => {
              cloud.called.push(String(name));
              throw new Error(`the wire was reached: sourcePlan.${String(name)}`);
            },
          }
        ),
      },
      credentials: { orgId: 'org_1' },
    }),
  };
});

vi.mock('../../../lib/context.js', () => ({
  buildContext: async () => ({
    repoRoot: '/tmp/unused',
    repo: {},
    store: { close: (): void => {} },
  }),
}));

import { withReviewCloud } from './shared.js';
import { reviewVerdictAction } from './verdict.js';

const FULL_HANDSHAKE = {
  server_version: '1.4.0',
  protocol_version: '0.0.21',
  min_cli_version: '0.0.1',
  min_protocol_version: '0.0.1',
  capabilities: ['source-plan-review/v1'],
};

let out: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cloud.handshake = FULL_HANDSHAKE;
  cloud.called = [];
  cloud.pings = 0;
  out = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  stdoutSpy.mockRestore();
});

describe('the gate runs before the operation', () => {
  it('never invokes the operation when the capability is missing', async () => {
    cloud.handshake = { ...FULL_HANDSHAKE, capabilities: [] };
    let operationRan = false;

    await expect(
      withReviewCloud(
        {
          requires: ['source-plan-review/v1'],
          operation: 'plan review push',
        },
        async () => {
          operationRan = true;
          return 'unreachable';
        }
      )
    ).rejects.toThrow(/does not advertise/);

    expect(operationRan).toBe(false);
    expect(cloud.called).toEqual([]);
  });

  it('invokes the operation when the capability is advertised', async () => {
    cloud.handshake = FULL_HANDSHAKE;
    const result = await withReviewCloud(
      { requires: ['source-plan-review/v1'], operation: 'plan review push' },
      async (ctx) => `ran against ${ctx.orgId}`
    );
    expect(result).toBe('ran against org_1');
  });

  it('still resolves the org from the same ping it gates on', async () => {
    cloud.handshake = FULL_HANDSHAKE;
    const orgId = await withReviewCloud(
      { requires: [], operation: 'review status' },
      async (ctx) => ctx.orgId
    );
    expect(orgId).toBe('org_1');
  });
});

// The gate's whole cost argument is that it rides a response the command was
// already waiting for. That is only true if it issues no request of its own, so
// the request count is asserted rather than reasoned about.
describe('the gate issues no request of its own', () => {
  it('costs exactly the one ping the harness already made', async () => {
    cloud.handshake = FULL_HANDSHAKE;
    await withReviewCloud(
      { requires: ['source-plan-review/v1'], operation: 'plan review push' },
      async () => 'done'
    );
    expect(cloud.pings).toBe(1);
  });

  it('costs no ping at all beyond that one when it refuses', async () => {
    cloud.handshake = { ...FULL_HANDSHAKE, capabilities: [] };
    await expect(
      withReviewCloud(
        { requires: ['source-plan-review/v1'], operation: 'plan review push' },
        async () => 'unreachable'
      )
    ).rejects.toThrow(/does not advertise/);
    expect(cloud.pings).toBe(1);
  });

  it('does not re-ping per required capability', async () => {
    cloud.handshake = {
      ...FULL_HANDSHAKE,
      capabilities: ['source-plan-review/v1', 'review-version-pull/v1'],
    };
    await withReviewCloud(
      {
        requires: ['source-plan-review/v1', 'review-version-pull/v1'],
        operation: 'plan review pull',
      },
      async () => 'done'
    );
    expect(cloud.pings).toBe(1);
  });
});

describe('a refused verb reaches no wire', () => {
  it('emits an error and attempts no mutation when the cloud lacks the capability', async () => {
    cloud.handshake = { ...FULL_HANDSHAKE, capabilities: [] };

    await expect(reviewVerdictAction('plan_abc', { approve: true, json: true })).rejects.toThrow(
      /CliExit/
    );

    // The point of the whole gate: setReviewerVerdict was never attempted.
    expect(cloud.called).toEqual([]);
    const envelope = JSON.parse(out[out.length - 1] ?? '{}') as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('CLOUD_ERROR');
    expect(envelope.error?.message).toContain('source-plan-review/v1');
  });

  it('reaches the mutation once the capability is advertised', async () => {
    cloud.handshake = FULL_HANDSHAKE;

    await expect(reviewVerdictAction('plan_abc', { approve: true, json: true })).rejects.toThrow(
      /CliExit/
    );

    // Proves the two cases above are gated, not merely broken: with the
    // capability present the verb does reach setReviewerVerdict (which the fake
    // then fails, hence the same exit).
    expect(cloud.called).toEqual(['setReviewerVerdict']);
  });
});
