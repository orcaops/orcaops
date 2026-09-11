import { afterEach, expect, it, vi } from 'vitest';

import * as engine from '@orcaops/review-engine';

import { reviewAction } from './review.js';
import { runInInvocationContext } from '../lib/invocation-context.js';

vi.mock('@orcaops/review-engine', async (original) => ({ ...(await original<typeof engine>()) }));
afterEach(() => vi.restoreAllMocks());
it('retains invocation cwd, environment and explicit root arguments before runtime discovery', async () => {
  const context = {
    cwd: '/original',
    env: { ORCAOPS_ROOT: '/environment', ORCAOPS_DATA_DIR: '/data' },
  };
  const args = ['state', 'health', '--review', 'original'];
  const runtime = engine.defaultReviewRuntimeDescriptor();
  vi.spyOn(engine, 'reviewRuntimeDescriptorFromModule').mockImplementation(async () => {
    args[3] = 'changed';
    context.cwd = '/changed';
    context.env.ORCAOPS_DATA_DIR = '/changed';
    context.env.ORCAOPS_ROOT = '/changed';
    await Promise.resolve();
    return runtime;
  });
  const run = vi.spyOn(engine, 'runReview').mockResolvedValue(0);
  await runInInvocationContext(context, () => reviewAction(args, '/explicit'));
  expect(run).toHaveBeenCalledWith(
    ['review', 'state', 'health', '--review', 'original', '--root', '/explicit'],
    { ORCAOPS_ROOT: '/environment', ORCAOPS_DATA_DIR: '/data' },
    '/original',
    runtime
  );
});
