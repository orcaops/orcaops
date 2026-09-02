import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ONLY the cloud harness: each action runs against a fake ctx whose
// client the test sets via `holder`. Everything else in shared.js stays real
// (mappers, pinRefOf), so these tests cover the action wrappers' emission
// paths end-to-end without a wire.
const holder: { client: unknown } = { client: null };

vi.mock('./shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared.js')>();
  return {
    ...actual,
    withReviewCloud: async (
      _opts: unknown,
      fn: (ctx: {
        client: unknown;
        repoRoot: string;
        baseUrl: string;
        orgId: string;
        credentialStore: unknown;
      }) => Promise<unknown>
    ) =>
      fn({
        client: holder.client,
        repoRoot: '/tmp/unused',
        baseUrl: 'https://cloud.example',
        orgId: 'org_1',
        credentialStore: {},
      }),
  };
});

vi.mock('@orcaops/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/sdk')>();
  return {
    ...actual,
    getAuthState: async () => ({ kind: 'connected', email: 'alex@example.com' }),
  };
});

import { reviewApproveAction } from './approve.js';
import { reviewDeclineAction } from './decline.js';
import { reviewDiffAction } from './diff.js';
import { reviewListAction } from './list.js';
import { reviewStatusAction } from './status.js';
import { reviewVerdictAction } from './verdict.js';
import { reviewViewAction } from './view.js';

let out: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  out = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
});
afterEach(() => {
  stdoutSpy.mockRestore();
});

const printed = (): string => out.join('');
const lastJson = (): Record<string, unknown> =>
  JSON.parse(out[out.length - 1] ?? '{}') as Record<string, unknown>;

const emptyRollup = {
  approvedCurrent: 0,
  approvedStale: 0,
  changesRequestedCurrent: 0,
  changesRequestedStale: 0,
  pending: 0,
};

const detail = {
  externalId: 'ext-1',
  slug: 'smoke',
  title: 'Smoke',
  status: 'APPROVED',
  approvedVersionNumber: 2,
  webUrl: 'https://cloud.example/p/ext-1',
  candidate: null,
  reviewers: [],
  reviewVerdict: emptyRollup,
  proposals: [],
  comments: [],
};

const listItem = {
  externalId: 'ext-1',
  slug: 'smoke',
  title: 'Smoke',
  status: 'IN_REVIEW',
  candidateVersionNumber: 1,
  approvedVersionNumber: null,
  openProposalCount: 0,
  authorHandle: 'alex@example.com',
  authorName: 'Alex Rivera',
  baselineBranch: null,
  baselineRepoUrl: null,
  reviewers: [{ handle: 'alex@example.com', name: 'Alex Rivera', standing: 'PENDING' }],
  reviewVerdict: emptyRollup,
  updatedAt: '2026-06-10T00:00:00.000Z',
};

describe('action wrappers emit through the harness', () => {
  it('view --json emits the detail + pinRef', async () => {
    holder.client = { sourcePlan: { reviewDetail: vi.fn(async () => detail) } };
    await reviewViewAction('ext-1', { json: true });
    expect(lastJson()).toMatchObject({ ok: true, pinRef: 'cloud:ext-1@2' });
  });

  it('view human render goes through formatHumanView', async () => {
    holder.client = { sourcePlan: { reviewDetail: vi.fn(async () => detail) } };
    await reviewViewAction('ext-1', {});
    expect(printed()).toContain('pin ref: cloud:ext-1@2');
  });

  it('list --json emits plans + truncated; human render prints the table', async () => {
    holder.client = {
      sourcePlan: { list: vi.fn(async () => ({ plans: [listItem], truncated: true })) },
    };
    await reviewListAction({ json: true });
    expect(lastJson()).toMatchObject({ ok: true, truncated: true });
    await reviewListAction({});
    expect(printed()).toContain('more exist — raise --limit');
  });

  it('status sections through the authed email and emits both forms', async () => {
    holder.client = {
      sourcePlan: { list: vi.fn(async () => ({ plans: [listItem], truncated: false })) },
    };
    await reviewStatusAction({ json: true });
    expect(lastJson()).toMatchObject({ ok: true, myHandle: 'alex@example.com' });
    await reviewStatusAction({});
    expect(printed()).toContain('Wants your review (1)');
  });

  it('verdict human output names the recorded state', async () => {
    holder.client = {
      sourcePlan: {
        setReviewerVerdict: vi.fn(async () => ({
          externalId: 'ext-1',
          reviewer: 'alex@example.com',
          state: 'APPROVED',
          note: null,
          updatedAt: null,
        })),
      },
    };
    await reviewVerdictAction('ext-1', { approve: true });
    expect(printed()).toContain('Recorded verdict APPROVED on ext-1');
  });

  it('decline human output names the proposal and reason', async () => {
    holder.client = {
      sourcePlan: {
        declineProposal: vi.fn(async () => ({
          externalId: 'ext-1',
          proposalId: 'prop_1',
          state: 'DECLINED',
          reason: 'absorbed',
        })),
      },
    };
    await reviewDeclineAction('ext-1', { proposal: 'prop_1', reason: 'absorbed' });
    expect(printed()).toContain('Declined proposal prop_1 on ext-1');
    expect(printed()).toContain('reason: absorbed');
  });

  it('approve --no-open prints the URL and the launched-not-approved contract', async () => {
    holder.client = { sourcePlan: { get: vi.fn(async () => detail) } };
    await reviewApproveAction('ext-1', { open: false });
    expect(printed()).toContain('https://cloud.example/p/ext-1');
    expect(printed()).toContain('Exit 0 means LAUNCHED, not approved');
  });

  it('diff human output renders the patch (and --json the envelope)', async () => {
    const bodyA = 'a\n';
    const bodyB = 'b\n';
    const { sha256Hex } = await import('@orcaops/storage');
    holder.client = {
      sourcePlan: {
        getApproved: vi.fn(async () => ({
          externalId: 'ext-1',
          slug: 'smoke',
          title: 'Smoke',
          approvedVersion: {
            versionNumber: 1,
            body: bodyA,
            contentHash: sha256Hex(bodyA),
            sourceRef: null,
          },
        })),
        reviewPull: vi.fn(async () => ({
          externalId: 'ext-1',
          target: 'candidate',
          versionId: 'ver_2',
          versionNumber: 2,
          proposalId: null,
          baseVersionNumber: null,
          contentHash: sha256Hex(bodyB),
          body: bodyB,
        })),
      },
    };
    await reviewDiffAction('ext-1', {});
    expect(printed()).toContain('+b');
    await reviewDiffAction('ext-1', { json: true });
    expect(lastJson()).toMatchObject({ ok: true, identical: false });
  });
});
