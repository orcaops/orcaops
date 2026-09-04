import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearCommonDirCache } from '@orcaops/core';
import { createLinkedWorktree, createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  desiredPersonalExcludeLines,
  personalManifestLocation,
  readEffectiveLocalManifest,
  readPersonalManifest,
  readPersonalManifestState,
  retainedPersonalManifest,
} from './personal-manifest.js';

const validManifest = JSON.stringify(
  { manifest_version: 1, entries: [], info_exclude: ['.orcaops/'] },
  null,
  2
);

describe('personal manifest', () => {
  let main: TempRepo;
  let linked: TempRepo;

  beforeEach(async () => {
    clearCommonDirCache();
    main = await createTempRepo({ initialBranch: 'main' });
    linked = await createLinkedWorktree(main.path);
  });
  afterEach(async () => {
    await linked.cleanup();
    await main.cleanup();
    clearCommonDirCache();
  });

  const write = async (body: string): Promise<string> => {
    const { manifestPath } = await personalManifestLocation(main.path);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, body, 'utf8');
    return manifestPath;
  };

  it('lives in the git common dir and is the same file from every worktree', async () => {
    const fromMain = await personalManifestLocation(main.path);
    const fromLinked = await personalManifestLocation(linked.path);
    expect(fromLinked.manifestPath).toBe(fromMain.manifestPath);
    expect(path.basename(fromMain.manifestPath)).toBe('personal-manifest.json');
    expect(fromMain.containmentRoot).toBe(fromLinked.containmentRoot);
  });

  it('reports absent, valid, and stale states without throwing', async () => {
    expect((await readPersonalManifestState(main.path)).kind).toBe('absent');
    await write(validManifest);
    const valid = await readPersonalManifestState(linked.path);
    expect(valid.kind).toBe('valid');
    await write('{ not json');
    const stale = await readPersonalManifestState(main.path);
    expect(stale.kind).toBe('stale');
    expect(stale.kind === 'stale' && stale.reason).toMatch(/not valid JSON/);
    await write(JSON.stringify({ manifest_version: 999, entries: 'nope' }));
    expect((await readPersonalManifestState(main.path)).kind).toBe('stale');
    // A stale manifest reads as none: the caller decides whether to replace it.
    expect(await readPersonalManifest(main.path)).toBeNull();
  });

  it('fails closed on a symlinked manifest with the remove-and-init recovery', async () => {
    const { manifestPath } = await personalManifestLocation(main.path);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(path.join(main.path, 'elsewhere.json'), validManifest, 'utf8');
    await symlink(path.join(main.path, 'elsewhere.json'), manifestPath);
    await expect(readPersonalManifestState(main.path)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('orcaops init --personal'),
    });
    await expect(readPersonalManifestState(main.path)).rejects.not.toThrow(/orcaops update/);
  });

  it('selects the common manifest for personal scope and the worktree one otherwise', async () => {
    await write(validManifest);
    expect(await readEffectiveLocalManifest(linked.path, 'personal')).not.toBeNull();
    expect(await readEffectiveLocalManifest(linked.path, 'project')).toBeNull();
  });

  it('keeps the exclusion desired while any personal claim exists', async () => {
    expect(await desiredPersonalExcludeLines(main.path, 'personal')).toEqual(['.orcaops/']);
    expect(await desiredPersonalExcludeLines(main.path, 'project')).toEqual([]);
    await write(validManifest);
    // A sibling on project scope must not strip the block the manifest owns.
    expect(await desiredPersonalExcludeLines(linked.path, 'project')).toEqual(['.orcaops/']);
    expect(await desiredPersonalExcludeLines(linked.path, 'global')).toEqual(['.orcaops/']);
  });

  it('refuses to release exclusion ownership from a stale manifest', async () => {
    await write('{ not json');

    await expect(desiredPersonalExcludeLines(linked.path, 'project')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('cannot prove exclusion ownership'),
    });
  });

  it('retains only the exclusion after uninstall', () => {
    const retained = retainedPersonalManifest({
      manifest_version: 1,
      entries: [
        {
          kind: 'generated-file',
          path: 'x',
          expectedHash: null,
          provenance: 'created',
          deleteMode: 'never',
        },
      ],
      info_exclude: ['.orcaops/'],
    });
    expect(retained.entries).toEqual([]);
    expect(retained.info_exclude).toEqual(['.orcaops/']);
  });
});
