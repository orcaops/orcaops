import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  emptyRegistry,
  loadRegistry,
  type Registry,
  REGISTRY_SCHEMA_VERSION,
  saveRegistry,
  touchProject,
} from './registry.js';

const TS = '2026-07-02T12:00:00.000Z';
const PID = '019f0000-aaaa-7000-8000-000000000001';

describe('loadRegistry (tolerant)', () => {
  it('missing file → empty registry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-reg-'));
    expect(await loadRegistry(path.join(dir, 'projects.json'))).toEqual(emptyRegistry());
  });

  it('corrupt JSON and wrong-shape JSON → empty registry, no throw', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-reg-'));
    const file = path.join(dir, 'projects.json');
    await writeFile(file, '{not json', 'utf8');
    expect(await loadRegistry(file)).toEqual(emptyRegistry());
    await writeFile(file, JSON.stringify({ schema_version: 99, projects: 'nope' }), 'utf8');
    expect(await loadRegistry(file)).toEqual(emptyRegistry());
  });

  it('round-trips through saveRegistry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-reg-'));
    const file = path.join(dir, 'nested', 'projects.json');
    const { registry } = touchProject(emptyRegistry(), PID, {
      displayName: 'my-repo',
      path: '/w/my-repo',
      remote: 'git@example.com:me/my-repo.git',
      rootCommitShas: ['abc'],
      ts: TS,
    });
    await saveRegistry(file, registry);
    expect(await loadRegistry(file)).toEqual(registry);
    // Written pretty-printed with a trailing newline (diff-friendly).
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true);
  });
});

describe('touchProject (pure, write-only-on-change)', () => {
  it('first touch creates the project and reports changed', () => {
    const r = touchProject(emptyRegistry(), PID, { displayName: 'repo', path: '/a', ts: TS });
    expect(r.changed).toBe(true);
    expect(r.registry.projects[PID]).toEqual({
      display_name: 'repo',
      last_seen_paths: ['/a'],
      remotes: [],
      root_commit_shas: [],
      last_seen_at: TS,
    });
  });

  it('re-touching with identical hints reports unchanged and returns the SAME registry', () => {
    const first = touchProject(emptyRegistry(), PID, { displayName: 'repo', path: '/a', ts: TS });
    const second = touchProject(first.registry, PID, {
      displayName: 'repo',
      path: '/a',
      ts: '2026-07-03T00:00:00.000Z',
    });
    expect(second.changed).toBe(false);
    expect(second.registry).toBe(first.registry);
    // last_seen_at did NOT advance — reads never rewrite the file.
    expect(second.registry.projects[PID].last_seen_at).toBe(TS);
  });

  it('a new path moves to the front, dedupes, and caps at 8', () => {
    let reg: Registry = emptyRegistry();
    for (let i = 0; i < 10; i++) {
      reg = touchProject(reg, PID, { path: `/p${i}`, ts: TS }).registry;
    }
    const paths = reg.projects[PID].last_seen_paths;
    expect(paths).toHaveLength(8);
    expect(paths[0]).toBe('/p9');
    // Re-touch an existing older path → moves to front without growing.
    reg = touchProject(reg, PID, { path: '/p5', ts: TS }).registry;
    expect(reg.projects[PID].last_seen_paths[0]).toBe('/p5');
    expect(reg.projects[PID].last_seen_paths).toHaveLength(8);
  });

  it('schema version is pinned', () => {
    expect(REGISTRY_SCHEMA_VERSION).toBe(1);
  });
});
