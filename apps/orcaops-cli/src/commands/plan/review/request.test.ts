import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';

const remote = vi.hoisted(() => ({
  reviewRequest: vi.fn(),
  stampUsage: vi.fn(),
  cloud: vi.fn(),
  command: vi.fn(),
  dispatched: { value: true },
}));
vi.mock('./shared.js', async (original) => ({
  ...(await original<typeof import('./shared.js')>()),
  withReviewCloud: async (options: unknown, run: (context: unknown) => Promise<unknown>) => {
    remote.cloud(options);
    return run({ stampUsage: remote.stampUsage });
  },
  createReviewMutation: (_context: unknown, command: unknown) => {
    remote.command(command);
    return { client: { sourcePlan: remote }, didDispatch: () => remote.dispatched.value };
  },
}));

import { reviewRequestAction, runReviewRequest } from './request.js';
import { CliExit } from '../../../io/exit.js';

const response = {
  externalId: 'canonical-plan',
  added: [{ userId: 'ben', rawTag: 'Ben' }],
  alreadyRequested: [{ userId: 'alice', rawTag: 'Alice' }],
  unresolved: [],
};
const run = (reviewers = ['Ben']) =>
  runReviewRequest({ client: { sourcePlan: remote }, externalId: 'plan-slug', reviewers });

beforeEach(() => {
  vi.clearAllMocks();
  remote.dispatched.value = true;
  remote.reviewRequest.mockResolvedValue(response);
});
afterEach(() => vi.restoreAllMocks());

describe('requesting reviewers', () => {
  it('normalizes repeated identifiers and preserves canonical identity and result categories', async () => {
    const result = await run([' Ben ', 'Alice', 'Ben']);
    expect(remote.reviewRequest).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      external_id: 'plan-slug',
      reviewers: ['Alice', 'Ben'],
    });
    expect(result).toMatchObject({
      status: 'requested',
      external_id: 'canonical-plan',
      added: [{ user_id: 'ben', reviewer: 'Ben' }],
      already_requested: [{ user_id: 'alice', reviewer: 'Alice' }],
      unresolved: [],
      not_confirmed: [],
    });
  });

  it('reports a repeated request as unchanged', async () => {
    remote.reviewRequest.mockResolvedValue({ ...response, added: [] });
    expect(await run()).toMatchObject({ status: 'unchanged', added: [] });
  });

  it('prints a definite no-change result after a fresh request', async () => {
    remote.reviewRequest.mockResolvedValue({ ...response, added: [] });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await reviewRequestAction('plan-slug', { reviewer: ['Alice'] });
    expect(output.mock.calls.map((call) => call[0]).join('')).toContain(
      'No reviewer changes: the cloud reported nothing to change.'
    );
  });

  it('reports already-requested and unresolved reviewers as partial', async () => {
    remote.reviewRequest.mockResolvedValue({
      ...response,
      added: [],
      unresolved: ['Sam'],
    });
    expect(await run(['Alice', 'Sam'])).toMatchObject({ status: 'partial' });
  });

  it('reports a submitted spelling omitted by a folded response as not confirmed', async () => {
    remote.reviewRequest.mockResolvedValue({
      ...response,
      alreadyRequested: [],
    });
    expect(await run(['Ben', 'ben@example.test'])).toMatchObject({
      status: 'partial',
      unresolved: [],
      not_confirmed: ['ben@example.test'],
    });
  });

  it('accepts a normalized echoed spelling when every submitted identifier is represented', async () => {
    remote.reviewRequest.mockResolvedValue({
      ...response,
      added: [{ userId: 'ben', rawTag: 'ben@example.test' }],
      alreadyRequested: [],
    });
    expect(await run(['Ben@Example.Test'])).toMatchObject({
      status: 'requested',
      not_confirmed: [],
    });
  });

  it.each([
    { reviewers: [] },
    { reviewers: [' '] },
    { reviewers: Array.from({ length: 26 }, (_, index) => `Reviewer ${index}`) },
    { reviewers: ['x'.repeat(201)] },
  ])('rejects invalid input before dispatch', async ({ reviewers }) => {
    await expect(run(reviewers)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(remote.reviewRequest).not.toHaveBeenCalled();
  });

  it('applies the reviewer bound after normalization and deduplication', async () => {
    await expect(run(Array(26).fill(' Ben '))).resolves.toMatchObject({ status: 'requested' });
    expect(remote.reviewRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: ['Ben'] })
    );
  });

  it.each([
    ['FORBIDDEN', 403, /Only the plan author can request reviewers/],
    ['CONFLICT', 409, /APPROVED|PINNED|frozen/i],
    ['NOT_FOUND', 404, /Not found: plan/],
  ] as const)('maps %s cloud errors', async (code, httpStatus, message) => {
    remote.reviewRequest.mockRejectedValue(new TrpcRequestError('rejected', { code, httpStatus }));
    await expect(run()).rejects.toThrow(message);
  });

  it('emits one JSON result and exits nonzero after partial resolution', async () => {
    remote.reviewRequest.mockResolvedValue({ ...response, unresolved: ['Sam'] });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      reviewRequestAction('plan-slug', { reviewer: ['Ben', 'Sam'], json: true })
    ).rejects.toEqual(new CliExit(1));
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
      ok: false,
      status: 'partial',
      external_id: 'canonical-plan',
      added: [{ user_id: 'ben', reviewer: 'Ben' }],
      unresolved: ['Sam'],
    });
    expect(remote.cloud).toHaveBeenCalledWith(
      expect.objectContaining({ requires: ['source-plan-review-request/v1'] })
    );
    expect(remote.stampUsage).toHaveBeenCalledTimes(1);
  });

  it('reports unresolved names without claiming they were notified', async () => {
    remote.reviewRequest.mockResolvedValue({
      ...response,
      added: [],
      alreadyRequested: [],
      unresolved: ['Sam'],
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(reviewRequestAction('plan-slug', { reviewer: ['Sam'] })).rejects.toEqual(
      new CliExit(1)
    );
    const text = output.mock.calls.map((call) => call[0]).join('');
    expect(text).toContain('Unresolved: Sam (not requested)');
    expect(text).toContain('`orcaops plan review reviewers`');
    expect(text).not.toContain('notification queued');
  });

  it('emits success for resolved requests and validates before constructing the cloud client', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await reviewRequestAction('plan-slug', { reviewer: ['Ben'], json: true });
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
      ok: true,
      status: 'requested',
    });
    remote.cloud.mockClear();
    await expect(reviewRequestAction('plan-slug')).rejects.toEqual(new CliExit(1));
    expect(remote.cloud).not.toHaveBeenCalled();
  });

  it('journals no resend marker and sends no nonce on a plain request', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await reviewRequestAction('plan-slug', { reviewer: ['Ben'] }, { resendToken: () => 'nonce-1' });
    expect(remote.command).toHaveBeenCalledExactlyOnceWith({
      verb: 'request',
      externalId: 'plan-slug',
      reviewers: ['Ben'],
    });
    expect(remote.reviewRequest.mock.calls[0][0]).not.toHaveProperty('resend');
    expect(output.mock.calls.map((call) => call[0]).join('')).not.toContain('nonce-1');
  });

  it('mints a distinct journal command for every resend invocation', async () => {
    const tokens = ['nonce-1', 'nonce-2'];
    for (const token of tokens) {
      await reviewRequestAction(
        'plan-slug',
        { reviewer: ['Ben'], resend: true },
        { resendToken: () => token }
      );
    }
    const commands = remote.command.mock.calls.map((call) => call[0]);
    expect(commands).toEqual([
      { verb: 'request', externalId: 'plan-slug', reviewers: ['Ben'], resend: 'nonce-1' },
      { verb: 'request', externalId: 'plan-slug', reviewers: ['Ben'], resend: 'nonce-2' },
    ]);
    expect(commands[0]).not.toEqual(commands[1]);
  });

  it('keeps the resend nonce out of the outbound payload', async () => {
    await reviewRequestAction(
      'plan-slug',
      { reviewer: ['Ben'], resend: true },
      { resendToken: () => 'nonce-1' }
    );
    expect(remote.reviewRequest).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      external_id: 'plan-slug',
      reviewers: ['Ben'],
    });
  });

  it('stamps different reviewer sets and a resend as distinct usage', async () => {
    await reviewRequestAction('plan-slug', { reviewer: ['Ben'] });
    await reviewRequestAction('plan-slug', { reviewer: ['Alice'] });
    await reviewRequestAction(
      'plan-slug',
      { reviewer: ['Ben'], resend: true },
      { resendToken: () => 'nonce-1' }
    );
    const ids = remote.stampUsage.mock.calls.map((call) => call[0].stableEventId);
    expect(new Set(ids).size).toBe(3);
  });

  it('reports the resend intent and the dispatch fact', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await reviewRequestAction(
      'plan-slug',
      { reviewer: ['Ben'], resend: true, json: true },
      { resendToken: () => 'nonce-1' }
    );
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
      resend: true,
      dispatched: true,
    });
  });

  it('marks a replayed result as unsent and names the flag that resends it', async () => {
    remote.dispatched.value = false;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await reviewRequestAction('plan-slug', { reviewer: ['Ben'] });
    const text = output.mock.calls.map((call) => call[0]).join('');
    expect(text).toContain('nothing was sent');
    expect(text).toContain('--resend');
    expect(remote.stampUsage).not.toHaveBeenCalled();
  });
});
