import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readRepositoryRegistration } from '@orcaops/core/history/registration';
import { uuidv7 } from '@orcaops/storage';
import { HistoryError, normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  openProjectDatabase,
  ProjectDatabaseError,
  projectDatabasePath,
} from '@orcaops/storage/history/database';
import { HistoryPersistenceError } from '@orcaops/storage/history/primitives';

import { toErrorEnvelope, writeErrorLine } from './output.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'authority-output-')));
  roots.push(base);
  const root = await normalizeHistoryRoot({ root: base });
  return {
    base,
    authority: {
      ...root,
      projectId: uuidv7(),
      repositoryInstanceId: uuidv7(),
      storeInstanceId: uuidv7(),
    },
  };
}

describe('authority entry error output', () => {
  it('preserves an actual readonly connection path refusal without creating a database', async () => {
    const f = await fixture();
    const file = projectDatabasePath(f.authority);
    await mkdir(path.dirname(file), { recursive: true });
    const outside = path.join(f.base, 'protected');
    await writeFile(outside, 'untouched non-database content');
    await symlink(outside, file);
    const error = await openProjectDatabase({ authority: f.authority, mode: 'reader' }).catch(
      (cause: unknown) => cause
    );
    expect(error).toBeInstanceOf(ProjectDatabaseError);
    expect(toErrorEnvelope(error)).toEqual({
      ok: false,
      error: {
        code: 'HISTORY_INACCESSIBLE',
        message:
          'The selected history path cannot be validated; inspect ownership, permissions and original authority before retrying',
      },
    });
    expect(await readdir(path.dirname(file))).toEqual([path.basename(file)]);
    expect(await readFile(outside, 'utf8')).toBe('untouched non-database content');
  });

  it('preserves an actual occupied registration refusal and its repair guidance', async () => {
    const f = await fixture();
    const file = path.join(f.base, 'orcaops', 'registration.json');
    await mkdir(path.dirname(file));
    await writeFile(file, '');
    const error = await readRepositoryRegistration({ commonDir: f.base }).catch(
      (cause: unknown) => cause
    );
    expect(error).toBeInstanceOf(HistoryError);
    const envelope = toErrorEnvelope(error);
    expect(envelope.error.code).toBe('ACTIVATION_PENDING');
    expect(envelope.error.message).toContain('preserve it for explicit repair');
    expect(Object.keys(envelope.error).sort()).toEqual(['code', 'message']);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    writeErrorLine(error);
    expect(stderr).toEqual([`Error: [ACTIVATION_PENDING] ${envelope.error.message}\n`]);
    expect(await readdir(path.dirname(file))).toEqual(['registration.json']);
    expect(await readFile(file, 'utf8')).toBe('');
  });

  it.each([
    ['AUTHORITY_MISMATCH', 'Select the registered root.'],
    ['HISTORY_MISSING', 'Restore expected history; never replace it.'],
    ['HISTORY_INACCESSIBLE', 'Inspect permissions and storage health.'],
    ['HISTORY_UNWRITABLE', 'Fix write access before retrying the original publication.'],
    ['HISTORY_UNEXPECTED_OWNER', 'Preserve unknown ownership for explicit repair.'],
    ['HISTORY_FORMAT_UNSUPPORTED', 'Use a compatible release.'],
    ['HISTORY_INTEGRITY_REQUIRED', 'Preserve evidence for repair.'],
    [
      'ACTIVATION_PENDING',
      'Retry the original authorized initialization or repair malformed metadata.',
    ],
    ['IDENTITY_CONFLICT', 'Validate the winning authority before adoption.'],
    ['OPERATION_PENDING', 'Reprepare under the original operation identity.'],
  ] as const)(
    'retains the justified %s condition without its internal context',
    (code, message) => {
      const error = new HistoryError(code, message, {
        path: '/private/identity',
        payload: 'private content',
        cleanupCause: new Error('private cleanup'),
        reason: 'disk-full',
      });
      expect(toErrorEnvelope(error)).toEqual({ ok: false, error: { code, message } });
    }
  );

  it('does not grant primary trust to unrelated history conditions or generic persistence codes', () => {
    expect(toErrorEnvelope(new HistoryError('CONFLICT', 'Legacy conflict')).error.code).toBe(
      'INTERNAL'
    );
    expect(
      toErrorEnvelope(new HistoryPersistenceError('HISTORY_MISSING', 'Legacy persistence')).error
        .code
    ).toBe('INTERNAL');
    expect(
      toErrorEnvelope(Object.assign(new Error('Untrusted'), { code: 'HISTORY_INACCESSIBLE' })).error
        .code
    ).toBe('INTERNAL');
  });
});
