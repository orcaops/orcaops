import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const fixtureTempDirs: string[] = [];
const makeFixtureTempDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  fixtureTempDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of fixtureTempDirs.reverse()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// Hermeticity: the snapshot layer resolves the archive through ORCAOPS_DATA_DIR
// → XDG_DATA_HOME → ~/.orcaops and the index through XDG_CACHE_HOME, so a leaked
// ambient var would read the developer's real archive. Scrub every ORCAOPS_*
// override, then point the archive and caches at throwaway dirs.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ORCAOPS_')) delete process.env[key];
}
process.env.ORCAOPS_DATA_DIR = makeFixtureTempDir('orcaops-watch-data-archive-');
process.env.XDG_DATA_HOME = makeFixtureTempDir('orcaops-watch-data-data-');
process.env.XDG_CACHE_HOME = makeFixtureTempDir('orcaops-watch-data-cache-');
