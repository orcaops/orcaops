import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OssSourcePlanUploadPayload } from '@orcaops/sdk';

import { runReviewComment } from '../../src/commands/plan/review/comment.js';
import { runReviewDecline } from '../../src/commands/plan/review/decline.js';
import { runReviewPropose } from '../../src/commands/plan/review/propose.js';
import { runReviewPush } from '../../src/commands/plan/review/push.js';
import { seedCandidate } from '../../src/commands/plan/review/test-helpers.js';
import { runReviewVerdict } from '../../src/commands/plan/review/verdict.js';
import { runPlanUpload } from '../../src/commands/plan/upload.js';
import { runReviewFeedbackReply } from '../../src/commands/review/reply.js';
import { toCloudErrorEnvelope } from '../../src/io/cloud-error-envelope.js';
import { OrcaopsError } from '../../src/io/errors.js';
import { toSecretWarningReports } from '../../src/lib/cloud-secret-gate.js';
import { resolveSourcePlan } from '../../src/lib/source-plan-resolver.js';
import { gatedVerbs } from '../support/cloud-write-surface.js';

/**
 * Behavioural proof that every gated outbound verb refuses a credential.
 *
 * The sibling `cloud-write-surface.test.ts` can only grep the gated files for
 * the gate identifier, which a dead call still satisfies. Each verb here is
 * driven for real against a recording fake transport, so making that verb's
 * gate unreachable turns its refusal into a wire call and fails a test.
 *
 * The drivers exercise the `run*` cores rather than the `*Action` wrappers,
 * because everything the gate protects — the payload build, the content hash,
 * the wire send — is on this side of that boundary and a core takes an injected
 * client. What a core cannot show is ORDER against the credential handshake,
 * since it never touches one; `cloud-gate-precedes-handshake.test.ts` drives
 * the wrappers for that.
 */

// Real-shape, semantically dead. A refuse-tier vendor prefix.
const DEAD_TOKEN = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';
const WARN_CODE = 'const token: HeldToken = { lockPath, live: true };';
const BASE_URL = 'https://cloud.example';
const ORG_ID = 'org_1';
const EXTERNAL_ID = 'ext-1';
const BASE_VERSION_ID = 'ver_4';
const AT = '2026-06-09T00:00:00.000Z';

interface DriveContext {
  repoRoot: string;
  field: string;
  value: string;
}

interface Drive {
  run: () => Promise<unknown>;
  /**
   * How many times the value got past the gate — a fake-transport call for
   * the wire verbs, and for the born pin the minted content-addressed anchor
   * (the pin has no transport of its own; minting the hash is the point of no
   * return the gate exists to precede).
   */
  escaped: () => number;
}

interface GatedVerbDriver {
  /** Authored fields this verb genuinely transmits, each probed in turn. */
  fields: readonly string[];
  drive: (ctx: DriveContext) => Drive;
}

/** The probe value when `label` is the field under test, else the clean default. */
function at<T extends string | null | undefined>(ctx: DriveContext, label: string, clean: T): T {
  return ctx.field === label ? (ctx.value as T) : clean;
}

const CLEAN_BODY = '# Plan\n\nRotate the deploy credential out of the repo.';

const DRIVERS: Record<string, GatedVerbDriver> = {
  'sourcePlan.attachPin': {
    fields: ['content'],
    drive: (ctx) => {
      let minted = 0;
      return {
        run: async () => {
          const file = path.join(ctx.repoRoot, 'pinned-plan.md');
          await writeFile(file, at(ctx, 'content', CLEAN_BODY), 'utf8');
          const resolved = await resolveSourcePlan(file, ctx.repoRoot, []);
          minted += 1;
          return resolved;
        },
        escaped: () => minted,
      };
    },
  },

  'sourcePlan.create': {
    fields: ['body', 'title', 'review_note', 'reviewer[0]'],
    drive: (ctx) => {
      const create = vi.fn(async (input: OssSourcePlanUploadPayload) => ({
        id: 'sp_1',
        externalId: input.external_id,
        slug: 'a-plan',
        status: 'draft',
        unresolved: [],
      }));
      const listReviewers = vi.fn(async () => ({ members: [], scope: 'org' }));
      const file = path.join(ctx.repoRoot, 'plan.md');
      return {
        run: () =>
          runPlanUpload({
            client: { sourcePlan: { create, listReviewers } },
            repoRoot: ctx.repoRoot,
            baseUrl: BASE_URL,
            orgId: ORG_ID,
            absPath: file,
            fileRealpath: file,
            body: at(ctx, 'body', CLEAN_BODY),
            title: at(ctx, 'title', 'Rotate the deploy credential'),
            reviewers: [at(ctx, 'reviewer[0]', 'alice')],
            reviewNote: at(ctx, 'review_note', 'please skim the rollout order'),
            authoredAt: AT,
          }),
        escaped: () => create.mock.calls.length + listReviewers.mock.calls.length,
      };
    },
  },

  'sourcePlan.reviewPush': {
    fields: ['body'],
    drive: (ctx) => {
      const reviewPush = vi.fn(async () => ({
        status: 'published' as const,
        externalId: EXTERNAL_ID,
        candidateVersionId: 'ver_5',
        candidateVersionNumber: 5,
        contentHash: 'unused',
      }));
      const reviewPropose = vi.fn(async () => ({
        externalId: EXTERNAL_ID,
        proposalId: 'prop_1',
        baseVersionId: BASE_VERSION_ID,
        needsRebase: false,
      }));
      return {
        run: () =>
          runReviewPush({
            client: { sourcePlan: { reviewPush, reviewPropose } },
            repoRoot: ctx.repoRoot,
            baseUrl: BASE_URL,
            orgId: ORG_ID,
            externalId: EXTERNAL_ID,
            body: at(ctx, 'body', CLEAN_BODY),
            baseVersionIdOverride: BASE_VERSION_ID,
            onConflict: 'fail',
            pulledAt: AT,
          }),
        escaped: () => reviewPush.mock.calls.length + reviewPropose.mock.calls.length,
      };
    },
  },

  'sourcePlan.reviewPropose': {
    fields: ['body', 'summary', 'source_ref'],
    drive: (ctx) => {
      const reviewPropose = vi.fn(async () => ({
        externalId: EXTERNAL_ID,
        proposalId: 'prop_1',
        baseVersionId: BASE_VERSION_ID,
        needsRebase: false,
      }));
      return {
        run: () =>
          runReviewPropose({
            client: { sourcePlan: { reviewPropose } },
            repoRoot: ctx.repoRoot,
            baseUrl: BASE_URL,
            orgId: ORG_ID,
            externalId: EXTERNAL_ID,
            body: at(ctx, 'body', CLEAN_BODY),
            baseVersionIdOverride: BASE_VERSION_ID,
            summary: at(ctx, 'summary', 'tighten the rollout order'),
            sourceRef: at(ctx, 'source_ref', 'docs/plans/rotate.md'),
            pulledAt: AT,
          }),
        escaped: () => reviewPropose.mock.calls.length,
      };
    },
  },

  'sourcePlan.reviewComment': {
    fields: ['body', 'quote', 'disambiguator'],
    drive: (ctx) => {
      const reviewComment = vi.fn(async () => ({
        externalId: EXTERNAL_ID,
        commentId: 'cmt_1',
      }));
      const quoted = 'Rotate the deploy credential';
      return {
        run: async () => {
          await seedCandidate(ctx.repoRoot, {
            versionId: BASE_VERSION_ID,
            versionNumber: 4,
            baseUrl: BASE_URL,
            orgId: ORG_ID,
            externalId: EXTERNAL_ID,
            body: CLEAN_BODY,
          });
          return runReviewComment({
            kind: 'root',
            client: { sourcePlan: { reviewComment } },
            repoRoot: ctx.repoRoot,
            baseUrl: BASE_URL,
            orgId: ORG_ID,
            externalId: EXTERNAL_ID,
            body: at(ctx, 'body', 'this ordering looks wrong'),
            quote: at(ctx, 'quote', quoted),
            disambiguator: at(ctx, 'disambiguator', 'first occurrence'),
          });
        },
        escaped: () => reviewComment.mock.calls.length,
      };
    },
  },

  'sourcePlan.setReviewerVerdict': {
    fields: ['note'],
    drive: (ctx) => {
      const setReviewerVerdict = vi.fn(async () => ({
        externalId: EXTERNAL_ID,
        reviewer: 'alice',
        state: 'approved',
        note: null,
        updatedAt: AT,
      }));
      return {
        run: () =>
          runReviewVerdict({
            client: { sourcePlan: { setReviewerVerdict } },
            externalId: EXTERNAL_ID,
            verdict: 'approved',
            note: at(ctx, 'note', 'reads fine to me'),
          }),
        escaped: () => setReviewerVerdict.mock.calls.length,
      };
    },
  },

  'sourcePlan.declineProposal': {
    fields: ['reason'],
    drive: (ctx) => {
      const declineProposal = vi.fn(async () => ({
        externalId: EXTERNAL_ID,
        proposalId: 'prop_1',
        state: 'declined',
        reason: null,
      }));
      return {
        run: () =>
          runReviewDecline({
            client: { sourcePlan: { declineProposal } },
            externalId: EXTERNAL_ID,
            proposalId: 'prop_1',
            reason: at(ctx, 'reason', 'superseded by the newer proposal'),
          }),
        escaped: () => declineProposal.mock.calls.length,
      };
    },
  },

  'review.reply': {
    fields: ['body'],
    drive: (ctx) => {
      const reply = vi.fn(async () => ({
        comment_id: 'cmt_2',
        parent_comment_id: 'cmt_1',
        published_at: AT,
      }));
      return {
        run: () =>
          runReviewFeedbackReply({
            client: { review: { reply } },
            commentId: 'cmt_1',
            body: at(ctx, 'body', 'fixed in the follow-up commit'),
            passToken: null,
          }),
        escaped: () => reply.mock.calls.length,
      };
    },
  },
};

describe('outbound secret gate refusal', () => {
  let repoRoot: string;

  beforeEach(async () => {
    // realpath: the upload index write and the review-pull cache reads assert
    // containment under this root, which the symlinked macOS tmpdir breaks.
    repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-secret-gate-')));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('drives every verb the write-surface inventory says is gated', () => {
    expect(Object.keys(DRIVERS).sort()).toEqual(gatedVerbs());
  });

  for (const [verb, driver] of Object.entries(DRIVERS)) {
    describe(verb, () => {
      for (const field of driver.fields) {
        it(`refuses a vendor token in ${field}, sending nothing`, async () => {
          const drive = driver.drive({
            repoRoot,
            field,
            value: `${CLEAN_BODY}\n\nUse ${DEAD_TOKEN} for the push.`,
          });

          await expect(drive.run()).rejects.toThrow(OrcaopsError);
          expect(drive.escaped()).toBe(0);
        });

        it(`reports a vendor token in ${field} as SECRET_IN_PAYLOAD without echoing it`, async () => {
          const drive = driver.drive({
            repoRoot,
            field,
            value: `${CLEAN_BODY}\n\nUse ${DEAD_TOKEN} for the push.`,
          });

          const err = await drive.run().then(
            () => null,
            (e: unknown) => e
          );
          const envelope = toCloudErrorEnvelope(err) as OrcaopsError;
          expect(envelope.code).toBe('SECRET_IN_PAYLOAD');
          expect(envelope.details?.secret_findings?.[0]?.path).toBe(field);
          // The remedy is to describe the credential, never to quote it back.
          expect(JSON.stringify({ m: envelope.message, d: envelope.details })).not.toContain(
            DEAD_TOKEN
          );
        });

        // Guards against a refusal that would fire for any input at all: the
        // same driver with the same field carrying benign text must reach the
        // transport, so the assertions above are measuring the gate.
        it(`sends a clean ${field} through to the transport`, async () => {
          const drive = driver.drive({ repoRoot, field, value: `${CLEAN_BODY}\n\nno secrets.` });

          await expect(drive.run()).resolves.toBeDefined();
          expect(drive.escaped()).toBeGreaterThan(0);
        });

        it(`surfaces a sanitized warn-tier finding in ${field}`, async () => {
          const drive = driver.drive({
            repoRoot,
            field,
            value: `${CLEAN_BODY}\n\n${WARN_CODE}`,
          });

          const result = (await drive.run()) as {
            secret_warnings?: Array<{ path: string; patterns: string[] }>;
            secretWarnings?: Parameters<typeof toSecretWarningReports>[0];
          };
          const warnings =
            result.secret_warnings ?? toSecretWarningReports(result.secretWarnings ?? []);
          expect(warnings).toEqual([
            expect.objectContaining({
              path: field,
              patterns: expect.arrayContaining(['generic-assignment']),
            }),
          ]);
          expect(JSON.stringify(warnings)).not.toContain(WARN_CODE);
          expect(JSON.stringify(warnings)).not.toMatch(/offset|length/);
          expect(drive.escaped()).toBeGreaterThan(0);
        });
      }
    });
  }
});
