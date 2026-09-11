import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import {
  HistoryError,
  inspectHistoryPath,
  normalizeHistoryRoot,
} from '@orcaops/storage/history/authority';

export const markerByteLimit = 64 * 1024;

export async function validateRegistrationRoot(root: string, required: boolean): Promise<void> {
  if (!path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new HistoryError(
      'AUTHORITY_MISMATCH',
      'Registration requires an absolute normalized root'
    );
  }
  const normalized = await normalizeHistoryRoot({ root });
  if (normalized.resolvedRoot !== root) {
    throw new HistoryError(
      'AUTHORITY_MISMATCH',
      'Registration root is an alias; select its resolved authority'
    );
  }
  const existing = await inspectHistoryPath(root, root);
  if ((!existing && required) || (existing && !existing.isDirectory())) {
    throw new HistoryError(
      'HISTORY_INACCESSIBLE',
      'Registration root is not an available directory; inspect its Git or data authority'
    );
  }
}

export async function readRegistrationBytes(root: string, file: string): Promise<Buffer | null> {
  const info = await inspectHistoryPath(root, file);
  if (!info) return null;
  if (!info.isFile() || info.size > markerByteLimit) {
    throw new HistoryError(
      'ACTIVATION_PENDING',
      'Occupied registration is not a bounded regular file; preserve it for explicit repair',
      { path: file }
    );
  }
  let handle;
  try {
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new HistoryError(
        'ACTIVATION_PENDING',
        'Registration changed to a nonregular path; preserve it for explicit repair'
      );
    }
    const owner = process.getuid?.();
    if (owner !== undefined && before.uid !== BigInt(owner)) {
      throw new HistoryError(
        'HISTORY_UNEXPECTED_OWNER',
        'Registration changed ownership before opening; preserve it for explicit repair'
      );
    }
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (owner !== undefined && opened.uid !== BigInt(owner)) {
      throw new HistoryError(
        'HISTORY_UNEXPECTED_OWNER',
        'Opened registration has an unexpected owner; preserve it for explicit repair'
      );
    }
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new HistoryError(
        'ACTIVATION_PENDING',
        'Registration changed while opening; retry observation without adopting it'
      );
    }
    const buffer = Buffer.alloc(markerByteLimit + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await lstat(file, { bigint: true });
    if (
      length > markerByteLimit ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      BigInt(length) !== opened.size
    ) {
      throw new HistoryError(
        'ACTIVATION_PENDING',
        'Registration changed while reading; retry observation without adopting it'
      );
    }
    return buffer.subarray(0, length);
  } catch (cause) {
    if (cause instanceof HistoryError) throw cause;
    throw new HistoryError(
      'HISTORY_INACCESSIBLE',
      'Cannot read occupied registration; inspect permissions and storage without replacing it',
      { path: file, cause }
    );
  } finally {
    await handle?.close();
  }
}
