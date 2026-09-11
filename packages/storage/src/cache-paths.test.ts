import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkoutsRoot, ensureDir0700, writeCachedirTag } from './cache-paths.js';

const HOME = '/home/dev';

describe('checkout cache paths', () => {
  it('selects the cache root without changing the data-root fallback', () => {
    expect(checkoutsRoot({ XDG_CACHE_HOME: '/xdg/cache' }, HOME)).toBe(
      '/xdg/cache/orcaops/checkouts'
    );
    expect(checkoutsRoot({}, HOME)).toBe('/home/dev/.orcaops/checkouts-cache');
    expect(checkoutsRoot({ ORCAOPS_DATA_DIR: '/data/orca' }, HOME)).toBe(
      '/data/orca/checkouts-cache'
    );
  });

  it('tightens directories and writes the canonical cache tag', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-cache-'));
    const root = path.join(base, 'checkouts');
    await ensureDir0700(root);
    if (process.platform !== 'win32') {
      await chmod(root, 0o755);
      await ensureDir0700(root);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    }
    await writeCachedirTag(root);
    expect(await readFile(path.join(root, 'CACHEDIR.TAG'), 'utf8')).toMatch(
      /^Signature: 8a477f597d28d172789f06886806bc55\n/
    );
  });
});
