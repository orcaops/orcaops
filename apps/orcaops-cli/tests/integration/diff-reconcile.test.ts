import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops diff --reconcile`.
 *
 * Covers: a planted in-window commit with no checkpoint (invisible to
 * the base→worktree attribution sweep), head-divergence spans
 * (post-window commits listed separately), the no-closed-checkpoint
 * branch-HEAD fallback, `--artifact` override, files_changed-only
 * degradation disclosure, mutual exclusivity with --attribution, and —
 * the audit-command contract — unresolvable base/head erroring instead
 * of reading as a clean (empty) reconcile.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ReconciledCommitOut {
  sha: string;
  subject: string;
  files: string[];
  uncovered_files: string[];
  fully_uncovered: boolean;
}

interface Envelope {
  artifact: { id: string; source: string };
  base: { sha: string };
  window: {
    head: { sha: string; source: string; checkpoint_n: number | null };
    total_commits: number;
    covered_commit_count: number;
    commits: ReconciledCommitOut[];
    uncovered_commits: ReconciledCommitOut[];
  };
  pre_summary?: {
    summary_head_sha: string;
    total_commits: number;
    covered_commit_count: number;
    uncovered_commits: ReconciledCommitOut[];
  };
  post_window_commits: Array<{ sha: string; subject: string }>;
  disclosure: {
    coverage_basis: string;
    manifestless_checkpoints: Array<{ artifact_id: string; checkpoint_n: number }>;
    incompatible_manifest_count: number;
    no_closed_checkpoints: boolean;
  };
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

describe('orcaops diff --reconcile', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--json',
        '--no-llm',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function capturePlan(stepCount = 2): Promise<{ artifactId: string; stepIds: string[] }> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'reconcile fixture',
          label: `reconcile-${randomUUID().slice(0, 8)}`,
          plan_steps: Array.from({ length: stepCount }, (_, i) => ({
            text: `step ${i + 1}`,
            label: `s${i + 1}`,
          })),
          touched_scope: [],
        })
      ),
    ]);
    expect(pr.exitCode).toBe(0);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    return { artifactId: plan.artifact_id, stepIds: plan.plan_steps.map((s) => s.step_id) };
  }

  async function openCp(artifactId: string, stepId: string): Promise<void> {
    const r = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: artifactId,
          declared_step_ids: [stepId],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
  }

  async function closeCp(
    artifactId: string,
    n: number,
    filesChanged: string[],
    stepId: string
  ): Promise<void> {
    const r = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: artifactId,
          n,
          summary: `cp${n}`,
          files_changed: filesChanged,
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepId],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
  }

  /**
   * cp1 covers claimed.ts; smuggled.ts lands in the GAP between cp1's
   * close and cp2's open (in-window, no checkpoint fence contains it —
   * cp2's open snapshot already includes it, so no manifest does
   * either); cp2 covers covered2.ts and extends the window past the
   * smuggled commit.
   */
  async function artifactWithGapCommit(): Promise<{
    artifactId: string;
    claimedSha: string;
    smuggledSha: string;
    covered2Sha: string;
  }> {
    const { artifactId, stepIds } = await capturePlan(2);
    await openCp(artifactId, stepIds[0]);
    const claimedSha = await commitFile(
      repo.path,
      'claimed.ts',
      'export const a = 1;\n',
      'cp1 work'
    );
    await closeCp(artifactId, 1, ['claimed.ts'], stepIds[0]);
    const smuggledSha = await commitFile(
      repo.path,
      'smuggled.ts',
      'export const smuggled = true;\n',
      'smuggled between checkpoints'
    );
    await openCp(artifactId, stepIds[1]);
    const covered2Sha = await commitFile(
      repo.path,
      'covered2.ts',
      'export const b = 2;\n',
      'cp2 work'
    );
    await closeCp(artifactId, 2, ['covered2.ts'], stepIds[1]);
    return { artifactId, claimedSha, smuggledSha, covered2Sha };
  }

  function run(args: string[]): Promise<CliResult> {
    return agent.runRaw(['diff', ...args]);
  }

  it('survives a rotted sibling artifact with a warning instead of aborting the branch', async () => {
    const a = await capturePlan(1);
    await openCp(a.artifactId, a.stepIds[0]);

    const b = await capturePlan(2);
    await openCp(b.artifactId, b.stepIds[0]);
    await commitFile(repo.path, 'covered.ts', 'export const c = 1;\n', 'cp1 work');
    await closeCp(b.artifactId, 1, ['covered.ts'], b.stepIds[0]);

    // Rot A's checkpoint_opened line AND delete its projection: the loss
    // is unattributable, so A's recovery-aware checkpoint read refuses.
    const aDir = path.join(repo.path, '.orcaops', 'artifacts', a.artifactId);
    const aLog = path.join(aDir, 'events.ndjson');
    const lines = (await readFile(aLog, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"checkpoint_opened"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(aLog, lines.join('\n'), 'utf8');
    await rm(path.join(aDir, 'checkpoint-1.json'), { force: true });

    const r = await run(['--reconcile', '--json', '--artifact', b.artifactId]);
    expect(r.exitCode).toBe(0);
    // A and B held concurrently-open windows, so B's close carries
    // window_overlap naming A: adjudication survives the rotted sibling
    // by keeping its claims unresolved, and says so.
    expect(r.stderr).toMatch(/could not read sibling artifact/);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.window.total_commits).toBeGreaterThan(0);
  });

  it('plain reconcile fails closed when any artifact on the branch is unreadable', async () => {
    // A's close line rots: under the artifact-level refusal contract
    // its artifact.json read refuses too, so default-artifact
    // RESOLUTION fails closed — the explicit escape is --artifact.
    const a = await capturePlan(1);
    await openCp(a.artifactId, a.stepIds[0]);
    await commitFile(repo.path, 'a-work.ts', 'export const a = 1;\n', 'a cp1 work');
    await closeCp(a.artifactId, 1, ['a-work.ts'], a.stepIds[0]);

    const b = await capturePlan(2);
    await openCp(b.artifactId, b.stepIds[0]);
    await commitFile(repo.path, 'covered.ts', 'export const c = 1;\n', 'b cp1 work');
    await closeCp(b.artifactId, 1, ['covered.ts'], b.stepIds[0]);

    const aDir = path.join(repo.path, '.orcaops', 'artifacts', a.artifactId);
    const aLog = path.join(aDir, 'events.ndjson');
    const lines = (await readFile(aLog, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(aLog, lines.join('\n'), 'utf8');
    await rm(path.join(aDir, 'checkpoint-1.json'), { force: true });

    const r = await run(['--reconcile', '--json']);
    expect(r.exitCode).not.toBe(0);
    const out = JSON.parse(r.stdout) as ErrorEnvelope;
    expect(out.error.message).toContain(a.artifactId);
    expect(out.error.message).toMatch(/unreadable|corrupt/);

    // The explicit --artifact escape works: candidates are scoped to B,
    // so the rotted sibling is outside the read set entirely.
    const scoped = await run(['--reconcile', '--json', '--artifact', b.artifactId]);
    expect(scoped.exitCode).toBe(0);
    const sOut = JSON.parse(scoped.stdout) as Envelope & {
      disclosure: { skipped_unreadable_artifacts: string[] };
    };
    expect(sOut.artifact.id).toBe(b.artifactId);
    expect(sOut.disclosure.skipped_unreadable_artifacts).toEqual([]);
  });

  it('attribution fails closed when a branch artifact is unreadable', async () => {
    const a = await capturePlan(1);
    await openCp(a.artifactId, a.stepIds[0]);
    await commitFile(repo.path, 'a-work.ts', 'export const a = 1;\n', 'a cp1 work');
    await closeCp(a.artifactId, 1, ['a-work.ts'], a.stepIds[0]);

    const b = await capturePlan(2);
    await openCp(b.artifactId, b.stepIds[0]);
    await commitFile(repo.path, 'covered.ts', 'export const c = 1;\n', 'b cp1 work');
    await closeCp(b.artifactId, 1, ['covered.ts'], b.stepIds[0]);

    const aDir = path.join(repo.path, '.orcaops', 'artifacts', a.artifactId);
    const aLog = path.join(aDir, 'events.ndjson');
    const lines = (await readFile(aLog, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(aLog, lines.join('\n'), 'utf8');
    await rm(path.join(aDir, 'checkpoint-1.json'), { force: true });

    const r = await run(['--attribution', '--json']);
    expect(r.exitCode).not.toBe(0);
    const out = JSON.parse(r.stdout) as ErrorEnvelope;
    // Fails closed at default-artifact resolution (the rotted sibling
    // refuses its artifact.json read); the pool guard behind it is
    // pinned at the export surface, which pools without resolution.
    expect(out.error.message).toContain(a.artifactId);
  });

  it('reports a planted in-window commit no checkpoint accounts for', async () => {
    const { artifactId, claimedSha, smuggledSha, covered2Sha } = await artifactWithGapCommit();

    const r = await run(['--reconcile', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;

    expect(out.artifact.id).toBe(artifactId);
    expect(out.artifact.source).toBe('active_artifact');
    expect(out.window.head.source).toBe('latest_closed_checkpoint');
    expect(out.window.head.checkpoint_n).toBe(2);
    expect(out.window.total_commits).toBe(3);
    expect(out.window.covered_commit_count).toBe(2);

    expect(out.window.uncovered_commits).toHaveLength(1);
    const uncovered = out.window.uncovered_commits[0];
    expect(uncovered.sha).toBe(smuggledSha);
    expect(uncovered.uncovered_files).toEqual(['smuggled.ts']);
    expect(uncovered.fully_uncovered).toBe(true);

    const coveredShas = out.window.commits
      .filter((c) => c.uncovered_files.length === 0)
      .map((c) => c.sha);
    expect(coveredShas).toContain(claimedSha);
    expect(coveredShas).toContain(covered2Sha);

    expect(out.post_window_commits).toEqual([]);
    expect(out.disclosure.coverage_basis).toBe('files_changed_and_manifests');
    expect(out.disclosure.no_closed_checkpoints).toBe(false);
  });

  it('neutralizes carriage returns in commit subjects before human rendering', async () => {
    await capturePlan(1);
    await commitFile(
      repo.path,
      'subject-control.ts',
      'export const subjectControl = true;\n',
      'visible subject\rspoofed finding'
    );

    const r = await run(['--reconcile']);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('\r');
    expect(r.stdout).toContain('visible subjectspoofed finding');
  });

  it('lists commits after the last close as post-window, not reconciled', async () => {
    const { smuggledSha } = await artifactWithGapCommit();
    const postSha = await commitFile(
      repo.path,
      'post.ts',
      'export const post = 1;\n',
      'after last close'
    );

    const r = await run(['--reconcile', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;

    expect(out.post_window_commits.map((c) => c.sha)).toEqual([postSha]);
    expect(out.window.commits.map((c) => c.sha)).not.toContain(postSha);
    // The in-window finding is unaffected by the trailing span.
    expect(out.window.uncovered_commits.map((c) => c.sha)).toEqual([smuggledSha]);
    expect(out.window.head.sha).not.toBe(postSha);
  });

  // ── post-last-close, pre-summary commits are a LOUD finding ──────────
  async function captureSummary(artifactId: string): Promise<void> {
    // Note: `capture summary` takes no --no-llm (only --json/--input).
    const r = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: artifactId,
          outcome: 'done',
        })
      ),
    ]);
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
  }

  it('a post-last-close, pre-summary commit is flagged loud in pre_summary', async () => {
    const { artifactId } = await artifactWithGapCommit();
    const preSha = await commitFile(
      repo.path,
      'pre-summary.ts',
      'export const p = 1;\n',
      'after last close, before summary'
    );
    await captureSummary(artifactId);
    const r = await run(['--reconcile', '--artifact', artifactId, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.pre_summary).toBeDefined();
    expect(out.pre_summary?.summary_head_sha).toBe(preSha);
    expect(out.pre_summary?.uncovered_commits.map((c) => c.sha)).toEqual([preSha]);
    // window head stays the last close; nothing spills into the soft span.
    expect(out.window.head.checkpoint_n).toBe(2);
    expect(out.post_window_commits).toEqual([]);
  });

  it('a summary at the window head produces no pre_summary (empty span)', async () => {
    const { artifactId } = await artifactWithGapCommit();
    // No commit since the last close → summary.head_sha == window head.
    await captureSummary(artifactId);
    const r = await run(['--reconcile', '--artifact', artifactId, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.pre_summary).toBeUndefined();
  });

  it('commits after the summary stay in the soft post_window disclosure', async () => {
    const { artifactId } = await artifactWithGapCommit();
    const preSha = await commitFile(
      repo.path,
      'pre-summary.ts',
      'export const p = 1;\n',
      'before summary'
    );
    await captureSummary(artifactId);
    const postSha = await commitFile(
      repo.path,
      'post-summary.ts',
      'export const q = 1;\n',
      'after summary'
    );
    const r = await run(['--reconcile', '--artifact', artifactId, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.pre_summary?.uncovered_commits.map((c) => c.sha)).toEqual([preSha]);
    expect(out.post_window_commits.map((c) => c.sha)).toEqual([postSha]);
  });

  it('a summary head orphaned by divergence falls back to the soft span (isAncestor gate)', async () => {
    const { artifactId } = await artifactWithGapCommit();
    const git = gitClient(repo.path);
    const windowHead = (await git.revparse(['HEAD'])).trim();
    await commitFile(repo.path, 'pre-summary.ts', 'export const p = 1;\n', 'summary commit');
    await captureSummary(artifactId);
    // Diverge: reset to the window head and commit elsewhere → the summary head
    // is still resolvable (dangling) but is NOT an ancestor of HEAD.
    await git.reset(['--hard', windowHead]);
    const divSha = await commitFile(
      repo.path,
      'divergent.ts',
      'export const d = 1;\n',
      'divergent line'
    );
    const r = await run(['--reconcile', '--artifact', artifactId, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.pre_summary).toBeUndefined();
    expect(out.post_window_commits.map((c) => c.sha)).toEqual([divSha]);
  });

  it('an active (un-summarized) artifact has no pre_summary', async () => {
    const { artifactId } = await artifactWithGapCommit();
    const postSha = await commitFile(
      repo.path,
      'post.ts',
      'export const x = 1;\n',
      'after last close'
    );
    const r = await run(['--reconcile', '--artifact', artifactId, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.pre_summary).toBeUndefined();
    expect(out.post_window_commits.map((c) => c.sha)).toEqual([postSha]);
  });

  it('falls back to branch HEAD when no checkpoint has closed, disclosed', async () => {
    await capturePlan(1);
    const straySha = await commitFile(repo.path, 'stray.ts', 'export const s = 1;\n', 'stray');

    const r = await run(['--reconcile', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;

    expect(out.window.head.source).toBe('branch_head_fallback');
    expect(out.window.head.sha).toBe(straySha);
    expect(out.window.head.checkpoint_n).toBeNull();
    expect(out.disclosure.no_closed_checkpoints).toBe(true);
    expect(out.window.uncovered_commits.map((c) => c.sha)).toEqual([straySha]);
    expect(out.window.uncovered_commits[0].fully_uncovered).toBe(true);
    expect(out.post_window_commits).toEqual([]);
  });

  it('honors --artifact override and rejects unknown ids', async () => {
    const { artifactId, smuggledSha } = await artifactWithGapCommit();

    const r = await run(['--reconcile', '--artifact', artifactId, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.artifact.source).toBe('flag');
    expect(out.window.uncovered_commits.map((c) => c.sha)).toEqual([smuggledSha]);

    const bad = await run(['--reconcile', '--artifact', 'no-such-artifact', '--json']);
    expect(bad.exitCode).toBe(1);
    const err = JSON.parse(bad.stdout) as ErrorEnvelope;
    expect(err.error.code).toBe('UNKNOWN_ARTIFACT');
  });

  it('degrades to files_changed-only coverage without manifests, disclosed', async () => {
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const existing = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({ ...existing, diff_fingerprint: { enabled: false } }, null, 2),
      'utf8'
    );

    const { artifactId, stepIds } = await capturePlan(1);
    await openCp(artifactId, stepIds[0]);
    const claimedSha = await commitFile(
      repo.path,
      'claimed.ts',
      'export const a = 1;\n',
      'claimed'
    );
    // In-fence but unclaimed: with manifests a whole-window diff would
    // cover it; under files_changed-only coverage it must surface.
    const underSha = await commitFile(
      repo.path,
      'under.ts',
      'export const under = 1;\n',
      'under-reported'
    );
    await closeCp(artifactId, 1, ['claimed.ts'], stepIds[0]);

    const r = await run(['--reconcile', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;

    expect(out.disclosure.coverage_basis).toBe('files_changed_only');
    expect(out.disclosure.manifestless_checkpoints).toHaveLength(1);
    expect(out.window.uncovered_commits.map((c) => c.sha)).toEqual([underSha]);
    expect(out.window.uncovered_commits[0].uncovered_files).toEqual(['under.ts']);
    expect(out.window.commits.find((c) => c.sha === claimedSha)?.uncovered_files).toEqual([]);
  });

  it('rejects --attribution together with --reconcile', async () => {
    await artifactWithGapCommit();
    const r = await run(['--attribution', '--reconcile', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as ErrorEnvelope;
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toContain('mutually exclusive');
  });

  it('rejects attribution-only flags under --reconcile', async () => {
    await artifactWithGapCommit();
    const r = await run(['--reconcile', '--base', 'HEAD', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as ErrorEnvelope;
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toContain('--attribution only');
  });

  it('requires an artifact on the branch', async () => {
    const r = await run(['--reconcile', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as ErrorEnvelope;
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toContain('--artifact');
  });

  it('errors — never reads clean — when the artifact base_sha is unresolvable', async () => {
    // Plan captured at C2; rewinding to C1 and pruning makes the
    // recorded base_sha unreachable (history rewrite). The audit must
    // hard-error: an empty window here would be a lie.
    const git = gitClient(repo.path);
    const c1 = (await git.revparse(['HEAD'])).trim();
    await commitFile(repo.path, 'seed.ts', 'export const seed = 1;\n', 'base commit');
    await capturePlan(1);
    await git.raw(['reset', '--hard', c1]);
    await git.raw(['reflog', 'expire', '--expire=now', '--all']);
    await git.raw(['gc', '--prune=now']);

    const r = await run(['--reconcile', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as ErrorEnvelope;
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toMatch(/base .*does not resolve/i);
    expect(err.error.message).toContain('refusing');
  });

  it('errors — never reads clean — when a closed checkpoint head_sha is unresolvable', async () => {
    const git = gitClient(repo.path);
    const c1 = (await git.revparse(['HEAD'])).trim();
    const { artifactId, stepIds } = await capturePlan(1);
    await openCp(artifactId, stepIds[0]);
    await commitFile(repo.path, 'work.ts', 'export const w = 1;\n', 'cp work');
    await closeCp(artifactId, 1, ['work.ts'], stepIds[0]);
    await git.raw(['reset', '--hard', c1]);
    await git.raw(['reflog', 'expire', '--expire=now', '--all']);
    await git.raw(['gc', '--prune=now']);

    const r = await run(['--reconcile', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as ErrorEnvelope;
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toMatch(/head_sha .*does not resolve/i);
    expect(err.error.message).toContain('refusing');
  });
});
