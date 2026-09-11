import { access, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { inspectHistoryPath } from './metadata.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, access: vi.fn(original.access) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const root = await realpath(await actual.mkdtemp(path.join(tmpdir(), 'history-metadata-')));
  roots.push(root);
  const file = path.join(root, 'history.sqlite3-journal');
  await actual.writeFile(file, 'rollback journal');
  return { actual, root, file };
}

it('reports a resource that disappears before its access check as absent', async () => {
  const f = await fixture();
  // What SQLite does to its own rollback journal while another initializer inspects it.
  vi.mocked(access).mockImplementation(async (target, mode) => {
    if (String(target) === f.file) await f.actual.rm(f.file);
    return f.actual.access(target, mode);
  });
  expect(await inspectHistoryPath(f.root, f.file)).toBeNull();
  await expect(f.actual.access(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps refusing a resource that is genuinely unreadable', async () => {
  const f = await fixture();
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  vi.mocked(access).mockImplementation(async (target, mode) => {
    if (String(target) === f.file) throw denied;
    return f.actual.access(target, mode);
  });
  await expect(inspectHistoryPath(f.root, f.file)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
    message: 'History resource is not readable',
    context: { path: f.file, cause: denied },
  });
});

it('still reports an absence that no readable ancestor can establish', async () => {
  const f = await fixture();
  const nested = path.join(f.root, 'projects');
  await mkdir(nested);
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  vi.mocked(access).mockImplementation(async (target, mode) => {
    if (String(target) === nested) throw denied;
    return f.actual.access(target, mode);
  });
  await expect(inspectHistoryPath(f.root, path.join(nested, 'absent'))).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
});

it('leaves an ordinary present resource and an ordinary absence unchanged', async () => {
  const f = await fixture();
  expect((await inspectHistoryPath(f.root, f.file))?.isFile()).toBe(true);
  expect(await inspectHistoryPath(f.root, path.join(f.root, 'absent'))).toBeNull();
  await writeFile(path.join(f.root, 'other'), 'kept');
  expect((await inspectHistoryPath(f.root, path.join(f.root, 'other')))?.isFile()).toBe(true);
});
