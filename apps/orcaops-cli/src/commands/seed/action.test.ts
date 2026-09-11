import { afterEach, expect, it, vi } from 'vitest';

import { getDefaultConfig } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { createDatabaseSeedAction } from './index.js';

function fixture(overrides: Partial<Parameters<typeof createDatabaseSeedAction>[0]> = {}) {
  const close = vi.fn();
  const resolveContext = vi.fn(async (...args: unknown[]) => {
    const options = args[0] as { signal: AbortSignal; onWait(): void };
    return {
      close,
      operationOptions: { signal: options.signal, onWait: options.onWait },
    };
  });
  const run = vi.fn(async () => ({ mode: 'applied', totals: { failed: 0 } }));
  const action = createDatabaseSeedAction({
    resolveContext,
    run,
    ...overrides,
  } as unknown as Parameters<typeof createDatabaseSeedAction>[0]);
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { action, close, output, resolveContext, run };
}

afterEach(() => vi.restoreAllMocks());

it('rejects invalid options before resolving project history', async () => {
  const f = fixture();
  await expect(f.action({ dryRun: true, yes: true, json: true })).rejects.toMatchObject({
    code: 1,
  });
  expect(f.resolveContext).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
  expect(JSON.parse(f.output.join('')).error.code).toBe('INVALID_INPUT');
});

it('preserves raw-input refusal without starting the seed run', async () => {
  const f = fixture();
  f.resolveContext.mockRejectedValue(
    new ProjectDatabaseError('SECRET_IN_PAYLOAD', 'Refused original input')
  );
  await expect(f.action({ author: 'refused', yes: true, json: true })).rejects.toMatchObject({
    code: 1,
  });
  expect(f.resolveContext).toHaveBeenCalledWith(
    expect.objectContaining({
      authoredPayloads: [{ author: 'refused', yes: true, json: true }],
      signal: expect.any(AbortSignal),
      onWait: expect.any(Function),
    })
  );
  expect(f.run).not.toHaveBeenCalled();
  expect(JSON.parse(f.output.join('')).error.code).toBe('SECRET_IN_PAYLOAD');
});

it('refuses authored enrichment before initialization or writer opening', async () => {
  const prepareAuthored = vi.fn(async () => {
    throw new ProjectDatabaseError('SECRET_IN_PAYLOAD', 'Refused authored enrichment');
  });
  const f = fixture({ prepareAuthored });
  let writerOpened = false;
  f.resolveContext.mockImplementation(async (...args: unknown[]) => {
    const options = args[0] as {
      signal: AbortSignal;
      onWait(): void;
      beforeWrite(input: {
        repoRoot: string;
        config: ReturnType<typeof getDefaultConfig>;
        database: null;
      }): Promise<void>;
    };
    await options.beforeWrite({ repoRoot: '/repo', config: getDefaultConfig(), database: null });
    writerOpened = true;
    return {
      close: f.close,
      operationOptions: { signal: options.signal, onWait: options.onWait },
    };
  });
  await expect(
    f.action({ yes: true, enrichmentDir: '/authored', json: true })
  ).rejects.toMatchObject({ code: 1 });
  expect(prepareAuthored).toHaveBeenCalledOnce();
  expect(writerOpened).toBe(false);
  expect(f.run).not.toHaveBeenCalled();
  expect(JSON.parse(f.output.join('')).error.code).toBe('SECRET_IN_PAYLOAD');
});

it('cancels while the writer context is opening without running seed writes', async () => {
  const f = fixture();
  f.resolveContext.mockImplementation(async (...args: unknown[]) => {
    const options = args[0] as { signal: AbortSignal };
    process.emit('SIGINT');
    expect(options.signal.aborted).toBe(true);
    return { close: f.close, operationOptions: { signal: options.signal, onWait: vi.fn() } };
  });
  await expect(f.action({ yes: true, json: true })).rejects.toMatchObject({ code: 1 });
  expect(f.run).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
  expect(JSON.parse(f.output.join('')).error.code).toBe('CANCELLED');
});

it('reports a context wait once and cancels before application writes', async () => {
  const f = fixture();
  f.resolveContext.mockImplementation(async (...args: unknown[]) => {
    const options = args[0] as { signal: AbortSignal; onWait(): void };
    options.onWait();
    options.onWait();
    process.emit('SIGINT');
    expect(options.signal.aborted).toBe(true);
    throw new ProjectDatabaseError('CANCELLED', 'Seed context wait cancelled');
  });
  await expect(f.action({ yes: true, json: true })).rejects.toMatchObject({ code: 1 });
  expect(f.run).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(process.stderr.write)
      .mock.calls.filter(([value]) => String(value).startsWith('Waiting for seed'))
  ).toHaveLength(1);
  expect(JSON.parse(f.output.join('')).error.code).toBe('CANCELLED');
});
