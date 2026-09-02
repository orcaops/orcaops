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
  // The setup deliberately moves each worker into one of these directories.
  // Leave it before deleting the owned roots so cleanup is portable.
  process.chdir(fixtureTempRoot);
  for (const dir of fixtureTempDirs.reverse()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// Make the CLI suite hermetic w.r.t. the developer's shell: it must honor only
// the orcaops env it sets itself, never ambient ORCAOPS_* overrides. Cloud
// credential resolution reads some ORCAOPS_* values straight from `process.env`
// (notably `resolveCredentialStore`'s ORCAOPS_TOKEN store selection in
// @orcaops/core), not the in-process agent's ALS env. Ambient values would make
// a direct `vitest` run disagree with `turbo` (whose strict-env `test` task
// scrubs these).
// Delete every ambient ORCAOPS_* override first, then re-establish the one var
// the suite deliberately owns: a private per-file config dir, so any auth-aware
// check (e.g. doctor's `cloud-auth`) reads an empty store instead of the
// machine's real login. Spawned smoke binaries inherit this scrubbed env.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ORCAOPS_')) delete process.env[key];
}
process.env.ORCAOPS_CONFIG_HOME = makeFixtureTempDir('orcaops-test-cfg-');

// Same hermeticity rule for ambient coding-session identity: a dev running the
// suite from inside a live Claude Code session carries CLAUDE_CODE_SESSION_ID,
// which `InProcessAgent` merges over `process.env` — so `stampUsage` resolves
// the dev's REAL session, finds their REAL transcript (the locator globs every
// `~/.claude/projects/*` dir), and appends usage-ledger lines between snapshot
// boundaries. That flips empty-fence assertions ('empty' → recovered
// 'captured') on the dev machine only. Tests that exercise sessions/pins pass
// their own ids explicitly via `makeAgent({ env })`, which overrides this scrub.
for (const key of [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
]) {
  delete process.env[key];
}

// Pin-store hermeticity: `pinStoreRoot` resolves through
// `$XDG_STATE_HOME/orcaops/pins` with a `~/.local/state` fallback, so every
// cli test that runs `capture plan` without an explicit env override leaks a
// pin directory into the developer's REAL state home, where they accumulate
// unboundedly. Point the whole suite at a throwaway state dir; tests that
// exercise pin paths explicitly still override via `makeAgent({ env })`.
process.env.XDG_STATE_HOME = makeFixtureTempDir('orcaops-test-state-');

// Archive hermeticity: the home-dir archive resolves through
// `$ORCAOPS_DATA_DIR` → `$XDG_DATA_HOME/orcaops` → `~/.orcaops`, and the
// disposable index through `$XDG_CACHE_HOME`. Any test enabling
// `archive.enabled` without these would mint a project identity and mirror
// events into the developer's REAL home archive. Point both at throwaway
// dirs (the ORCAOPS_* scrub above already removed any ambient
// ORCAOPS_DATA_DIR). Tests asserting path *tiers* pass explicit env params.
process.env.ORCAOPS_DATA_DIR = makeFixtureTempDir('orcaops-test-archive-');
process.env.XDG_DATA_HOME = makeFixtureTempDir('orcaops-test-data-');
process.env.XDG_CACHE_HOME = makeFixtureTempDir('orcaops-test-cache-');

// Global-install hermeticity: `resolveGlobalRoot`/`resolveGlobalSkillsDir`
// resolve through `$ORCAOPS_GLOBAL_ROOT` and otherwise fall back to the
// registry's REAL per-user dirs (`~/.orcaops`, `~/.claude/skills`, …). Any
// test running `init`/`update` under a global-materializing scope (`global`,
// `personal`) without an explicit override would write skill trees and the
// global manifest into the developer's real home. Point the whole suite at a
// throwaway root (the ORCAOPS_* scrub above already removed any ambient
// value); tests asserting global layout still override via `makeAgent({ env })`.
process.env.ORCAOPS_GLOBAL_ROOT = makeFixtureTempDir('orcaops-test-global-');

// Machine-level session-hook scans must never fall through to os.homedir().
// Tests that exercise custom locations still override these per invocation.
process.env.CLAUDE_CONFIG_DIR = makeFixtureTempDir('orcaops-test-claude-');
process.env.CODEX_HOME = makeFixtureTempDir('orcaops-test-codex-');

// Scrub every ambient invoking-agent marker for the same hermeticity
// reason: `InProcessAgent` merges its per-invocation env OVER
// `process.env`, so a developer running vitest from inside an agent
// shell (Claude Code exports CLAUDECODE=1 into every Bash call) would
// silently attribute every test capture to that agent. Tests that
// exercise ambient detection inject markers explicitly per agent frame.
// Keep this list in sync with AMBIENT_MARKER_ENV_KEYS/_PREFIXES in
// `src/lib/invoking-agent.ts`.
for (const key of [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CURSOR_AGENT',
  'CURSOR_TRACE_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
]) {
  delete process.env[key];
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CODEX_SANDBOX')) delete process.env[key];
}

// Repo-escape backstop: every worker starts with
// `process.cwd()` INSIDE the real orcaops repo, so any code path that falls
// back to ambient cwd — a direct-action test (no InProcessAgent ALS frame)
// whose action calls `buildContext()`, e.g. `stampPlanReviewUsage` — resolves
// the REAL repo root and can WRITE to it. Chdir each worker into a throwaway
// non-repo dir so an unsandboxed
// root inference fails loudly (UNINITIALIZED / not-a-repo, swallowed by
// best-effort paths) instead of silently mutating the host checkout. Tests
// that need a repo always pass an explicit cwd (InProcessAgent / spawn).
process.chdir(makeFixtureTempDir('orcaops-test-cwd-'));
