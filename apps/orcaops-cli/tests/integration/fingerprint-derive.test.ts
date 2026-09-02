import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops fingerprint derive`.
 *
 * Recomputes a closed checkpoint's manifest from its pinned snapshot trees
 * and verifies it against the capture-time `manifest_hash`. Output-only:
 * nothing is persisted (no store writes, no cache).
 *
 * The whole suite runs LOGGED OUT (no `seedCloudLogin`): capture is
 * auth-independent, so derive working here doubles as logged-out coverage.
 *
 * Covers: verified-true round trip, cap-change mismatch (verified false +
 * truncation note), deliberate-skip error (no derivable trees), open-cp
 * error, unknown artifact/checkpoint, pruned-refs unreachable-tree error,
 * and the never-print-raw-code output guard in both modes.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OkEnvelope {
  ok: true;
  [k: string]: unknown;
}

function parseOk<T = OkEnvelope>(r: CliResult): T {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed as T;
}

interface ErrEnvelope {
  ok: false;
  error: { code: string; message: string; path?: string };
}

function parseErr(r: CliResult): ErrEnvelope {
  expect(r.exitCode).toBe(1);
  const parsed = JSON.parse(r.stdout) as ErrEnvelope;
  expect(parsed.ok).toBe(false);
  return parsed;
}

interface CapturedPlan {
  artifact_id: string;
  step_ids: string[];
}

const FORBIDDEN_KEYS = new Set([
  'diff',
  'patch',
  'diff_text',
  'patch_text',
  'raw_diff',
  'raw_patch',
]);

function assertNoRawText(envelopeOrText: unknown, stringified: string): void {
  function visit(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      expect(FORBIDDEN_KEYS.has(k), `forbidden key "${k}"`).toBe(false);
      visit(v);
    }
  }
  visit(envelopeOrText);
  expect(stringified).not.toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  expect(stringified).not.toContain('--- a/');
  expect(stringified).not.toContain('+++ b/');
}

interface DeriveOk extends OkEnvelope {
  source: string;
  open_tree_sha: string;
  close_tree_sha: string;
  stored: { status: string; manifest_hash: string | null; truncated: boolean };
  derived: { status: string; manifest_hash: string | null; truncated: boolean };
  verified: boolean | null;
  note?: string;
}

describe('orcaops fingerprint derive', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    // Drain disabled so capture runs with no cloud I/O; snapshot capture is on
    // by default (auth-independent) — deliberately no login.
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function capturePlan(): Promise<CapturedPlan> {
    const r = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'fingerprint derive test',
          label: 'fingerprint-derive',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const ok = parseOk<
      OkEnvelope & { artifact_id: string; plan_steps: Array<{ step_id: string }> }
    >(r);
    return { artifact_id: ok.artifact_id, step_ids: ok.plan_steps.map((s) => s.step_id) };
  }

  async function openCp(artifactId: string, stepId: string): Promise<void> {
    parseOk(
      await agent.runRaw([
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
      ])
    );
  }

  async function closeCp(artifactId: string, stepId: string): Promise<void> {
    parseOk(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `close-${randomUUID()}`,
            artifact_id: artifactId,
            n: 1,
            summary: 'cp1',
            files_changed: [],
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [stepId],
          })
        ),
      ])
    );
  }

  /** Plan → open → commit real work → close: a captured cp with a manifest. */
  async function capturedCp(): Promise<CapturedPlan> {
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);
    await commitFile(
      repo.path,
      'src/foo.ts',
      'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n',
      'add foo'
    );
    await closeCp(plan.artifact_id, plan.step_ids[0]);
    return plan;
  }

  async function setMaxDiffBytes(maxDiffBytes: number): Promise<void> {
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    cfg.diff_fingerprint = { enabled: true, max_diff_bytes: maxDiffBytes };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  async function disableFingerprint(): Promise<void> {
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    cfg.diff_fingerprint = { enabled: false, max_diff_bytes: 2_000_000 };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  function derive(artifactId: string, n: number | string, json = true): Promise<CliResult> {
    const args = ['fingerprint', 'derive', '--artifact', artifactId, '--checkpoint', String(n)];
    if (json) args.push('--json');
    return agent.runRaw(args);
  }

  it('verified: true — recomputation reproduces the stored manifest_hash (logged out)', async () => {
    const plan = await capturedCp();

    const out = parseOk<DeriveOk>(await derive(plan.artifact_id, 1));
    expect(out.verified).toBe(true);
    expect(out.source).toBe('stored_manifest_trees');
    expect(out.stored.status).toBe('captured');
    expect(out.derived.status).toBe('captured');
    expect(out.derived.manifest_hash).toBe(out.stored.manifest_hash);
    expect(out.stored.manifest_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.note).toBeUndefined();
    assertNoRawText(out, JSON.stringify(out));
  });

  it('verified: true on an empty-fence cp (hunks:[] manifest reproduces)', async () => {
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);
    await closeCp(plan.artifact_id, plan.step_ids[0]); // no work

    const out = parseOk<DeriveOk>(await derive(plan.artifact_id, 1));
    expect(out.stored.status).toBe('empty');
    expect(out.derived.status).toBe('empty');
    expect(out.verified).toBe(true);
  });

  it('cap change since capture → verified: false with a truncation-mismatch note', async () => {
    const plan = await capturedCp();
    // Shrink the cap far below the captured diff size: the re-derived diff
    // truncates where the stored one did not → hashes cannot match.
    await setMaxDiffBytes(64);

    const out = parseOk<DeriveOk>(await derive(plan.artifact_id, 1));
    expect(out.verified).toBe(false);
    expect(out.stored.truncated).toBe(false);
    expect(out.derived.truncated).toBe(true);
    expect(out.note).toMatch(/max_diff_bytes/);
    assertNoRawText(out, JSON.stringify(out));
  });

  it('deliberately-skipped capture (config disabled) → INVALID_INPUT with the skip reason', async () => {
    await disableFingerprint();
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);
    await commitFile(repo.path, 'src/foo.ts', 'export const x = 1;\n', 'foo');
    await closeCp(plan.artifact_id, plan.step_ids[0]);

    const err = parseErr(await derive(plan.artifact_id, 1));
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toMatch(/no derivable trees/);
    expect(err.error.message).toMatch(/skipped/);
  });

  it('open checkpoint → INVALID_INPUT (only closed cps have capture-time trees)', async () => {
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);

    const err = parseErr(await derive(plan.artifact_id, 1));
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toMatch(/is open, not closed/);
  });

  it('unknown artifact / unknown checkpoint error distinctly', async () => {
    const plan = await capturePlan();

    const unknownArtifact = parseErr(await derive('01890000-0000-7000-8000-000000000000', 1));
    expect(unknownArtifact.error.code).toBe('UNKNOWN_ARTIFACT');

    const unknownCp = parseErr(await derive(plan.artifact_id, 9));
    expect(unknownCp.error.code).toBe('INVALID_INPUT');
    expect(unknownCp.error.message).toMatch(/No checkpoint #9/);
  });

  it('pruned snapshot refs → unreachable-trees error pointing at the prune', async () => {
    const plan = await capturedCp();

    // Drop every snapshot ref for the artifact, then aggressively gc so the
    // now-unreachable tree objects are actually deleted from the odb.
    parseOk(
      await agent.runRaw([
        'snapshots',
        'prune',
        '--artifact',
        plan.artifact_id,
        '--apply',
        '--json',
      ])
    );
    execFileSync(
      'git',
      [
        '-c',
        'gc.reflogExpire=now',
        '-c',
        'gc.reflogExpireUnreachable=now',
        'gc',
        '--prune=now',
        '--quiet',
      ],
      { cwd: repo.path }
    );

    const err = parseErr(await derive(plan.artifact_id, 1));
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toMatch(/unreachable/);
    expect(err.error.message).toMatch(/prune/);
  });

  it('human mode exits 0, prints the verdict, and never leaks raw diff text', async () => {
    const plan = await capturedCp();

    const human = await derive(plan.artifact_id, 1, false);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('verified:        true');
    expect(human.stdout).toContain('tree source:');
    assertNoRawText(null, human.stdout);
  });
});
