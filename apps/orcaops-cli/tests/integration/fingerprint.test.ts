import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile, effectiveConfigPath } from '../support/test-helpers.js';

/**
 * `orcaops fingerprint show` CLI command.
 *
 * Covers: inline-manifest load, sidecar-spilled-manifest load, the
 * `status:'empty'` (real manifest, hunks:[]) case, the deliberate-skip
 * (`manifest_hash:null`, exit 0) case, the strict-sync missing-manifest
 * integrity case (`manifest_hash` non-null but manifest unloadable →
 * distinct `EVENT_LOG_CORRUPT` error, nonzero exit), unknown
 * artifact/checkpoint, and the never-print-raw-code output guard.
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

describe('orcaops fingerprint show', () => {
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
    // Drain disabled so capture runs with no cloud I/O; snapshot capture is on by
    // default (auth-independent).
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
          task: 'fingerprint show test',
          label: 'fingerprint-show',
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

  async function disableFingerprint(): Promise<void> {
    const cfgPath = await effectiveConfigPath(repo.path);
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    cfg.diff_fingerprint = { enabled: false, max_diff_bytes: 2_000_000 };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  function show(artifactId: string, n: number | string, json = true): Promise<CliResult> {
    const args = ['fingerprint', 'show', '--artifact', artifactId, '--checkpoint', String(n)];
    if (json) args.push('--json');
    return agent.runRaw(args);
  }

  it('renders an inline-manifest captured cp (--json)', async () => {
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);
    await commitFile(repo.path, 'src/foo.ts', 'export const x = 1;\nexport const y = 2;\n', 'foo');
    await closeCp(plan.artifact_id, plan.step_ids[0]);

    const out = parseOk<
      OkEnvelope & {
        summary: { status: string; hunk_count: number; manifest_hash: string };
        manifest: { hunks: unknown[] };
      }
    >(await show(plan.artifact_id, 1));
    expect(out.summary.status).toBe('captured');
    expect(out.summary.manifest_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.manifest.hunks.length).toBe(out.summary.hunk_count);
    expect(out.summary.hunk_count).toBeGreaterThan(0);
    assertNoRawText(out, JSON.stringify(out));
  });

  it('renders an empty cp: real manifest, hunks:[], non-null manifest_hash', async () => {
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);
    await closeCp(plan.artifact_id, plan.step_ids[0]); // no work

    const out = parseOk<
      OkEnvelope & {
        summary: { status: string; manifest_hash: string };
        manifest: { hunks: unknown[] };
      }
    >(await show(plan.artifact_id, 1));
    expect(out.summary.status).toBe('empty');
    expect(out.summary.manifest_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.manifest.hunks).toEqual([]);
  });

  it('renders a deliberately-skipped cp (manifest_hash null) and exits 0', async () => {
    await disableFingerprint();
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);
    await commitFile(repo.path, 'src/foo.ts', 'export const x = 1;\n', 'foo');
    await closeCp(plan.artifact_id, plan.step_ids[0]);

    const out = parseOk<
      OkEnvelope & { summary: { status: string; manifest_hash: null }; manifest: null }
    >(await show(plan.artifact_id, 1));
    expect(out.summary.status).toBe('skipped');
    expect(out.summary.manifest_hash).toBeNull();
    expect(out.manifest).toBeNull();

    // Human mode also exits 0 and prints "(none captured)" / no raw text.
    const human = await show(plan.artifact_id, 1, false);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('(none captured)');
    assertNoRawText(null, human.stdout);
  });

  it('loads a sidecar-spilled manifest (large diff) the same as inline', async () => {
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);
    // ~1500 distinct lines on a new file → one big hunk → manifest with
    // ~1500 line hashes → checkpoint_closed payload exceeds the 8 KB
    // inline budget → spills to sidecars/<event_id>.json.
    const big = Array.from({ length: 1500 }, (_, i) => `line ${i} alpha bravo charlie\n`).join('');
    await commitFile(repo.path, 'src/big.ts', big, 'big');
    await closeCp(plan.artifact_id, plan.step_ids[0]);

    // Confirm it actually spilled (otherwise the next test's premise is moot).
    const sidecarsDir = path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id, 'sidecars');
    const sidecars = await readdir(sidecarsDir);
    expect(sidecars.length).toBeGreaterThan(0);

    const out = parseOk<
      OkEnvelope & { summary: { status: string }; manifest: { hunks: unknown[] } }
    >(await show(plan.artifact_id, 1));
    expect(out.summary.status).toBe('captured');
    expect(out.manifest.hunks.length).toBeGreaterThan(0);
    assertNoRawText(out, JSON.stringify(out));
  });

  it('refuses the fingerprint read on a corrupt sidecar — artifact-level, doctor-diagnosable', async () => {
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);
    const big = Array.from({ length: 1500 }, (_, i) => `line ${i} alpha bravo charlie\n`).join('');
    await commitFile(repo.path, 'src/big.ts', big, 'big');
    await closeCp(plan.artifact_id, plan.step_ids[0]);

    // Corrupt the spilled manifest sidecar: a sidecar-corrupt event IS
    // non-tail loss, so the artifact-level contract refuses the read
    // itself — still distinct, loud, and doctor-diagnosable.
    const sidecarsDir = path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id, 'sidecars');
    for (const f of await readdir(sidecarsDir)) {
      await writeFile(path.join(sidecarsDir, f), 'CORRUPTED-NOT-JSON', 'utf8');
    }

    const r = await show(plan.artifact_id, 1);
    const err = parseErr(r);
    expect(err.error.message).toMatch(/corrupt event-log line|unreadable/);
    expect(err.error.message).toMatch(/orcaops doctor/);
  });

  it('errors on unknown artifact and unknown checkpoint', async () => {
    const plan = await capturePlan();
    await openCp(plan.artifact_id, plan.step_ids[0]);
    await commitFile(repo.path, 'src/foo.ts', 'export const x = 1;\n', 'foo');
    await closeCp(plan.artifact_id, plan.step_ids[0]);

    const unknownArt = parseErr(await show('019e0000-0000-7000-8000-000000000000', 1));
    expect(unknownArt.error.code).toBe('UNKNOWN_ARTIFACT');

    const unknownCp = parseErr(await show(plan.artifact_id, 9));
    expect(unknownCp.error.code).toBe('INVALID_INPUT');
    expect(unknownCp.error.path).toBe('checkpoint');
  });
});
