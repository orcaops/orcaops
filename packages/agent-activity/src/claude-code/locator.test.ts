import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { claudeProjectBases, ClaudeTranscriptLocator } from './locator.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-locator-'));
  roots.push(root);
  return root;
}

async function writeAnchor(base: string, project: string, sessionId: string): Promise<string> {
  const projectDir = path.join(base, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, `${sessionId}.jsonl`), '');
  return projectDir;
}

describe('claudeProjectBases', () => {
  it('normalizes configured roots with precedence, trimming, expansion, and deduplication', async () => {
    const home = await temporaryRoot();
    const configured = path.join(home, 'configured');

    expect(
      claudeProjectBases({
        HOME: home,
        CLAUDE_CONFIG_DIR: ` ${configured}, ,~/alternate,${configured},${path.join(home, 'direct', 'projects')} `,
        XDG_CONFIG_HOME: path.join(home, 'ignored-xdg'),
      })
    ).toEqual([
      path.join(configured, 'projects'),
      path.join(home, 'alternate', 'projects'),
      path.join(home, 'direct', 'projects'),
    ]);
  });

  it('returns the explicit XDG base before the legacy home base', async () => {
    const home = await temporaryRoot();
    const xdg = path.join(home, 'xdg');

    expect(claudeProjectBases({ HOME: home, XDG_CONFIG_HOME: ` ${xdg} ` })).toEqual([
      path.join(xdg, 'claude', 'projects'),
      path.join(home, '.claude', 'projects'),
    ]);
  });

  it('returns both default home bases in discovery order', async () => {
    const home = await temporaryRoot();

    expect(claudeProjectBases({ HOME: home })).toEqual([
      path.join(home, '.config', 'claude', 'projects'),
      path.join(home, '.claude', 'projects'),
    ]);
  });

  it('falls back to default roots when configured entries are empty', async () => {
    const home = await temporaryRoot();

    expect(claudeProjectBases({ HOME: home, CLAUDE_CONFIG_DIR: ' , , ' })).toEqual([
      path.join(home, '.config', 'claude', 'projects'),
      path.join(home, '.claude', 'projects'),
    ]);
  });
});

describe('ClaudeTranscriptLocator', () => {
  it('locates multiple sessions by their anchor files', async () => {
    const home = await temporaryRoot();
    const base = path.join(home, 'configured');
    const firstDir = await writeAnchor(base, 'project-a', 'session-a');
    const secondDir = await writeAnchor(base, 'project-b', 'session-b');
    const locator = new ClaudeTranscriptLocator({ HOME: home, CLAUDE_CONFIG_DIR: base });

    const found = await locator.locateSessions(new Set(['session-a', 'session-b', 'missing']));

    expect(found.get('session-a')).toEqual({
      sessionId: 'session-a',
      projectDir: firstDir,
      transcriptPath: path.join(firstDir, 'session-a.jsonl'),
    });
    expect(found.get('session-b')?.projectDir).toBe(secondDir);
    expect(found.has('missing')).toBe(false);
  });

  it('uses cwd encoding only to prefer a matching anchored project', async () => {
    const home = await temporaryRoot();
    const base = path.join(home, 'configured');
    await writeAnchor(base, 'a-project', 'session');
    const preferred = await writeAnchor(base, '-workspace--project', 'session');
    const locator = new ClaudeTranscriptLocator({ HOME: home, CLAUDE_CONFIG_DIR: base });

    expect((await locator.locateSession('session', '/workspace/.project'))?.projectDir).toBe(
      preferred
    );
    expect(await locator.locateSession('missing', '/workspace/.project')).toBeNull();
  });

  it('uses the first configured base containing an anchor', async () => {
    const home = await temporaryRoot();
    const first = path.join(home, 'first');
    const second = path.join(home, 'second');
    const firstDir = await writeAnchor(first, 'project', 'session');
    await writeAnchor(second, 'project', 'session');
    const locator = new ClaudeTranscriptLocator({
      HOME: home,
      CLAUDE_CONFIG_DIR: `${first},${second}`,
    });

    expect((await locator.locateSession('session'))?.projectDir).toBe(firstDir);
  });

  it('requires the anchor to be a file', async () => {
    const home = await temporaryRoot();
    const base = path.join(home, 'configured');
    await mkdir(path.join(base, 'projects', 'project', 'session.jsonl'), { recursive: true });
    const locator = new ClaudeTranscriptLocator({ HOME: home, CLAUDE_CONFIG_DIR: base });

    expect(await locator.locateSession('session')).toBeNull();
  });

  it('continues after missing and non-directory roots', async () => {
    const home = await temporaryRoot();
    const missing = path.join(home, 'missing');
    const invalid = path.join(home, 'not-a-directory');
    const valid = path.join(home, 'valid');
    await writeFile(invalid, 'not a directory');
    const projectDir = await writeAnchor(valid, 'project', 'session');
    const locator = new ClaudeTranscriptLocator({
      HOME: home,
      CLAUDE_CONFIG_DIR: `${missing},${invalid},${valid}`,
    });

    expect((await locator.locateSession('session'))?.projectDir).toBe(projectDir);
  });

  it('ignores blank session ids', async () => {
    const home = await temporaryRoot();
    const locator = new ClaudeTranscriptLocator({ HOME: home });

    expect(await locator.locateSession('   ')).toBeNull();
    expect((await locator.locateSessions(new Set(['', '   ']))).size).toBe(0);
  });

  it('rejects path-like session ids before anchor lookup', async () => {
    const home = await temporaryRoot();
    const base = path.join(home, 'configured');
    const projectsDir = path.join(base, 'projects');
    await mkdir(path.join(projectsDir, 'a-project'), { recursive: true });
    await writeFile(path.join(projectsDir, 'outside.jsonl'), 'escape target');
    const locator = new ClaudeTranscriptLocator({ HOME: home, CLAUDE_CONFIG_DIR: base });
    const invalid = [
      '../outside',
      '..\\outside',
      '/absolute/session',
      'C:\\absolute\\session',
      '.',
      '..',
      '',
      '   ',
    ];

    for (const sessionId of invalid) {
      expect(await locator.locateSession(sessionId), sessionId).toBeNull();
    }
    expect(await locator.locateSessions(new Set(invalid))).toEqual(new Map());
  });

  it('accepts UUID-style and opaque single-component session ids', async () => {
    const home = await temporaryRoot();
    const base = path.join(home, 'configured');
    const uuid = '11111111-2222-3333-4444-555555555555';
    const uuidProject = await writeAnchor(base, 'project-a', uuid);
    const opaqueProject = await writeAnchor(base, 'project-b', 'sess-1');
    const locator = new ClaudeTranscriptLocator({ HOME: home, CLAUDE_CONFIG_DIR: base });

    expect((await locator.locateSession(`  ${uuid}  `))?.projectDir).toBe(uuidProject);
    const found = await locator.locateSessions(new Set([uuid, ' sess-1 ']));
    expect(found.get(uuid)?.projectDir).toBe(uuidProject);
    expect(found.get('sess-1')?.projectDir).toBe(opaqueProject);
  });
});
