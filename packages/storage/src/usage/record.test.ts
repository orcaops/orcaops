import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveUsageLedgerRecord, loadUsageRecordPayload } from './record.js';
import { MAX_USAGE_SIDECAR_BYTES, type UsageLedgerRecord } from '../schema/usage-ledger.js';

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: openMock };
});

afterEach(() => {
  openMock.mockReset();
});

describe('usage sidecar reads', () => {
  it('rejects an oversized declaration before stat or allocation', async () => {
    const handle = fakeHandle(Buffer.alloc(0), 0);
    openMock.mockResolvedValue(handle.value);
    const record = { ...sidecarRecord('{}'), sidecar_size: MAX_USAGE_SIDECAR_BYTES + 1 };

    await expect(loadUsageRecordPayload(record, '/sidecars')).resolves.toEqual({ ok: false });
    expect(handle.stat).not.toHaveBeenCalled();
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('refuses to create a usage sidecar above the reader allocation ceiling', () => {
    expect(() =>
      deriveUsageLedgerRecord({
        type: 'source_plan_linked',
        ts: '2026-08-05T00:00:00.000Z',
        idempotency_key: 'oversized',
        payload: { value: 'x'.repeat(MAX_USAGE_SIDECAR_BYTES) },
      })
    ).toThrow(/exceeds/);
  });

  it('rejects a same-handle size mismatch without reading payload bytes', async () => {
    const handle = fakeHandle(Buffer.from('four'), 4);
    openMock.mockResolvedValue(handle.value);

    await expect(loadUsageRecordPayload(sidecarRecord('abc'), '/sidecars')).resolves.toEqual({
      ok: false,
    });
    expect(openMock).toHaveBeenCalledOnce();
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('rejects a non-regular sidecar before reading payload bytes', async () => {
    const handle = fakeHandle(Buffer.from('{}'), 2, false, false);
    openMock.mockResolvedValue(handle.value);

    await expect(loadUsageRecordPayload(sidecarRecord('{}'), '/sidecars')).resolves.toEqual({
      ok: false,
    });
    expect(handle.stat).toHaveBeenCalledOnce();
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('rejects growth after stat by probing one byte beyond the declaration', async () => {
    const declared = '{"value":1}';
    const handle = fakeHandle(Buffer.from(`${declared}X`), Buffer.byteLength(declared));
    openMock.mockResolvedValue(handle.value);

    await expect(loadUsageRecordPayload(sidecarRecord(declared), '/sidecars')).resolves.toEqual({
      ok: false,
    });
    expect(handle.read).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('keeps a hash-valid payload when closing the read-only handle fails', async () => {
    const payload = Buffer.from('{"value":1}');
    const handle = fakeHandle(payload, payload.byteLength, true);
    openMock.mockResolvedValue(handle.value);

    await expect(
      loadUsageRecordPayload(sidecarRecord(payload.toString('utf8')), '/sidecars')
    ).resolves.toEqual({ ok: true, payload: { value: 1 } });
    expect(handle.close).toHaveBeenCalledOnce();
  });
});

function sidecarRecord(bytes: string): UsageLedgerRecord {
  const payload = Buffer.from(bytes);
  return {
    event_id: '01999999-9999-7000-8000-000000000001',
    type: 'source_plan_linked',
    ts: '2026-08-05T00:00:00.000Z',
    schema_version: 1,
    idempotency_key: 'record-test',
    sidecar_sha256: createHash('sha256').update(payload).digest('hex'),
    sidecar_size: payload.byteLength,
    checksum: '0'.repeat(64),
  };
}

function fakeHandle(
  bytes: Buffer,
  statSize: number,
  closeFails = false,
  isRegular = true
): {
  value: FileHandle;
  stat: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  let position = 0;
  const stat = vi.fn(async () => ({ size: statSize, isFile: () => isRegular }));
  const read = vi.fn(
    async (buffer: Buffer, offset: number, length: number): Promise<{ bytesRead: number }> => {
      const bytesRead = Math.min(length, bytes.byteLength - position);
      bytes.copy(buffer, offset, position, position + bytesRead);
      position += bytesRead;
      return { bytesRead };
    }
  );
  const close = vi.fn(async () => {
    if (closeFails) throw Object.assign(new Error('mocked close EIO'), { code: 'EIO' });
  });
  return {
    value: {
      stat,
      read,
      close,
    } as unknown as FileHandle,
    stat,
    read,
    close,
  };
}
