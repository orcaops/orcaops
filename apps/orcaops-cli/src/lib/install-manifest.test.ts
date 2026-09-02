import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PlannedFile } from '@orcaops/adapters';

import {
  buildManifests,
  classifyAdoption,
  diffInstallManifests,
  type InstallManifest,
  MANIFEST_VERSION,
  readInstallManifest,
  readLocalManifest,
  reconstructLocalManifest,
  writeInstallManifest,
  writeLocalManifest,
} from './install-manifest.js';

const stamped = (v: string): string =>
  `---\nname: "x"\nmetadata:\n  generatedBy: "orcaops@${v}"\n---\nbody`;

const pf = (
  p: string,
  action: PlannedFile['action'],
  hash: string,
  currentContent: string | null = null,
  desiredContent = 'D'
): PlannedFile => ({
  path: p,
  kind: 'generated-file',
  desiredContent,
  currentContent,
  action,
  hash,
});

describe('classifyAdoption', () => {
  const base = { kind: 'generated-file' as const, desiredHash: 'HASH', currentVersion: '0.0.5' };

  it('absent → created + hash', () => {
    expect(
      classifyAdoption({ ...base, currentContent: null, contentMatchesDesired: false })
    ).toEqual({ provenance: 'created', deleteMode: 'hash', expectedHash: 'HASH' });
  });

  it('current stamp + content matches → created + hash', () => {
    expect(
      classifyAdoption({ ...base, currentContent: stamped('0.0.5'), contentMatchesDesired: true })
    ).toEqual({ provenance: 'created', deleteMode: 'hash', expectedHash: 'HASH' });
  });

  it('current stamp + content differs (user edit) → adopted + never', () => {
    expect(
      classifyAdoption({ ...base, currentContent: stamped('0.0.5'), contentMatchesDesired: false })
    ).toEqual({ provenance: 'adopted', deleteMode: 'never', expectedHash: 'HASH' });
  });

  it('refuses ownership when the stamp is not current', () => {
    expect(
      classifyAdoption({ ...base, currentContent: stamped('0.0.4'), contentMatchesDesired: false })
    ).toEqual({ provenance: 'pre-existing', deleteMode: 'never', expectedHash: null });
  });

  it('unstamped → pre-existing + never + null', () => {
    expect(
      classifyAdoption({
        ...base,
        currentContent: 'a user file, no stamp',
        contentMatchesDesired: false,
      })
    ).toEqual({ provenance: 'pre-existing', deleteMode: 'never', expectedHash: null });
  });

  it('NEWER stamp → pre-existing + never (an older CLI cannot own or delete ahead state)', () => {
    expect(
      classifyAdoption({ ...base, currentContent: stamped('99.0.0'), contentMatchesDesired: false })
    ).toEqual({ provenance: 'pre-existing', deleteMode: 'never', expectedHash: null });
  });
});

describe('buildManifests', () => {
  it('committed manifest is churn-free (no hashes / CLI version); local carries the guards', () => {
    const { install, local } = buildManifests({
      repoRoot: '/repo',
      installAgents: ['claude-code'],
      files: [pf('.claude/skills/orcaops-capture/SKILL.md', 'create', 'H1')],
      instructionPlacements: [],
      gitignoreLines: ['.orcaops/install.local.json'],
      namingPrefix: 'orcaops',
    });

    expect(install.manifest_version).toBe(MANIFEST_VERSION);
    expect(install.install_agents).toEqual(['claude-code']);
    expect(install.naming_prefix).toBe('orcaops'); // recorded for prefix-rename detection
    expect(install.entries).toContainEqual({
      kind: 'generated-file',
      path: '.claude/skills/orcaops-capture/SKILL.md',
    });
    expect(install.entries).toContainEqual({
      kind: 'gitignore-entry',
      path: '.orcaops/install.local.json',
    });
    // committed manifest carries NO per-file hash
    expect(JSON.stringify(install)).not.toContain('H1');

    const skillLocal = local.entries.find((e) => e.kind === 'generated-file');
    expect(skillLocal).toMatchObject({
      expectedHash: 'H1',
      provenance: 'created',
      deleteMode: 'hash',
    });
  });

  it('a stamp-matched user edit (unchanged but content differs) → never guard', () => {
    const { local } = buildManifests({
      repoRoot: '/repo',
      installAgents: ['claude-code'],
      files: [pf('s/SKILL.md', 'unchanged', 'H2', stamped('0.0.5'), 'DIFFERENT')],
      instructionPlacements: [],
      gitignoreLines: [],
      namingPrefix: 'orcaops',
    });
    expect(local.entries[0]).toMatchObject({ provenance: 'adopted', deleteMode: 'never' });
  });

  it('a preserved-ahead file is never deletable by this CLI (pre-existing + never)', () => {
    const { local } = buildManifests({
      repoRoot: '/repo',
      installAgents: ['claude-code'],
      files: [
        {
          ...pf('s/SKILL.md', 'unchanged', 'H3', stamped('99.0.0'), 'DIFFERENT'),
          reason: 'preserved-ahead',
          onDiskVersion: '99.0.0',
        },
      ],
      instructionPlacements: [],
      gitignoreLines: [],
      namingPrefix: 'orcaops',
    });
    expect(local.entries[0]).toMatchObject({
      provenance: 'pre-existing',
      deleteMode: 'never',
      expectedHash: null,
    });
  });

  it('a preserved-ahead block placement is never recorded as CLI-created state', () => {
    const { local } = buildManifests({
      repoRoot: '/repo',
      installAgents: ['claude-code'],
      files: [],
      instructionPlacements: [
        {
          path: 'AGENTS.md',
          materialization: 'block' as const,
          blockHash: 'BH',
          reason: 'preserved-ahead' as const,
        },
      ],
      gitignoreLines: [],
      namingPrefix: 'orcaops',
    });
    expect(local.entries[0]).toMatchObject({
      kind: 'injected-block',
      provenance: 'pre-existing',
      deleteMode: 'never',
      expectedHash: null,
    });
  });

  it('instruction placements: committed install.json is identical for symlink vs dual-write', () => {
    const block = (path: string) => ({ path, materialization: 'block' as const, blockHash: 'BH' });
    const dual = buildManifests({
      repoRoot: '/repo',
      installAgents: ['claude-code'],
      files: [],
      instructionPlacements: [block('AGENTS.md'), block('CLAUDE.md')],
      gitignoreLines: [],
      namingPrefix: 'orcaops',
    });
    const linked = buildManifests({
      repoRoot: '/repo',
      installAgents: ['claude-code'],
      files: [],
      instructionPlacements: [
        block('AGENTS.md'),
        { path: 'CLAUDE.md', materialization: 'symlink', symlinkTarget: 'AGENTS.md' },
      ],
      gitignoreLines: [],
      namingPrefix: 'orcaops',
    });
    // Both physical layouts record the SAME committed ownership (machine-stable).
    expect(dual.install.entries).toEqual(linked.install.entries);
    expect(dual.install.entries).toEqual([
      { kind: 'injected-block', path: 'AGENTS.md' },
      { kind: 'injected-block', path: 'CLAUDE.md' },
    ]);
    // The local manifest is where they differ.
    expect(dual.local.entries[1]).toMatchObject({ materialization: 'block', expectedHash: 'BH' });
    expect(linked.local.entries[1]).toMatchObject({
      materialization: 'symlink',
      symlinkTarget: 'AGENTS.md',
      expectedHash: null,
      deleteMode: 'hash',
    });
  });

  it('committed instruction-entry order is deterministic regardless of placement input order', () => {
    const block = (path: string) => ({ path, materialization: 'block' as const, blockHash: 'BH' });
    const args = (placements: Parameters<typeof buildManifests>[0]['instructionPlacements']) => ({
      repoRoot: '/repo',
      installAgents: ['claude-code'],
      files: [],
      instructionPlacements: placements,
      gitignoreLines: [],
      namingPrefix: 'orcaops',
    });
    // A fresh repo yields canonical-first [AGENTS.md, CLAUDE.md]; a CLAUDE.md-preexisting
    // repo yields [CLAUDE.md, AGENTS.md]. Both must commit the SAME entry order.
    const forward = buildManifests(args([block('AGENTS.md'), block('CLAUDE.md')]));
    const reversed = buildManifests(args([block('CLAUDE.md'), block('AGENTS.md')]));
    expect(reversed.install.entries).toEqual(forward.install.entries);
    expect(reversed.install.entries).toEqual([
      { kind: 'injected-block', path: 'AGENTS.md' },
      { kind: 'injected-block', path: 'CLAUDE.md' },
    ]);
  });

  it('records managed paths with portable separators', () => {
    const { install, local } = buildManifests({
      repoRoot: 'C:\\repo',
      installAgents: ['claude-code'],
      files: [pf('.claude\\skills\\orcaops-capture\\SKILL.md', 'create', 'H1')],
      instructionPlacements: [
        {
          path: 'docs\\AGENTS.md',
          materialization: 'block',
          blockHash: 'BH',
        },
      ],
      gitignoreLines: ['literal\\pattern'],
      namingPrefix: 'orcaops',
    });

    expect(install.entries).toEqual([
      { kind: 'generated-file', path: '.claude/skills/orcaops-capture/SKILL.md' },
      { kind: 'injected-block', path: 'docs/AGENTS.md' },
      { kind: 'gitignore-entry', path: 'literal\\pattern' },
    ]);
    expect(local.entries.map((entry) => entry.path)).toEqual([
      '.claude/skills/orcaops-capture/SKILL.md',
      'docs/AGENTS.md',
      'literal\\pattern',
    ]);
  });
});

describe('diffInstallManifests', () => {
  it('reports removed + added entries by kind+path', () => {
    const mk = (paths: string[]): InstallManifest => ({
      manifest_version: 1,
      install_agents: [],
      naming_prefix: 'orcaops',
      entries: paths.map((p) => ({ kind: 'generated-file' as const, path: p })),
    });
    const d = diffInstallManifests(mk(['x', 'y']), mk(['y', 'z']));
    expect(d.removed).toEqual([{ kind: 'generated-file', path: 'x' }]);
    expect(d.added).toEqual([{ kind: 'generated-file', path: 'z' }]);
  });

  it('treats legacy backslash paths as the same managed entry', () => {
    const mk = (entryPath: string): InstallManifest => ({
      manifest_version: 1,
      install_agents: [],
      naming_prefix: 'orcaops',
      entries: [{ kind: 'generated-file', path: entryPath }],
    });

    expect(diffInstallManifests(mk('skills\\capture.md'), mk('skills/capture.md'))).toEqual({
      removed: [],
      added: [],
    });
  });
});

describe('manifest read/write + reconstruction', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-manifest-'));
    await mkdir(path.join(root, '.orcaops'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('local manifest round-trips its info_exclude bookkeeping through write → read', async () => {
    // The reader is a strict object, so a field the personal-scope installer
    // writes must be declared there or every install.local.json it produces
    // is rejected as invalid — a break typecheck cannot see.
    const { local } = buildManifests({
      repoRoot: root,
      installAgents: ['claude-code'],
      files: [pf('a/SKILL.md', 'create', 'H1')],
      instructionPlacements: [],
      gitignoreLines: [],
      namingPrefix: 'orcaops',
      infoExcludeLines: ['.orcaops/', '!.orcaops/config.json'],
    });
    expect(local.info_exclude).toEqual(['.orcaops/', '!.orcaops/config.json']);
    await writeLocalManifest(root, local);
    expect(await readLocalManifest(root)).toEqual(local);
  });

  it('install manifest round-trips through write → read', async () => {
    const { install } = buildManifests({
      repoRoot: root,
      installAgents: ['claude-code'],
      files: [pf('a/SKILL.md', 'create', 'H1')],
      instructionPlacements: [],
      gitignoreLines: ['.orcaops/install.local.json'],
      namingPrefix: 'orcaops',
    });
    await writeInstallManifest(root, install);
    expect(await readInstallManifest(root)).toEqual(install);
  });

  it('rejects a non-canonical backslash managed path with regenerate guidance', async () => {
    // Writers still emit portable slashes; the READER is strict — a backslash
    // managed path must be regenerated because ownership metadata is consumed
    // by mutation guards and must be unambiguous on every platform.
    await writeFile(
      path.join(root, '.orcaops', 'install.json'),
      JSON.stringify({
        manifest_version: 1,
        install_agents: [],
        naming_prefix: 'orcaops',
        entries: [{ kind: 'generated-file', path: '.claude\\skills\\capture\\SKILL.md' }],
      }),
      'utf8'
    );

    await expect(readInstallManifest(root)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('canonical slash-relative'),
    });
  });

  it('accepts a gitignore-entry whose literal pattern contains a backslash', async () => {
    await writeFile(
      path.join(root, '.orcaops', 'install.json'),
      JSON.stringify({
        manifest_version: 1,
        install_agents: [],
        naming_prefix: 'orcaops',
        entries: [{ kind: 'gitignore-entry', path: 'literal\\pattern' }],
      }),
      'utf8'
    );

    expect(await readInstallManifest(root)).toMatchObject({
      entries: [{ kind: 'gitignore-entry', path: 'literal\\pattern' }],
    });
  });

  it('rejects malformed JSON, a wrong manifest_version, and unknown keys with typed errors', async () => {
    const manifestPath = path.join(root, '.orcaops', 'install.json');

    await writeFile(manifestPath, '{ not json', 'utf8');
    await expect(readInstallManifest(root)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('malformed JSON'),
    });

    await writeFile(
      manifestPath,
      JSON.stringify({
        manifest_version: 2,
        install_agents: [],
        naming_prefix: 'orcaops',
        entries: [],
      }),
      'utf8'
    );
    await expect(readInstallManifest(root)).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await writeFile(
      manifestPath,
      JSON.stringify({
        manifest_version: 1,
        install_agents: [],
        naming_prefix: 'orcaops',
        entries: [],
        extra: true,
      }),
      'utf8'
    );
    await expect(readInstallManifest(root)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a current install manifest that omits naming_prefix', async () => {
    await writeFile(
      path.join(root, '.orcaops', 'install.json'),
      JSON.stringify({ manifest_version: 1, install_agents: [], entries: [] }),
      'utf8'
    );

    await expect(readInstallManifest(root)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('naming_prefix'),
    });
  });

  it('rejects a hash-deletable null-target symlink record in the local manifest', async () => {
    await writeFile(
      path.join(root, '.orcaops', 'install.local.json'),
      JSON.stringify({
        manifest_version: 1,
        entries: [
          {
            kind: 'injected-block',
            path: 'CLAUDE.md',
            expectedHash: null,
            provenance: 'created',
            deleteMode: 'hash',
            materialization: 'symlink',
            symlinkTarget: null,
          },
        ],
      }),
      'utf8'
    );

    await expect(readLocalManifest(root)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('symlinkTarget'),
    });
  });

  it('rejects an absolute managed path in the local manifest', async () => {
    await writeFile(
      path.join(root, '.orcaops', 'install.local.json'),
      JSON.stringify({
        manifest_version: 1,
        entries: [
          {
            kind: 'generated-file',
            path: '/etc/victim.md',
            expectedHash: 'H',
            provenance: 'created',
            deleteMode: 'hash',
          },
        ],
      }),
      'utf8'
    );
    await expect(readLocalManifest(root)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a traversal managed path before any reader consumer sees it', async () => {
    await writeFile(
      path.join(root, '.orcaops', 'install.local.json'),
      JSON.stringify({
        manifest_version: 1,
        entries: [
          {
            kind: 'generated-file',
            path: '../outside.md',
            expectedHash: 'H',
            provenance: 'created',
            deleteMode: 'hash',
          },
        ],
      }),
      'utf8'
    );

    await expect(readLocalManifest(root)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses an ancestor symlink for manifest reads and writes', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-manifest-outside-'));
    const external = path.join(outside, 'install.json');
    await writeFile(external, '{"external":true}\n', 'utf8');
    await rm(path.join(root, '.orcaops'), { recursive: true, force: true });
    await symlink(outside, path.join(root, '.orcaops'));
    const install: InstallManifest = {
      manifest_version: 1,
      install_agents: [],
      naming_prefix: 'orcaops',
      entries: [],
    };

    try {
      // The READ surfaces the containment refusal through the typed manifest
      // envelope (INVALID_INPUT), never a raw internal path error.
      await expect(readInstallManifest(root)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/must not contain symlinks/),
      });
      await expect(writeInstallManifest(root, install)).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readFile(external, 'utf8')).toBe('{"external":true}\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a final manifest symlink for reads and writes', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-manifest-outside-'));
    const external = path.join(outside, 'install.json');
    await writeFile(external, '{"external":true}\n', 'utf8');
    await symlink(external, path.join(root, '.orcaops', 'install.json'));
    const install: InstallManifest = {
      manifest_version: 1,
      install_agents: [],
      naming_prefix: 'orcaops',
      entries: [],
    };

    try {
      // The READ surfaces the containment refusal through the typed manifest
      // envelope (INVALID_INPUT), never a raw internal path error.
      await expect(readInstallManifest(root)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/must not contain symlinks/),
      });
      await expect(writeInstallManifest(root, install)).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readFile(external, 'utf8')).toBe('{"external":true}\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses reconstruction reads through a manifest-selected ancestor symlink', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-manifest-outside-'));
    const external = path.join(outside, 'SKILL.md');
    await writeFile(external, stamped('0.0.5'), 'utf8');
    await symlink(outside, path.join(root, 'redirect'));
    const install: InstallManifest = {
      manifest_version: 1,
      install_agents: [],
      naming_prefix: 'orcaops',
      entries: [{ kind: 'generated-file', path: 'redirect/SKILL.md' }],
    };

    try {
      await expect(reconstructLocalManifest(root, install, [], '0.0.5')).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readFile(external, 'utf8')).toBe(stamped('0.0.5'));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reconstructs a final generated-file symlink as a protected user replacement', async () => {
    const skillRel = '.claude/skills/orcaops-capture/SKILL.md';
    const skillPath = path.join(root, skillRel);
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-manifest-outside-'));
    const external = path.join(outside, 'SKILL.md');
    const externalBody = stamped('0.0.5');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(external, externalBody, 'utf8');
    await symlink(external, skillPath);
    const install: InstallManifest = {
      manifest_version: 1,
      install_agents: ['claude-code'],
      naming_prefix: 'orcaops',
      entries: [{ kind: 'generated-file', path: skillRel }],
    };
    const currentFiles = [pf(skillRel, 'unchanged', 'HASH-OK', null, externalBody)];

    try {
      const local = await reconstructLocalManifest(root, install, currentFiles, '0.0.5');
      expect(local.entries).toContainEqual({
        kind: 'generated-file',
        path: skillRel,
        expectedHash: null,
        provenance: 'pre-existing',
        deleteMode: 'never',
      });
      expect(await readFile(external, 'utf8')).toBe(externalBody);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reconstructs local guards from committed manifest + on-disk + current gen', async () => {
    const skillRel = '.claude/skills/orcaops-capture/SKILL.md';
    const desired = stamped('0.0.5');
    // on-disk matches the current desired output exactly
    await mkdir(path.join(root, path.dirname(skillRel)), { recursive: true });
    await writeFile(path.join(root, skillRel), desired, 'utf8');

    const install: InstallManifest = {
      manifest_version: 1,
      install_agents: ['claude-code'],
      naming_prefix: 'orcaops',
      entries: [
        { kind: 'generated-file', path: skillRel },
        { kind: 'generated-file', path: '.claude/skills/removed/SKILL.md' }, // template gone
      ],
    };
    const currentFiles = [pf(skillRel, 'unchanged', 'HASH-OK', desired, desired)];

    const local = await reconstructLocalManifest(root, install, currentFiles, '0.0.5');
    const live = local.entries.find((e) => e.path === skillRel);
    const gone = local.entries.find((e) => e.path === '.claude/skills/removed/SKILL.md');
    expect(live).toMatchObject({
      deleteMode: 'hash',
      provenance: 'created',
      expectedHash: 'HASH-OK',
    });
    // removed template, absent on disk → unstamped → pre-existing/never (nothing to delete)
    expect(gone).toMatchObject({
      deleteMode: 'never',
      provenance: 'pre-existing',
      expectedHash: null,
    });
  });

  it('reconstructs a legacy backslash entry against its portable on-disk path', async () => {
    const portablePath = '.claude/skills/orcaops-capture/SKILL.md';
    const legacyPath = '.claude\\skills\\orcaops-capture\\SKILL.md';
    const desired = stamped('0.0.5');
    await mkdir(path.dirname(path.join(root, portablePath)), { recursive: true });
    await writeFile(path.join(root, portablePath), desired, 'utf8');

    const local = await reconstructLocalManifest(
      root,
      {
        manifest_version: 1,
        install_agents: ['claude-code'],
        naming_prefix: 'orcaops',
        entries: [{ kind: 'generated-file', path: legacyPath }],
      },
      [pf(legacyPath, 'unchanged', 'HASH-OK', desired, desired)],
      '0.0.5'
    );

    expect(local.entries).toEqual([
      {
        kind: 'generated-file',
        path: portablePath,
        expectedHash: 'HASH-OK',
        provenance: 'created',
        deleteMode: 'hash',
      },
    ]);
  });

  it('refuses ownership of removed-template entries regardless of historical stamps', async () => {
    const stampedRel = '.claude/skills/orcaops-old/SKILL.md';
    const userRel = '.claude/skills/orcaops-user/SKILL.md';
    await mkdir(path.join(root, path.dirname(stampedRel)), { recursive: true });
    await writeFile(path.join(root, stampedRel), stamped('0.0.1'), 'utf8'); // old orcaops stamp
    await mkdir(path.join(root, path.dirname(userRel)), { recursive: true });
    await writeFile(path.join(root, userRel), 'hand-written, no stamp\n', 'utf8');

    const install: InstallManifest = {
      manifest_version: 1,
      install_agents: ['claude-code'],
      naming_prefix: 'orcaops',
      // Both templates are gone (absent from currentFiles) → removed-template branch.
      entries: [
        { kind: 'generated-file', path: stampedRel },
        { kind: 'generated-file', path: userRel },
      ],
    };
    const local = await reconstructLocalManifest(root, install, [], '0.0.5');
    const stampedE = local.entries.find((e) => e.path === stampedRel);
    const userE = local.entries.find((e) => e.path === userRel);
    expect(stampedE).toMatchObject({
      provenance: 'pre-existing',
      deleteMode: 'never',
      expectedHash: null,
    });
    expect(userE).toMatchObject({
      provenance: 'pre-existing',
      deleteMode: 'never',
      expectedHash: null,
    });
  });

  it('reconstructs a symlinked instruction file as materialization=symlink', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'canonical\n', 'utf8');
    await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));
    const install: InstallManifest = {
      manifest_version: 1,
      install_agents: ['claude-code'],
      naming_prefix: 'orcaops',
      entries: [
        { kind: 'injected-block', path: 'AGENTS.md' },
        { kind: 'injected-block', path: 'CLAUDE.md' },
      ],
    };

    const local = await reconstructLocalManifest(root, install, [], '0.0.5');
    const agents = local.entries.find((e) => e.path === 'AGENTS.md');
    const claude = local.entries.find((e) => e.path === 'CLAUDE.md');
    // A real block region is unverifiable on reconstruction → confirm-gated.
    expect(agents).toMatchObject({ deleteMode: 'confirm', expectedHash: null });
    // The symlink target is recorded, but reconstruction can't prove orcaops owns
    // it (the observed target is self-referential), so it is confirm-gated too.
    expect(claude).toMatchObject({
      materialization: 'symlink',
      symlinkTarget: 'AGENTS.md',
      deleteMode: 'confirm',
      provenance: 'adopted',
    });
  });
});
