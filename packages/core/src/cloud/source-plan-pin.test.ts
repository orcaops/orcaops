import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type SourcePlanGetResult, TrpcRequestError } from '@orcaops/sdk';
import {
  sourcePlanCacheDir,
  type SourcePlanPin,
  writePullCachePathPointer,
  writePullCacheRecord,
} from '@orcaops/storage';

import {
  type AttachClient,
  attachSourcePlanPin,
  bornPinExternalId,
  buildBranchAPin,
  buildBranchBPin,
  type PreflightClient,
  preflightSourcePlan,
  resolveBranchBPinTitle,
} from './source-plan-pin.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function cloudPin(over: Partial<Record<string, string>> = {}): SourcePlanPin {
  const content = over.content ?? '# Cloud plan\n\nbody';
  return {
    source_ref: {
      kind: 'cloud',
      locator: over.locator ?? 'ext-1',
      version: over.version ?? '3',
      base_url: over.base_url ?? 'https://cloud.example',
      org_id: over.org_id ?? 'org_1',
    },
    content,
    hash: sha(content),
    baseline: null,
  };
}

function localPin(
  locator: string,
  content = '# Local plan\n\nbody',
  baseline: SourcePlanPin['baseline'] = null
): SourcePlanPin {
  return { source_ref: { kind: 'local', locator }, content, hash: sha(content), baseline };
}

const BASELINE = {
  repo_url: 'https://github.com/acme/widgets',
  branch: 'feature/pin-baseline',
  head_sha: 'c'.repeat(40),
};

const ATTACH_BASE = {
  artifactId: 'artifact-123',
  planLabel: 'My Plan Label',
  baseUrl: 'https://cloud.example',
  currentOrgId: 'org_1',
  authoredAt: '2026-06-08T00:00:00.000Z',
};

function getClient(result: SourcePlanGetResult | (() => never)): PreflightClient {
  return {
    sourcePlan: {
      get: vi.fn(async () => (typeof result === 'function' ? result() : result)),
    },
  };
}

describe('Branch-A builder', () => {
  it('echoes version/hash/body from the frozen pin; source_ref + derived_from null', () => {
    const pin = cloudPin();
    const payload = buildBranchAPin({ ...ATTACH_BASE, sourcePlan: pin });
    expect(payload).toMatchObject({
      schema_version: 1,
      artifact_id: 'artifact-123',
      external_id: 'ext-1',
      version_number: 3,
      title: 'My Plan Label',
      body: pin.content,
      content_hash: pin.hash,
      source_ref: null,
      derived_from: null,
      baseline: null,
      authored_at: '2026-06-08T00:00:00.000Z',
    });
  });

  it('sends baseline null even when the (tampered) cloud pin carries one', () => {
    // A cloud pin never legitimately carries a baseline (capture only
    // freezes one onto local pins) — Branch A must not echo a tampered one.
    const pin = { ...cloudPin(), baseline: BASELINE };
    const payload = buildBranchAPin({ ...ATTACH_BASE, sourcePlan: pin });
    expect(payload.baseline).toBeNull();
  });
});

describe('Branch-B builder', () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-pin-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('seals version_number 1 with the deterministic born id; derived_from null without repoRoot', async () => {
    const pin = localPin('docs/plan.md');
    const payload = await buildBranchBPin({ ...ATTACH_BASE, sourcePlan: pin });
    expect(payload).toMatchObject({
      schema_version: 1,
      artifact_id: 'artifact-123',
      external_id: bornPinExternalId('artifact-123'),
      version_number: 1,
      title: 'My Plan Label',
      body: pin.content,
      content_hash: pin.hash,
      source_ref: null,
      derived_from: null,
      baseline: null,
    });
    expect(bornPinExternalId('artifact-123')).toHaveLength(64);
  });

  it("carries the pin's frozen authoring baseline onto the wire", async () => {
    const pin = localPin('docs/plan.md', '# Local plan\n\nbody', BASELINE);
    const payload = await buildBranchBPin({ ...ATTACH_BASE, sourcePlan: pin });
    expect(payload.baseline).toEqual(BASELINE);
  });

  it('resolves org-scoped derived_from when the local file traces to a prior pull', async () => {
    const outPath = path.join(repoRoot, 'docs', 'plan.md');
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, 'pulled body', 'utf8');
    await writePullCacheRecord(sourcePlanCacheDir(repoRoot), {
      schema_version: 1,
      external_id: 'src-ext',
      slug: 'src',
      version_number: 7,
      title: 'Source',
      body: 'pulled body',
      content_hash: sha('pulled body'),
      source_ref: null,
      base_url: 'https://cloud.example',
      org_id: 'org_1',
      pulled_at: '2026-06-08T00:00:00.000Z',
    });
    await writePullCachePathPointer(sourcePlanCacheDir(repoRoot), {
      baseUrl: 'https://cloud.example',
      orgId: 'org_1',
      realPath: outPath,
      externalId: 'src-ext',
      versionNumber: 7,
    });

    const payload = await buildBranchBPin({
      ...ATTACH_BASE,
      sourcePlan: localPin('docs/plan.md'),
      repoRoot,
    });
    expect(payload.derived_from).toEqual({ source_plan_external_id: 'src-ext', version_number: 7 });
  });

  it('degrades derived_from to null under a different org (org-scoped lineage)', async () => {
    const outPath = path.join(repoRoot, 'docs', 'plan.md');
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, 'pulled body', 'utf8');
    await writePullCacheRecord(sourcePlanCacheDir(repoRoot), {
      schema_version: 1,
      external_id: 'src-ext',
      slug: 'src',
      version_number: 7,
      title: 'Source',
      body: 'pulled body',
      content_hash: sha('pulled body'),
      source_ref: null,
      base_url: 'https://cloud.example',
      org_id: 'org_1',
      pulled_at: '2026-06-08T00:00:00.000Z',
    });
    await writePullCachePathPointer(sourcePlanCacheDir(repoRoot), {
      baseUrl: 'https://cloud.example',
      orgId: 'org_1',
      realPath: outPath,
      externalId: 'src-ext',
      versionNumber: 7,
    });

    const payload = await buildBranchBPin({
      ...ATTACH_BASE,
      currentOrgId: 'other-org',
      sourcePlan: localPin('docs/plan.md'),
      repoRoot,
    });
    expect(payload.derived_from).toBeNull();
  });
});

describe('Branch-B replay title', () => {
  it('uses the title stored under the deterministic born-pin id', async () => {
    const client = getClient({
      externalId: bornPinExternalId('artifact-123'),
      slug: 'stored-title',
      title: 'Stored title',
      status: 'PINNED',
      approvedVersionNumber: null,
      webUrl: 'https://cloud.example/plans/stored-title',
      captureThread: { externalId: 'artifact-123', label: 'Current label', taskNumber: null },
    });

    await expect(
      resolveBranchBPinTitle(client, {
        artifactId: 'artifact-123',
        planLabel: 'Current label',
      })
    ).resolves.toBe('Stored title');
    expect(client.sourcePlan.get).toHaveBeenCalledWith({
      slugOrExternalId: bornPinExternalId('artifact-123'),
    });
  });

  it('uses the current label only when the born pin does not exist', async () => {
    const client = getClient(() => {
      throw new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 });
    });

    await expect(
      resolveBranchBPinTitle(client, {
        artifactId: 'artifact-123',
        planLabel: 'Current label',
      })
    ).resolves.toBe('Current label');
  });

  it('does not treat a missing procedure as a missing born pin', async () => {
    const client = getClient(() => {
      throw new TrpcRequestError('missing', {
        code: 'NOT_FOUND',
        httpStatus: 404,
        appCode: 'UNKNOWN_PROCEDURE',
      });
    });

    await expect(
      resolveBranchBPinTitle(client, {
        artifactId: 'artifact-123',
        planLabel: 'Current label',
      })
    ).rejects.toMatchObject({ data: { appCode: 'UNKNOWN_PROCEDURE' } });
  });
});

describe('preflightSourcePlan', () => {
  it('is a no-op for a local (Branch-B) pin — never calls get', async () => {
    const client = getClient(() => {
      throw new Error('get should not be called');
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: localPin('docs/plan.md'),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      })
    ).resolves.toBeUndefined();
    expect(client.sourcePlan.get).not.toHaveBeenCalled();
  });

  it('rejects a wrong-origin pin (base_url or org mismatch) before any get', async () => {
    const client = getClient(() => {
      throw new Error('get should not be called');
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin({ base_url: 'https://evil.example' }),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      })
    ).rejects.toMatchObject({ reason: 'wrong-origin' });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin(),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'different-org',
        currentThreadExternalId: null,
      })
    ).rejects.toMatchObject({ reason: 'wrong-origin' });
    expect(client.sourcePlan.get).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-numeric / non-positive) pinned version BEFORE any get', async () => {
    for (const version of ['abc', '0', '-1', '1.5']) {
      const client = getClient(() => {
        throw new Error('get must not be called for a malformed version');
      });
      await expect(
        preflightSourcePlan(client, {
          sourcePlan: cloudPin({ version }),
          baseUrl: 'https://cloud.example',
          currentOrgId: 'org_1',
          currentThreadExternalId: null,
        })
      ).rejects.toMatchObject({ reason: 'malformed' });
      expect(client.sourcePlan.get).not.toHaveBeenCalled();
    }
  });

  it('passes a trailing-slash / default-port base_url difference (canonicalized compare)', async () => {
    const client = getClient({
      externalId: 'ext-1',
      slug: 's',
      title: 't',
      webUrl: 'https://cloud.example/plans/s',
      status: 'APPROVED',
      approvedVersionNumber: 3,
      captureThread: null,
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin({ base_url: 'https://cloud.example/' }),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      })
    ).resolves.toBeUndefined();
  });

  it('maps a NOT_FOUND get to a not-found preflight error', async () => {
    const client = getClient(() => {
      throw new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 });
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin(),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      })
    ).rejects.toMatchObject({ reason: 'not-found' });
  });

  it('proceeds on APPROVED + version match', async () => {
    const client = getClient({
      externalId: 'ext-1',
      slug: 's',
      title: 't',
      webUrl: 'https://cloud.example/plans/s',
      status: 'APPROVED',
      approvedVersionNumber: 3,
      captureThread: null,
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin({ version: '3' }),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      })
    ).resolves.toBeUndefined();
  });

  it('fails stale on APPROVED + version mismatch', async () => {
    const client = getClient({
      externalId: 'ext-1',
      slug: 's',
      title: 't',
      webUrl: 'https://cloud.example/plans/s',
      status: 'APPROVED',
      approvedVersionNumber: 5,
      captureThread: null,
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin({ version: '3' }),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      })
    ).rejects.toMatchObject({ reason: 'stale' });
  });

  it('flags APPROVED + null approvedVersionNumber as an inconsistent-cloud-state stale', async () => {
    const client = getClient({
      externalId: 'ext-1',
      slug: 's',
      title: 't',
      webUrl: 'https://cloud.example/plans/s',
      status: 'APPROVED',
      approvedVersionNumber: null,
      captureThread: null,
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin({ version: '3' }),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      })
    ).rejects.toMatchObject({
      reason: 'stale',
      message: expect.stringMatching(/inconsistent cloud state/i),
    });
  });

  it('distinguishes downgrade vs upgrade staleness wording (both reason: stale)', async () => {
    const at = (approvedVersionNumber: number): Promise<Error> =>
      preflightSourcePlan(
        getClient({
          externalId: 'ext-1',
          slug: 's',
          title: 't',
          webUrl: 'https://cloud.example/plans/s',
          status: 'APPROVED',
          approvedVersionNumber,
          captureThread: null,
        }),
        {
          sourcePlan: cloudPin({ version: '3' }),
          baseUrl: 'https://cloud.example',
          currentOrgId: 'org_1',
          currentThreadExternalId: null,
        }
      ).then(
        () => {
          throw new Error('expected a stale rejection');
        },
        (e: Error) => e
      );
    const downgrade = await at(2);
    const upgrade = await at(5);
    expect(downgrade).toMatchObject({ reason: 'stale' });
    expect(upgrade).toMatchObject({ reason: 'stale' });
    expect(downgrade.message).toMatch(/rolled back to 2/);
    expect(upgrade.message).toMatch(/now 5/);
    expect(downgrade.message).not.toBe(upgrade.message);
  });

  it('does not infer not-found from a bare HTTP status', async () => {
    const client = getClient(() => {
      throw new TrpcRequestError('missing', { httpStatus: 404 });
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin(),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      })
    ).rejects.toBeInstanceOf(TrpcRequestError);
  });

  it('lets typed missing-procedure skew escape the not-found arm untouched', async () => {
    const raw = new TrpcRequestError('anything', {
      code: 'NOT_FOUND',
      httpStatus: 404,
      appCode: 'UNKNOWN_PROCEDURE',
    });
    const client = getClient(() => {
      throw raw;
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin(),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      })
    ).rejects.toBe(raw);
  });

  it('proceeds on PINNED WITHOUT staleness-failing, even when approvedVersionNumber is non-null', async () => {
    const client = getClient({
      externalId: 'ext-1',
      slug: 's',
      title: 't',
      webUrl: 'https://cloud.example/plans/s',
      status: 'PINNED',
      approvedVersionNumber: 99, // Branch-A CAS retains it — must NOT staleness-fail
      // Owned by this artifact's thread: the subject here is the staleness rule,
      // so ownership has to be in a passing state or the assertion would prove
      // nothing about staleness.
      captureThread: { externalId: 'thread-mine', label: 'owning thread', taskNumber: null },
    });
    await expect(
      preflightSourcePlan(client, {
        sourcePlan: cloudPin({ version: '3' }),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: 'thread-mine',
      })
    ).resolves.toBeUndefined();
  });

  describe('PINNED thread ownership (launch-wire captureThread ref)', () => {
    const pinnedTo = (owner: string | null) => ({
      externalId: 'ext-1',
      slug: 's',
      title: 't',
      webUrl: 'https://cloud.example/plans/s',
      status: 'PINNED',
      approvedVersionNumber: 99,
      captureThread:
        owner === null ? null : { externalId: owner, label: 'owning thread', taskNumber: null },
    });

    it('rejects pinned-elsewhere BEFORE publish when the owner is a different thread (fresh publish)', async () => {
      const client = getClient(pinnedTo('thread-other'));
      await expect(
        preflightSourcePlan(client, {
          sourcePlan: cloudPin({ version: '3' }),
          baseUrl: 'https://cloud.example',
          currentOrgId: 'org_1',
          currentThreadExternalId: null,
        })
      ).rejects.toMatchObject({ reason: 'pinned-elsewhere' });
      // The read-only guard made exactly its single get and nothing else —
      // a rejection provably publishes nothing.
      expect(client.sourcePlan.get).toHaveBeenCalledTimes(1);
    });

    it('rejects pinned-elsewhere when the owner differs from THIS artifact prior-push thread', async () => {
      const client = getClient(pinnedTo('thread-other'));
      await expect(
        preflightSourcePlan(client, {
          sourcePlan: cloudPin({ version: '3' }),
          baseUrl: 'https://cloud.example',
          currentOrgId: 'org_1',
          currentThreadExternalId: 'thread-mine',
        })
      ).rejects.toMatchObject({ reason: 'pinned-elsewhere' });
    });

    it('passes a re-push whose prior thread IS the owner', async () => {
      const client = getClient(pinnedTo('thread-mine'));
      await expect(
        preflightSourcePlan(client, {
          sourcePlan: cloudPin({ version: '3' }),
          baseUrl: 'https://cloud.example',
          currentOrgId: 'org_1',
          currentThreadExternalId: 'thread-mine',
        })
      ).resolves.toBeUndefined();
    });

    it('refuses a terminally pinned plan whose owning thread was deleted', async () => {
      const client = getClient(pinnedTo(null));
      await expect(
        preflightSourcePlan(client, {
          sourcePlan: cloudPin({ version: '3' }),
          baseUrl: 'https://cloud.example',
          currentOrgId: 'org_1',
          currentThreadExternalId: null,
        })
      ).rejects.toMatchObject({ reason: 'owner-deleted' });
    });

    it('does not tell the user to push from an artifact that no longer exists', async () => {
      // The pinned-elsewhere remedy ("push from the artifact that owns the pin")
      // is actively wrong once the owner is deleted — there is nothing to push
      // from. Distinct reasons exist so the messages can differ; this pins that
      // they actually do.
      const client = getClient(pinnedTo(null));
      const err = await preflightSourcePlan(client, {
        sourcePlan: cloudPin({ version: '3' }),
        baseUrl: 'https://cloud.example',
        currentOrgId: 'org_1',
        currentThreadExternalId: null,
      }).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err?.message).toContain('Upload a fresh plan');
      expect(err?.message).not.toContain('push from the artifact');
    });

    it('still refuses an explicit null even when a prior thread exists for this artifact', async () => {
      // A re-push has a currentThreadExternalId, which must not be mistaken for
      // a match against a null owner.
      const client = getClient(pinnedTo(null));
      await expect(
        preflightSourcePlan(client, {
          sourcePlan: cloudPin({ version: '3' }),
          baseUrl: 'https://cloud.example',
          currentOrgId: 'org_1',
          currentThreadExternalId: 'thread-mine',
        })
      ).rejects.toMatchObject({ reason: 'owner-deleted' });
    });
  });

  it('rejects a non-APPROVED / non-PINNED status (DRAFT/REJECTED) before publish', async () => {
    for (const status of ['DRAFT', 'UNDER_REVIEW', 'REJECTED']) {
      const client = getClient({
        externalId: 'ext-1',
        slug: 's',
        title: 't',
        webUrl: 'https://cloud.example/plans/s',
        status,
        approvedVersionNumber: null,
        captureThread: null,
      });
      await expect(
        preflightSourcePlan(client, {
          sourcePlan: cloudPin(),
          baseUrl: 'https://cloud.example',
          currentOrgId: 'org_1',
          currentThreadExternalId: null,
        })
      ).rejects.toMatchObject({ reason: 'not-approved' });
    }
  });
});

describe('attachSourcePlanPin', () => {
  function attachClient(impl?: () => never): {
    client: AttachClient;
    attachPin: ReturnType<typeof vi.fn>;
  } {
    const attachPin = vi.fn(async () => {
      if (impl) impl();
      return { id: 'row-1' };
    });
    return { client: { sourcePlan: { attachPin } }, attachPin };
  }

  it('dispatches Branch A for a cloud pin', async () => {
    const { client, attachPin } = attachClient();
    const branch = await attachSourcePlanPin(client, { ...ATTACH_BASE, sourcePlan: cloudPin() });
    expect(branch).toBe('A');
    expect(attachPin.mock.calls[0][0]).toMatchObject({ external_id: 'ext-1', version_number: 3 });
  });

  it('dispatches Branch B for a local pin', async () => {
    const { client, attachPin } = attachClient();
    const branch = await attachSourcePlanPin(client, {
      ...ATTACH_BASE,
      sourcePlan: localPin('docs/plan.md'),
    });
    expect(branch).toBe('B');
    expect(attachPin.mock.calls[0][0]).toMatchObject({
      external_id: bornPinExternalId('artifact-123'),
      version_number: 1,
    });
  });

  it('propagates the cloud ConflictError verbatim (no flattening at the pin layer)', async () => {
    const msg = 'Source plan is already pinned to a different capture thread.';
    const { client } = attachClient(() => {
      throw new TrpcRequestError(msg, { code: 'CONFLICT', httpStatus: 409 });
    });
    await expect(
      attachSourcePlanPin(client, { ...ATTACH_BASE, sourcePlan: cloudPin() })
    ).rejects.toThrow(msg);
  });
});
