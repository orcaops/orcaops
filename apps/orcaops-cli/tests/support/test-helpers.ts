import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CLOUD_BASE_URL, FileStore, loadConfig, resolveConfigPath } from '@orcaops/core';
import {
  ArtifactStore,
  type EvaluatorDispositionPayload,
  type EvaluatorRunPayload,
  uuidv7,
} from '@orcaops/storage';
import { gitClient, type InProcessAgent } from '@orcaops/test-harness';

/**
 * Absolute path to the workspace's tests/fixtures/test-pack. CLI tests
 * call this via `installTestPack(agent)` from a fresh TempRepo so the
 * test ref namespace (`test-pack/<id>`) is discoverable through the
 * real resolver.
 */
export const TEST_PACK_ABS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/test-pack'
);

/** Convenience: the `test-pack/<id>` evaluator_ref strings used by tests. */
export const TEST_PACK_REFS = {
  apiStub: 'test-pack/api-stub',
  scopeDensityStub: 'test-pack/scope-density-stub',
  strictStub: 'test-pack/strict-stub',
} as const;

/**
 * Install the workspace's test-pack into the agent's repo via the
 * real `eval add-pack` command. Routes through the CLI agent so the
 * pack lands in the agent's cwd (not the test process cwd) — needed
 * for any test that calls a discovery-routed command afterwards
 * (block acknowledge / dismiss, eval test, lifecycle gates).
 *
 * Tests that only assert on storage projections (event logs / search
 * index) may instead seed `evaluator_runs` directly with a stable
 * `test-pack/<id>` ref via `plantBlockViolation` and skip the install.
 */
export async function installTestPack(agent: InProcessAgent): Promise<void> {
  const r = await agent.runRaw(['eval', 'add-pack', TEST_PACK_ABS_PATH, '--yes', '--json']);
  if (r.exitCode !== 0) {
    throw new Error(`installTestPack failed (exitCode=${r.exitCode}): ${r.stderr || r.stdout}`);
  }
}

/**
 * Strip every shell-key env var the CLI's `resolveShellKey` reads, then
 * merge in test-specific overrides. Used by tests that need a clean env
 * before exercising shell-key precedence (CLAUDE_SESSION_ID,
 * CODEX_SESSION_ID, TMUX_PANE, STY, WINDOW, TTY) and / or XDG_STATE_HOME
 * isolation.
 *
 * Pass the resulting object to `makeAgent({ env: withCleanSession(...) })`.
 */
export function withCleanSession(extras: Record<string, string>): Record<string, string> {
  return {
    CLAUDE_SESSION_ID: '',
    CODEX_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
    // A REAL throwaway dir, not '' — `pinStoreRoot` treats the empty string
    // as unset and falls back to the developer's real ~/.local/state, so ''
    // here would leak pin dirs from every withCleanSession caller that runs
    // `capture plan` without an explicit xdgState override.
    XDG_STATE_HOME: mkdtempSync(path.join(tmpdir(), 'orcaops-test-state-')),
    ...extras,
  };
}

/**
 * Seed a pre-pr block evaluator violation for an artifact. Used by
 * tests that exercise the BLOCKED summary / acknowledge / dismiss
 * surface without driving an actual evaluator failure (which would
 * require staging a real violation in the working tree).
 *
 * Writes an `evaluator_run_recorded` event with the new
 * EvaluatorRunPayload shape. Returns the minted run_id so test code
 * can target the disposition write at it.
 *
 * `evaluatorRef` is the `<pack>/<id>` ref the violation will surface
 * as. Tests typically pass one of the `TEST_PACK_REFS` constants
 * (resolved via the real `apps/orcaops-cli/tests/fixtures/test-pack`
 * after the test sets up `runAddPack({ source: TEST_PACK_ABS_PATH })`)
 * so downstream CLI lookups via discoverEvaluators succeed.
 */
export async function plantBlockViolation(opts: {
  cwd: string;
  artifactId: string;
  evaluatorRef: string;
}): Promise<string> {
  const config = await loadConfig(opts.cwd);
  const store = new ArtifactStore({ repoRoot: opts.cwd, config });
  try {
    const runId = uuidv7();
    const [packageId, evaluatorId] = opts.evaluatorRef.split('/');
    const payload: EvaluatorRunPayload = {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: opts.artifactId,
      evaluator_ref: opts.evaluatorRef,
      package_id: packageId,
      evaluator_id: evaluatorId,
      phase: 'pre-pr',
      severity: 'block',
      run_status: 'completed',
      verdict: 'violation',
      body: 'VIOLATION\n\nseeded for test',
      ts: new Date().toISOString(),
    };
    await store.writeEvaluatorRunPayload(opts.artifactId, payload);
    return runId;
  } finally {
    store.close();
  }
}

/**
 * Seed a pre-pr block evaluator run as already-acknowledged. Pairs
 * with {@link plantBlockViolation} when a test needs to verify
 * behavior on the post-acknowledge path (e.g., summary unblocking).
 *
 * Writes the underlying violation event AND a paired
 * evaluator_disposition_recorded event so the materialized projection
 * surfaces `disposition: 'acknowledged'` on the targeted run.
 */
export async function plantAcknowledge(opts: {
  cwd: string;
  artifactId: string;
  evaluatorRef: string;
}): Promise<{ runId: string; dispositionId: string }> {
  const runId = await plantBlockViolation({
    cwd: opts.cwd,
    artifactId: opts.artifactId,
    evaluatorRef: opts.evaluatorRef,
  });
  const config = await loadConfig(opts.cwd);
  const store = new ArtifactStore({ repoRoot: opts.cwd, config });
  try {
    const dispositionId = uuidv7();
    const payload: EvaluatorDispositionPayload = {
      schema: 'orcaops.evaluator_disposition/v1',
      disposition_id: dispositionId,
      artifact_id: opts.artifactId,
      run_id: runId,
      evaluator_ref: opts.evaluatorRef,
      disposition: 'acknowledged',
      reason: 'resolved by test',
      agent_session_id: null,
      ts: new Date().toISOString(),
    };
    await store.writeEvaluatorDisposition(opts.artifactId, payload);
    return { runId, dispositionId };
  } finally {
    store.close();
  }
}

/**
 * Write a file, stage it, commit. Returns the new HEAD SHA. The parent
 * directory is created if needed. Used by repo-state / lineage / sync
 * tests to plant material for the CLI to inspect.
 */
export async function commitFile(
  repoPath: string,
  file: string,
  content: string,
  msg: string
): Promise<string> {
  const full = path.join(repoPath, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  const git = gitClient(repoPath);
  await git.add(file);
  // Committing content identical to HEAD stages nothing; gitClient treats that
  // as a no-op and this returns the unchanged HEAD, which several callers rely on.
  await git.commit(msg);
  return git.revparse(['HEAD']);
}

/**
 * Seed a logged-in cloud credential into the test's ORCAOPS_CONFIG_HOME so checkpoint
 * snapshot capture passes the recent-login gate. Writes through a real FileStore (no dir
 * override → resolves the per-file config home the CLI suite setup established) at
 * DEFAULT_CLOUD_BASE_URL — the target the production entrypoint injects.
 * `expiresInSeconds` offsets the access-token expiry from now: positive = fresh,
 * negative = expired (within or past the 30-day grace). Pair with `ORCAOPS_DISABLE_DRAIN: '1'`
 * on the agent env so seeded creds never trigger a real cloud sync (the temp repo has no
 * git remote, which also short-circuits eager push).
 */
export function seedCloudLogin(
  opts: { expiresInSeconds?: number; baseUrl?: string; dir?: string } = {}
): void {
  const baseUrl = opts.baseUrl ?? DEFAULT_CLOUD_BASE_URL;
  const expiresAt = Math.floor(Date.now() / 1000) + (opts.expiresInSeconds ?? 1800);
  // `dir` targets a caller-owned config home passed to an agent via env only —
  // the default store reads process.env, which such a dir is deliberately not in.
  new FileStore(opts.dir ? { dir: opts.dir } : undefined).write(baseUrl, {
    v: 1,
    loginMethod: 'oauth',
    baseUrl,
    userId: 'usr_test',
    orgId: 'org_test',
    orgName: 'Test Org',
    orgSlug: 'test-org',
    email: 'test@orcaops.test',
    accessToken: 'at_test',
    refreshToken: 'rt_test',
    expiresAt,
  });
}

/** Remove any seeded cloud credential (reset cred state between gating tests). */
export function clearCloudLogin(): void {
  new FileStore().clearAll();
}

/**
 * The config file governing `repoRoot` right now. A fresh init is personal
 * and lives in the git common dir, so a test that hand-joins
 * `<repo>/.orcaops/config.json` after init reads a file that does not exist;
 * one that is about the worktree layout should say `--scope project`.
 */
export async function effectiveConfigPath(repoRoot: string): Promise<string> {
  return resolveConfigPath(repoRoot);
}

export async function readEffectiveConfig(repoRoot: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(await effectiveConfigPath(repoRoot), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Read → mutate → write the effective config in place, as tests patch settings. */
export async function patchEffectiveConfig(
  repoRoot: string,
  mutate: (raw: Record<string, unknown>) => void
): Promise<string> {
  const configPath = await effectiveConfigPath(repoRoot);
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  mutate(raw);
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return configPath;
}
