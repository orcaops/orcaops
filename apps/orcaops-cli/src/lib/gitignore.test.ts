import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureGitignoreEntries,
  ORCAOPS_BASE_GITIGNORE,
  planGitignoreEntries,
  planRemoveGitignoreEntries,
  reconcileGitignore,
} from './gitignore.js';
import { ORCAOPS_MANAGED_BLOCK_END, ORCAOPS_MANAGED_BLOCK_START } from './managed-line-block.js';
import { gitignoreMutation, mutationGlyph } from './mutations.js';

describe('ORCAOPS_BASE_GITIGNORE — nested-store pair', () => {
  it('ignores nested .orcaops everywhere, then re-includes the ROOT store (order is load-bearing)', () => {
    const broad = ORCAOPS_BASE_GITIGNORE.indexOf('**/.orcaops/');
    const negation = ORCAOPS_BASE_GITIGNORE.indexOf('!/.orcaops/');
    expect(broad).toBeGreaterThanOrEqual(0);
    // git's last-match-wins: the negation must FOLLOW the broad ignore, or
    // the root store (committed install.json / evaluators.yaml) gets ignored.
    expect(negation).toBe(broad + 1);
  });
});

describe('gitignore planner (idempotent)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-gi-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const gi = () => readFile(path.join(root, '.gitignore'), 'utf8');
  const block = (lines: string[]): string =>
    `${ORCAOPS_MANAGED_BLOCK_START}\n${lines.join('\n')}\n${ORCAOPS_MANAGED_BLOCK_END}\n`;

  it('a brand-new .gitignore has no leading blank line', async () => {
    const plan = await planGitignoreEntries(root, ['.orcaops/install.local.json']);
    expect(plan.desiredContent).toBe(block(['.orcaops/install.local.json']));
  });

  it('a later add reuses the existing block — never a second one', async () => {
    await ensureGitignoreEntries(root, ['.orcaops/install.local.json']);
    const added = await ensureGitignoreEntries(root, ['.claude/skills/orcaops-*/']);
    expect(added).toEqual(['.claude/skills/orcaops-*/']);
    const content = await gi();
    expect(content.match(/# >>> orcaops >>>/g)).toHaveLength(1);
    expect(content).toContain('.orcaops/install.local.json');
    expect(content).toContain('.claude/skills/orcaops-*/');
    // Re-running with everything present is a no-op.
    const noop = await planGitignoreEntries(root, ['.orcaops/install.local.json']);
    expect(noop.desiredContent).toBeNull();
  });

  it('preserves pre-existing user content, separated from the orcaops block', async () => {
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n', 'utf8');
    await ensureGitignoreEntries(root, ['.orcaops/install.local.json']);
    const content = await gi();
    expect(content.startsWith('node_modules\n')).toBe(true);
    expect(content).toContain(block(['.orcaops/install.local.json']));
  });

  it('mutationGlyph marks a gitignore create with + (currentContent is "" not null)', async () => {
    const plan = await planGitignoreEntries(root, ['.orcaops/install.local.json']);
    expect(mutationGlyph(gitignoreMutation(root, plan))).toBe('+');
  });

  it('refuses a final .gitignore symlink without changing its external target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-gi-outside-'));
    const external = path.join(outside, '.gitignore');
    await writeFile(external, 'outside\n', 'utf8');
    await symlink(external, path.join(root, '.gitignore'));

    try {
      await expect(planGitignoreEntries(root, ['.orcaops/'])).rejects.toThrow(
        /must not contain symlinks/
      );
      await expect(ensureGitignoreEntries(root, ['.orcaops/'])).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readFile(external, 'utf8')).toBe('outside\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('planRemoveGitignoreEntries (inverse of the writer)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-gi-rm-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const LINES = ['.orcaops/artifacts/', '.orcaops/cache/', '.orcaops/install.local.json'];
  const block = (lines: string[]): string =>
    `${ORCAOPS_MANAGED_BLOCK_START}\n${lines.join('\n')}\n${ORCAOPS_MANAGED_BLOCK_END}\n`;

  it('an orcaops-only .gitignore rounds back to absent (deleteFile)', async () => {
    await ensureGitignoreEntries(root, LINES);
    const plan = await planRemoveGitignoreEntries(root, LINES);
    expect(plan.deleteFile).toBe(true);
    expect(plan.removed.sort()).toEqual([...LINES].sort());
  });

  it('preserves user lines and drops the empty bounded block', async () => {
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n', 'utf8');
    await ensureGitignoreEntries(root, LINES);
    const plan = await planRemoveGitignoreEntries(root, LINES);
    expect(plan.deleteFile).toBe(false);
    expect(plan.desiredContent).toBe('node_modules\n');
    expect(plan.removed).toContain('.orcaops/cache/');
  });

  it('absent .gitignore → no-op', async () => {
    const plan = await planRemoveGitignoreEntries(root, LINES);
    expect(plan).toMatchObject({ removed: [], desiredContent: null, deleteFile: false });
  });

  it('a file with none of our entries is left untouched (stray # orcaops kept)', async () => {
    await writeFile(path.join(root, '.gitignore'), '# orcaops\ndist/\n', 'utf8');
    const plan = await planRemoveGitignoreEntries(root, LINES);
    expect(plan.removed).toEqual([]);
    expect(plan.desiredContent).toBeNull();
    expect(plan.deleteFile).toBe(false);
  });

  it('preserves a matching user line outside the block during uninstall', async () => {
    await writeFile(
      path.join(root, '.gitignore'),
      `.orcaops/cache/\n\n${block(['.orcaops/cache/'])}`,
      'utf8'
    );
    const plan = await planRemoveGitignoreEntries(root, ['.orcaops/cache/']);
    expect(plan.removed).toEqual(['.orcaops/cache/']);
    expect(plan.desiredContent).toBe('.orcaops/cache/\n');
  });

  it('keeps retained entries inside the bounded block during partial uninstall', async () => {
    await writeFile(path.join(root, '.gitignore'), block(LINES), 'utf8');
    const plan = await planRemoveGitignoreEntries(root, ['.orcaops/install.local.json']);
    expect(plan.desiredContent).toBe(block(['.orcaops/artifacts/', '.orcaops/cache/']));
  });
});

describe('reconcileGitignore ownership', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-gi-rec-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const block = (lines: string[]): string =>
    `${ORCAOPS_MANAGED_BLOCK_START}\n${lines.join('\n')}\n${ORCAOPS_MANAGED_BLOCK_END}\n`;

  it('preserves matching user lines outside the bounded block on update', async () => {
    await writeFile(
      path.join(root, '.gitignore'),
      `.orcaops/cache/\n\n${block(['.orcaops/cache/', '.orcaops/tmp/'])}`,
      'utf8'
    );
    const plan = await reconcileGitignore(root, ['.orcaops/cache/']);
    expect(plan.desiredContent).toBe(`.orcaops/cache/\n\n${block(['.orcaops/cache/'])}`);
  });

  it('keeps an unmatched start marker and following user lines outside the managed block', async () => {
    const gitignorePath = path.join(root, '.gitignore');
    await writeFile(gitignorePath, `${ORCAOPS_MANAGED_BLOCK_START}\nuser.log\n`, 'utf8');

    const first = await reconcileGitignore(root, ['.orcaops/cache/']);
    expect(first.desiredContent).toBe(
      `${ORCAOPS_MANAGED_BLOCK_START}\nuser.log\n\n${block(['.orcaops/cache/'])}`
    );
    await writeFile(gitignorePath, first.desiredContent as string, 'utf8');

    const second = await reconcileGitignore(root, ['.orcaops/cache/']);
    expect(second.desiredContent).toBeNull();
    expect(await readFile(gitignorePath, 'utf8')).toContain(
      `${ORCAOPS_MANAGED_BLOCK_START}\nuser.log\n`
    );
  });
});
