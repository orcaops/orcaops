import { randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  stringifyTerminalSafeJson,
  stripTerminalFormatting,
} from '@orcaops/evaluator-protocol/terminal';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { getInvocationCwd } from './invocation-context.js';
import { CliExit } from '../io/exit.js';
import { toErrorEnvelope } from '../io/output.js';

export const INSPECTION_BYTES = 16_384;
export const INSPECTION_DETAILS_BYTES = 32_768;
export const EXPORT_BYTES = 67_108_864;

export const inspectionArgument = (value: string) =>
  /^[\w./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export const inspectionBytes = (value: object): number =>
  Buffer.byteLength(stringifyTerminalSafeJson({ ok: true, ...value })) + 1;

export const inspectionValueBytes = (value: unknown): number =>
  Buffer.byteLength(stringifyTerminalSafeJson({ value: value ?? null })) -
  Buffer.byteLength('{"value":}');

export function writeInspectionParseError(text: string): void {
  process.stderr.write(
    Buffer.byteLength(text) <= INSPECTION_BYTES
      ? stripTerminalFormatting(text)
      : 'Invalid inspection arguments; oversized error details omitted. Use --help for supported options.\n'
  );
}

export function emitInspectionError(cause: unknown, json = true): never {
  let result = toErrorEnvelope(cause);
  if (inspectionBytes(result) > INSPECTION_BYTES) {
    result = {
      ok: false,
      error: {
        code: result.error.code,
        message:
          result.error.message +
          ' Additional error details omitted to fit the inspection allowance.',
      },
    };
  }
  if (inspectionBytes(result) > INSPECTION_BYTES)
    result = {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Inspection failed; the error text exceeds the output allowance.',
      },
    };
  if (json) process.stdout.write(stringifyTerminalSafeJson(result) + '\n');
  else
    process.stderr.write(
      stripTerminalFormatting(`Error: [${result.error.code}] ${result.error.message}\n`)
    );
  throw new CliExit(1);
}

export function measuredInspection<T extends object>(value: T, ceiling = INSPECTION_BYTES) {
  return measureResponse({ ...value, output: { ceiling_bytes: ceiling, bytes: 0 } });
}

export function measureResponse<T extends { output: { ceiling_bytes: number; bytes: number } }>(
  result: T
): T {
  for (;;) {
    const size = inspectionBytes(result);
    if (size > result.output.ceiling_bytes)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Required inspection metadata exceeds the output allowance. Narrow the selection.'
      );
    if (result.output.bytes === size) return result;
    result.output.bytes = size;
  }
}

export function validateExportPath(destination?: string) {
  if (
    destination !== undefined &&
    (!destination.trim() ||
      destination === '-' ||
      destination.length > 2048 ||
      [...destination].some((character) => character.charCodeAt(0) < 32))
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide a file path of at most 2048 characters, not stdout.'
    );
}

function* jsonChunks(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) {
      if (index) yield ',';
      yield* jsonChunks(value[index] ?? null);
    }
    yield ']';
  } else if (value !== null && typeof value === 'object') {
    yield '{';
    let first = true;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (!first) yield ',';
      first = false;
      yield JSON.stringify(key) + ':';
      yield* jsonChunks(child);
    }
    yield '}';
  } else yield JSON.stringify(value) ?? 'null';
}

export async function exportInspection(destination: string, value: object) {
  validateExportPath(destination);
  const absolute = path.resolve(getInvocationCwd(), destination);
  const temporary = path.join(path.dirname(absolute), `.orcaops-export-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        `${path.dirname(absolute)} is not an existing directory; choose a new file in one. ` +
          'Nothing was written.'
      );
    throw err;
  }
  let written = 0;
  try {
    let pending = '';
    const flush = async () => {
      if (!pending) return;
      const bytes = Buffer.from(pending);
      written += bytes.length;
      if (written > EXPORT_BYTES)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Export exceeds the 64 MiB file allowance. Select a checkpoint or section.'
        );
      await handle.writeFile(bytes);
      pending = '';
    };
    for (const chunk of jsonChunks({ ok: true, ...value })) {
      pending += chunk;
      if (Buffer.byteLength(pending) >= 65_536) await flush();
    }
    pending += '\n';
    await flush();
    await handle.sync();
    await handle.close();
    // A hard link publishes the complete file without ever replacing an existing destination.
    try {
      await link(temporary, absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST')
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          `${absolute} already exists; choose a new file. Nothing was written.`
        );
      throw err;
    }
    return { path: absolute, bytes: written };
  } finally {
    await handle.close();
    await unlink(temporary);
  }
}
