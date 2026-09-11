import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

import { isUuidV7 } from '../../ids/uuidv7.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';
import { inspectHistoryPath } from '../metadata.js';
import { HistoryError } from '../types.js';
import type { ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { readProjectInitialization } from './initialization.js';

export interface ProjectEvidenceFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}
export interface PublishProjectEvidence {
  readonly publicationId: string;
  readonly members: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly secretAllow: readonly string[];
}

const fileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}
function integrity(message: string): never {
  throw new ProjectDatabaseError('HISTORY_INTEGRITY_REQUIRED', message);
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Evidence publication cancelled; retry the original publication identity and content when ready'
    );
}
function validateDescriptor(input: ProjectEvidenceFile): ProjectEvidenceFile {
  if (!input || typeof input.relativePath !== 'string')
    invalid('Select an exact retained evidence descriptor');
  const parts = input.relativePath.split('/');
  if (
    parts.length !== 3 ||
    parts[0] !== 'evidence' ||
    !isUuidV7(parts[1]!) ||
    !fileNamePattern.test(parts[2]!) ||
    typeof input.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0
  )
    invalid('Select a contained immutable publication path with its exact hash and byte length');
  return { relativePath: input.relativePath, sha256: input.sha256, byteLength: input.byteLength };
}
function checkOwned(info: BigIntStats): void {
  if (process.getuid && info.uid !== BigInt(process.getuid()))
    throw new HistoryError(
      'HISTORY_UNEXPECTED_OWNER',
      'Preserve evidence with unexpected ownership for explicit repair'
    );
  if ((info.mode & 0o022n) !== 0n)
    integrity('Evidence path permits writes by another owner; preserve it for explicit repair');
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
async function closeEvidenceFile(handle: FileHandle, primary: unknown): Promise<void> {
  try {
    await handle.close();
  } catch (cause) {
    if (primary === undefined) throw cause;
    const failures = new AggregateError(
      [primary, cause],
      'Evidence operation and descriptor close failed'
    );
    if (primary instanceof ProjectDatabaseError)
      throw new ProjectDatabaseError(primary.code, primary.message, { cause: failures });
    if (primary instanceof HistoryError)
      throw new HistoryError(primary.code, primary.message, {
        ...primary.context,
        cause: failures,
      });
    throw failures;
  }
}

async function syncPath(root: string, file: string, directory: boolean): Promise<void> {
  await inspectHistoryPath(root, file);
  const before = await lstat(file, { bigint: true });
  checkOwned(before);
  if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile()))
    integrity('Evidence durability requires an owned regular path; preserve unexpected contents');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let primary: unknown;
  try {
    const opened = await handle.stat({ bigint: true });
    checkOwned(opened);
    if (!sameFile(before, opened)) integrity('Evidence path changed during durability validation');
    await handle.sync();
    const named = await lstat(file, { bigint: true });
    if (!sameFile(opened, named)) integrity('Evidence path changed while its durability settled');
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    await closeEvidenceFile(handle, primary);
  }
}

async function readExact(
  root: string,
  file: string,
  expected: ProjectEvidenceFile,
  missingAllowed: boolean
): Promise<Buffer | null> {
  const info = await inspectHistoryPath(root, file);
  if (!info) {
    if (missingAllowed) return null;
    integrity('Selected retained evidence is missing; restore it or use explicit repair');
  }
  const before = await lstat(file, { bigint: true });
  checkOwned(before);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expected.byteLength))
    integrity('Retained evidence differs from its declared type or size; preserve it for repair');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let primary: unknown;
  try {
    const opened = await handle.stat({ bigint: true });
    checkOwned(opened);
    if (!sameFile(before, opened) || !opened.isFile() || opened.size !== before.size)
      integrity('Retained evidence changed while opening; preserve it for repair');
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= expected.byteLength) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, expected.byteLength - length + 1));
      const result = await handle.read(buffer, 0, buffer.length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    checkOwned(after);
    checkOwned(named);
    const bytes = Buffer.concat(chunks);
    if (
      !sameFile(opened, named) ||
      after.size !== opened.size ||
      named.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      named.mtimeNs !== opened.mtimeNs ||
      bytes.length !== expected.byteLength ||
      sha256(bytes) !== expected.sha256
    )
      integrity(
        'Retained evidence differs from its exact hash or changed while reading; preserve it for repair'
      );
    return bytes;
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    await closeEvidenceFile(handle, primary);
  }
}

export async function readProjectEvidence(
  database: ProjectDatabase,
  descriptor: ProjectEvidenceFile
): Promise<Buffer> {
  const expected = validateDescriptor(descriptor);
  readProjectInitialization(database);
  const root = path.dirname(database.databasePath);
  try {
    const bytes = await readExact(root, path.join(root, expected.relativePath), expected, false);
    readProjectInitialization(database);
    return bytes!;
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError || cause instanceof HistoryError) throw cause;
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Cannot read selected evidence; inspect access and storage health without replacing history',
      { cause }
    );
  }
}

function prepare(input: PublishProjectEvidence) {
  if (
    !input ||
    !isUuidV7(input.publicationId) ||
    !Array.isArray(input.members) ||
    input.members.length === 0 ||
    !Array.isArray(input.secretAllow) ||
    !Array.from(input.secretAllow).every((value) => typeof value === 'string')
  )
    invalid(
      'Provide an immutable publication UUID, nonempty member batch and explicit secret allowlist'
    );
  const names = new Set<string>();
  const allow = [...input.secretAllow];
  return Array.from(input.members, (member) => {
    if (
      !member ||
      typeof member.name !== 'string' ||
      !fileNamePattern.test(member.name) ||
      names.has(member.name) ||
      !(member.bytes instanceof Uint8Array)
    )
      invalid('Provide distinct safe evidence filenames and exact UTF-8 bytes');
    names.add(member.name);
    const bytes = Buffer.from(member.bytes);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Retained review evidence must be UTF-8 text',
        { cause }
      );
    }
    try {
      assertNoSecretsInPayload(member.name, allow);
      assertNoSecretsInPayload(text, allow);
      // Scan lexical strings as well: parsing JSON would discard earlier duplicate keys.
      for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(match[0]);
        } catch {
          continue;
        }
        assertNoSecretsInPayload(decoded, allow);
      }
    } catch (cause) {
      if (!(cause instanceof SecretInPayloadError)) throw cause;
      throw new ProjectDatabaseError(
        'SECRET_IN_PAYLOAD',
        'Secret refusal: remove or redescribe refused evidence before a new attempt',
        { cause }
      );
    }
    return {
      bytes,
      descriptor: {
        relativePath: `evidence/${input.publicationId}/${member.name}`,
        sha256: sha256(bytes),
        byteLength: bytes.length,
      },
    };
  });
}

export async function publishProjectEvidence(
  database: ProjectDatabase,
  input: PublishProjectEvidence,
  options: { signal?: AbortSignal } = {}
): Promise<ProjectEvidenceFile[]> {
  const signal = options.signal;
  const members = prepare(input);
  cancelled(signal);
  readProjectInitialization(database);
  const root = path.dirname(database.databasePath);
  const directory = path.join(root, 'evidence', input.publicationId);
  const directories = [root, path.join(root, 'evidence'), directory];
  try {
    for (const target of directories) {
      cancelled(signal);
      readProjectInitialization(database);
      if (!(await inspectHistoryPath(root, target))) {
        try {
          await mkdir(target, { mode: 0o700 });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        }
      }
      const observed = await lstat(target, { bigint: true });
      checkOwned(observed);
      if (!observed.isDirectory() || observed.isSymbolicLink())
        integrity('Evidence ancestor is occupied by unexpected contents; preserve it for repair');
    }
    for (const member of members) {
      cancelled(signal);
      readProjectInitialization(database);
      const target = path.join(root, member.descriptor.relativePath);
      if (!(await readExact(root, target, member.descriptor, true))) {
        const temporary = path.join(directory, `.${randomUUID()}.tmp`);
        const handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600
        );
        let identity: BigIntStats;
        let primary: unknown;
        try {
          identity = await handle.stat({ bigint: true });
          await handle.writeFile(member.bytes);
          await handle.sync();
        } catch (cause) {
          primary = cause;
          throw cause;
        } finally {
          await closeEvidenceFile(handle, primary);
        }
        cancelled(signal);
        readProjectInitialization(database);
        await readExact(root, temporary, member.descriptor, false);
        if (!sameFile(identity, await lstat(temporary, { bigint: true })))
          integrity('Prepared evidence changed identity; preserve the leftover for repair');
        try {
          await link(temporary, target);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        }
        await readExact(root, target, member.descriptor, false);
        await syncPath(root, target, false);
        for (const ancestor of [...directories].reverse()) await syncPath(root, ancestor, true);
        // Failure never undoes a final publication or removes another attempt's temporary file.
        if (!sameFile(identity, await lstat(temporary, { bigint: true })))
          integrity('Temporary evidence ownership changed; preserve it for repair');
        await unlink(temporary);
        await syncPath(root, directory, true);
      } else {
        await syncPath(root, target, false);
        for (const ancestor of [...directories].reverse()) await syncPath(root, ancestor, true);
      }
    }
    cancelled(signal);
    readProjectInitialization(database);
    return members.map(({ descriptor }) => ({ ...descriptor }));
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError || cause instanceof HistoryError) throw cause;
    throw new HistoryError(
      'HISTORY_UNWRITABLE',
      'Evidence durability is incomplete; preserve leftovers and retry the original identity and content after fixing storage',
      { cause }
    );
  }
}
