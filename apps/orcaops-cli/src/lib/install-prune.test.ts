import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '@orcaops/storage';

import {
  type InstallEntry,
  type InstallManifest,
  type LocalEntry,
  type LocalManifest,
} from './install-manifest.js';
import {
  evaluateEntryDeleteGuard,
  planOrphanPrune,
  rmdirEmptyManagedDirs,
} from './install-prune.js';
import { executeMutations } from './mutations.js';

const SKILL = '.claude/skills/orcaops-legacy/SKILL.md';

const stampedBody = (v: string): string =>
  `---\nname: "x"\nmetadata:\n  generatedBy: "orcaops@${v}"\n---\nbody`;

function committed(entries: InstallEntry[]): InstallManifest {
  return {
    manifest_version: 1,
    install_agents: ['claude-code'],
    naming_prefix: 'orcaops',
    entries,
  };
}
function localM(entries: LocalEntry[]): LocalManifest {
  return { manifest_version: 1, entries };
}

describe('planOrphanPrune', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-prune-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(rel: string, content: string): Promise<string> {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return abs;
  }

  const run = (
    prevInstall: InstallManifest | null,
    nextInstall: InstallManifest,
    prevLocal: LocalManifest | null,
    genFiles: never[] = []
  ) =>
    planOrphanPrune({
      repoRoot: root,
      prefix: 'orcaops',
      prevInstall,
      nextInstall,
      prevLocal,
      genFiles,
      currentVersion: '9.9.9',
    });

  it('hash + on-disk == expectedHash → delete mutation', async () => {
    const content = 'managed body\n';
    await seed(SKILL, content);
    const r = await run(
      committed([{ kind: 'generated-file', path: SKILL }]),
      committed([]),
      localM([
        {
          kind: 'generated-file',
          path: SKILL,
          expectedHash: sha256Hex(content),
          provenance: 'created',
          deleteMode: 'hash',
        },
      ])
    );
    expect(r.deleted).toEqual([SKILL]);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0].kind).toBe('delete');
    expect(r.preserved).toEqual([]);
  });

  it('an orphan stamped AHEAD of the CLI is preserved even when its hash matches (no delete-downgrade)', async () => {
    // A newer-CLI-written install.local.json makes the hash guard pass; the
    // file is an "orphan" only because this CLI's template set is older.
    const content = stampedBody('99.0.0');
    await seed(SKILL, content);
    const r = await run(
      committed([{ kind: 'generated-file', path: SKILL }]),
      committed([]),
      localM([
        {
          kind: 'generated-file',
          path: SKILL,
          expectedHash: sha256Hex(content),
          provenance: 'created',
          deleteMode: 'hash',
        },
      ])
    );
    expect(r.deleted).toEqual([]);
    expect(r.mutations).toEqual([]);
    expect(r.preserved).toEqual([{ path: SKILL, kind: 'generated-file', reason: 'pre-existing' }]);
    expect(r.preservedAhead).toEqual([{ path: SKILL, stampedVersion: '99.0.0' }]);
  });

  it('hash + on-disk differs from expectedHash → preserved user-edited', async () => {
    await seed(SKILL, 'EDITED\n');
    const r = await run(
      committed([{ kind: 'generated-file', path: SKILL }]),
      committed([]),
      localM([
        {
          kind: 'generated-file',
          path: SKILL,
          expectedHash: sha256Hex('original\n'),
          provenance: 'created',
          deleteMode: 'hash',
        },
      ])
    );
    expect(r.deleted).toEqual([]);
    expect(r.mutations).toEqual([]);
    expect(r.preserved).toEqual([{ path: SKILL, kind: 'generated-file', reason: 'user-edited' }]);
  });

  it('preserves a managed file replaced by a symlink without reading its target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-prune-outside-'));
    const sentinel = path.join(outside, 'sentinel.md');
    const content = 'external bytes\n';
    await writeFile(sentinel, content, 'utf8');
    await mkdir(path.dirname(path.join(root, SKILL)), { recursive: true });
    await symlink(sentinel, path.join(root, SKILL));

    try {
      const r = await run(
        committed([{ kind: 'generated-file', path: SKILL }]),
        committed([]),
        localM([
          {
            kind: 'generated-file',
            path: SKILL,
            expectedHash: sha256Hex(content),
            provenance: 'created',
            deleteMode: 'hash',
          },
        ])
      );

      expect(r.deleted).toEqual([]);
      expect(r.preserved).toEqual([{ path: SKILL, kind: 'generated-file', reason: 'user-edited' }]);
      expect(await readFile(sentinel, 'utf8')).toBe(content);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects an install path that normalizes to a differently reported file', async () => {
    const victim = 'victim.md';
    const content = 'managed\n';
    await seed(victim, content);

    await expect(
      run(
        committed([{ kind: 'generated-file', path: `nested/../${victim}` }]),
        committed([]),
        localM([
          {
            kind: 'generated-file',
            path: `nested/../${victim}`,
            expectedHash: sha256Hex(content),
            provenance: 'created',
            deleteMode: 'hash',
          },
        ])
      )
    ).rejects.toThrow(/canonical relative path/);
    expect(await readFile(path.join(root, victim), 'utf8')).toBe(content);
  });

  it('deleteMode never (pre-existing) → preserved pre-existing', async () => {
    await seed(SKILL, 'x');
    const r = await run(
      committed([{ kind: 'generated-file', path: SKILL }]),
      committed([]),
      localM([
        {
          kind: 'generated-file',
          path: SKILL,
          expectedHash: null,
          provenance: 'pre-existing',
          deleteMode: 'never',
        },
      ])
    );
    expect(r.deleted).toEqual([]);
    expect(r.preserved[0].reason).toBe('pre-existing');
  });

  it('deleteMode confirm → preserved unverifiable', async () => {
    await seed(SKILL, 'x');
    const r = await run(
      committed([{ kind: 'generated-file', path: SKILL }]),
      committed([]),
      localM([
        {
          kind: 'generated-file',
          path: SKILL,
          expectedHash: null,
          provenance: 'adopted',
          deleteMode: 'confirm',
        },
      ])
    );
    expect(r.deleted).toEqual([]);
    expect(r.preserved[0].reason).toBe('unverifiable');
  });

  it('deleteMode confirm rejects a path that normalizes to another entry', async () => {
    await expect(
      evaluateEntryDeleteGuard(
        root,
        { kind: 'generated-file', path: 'nested/../victim.md' },
        {
          kind: 'generated-file',
          path: 'nested/../victim.md',
          expectedHash: null,
          provenance: 'adopted',
          deleteMode: 'confirm',
        },
        '9.9.9'
      )
    ).rejects.toThrow(/canonical relative path/);
  });

  it('a real injected-block (materialization block) is NEVER file-deleted', async () => {
    await seed('AGENTS.md', 'user prose with managed block');
    const r = await run(
      committed([{ kind: 'injected-block', path: 'AGENTS.md' }]),
      committed([]),
      localM([
        {
          kind: 'injected-block',
          path: 'AGENTS.md',
          expectedHash: 'abc',
          provenance: 'created',
          deleteMode: 'hash',
          materialization: 'block',
        },
      ])
    );
    expect(r.deleted).toEqual([]);
    expect(r.preserved[0].reason).toBe('managed-block');
  });

  it('a gitignore-entry orphan is skipped (never pruned here)', async () => {
    const r = await run(
      committed([{ kind: 'gitignore-entry', path: '.orcaops/install.local.json' }]),
      committed([]),
      localM([
        {
          kind: 'gitignore-entry',
          path: '.orcaops/install.local.json',
          expectedHash: null,
          provenance: 'created',
          deleteMode: 'never',
        },
      ])
    );
    expect(r.deleted).toEqual([]);
    expect(r.preserved).toEqual([]);
  });

  it('a symlink orphan still pointing at its recorded target → deleted as a link', async () => {
    await seed('AGENTS.md', 'canonical');
    await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));
    const r = await run(
      committed([{ kind: 'injected-block', path: 'CLAUDE.md' }]),
      committed([]),
      localM([
        {
          kind: 'injected-block',
          path: 'CLAUDE.md',
          expectedHash: null,
          provenance: 'created',
          deleteMode: 'hash',
          materialization: 'symlink',
          symlinkTarget: 'AGENTS.md',
        },
      ])
    );
    expect(r.deleted).toEqual(['CLAUDE.md']);
    expect(r.mutations[0].kind).toBe('delete');
    // the canonical target is untouched in the plan
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('canonical');
  });

  it('a NULL recorded symlink target never authorizes hash-mode deletion', async () => {
    // With no recorded target there is no ownership evidence — treating null
    // as a wildcard would let a corrupt/reconstructed entry delete an
    // arbitrary same-path symlink (the P0 delete-guard finding).
    await seed('AGENTS.md', 'canonical');
    await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));
    const r = await run(
      committed([{ kind: 'injected-block', path: 'CLAUDE.md' }]),
      committed([]),
      localM([
        {
          kind: 'injected-block',
          path: 'CLAUDE.md',
          expectedHash: null,
          provenance: 'created',
          deleteMode: 'hash',
          materialization: 'symlink',
          symlinkTarget: null,
        },
      ])
    );
    expect(r.deleted).toEqual([]);
    expect(r.preserved[0].reason).toBe('user-edited');
  });

  it('a symlink orphan re-pointed elsewhere → preserved user-edited', async () => {
    await seed('OTHER.md', 'other');
    await symlink('OTHER.md', path.join(root, 'CLAUDE.md'));
    const r = await run(
      committed([{ kind: 'injected-block', path: 'CLAUDE.md' }]),
      committed([]),
      localM([
        {
          kind: 'injected-block',
          path: 'CLAUDE.md',
          expectedHash: null,
          provenance: 'created',
          deleteMode: 'hash',
          materialization: 'symlink',
          symlinkTarget: 'AGENTS.md',
        },
      ])
    );
    expect(r.deleted).toEqual([]);
    expect(r.preserved[0].reason).toBe('user-edited');
  });

  it('reconstruct-if-absent: removed UNSTAMPED file → preserved (pre-existing)', async () => {
    await seed(SKILL, 'legacy'); // hand-written, no orcaops stamp
    const r = await run(
      committed([{ kind: 'generated-file', path: SKILL }]),
      committed([]),
      null,
      []
    );
    expect(r.deleted).toEqual([]);
    // An unstamped file at a managed path reconstructs pre-existing/never, not confirm.
    expect(r.preserved[0]).toMatchObject({ path: SKILL, reason: 'pre-existing' });
  });

  it('reconstruct-if-absent: removed historically stamped file is pre-existing', async () => {
    await seed(SKILL, stampedBody('0.0.1'));
    const r = await run(
      committed([{ kind: 'generated-file', path: SKILL }]),
      committed([]),
      null,
      []
    );
    expect(r.deleted).toEqual([]);
    expect(r.preserved[0]).toMatchObject({ path: SKILL, reason: 'pre-existing' });
  });

  it('reconstruct-if-absent: a re-pointed symlink instruction orphan is preserved, not deleted', async () => {
    // Fresh clone (no prevLocal). The user re-pointed CLAUDE.md at their own file.
    await seed('OTHER.md', 'user target\n');
    await symlink('OTHER.md', path.join(root, 'CLAUDE.md'));
    const r = await run(
      committed([{ kind: 'injected-block', path: 'CLAUDE.md' }]),
      committed([]),
      null, // no prevLocal → reconstruct confirm-gates a symlink it can't prove it owns
      []
    );
    // The link must NOT be deleted: observed target == recorded target is a
    // self-referential pass, not proof of ownership.
    expect(r.deleted).toEqual([]);
    expect(r.preserved[0]).toMatchObject({ path: 'CLAUDE.md', reason: 'unverifiable' });
  });

  it('no prevInstall → no prune', async () => {
    const r = await run(null, committed([]), null);
    expect(r).toEqual({ mutations: [], deleted: [], preserved: [], preservedAhead: [] });
  });

  it('an entry still present in the next manifest is not an orphan', async () => {
    await seed(SKILL, 'x');
    const both = committed([{ kind: 'generated-file', path: SKILL }]);
    const r = await run(
      both,
      both,
      localM([
        {
          kind: 'generated-file',
          path: SKILL,
          expectedHash: sha256Hex('x'),
          provenance: 'created',
          deleteMode: 'hash',
        },
      ])
    );
    expect(r.deleted).toEqual([]);
    expect(r.preserved).toEqual([]);
  });

  it('executing the delete + rmdirEmptyManagedDirs removes the file and its empty dir', async () => {
    const content = 'body';
    await seed(SKILL, content);
    const r = await run(
      committed([{ kind: 'generated-file', path: SKILL }]),
      committed([]),
      localM([
        {
          kind: 'generated-file',
          path: SKILL,
          expectedHash: sha256Hex(content),
          provenance: 'created',
          deleteMode: 'hash',
        },
      ])
    );
    await executeMutations(r.mutations, 'apply');
    const removedDirs = await rmdirEmptyManagedDirs(root, ['orcaops'], r.deleted);
    expect(removedDirs).toContain('.claude/skills/orcaops-legacy');
    await expect(readFile(path.join(root, SKILL), 'utf8')).rejects.toThrow();
  });

  it('rmdirEmptyManagedDirs is prefix-scoped and only removes empty dirs', async () => {
    await mkdir(path.join(root, '.claude/skills/userdir'), { recursive: true });
    await seed('.claude/skills/orcaops-keep/SKILL.md', 'x');
    const removed = await rmdirEmptyManagedDirs(
      root,
      ['orcaops'],
      [
        '.claude/skills/userdir/SKILL.md', // parent not prefix-scoped → ignored
        '.claude/skills/orcaops-keep/SKILL.md', // prefix-scoped but non-empty → ENOTEMPTY skip
      ]
    );
    expect(removed).toEqual([]);
  });

  it('rmdirEmptyManagedDirs refuses an ancestor symlink outside the worktree', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-prune-outside-'));
    const managedDir = path.join(outside, 'skills', 'orcaops-old');
    await mkdir(managedDir, { recursive: true });
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside', 'utf8');
    await symlink(outside, path.join(root, '.claude'));

    try {
      await expect(
        rmdirEmptyManagedDirs(root, ['orcaops'], ['.claude/skills/orcaops-old/SKILL.md'])
      ).rejects.toThrow(/must not contain symlinks/);
      expect(await readFile(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('outside');
      expect((await stat(managedDir)).isDirectory()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('evaluateEntryDeleteGuard (the shared delete-safety guard)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-guard-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const entry: InstallEntry = { kind: 'generated-file', path: SKILL };
  const le = (over: Partial<LocalEntry>): LocalEntry => ({
    kind: 'generated-file',
    path: SKILL,
    expectedHash: null,
    provenance: 'created',
    deleteMode: 'hash',
    ...over,
  });

  // The two dispositions uninstall depends on (prune folds both into "preserve").
  it('deleteMode confirm → confirm disposition (uninstall acts on it under --force)', async () => {
    const abs = path.join(root, SKILL);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, stampedBody('0.0.1'), 'utf8');
    const g = await evaluateEntryDeleteGuard(
      root,
      entry,
      le({ deleteMode: 'confirm', provenance: 'adopted' }),
      '9.9.9'
    );
    expect(g.kind).toBe('confirm');
  });

  it.each(['symlink', 'directory'] as const)(
    'confirm mode preserves a generated entry replaced by a %s',
    async (replacement) => {
      const abs = path.join(root, SKILL);
      await mkdir(path.dirname(abs), { recursive: true });
      if (replacement === 'symlink') {
        const target = path.join(root, 'replacement');
        await writeFile(target, 'replacement\n', 'utf8');
        await symlink(target, abs);
      } else {
        await mkdir(abs);
      }

      const g = await evaluateEntryDeleteGuard(
        root,
        entry,
        le({ deleteMode: 'confirm', provenance: 'adopted' }),
        '9.9.9'
      );
      expect(g).toEqual({ kind: 'preserve', reason: 'user-edited' });
    }
  );

  it('hash + on-disk already gone → absent disposition', async () => {
    // nothing seeded at SKILL
    const g = await evaluateEntryDeleteGuard(
      root,
      entry,
      le({ expectedHash: 'deadbeef' }),
      '9.9.9'
    );
    expect(g.kind).toBe('absent');
  });

  it('no local entry → preserve unverifiable', async () => {
    const g = await evaluateEntryDeleteGuard(root, entry, undefined, '9.9.9');
    expect(g).toEqual({ kind: 'preserve', reason: 'unverifiable' });
  });

  it('hash + on-disk == expectedHash → delete disposition', async () => {
    const abs = path.join(root, SKILL);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, 'body\n', 'utf8');
    const g = await evaluateEntryDeleteGuard(
      root,
      entry,
      le({ expectedHash: sha256Hex('body\n') }),
      '9.9.9'
    );
    expect(g.kind).toBe('delete');
    if (g.kind === 'delete') expect(g.mutation.kind).toBe('delete');
  });

  it('an adopted/never entry holding AHEAD bytes reports pre-existing, not user-edited', async () => {
    // A NEWER CLI preserves a same-version user edit as adopted/never; an
    // older CLI's report must classify the ahead state directionally.
    const abs = path.join(root, SKILL);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, stampedBody('99.0.0'), 'utf8');
    const g = await evaluateEntryDeleteGuard(
      root,
      entry,
      le({ deleteMode: 'never', provenance: 'adopted' }),
      '0.0.5'
    );
    expect(g).toEqual({ kind: 'preserve', reason: 'pre-existing' });
  });

  it('an adopted/never entry with a current stamp still reports user-edited', async () => {
    const abs = path.join(root, SKILL);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, stampedBody('9.9.9'), 'utf8');
    const g = await evaluateEntryDeleteGuard(
      root,
      entry,
      le({ deleteMode: 'never', provenance: 'adopted' }),
      '9.9.9'
    );
    expect(g).toEqual({ kind: 'preserve', reason: 'user-edited' });
  });

  it('an AHEAD-stamped file is preserved even when its recorded hash matches', async () => {
    // A NEWER CLI's own manifest records hashes its bytes match — hash-match
    // must not grant an older CLI deletion authority over ahead state.
    const body = stampedBody('99.0.0');
    const abs = path.join(root, SKILL);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
    const g = await evaluateEntryDeleteGuard(
      root,
      entry,
      le({ expectedHash: sha256Hex(body) }),
      '0.0.5'
    );
    expect(g).toEqual({ kind: 'preserve', reason: 'pre-existing' });
  });

  it('an AHEAD-stamped file never reaches confirm (forced confirmation cannot downgrade)', async () => {
    const abs = path.join(root, SKILL);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, stampedBody('99.0.0'), 'utf8');
    const g = await evaluateEntryDeleteGuard(
      root,
      entry,
      le({ deleteMode: 'confirm', provenance: 'adopted' }),
      '0.0.5'
    );
    expect(g).toEqual({ kind: 'preserve', reason: 'pre-existing' });
  });
});
