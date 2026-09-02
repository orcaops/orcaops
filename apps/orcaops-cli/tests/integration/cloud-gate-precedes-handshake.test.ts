import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The outbound gate refuses BEFORE the cloud handshake.
 *
 * `cloud-secret-gate-refusal.test.ts` drives the `run*` cores, which proves the
 * refusal precedes the payload build, the content hash, and the wire send. It
 * cannot prove ORDER against the handshake, because the cores never touch it:
 * the `*Action` wrappers resolve credentials and ping for capabilities first,
 * so a refusal that lived only in the core came after a round trip carrying the
 * caller's credentials.
 *
 * Here each `*Action` is driven with a refuse-tier value while the two
 * handshake entry points are replaced by spies that fail if they are reached.
 */
const handshake = vi.hoisted(() => ({
  resolveCredentialStore: vi.fn(() => {
    throw new Error('resolveCredentialStore reached');
  }),
  createCloudClient: vi.fn(() => {
    throw new Error('createCloudClient reached');
  }),
}));

vi.mock('@orcaops/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@orcaops/core')>()),
  ...handshake,
}));

const { reviewCommentAction } = await import('../../src/commands/plan/review/comment.js');
const { reviewDeclineAction } = await import('../../src/commands/plan/review/decline.js');
const { reviewProposeAction } = await import('../../src/commands/plan/review/propose.js');
const { reviewPushAction } = await import('../../src/commands/plan/review/push.js');
const { reviewVerdictAction } = await import('../../src/commands/plan/review/verdict.js');
const { planUploadAction } = await import('../../src/commands/plan/upload.js');
const { reviewFeedbackReplyAction } = await import('../../src/commands/review/reply.js');

// Real-shape, semantically dead. A refuse-tier vendor prefix.
const DEAD_TOKEN = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';
const DIRTY = `Rotate the deploy credential. Use ${DEAD_TOKEN} for the push.`;

describe('the outbound gate precedes the cloud handshake', () => {
  let repoRoot: string;
  let bodyFile: string;
  let stdout: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-gate-order-'));
    bodyFile = path.join(repoRoot, 'plan.md');
    await writeFile(bodyFile, DIRTY, 'utf8');
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    handshake.resolveCredentialStore.mockClear();
    handshake.createCloudClient.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const ACTIONS: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    ['plan upload', () => planUploadAction(bodyFile, { title: 'a plan', json: true })],
    ['plan review push', () => reviewPushAction('ext-1', { input: bodyFile, json: true })],
    ['plan review propose', () => reviewProposeAction('ext-1', { input: bodyFile, json: true })],
    ['plan review comment', () => reviewCommentAction('ext-1', { input: bodyFile, json: true })],
    [
      'plan review verdict',
      () => reviewVerdictAction('ext-1', { approve: true, note: DIRTY, json: true }),
    ],
    [
      'plan review decline',
      () => reviewDeclineAction('ext-1', { proposal: 'prop_1', reason: DIRTY, json: true }),
    ],
    ['review reply', () => reviewFeedbackReplyAction('cmt_1', { message: DIRTY, json: true })],
  ];

  for (const [verb, run] of ACTIONS) {
    it(`${verb} refuses without resolving credentials or opening a client`, async () => {
      await expect(run()).rejects.toThrow();
      expect(stdout).toContain('SECRET_IN_PAYLOAD');
      // The remedy is to describe the credential, never to quote it back.
      expect(stdout).not.toContain(DEAD_TOKEN);
      expect(handshake.resolveCredentialStore).not.toHaveBeenCalled();
      expect(handshake.createCloudClient).not.toHaveBeenCalled();
    });
  }
});
