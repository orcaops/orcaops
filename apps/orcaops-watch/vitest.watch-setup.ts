import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const fixtureTempRoot = tmpdir();
const fixtureTempDirs: string[] = [];
const makeFixtureTempDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(fixtureTempRoot, prefix));
  fixtureTempDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of fixtureTempDirs.reverse()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// Hermeticity (mirrors apps/orcaops-cli/vitest.cli-setup.ts): the watch suite
// must honor only the orcaops env it sets itself, never the developer's ambient
// ORCAOPS_* / data dirs. The history root resolves through ORCAOPS_DATA_DIR →
// XDG_DATA_HOME → ~/.orcaops and caches through XDG_CACHE_HOME, so a leaked
// ambient var would read the machine's real project databases. Scrub every
// ORCAOPS_* override, then point the data root + caches at throwaway dirs.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ORCAOPS_')) delete process.env[key];
}
process.env.ORCAOPS_DATA_DIR = makeFixtureTempDir('orcaops-watch-history-');
process.env.XDG_DATA_HOME = makeFixtureTempDir('orcaops-watch-data-');
process.env.XDG_CACHE_HOME = makeFixtureTempDir('orcaops-watch-cache-');

// Same ambient-agent scrub as the CLI suite: a dev running vitest inside an
// agent shell (Claude Code exports CLAUDECODE=1) must not leak those markers
// into the delegation-stub test's child env.
for (const key of [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
]) {
  delete process.env[key];
}
