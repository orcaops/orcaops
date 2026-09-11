import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { hardwareFlush, sameFile, validateAncestors, writeout } from './durability.js';
import { retentionCancelled, retentionGitUnavailable, runRetentionGit } from './git-process.js';
import { createRetentionRef, removeRetentionRef } from './ref-transaction.js';
import {
  type RegisteredDatabaseContext,
  revalidateDatabaseExecutionContext,
} from '../context/execution.js';
import { inspectDatabaseFilesystem } from '../context/filesystem.js';

const objectId = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .refine((value) => !/^0+$/.test(value));
const descriptor = z.strictObject({
  fullRef: z.string(),
  objectOid: objectId,
  treeOid: objectId,
  objectFormat: z.enum(['sha1', 'sha256']),
});
export type DatabaseGitPublication = z.infer<typeof descriptor>;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const snapshotRef = new RegExp(
  `^refs/orcaops/snap/${uuid}/([1-9][0-9]*)/(?:open|close|abandon)-${uuid}$`
);
const otherRef = new RegExp(
  `^refs/orcaops/(?:baseline/${uuid}-${uuid}|review/${uuid}-${uuid}(?:-base)?)$`
);

function protectedRef(): never {
  throw new ProjectDatabaseError(
    'HISTORY_UNEXPECTED_OWNER',
    'The expected immutable Git publication is symbolic or has different content; preserve it and inspect original ownership before explicit repair'
  );
}
async function currentRef(
  cwd: string,
  fullRef: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (
    (
      await runRetentionGit(cwd, ['symbolic-ref', '--quiet', fullRef], {
        signal,
        allowedExitCodes: [1],
      })
    ).code === 0
  )
    protectedRef();
  const result = await runRetentionGit(cwd, ['rev-parse', '--verify', '--quiet', fullRef], {
    signal,
    allowedExitCodes: [1],
  });
  return result.code === 0 ? result.stdout.trim() : null;
}
async function writeoutRef(
  common: string,
  publication: DatabaseGitPublication,
  device: bigint,
  signal?: AbortSignal
) {
  const loose = path.join(common, publication.fullRef);
  await validateAncestors(common, loose, device);
  let file: string;
  let packed = false;
  try {
    await lstat(loose);
    file = loose;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    file = path.join(common, 'packed-refs');
    packed = true;
  }
  retentionCancelled(signal);
  const observed = await lstat(file, { bigint: true });
  await writeout(file, device, false, (text) => {
    if (!packed) {
      if (text !== `${publication.objectOid}\n`) protectedRef();
    } else {
      const matches = text.split('\n').filter((line) => line.endsWith(` ${publication.fullRef}`));
      if (matches.length !== 1 || matches[0] !== `${publication.objectOid} ${publication.fullRef}`)
        protectedRef();
    }
  });
  let directory = path.dirname(file);
  for (;;) {
    retentionCancelled(signal);
    await writeout(directory, device, true);
    if (directory === common) break;
    const parent = path.dirname(directory);
    if (parent === directory || !directory.startsWith(`${common}${path.sep}`))
      retentionGitUnavailable(
        new Error('Git reference ancestry escaped its original common directory')
      );
    directory = parent;
  }
  return { file, observed, packed };
}

export async function publishDatabaseGitRef(
  expected: RegisteredDatabaseContext,
  raw: DatabaseGitPublication,
  options: { signal?: AbortSignal } = {}
): Promise<{ publication: 'created' | 'existing'; fullRef: string; objectOid: string }> {
  const parsed = descriptor.safeParse(raw);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact immutable Git publication descriptor',
      { cause: parsed.error }
    );
  const publication = parsed.data;
  const snapshot = snapshotRef.exec(publication.fullRef);
  if (
    (!snapshot && !otherRef.test(publication.fullRef)) ||
    (snapshot && !Number.isSafeInteger(Number(snapshot[1]))) ||
    publication.objectOid.length !== (publication.objectFormat === 'sha1' ? 40 : 64) ||
    publication.treeOid.length !== publication.objectOid.length
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select an exact newly authored retention namespace and matching Git object format'
    );
  const context = structuredClone(expected);
  const signal = options.signal;
  try {
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      retentionGitUnavailable(new Error('This platform has no qualified Git durability path'));
    await revalidateDatabaseExecutionContext(context, { signal });
    const cwd = context.git.worktreeRoot,
      common = context.git.commonDir;
    await inspectDatabaseFilesystem(common, signal);
    const format = await runRetentionGit(cwd, ['rev-parse', '--show-object-format'], { signal });
    const backend = await runRetentionGit(cwd, ['config', '--get', 'extensions.refStorage'], {
      signal,
      allowedExitCodes: [1],
    });
    if (
      format.stdout.trim() !== publication.objectFormat ||
      (backend.code === 0 && backend.stdout.trim() !== 'files')
    )
      retentionGitUnavailable(
        new Error(
          'This Git object format or ref backend is not qualified for publication; reftable remains a separate compatibility gate'
        )
      );
    const type = await runRetentionGit(cwd, ['cat-file', '-t', publication.objectOid], { signal });
    const tree = await runRetentionGit(
      cwd,
      ['rev-parse', '--verify', `${publication.objectOid}^{tree}`],
      { signal }
    );
    if (type.stdout.trim() !== 'commit' || tree.stdout.trim() !== publication.treeOid)
      protectedRef();
    const commonInfo = await lstat(common, { bigint: true });
    if (
      !commonInfo.isDirectory() ||
      commonInfo.isSymbolicLink() ||
      commonInfo.dev.toString() !== context.git.repositoryCreation.device ||
      commonInfo.ino.toString() !== context.git.repositoryCreation.inode
    )
      retentionGitUnavailable(
        new Error('Original Git common directory changed before publication')
      );
    const objects = (
      await runRetentionGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], {
        signal,
      })
    ).stdout.trim();
    const objectInfo = await lstat(objects, { bigint: true });
    if (
      !objectInfo.isDirectory() ||
      objectInfo.isSymbolicLink() ||
      objectInfo.dev !== commonInfo.dev
    )
      retentionGitUnavailable(
        new Error('Git object and reference storage must share the qualified local device')
      );
    const current = await currentRef(cwd, publication.fullRef, signal);
    if (current !== null && current !== publication.objectOid) protectedRef();
    let created = false;
    await validateAncestors(common, path.join(common, publication.fullRef), commonInfo.dev);
    if (current === null) {
      try {
        await createRetentionRef(context, publication, signal);
        created = true;
      } catch (cause) {
        if (
          !(cause instanceof ProjectDatabaseError) ||
          cause.code !== 'HISTORY_INACCESSIBLE' ||
          (await currentRef(cwd, publication.fullRef, signal)) !== publication.objectOid
        )
          throw cause;
      }
    }
    const representation = await writeoutRef(common, publication, commonInfo.dev, signal);
    if (process.platform === 'darwin')
      await hardwareFlush(cwd, objects, commonInfo.dev, publication.objectFormat, signal);
    retentionCancelled(signal);
    await revalidateDatabaseExecutionContext(context, { signal });
    if ((await currentRef(cwd, publication.fullRef, signal)) !== publication.objectOid)
      protectedRef();
    const finalRepresentation = await lstat(representation.file, { bigint: true });
    if (
      !sameFile(representation.observed, finalRepresentation) ||
      representation.observed.size !== finalRepresentation.size ||
      representation.observed.mtimeNs !== finalRepresentation.mtimeNs
    )
      retentionGitUnavailable(
        new Error(
          'Git reference representation changed after durability acknowledgement; retry the original publication'
        )
      );
    if (representation.packed) {
      try {
        await lstat(path.join(common, publication.fullRef));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
          return {
            publication: created ? 'created' : 'existing',
            fullRef: publication.fullRef,
            objectOid: publication.objectOid,
          };
        throw cause;
      }
      retentionGitUnavailable(
        new Error(
          'Git reference gained an unchecked loose representation; retry the original publication'
        )
      );
    }
    return {
      publication: created ? 'created' : 'existing',
      fullRef: publication.fullRef,
      objectOid: publication.objectOid,
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    retentionGitUnavailable(cause);
  }
}

export async function removeDatabaseGitRef(
  expected: RegisteredDatabaseContext,
  raw: Omit<DatabaseGitPublication, 'treeOid'>,
  options: { signal?: AbortSignal } = {}
): Promise<{ outcome: 'removed' | 'absent'; fullRef: string; objectOid: string }> {
  const parsed = descriptor.omit({ treeOid: true }).safeParse(raw);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact admitted cleanup ref, object ID and object format'
    );
  const publication = parsed.data;
  const snapshot = snapshotRef.exec(publication.fullRef);
  if (
    (!snapshot && !otherRef.test(publication.fullRef)) ||
    (snapshot && !Number.isSafeInteger(Number(snapshot[1]))) ||
    publication.objectOid.length !== (publication.objectFormat === 'sha1' ? 40 : 64)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact admitted authored cleanup namespace and Git object format'
    );
  const context = structuredClone(expected),
    signal = options.signal;
  try {
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      retentionGitUnavailable(new Error('This platform has no qualified Git durability path'));
    await revalidateDatabaseExecutionContext(context, { signal });
    const cwd = context.git.worktreeRoot,
      common = context.git.commonDir;
    await inspectDatabaseFilesystem(common, signal);
    const format = await runRetentionGit(cwd, ['rev-parse', '--show-object-format'], { signal });
    const backend = await runRetentionGit(cwd, ['config', '--get', 'extensions.refStorage'], {
      signal,
      allowedExitCodes: [1],
    });
    if (
      format.stdout.trim() !== publication.objectFormat ||
      (backend.code === 0 && backend.stdout.trim() !== 'files')
    )
      retentionGitUnavailable(
        new Error(
          'This Git backend/object format has no qualified cleanup path; preserve the publication'
        )
      );
    const commonInfo = await lstat(common, { bigint: true });
    if (
      !commonInfo.isDirectory() ||
      commonInfo.isSymbolicLink() ||
      commonInfo.dev.toString() !== context.git.repositoryCreation.device ||
      commonInfo.ino.toString() !== context.git.repositoryCreation.inode
    )
      retentionGitUnavailable(new Error('Original Git common directory changed before cleanup'));
    const objects = (
      await runRetentionGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], {
        signal,
      })
    ).stdout.trim();
    const objectInfo = await lstat(objects, { bigint: true });
    if (
      !objectInfo.isDirectory() ||
      objectInfo.isSymbolicLink() ||
      objectInfo.dev !== commonInfo.dev
    )
      retentionGitUnavailable(
        new Error('Git object and reference storage must share the qualified local device')
      );
    const loose = path.join(common, publication.fullRef);
    await validateAncestors(common, loose, commonInfo.dev);
    const before = await currentRef(cwd, publication.fullRef, signal);
    if (before !== null && before !== publication.objectOid) protectedRef();
    if (before !== null) await removeRetentionRef(context, publication, signal);
    retentionCancelled(signal);
    if ((await currentRef(cwd, publication.fullRef, signal)) !== null)
      retentionGitUnavailable(
        new Error(
          'The retired ref was recreated during cleanup; preserve it and retry only the admitted cleanup identity'
        )
      );
    const packed = path.join(common, 'packed-refs');
    let packedInfo: BigIntStats | null;
    try {
      packedInfo = await lstat(packed, { bigint: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      packedInfo = null;
    }
    if (packedInfo)
      await writeout(packed, commonInfo.dev, false, (text) => {
        if (text.split('\n').some((line) => line.endsWith(` ${publication.fullRef}`)))
          protectedRef();
      });
    let directory = path.dirname(loose);
    for (;;) {
      retentionCancelled(signal);
      try {
        await lstat(directory);
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      if (directory === common)
        retentionGitUnavailable(new Error('Original Git directory disappeared during cleanup'));
      directory = path.dirname(directory);
    }
    for (;;) {
      retentionCancelled(signal);
      await writeout(directory, commonInfo.dev, true);
      if (directory === common) break;
      directory = path.dirname(directory);
    }
    if (process.platform === 'darwin')
      await hardwareFlush(cwd, objects, commonInfo.dev, publication.objectFormat, signal);
    await revalidateDatabaseExecutionContext(context, { signal });
    if ((await currentRef(cwd, publication.fullRef, signal)) !== null)
      retentionGitUnavailable(
        new Error(
          'The retired ref was recreated after cleanup writeout; preserve it and retry only the admitted cleanup identity'
        )
      );
    let finalPacked: BigIntStats | null;
    try {
      finalPacked = await lstat(packed, { bigint: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      finalPacked = null;
    }
    if (
      (packedInfo === null) !== (finalPacked === null) ||
      (packedInfo &&
        finalPacked &&
        (!sameFile(packedInfo, finalPacked) ||
          packedInfo.size !== finalPacked.size ||
          packedInfo.mtimeNs !== finalPacked.mtimeNs))
    )
      retentionGitUnavailable(
        new Error(
          'Packed ref representation changed after cleanup writeout; retry only the admitted cleanup identity'
        )
      );
    return {
      outcome: before === null ? 'absent' : 'removed',
      fullRef: publication.fullRef,
      objectOid: publication.objectOid,
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    retentionGitUnavailable(cause);
  }
}
