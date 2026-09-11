import { afterEach, expect, it, vi } from 'vitest';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { createDatabaseCheckoutAction } from './checkout.js';
import { validateDatabaseCheckout } from '../lib/database-checkout.js';

const identity = {
  operationId: 'original-parent',
  focusOperationId: 'original-child',
  artifactId: 'original-artifact',
};
function fixture() {
  const close = vi.fn();
  const prepare = vi.fn(async () => ({
    prepared: {},
    identity,
    authority: {},
    shellKey: { kind: 'codex_session', value: 'test' },
  }));
  const openWriter = vi.fn(async () => ({ close }));
  const publish = vi.fn(async () => ({
    operationId: identity.operationId,
    artifactId: identity.artifactId,
    binding: { replayed: false, value: {}, counters: {} },
    focus: {
      state: 'updated',
      operationId: identity.focusOperationId,
      publication: {},
      error: null,
    },
  }));
  const action = createDatabaseCheckoutAction({
    prepare,
    openWriter,
    publish,
  } as unknown as Parameters<typeof createDatabaseCheckoutAction>[0]);
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { close, prepare, openWriter, publish, action, output };
}
afterEach(() => vi.restoreAllMocks());
it('rejects malformed options before an invocation can reach writer preparation', () => {
  for (const value of [
    null,
    [],
    { json: true, extra: true },
    { artifactId: 'id', clear: true },
    { operationId: 'invalid' },
  ])
    expect(() => validateDatabaseCheckout(value as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
});
it('preserves preparation failure without opening a writer', async () => {
  const f = fixture();
  f.prepare.mockRejectedValue(
    new ProjectDatabaseError('SECRET_IN_PAYLOAD', 'Refused original input')
  );
  await expect(f.action({ artifactId: 'original', json: true })).rejects.toMatchObject({ code: 1 });
  expect(f.openWriter).not.toHaveBeenCalled();
  expect(JSON.parse(f.output.join('')).error.code).toBe('SECRET_IN_PAYLOAD');
});
it('closes before success and removes its cancellation listener', async () => {
  const f = fixture();
  const listeners = process.listenerCount('SIGINT');
  f.close.mockImplementation(() => expect(f.output).toEqual([]));
  await f.action({ artifactId: 'original', json: true });
  expect(f.close).toHaveBeenCalledOnce();
  expect(JSON.parse(f.output.join(''))).toMatchObject({
    ok: true,
    operation_id: identity.operationId,
  });
  expect(process.listenerCount('SIGINT')).toBe(listeners);
});
it('retains committed binding and original retry IDs when focus fails', async () => {
  const f = fixture();
  f.publish.mockResolvedValue({
    operationId: identity.operationId,
    artifactId: identity.artifactId,
    binding: { replayed: false, value: {}, counters: {} },
    focus: {
      state: 'failed',
      operationId: identity.focusOperationId,
      publication: null,
      error: new ProjectDatabaseError('STALE_CONTEXT', 'Original slot changed'),
    },
  } as unknown as Awaited<ReturnType<typeof f.publish>>);
  await expect(f.action({ artifactId: 'original', json: true })).rejects.toMatchObject({ code: 1 });
  expect(f.output).toHaveLength(1);
  expect(JSON.parse(f.output[0])).toMatchObject({
    ok: false,
    error: { code: 'STALE_CONTEXT' },
    action: 'partial',
    binding: { state: 'committed' },
    focus: { state: 'failed' },
    operation_id: identity.operationId,
    focus_operation_id: identity.focusOperationId,
  });
});
it('preserves primary publication errors and emits cleanup failure only on stderr', async () => {
  const f = fixture();
  f.publish.mockRejectedValue(new ProjectDatabaseError('CANCELLED', 'Cancelled before settlement'));
  f.close.mockImplementation(() => {
    throw new Error('cleanup detail');
  });
  await expect(f.action({ artifactId: 'original', json: true })).rejects.toMatchObject({ code: 1 });
  expect(f.output).toHaveLength(1);
  expect(JSON.parse(f.output[0])).toMatchObject({
    error: { code: 'CANCELLED' },
    operation_id: identity.operationId,
  });
  expect(process.stderr.write).toHaveBeenCalled();
});
it('reports close failure after publication without emitting earlier success', async () => {
  const f = fixture();
  f.close.mockImplementation(() => {
    throw new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Close failed');
  });
  await expect(f.action({ artifactId: 'original', json: true })).rejects.toMatchObject({ code: 1 });
  expect(f.output).toHaveLength(1);
  expect(JSON.parse(f.output[0])).toMatchObject({
    ok: false,
    error: { code: 'HISTORY_INACCESSIBLE' },
    binding: { state: 'committed' },
    operation_id: identity.operationId,
  });
});
it('cancels before writer admission and reports visible waits on stderr', async () => {
  const f = fixture();
  f.prepare.mockImplementation(async (...args: unknown[]) => {
    const options = args[1] as { signal: AbortSignal; onWait(): void };
    options.onWait();
    options.onWait();
    process.emit('SIGINT');
    expect(options.signal.aborted).toBe(true);
    return {
      prepared: {},
      identity,
      authority: {},
      shellKey: { kind: 'codex_session', value: 'test' },
    };
  });
  await expect(f.action({ artifactId: 'original', json: true })).rejects.toMatchObject({ code: 1 });
  expect(f.openWriter).not.toHaveBeenCalled();
  expect(JSON.parse(f.output[0]).error.code).toBe('CANCELLED');
  expect(
    vi
      .mocked(process.stderr.write)
      .mock.calls.filter(([value]) => String(value).startsWith('Waiting for checkout'))
  ).toHaveLength(1);
});

it('cancels while the writer is opening without settling or stranding it', async () => {
  const f = fixture();
  f.openWriter.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { signal: AbortSignal };
    process.emit('SIGINT');
    expect(request.signal.aborted).toBe(true);
    return { close: f.close };
  });
  await expect(f.action({ artifactId: 'original', json: true })).rejects.toMatchObject({ code: 1 });
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
  expect(JSON.parse(f.output.join('')).error.code).toBe('CANCELLED');
});

it('keeps focus failure primary when binding committed and cleanup also fails', async () => {
  const f = fixture();
  f.publish.mockResolvedValue({
    operationId: identity.operationId,
    artifactId: identity.artifactId,
    binding: { replayed: false, value: {}, counters: {} },
    focus: {
      state: 'failed',
      operationId: identity.focusOperationId,
      publication: null,
      error: new ProjectDatabaseError('STALE_CONTEXT', 'Original focus slot changed'),
    },
  } as unknown as Awaited<ReturnType<typeof f.publish>>);
  f.close.mockImplementation(() => {
    throw new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Writer cleanup failed');
  });
  await expect(f.action({ artifactId: 'original', json: true })).rejects.toMatchObject({ code: 1 });
  expect(f.output).toHaveLength(1);
  expect(JSON.parse(f.output[0])).toMatchObject({
    ok: false,
    error: { code: 'STALE_CONTEXT' },
    binding: { state: 'committed' },
    focus: { state: 'failed' },
  });
  expect(process.stderr.write).toHaveBeenCalled();
});
