import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SupportedAgentId } from '@orcaops/storage';

import {
  activeEntries,
  planGlobalInstall,
  readGlobalManifest,
  resolveGlobalSkillsDir,
} from './global-install.js';

/**
 * The rest of the suite pins `ORCAOPS_GLOBAL_ROOT`, which short-circuits
 * `resolveGlobalSkillsDir` before the registry is consulted — so nothing else
 * exercises the native branch this bug lives on. These cases clear it.
 *
 * Hermeticity without the override: the manifest resolves through `$HOME` at
 * call time, so HOME is redirected; the skills root comes from the shared
 * setup's fixture `CLAUDE_CONFIG_DIR`. Neither real dir is touched.
 */
describe('global manifest under a native (env-derived) agent root', () => {
  let home: string;
  let foreignRoot: string;
  let prevGlobalRoot: string | undefined;
  let prevHome: string | undefined;

  const liveSkillsRoot = (): string => resolveGlobalSkillsDir('claude-code')!;

  const entryAt = (filePath: string, refs: string[]) => ({
    agent: 'claude-code' as const,
    surface: 'skill' as const,
    prefix: 'orcaops',
    path: filePath,
    materialization: 'copy' as const,
    symlinkTarget: null,
    expectedHash: 'a'.repeat(64),
    refs,
  });

  const writeManifest = async (entries: unknown[]): Promise<void> => {
    await mkdir(path.join(home, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(home, '.orcaops', 'install.local.json'),
      JSON.stringify({ manifest_version: 1, materialized_by: '9.9.9', entries }),
      'utf8'
    );
  };

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'orcaops-native-home-'));
    foreignRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-native-foreign-'));
    prevGlobalRoot = process.env.ORCAOPS_GLOBAL_ROOT;
    prevHome = process.env.HOME;
    delete process.env.ORCAOPS_GLOBAL_ROOT;
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (prevGlobalRoot === undefined) delete process.env.ORCAOPS_GLOBAL_ROOT;
    else process.env.ORCAOPS_GLOBAL_ROOT = prevGlobalRoot;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
    await rm(foreignRoot, { recursive: true, force: true });
  });

  it('resolves the agent root from the registry, not the global-root override', () => {
    expect(process.env.ORCAOPS_GLOBAL_ROOT).toBeUndefined();
    const live = liveSkillsRoot();
    expect(live).toBeTruthy();
    expect(live.endsWith(path.join('skills'))).toBe(true);
  });

  it('reads a manifest whose entries were recorded under a different agent root', async () => {
    const foreign = path.join(foreignRoot, 'skills', 'orcaops-capture', 'SKILL.md');
    await writeManifest([entryAt(foreign, ['repoOLD'])]);

    const m = await readGlobalManifest();
    expect(m).not.toBeNull();
    expect(m!.inert_entries?.map((e) => e.path)).toEqual([foreign]);
    expect(activeEntries(m)).toEqual([]);
  });

  it('keeps entries under the live root active alongside a foreign one', async () => {
    const live = path.join(liveSkillsRoot(), 'orcaops-capture', 'SKILL.md');
    const foreign = path.join(foreignRoot, 'skills', 'orcaops-why', 'SKILL.md');
    await writeManifest([entryAt(live, ['repoLIVE']), entryAt(foreign, ['repoOLD'])]);

    const m = await readGlobalManifest();
    expect(activeEntries(m).map((e) => e.path)).toEqual([live]);
    expect(m!.inert_entries?.map((e) => e.path)).toEqual([foreign]);
  });

  it('preserves a foreign root’s entries and refs across a write under the live root', async () => {
    const foreign = path.join(foreignRoot, 'skills', 'orcaops-capture', 'SKILL.md');
    await writeManifest([entryAt(foreign, ['repoOLD'])]);

    const r = await planGlobalInstall(
      {
        repoId: 'repoNEW',
        agents: ['claude-code'] as SupportedAgentId[],
        prefix: 'orcaops',
        generatedBy: '9.9.9',
        link: 'copy',
        cliVersion: '9.9.9',
      },
      'apply'
    );

    const carried = r.manifest.entries.find((e) => e.path === foreign);
    expect(carried).toBeDefined();
    expect(carried!.refs).toEqual(['repoOLD']);
    // Assert on the written manifest, NOT `activeEntries(r.manifest)`: a plan
    // result carries no `inert_entries`, so that helper returns every row and
    // the assertion would hold regardless of behaviour.
    const live = r.manifest.entries.filter((e) => e.path.startsWith(liveSkillsRoot() + path.sep));
    expect(live.length).toBeGreaterThan(0);
    expect(live.some((e) => e.refs.includes('repoNEW'))).toBe(true);
    expect(r.removed).not.toContain(foreign);
  });

  it('never deletes under a foreign root when the last live ref is released', async () => {
    const foreign = path.join(foreignRoot, 'skills', 'orcaops-capture', 'SKILL.md');
    await mkdir(path.dirname(foreign), { recursive: true });
    await writeFile(foreign, 'body', 'utf8');
    // The only record of repoGONE, so a naive sweep drives its ref to zero.
    await writeManifest([entryAt(foreign, ['repoGONE'])]);

    await planGlobalInstall(
      {
        repoId: 'repoGONE',
        agents: [] as SupportedAgentId[],
        prefix: 'orcaops',
        generatedBy: '9.9.9',
        link: 'copy',
        cliVersion: '9.9.9',
      },
      'apply'
    );

    expect(existsSync(foreign)).toBe(true);
    const after = await readGlobalManifest();
    const carried = after!.entries.find((e) => e.path === foreign);
    expect(carried?.refs).toEqual(['repoGONE']);
  });

  it('classifies each entry by its recorded path, so a restored root reads active again', async () => {
    // `agents.ts` freezes the root at module load, so the root cannot move
    // inside one process; drive the same decision by moving the recorded paths.
    const livePath = path.join(liveSkillsRoot(), 'orcaops-capture', 'SKILL.md');
    const foreignPath = path.join(foreignRoot, 'skills', 'orcaops-capture', 'SKILL.md');

    await writeManifest([entryAt(livePath, ['repoX'])]);
    expect(activeEntries(await readGlobalManifest()).map((e) => e.path)).toEqual([livePath]);
    expect((await readGlobalManifest())!.inert_entries).toBeUndefined();

    await writeManifest([entryAt(foreignPath, ['repoX'])]);
    const away = await readGlobalManifest();
    expect(away!.inert_entries?.map((e) => e.path)).toEqual([foreignPath]);
    expect(activeEntries(away)).toEqual([]);
    expect(away!.entries[0].refs).toEqual(['repoX']);

    await writeManifest([entryAt(livePath, ['repoX'])]);
    const back = await readGlobalManifest();
    expect(activeEntries(back).map((e) => e.path)).toEqual([livePath]);
    expect(back!.inert_entries).toBeUndefined();
    expect(back!.entries[0].refs).toEqual(['repoX']);
  });
});
