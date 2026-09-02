import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  archiveArtifactPaths,
  archiveLocksDir,
  archiveProjectDir,
  archiveReviewPaths,
  archiveRoot,
  archiveUsageLedgerPaths,
  checkoutsRoot,
  ensureDir0700,
  indexRoot,
  projectIndexDbPath,
  projectIndexMetaPath,
  registryPath,
  writeCachedirTag,
} from './paths.js';

const HOME = '/home/dev';

describe('archiveRoot', () => {
  it('prefers $ORCAOPS_DATA_DIR over everything', () => {
    const env = { ORCAOPS_DATA_DIR: '/data/orca', XDG_DATA_HOME: '/xdg/data' };
    expect(archiveRoot(env, HOME)).toBe('/data/orca');
  });

  it('falls back to $XDG_DATA_HOME/orcaops', () => {
    expect(archiveRoot({ XDG_DATA_HOME: '/xdg/data' }, HOME)).toBe('/xdg/data/orcaops');
  });

  it('defaults to ~/.orcaops', () => {
    expect(archiveRoot({}, HOME)).toBe('/home/dev/.orcaops');
  });

  it('ignores empty/whitespace env values', () => {
    expect(archiveRoot({ ORCAOPS_DATA_DIR: '  ', XDG_DATA_HOME: '' }, HOME)).toBe(
      '/home/dev/.orcaops'
    );
  });
});

describe('indexRoot', () => {
  it('prefers $XDG_CACHE_HOME/orcaops/archive-index', () => {
    expect(indexRoot({ XDG_CACHE_HOME: '/xdg/cache' }, HOME)).toBe(
      '/xdg/cache/orcaops/archive-index'
    );
  });

  it('defaults under the archive root (index-cache), honoring ORCAOPS_DATA_DIR', () => {
    expect(indexRoot({}, HOME)).toBe('/home/dev/.orcaops/index-cache');
    expect(indexRoot({ ORCAOPS_DATA_DIR: '/data/orca' }, HOME)).toBe('/data/orca/index-cache');
  });
});

describe('checkoutsRoot', () => {
  it('prefers $XDG_CACHE_HOME/orcaops/checkouts', () => {
    expect(checkoutsRoot({ XDG_CACHE_HOME: '/xdg/cache' }, HOME)).toBe(
      '/xdg/cache/orcaops/checkouts'
    );
  });

  it('defaults under the archive root (checkouts-cache), honoring ORCAOPS_DATA_DIR', () => {
    expect(checkoutsRoot({}, HOME)).toBe('/home/dev/.orcaops/checkouts-cache');
    expect(checkoutsRoot({ ORCAOPS_DATA_DIR: '/data/orca' }, HOME)).toBe(
      '/data/orca/checkouts-cache'
    );
  });
});

describe('layout shape', () => {
  const root = '/home/dev/.orcaops';
  const pid = '019f0000-aaaa-7000-8000-000000000001';

  it('mirrors the hot event-log layout per artifact', () => {
    const projectDir = archiveProjectDir(root, pid);
    expect(projectDir).toBe(path.join(root, 'projects', pid));
    const paths = archiveArtifactPaths(projectDir, 'art-1');
    expect(paths.eventsNdjson).toBe(path.join(projectDir, 'artifacts', 'art-1', 'events.ndjson'));
    expect(paths.sidecarsDir).toBe(path.join(projectDir, 'artifacts', 'art-1', 'sidecars'));
    expect(paths.derivedDir).toBe(path.join(projectDir, 'artifacts', 'art-1', 'derived'));
  });

  it('mirrors the hot usage-ledger layout per project', () => {
    const projectDir = archiveProjectDir(root, pid);
    const usage = archiveUsageLedgerPaths(projectDir);
    expect(usage.ledgerNdjson).toBe(path.join(projectDir, 'usage', 'ledger.ndjson'));
    expect(usage.sidecarsDir).toBe(path.join(projectDir, 'usage', 'sidecars'));
  });

  it('mirrors the hot review-log layout per branch slug, sibling of artifacts/', () => {
    const projectDir = archiveProjectDir(root, pid);
    const review = archiveReviewPaths(projectDir, 3, 'feat%2Fx');
    expect(review.dir).toBe(path.join(projectDir, 'reviews', 'v3', 'feat%2Fx'));
    expect(review.journalNdjson).toBe(
      path.join(projectDir, 'reviews', 'v3', 'feat%2Fx', 'journal.ndjson')
    );
    expect(review.commentsNdjson).toBe(
      path.join(projectDir, 'reviews', 'v3', 'feat%2Fx', 'comments.ndjson')
    );
  });

  it('registry and index paths hang off the right roots', () => {
    expect(registryPath(root)).toBe(path.join(root, 'projects.json'));
    const idx = '/cache/orcaops/archive-index';
    expect(projectIndexDbPath(idx, pid)).toBe(path.join(idx, `${pid}.db`));
    expect(projectIndexMetaPath(idx, pid)).toBe(path.join(idx, `${pid}.meta.json`));
    // Locks are ephemeral → they live under the DISPOSABLE index root,
    // never inside the precious archive tree.
    expect(archiveLocksDir(idx, pid)).toBe(path.join(idx, 'locks', pid));
  });
});

describe('ensureDir0700', () => {
  it('creates nested dirs and tightens pre-existing loose perms', async () => {
    if (process.platform === 'win32') return;
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-archive-'));
    const dir = path.join(base, 'a', 'b');
    await ensureDir0700(dir);
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe('700');
    // Widen, then re-ensure: the explicit chmod (not the umask-masked
    // mkdir mode) is what restores 0700 on a pre-existing dir.
    const { chmod } = await import('node:fs/promises');
    await chmod(dir, 0o755);
    await ensureDir0700(dir);
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe('700');
  });
});

describe('writeCachedirTag', () => {
  it('writes the canonical signature at the index root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-idx-'));
    const idx = path.join(base, 'archive-index');
    await writeCachedirTag(idx);
    const content = await readFile(path.join(idx, 'CACHEDIR.TAG'), 'utf8');
    expect(content.startsWith('Signature: 8a477f597d28d172789f06886806bc55')).toBe(true);
  });
});
