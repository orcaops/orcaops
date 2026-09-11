import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { enumerateLegacyGitContexts, resolveLegacyGitContext } from './source-git.js';

const execute = promisify(execFile);
const roots: string[] = [];
const projectId = '01900000-0000-7000-8000-000000000001';
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd: string, ...args: string[]) => execute('git', ['-C', cwd, ...args], { env });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'source-git-')));
  roots.push(root);
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  await git(cwd, 'init', '-qb', 'main');
  return { root, cwd };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('source Git administration', () => {
  it('preserves unknown project identity and unborn or detached branch evidence', async () => {
    const f = await fixture();
    expect(await resolveLegacyGitContext({ cwd: f.cwd, env })).toMatchObject({
      projectId: null,
      branch: 'main',
      headOid: null,
    });
    await git(
      f.cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'Initial'
    );
    await git(f.cwd, 'checkout', '--detach', '-q');
    await git(f.cwd, 'config', '--local', 'orcaops.projectid', projectId);
    expect(await resolveLegacyGitContext({ cwd: f.cwd, env })).toMatchObject({
      projectId,
      branch: null,
      headOid: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
  });
  it('detects real same-path Git replacement while accepting the unchanged original directory', async () => {
    const f = await fixture();
    const original = await resolveLegacyGitContext({ cwd: f.cwd, env });
    expect((await enumerateLegacyGitContexts(original, { env })).unresolved).toEqual([]);
    await rename(path.join(f.cwd, '.git'), path.join(f.root, 'retained-git'));
    await git(f.cwd, 'init', '-qb', 'main');
    const replaced = await resolveLegacyGitContext({ cwd: f.cwd, env });
    expect(replaced.commonDir).toBe(original.commonDir);
    expect(replaced.administrativeFingerprint).not.toBe(original.administrativeFingerprint);
    expect((await enumerateLegacyGitContexts(original, { env })).unresolved).not.toEqual([]);
    expect(await readdir(f.root)).toContain('retained-git');
  });
  it('observes canonical marker presence without interpreting or adopting its identities', async () => {
    const f = await fixture();
    const marker = path.join(f.cwd, '.git', 'orcaops', 'registration.json');
    await mkdir(path.dirname(marker));
    await writeFile(marker, '{"invalid":"canonical private payload"}');
    const context = await resolveLegacyGitContext({ cwd: f.cwd, env });
    expect(context.canonicalMarkers).toEqual([marker]);
    expect(context.projectId).toBeNull();
    expect(JSON.stringify(context)).not.toContain('canonical private payload');
    expect(await readdir(f.root)).toEqual(['repo']);
  });
  it('rejects duplicated Git project identities without selecting the final value', async () => {
    const f = await fixture();
    await git(f.cwd, 'config', '--local', '--add', 'orcaops.projectid', projectId);
    await git(f.cwd, 'config', '--local', '--add', 'orcaops.projectid', projectId);
    await expect(resolveLegacyGitContext({ cwd: f.cwd, env })).rejects.toMatchObject({
      code: 'SOURCE_CONFLICT',
    });
  });
});
