import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile, effectiveConfigPath } from '../support/test-helpers.js';

/**
 * `orcaops diff --attribution`.
 *
 * Covers: hunk-level attribution against stored manifests with the
 * default (active-artifact) base, unattributed detection +
 * `--unattributed`, explicit `--base`, the no-artifact hard-require,
 * the reserved plain `orcaops diff`, and file-level degradation when
 * fingerprints are disabled.
 *
 * Also covers the amended base precedence (`--base` → `--artifact` →
 * active → recent) over two SUMMARIZED artifacts on one branch, plus
 * `manifest_scope` disclosure and reconcile's unchanged `source: 'flag'`.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Envelope {
  base: { ref: string; sha: string; source: string };
  manifest_scope: { kind: 'artifact'; artifact_id: string } | { kind: 'branch'; branch: string };
  target: { kind: string };
  attribution_granularity: string;
  hunks?: Array<{
    file: string | null;
    matches: Array<{ artifact_id: string; checkpoint_n: number; match: string }>;
    ambiguous: boolean;
  }> | null;
  unattributed: Array<{ file: string | null }> | null;
  coverage: {
    total_hunks: number;
    attributed_hunks: number;
    unattributed_hunks: number;
  } | null;
  file_attributions?: Array<{ artifact_id: string; checkpoint_n: number; files: string[] }>;
  checkpoint_granularity: Record<string, string>;
  disclosure: { manifestless_checkpoints: Array<{ checkpoint_n: number }> };
}

describe('orcaops diff --attribution', () => {
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

  /** Plan + one closed cp whose work is `attributed.ts`. */
  async function artifactWithWork(): Promise<string> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'attribution fixture',
          label: `attr-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    await commitFile(
      repo.path,
      'attributed.ts',
      'export function capturedByCheckpoint(): number {\n  return 42;\n}\n',
      'cp1 work'
    );
    const close = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1',
          files_changed: ['attributed.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    expect(close.exitCode).toBe(0);
    return plan.artifact_id;
  }

  function run(args: string[]): Promise<CliResult> {
    return agent.runRaw(['diff', ...args]);
  }

  it('attributes checkpoint work at hunk level with the active-artifact default base', async () => {
    const artifactId = await artifactWithWork();
    // Stray uncommitted work no checkpoint accounts for.
    await writeFile(
      path.join(repo.path, 'stray.ts'),
      'export function neverCheckpointed(): string {\n  return "stray";\n}\n',
      'utf8'
    );

    const r = await run(['--attribution', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;

    expect(out.base.source).toBe('active_artifact');
    expect(out.base.ref).toBe(`artifact:${artifactId}`);
    expect(out.target.kind).toBe('worktree');
    expect(out.attribution_granularity).toBe('hunk');
    expect(out.checkpoint_granularity[`${artifactId}:1`]).toBe('hunk');

    const attributedHunk = out.hunks?.find((h) => h.file === 'attributed.ts');
    expect(attributedHunk?.matches[0]).toMatchObject({
      artifact_id: artifactId,
      checkpoint_n: 1,
      match: 'exact',
    });
    expect(out.unattributed?.map((h) => h.file)).toContain('stray.ts');
    expect(out.coverage?.attributed_hunks).toBeGreaterThanOrEqual(1);
    expect(out.coverage?.unattributed_hunks).toBeGreaterThanOrEqual(1);
  });

  it('--unattributed reports only the unaccounted hunks', async () => {
    await artifactWithWork();
    await writeFile(
      path.join(repo.path, 'stray.ts'),
      'export function neverCheckpointed(): string {\n  return "stray";\n}\n',
      'utf8'
    );

    const r = await run(['--attribution', '--unattributed', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.hunks).toBeUndefined();
    expect(out.unattributed?.map((h) => h.file)).toContain('stray.ts');
    expect(out.unattributed?.map((h) => h.file)).not.toContain('attributed.ts');
  });

  it('honors an explicit --base ref', async () => {
    await artifactWithWork();
    const r = await run(['--attribution', '--base', 'HEAD', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.base.source).toBe('flag');
    // HEAD already contains the committed cp work, so it is out of the
    // diff. (The worktree tree still carries uncommitted `.orcaops/`
    // files from init — those appear as unattributed hunks, correctly.)
    expect(out.coverage?.attributed_hunks).toBe(0);
    expect(out.hunks?.some((h) => h.file === 'attributed.ts')).toBe(false);
  });

  it('hard-requires --base when the branch has no artifacts', async () => {
    const r = await run(['--attribution', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toContain('--base');
  });

  it('reserves plain `orcaops diff` with guidance', async () => {
    const r = await run(['--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toContain('--attribution');
  });

  it('degrades to file-level attribution when checkpoints have no manifests', async () => {
    const configPath = await effectiveConfigPath(repo.path);
    const existing = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({ ...existing, diff_fingerprint: { enabled: false } }, null, 2),
      'utf8'
    );
    const artifactId = await artifactWithWork();

    const r = await run(['--attribution', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    expect(out.attribution_granularity).toBe('file');
    expect(out.checkpoint_granularity[`${artifactId}:1`]).toBe('file');
    expect(out.coverage).toBeNull();
    expect(out.file_attributions).toEqual([
      { artifact_id: artifactId, checkpoint_n: 1, files: ['attributed.ts'] },
    ]);
    expect(out.disclosure.manifestless_checkpoints).toHaveLength(1);
  });

  // ── Explicit --artifact controls the base ─────────────────────────────
  //
  // Regression cover for a real hazard: two SUMMARIZED artifacts on one
  // branch. The in-flight tier finds nothing, so unless `--artifact` also
  // fixes the base, resolution falls through to `listArtifacts` ordered by
  // started_at DESC and the newest wins even when the caller named the
  // older one — a read-only review artifact silently becoming the
  // attribution base for the work it reviewed, undisclosed in the envelope.

  async function summarize(artifactId: string): Promise<void> {
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

  /** Two summarized artifacts on one branch; returns [older, newer]. */
  async function twoSummarizedArtifacts(): Promise<[string, string]> {
    const older = await artifactWithWork();
    await summarize(older);
    const newer = await artifactWithWork();
    await summarize(newer);
    expect(older).not.toBe(newer);
    return [older, newer];
  }

  it('--artifact supplies the base, overriding recency', async () => {
    const [older, newer] = await twoSummarizedArtifacts();

    const explicit = await run(['--attribution', '--artifact', older, '--json']);
    expect(explicit.exitCode).toBe(0);
    const out = JSON.parse(explicit.stdout) as Envelope;
    expect(out.base.ref).toBe(`artifact:${older}`);
    expect(out.base.source).toBe('artifact_flag');
    expect(out.manifest_scope).toEqual({ kind: 'artifact', artifact_id: older });

    // Without the flag, recency still governs — the newer artifact wins.
    const dflt = await run(['--attribution', '--json']);
    expect(dflt.exitCode).toBe(0);
    const outDefault = JSON.parse(dflt.stdout) as Envelope;
    expect(outDefault.base.ref).toBe(`artifact:${newer}`);
    expect(outDefault.base.source).toBe('recent_artifact');
    expect(outDefault.manifest_scope).toEqual({ kind: 'branch', branch: 'main' });
  }, 60_000);

  it('--base beats --artifact and reports source flag, not artifact_flag', async () => {
    const [older] = await twoSummarizedArtifacts();
    const r = await run(['--attribution', '--artifact', older, '--base', 'HEAD~1', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Envelope;
    // --base is the more specific instruction, so it wins outright...
    expect(out.base.ref).toBe('HEAD~1');
    expect(out.base.source).toBe('flag');
    // ...while --artifact still scopes manifest sourcing, as it always did.
    expect(out.manifest_scope).toEqual({ kind: 'artifact', artifact_id: older });
  }, 60_000);

  it('rejects an unknown --artifact id with UNKNOWN_ARTIFACT', async () => {
    await artifactWithWork();
    const r = await run(['--attribution', '--artifact', 'doesnotexist', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('UNKNOWN_ARTIFACT');
    expect(err.error.message).toContain('doesnotexist');
  }, 30_000);

  it('reconcile keeps reporting an explicit --artifact as source flag (unchanged)', async () => {
    // Reconcile already resolved --artifact in its own branch and is untouched
    // by the attribution change. Pinned so its public source value cannot drift
    // to artifact_flag as an incidental side effect of a shared refactor.
    const [older] = await twoSummarizedArtifacts();
    const r = await run(['--reconcile', '--artifact', older, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { artifact: { id: string; source: string } };
    expect(out.artifact.id).toBe(older);
    expect(out.artifact.source).toBe('flag');
  }, 60_000);
});
