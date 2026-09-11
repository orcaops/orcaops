import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type HistoryAuthority,
  historyCacheIdentity,
  historyPaths,
  normalizeHistoryRoot,
  readHistoryMetadata,
} from './authority.js';
import { uuidv7 } from '../ids/uuidv7.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'history-authority-'));
  roots.push(temporary);
  const root = await normalizeHistoryRoot({ root: path.join(temporary, 'data') });
  const authority: HistoryAuthority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    formatVersion: 1,
  };
  return { temporary, root, authority };
}

describe('history authority', () => {
  it('normalizes aliases and absent suffixes without creating directories', async () => {
    const f = await fixture();
    await symlink(f.temporary, path.join(f.temporary, 'alias'));
    expect(await normalizeHistoryRoot({ root: path.join(f.temporary, 'alias', 'data') })).toEqual(
      f.root
    );
    expect(await readdir(f.temporary)).toEqual(['alias']);
    expect(
      await normalizeHistoryRoot({
        env: { ORCAOPS_DATA_DIR: ' selected ', XDG_DATA_HOME: 'ignored' },
        cwd: f.temporary,
      })
    ).toEqual(await normalizeHistoryRoot({ root: path.join(f.temporary, 'selected') }));
    expect((await normalizeHistoryRoot({ env: { XDG_DATA_HOME: f.temporary } })).resolvedRoot).toBe(
      path.join(path.dirname(f.root.resolvedRoot), 'orcaops')
    );
    expect((await normalizeHistoryRoot({ env: {}, home: f.temporary })).resolvedRoot).toBe(
      path.join(path.dirname(f.root.resolvedRoot), '.orcaops')
    );
  });

  it('rejects dangling aliases, non-directory ancestors, and invalid authority paths', async () => {
    const f = await fixture();
    await symlink(path.join(f.temporary, 'missing'), path.join(f.temporary, 'broken'));
    await expect(
      normalizeHistoryRoot({ root: path.join(f.temporary, 'broken', 'data') })
    ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
    await writeFile(path.join(f.temporary, 'file'), 'occupied');
    await expect(
      normalizeHistoryRoot({ root: path.join(f.temporary, 'file', 'data') })
    ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
    expect(() => historyPaths({ ...f.authority, projectId: '../project' })).toThrow();
  });

  it('reads bounded metadata without following aliases or treating null as absence', async () => {
    const f = await fixture();
    const projectDir = historyPaths(f.authority).projectDir;
    await mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, 'record.json');
    await writeFile(file, JSON.stringify({ state: 'ready' }));
    expect(await readHistoryMetadata(f.root.resolvedRoot, file)).toEqual({ state: 'ready' });
    await writeFile(file, 'null');
    await expect(readHistoryMetadata(f.root.resolvedRoot, file)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    await writeFile(path.join(projectDir, 'target.json'), '{}');
    await symlink(path.join(projectDir, 'target.json'), path.join(projectDir, 'alias.json'));
    await expect(
      readHistoryMetadata(f.root.resolvedRoot, path.join(projectDir, 'alias.json'))
    ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
  });

  it('separates cache identities for store and root changes', async () => {
    const f = await fixture();
    const other = await normalizeHistoryRoot({ root: path.join(f.temporary, 'other') });
    expect(historyCacheIdentity({ ...f.authority, storeInstanceId: uuidv7() })).not.toBe(
      historyCacheIdentity(f.authority)
    );
    expect(historyCacheIdentity({ ...f.authority, ...other })).not.toBe(
      historyCacheIdentity(f.authority)
    );
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'does not treat inaccessible parents as absent',
    async () => {
      const f = await fixture();
      await mkdir(f.root.resolvedRoot);
      await chmod(f.root.resolvedRoot, 0);
      try {
        await expect(
          normalizeHistoryRoot({ root: path.join(f.root.resolvedRoot, 'missing') })
        ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
      } finally {
        await chmod(f.root.resolvedRoot, 0o700);
      }
    }
  );
});
