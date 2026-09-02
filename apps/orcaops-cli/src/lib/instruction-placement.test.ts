import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  planRemoveInstructionBlocks,
  resolveInstructionPlacement,
  type ResolveInstructionPlacementInput,
} from './instruction-placement.js';
import { executeMutations } from './mutations.js';

const MARKER = '<!-- orcaops:start v=';
const BOTH = ['AGENTS.md', 'CLAUDE.md'];

describe('resolveInstructionPlacement', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-place-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const resolve = (opts: Partial<ResolveInstructionPlacementInput> = {}) =>
    resolveInstructionPlacement({
      repoRoot: root,
      instructionFiles: BOTH,
      generatedBy: '9.9.9',
      ...opts,
    });

  const read = (rel: string) => readFile(path.join(root, rel), 'utf8');
  const isLink = async (rel: string) => (await lstat(path.join(root, rel))).isSymbolicLink();

  it('0 real files → AGENTS.md is canonical, CLAUDE.md symlinks to it', async () => {
    const res = await resolve();
    expect(res.canonical).toBe('AGENTS.md');
    expect(res.results).toEqual([
      { path: 'AGENTS.md', action: 'created' },
      { path: 'CLAUDE.md', action: 'symlinked' },
    ]);
    expect(res.placements).toEqual([
      { path: 'AGENTS.md', materialization: 'block', blockHash: expect.any(String) },
      { path: 'CLAUDE.md', materialization: 'symlink', symlinkTarget: 'AGENTS.md' },
    ]);

    await executeMutations(res.mutations, 'apply');
    expect(await isLink('CLAUDE.md')).toBe(true);
    expect(await readlink(path.join(root, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(await read('AGENTS.md')).toContain(MARKER);
    expect(await read('CLAUDE.md')).toBe(await read('AGENTS.md'));
  });

  it('exactly 1 real file → that file is canonical (the other symlinks to it)', async () => {
    await writeFile(path.join(root, 'CLAUDE.md'), 'user prose\n', 'utf8');
    const res = await resolve();
    expect(res.canonical).toBe('CLAUDE.md');

    await executeMutations(res.mutations, 'apply');
    expect(await isLink('AGENTS.md')).toBe(true);
    expect(await readlink(path.join(root, 'AGENTS.md'))).toBe('CLAUDE.md');
    const claude = await read('CLAUDE.md');
    expect(claude).toContain('user prose');
    expect(claude).toContain(MARKER);
  });

  it('2 real byte-identical files → collapse, delete BEFORE symlink, no data loss', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'shared\n', 'utf8');
    await writeFile(path.join(root, 'CLAUDE.md'), 'shared\n', 'utf8');
    const res = await resolve();
    expect(res.canonical).toBe('AGENTS.md');

    const delIdx = res.mutations.findIndex((m) => m.kind === 'delete' && m.path === 'CLAUDE.md');
    const linkIdx = res.mutations.findIndex((m) => m.kind === 'symlink' && m.path === 'CLAUDE.md');
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(linkIdx).toBeGreaterThan(delIdx); // delete precedes symlink

    await executeMutations(res.mutations, 'apply');
    expect(await isLink('CLAUDE.md')).toBe(true);
    const agents = await read('AGENTS.md');
    expect(agents).toContain('shared');
    expect(agents).toContain(MARKER);
    expect(await read('CLAUDE.md')).toBe(agents); // shared content reproduced via the symlink
  });

  it('2 real DIVERGENT files (safe) → dual-maintain, no symlink, no delete, one warning', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'alpha\n', 'utf8');
    await writeFile(path.join(root, 'CLAUDE.md'), 'beta\n', 'utf8');
    const res = await resolve();

    expect(res.mutations.some((m) => m.kind === 'symlink')).toBe(false);
    expect(res.mutations.some((m) => m.kind === 'delete')).toBe(false);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('orcaops link');
    expect(res.placements.every((p) => p.materialization === 'block')).toBe(true);

    await executeMutations(res.mutations, 'apply');
    expect(await isLink('AGENTS.md')).toBe(false);
    expect(await isLink('CLAUDE.md')).toBe(false);
    const agents = await read('AGENTS.md');
    const claude = await read('CLAUDE.md');
    expect(agents).toContain('alpha'); // each keeps its distinct out-of-block content
    expect(claude).toContain('beta');
    expect(agents).toContain(MARKER);
    expect(claude).toContain(MARKER);
  });

  it('safe mode refuses a foreign instruction symlink without changing either file', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'user agents prose\n', 'utf8');
    await writeFile(path.join(root, 'notes.md'), 'foreign target\n', 'utf8');
    await symlink('notes.md', path.join(root, 'CLAUDE.md'));

    await expect(resolve()).rejects.toThrow(/Refusing to replace foreign instruction symlink/);

    expect(await read('AGENTS.md')).toBe('user agents prose\n');
    expect(await readlink(path.join(root, 'CLAUDE.md'))).toBe('notes.md');
    expect(await read('notes.md')).toBe('foreign target\n');
  });

  it('force-collapse explicitly re-points a foreign instruction symlink', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'user agents prose\n', 'utf8');
    await writeFile(path.join(root, 'notes.md'), 'foreign target\n', 'utf8');
    await symlink('notes.md', path.join(root, 'CLAUDE.md'));

    const res = await resolve({ mode: 'force-collapse' });
    await executeMutations(res.mutations, 'apply');

    expect(await readlink(path.join(root, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(await read('AGENTS.md')).toContain(MARKER);
    expect(await read('notes.md')).toBe('foreign target\n');
  });

  it('safe mode refuses an unterminated managed block without creating its secondary', async () => {
    const malformed =
      '# User prose\n\n<!-- orcaops:start v=0.0.5 -->\nmanaged-looking text\nuser tail\n';
    await writeFile(path.join(root, 'AGENTS.md'), malformed, 'utf8');

    await expect(resolve()).rejects.toThrow(/managed-block markers are malformed or ambiguous/);

    expect(await read('AGENTS.md')).toBe(malformed);
    await expect(lstat(path.join(root, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('force explicitly repairs an unterminated managed block', async () => {
    await writeFile(
      path.join(root, 'AGENTS.md'),
      '# User prose\n\n<!-- orcaops:start v=0.0.5 -->\nmalformed tail\n',
      'utf8'
    );

    const res = await resolve({ force: true });
    await executeMutations(res.mutations, 'apply');

    const agents = await read('AGENTS.md');
    expect(agents).toContain('# User prose');
    expect(agents).toContain(MARKER);
    expect(agents).not.toContain('malformed tail');
  });

  it('is idempotent: a re-run on an already-correct layout changes nothing', async () => {
    await executeMutations((await resolve()).mutations, 'apply');

    const second = await resolve();
    expect(second.mutations.every((m) => !m.changed)).toBe(true);
    expect(second.results).toEqual([
      { path: 'AGENTS.md', action: 'unchanged' },
      { path: 'CLAUDE.md', action: 'unchanged' },
    ]);
    const applied = await executeMutations(second.mutations, 'apply');
    expect(applied.changed).toHaveLength(0);
  });

  it('force-collapse consolidates divergent files onto the canonical (lossy, confirmed)', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'alpha\n', 'utf8');
    await writeFile(path.join(root, 'CLAUDE.md'), 'beta unique\n', 'utf8');
    const res = await resolve({ mode: 'force-collapse' });
    expect(res.warnings).toHaveLength(0);

    const del = res.mutations.find((m) => m.kind === 'delete' && m.path === 'CLAUDE.md');
    expect(del?.currentContent).toContain('beta unique');

    await executeMutations(res.mutations, 'apply');
    expect(await isLink('CLAUDE.md')).toBe(true);
    expect(await read('CLAUDE.md')).toBe(await read('AGENTS.md')); // beta dropped
  });

  it('never collapses an identical ahead-stamped secondary into a symlink', async () => {
    await executeMutations((await resolve({ instructionFiles: ['AGENTS.md'] })).mutations, 'apply');
    const block = await read('AGENTS.md');
    await writeFile(path.join(root, 'CLAUDE.md'), block, 'utf8');

    const older = await resolve({ generatedBy: '0.0.5' });
    const secondary = older.results.find((r) => r.path === 'CLAUDE.md');
    expect(secondary).toMatchObject({
      action: 'unchanged',
      reason: 'preserved-ahead',
      stampedVersion: '9.9.9',
    });
    expect(older.mutations.some((m) => m.kind === 'delete' || m.kind === 'symlink')).toBe(false);
    expect(older.warnings.some((w) => w.includes('newer than'))).toBe(true);

    await executeMutations(older.mutations, 'apply');
    expect(await isLink('CLAUDE.md')).toBe(false);
    expect(await read('CLAUDE.md')).toBe(block);
  });

  it('force-collapse preserves a divergent ahead-stamped secondary without the override', async () => {
    await executeMutations((await resolve({ instructionFiles: ['AGENTS.md'] })).mutations, 'apply');
    const block = await read('AGENTS.md');
    await writeFile(path.join(root, 'CLAUDE.md'), `${block}\nunique trailing prose\n`, 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), 'plain user file\n', 'utf8');

    const res = await resolve({ generatedBy: '0.0.5', mode: 'force-collapse' });
    expect(res.canonical).toBe('AGENTS.md');
    expect(res.mutations.some((m) => m.kind === 'delete' && m.path === 'CLAUDE.md')).toBe(false);
    expect(res.results.find((r) => r.path === 'CLAUDE.md')).toMatchObject({
      action: 'unchanged',
      reason: 'preserved-ahead',
      stampedVersion: '9.9.9',
    });
    expect(res.warnings.some((w) => w.includes('newer than'))).toBe(true);

    await executeMutations(res.mutations, 'apply');
    expect(await isLink('CLAUDE.md')).toBe(false);
    expect(await read('CLAUDE.md')).toContain('unique trailing prose');
  });

  it('honors an explicit canonical override', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'alpha\n', 'utf8');
    await writeFile(path.join(root, 'CLAUDE.md'), 'beta\n', 'utf8');
    const res = await resolve({ mode: 'force-collapse', canonical: 'CLAUDE.md' });
    expect(res.canonical).toBe('CLAUDE.md');

    await executeMutations(res.mutations, 'apply');
    expect(await isLink('AGENTS.md')).toBe(true);
    expect(await readlink(path.join(root, 'AGENTS.md'))).toBe('CLAUDE.md');
    expect(await read('CLAUDE.md')).toContain('beta');
  });

  it('single-instruction-file agents (e.g. codex) inject one block, no symlink', async () => {
    const res = await resolve({ instructionFiles: ['AGENTS.md'] });
    expect(res.canonical).toBe('AGENTS.md');
    expect(res.mutations.some((m) => m.kind === 'symlink')).toBe(false);
    expect(res.results).toEqual([{ path: 'AGENTS.md', action: 'created' }]);
  });

  it('preserves a non-regular entry and uses an available instruction file', async () => {
    await mkdir(path.join(root, 'AGENTS.md'));

    const res = await resolve({ canonical: 'AGENTS.md' });

    expect(res.canonical).toBe('CLAUDE.md');
    expect(res.results).toEqual([
      { path: 'CLAUDE.md', action: 'created' },
      { path: 'AGENTS.md', action: 'unchanged' },
    ]);
    expect(res.placements).toEqual([
      { path: 'CLAUDE.md', materialization: 'block', blockHash: expect.any(String) },
    ]);
    expect(res.warnings).toEqual([
      'AGENTS.md is not a regular file; preserving it unchanged.',
      'AGENTS.md cannot hold a managed instruction block; using CLAUDE.md instead.',
    ]);

    await executeMutations(res.mutations, 'apply');
    expect((await lstat(path.join(root, 'AGENTS.md'))).isDirectory()).toBe(true);
    expect(await read('CLAUDE.md')).toContain(MARKER);
  });

  it('leaves all entries untouched when none can hold a managed block', async () => {
    await mkdir(path.join(root, 'AGENTS.md'));

    const res = await resolve({ instructionFiles: ['AGENTS.md'] });

    expect(res).toMatchObject({
      canonical: '',
      mutations: [],
      placements: [],
      results: [{ path: 'AGENTS.md', action: 'unchanged' }],
      warnings: ['AGENTS.md is not a regular file; preserving it unchanged.'],
    });
    expect((await lstat(path.join(root, 'AGENTS.md'))).isDirectory()).toBe(true);
  });

  it('bootstrap=manual advice for a malformed AHEAD block is upgrade, not hand-removal', async () => {
    await writeFile(
      path.join(root, 'AGENTS.md'),
      '# mine\n<!-- orcaops:start v=99.0.0 -->\nnewer body, no end marker\n',
      'utf8'
    );
    const res = await planRemoveInstructionBlocks({
      repoRoot: root,
      instructionFiles: ['AGENTS.md'],
      generatedBy: '0.0.5',
    });
    expect(res.mutations).toEqual([]);
    expect(res.warnings.join(' ')).toMatch(/newer than this CLI/);
    expect(res.warnings.join(' ')).not.toMatch(/remove it by hand/);
  });

  it('preserves non-regular entries while planning managed-block removal', async () => {
    await mkdir(path.join(root, 'AGENTS.md'));

    const res = await planRemoveInstructionBlocks({
      repoRoot: root,
      instructionFiles: ['AGENTS.md'],
      generatedBy: '9.9.9',
    });

    expect(res).toEqual({
      mutations: [],
      results: [{ path: 'AGENTS.md', action: 'unchanged' }],
      warnings: ['AGENTS.md is not a regular file; preserving it unchanged.'],
    });
    expect((await lstat(path.join(root, 'AGENTS.md'))).isDirectory()).toBe(true);
  });

  it('refuses to inspect an instruction file through an ancestor symlink', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-place-outside-'));
    const sentinel = path.join(outside, 'AGENTS.md');
    await writeFile(sentinel, 'outside', 'utf8');
    await symlink(outside, path.join(root, 'redirect'));

    try {
      await expect(resolve({ instructionFiles: ['redirect/AGENTS.md'] })).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readFile(sentinel, 'utf8')).toBe('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('threads the ahead-guard reason + stampedVersion from the inject plan', async () => {
    await executeMutations((await resolve()).mutations, 'apply');

    const older = await resolve({ generatedBy: '0.0.5' });
    const canon = older.results.find((r) => r.path === 'AGENTS.md');
    expect(canon).toEqual({
      path: 'AGENTS.md',
      action: 'unchanged',
      reason: 'preserved-ahead',
      stampedVersion: '9.9.9',
    });
    expect(older.mutations.every((m) => !m.changed)).toBe(true);
  });

  it('overrideAhead threads through and downgrades the block (forced-downgrade)', async () => {
    await executeMutations((await resolve()).mutations, 'apply');

    const forced = await resolve({ generatedBy: '0.0.5', force: true, overrideAhead: true });
    const canon = forced.results.find((r) => r.path === 'AGENTS.md');
    expect(canon).toEqual({
      path: 'AGENTS.md',
      action: 'replaced',
      reason: 'forced-downgrade',
      stampedVersion: '9.9.9',
    });

    await executeMutations(forced.mutations, 'apply');
    expect(await read('AGENTS.md')).toContain(`${MARKER}0.0.5 -->`);
  });
});
