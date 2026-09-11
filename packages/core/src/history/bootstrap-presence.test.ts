import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';

import { enumerateDatabaseGitContexts, resolveDatabaseGitContext } from './context/git-context.js';
import { runHistoryGit } from './git-context.js';
import { BOOTSTRAP_CHECKOUT_LOCATIONS, inspectBootstrapInventory } from './presence.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});
const repositoryId = '01900000-0000-7000-8000-000000000001';

async function fixture(linked = true) {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'history-presence-'));
  temporaryRoots.push(raw);
  const temporary = await fs.realpath(raw);
  const main = path.join(temporary, 'main');
  await fs.mkdir(main);
  await runHistoryGit(main, ['init', '-q']);
  await runHistoryGit(main, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'Initial',
  ]);
  const sibling = path.join(temporary, 'linked');
  if (linked) await runHistoryGit(main, ['worktree', 'add', '-qb', 'linked', sibling]);
  const root = await normalizeHistoryRoot({ root: path.join(temporary, 'data') });
  const context = await resolveDatabaseGitContext({ cwd: main });
  return { temporary, main, sibling, root, context };
}

async function inspect(f: Awaited<ReturnType<typeof fixture>>, projectId?: string | null) {
  const inventory = await enumerateDatabaseGitContexts(f.context);
  return inspectBootstrapInventory({ context: f.context, root: f.root, projectId }, inventory);
}

describe('bounded bootstrap presence', () => {
  it('matches all committed supported locations exactly', async () => {
    const contract = JSON.parse(
      await fs.readFile(
        fileURLToPath(
          new URL('../../../test-harness/tests/fixtures/bootstrap-locations.json', import.meta.url)
        ),
        'utf8'
      )
    );
    expect(BOOTSTRAP_CHECKOUT_LOCATIONS).toEqual(contract.checkout_presence);
  });

  it('proves a clean main and linked checkout fresh without reading generic files or creating state', async () => {
    const f = await fixture();
    for (const parent of ['.agents', '.claude', '.cursor', '.opencode'])
      await fs.mkdir(path.join(f.sibling, parent));
    await fs.writeFile(path.join(f.sibling, 'AGENTS.md'), 'Unrelated user prose');
    await fs.writeFile(path.join(f.sibling, '.claude', 'settings.json'), 'not inspected');
    const opened: string[] = [];
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
      .open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      opened.push(String(args[0]));
      return original(...args);
    });
    const preview = await inspect(f);
    expect(preview.fresh).toBe(true);
    expect(preview.inventory.contexts.map((context) => context.worktreeRoot).sort()).toEqual(
      [f.main, f.sibling].sort()
    );
    for (const context of preview.inventory.contexts)
      expect(
        preview.checked
          .filter(
            (check) =>
              check.context_id === context.gitDir &&
              BOOTSTRAP_CHECKOUT_LOCATIONS.includes(
                check.relative_location as (typeof BOOTSTRAP_CHECKOUT_LOCATIONS)[number]
              )
          )
          .map((check) => check.relative_location)
      ).toEqual(BOOTSTRAP_CHECKOUT_LOCATIONS);
    expect(
      opened.every(
        (file) => file.startsWith(f.context.commonDir) || file === path.join(f.sibling, '.git')
      )
    ).toBe(true);
    expect(await fs.readdir(f.temporary)).toEqual(['linked', 'main']);
    await expect(fs.lstat(path.join(f.context.commonDir, 'orcaops'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    '.orcaops',
    '.agents/skills/orcaops-capture/SKILL.md',
    '.aider-desk/commands/orcaops/show.md',
    '.cursor/commands/orcaops-status.md',
    '.opencode/plugins/orcaops-session-context.js',
  ])('retains sibling %s evidence without opening its payload', async (location) => {
    const f = await fixture();
    const file = path.join(f.sibling, location);
    if (location === '.orcaops') {
      await fs.mkdir(path.join(file, 'reviews'), { recursive: true });
      await fs.writeFile(path.join(file, 'reviews', 'only.json'), 'invalid legacy payload');
    } else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'invalid legacy payload');
    }
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
      .open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).startsWith(file)) throw new Error('Legacy payload opened');
      return original(...args);
    });
    const preview = await inspect(f);
    expect(preview.fresh).toBe(false);
    expect(preview.checked).toContainEqual(
      expect.objectContaining({ relative_location: location, state: 'present' })
    );
  });

  it.each(['metadata', 'config', 'refs', 'exclude', 'catalog', 'destination'])(
    'detects existing %s metadata conservatively',
    async (kind) => {
      const f = await fixture(false);
      if (kind === 'metadata') await fs.mkdir(path.join(f.context.commonDir, 'orcaops'));
      if (kind === 'config')
        await runHistoryGit(f.main, ['config', '--local', 'orcaops.unknown', 'value']);
      if (kind === 'refs') {
        const head = (await runHistoryGit(f.main, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
        await runHistoryGit(f.main, ['update-ref', 'refs/notes/orcaops', head]);
      }
      if (kind === 'exclude')
        await fs.appendFile(path.join(f.context.commonDir, 'info', 'exclude'), '\n.orcaops/\n');
      if (kind === 'catalog') {
        await fs.mkdir(f.root.resolvedRoot);
        await fs.writeFile(
          path.join(f.root.resolvedRoot, 'projects.json'),
          JSON.stringify({
            schema_version: 1,
            projects: { [repositoryId]: { last_seen_paths: [f.main] } },
          })
        );
      }
      if (kind === 'destination')
        await fs.mkdir(path.join(f.root.resolvedRoot, 'projects', repositoryId), {
          recursive: true,
        });
      const result = await inspect(f, kind === 'destination' ? repositoryId : null);
      expect(result.fresh).toBe(false);
      expect(result.checked.some((check) => check.state === 'present')).toBe(true);
    }
  );

  it.each(['project config', 'personal manifest'])(
    'detects custom-prefix installs through surviving %s without decoding their files',
    async (kind) => {
      const f = await fixture(false);
      const generated = path.join(f.main, '.agents/skills/custom-capture/SKILL.md');
      await fs.mkdir(path.dirname(generated), { recursive: true });
      await fs.writeFile(generated, 'Custom-prefix generated skill');
      const marker =
        kind === 'project config'
          ? path.join(f.main, '.orcaops/config.json')
          : path.join(f.context.commonDir, 'orcaops/personal-manifest.json');
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, 'Unreadable legacy payload is not decoded');
      const original = (
        await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      ).open;
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if ([generated, marker].includes(String(args[0]))) throw new Error('Legacy payload opened');
        return original(...args);
      });
      const result = await inspect(f);
      expect(result.fresh).toBe(false);
      expect(vi.mocked(fs.open).mock.calls.map(([file]) => String(file))).not.toContain(generated);
      expect(vi.mocked(fs.open).mock.calls.map(([file]) => String(file))).not.toContain(marker);
      expect(result.checked).toContainEqual(
        expect.objectContaining({
          relative_location: kind === 'project config' ? '.orcaops' : 'orcaops',
          state: 'present',
        })
      );
    }
  );

  it('does not associate an unrelated catalog entry or tolerate a malformed catalog', async () => {
    const f = await fixture(false);
    await fs.mkdir(f.root.resolvedRoot);
    const catalog = path.join(f.root.resolvedRoot, 'projects.json');
    await fs.writeFile(
      catalog,
      JSON.stringify({
        schema_version: 1,
        projects: { [repositoryId]: { last_seen_paths: ['/unrelated'] } },
      })
    );
    expect((await inspect(f)).fresh).toBe(true);
    await fs.writeFile(catalog, '{');
    const result = await inspect(f);
    expect(result.fresh).toBe(false);
    expect(result.unresolved).toContainEqual(
      expect.objectContaining({ relative_location: 'projects.json:membership' })
    );
  });

  it('does not prove absence through symlinked parents', async () => {
    const f = await fixture();
    await fs.symlink(path.join(f.temporary, 'missing'), path.join(f.sibling, '.agents'));
    const result = await inspect(f);
    expect(result.fresh).toBe(false);
    expect(result.unresolved.some((entry) => entry.relative_location.startsWith('.agents/'))).toBe(
      true
    );
  });

  it('classifies generated markers of the wrong type as unresolved', async () => {
    const f = await fixture(false);
    const marker = '.agents/skills/orcaops-capture/SKILL.md';
    await fs.mkdir(path.join(f.main, marker), { recursive: true });
    const result = await inspect(f);
    expect(result.unresolved).toContainEqual(
      expect.objectContaining({ relative_location: marker, state: 'unclassified' })
    );
    expect(result.fresh).toBe(false);
  });

  it('treats catalog path aliases as prior evidence without assigning their project', async () => {
    const f = await fixture(false);
    const alias = path.join(f.temporary, 'alias');
    await fs.symlink(f.main, alias);
    await fs.mkdir(f.root.resolvedRoot);
    await fs.writeFile(
      path.join(f.root.resolvedRoot, 'projects.json'),
      JSON.stringify({
        schema_version: 1,
        projects: { [repositoryId]: { last_seen_paths: [alias] } },
      })
    );
    expect((await inspect(f)).fresh).toBe(false);
  });
});
