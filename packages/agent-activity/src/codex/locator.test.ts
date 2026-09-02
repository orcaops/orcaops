import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexRolloutLocator, codexSessionRoots, parseCodexRolloutMetaLine } from './locator.js';

const ROOT = '11111111-2222-4333-8444-555555555555';
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GRANDCHILD = '12345678-1234-4234-8234-123456789abc';
const OTHER = '99999999-8888-4777-8666-555555555555';
const UNKNOWN = 'fedcba98-7654-4321-8123-0123456789ab';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-locator-'));
  roots.push(root);
  return root;
}

function meta(id: string, options: { root?: string; parent?: string; cwd?: string } = {}): object {
  return {
    timestamp: '2030-01-01T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      ...(options.root ? { session_id: options.root } : {}),
      ...(options.parent ? { parent_thread_id: options.parent, thread_source: 'subagent' } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
  };
}

async function writeRollout(
  codexHome: string,
  id: string,
  firstLine: object | string,
  date = '2027/01/02',
  collection = 'sessions'
): Promise<string> {
  const dir = path.join(codexHome, collection, ...date.split('/'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2027-01-02T03-04-05-${id}.jsonl`);
  await writeFile(
    file,
    `${typeof firstLine === 'string' ? firstLine : JSON.stringify(firstLine)}\n`
  );
  return file;
}

describe('CodexRolloutLocator', () => {
  it('indexes old live and archived rollouts once and resolves every descendant to its root', async () => {
    const base = await temporaryRoot();
    const firstHome = path.join(base, 'first');
    const secondHome = path.join(base, 'second');
    const rootFile = await writeRollout(firstHome, ROOT, meta(ROOT, { root: ROOT }), '2024/01/02');
    const childFile = await writeRollout(
      secondHome,
      CHILD,
      meta(CHILD, { root: ROOT, parent: ROOT }),
      '2025/02/03',
      'archived_sessions'
    );
    const grandchildFile = await writeRollout(
      firstHome,
      GRANDCHILD,
      meta(GRANDCHILD, { parent: CHILD }),
      '2026/03/04'
    );
    await writeRollout(secondHome, OTHER, meta(OTHER, { root: OTHER }), '2024/01/02');

    let scans = 0;
    const locator = new CodexRolloutLocator(
      { CODEX_HOME: `${firstHome},${secondHome}` },
      { indexRefreshMs: Number.POSITIVE_INFINITY, onScan: () => scans++ }
    );
    const found = await locator.locateSessions(new Set([ROOT, CHILD, GRANDCHILD]));

    expect(scans).toBe(1);
    for (const id of [ROOT, CHILD, GRANDCHILD]) {
      expect(found.get(id)?.rootSessionId).toBe(ROOT);
      expect(found.get(id)?.rollouts.map((rollout) => rollout.path)).toEqual(
        [rootFile, grandchildFile, childFile].sort()
      );
    }
    expect(await locator.canonicalizeSessionId(ROOT)).toBe(ROOT);
    expect(await locator.canonicalizeSessionId(CHILD)).toBe(ROOT);
    expect(await locator.canonicalizeSessionId(GRANDCHILD)).toBe(ROOT);

    await locator.locateSessions(new Set([ROOT, CHILD]));
    expect(scans).toBe(1);
    await locator.locateSessions(new Set([UNKNOWN, '00000000-0000-4000-8000-000000000000']));
    expect(scans).toBe(2);
  });

  it('rescans once when a known rollout moves into the archive', async () => {
    const codexHome = await temporaryRoot();
    const live = await writeRollout(codexHome, ROOT, meta(ROOT, { root: ROOT }));
    let scans = 0;
    const locator = new CodexRolloutLocator(
      { CODEX_HOME: codexHome },
      { indexRefreshMs: Number.POSITIVE_INFINITY, onScan: () => scans++ }
    );
    expect((await locator.locateSession(ROOT))?.rollouts[0]?.path).toBe(live);

    const archivedDir = path.join(codexHome, 'archived_sessions');
    await mkdir(archivedDir, { recursive: true });
    const archived = path.join(archivedDir, path.basename(live));
    await rename(live, archived);

    expect((await locator.locateSession(ROOT))?.rollouts[0]?.path).toBe(archived);
    expect(scans).toBe(2);
  });

  it('does not rescan repeatedly for absent session ids inside the refresh window', async () => {
    const codexHome = await temporaryRoot();
    let scans = 0;
    const locator = new CodexRolloutLocator(
      { CODEX_HOME: codexHome },
      { indexRefreshMs: 60_000, now: () => 1_000, onScan: () => scans++ }
    );

    for (let i = 0; i < 6; i++) {
      expect(await locator.locateSession(UNKNOWN)).toBeNull();
    }
    expect(scans).toBe(1);

    expect(
      await locator.locateSessions(new Set([UNKNOWN, '00000000-0000-4000-8000-000000000000']))
    ).toEqual(new Map());
    expect(scans).toBe(2);

    await locator.locateSessions(new Set([UNKNOWN, '00000000-0000-4000-8000-000000000000']));
    expect(scans).toBe(2);
  });

  it('discovers a negatively cached session after the index refresh boundary', async () => {
    const codexHome = await temporaryRoot();
    let nowMs = 1_000;
    let scans = 0;
    const locator = new CodexRolloutLocator(
      { CODEX_HOME: codexHome },
      { indexRefreshMs: 60_000, now: () => nowMs, onScan: () => scans++ }
    );

    expect(await locator.locateSession(UNKNOWN)).toBeNull();
    await writeRollout(codexHome, UNKNOWN, meta(UNKNOWN, { root: UNKNOWN }));
    expect(await locator.locateSession(UNKNOWN)).toBeNull();
    expect(scans).toBe(1);

    nowMs += 60_001;
    expect((await locator.locateSession(UNKNOWN))?.rootSessionId).toBe(UNKNOWN);
    expect(scans).toBe(2);
  });

  it('anchors a known filename when its first line is malformed', async () => {
    const codexHome = await temporaryRoot();
    const file = await writeRollout(codexHome, ROOT, '{not-json');
    const locator = new CodexRolloutLocator(
      { CODEX_HOME: codexHome },
      { indexRefreshMs: Number.POSITIVE_INFINITY }
    );

    const found = await locator.locateSession(ROOT);

    expect(found).toMatchObject({ rootSessionId: ROOT });
    expect(found?.rollouts).toEqual([expect.objectContaining({ path: file, meta: null })]);
  });

  it('does not canonicalize a child whose declared root is unavailable', async () => {
    const codexHome = await temporaryRoot();
    await writeRollout(codexHome, CHILD, meta(CHILD, { root: ROOT, parent: ROOT }));
    const locator = new CodexRolloutLocator(
      { CODEX_HOME: codexHome },
      { indexRefreshMs: Number.POSITIVE_INFINITY }
    );

    expect(await locator.canonicalizeSessionId(CHILD)).toBeNull();
  });
});

describe('Codex rollout metadata', () => {
  it('parses root identity and retains older parent-only links', () => {
    expect(
      parseCodexRolloutMetaLine(JSON.stringify(meta(CHILD, { root: ROOT, parent: ROOT })))
    ).toEqual({
      id: CHILD,
      rootSessionId: ROOT,
      isSubagent: true,
      parentThreadId: ROOT,
    });
    expect(parseCodexRolloutMetaLine(JSON.stringify(meta(GRANDCHILD, { parent: CHILD })))).toEqual({
      id: GRANDCHILD,
      rootSessionId: GRANDCHILD,
      isSubagent: true,
      parentThreadId: CHILD,
    });
    expect(parseCodexRolloutMetaLine('{bad')).toBeNull();
  });

  it('normalizes configured and default roots', async () => {
    const home = await temporaryRoot();
    expect(codexSessionRoots({ CODEX_HOME: '~/one, ~/one, /two' }, home)).toEqual([
      path.join(home, 'one'),
      '/two',
    ]);
    expect(codexSessionRoots({}, home)).toEqual([path.join(home, '.codex')]);
  });
});
