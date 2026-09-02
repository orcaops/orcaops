import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ArtifactLockLeaseLostError,
  attachLeaseLossCause,
  StalePlanRevisionError,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';

// Hoisted spy refs so the vi.mock factories (themselves hoisted) can close over
// them. This is the one module-mock in the CLI suite: runCaptureWithSync builds
// its own context and resolves its own cloud-sync seams internally, so a DIRECT
// assertion that the top-of-command drain receives `repoRoot` (the born-pin
// derived_from lineage path) needs those seams replaced.
const h = vi.hoisted(() => ({
  flushPendingPushes: vi.fn(),
  eagerPush: vi.fn(),
  resolveCloudTarget: vi.fn(),
  resolveCredentialStore: vi.fn(),
  buildContext: vi.fn(),
  appendNextActions: vi.fn(),
  materializeDigest: vi.fn(),
  stampUsage: vi.fn(),
  emitOk: vi.fn(),
  emitError: vi.fn(),
}));

vi.mock('@orcaops/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/core')>();
  return {
    ...actual,
    flushPendingPushes: h.flushPendingPushes,
    eagerPush: h.eagerPush,
    resolveCloudTarget: h.resolveCloudTarget,
    resolveCredentialStore: h.resolveCredentialStore,
  };
});

vi.mock('./context.js', () => ({ buildContext: h.buildContext }));
vi.mock('./next-actions.js', () => ({ appendNextActions: h.appendNextActions }));
vi.mock('./materialize-digest.js', () => ({ materializeDigest: h.materializeDigest }));
vi.mock('./usage-stamp.js', () => ({ stampUsage: h.stampUsage }));
vi.mock('../io/output.js', () => ({ emitOk: h.emitOk, emitError: h.emitError }));

const { runCapture, runCaptureWithSync } = await import('./run-capture.js');

describe('runCapture — mapped errors keep the lease-loss cause', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The capture verbs are the heaviest users of the artifact lock, and every
  // one of their storage errors is remapped into a FRESH OrcaopsError. Without
  // the pass-through the lease-loss evidence dies at this boundary and the
  // stderr disclosure (covered in io/output.test.ts) never sees it.
  it('carries a confirmed lease loss across the storage-to-CLI remap', async () => {
    const stale = new StalePlanRevisionError('prior event is stale', 'a1', 'observed', 'latest', 3);
    attachLeaseLossCause(stale, new ArtifactLockLeaseLostError('a1'));

    await runCapture(async () => {
      throw stale;
    });

    const mapped = h.emitError.mock.calls[0]?.[0] as OrcaopsError;
    expect(mapped).toBeInstanceOf(OrcaopsError);
    expect(mapped.code).toBe(ErrorCodes.STALE_PLAN_REVISION);
    expect(mapped.cause).toBeInstanceOf(ArtifactLockLeaseLostError);
  });

  it('leaves an unmapped error and its cause untouched', async () => {
    const raw = new Error('something else');
    await runCapture(async () => {
      throw raw;
    });

    expect(h.emitError.mock.calls[0]?.[0]).toBe(raw);
    expect(raw.cause).toBeUndefined();
  });
});

describe('runCaptureWithSync — drain lineage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.flushPendingPushes.mockResolvedValue({ skipped: false });
    h.eagerPush.mockResolvedValue({});
    h.resolveCloudTarget.mockReturnValue('https://api.orcaops.ai');
    h.resolveCredentialStore.mockReturnValue({});
    h.appendNextActions.mockImplementation(async (_ctx: unknown, obj: unknown) => obj);
    h.materializeDigest.mockResolvedValue({ path: '/fake/digest.md' });
    h.stampUsage.mockResolvedValue(undefined);
  });

  it('threads ctx.repoRoot into the top-of-command flushPendingPushes drain', async () => {
    const close = vi.fn();
    const ctx = {
      store: { close },
      repo: {},
      repoRoot: '/fake/repo/root',
      invokingAgent: { agent: 'claude-code', source: 'ambient' },
    };
    h.buildContext.mockResolvedValue(ctx);

    await runCaptureWithSync(async () => ({}));

    expect(h.flushPendingPushes).toHaveBeenCalledTimes(1);
    expect(h.flushPendingPushes.mock.calls[0][0]).toMatchObject({
      store: ctx.store,
      repo: ctx.repo,
      repoRoot: '/fake/repo/root',
      baseUrl: 'https://api.orcaops.ai',
    });
    // No artifact was written, so the eager push branch is skipped.
    expect(h.eagerPush).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('renders an opted-in digest after usage recording and eager sync', async () => {
    const ctx = {
      store: { close: vi.fn(), store: { getCloudSyncStateForArtifact: vi.fn(() => null) } },
      repo: {},
      repoRoot: '/fake/repo/root',
      gates: { cloud: false },
      invokingAgent: { agent: 'codex', source: 'ambient' },
    };
    h.buildContext.mockResolvedValue(ctx);

    await runCaptureWithSync(async () => ({
      artifact_id: 'artifact-1',
      usageStamp: { kind: 'fixture' } as never,
      renderFinalDigest: true,
    }));

    expect(h.stampUsage.mock.invocationCallOrder[0]).toBeLessThan(
      h.eagerPush.mock.invocationCallOrder[0]!
    );
    expect(h.eagerPush.mock.invocationCallOrder[0]).toBeLessThan(
      h.materializeDigest.mock.invocationCallOrder[0]!
    );
    const output = h.appendNextActions.mock.calls.at(-1)?.[1];
    expect(output).toEqual(
      expect.objectContaining({
        finalization_status: 'finalized',
        digest: { status: 'current', cached_at: '/fake/digest.md' },
      })
    );
    expect(output).not.toHaveProperty('renderFinalDigest');
  });

  it.each(['needs_attention', 'blocked'])(
    '%s does not render or report finalization',
    async (status) => {
      const ctx = {
        store: { close: vi.fn(), store: { getCloudSyncStateForArtifact: vi.fn(() => null) } },
        repo: {},
        repoRoot: '/fake/repo/root',
        gates: { cloud: false },
        invokingAgent: { agent: 'codex', source: 'ambient' },
      };
      h.buildContext.mockResolvedValue(ctx);

      await runCaptureWithSync(async () => ({ artifact_id: 'artifact-1', status }));

      expect(h.materializeDigest).not.toHaveBeenCalled();
      const output = h.appendNextActions.mock.calls.at(-1)?.[1];
      expect(output).toEqual(expect.objectContaining({ artifact_id: 'artifact-1', status }));
      expect(output).not.toHaveProperty('summary_event_id');
      expect(output).not.toHaveProperty('finalization_status');
      expect(output).not.toHaveProperty('digest');
      expect(output).not.toHaveProperty('renderFinalDigest');
    }
  );

  it('keeps the summary finalized and reports a repair command when digest generation fails', async () => {
    const ctx = {
      store: { close: vi.fn(), store: { getCloudSyncStateForArtifact: vi.fn(() => null) } },
      repo: {},
      repoRoot: '/fake/repo/root',
      gates: { cloud: false },
      invokingAgent: { agent: 'codex', source: 'ambient' },
    };
    h.buildContext.mockResolvedValue(ctx);
    h.materializeDigest.mockRejectedValue(new Error('injected digest failure'));

    await runCaptureWithSync(async () => ({
      artifact_id: 'artifact-1',
      renderFinalDigest: true,
    }));

    expect(h.appendNextActions.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        finalization_status: 'finalized_without_digest',
        digest: expect.objectContaining({
          status: 'failed',
          action: 'orcaops digest --artifact artifact-1',
        }),
      })
    );
  });

  it('repairs the digest on summary replay without rewriting or re-pushing the artifact', async () => {
    const ctx = {
      store: { close: vi.fn(), store: { getCloudSyncStateForArtifact: vi.fn(() => null) } },
      repo: {},
      repoRoot: '/fake/repo/root',
      gates: { cloud: false },
      invokingAgent: { agent: 'codex', source: 'ambient' },
    };
    h.buildContext.mockResolvedValue(ctx);

    await runCaptureWithSync(async () => ({
      artifact_id: 'artifact-1',
      idempotency_status: 'replay',
      renderFinalDigest: true,
    }));

    expect(h.eagerPush).not.toHaveBeenCalled();
    expect(h.materializeDigest).toHaveBeenCalledWith(ctx, 'artifact-1');
    expect(h.appendNextActions.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ finalization_status: 'finalized' })
    );
  });
});
