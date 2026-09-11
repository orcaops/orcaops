import { randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';

import { isUuidV7 } from '@orcaops/storage';
import { HistoryError, inspectHistoryPath } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { decodeRegistration } from './registration-files-format.js';
import { readRegistrationBytes, validateRegistrationRoot } from './registration-files-io.js';

function checkOwner(info: BigIntStats, file: string): void {
  if (process.getuid && info.uid !== BigInt(process.getuid())) {
    throw new HistoryError(
      'HISTORY_UNEXPECTED_OWNER',
      'Preserve metadata with unexpected ownership for explicit repair',
      { path: file }
    );
  }
}

async function syncPath(file: string, directory: boolean): Promise<void> {
  const before = await lstat(file, { bigint: true });
  checkOwner(before, file);
  if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile())) {
    throw new HistoryError(
      'HISTORY_INACCESSIBLE',
      'Cannot establish durability through an unexpected metadata path',
      { path: file }
    );
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    checkOwner(opened, file);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new HistoryError(
        'ACTIVATION_PENDING',
        'Metadata changed before durability could be established; retry the original publication'
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectories(root: string, directory: string): Promise<string[]> {
  await validateRegistrationRoot(root, true);
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HistoryError(
      'HISTORY_INACCESSIBLE',
      'Registration destination escapes its administrative root'
    );
  }
  const directories = [root];
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    const parent = directories[directories.length - 1];
    const next = path.join(parent, segment);
    const existing = await inspectHistoryPath(root, next);
    if (!existing) {
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      }
    }
    const actual = await inspectHistoryPath(root, next);
    if (!actual?.isDirectory()) {
      throw new HistoryError(
        'HISTORY_INACCESSIBLE',
        'Occupied metadata ancestor is not an owned directory; preserve it for repair',
        { path: next }
      );
    }
    directories.push(next);
  }
  return directories;
}

export interface PreparedRegistration {
  publish(signal?: AbortSignal): Promise<'created' | 'existing'>;
  dispose(primaryFailure?: unknown): Promise<void>;
}

// The temporary name and the pattern that recognizes it are one contract: a reader that
// re-derives it from the ".tmp" suffix alone would mistake a foreign file for ours, and
// one that never recognizes it reads every interrupted publication as unknown ownership.
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const preparedName = new RegExp(`^\\.(.+)\\.${uuid}\\.${uuid}\\.tmp$`);
function prepareName(target: string, operationId: string, unique: string): string {
  return `.${target}.${operationId}.${unique}.tmp`;
}

/**
 * The final entry name a prepared temporary belongs to, or null when the name was not
 * written by this publisher. A recognized leftover is preserved, never adopted or removed.
 */
export function preparedRegistrationTarget(name: string): string | null {
  return preparedName.exec(name)?.[1] ?? null;
}

/**
 * Whether the name is a temporary this publisher prepared for a catalog entry. Catalog
 * readers meet it while a publication is in flight and after an interrupted one, and must
 * report complete history either way; the leftover is preserved, never reused or removed.
 */
export function isPreparedCatalogEntryName(name: string): boolean {
  const target = preparedRegistrationTarget(name);
  return !!target && target.endsWith('.json') && isUuidV7(target.slice(0, -5));
}

export async function prepareRegistration<T extends { hash: string }>(input: {
  root: string;
  file: string;
  bytes: Buffer;
  schema: z.ZodType<T>;
  operationId: string;
}): Promise<PreparedRegistration> {
  const { root, file, schema, operationId } = input;
  const bytes = Buffer.from(input.bytes);
  const directory = path.dirname(file);
  const verifyExisting = async (): Promise<boolean> => {
    const existing = await readRegistrationBytes(root, file);
    if (!existing) return false;
    decodeRegistration(existing, schema, 'Existing immutable registration');
    if (!existing.equals(bytes)) {
      throw new HistoryError(
        'IDENTITY_CONFLICT',
        'Immutable registration already has different content; validate the winning authority instead of replacing it',
        { path: file }
      );
    }
    return true;
  };
  await verifyExisting();
  let temporary: string | undefined;
  let identity: BigIntStats | undefined;
  let settled = false;
  let linked = false;
  const removeTemporary = async (): Promise<void> => {
    if (!temporary || !identity) return;
    const actual = await lstat(temporary, { bigint: true }).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return null;
        throw cause;
      }
    );
    if (!actual) return;
    checkOwner(actual, temporary);
    if (actual.dev !== identity.dev || actual.ino !== identity.ino || !actual.isFile()) {
      throw new HistoryError(
        'ACTIVATION_PENDING',
        'Temporary registration ownership changed; preserve it for explicit repair',
        { path: temporary }
      );
    }
    await unlink(temporary);
    temporary = undefined;
    await syncPath(directory, true);
  };
  const dispose = async (primaryFailure?: unknown): Promise<void> => {
    try {
      await removeTemporary();
    } catch (cleanupCause) {
      if (primaryFailure instanceof HistoryError) {
        primaryFailure.context.cleanupCause = cleanupCause;
        return;
      }
      if (primaryFailure instanceof Error) {
        primaryFailure.cause = new AggregateError(
          primaryFailure.cause === undefined
            ? [cleanupCause]
            : [primaryFailure.cause, cleanupCause],
          'Registration also failed to clean its temporary file; preserve the leftover for repair'
        );
        return;
      }
      if (cleanupCause instanceof HistoryError) throw cleanupCause;
      throw new HistoryError(
        'HISTORY_UNWRITABLE',
        'Registration temporary cleanup is incomplete; preserve the leftover and retry the original operation after fixing access or storage',
        { path: temporary, linked, cause: cleanupCause }
      );
    }
  };
  try {
    const directories = await ensureDirectories(root, directory);
    temporary = path.join(directory, prepareName(path.basename(file), operationId, randomUUID()));
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      identity = await handle.stat({ bigint: true });
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return {
      dispose,
      async publish(signal) {
        if (settled || !temporary || !identity) {
          throw new HistoryError(
            'OPERATION_PENDING',
            'Registration preparation is no longer available; retry the original operation'
          );
        }
        settled = true;
        try {
          await inspectHistoryPath(root, directory);
          const current = await lstat(temporary, { bigint: true });
          checkOwner(current, temporary);
          if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
            throw new HistoryError(
              'ACTIVATION_PENDING',
              'Prepared registration changed; preserve it for explicit repair'
            );
          }
          const actualBytes = await readRegistrationBytes(root, temporary);
          if (!actualBytes?.equals(bytes))
            throw new HistoryError(
              'ACTIVATION_PENDING',
              'Prepared registration content changed; preserve it for explicit repair'
            );
          if (signal?.aborted)
            throw new ProjectDatabaseError(
              'CANCELLED',
              'Registration cancelled before linking; retry the original operation when ready'
            );
          let result: 'created' | 'existing' = 'created';
          try {
            await link(temporary, file);
            linked = true;
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
            if (!(await verifyExisting())) throw cause;
            result = 'existing';
            await syncPath(file, false);
          }
          // Equal retries must also settle names left behind by an earlier failed directory sync.
          for (const item of [...directories].reverse()) await syncPath(item, true);
          await dispose();
          return result;
        } catch (cause) {
          if (cause instanceof HistoryError || cause instanceof ProjectDatabaseError) throw cause;
          throw new HistoryError(
            'HISTORY_UNWRITABLE',
            'Registration durability is incomplete; retry the same identity and content without undoing a published marker',
            { path: file, linked, cause }
          );
        }
      },
    };
  } catch (cause) {
    try {
      await dispose();
    } catch (cleanupCause) {
      throw new HistoryError(
        'HISTORY_UNWRITABLE',
        'Registration preparation and temporary cleanup failed; preserve leftovers and retry the original operation',
        { cause, cleanupCause }
      );
    }
    if (cause instanceof HistoryError) throw cause;
    throw new HistoryError(
      'HISTORY_UNWRITABLE',
      'Cannot prepare a durable registration; inspect permissions and storage before retrying',
      { cause }
    );
  }
}
