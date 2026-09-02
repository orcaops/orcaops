import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SKILL_TEMPLATES } from '@orcaops/adapters';
import { sha256Hex, type SupportedAgentId } from '@orcaops/storage';

import {
  planGlobalInstall,
  readGlobalManifest,
  releaseGlobalRefs,
  resolveGlobalSkillsDir,
} from './global-install.js';

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

describe('global install', () => {
  let root: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-global-'));
    prevEnv = process.env.ORCAOPS_GLOBAL_ROOT;
    process.env.ORCAOPS_GLOBAL_ROOT = root; // hermetic: redirects the whole global footprint
  });
  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.ORCAOPS_GLOBAL_ROOT;
    else process.env.ORCAOPS_GLOBAL_ROOT = prevEnv;
    await rm(root, { recursive: true, force: true });
  });

  const base = {
    agents: ['claude-code'] as SupportedAgentId[],
    prefix: 'orcaops',
    generatedBy: '9.9.9',
    link: 'copy' as const,
    cliVersion: '9.9.9',
  };
  const skillsDir = (): string => resolveGlobalSkillsDir('claude-code')!;

  it('creates and locks an absent global root on first materialization', async () => {
    const absentRoot = path.join(root, 'absent', 'global');
    process.env.ORCAOPS_GLOBAL_ROOT = absentRoot;

    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');

    expect(await exists(path.join(absentRoot, 'install.local.json'))).toBe(true);
    expect(
      (await readGlobalManifest())!.entries.every((entry) => entry.refs.includes('repoA'))
    ).toBe(true);
  });

  it('materializes global skills into a ref-counted manifest', async () => {
    const r = await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    expect(r.materialized.length).toBeGreaterThan(0);
    expect(await exists(path.join(skillsDir(), 'orcaops-capture', 'SKILL.md'))).toBe(true);

    const m = await readGlobalManifest();
    expect(m!.materialized_by).toBe('9.9.9');
    expect(m!.entries.length).toBeGreaterThan(0);
    expect(m!.entries.every((e) => e.refs.includes('repoA'))).toBe(true);
  });

  it('a skills subset (the enabled set) materializes only those skill dirs', async () => {
    const subset = SKILL_TEMPLATES.filter((s) => s.id !== 'digest');
    await planGlobalInstall({ repoId: 'repoA', ...base, skills: subset }, 'apply');

    expect(await exists(path.join(skillsDir(), 'orcaops-capture', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(skillsDir(), 'orcaops-digest'))).toBe(false);

    const m = await readGlobalManifest();
    const skillEntries = m!.entries.filter((e) => e.surface === 'skill');
    expect(skillEntries).toHaveLength(subset.length);
    expect(skillEntries.some((e) => e.path.includes('orcaops-digest'))).toBe(false);

    // Re-running with the FULL set materializes the missing dir (re-enable path).
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    expect(await exists(path.join(skillsDir(), 'orcaops-digest', 'SKILL.md'))).toBe(true);
  });

  describe('gate-withheld skills are held, not deleted', () => {
    const CLOUD = SKILL_TEMPLATES.filter((s) => (s.requires ?? []).includes('cloud'));
    const UNGATED = SKILL_TEMPLATES.filter((s) => !(s.requires ?? []).includes('cloud'));
    const cloudDir = (t: { id: string }): string => path.join(skillsDir(), `orcaops-${t.id}`);

    it('keeps a materialized cloud skill when the machine loses its credentials', async () => {
      // The hash guard would PERMIT the delete precisely because the file is
      // unmodified.
      await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
      for (const t of CLOUD) expect(await exists(path.join(cloudDir(t), 'SKILL.md'))).toBe(true);

      const res = await planGlobalInstall(
        { repoId: 'repoA', ...base, skills: UNGATED, heldSkills: CLOUD },
        'apply'
      );

      for (const t of CLOUD) {
        expect(await exists(path.join(cloudDir(t), 'SKILL.md'))).toBe(true);
        expect(res.removed.some((p) => p.includes(`orcaops-${t.id}`))).toBe(false);
        expect(res.held.some((p) => p.includes(`orcaops-${t.id}`))).toBe(true);
      }
      const m = await readGlobalManifest();
      for (const t of CLOUD) {
        const entry = m!.entries.find((e) => e.path.includes(`orcaops-${t.id}`));
        expect(entry?.refs).toEqual(['repoA']);
      }
    });

    it('survives an overrideAhead rewrite — force downgrades the tree, never the hold', async () => {
      await planGlobalInstall(
        { repoId: 'repoA', ...base, generatedBy: '99.0.0', cliVersion: '99.0.0' },
        'apply'
      );
      const r = await planGlobalInstall(
        {
          repoId: 'repoA',
          ...base,
          generatedBy: '0.0.5',
          cliVersion: '0.0.5',
          skills: UNGATED,
          heldSkills: CLOUD,
          force: true,
          overrideAhead: true,
        },
        'apply'
      );
      expect(r.skippedVersionMismatch).toBe(false);
      for (const t of CLOUD) {
        expect(await exists(path.join(cloudDir(t), 'SKILL.md'))).toBe(true);
        expect(r.removed.some((p) => p.includes(`orcaops-${t.id}`))).toBe(false);
        expect(r.held.some((p) => p.includes(`orcaops-${t.id}`))).toBe(true);
      }
      const m = await readGlobalManifest();
      for (const t of CLOUD) {
        expect(m!.entries.find((e) => e.path.includes(`orcaops-${t.id}`))?.refs).toEqual(['repoA']);
      }
    });

    it('never creates a held skill that was not already there', async () => {
      const res = await planGlobalInstall(
        { repoId: 'repoA', ...base, skills: UNGATED, heldSkills: CLOUD },
        'apply'
      );
      for (const t of CLOUD) expect(await exists(cloudDir(t))).toBe(false);
      expect(res.held).toEqual([]);
      const m = await readGlobalManifest();
      expect(m!.entries.some((e) => CLOUD.some((t) => e.path.includes(`orcaops-${t.id}`)))).toBe(
        false
      );
    });

    it('never adds a ref a held skill did not already have', async () => {
      await planGlobalInstall({ repoId: 'repoB', ...base }, 'apply');
      await planGlobalInstall(
        { repoId: 'repoA', ...base, skills: UNGATED, heldSkills: CLOUD },
        'apply'
      );
      const m = await readGlobalManifest();
      for (const t of CLOUD) {
        const entry = m!.entries.find((e) => e.path.includes(`orcaops-${t.id}`));
        expect(entry?.refs).toEqual(['repoB']);
      }
    });

    it('still releases a held key when the repo leaves global scope', async () => {
      // `agents: []` holds nothing, so a scope exit cleans up everything.
      await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
      await releaseGlobalRefs({ repoId: 'repoA', cliVersion: base.cliVersion }, 'apply');
      for (const t of CLOUD) expect(await exists(cloudDir(t))).toBe(false);
    });

    it('still removes a skill the user disabled rather than one the gate withholds', async () => {
      await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
      await planGlobalInstall(
        {
          repoId: 'repoA',
          ...base,
          skills: SKILL_TEMPLATES.filter((s) => s.id !== 'digest'),
          heldSkills: CLOUD,
        },
        'apply'
      );
      expect(await exists(path.join(skillsDir(), 'orcaops-digest'))).toBe(false);
    });

    it('holds under the prior prefix too, so a rename does not delete', async () => {
      // No heldPrefixes argument: the prior manifest records them, so a caller
      // cannot lose the protection by forgetting to pass it.
      await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
      await planGlobalInstall(
        { repoId: 'repoA', ...base, prefix: 'oo', skills: UNGATED, heldSkills: CLOUD },
        'apply'
      );
      for (const t of CLOUD) expect(await exists(path.join(cloudDir(t), 'SKILL.md'))).toBe(true);
    });

    it('an explicit prefix list still overrides the derived one', async () => {
      await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
      await planGlobalInstall(
        {
          repoId: 'repoA',
          ...base,
          prefix: 'oo',
          skills: UNGATED,
          heldSkills: CLOUD,
          // Omits the prior prefix, so nothing is held under it.
          heldPrefixes: ['oo'],
        },
        'apply'
      );
      for (const t of CLOUD) expect(await exists(cloudDir(t))).toBe(false);
    });

    it('derives nothing from a key another repo holds', async () => {
      // repoA never referenced the key, so its rename must not inherit a hold.
      await planGlobalInstall({ repoId: 'repoB', ...base }, 'apply');
      const res = await planGlobalInstall(
        { repoId: 'repoA', ...base, prefix: 'oo', skills: UNGATED, heldSkills: CLOUD },
        'apply'
      );
      expect(res.held).toEqual([]);
    });
  });

  it('two repos sharing a prefix ref-count each key to 2', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    await planGlobalInstall({ repoId: 'repoB', ...base }, 'apply');
    const m = await readGlobalManifest();
    expect(
      m!.entries.every(
        (e) => e.refs.length === 2 && e.refs.includes('repoA') && e.refs.includes('repoB')
      )
    ).toBe(true);
  });

  it('a prefix change decrements old keys and increments new ones', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply'); // prefix orcaops
    const r = await planGlobalInstall({ repoId: 'repoA', ...base, prefix: 'oo' }, 'apply');
    expect(r.removed.length).toBeGreaterThan(0); // old orcaops-* keys hit refcount 0
    const m = await readGlobalManifest();
    expect(m!.entries.every((e) => e.prefix === 'oo')).toBe(true);
    expect(await exists(path.join(skillsDir(), 'orcaops-capture'))).toBe(false); // old dir removed
    expect(await exists(path.join(skillsDir(), 'oo-capture', 'SKILL.md'))).toBe(true);
  });

  it('a second repo keeps a shared key alive when the first changes prefix', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    await planGlobalInstall({ repoId: 'repoB', ...base }, 'apply'); // both on orcaops
    await planGlobalInstall({ repoId: 'repoA', ...base, prefix: 'oo' }, 'apply'); // A moves to oo
    const m = await readGlobalManifest();
    // orcaops-* keys still referenced by repoB (not removed); oo-* keys referenced by repoA.
    expect(await exists(path.join(skillsDir(), 'orcaops-capture', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(skillsDir(), 'oo-capture', 'SKILL.md'))).toBe(true);
    const orcaopsKey = m!.entries.find((e) => e.prefix === 'orcaops');
    expect(orcaopsKey!.refs).toEqual(['repoB']);
  });

  it('refuses a CLI version mismatch without reporting or persisting ownership changes', async () => {
    // generatedBy tracks cliVersion as every real caller does — otherwise the
    // fixture's stamps would trip the AHEAD guard before the mismatch branch.
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '1.0.0', cliVersion: '1.0.0' },
      'apply'
    );
    const manifestPath = path.join(root, 'install.local.json');
    const beforeBytes = await readFile(manifestPath, 'utf8');
    const before = await readGlobalManifest();

    const r = await planGlobalInstall(
      { repoId: 'repoB', ...base, generatedBy: '2.0.0', cliVersion: '2.0.0' },
      'apply'
    );

    expect(r.skippedVersionMismatch).toBe(true);
    expect(r.materialized).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/materialized by CLI v1\.0\.0/);
    expect(r.materialized).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.copyFallbacks).toEqual([]);
    expect(r.manifest).toEqual(before);
    expect(await readFile(manifestPath, 'utf8')).toBe(beforeBytes);
    expect(await readGlobalManifest()).toEqual(before);
    expect(before!.entries.every((entry) => !entry.refs.includes('repoB'))).toBe(true);
  });

  it('warns + SKIPS the rewrite on a CLI version mismatch (per-user-current)', async () => {
    // generatedBy tracks cliVersion as every real caller does; the base
    // fixture's 9.9.9 bytes would be ahead of BOTH CLIs and trip the ahead guard.
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '1.0.0', cliVersion: '1.0.0' },
      'apply'
    );
    const r = await planGlobalInstall(
      { repoId: 'repoB', ...base, generatedBy: '2.0.0', cliVersion: '2.0.0' },
      'apply'
    );
    expect(r.skippedVersionMismatch).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/materialized by CLI v1\.0\.0/);
    const m = await readGlobalManifest();
    expect(m!.materialized_by).toBe('1.0.0'); // ownership not taken over by the newer CLI
    expect(r.materialized).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it('a non-skipped PREVIEW still reports what it would materialize (dry-run intact)', async () => {
    const r = await planGlobalInstall({ repoId: 'repoA', ...base }, 'preview');
    expect(r.skippedVersionMismatch).toBe(false);
    expect(r.materialized.length).toBeGreaterThan(0);
    expect(await readGlobalManifest()).toBeNull();
  });

  it('blanket force does NOT downgrade a global tree materialized by a NEWER CLI (ahead guard)', async () => {
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '99.0.0', cliVersion: '99.0.0' },
      'apply'
    );
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    const aheadBytes = await readFile(skill, 'utf8');

    const r = await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '0.0.5', cliVersion: '0.0.5', force: true },
      'apply'
    );
    expect(r.skippedVersionMismatch).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/NEWER orcaops \(v99\.0\.0\)/);
    expect(r.warnings.join(' ')).toMatch(/update --force/);
    expect(await readFile(skill, 'utf8')).toBe(aheadBytes);
    expect((await readGlobalManifest())!.materialized_by).toBe('99.0.0');
    expect(r.materialized).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it('overrideAhead DOWNGRADES the ahead global tree — proving the guard, not luck, preserves it', async () => {
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '99.0.0', cliVersion: '99.0.0' },
      'apply'
    );
    const r = await planGlobalInstall(
      {
        repoId: 'repoA',
        ...base,
        generatedBy: '0.0.5',
        cliVersion: '0.0.5',
        force: true,
        overrideAhead: true,
      },
      'apply'
    );
    expect(r.skippedVersionMismatch).toBe(false);
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    expect(await readFile(skill, 'utf8')).toContain('orcaops@0.0.5');
    expect((await readGlobalManifest())!.materialized_by).toBe('0.0.5');
  });

  it('interrupted newer run: ahead FILES under a same-version manifest are not downgraded', async () => {
    // Artifacts land before the manifest, so an interrupted newer run leaves
    // ahead files under a manifest that still claims this CLI's version.
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '0.0.5', cliVersion: '0.0.5' },
      'apply'
    );
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    const manifest = (await readGlobalManifest())!;
    expect(manifest.materialized_by).toBe('0.0.5'); // manifest still claims the OLD version
    const aheadBytes = (await readFile(skill, 'utf8')).replace(/orcaops@[^"\n]+/, 'orcaops@99.0.0');
    await writeFile(skill, aheadBytes, 'utf8');

    const r = await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '0.0.5', cliVersion: '0.0.5', force: true },
      'apply'
    );
    expect(r.skippedVersionMismatch).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/NEWER orcaops \(v99\.0\.0\)/);
    expect(await readFile(skill, 'utf8')).toBe(aheadBytes);
    expect((await readGlobalManifest())!.materialized_by).toBe('0.0.5');
  });

  it('interrupted newer run: overrideAhead still repairs it (the guard is not a dead end)', async () => {
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '0.0.5', cliVersion: '0.0.5' },
      'apply'
    );
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    await writeFile(
      skill,
      (await readFile(skill, 'utf8')).replace(/orcaops@[^"\n]+/, 'orcaops@99.0.0'),
      'utf8'
    );

    const r = await planGlobalInstall(
      {
        repoId: 'repoA',
        ...base,
        generatedBy: '0.0.5',
        cliVersion: '0.0.5',
        force: true,
        overrideAhead: true,
      },
      'apply'
    );
    expect(r.skippedVersionMismatch).toBe(false);
    expect(await readFile(skill, 'utf8')).toContain('orcaops@0.0.5');
  });

  it('an ahead artifact under an OBSOLETE prefix still blocks the rewrite (refs + manifest untouched)', async () => {
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '0.0.5', cliVersion: '0.0.5' },
      'apply'
    );
    // Interrupted newer run restamped the existing orcaops-* artifact...
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    const aheadBytes = (await readFile(skill, 'utf8')).replace(/orcaops@[^"\n]+/, 'orcaops@99.0.0');
    await writeFile(skill, aheadBytes, 'utf8');
    const before = await readGlobalManifest();

    // ...then a prefix change makes those keys removal candidates: only the
    // prior-entry scan can see the ahead stamp (the desired set is oo-*).
    const r = await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '0.0.5', cliVersion: '0.0.5', prefix: 'oo' },
      'apply'
    );
    expect(r.skippedVersionMismatch).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/NEWER orcaops \(v99\.0\.0\)/);
    expect(await readFile(skill, 'utf8')).toBe(aheadBytes);
    expect(await readGlobalManifest()).toEqual(before);
    expect(await exists(path.join(skillsDir(), 'oo-capture', 'SKILL.md'))).toBe(false);
  });

  it('keeps a store blob another agent root still links to when the last local ref drops', async () => {
    // One skill under two agent roots shares a single store blob, so reclaiming
    // it here dangles the other root's symlinks while the manifest still
    // records them as intact.
    await planGlobalInstall({ repoId: 'repoLIVE', ...base, link: 'symlink' }, 'apply');
    const live = (await readGlobalManifest())!.entries.find((e) =>
      e.path.endsWith(path.join('orcaops-capture', 'SKILL.md'))
    )!;
    const store = path.resolve(path.dirname(live.path), live.symlinkTarget!);
    expect(await exists(store)).toBe(true);

    const foreignRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-foreign-root-'));
    const foreignPath = path.join(foreignRoot, 'skills', 'orcaops-capture', 'SKILL.md');
    await mkdir(path.dirname(foreignPath), { recursive: true });
    const rel = path.relative(path.dirname(foreignPath), store);
    await symlink(rel, foreignPath);
    const raw = JSON.parse(await readFile(path.join(root, 'install.local.json'), 'utf8')) as {
      entries: unknown[];
    };
    raw.entries.push({ ...live, path: foreignPath, symlinkTarget: rel, refs: ['repoOTHER'] });
    await writeFile(path.join(root, 'install.local.json'), JSON.stringify(raw), 'utf8');
    expect((await readGlobalManifest())!.inert_entries?.map((e) => e.path)).toEqual([foreignPath]);

    const r = await planGlobalInstall({ repoId: 'repoLIVE', ...base, agents: [] }, 'apply');

    expect(await exists(store)).toBe(true);
    // `exists` stats through the link, so this proves it still RESOLVES.
    expect(await exists(foreignPath)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/shared global store artifact/);
    await rm(foreignRoot, { recursive: true, force: true });
  });

  it('absent manifest: an ahead symlink STORE blocks the rewrite (interrupted symlink-mode install)', async () => {
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '0.0.5', cliVersion: '0.0.5', link: 'symlink' },
      'apply'
    );
    const m = (await readGlobalManifest())!;
    const entry = m.entries.find((e) => e.path.endsWith(path.join('orcaops-capture', 'SKILL.md')))!;
    const store = path.resolve(path.dirname(entry.path), entry.symlinkTarget!);
    const aheadBytes = (await readFile(store, 'utf8')).replace(/orcaops@[^"\n]+/, 'orcaops@99.0.0');
    await writeFile(store, aheadBytes, 'utf8');
    // Interrupted newer FIRST install: ahead store bytes, no manifest. The
    // visible path is a symlink the no-follow read skips — only the store
    // scan can see the ahead stamp.
    await rm(path.join(root, 'install.local.json'));

    const r = await planGlobalInstall(
      {
        repoId: 'repoA',
        ...base,
        generatedBy: '0.0.5',
        cliVersion: '0.0.5',
        link: 'symlink',
        force: true,
      },
      'apply'
    );
    expect(r.skippedVersionMismatch).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/NEWER orcaops \(v99\.0\.0\)/);
    expect(await readFile(store, 'utf8')).toBe(aheadBytes);
    expect(await readGlobalManifest()).toBeNull();
  });

  it('force still bypasses a BEHIND-version mismatch (existing upgrade path unregressed)', async () => {
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '1.0.0', cliVersion: '1.0.0' },
      'apply'
    );
    const r = await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '2.0.0', cliVersion: '2.0.0', force: true },
      'apply'
    );
    expect(r.skippedVersionMismatch).toBe(false);
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    expect(await readFile(skill, 'utf8')).toContain('orcaops@2.0.0');
    expect((await readGlobalManifest())!.materialized_by).toBe('2.0.0');
  });

  it('absent manifest: an ahead-stamped on-disk file blocks the rewrite; ownership still gates the override', async () => {
    const dir = path.join(skillsDir(), 'orcaops-capture');
    await mkdir(dir, { recursive: true });
    const skill = path.join(dir, 'SKILL.md');
    const aheadBytes = '---\nname: "x"\nmetadata:\n  generatedBy: "orcaops@99.0.0"\n---\nbody\n';
    await writeFile(skill, aheadBytes, 'utf8');

    const r = await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '0.0.5', cliVersion: '0.0.5', force: true },
      'apply'
    );
    expect(r.skippedVersionMismatch).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/NEWER orcaops \(v99\.0\.0\)/);
    expect(await readFile(skill, 'utf8')).toBe(aheadBytes);
    expect(await readGlobalManifest()).toBeNull();

    // The override grants DIRECTION permission, not ownership: with no
    // manifest entry the path is unowned, and the refusal names the
    // ownership remedy rather than re-advising the override.
    await expect(
      planGlobalInstall(
        {
          repoId: 'repoA',
          ...base,
          generatedBy: '0.0.5',
          cliVersion: '0.0.5',
          force: true,
          overrideAhead: true,
        },
        'apply'
      )
    ).rejects.toThrow(/unowned or modified/);
    expect(await readFile(skill, 'utf8')).toBe(aheadBytes);
    expect(await readGlobalManifest()).toBeNull();
  });

  it('preserves refs when their owning CLI version cannot release them', async () => {
    // generatedBy tracks cliVersion so this pins the MISMATCH branch, not the
    // ahead guard (the base fixture's 9.9.9 stamps would be ahead of 2.0.0).
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '1.0.0', cliVersion: '1.0.0' },
      'apply'
    );
    const manifestPath = path.join(root, 'install.local.json');
    const beforeBytes = await readFile(manifestPath, 'utf8');

    const r = await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '2.0.0' }, 'apply');

    expect(r?.skippedVersionMismatch).toBe(true);
    expect(r?.warnings.join(' ')).toMatch(/materialized by CLI v1\.0\.0/);
    expect(r?.removed).toEqual([]);
    expect(await readFile(manifestPath, 'utf8')).toBe(beforeBytes);
    expect(
      (await readGlobalManifest())!.entries.every((entry) => entry.refs.includes('repoA'))
    ).toBe(true);
  });

  it('does not relabel retained entries during a forced cross-version release', async () => {
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '1.0.0', cliVersion: '1.0.0' },
      'apply'
    );
    await planGlobalInstall(
      { repoId: 'repoB', ...base, generatedBy: '1.0.0', cliVersion: '1.0.0' },
      'apply'
    );

    await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '2.0.0', force: true }, 'apply');

    const manifest = (await readGlobalManifest())!;
    expect(manifest.materialized_by).toBe('1.0.0');
    expect(manifest.entries.every((entry) => entry.refs.includes('repoB'))).toBe(true);
    expect(manifest.entries.every((entry) => !entry.refs.includes('repoA'))).toBe(true);
  });

  it('sole-ref release of an AHEAD tree needs the downgrade override, not plain force (copy)', async () => {
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '99.0.0', cliVersion: '99.0.0' },
      'apply'
    );
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    const aheadBytes = await readFile(skill, 'utf8');

    const r = await releaseGlobalRefs(
      { repoId: 'repoA', cliVersion: '0.0.5', force: true },
      'apply'
    );
    expect(r?.skippedVersionMismatch).toBe(true);
    expect(r?.warnings.join(' ')).toMatch(/NEWER orcaops \(v99\.0\.0\)/);
    expect(await readFile(skill, 'utf8')).toBe(aheadBytes);
    expect(
      (await readGlobalManifest())!.entries.every((entry) => entry.refs.includes('repoA'))
    ).toBe(true);

    const forced = await releaseGlobalRefs(
      { repoId: 'repoA', cliVersion: '0.0.5', force: true, overrideAhead: true },
      'apply'
    );
    expect(forced?.skippedVersionMismatch).toBe(false);
    expect(await exists(skill)).toBe(false);
  });

  it('sole-ref release of an AHEAD tree needs the downgrade override, not plain force (symlink)', async () => {
    await planGlobalInstall(
      { repoId: 'repoA', ...base, generatedBy: '99.0.0', cliVersion: '99.0.0', link: 'symlink' },
      'apply'
    );
    const m = (await readGlobalManifest())!;
    const entry = m.entries.find((e) => e.path.endsWith(path.join('orcaops-capture', 'SKILL.md')))!;
    const store = path.resolve(path.dirname(entry.path), entry.symlinkTarget!);
    const storeBytes = await readFile(store, 'utf8');

    const r = await releaseGlobalRefs(
      { repoId: 'repoA', cliVersion: '0.0.5', force: true },
      'apply'
    );
    expect(r?.skippedVersionMismatch).toBe(true);
    expect(await readFile(store, 'utf8')).toBe(storeBytes);
    expect((await readGlobalManifest())!.entries.every((e) => e.refs.includes('repoA'))).toBe(true);

    const forced = await releaseGlobalRefs(
      { repoId: 'repoA', cliVersion: '0.0.5', force: true, overrideAhead: true },
      'apply'
    );
    expect(forced?.skippedVersionMismatch).toBe(false);
    expect(await exists(store)).toBe(false);
  });

  it('removes an unreferenced symlink store blob when the entry link is already absent', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    const manifest = (await readGlobalManifest())!;
    const entry = manifest.entries.find((candidate) => candidate.surface === 'skill')!;
    const store = path.resolve(path.dirname(entry.path), entry.symlinkTarget!);
    await rm(entry.path);

    await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9' }, 'apply');

    expect(await exists(store)).toBe(false);
    expect(
      (await readGlobalManifest())!.entries.some((candidate) => candidate.path === entry.path)
    ).toBe(false);
  });

  it('preserves edited symlink store bytes when the entry link is absent', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    const manifest = (await readGlobalManifest())!;
    const entry = manifest.entries.find((candidate) => candidate.surface === 'skill')!;
    const store = path.resolve(path.dirname(entry.path), entry.symlinkTarget!);
    await rm(entry.path);
    await writeFile(store, 'user-edited store bytes', 'utf8');

    await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9' }, 'apply');

    expect(await readFile(store, 'utf8')).toBe('user-edited store bytes');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the manifest when ownership inspection fails during release',
    async () => {
      await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
      const manifestPath = path.join(root, 'install.local.json');
      const before = await readFile(manifestPath, 'utf8');
      const entry = (await readGlobalManifest())!.entries[0];
      await chmod(entry.path, 0o000);
      try {
        await expect(
          releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9' }, 'apply')
        ).rejects.toBeDefined();
        expect(await readFile(manifestPath, 'utf8')).toBe(before);
      } finally {
        await chmod(entry.path, 0o600);
      }
    }
  );

  it('symlink mode preserves a foreign SIBLING and still symlinks our file', async () => {
    const dir = path.join(skillsDir(), 'orcaops-capture');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'USER_FILE.md'), 'do not delete', 'utf8');

    const r = await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    // A foreign sibling no longer forces a copy fallback — we symlink just OUR file.
    expect(r.copyFallbacks.length).toBe(0);
    expect(await exists(path.join(dir, 'USER_FILE.md'))).toBe(true); // foreign content preserved
    const skill = path.join(dir, 'SKILL.md');
    expect((await lstat(skill)).isSymbolicLink()).toBe(true); // ours is a FILE symlink
    // The symlinked path is a REAL lookup (not a dir-points-at-file ENOTDIR).
    expect(await readFile(skill, 'utf8')).toContain('orcaops@9.9.9');
  });

  it('refuses a foreign real file at the exact global artifact path', async () => {
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, 'a real user file at our path', 'utf8');

    await expect(
      planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink', force: true }, 'apply')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await lstat(skill)).isSymbolicLink()).toBe(false);
    expect(await readFile(skill, 'utf8')).toBe('a real user file at our path');
    expect(await exists(path.join(root, 'install.local.json'))).toBe(false);
  });

  it('refuses a foreign symlink at the exact global artifact path', async () => {
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    const foreign = path.join(root, 'foreign.md');
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(foreign, 'foreign', 'utf8');
    await symlink(foreign, skill);

    await expect(
      planGlobalInstall({ repoId: 'repoA', ...base, link: 'copy' }, 'apply')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await lstat(skill)).isSymbolicLink()).toBe(true);
    expect(await readFile(skill, 'utf8')).toBe('foreign');
  });

  it('adopts exact generated files left before manifest publication', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    await rm(path.join(root, 'install.local.json'));

    const result = await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    expect(result.copyFallbacks).toEqual([]);
    expect(
      (await readGlobalManifest())!.entries.every((entry) => entry.refs.includes('repoA'))
    ).toBe(true);
  });

  it('adopts exact generated symlinks left before manifest publication', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    await rm(path.join(root, 'install.local.json'));

    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    expect((await lstat(skill)).isSymbolicLink()).toBe(true);
    expect(
      (await readGlobalManifest())!.entries.every((entry) => entry.refs.includes('repoA'))
    ).toBe(true);
  });

  it('refuses to overwrite user edits made through a global symlink without force', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    await writeFile(skill, 'user edit through installed symlink', 'utf8');

    await expect(
      planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(await readFile(skill, 'utf8')).toBe('user edit through installed symlink');
  });

  it('preserves the visible symlink when its store bytes were edited before final release', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    const entry = (await readGlobalManifest())!.entries.find(
      (candidate) => candidate.path === skill
    )!;
    const store = path.resolve(path.dirname(skill), entry.symlinkTarget!);
    await writeFile(skill, 'user edit through installed symlink', 'utf8');

    const result = await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9' }, 'apply');

    expect((await lstat(skill)).isSymbolicLink()).toBe(true);
    expect(await readFile(store, 'utf8')).toBe('user edit through installed symlink');
    expect(result!.removed).not.toContain(skill);
    expect(result!.warnings.join(' ')).toContain('preserved modified global symlink artifact');
  });

  it('previews preservation for an edited symlink store without claiming removal', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    const entry = (await readGlobalManifest())!.entries.find(
      (candidate) => candidate.path === skill
    )!;
    const store = path.resolve(path.dirname(skill), entry.symlinkTarget!);
    await writeFile(skill, 'user edit through installed symlink', 'utf8');

    const result = await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9' }, 'preview');

    expect(result!.removed).not.toContain(skill);
    expect(result!.warnings.join(' ')).toContain('preserved modified global symlink artifact');
    expect((await lstat(skill)).isSymbolicLink()).toBe(true);
    expect(await readFile(store, 'utf8')).toBe('user edit through installed symlink');
  });

  it('removes an owned store blob when switching the same key from symlink to copy', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    const entry = (await readGlobalManifest())!.entries.find(
      (candidate) => candidate.path === skill
    )!;
    const store = path.resolve(path.dirname(skill), entry.symlinkTarget!);

    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'copy' }, 'apply');

    expect((await lstat(skill)).isFile()).toBe(true);
    expect(await exists(store)).toBe(false);
  });

  it('refuses to hide edited store bytes when switching from symlink to copy', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    const entry = (await readGlobalManifest())!.entries.find(
      (candidate) => candidate.path === skill
    )!;
    const store = path.resolve(path.dirname(skill), entry.symlinkTarget!);
    await writeFile(skill, 'user edit through installed symlink', 'utf8');

    await expect(
      planGlobalInstall({ repoId: 'repoA', ...base, link: 'copy' }, 'apply')
    ).rejects.toThrow('is unowned or modified');

    expect((await lstat(skill)).isSymbolicLink()).toBe(true);
    expect(await readFile(store, 'utf8')).toBe('user edit through installed symlink');
    expect(
      (await readGlobalManifest())!.entries.find((candidate) => candidate.path === skill)
        ?.materialization
    ).toBe('symlink');
  });

  it('serializes concurrent repositories without losing either ref', async () => {
    await Promise.all([
      planGlobalInstall({ repoId: 'repoA', ...base }, 'apply'),
      planGlobalInstall({ repoId: 'repoB', ...base }, 'apply'),
    ]);

    expect(
      (await readGlobalManifest())!.entries.every(
        (entry) => entry.refs.includes('repoA') && entry.refs.includes('repoB')
      )
    ).toBe(true);
  });

  it('serializes a concurrent release and install without losing retained refs', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    await planGlobalInstall({ repoId: 'repoB', ...base }, 'apply');

    await Promise.all([
      releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9' }, 'apply'),
      planGlobalInstall({ repoId: 'repoC', ...base }, 'apply'),
    ]);

    expect(
      (await readGlobalManifest())!.entries.every(
        (entry) =>
          !entry.refs.includes('repoA') &&
          entry.refs.includes('repoB') &&
          entry.refs.includes('repoC')
      )
    ).toBe(true);
  });

  it('ignores a stale caller snapshot when applying under the global lock', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    const stale = await readGlobalManifest();
    await planGlobalInstall({ repoId: 'repoB', ...base }, 'apply');

    await planGlobalInstall({ repoId: 'repoC', ...base }, 'apply', stale);
    expect(
      (await readGlobalManifest())!.entries.every((entry) =>
        ['repoA', 'repoB', 'repoC'].every((repoId) => entry.refs.includes(repoId))
      )
    ).toBe(true);
  });

  it('link-symlink materializes a readable skill AND command', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    expect((await lstat(skill)).isSymbolicLink()).toBe(true);
    expect(await readFile(skill, 'utf8')).toContain('orcaops@9.9.9'); // resolves, not ENOTDIR
    // commands materialize under the hermetic global root (claude-code supportsCommands).
    const cmd = path.join(root, 'claude-code', 'commands', 'orcaops', 'status.md');
    expect((await lstat(cmd)).isSymbolicLink()).toBe(true);
    expect(await readFile(cmd, 'utf8')).toContain('orcaops:status');
  });

  it('removing a key (prefix change) never deletes a foreign sibling', async () => {
    const dir = path.join(skillsDir(), 'orcaops-capture');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'USER_FILE.md'), 'keep me', 'utf8');
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink' }, 'apply');
    // Drop the orcaops-capture key by changing prefix → its refcount hits 0.
    await planGlobalInstall({ repoId: 'repoA', ...base, link: 'symlink', prefix: 'oo' }, 'apply');
    expect(await exists(path.join(dir, 'USER_FILE.md'))).toBe(true); // sibling survives the rm
    expect(await exists(path.join(dir, 'SKILL.md'))).toBe(false); // only OUR symlink removed
  });

  it('does not delete a user-edited copy when a clean sibling key is removed', async () => {
    // repoA installs (copy); the user then edits one global file. A prefix change drops BOTH
    // keys, but removeIfOwned must preserve the edited one (hash mismatch) and not nuke it via
    // a sibling's clean removal.
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    const edited = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    await writeFile(edited, 'USER EDIT — preserve me', 'utf8');
    await planGlobalInstall({ repoId: 'repoA', ...base, prefix: 'oo' }, 'apply');
    expect(await exists(edited)).toBe(true); // edited file preserved (hash guard honored)
    expect(await readFile(edited, 'utf8')).toBe('USER EDIT — preserve me');
  });

  it('releaseGlobalRefs decrements a leaving repo + removes zero-count artifacts', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    const skill = path.join(skillsDir(), 'orcaops-capture', 'SKILL.md');
    expect(await exists(skill)).toBe(true);

    const r = await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9' }, 'apply');
    expect(r).not.toBeNull();
    expect(r!.removed.length).toBeGreaterThan(0);
    const m = await readGlobalManifest();
    expect(m!.entries.length).toBe(0); // every key this repo held was released
    expect(await exists(skill)).toBe(false); // artifact cleaned
  });

  it('releaseGlobalRefs holds nothing — the empty agent set is the contract', async () => {
    // Held keys derive per agent, so the release's empty agent set makes holds
    // structurally inert: an explicit release removes cloud skills too. Wiring
    // the release like the update path (agents + heldSkills) breaks this.
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'apply');
    const cloudDir = path.join(skillsDir(), 'orcaops-plan-approval');
    expect(await exists(path.join(cloudDir, 'SKILL.md'))).toBe(true);

    const released = await releaseGlobalRefs(
      { repoId: 'repoA', cliVersion: '9.9.9' },
      'apply',
      await readGlobalManifest()
    );
    expect(released!.held).toEqual([]);
    expect(released!.removed.length).toBeGreaterThan(0);
    expect(await exists(cloudDir)).toBe(false);
  });

  it('releaseGlobalRefs is a no-op (null) when the repo holds no global refs', async () => {
    expect(await releaseGlobalRefs({ repoId: 'nobody', cliVersion: '9.9.9' }, 'apply')).toBeNull();
  });

  it('preview mode writes nothing', async () => {
    await planGlobalInstall({ repoId: 'repoA', ...base }, 'preview');
    expect(await exists(path.join(skillsDir(), 'orcaops-capture', 'SKILL.md'))).toBe(false);
    expect(await readGlobalManifest()).toBeNull();
  });
});

describe('global manifest fail-closed validation (D7 root policy)', () => {
  let root: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-global-strict-'));
    prevEnv = process.env.ORCAOPS_GLOBAL_ROOT;
    process.env.ORCAOPS_GLOBAL_ROOT = root;
  });
  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.ORCAOPS_GLOBAL_ROOT;
    else process.env.ORCAOPS_GLOBAL_ROOT = prevEnv;
    await rm(root, { recursive: true, force: true });
  });

  const writeManifest = async (manifest: unknown): Promise<void> => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'install.local.json'), JSON.stringify(manifest), 'utf8');
  };

  const validEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    agent: 'claude-code',
    surface: 'skill',
    prefix: 'orcaops',
    path: path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md'),
    materialization: 'copy',
    symlinkTarget: null,
    expectedHash: 'H',
    refs: ['repoA'],
    ...over,
  });

  it('rejects malformed JSON, a wrong version, and unknown keys with typed errors', async () => {
    await writeFile(path.join(root, 'install.local.json'), '{ nope', 'utf8');
    await expect(readGlobalManifest()).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('malformed JSON'),
    });

    await writeManifest({ manifest_version: 99, materialized_by: '1.0.0', entries: [] });
    await expect(readGlobalManifest()).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await writeManifest({
      manifest_version: 1,
      materialized_by: '1.0.0',
      entries: [],
      extra: 1,
    });
    await expect(readGlobalManifest()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects cross-field incoherence: copy without a hash, symlink with one', async () => {
    await writeManifest({
      manifest_version: 1,
      materialized_by: '1.0.0',
      entries: [validEntry({ expectedHash: null })],
    });
    await expect(readGlobalManifest()).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await writeManifest({
      manifest_version: 1,
      materialized_by: '1.0.0',
      entries: [
        validEntry({ materialization: 'symlink', symlinkTarget: '../store/x', expectedHash: 'H' }),
      ],
    });
    await expect(readGlobalManifest()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('parks an entry outside its allowed agent/surface root as inert instead of failing the read', async () => {
    // An agent's global root moves with its env var while the manifest is
    // pinned to the global root, so one manifest legitimately holds entries
    // from several roots. A path outside the live root is indistinguishable
    // from a fabricated one, so both are parked: never planned, never owned,
    // never deleted. Containment is still enforced where it matters — this
    // entry can never reach `removeIfOwned`.
    const foreign = path.join(tmpdir(), 'stolen', 'SKILL.md');
    await writeManifest({
      manifest_version: 1,
      materialized_by: '1.0.0',
      entries: [validEntry({ path: foreign })],
    });
    const m = await readGlobalManifest();
    expect(m!.inert_entries?.map((e) => e.path)).toEqual([foreign]);
    expect(m!.entries.map((e) => e.path)).toEqual([foreign]);
  });

  it('preserves an inert entry and its refs through a write under a different root', async () => {
    const foreign = path.join(tmpdir(), 'stolen', 'SKILL.md');
    await writeManifest({
      manifest_version: 1,
      materialized_by: '9.9.9',
      entries: [validEntry({ path: foreign, refs: ['repoFOREIGN'] })],
    });
    const r = await planGlobalInstall(
      {
        repoId: 'repoLIVE',
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
    expect(carried!.refs).toEqual(['repoFOREIGN']);
    // The live root's own artifacts landed alongside it, not instead of it.
    expect(r.manifest.entries.length).toBeGreaterThan(1);
    // Nothing under the foreign root was touched.
    expect(r.removed).not.toContain(foreign);
  });

  it('defuses a store target aimed outside the canonical store by read-repair', async () => {
    // A confused-deputy target (recorded relative aiming at an outside file)
    // is REPLACED by the derived in-store target at read time — deletion can
    // only ever follow the repaired path, and the read never bricks.
    const linkPath = path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
    await writeManifest({
      manifest_version: 1,
      materialized_by: '1.0.0',
      entries: [
        validEntry({
          materialization: 'symlink',
          expectedHash: null,
          symlinkTarget: path.relative(path.dirname(linkPath), path.join(tmpdir(), 'victim.md')),
          path: linkPath,
        }),
      ],
    });
    const m = await readGlobalManifest();
    const entry = m!.entries[0];
    const resolved = path.resolve(path.dirname(linkPath), entry.symlinkTarget!);
    expect(resolved).not.toContain('victim');
    expect(resolved).toContain(`${path.sep}store${path.sep}`);
    expect(m!.repaired_targets).toBe(1);
  });

  it('rejects an entry whose ancestors escape through a real symlink (lexical bypass closed)', async () => {
    // The skill dir under the allowed root is a SYMLINK to an outside dir;
    // the entry path is lexically inside the root but resolves outside it.
    const { mkdir: mkdirP, symlink: symlinkP } = await import('node:fs/promises');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-victim-'));
    try {
      const skillsRoot = path.join(root, 'claude-code', 'skills');
      await mkdirP(skillsRoot, { recursive: true });
      await symlinkP(outside, path.join(skillsRoot, 'orcaops-capture'));
      await writeManifest({
        manifest_version: 1,
        materialized_by: '1.0.0',
        entries: [validEntry({ path: path.join(skillsRoot, 'orcaops-capture', 'SKILL.md') })],
      });
      await expect(readGlobalManifest()).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('outside its allowed'),
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('a relative ORCAOPS_GLOBAL_ROOT round-trips write-then-read (writer/reader agreement)', async () => {
    const prevCwd = process.cwd();
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-relroot-'));
    try {
      process.chdir(base);
      process.env.ORCAOPS_GLOBAL_ROOT = './global';
      await planGlobalInstall(
        {
          repoId: 'repoA',
          agents: ['claude-code'] as SupportedAgentId[],
          prefix: 'orcaops',
          generatedBy: '9.9.9',
          link: 'copy',
          cliVersion: '9.9.9',
        },
        'apply'
      );
      const m = await readGlobalManifest();
      expect(m).not.toBeNull();
      expect(m!.entries.every((e) => path.isAbsolute(e.path))).toBe(true);
    } finally {
      process.chdir(prevCwd);
      process.env.ORCAOPS_GLOBAL_ROOT = root;
      await rm(base, { recursive: true, force: true });
    }
  });

  it('reads a baseline-format manifest under a SYMLINKED agent root, repairing the stale target', async () => {
    // The shipped baseline recorded raw lexical spellings and raw-relative
    // symlink targets. Under a dotfile-symlinked agent dir the recorded
    // relative target resolves at the wrong depth from the canonical dirname;
    // the reader must repair it from the entry's own fields, never brick.
    const {
      mkdir: mkdirP,
      symlink: symlinkP,
      writeFile: writeP,
    } = await import('node:fs/promises');
    const realBase = await mkdtemp(path.join(tmpdir(), 'orcaops-dotfiles-'));
    try {
      await mkdirP(path.join(realBase, 'deep', 'claude'), { recursive: true });
      await mkdirP(root, { recursive: true });
      // root/claude-code -> realBase/deep/claude (different depth than the lexical spelling)
      await symlinkP(path.join(realBase, 'deep', 'claude'), path.join(root, 'claude-code'));
      const lexicalEntry = path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
      await mkdirP(path.dirname(lexicalEntry), { recursive: true });
      // Baseline-style raw-relative target computed from the LEXICAL dirname.
      const rawRelative = path.relative(
        path.dirname(lexicalEntry),
        path.join(root, 'store', 'claude-code', 'skill', 'orcaops-capture', 'SKILL.md')
      );
      await writeP(
        path.join(root, 'install.local.json'),
        JSON.stringify({
          manifest_version: 1,
          materialized_by: '0.0.5',
          entries: [
            {
              agent: 'claude-code',
              surface: 'skill',
              prefix: 'orcaops',
              path: lexicalEntry,
              materialization: 'symlink',
              symlinkTarget: rawRelative,
              expectedHash: null,
              refs: ['repoA'],
            },
          ],
        }),
        'utf8'
      );
      const m = await readGlobalManifest();
      expect(m).not.toBeNull();
      const entry = m!.entries[0];
      // The repaired target must resolve inside the canonical store from the
      // CANONICAL dirname (the physical location of the link).
      const canonicalDir = path.join(realBase, 'deep', 'claude', 'skills', 'orcaops-capture');
      const resolved = path.resolve(canonicalDir, entry.symlinkTarget!);
      expect(resolved.includes(`${path.sep}store${path.sep}`)).toBe(true);
    } finally {
      await rm(realBase, { recursive: true, force: true });
    }
  });

  it('rejects a dot-segment leaf that would rejoin an escape after parent validation', async () => {
    const skillsRoot = path.join(root, 'claude-code', 'skills');
    await mkdir(path.join(skillsRoot, 'x'), { recursive: true });
    await writeManifest({
      manifest_version: 1,
      materialized_by: '1.0.0',
      entries: [validEntry({ path: `${skillsRoot}/x/..` })],
    });
    await expect(readGlobalManifest()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a global manifest FILE reachable only through a symlink', async () => {
    const { symlink: symlinkP, writeFile: writeP } = await import('node:fs/promises');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-foreign-manifest-'));
    try {
      await writeP(
        path.join(outside, 'install.local.json'),
        JSON.stringify({ manifest_version: 1, materialized_by: '1.0.0', entries: [] }),
        'utf8'
      );
      await mkdir(root, { recursive: true });
      await symlinkP(
        path.join(outside, 'install.local.json'),
        path.join(root, 'install.local.json')
      );
      await expect(readGlobalManifest()).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/symlink/i),
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('merges refs when two spellings of one artifact collapse onto one canonical key', async () => {
    // root/claude-code is a symlink, so the lexical and physical spellings of
    // the same file are both valid reads; planning must union their refs.
    const {
      mkdir: mkdirP,
      symlink: symlinkP,
      writeFile: writeP,
    } = await import('node:fs/promises');
    const realBase = await mkdtemp(path.join(tmpdir(), 'orcaops-spellings-'));
    try {
      await mkdirP(path.join(realBase, 'claude', 'skills', 'orcaops-capture'), { recursive: true });
      await mkdirP(root, { recursive: true });
      await symlinkP(path.join(realBase, 'claude'), path.join(root, 'claude-code'));
      const lexical = path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
      const physical = path.join(realBase, 'claude', 'skills', 'orcaops-capture', 'SKILL.md');
      await writeP(physical, 'body', 'utf8');
      const bodyHash = sha256Hex('body');
      await writeP(
        path.join(root, 'install.local.json'),
        JSON.stringify({
          manifest_version: 1,
          materialized_by: '9.9.9',
          entries: [
            {
              agent: 'claude-code',
              surface: 'skill',
              prefix: 'orcaops',
              path: lexical,
              materialization: 'copy',
              symlinkTarget: null,
              expectedHash: bodyHash,
              refs: ['repoA'],
            },
            {
              agent: 'claude-code',
              surface: 'skill',
              prefix: 'orcaops',
              path: physical,
              materialization: 'copy',
              symlinkTarget: null,
              expectedHash: bodyHash,
              refs: ['repoB'],
            },
          ],
        }),
        'utf8'
      );
      // A preview plan for a third repo exposes the merged bookkeeping.
      const r = await planGlobalInstall(
        {
          repoId: 'repoC',
          agents: ['claude-code'] as SupportedAgentId[],
          prefix: 'orcaops',
          generatedBy: '9.9.9',
          link: 'copy',
          cliVersion: '9.9.9',
        },
        'preview'
      );
      const captureEntry = r.manifest.entries.find((e) => e.path.includes('orcaops-capture'));
      expect(captureEntry!.refs).toEqual(expect.arrayContaining(['repoA', 'repoB', 'repoC']));
    } finally {
      await rm(realBase, { recursive: true, force: true });
    }
  });

  it('never deletes a SIBLING store file aimed at by a corrupt in-store target', async () => {
    // The recorded target points at another artifact's store blob (still
    // inside the store) and the on-disk link matches it. Ownership resolves
    // against the DERIVED path only, so cleanup must preserve the sibling.
    const {
      mkdir: mkdirP,
      symlink: symlinkP,
      writeFile: writeP,
      readFile: readP,
    } = await import('node:fs/promises');
    const linkDir = path.join(root, 'claude-code', 'skills', 'orcaops-capture');
    const siblingStore = path.join(
      root,
      'store',
      'claude-code',
      'skill',
      'orcaops-digest',
      'SKILL.md'
    );
    await mkdirP(linkDir, { recursive: true });
    await mkdirP(path.dirname(siblingStore), { recursive: true });
    await writeP(siblingStore, 'sibling blob', 'utf8');
    const linkPath = path.join(linkDir, 'SKILL.md');
    const evilRelative = path.relative(linkDir, siblingStore);
    await symlinkP(evilRelative, linkPath);
    await writeManifest({
      manifest_version: 1,
      materialized_by: '9.9.9',
      entries: [
        validEntry({
          materialization: 'symlink',
          expectedHash: null,
          symlinkTarget: evilRelative,
          path: linkPath,
        }),
      ],
    });
    // Dropping the only ref triggers last-ref cleanup for the entry.
    const r = await planGlobalInstall(
      {
        repoId: 'repoA',
        agents: [],
        prefix: 'orcaops',
        generatedBy: '9.9.9',
        link: 'copy',
        cliVersion: '9.9.9',
        force: true,
      },
      'apply'
    );
    expect(r.removed).not.toContain(linkPath);
    expect(r.warnings.join(' ')).toContain('preserved re-pointed global symlink');
    // The sibling's blob survives; the non-matching link is preserved too.
    expect(await readP(siblingStore, 'utf8')).toBe('sibling blob');
  });

  it('preserves a dangling link written with an unverifiable historical formula', async () => {
    const {
      mkdir: mkdirP,
      symlink: symlinkP,
      writeFile: writeP,
      lstat: lstatP,
    } = await import('node:fs/promises');
    const realBase = await mkdtemp(path.join(tmpdir(), 'orcaops-stale-'));
    try {
      await mkdirP(path.join(realBase, 'deep', 'claude'), { recursive: true });
      await mkdirP(root, { recursive: true });
      await symlinkP(path.join(realBase, 'deep', 'claude'), path.join(root, 'claude-code'));
      const lexicalEntry = path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
      await mkdirP(path.dirname(lexicalEntry), { recursive: true });
      const lexicalStore = path.join(
        root,
        'store',
        'claude-code',
        'skill',
        'orcaops-capture',
        'SKILL.md'
      );
      await mkdirP(path.dirname(lexicalStore), { recursive: true });
      await writeP(lexicalStore, 'own blob', 'utf8');
      const historicalTarget = path.relative(path.dirname(lexicalEntry), lexicalStore);
      await symlinkP(historicalTarget, lexicalEntry);
      await writeManifest({
        manifest_version: 1,
        materialized_by: '9.9.9',
        entries: [
          validEntry({
            materialization: 'symlink',
            expectedHash: null,
            symlinkTarget: historicalTarget,
            path: lexicalEntry,
          }),
        ],
      });
      const m = await readGlobalManifest();
      await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9', force: true }, 'apply', m);
      expect((await lstatP(lexicalEntry)).isSymbolicLink()).toBe(true);
      expect((await lstatP(lexicalStore)).isFile()).toBe(true);
    } finally {
      await rm(realBase, { recursive: true, force: true });
    }
  });

  it('preserves a user dangling link whose target merely ENDS WITH a store-shaped suffix', async () => {
    // A user link aimed at an unrelated absent store-shaped path is not the
    // current derived store target and must survive cleanup.
    const { mkdir: mkdirP, symlink: symlinkP, lstat: lstatP } = await import('node:fs/promises');
    const linkDir = path.join(root, 'claude-code', 'skills', 'orcaops-capture');
    await mkdirP(linkDir, { recursive: true });
    const linkPath = path.join(linkDir, 'SKILL.md');
    // A fresh mkdtemp parent guarantees the store-shaped descendant is absent.
    const forgedBase = await mkdtemp(path.join(tmpdir(), 'orcaops-forged-'));
    try {
      const forged = path.join(
        forgedBase,
        'absent',
        'store',
        'claude-code',
        'skill',
        'orcaops-capture',
        'SKILL.md'
      );
      await symlinkP(forged, linkPath);
      await writeManifest({
        manifest_version: 1,
        materialized_by: '9.9.9',
        entries: [
          validEntry({
            materialization: 'symlink',
            expectedHash: null,
            symlinkTarget: forged,
            path: linkPath,
          }),
        ],
      });
      const m = await readGlobalManifest();
      await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9', force: true }, 'apply', m);
      const st = await lstatP(linkPath);
      expect(st.isSymbolicLink()).toBe(true);
    } finally {
      await rm(forgedBase, { recursive: true, force: true });
    }
  });

  it('rejects a global root nested under a regular FILE instead of treating it as absent', async () => {
    // ENOTDIR is a broken configuration (mkdir can never create this root),
    // not first-run absence — reading it as absent would let project
    // mutations run before the global phase fails.
    const { writeFile: writeP, rm: rmP } = await import('node:fs/promises');
    const fileAncestor = path.join(tmpdir(), `orcaops-file-ancestor-${Date.now()}`);
    const prevRoot = process.env.ORCAOPS_GLOBAL_ROOT;
    try {
      await writeP(fileAncestor, 'a regular file', 'utf8');
      process.env.ORCAOPS_GLOBAL_ROOT = path.join(fileAncestor, 'child');
      await expect(readGlobalManifest()).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('non-directory'),
      });
    } finally {
      process.env.ORCAOPS_GLOBAL_ROOT = prevRoot;
      await rmP(fileAncestor, { force: true });
    }
  });

  it('rejects a global root that IS a regular file with the typed error', async () => {
    const { writeFile: writeP, rm: rmP } = await import('node:fs/promises');
    const fileRoot = path.join(tmpdir(), `orcaops-file-root-${Date.now()}`);
    const prevRoot = process.env.ORCAOPS_GLOBAL_ROOT;
    try {
      await writeP(fileRoot, 'a regular file', 'utf8');
      process.env.ORCAOPS_GLOBAL_ROOT = fileRoot;
      await expect(readGlobalManifest()).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('not a directory'),
      });
    } finally {
      process.env.ORCAOPS_GLOBAL_ROOT = prevRoot;
      await rmP(fileRoot, { force: true });
    }
  });

  it('refuses an unowned exact path before considering derived store claims', async () => {
    const { mkdir: mkdirP, writeFile: writeP } = await import('node:fs/promises');
    const occupied = path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
    await mkdirP(path.dirname(occupied), { recursive: true });
    await writeP(occupied, 'a real user file at our path', 'utf8');
    const nestedPath = path.join(
      root,
      'claude-code',
      'skills',
      'nested',
      'orcaops-capture',
      'SKILL.md'
    );
    const store = path.join(root, 'store', 'claude-code', 'skill', 'orcaops-capture', 'SKILL.md');
    await writeManifest({
      manifest_version: 1,
      materialized_by: '9.9.9',
      entries: [
        validEntry({
          materialization: 'symlink',
          expectedHash: null,
          symlinkTarget: path.relative(path.dirname(nestedPath), store),
          path: nestedPath,
          prefix: 'oo',
          refs: ['repoB'],
        }),
      ],
    });
    await expect(
      planGlobalInstall(
        {
          repoId: 'repoA',
          agents: ['claude-code'] as SupportedAgentId[],
          prefix: 'orcaops',
          generatedBy: '9.9.9',
          link: 'symlink',
          cliVersion: '9.9.9',
        },
        'apply'
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await readFile(occupied, 'utf8')).toBe('a real user file at our path');
  });

  it('refuses a desired-vs-prior DERIVED STORE collision before any mutation', async () => {
    // A corrupt nested prior entry derives the same store blob a legitimate
    // symlink-mode desired artifact derives, while their entry paths differ.
    // The preflight must refuse on the store dimension — writing both would
    // produce a manifest the reader rejects on its next read.
    const nestedPath = path.join(
      root,
      'claude-code',
      'skills',
      'nested',
      'orcaops-capture',
      'SKILL.md'
    );
    const store = path.join(root, 'store', 'claude-code', 'skill', 'orcaops-capture', 'SKILL.md');
    await writeManifest({
      manifest_version: 1,
      materialized_by: '9.9.9',
      entries: [
        validEntry({
          materialization: 'symlink',
          expectedHash: null,
          symlinkTarget: path.relative(path.dirname(nestedPath), store),
          path: nestedPath,
          prefix: 'oo',
          refs: ['repoB'],
        }),
      ],
    });
    await expect(
      planGlobalInstall(
        {
          repoId: 'repoA',
          agents: ['claude-code'] as SupportedAgentId[],
          prefix: 'orcaops',
          generatedBy: '9.9.9',
          link: 'symlink',
          cliVersion: '9.9.9',
        },
        'apply'
      )
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('both derive the store file'),
    });
    // Zero bytes moved: neither the entry path nor the store subtree exists.
    expect(await exists(path.join(root, 'claude-code', 'skills', 'orcaops-capture'))).toBe(false);
    expect(await exists(path.join(root, 'store'))).toBe(false);
  });

  it('refuses a desired-vs-prior ownership collision on one path BEFORE any mutation', async () => {
    // A prior entry (here: an incoherent prefix recorded against the path
    // the desired set derives) already owns the materialized path under a
    // different key. The preflight must refuse before a single file lands —
    // never mid-loop with one agent's artifacts already written.
    const entryPath = path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
    await writeManifest({
      manifest_version: 1,
      materialized_by: '9.9.9',
      entries: [validEntry({ path: entryPath, prefix: 'oo', refs: ['repoB'] })],
    });
    await expect(
      planGlobalInstall(
        {
          repoId: 'repoA',
          agents: ['claude-code'] as SupportedAgentId[],
          prefix: 'orcaops',
          generatedBy: '9.9.9',
          link: 'copy',
          cliVersion: '9.9.9',
        },
        'apply'
      )
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('both materialize at'),
    });
    // Zero bytes moved: the entry path (and every sibling artifact) is absent.
    expect(await exists(entryPath)).toBe(false);
    expect(await exists(path.join(root, 'claude-code', 'skills', 'orcaops-digest'))).toBe(false);
  });

  it('rejects a DANGLING global root symlink instead of treating it as absent', async () => {
    const { symlink: symlinkP, rm: rmP } = await import('node:fs/promises');
    const danglingRoot = path.join(tmpdir(), `orcaops-dangling-${Date.now()}`);
    const prevRoot = process.env.ORCAOPS_GLOBAL_ROOT;
    try {
      await symlinkP(path.join(tmpdir(), 'never-exists-anywhere'), danglingRoot);
      process.env.ORCAOPS_GLOBAL_ROOT = danglingRoot;
      await expect(readGlobalManifest()).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('dangling symlink'),
      });
    } finally {
      process.env.ORCAOPS_GLOBAL_ROOT = prevRoot;
      await rmP(danglingRoot, { force: true });
    }
  });

  it('rejects two entries claiming one materialized path under different prefixes', async () => {
    const entryPath = path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
    await writeManifest({
      manifest_version: 1,
      materialized_by: '9.9.9',
      entries: [
        validEntry({ path: entryPath, prefix: 'orcaops', refs: ['repoA'] }),
        validEntry({ path: entryPath, prefix: 'oo', refs: ['repoB'] }),
      ],
    });
    await expect(readGlobalManifest()).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('both claim the materialized path'),
    });
  });

  it('rejects two entries deriving one STORE file under different ownership keys', async () => {
    // Distinct canonical entry paths can still collapse onto one derived
    // store blob (derivation keeps only the last two path segments). A
    // cross-key claim on the blob could release what the other still
    // references, so the reader fails closed.
    const linkA = path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
    const linkB = path.join(root, 'claude-code', 'skills', 'nested', 'orcaops-capture', 'SKILL.md');
    const store = path.join(root, 'store', 'claude-code', 'skill', 'orcaops-capture', 'SKILL.md');
    await writeManifest({
      manifest_version: 1,
      materialized_by: '9.9.9',
      entries: [
        validEntry({
          materialization: 'symlink',
          expectedHash: null,
          symlinkTarget: path.relative(path.dirname(linkA), store),
          path: linkA,
          refs: ['repoA'],
        }),
        validEntry({
          materialization: 'symlink',
          expectedHash: null,
          symlinkTarget: path.relative(path.dirname(linkB), store),
          path: linkB,
          refs: ['repoB'],
        }),
      ],
    });
    await expect(readGlobalManifest()).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('both derive the store file'),
    });
  });

  it('rejects same-key duplicate entries with conflicting materialization metadata', async () => {
    const entryPath = path.join(root, 'claude-code', 'skills', 'orcaops-capture', 'SKILL.md');
    const store = path.join(root, 'store', 'claude-code', 'skill', 'orcaops-capture', 'SKILL.md');
    await writeManifest({
      manifest_version: 1,
      materialized_by: '9.9.9',
      entries: [
        validEntry({
          path: entryPath,
          materialization: 'copy',
          expectedHash: 'H',
          refs: ['repoA'],
        }),
        validEntry({
          path: entryPath,
          materialization: 'symlink',
          expectedHash: null,
          symlinkTarget: path.relative(path.dirname(entryPath), store),
          refs: ['repoB'],
        }),
      ],
    });
    await expect(readGlobalManifest()).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('conflicting materialization metadata'),
    });
  });

  it('preserves a USER-created dangling symlink outside the current store target', async () => {
    // A corrupt manifest can name a link the user re-pointed somewhere that
    // no longer exists. Dangling alone must not authorize deletion.
    const { mkdir: mkdirP, symlink: symlinkP, lstat: lstatP } = await import('node:fs/promises');
    const linkDir = path.join(root, 'claude-code', 'skills', 'orcaops-capture');
    await mkdirP(linkDir, { recursive: true });
    const linkPath = path.join(linkDir, 'SKILL.md');
    await symlinkP('../../missing-user-note.md', linkPath);
    await writeManifest({
      manifest_version: 1,
      materialized_by: '9.9.9',
      entries: [
        validEntry({
          materialization: 'symlink',
          expectedHash: null,
          symlinkTarget: '../../missing-user-note.md',
          path: linkPath,
        }),
      ],
    });
    const m = await readGlobalManifest();
    await releaseGlobalRefs({ repoId: 'repoA', cliVersion: '9.9.9', force: true }, 'apply', m);
    // The user's dangling link survives cleanup (the entry itself is dropped).
    const st = await lstatP(linkPath);
    expect(st.isSymbolicLink()).toBe(true);
  });

  it('rejects a DANGLING ANCESTOR of the global root instead of treating it as absent', async () => {
    const { symlink: symlinkP, rm: rmP } = await import('node:fs/promises');
    const danglingParent = path.join(tmpdir(), `orcaops-dang-parent-${Date.now()}`);
    const prevRoot = process.env.ORCAOPS_GLOBAL_ROOT;
    try {
      await symlinkP(path.join(tmpdir(), 'never-exists-anywhere-2'), danglingParent);
      process.env.ORCAOPS_GLOBAL_ROOT = path.join(danglingParent, 'child');
      await expect(readGlobalManifest()).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('dangling symlink'),
      });
    } finally {
      process.env.ORCAOPS_GLOBAL_ROOT = prevRoot;
      await rmP(danglingParent, { force: true });
    }
  });

  it('round-trips a manifest planGlobalInstall itself wrote (strictness accepts our own writer)', async () => {
    await planGlobalInstall(
      {
        repoId: 'repoA',
        agents: ['claude-code'] as SupportedAgentId[],
        prefix: 'orcaops',
        generatedBy: '9.9.9',
        link: 'symlink',
        cliVersion: '9.9.9',
      },
      'apply'
    );
    const m = await readGlobalManifest();
    expect(m).not.toBeNull();
    expect(m!.entries.length).toBeGreaterThan(0);
  });
});
