import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ArtifactLockLeaseLostError,
  attachLeaseLossCause,
  StalePlanRevisionError,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';

const h = vi.hoisted(() => ({ emitOk: vi.fn(), emitError: vi.fn() }));
vi.mock('../io/output.js', () => ({ emitOk: h.emitOk, emitError: h.emitError }));
const { runCapture } = await import('./run-capture.js');

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
