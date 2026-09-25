import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These exercise the real `withReviewCloud`. The canonical client boundary and
 * registered database context are faked so the public composition is covered
 * without credentials, project files, or a network request.
 */
const cloud: {
  handshake: unknown;
  /** Every sourcePlan procedure the fake client was asked to call. */
  called: string[];
  /** How many cli.ping requests the harness issued. */
  pings: number;
  contextError: Error | null;
  responses: Record<string, unknown>;
} = { handshake: null, called: [], pings: 0, contextError: null, responses: {} };

vi.mock('@orcaops/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/core')>();
  return {
    ...actual,
    resolveCredentialStore: () => ({ kind: 'file' }),
    resolveCloudTarget: () => 'https://cloud.example',
  };
});

vi.mock('@orcaops/core/history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/core/history')>();
  const core = await import('@orcaops/core');
  return {
    ...actual,
    createCanonicalCloudClient: async (input: {
      requires: readonly string[];
      operation: string;
      cliVersion: string;
    }) => {
      cloud.pings += 1;
      core.assertCloudSupports(
        { handshake: cloud.handshake },
        input.requires as never,
        input.operation,
        { cliVersion: input.cliVersion }
      );
      return {
        client: {
          // Any procedure reached here is a request the gate failed to prevent.
          sourcePlan: new Proxy(
            {},
            {
              get: (_target, name) => async (): Promise<unknown> => {
                cloud.called.push(String(name));
                if (String(name) in cloud.responses) return cloud.responses[String(name)];
                throw new Error(`the wire was reached: sourcePlan.${String(name)}`);
              },
            }
          ),
        },
        target: {
          server_url: 'https://cloud.example',
          org_id: 'org_1',
          account_id: 'user_1',
        },
        credentialStore: {},
      };
    },
  };
});

vi.mock('../../../lib/database-capture-context.js', () => ({
  resolveDatabaseCaptureContext: async () => {
    if (cloud.contextError) throw cloud.contextError;
    return {
      registered: { git: { worktreeRoot: '/tmp/unused' } },
      env: {},
      invokingAgent: { agent: 'codex', source: 'ambient' },
      repo: {},
      project: { database: {} },
      config: { redact: { allow: [] } },
      close: (): void => {},
    };
  },
  openDatabaseCaptureWriter: async () => {
    throw new Error('writer should not open');
  },
}));

vi.mock('../../../lib/database-source-plan-review-mutations.js', () => ({
  createDatabaseSourcePlanReviewMutationClient: (input: { client: unknown }) => ({
    ...(input.client as object),
    didDispatch: () => true,
  }),
}));

vi.mock('../../../lib/database-source-plan-review.js', () => ({
  createDatabasePlanReviewPersistence: () => undefined,
}));

import { withReviewCloud } from './shared.js';
import { reviewVerdictAction } from './verdict.js';
import { buildProgram } from '../../../cli/program.js';

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
  cloud.contextError = null;
  cloud.responses = {};
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
  it('rejects a missing reviewer with structured output before the cloud handshake', async () => {
    await expect(
      buildProgram({ cloudBaseUrl: 'https://cloud.example' }).parseAsync([
        'node',
        'orcaops',
        'plan',
        'review',
        'request',
        'ext-1',
        '--json',
      ])
    ).rejects.toThrow();
    expect(cloud.pings).toBe(0);
    expect(cloud.called).toEqual([]);
    expect(JSON.parse(out.join(''))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('requires the reviewer request capability before dispatching the registered command', async () => {
    await expect(
      buildProgram({ cloudBaseUrl: 'https://cloud.example' }).parseAsync([
        'node',
        'orcaops',
        'plan',
        'review',
        'request',
        'ext-1',
        '--reviewer',
        'Ben',
        '--json',
      ])
    ).rejects.toThrow();
    expect(cloud.pings).toBe(1);
    expect(cloud.called).toEqual([]);
    expect(out.join('')).toContain('source-plan-review-request/v1');
  });

  it('dispatches repeated reviewer options when the request capability is advertised', async () => {
    cloud.handshake = { ...FULL_HANDSHAKE, capabilities: ['source-plan-review-request/v1'] };
    cloud.responses.reviewRequest = {
      externalId: 'ext-1',
      added: [{ userId: 'ben', rawTag: 'Ben' }],
      alreadyRequested: [{ userId: 'alice', rawTag: 'Alice' }],
      unresolved: [],
    };
    await buildProgram({ cloudBaseUrl: 'https://cloud.example' }).parseAsync([
      'node',
      'orcaops',
      'plan',
      'review',
      'request',
      'ext-1',
      '--reviewer',
      'Ben',
      '--reviewer',
      'Alice',
      '--json',
    ]);
    expect(cloud.called).toEqual(['reviewRequest']);
    expect(out.join('')).toContain('"status":"requested"');
  });

  it('carries the resend flag from the registered command into the emitted result', async () => {
    cloud.handshake = { ...FULL_HANDSHAKE, capabilities: ['source-plan-review-request/v1'] };
    cloud.responses.reviewRequest = {
      externalId: 'ext-1',
      added: [{ userId: 'ben', rawTag: 'Ben' }],
      alreadyRequested: [],
      unresolved: [],
    };
    await buildProgram({ cloudBaseUrl: 'https://cloud.example' }).parseAsync([
      'node',
      'orcaops',
      'plan',
      'review',
      'request',
      'ext-1',
      '--reviewer',
      'Ben',
      '--resend',
      '--json',
    ]);
    expect(cloud.called).toEqual(['reviewRequest']);
    expect(JSON.parse(out.join(''))).toMatchObject({ resend: true, dispatched: true });
  });

  it('routes the registered verdict command through the database and canonical client defaults', async () => {
    cloud.responses.setReviewerVerdict = {
      externalId: 'ext-1',
      reviewer: 'alex@example.com',
      state: 'APPROVED',
      note: null,
      updatedAt: null,
    };
    await buildProgram({ cloudBaseUrl: 'https://cloud.example' }).parseAsync([
      'node',
      'orcaops',
      'plan',
      'review',
      'verdict',
      'ext-1',
      '--approve',
      '--json',
    ]);
    expect(cloud.pings).toBe(1);
    expect(cloud.called).toEqual(['setReviewerVerdict']);
    expect(out.join('')).toContain('"external_id":"ext-1"');
  });

  it('refuses the registered command when project history is missing before cloud setup', async () => {
    cloud.contextError = new Error('Select the original registered project');
    await expect(
      buildProgram({ cloudBaseUrl: 'https://cloud.example' }).parseAsync([
        'node',
        'orcaops',
        'plan',
        'review',
        'verdict',
        'ext-1',
        '--approve',
        '--json',
      ])
    ).rejects.toThrow();
    expect(cloud.pings).toBe(0);
    expect(cloud.called).toEqual([]);
  });

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
