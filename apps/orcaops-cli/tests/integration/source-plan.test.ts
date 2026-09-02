import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  artifactPathsFor,
  getDefaultConfig,
  sourcePlanCacheDir,
  writePullCacheRecord,
} from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { cloudRecord } from '../support/source-plan-test-helpers.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * `--source-plan <ref>` reads + hashes a local plan file and
 * pins it immutably onto the artifact (projected onto artifact.json).
 * Opt-in: absent → source_plan stays null. A missing file fails loud
 * BEFORE any idempotency / artifact state is committed.
 */
describe('capture plan --source-plan', () => {
  let repo: TempRepo;
  let inputDir: string;
  let agent: ReturnType<typeof makeAgent>;

  const planJson = (key: string) =>
    JSON.stringify({
      idempotency_key: key,
      task: 'thing under a pinned plan',
      label: 'pinned-plan-thing',
      plan_steps: [{ text: 's1', label: 's1' }],
      touched_scope: [],
    });

  async function readArtifactJson(artifactId: string): Promise<Record<string, unknown>> {
    const paths = artifactPathsFor(repo.path, getDefaultConfig(), artifactId);
    return JSON.parse(await readFile(paths.artifactJson, 'utf8')) as Record<string, unknown>;
  }

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    inputDir = await mkdtemp(path.join(tmpdir(), 'orcaops-srcplan-'));
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('plan upload rejects a dirty body locally, before any credential or network work', async () => {
    const planFile = path.join(inputDir, 'dirty-plan.md');
    // U+0085 — the C1 byte the wire policy forbids. No cloud credentials
    // exist in this harness, so reaching the network would surface an
    // auth/connection error instead of the promised local code-point one.
    await writeFile(planFile, '# Plan\n\nbody\u0085tail\n', 'utf8');

    const res = await agent.runRaw(['plan', 'upload', planFile, '--title', 'Dirty', '--json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout + res.stderr).toContain('U+0085 at offset 12');
  });

  it('pins the source plan content + hash onto artifact.json', async () => {
    const planFile = path.join(inputDir, 'slice-plan.md');
    const content = '# Demo plan\n\n- pin source plan\n- structured non_goals\n';
    await writeFile(planFile, content, 'utf8');

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      inputFile(planJson('k-src-1')),
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as { ok: boolean; artifact_id: string };
    expect(out.ok).toBe(true);

    const artifact = await readArtifactJson(out.artifact_id);
    const pin = artifact.source_plan as {
      content: string;
      hash: string;
      source_ref: { kind: string; locator: string };
      baseline: { repo_url: string | null; branch: string | null; head_sha: string | null };
    };
    expect(pin).not.toBeNull();
    expect(pin.content).toBe(content);
    // The hash is a content-integrity anchor (the plan-conformance evaluator
    // relies on it), so assert the real sha256 of the pinned content — not
    // just its hex shape.
    const expectedHash = createHash('sha256').update(content, 'utf8').digest('hex');
    expect(pin.hash).toBe(expectedHash);
    expect(pin.source_ref).toEqual({ kind: 'local', locator: planFile });
    // A LOCAL pin freezes the authoring baseline at capture: the temp repo
    // has no remote (repo_url null) and the memoized HEAD read makes the
    // frozen head_sha exactly the sha the artifact was created at.
    const lineage = artifact.branch_lineage as Array<{ branch: string; head_sha: string }>;
    expect(pin.baseline).toEqual({
      repo_url: null,
      branch: 'main',
      head_sha: lineage[0]!.head_sha,
    });
  });

  it('captures a cloud-ref pin with baseline null (local pins only)', async () => {
    await writePullCacheRecord(sourcePlanCacheDir(repo.path), cloudRecord());

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(planJson('k-src-cloud-1')),
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as { ok: boolean; artifact_id: string };
    expect(out.ok).toBe(true);

    const artifact = await readArtifactJson(out.artifact_id);
    const pin = artifact.source_plan as { source_ref: { kind: string }; baseline: unknown };
    // The authoring baseline of a cloud plan already lives cloud-side from
    // `plan upload`; capture must NOT stamp local git state onto it.
    expect(pin.source_ref.kind).toBe('cloud');
    expect(pin.baseline).toBeNull();
  });

  it('leaves source_plan null when --source-plan is omitted (opt-in no-op)', async () => {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planJson('k-src-2')),
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as { artifact_id: string };
    const artifact = await readArtifactJson(out.artifact_id);
    expect(artifact.source_plan).toBeNull();
  });

  it('fails loud (NO_INPUT) on a missing --source-plan file and leaves NO state behind', async () => {
    const missing = path.join(inputDir, 'never-existed.md');
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      missing,
      '--input',
      inputFile(planJson('k-src-3')),
    ]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; path?: string } };
    expect(env.error.code).toBe('NO_INPUT');
    expect(env.error.path).toBe('source-plan');

    // Regression: resolution runs BEFORE lookupOrInsertPlanIdempotency,
    // so the failed attempt must not have committed an idempotency row.
    // Re-capturing with the SAME key therefore CREATES a fresh artifact
    // (a 'replay' here would prove a dangling row was left behind).
    const retry = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planJson('k-src-3')),
    ]);
    expect(retry.exitCode).toBe(0);
    const out = JSON.parse(retry.stdout) as { idempotency_status: string };
    expect(out.idempotency_status).toBe('created');
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   \n\t\n'],
  ])(
    'fails loud (NO_INPUT) on a %s --source-plan file and leaves NO state behind',
    async (kind, blankContent) => {
      const blankFile = path.join(inputDir, `blank-${kind}.md`);
      await writeFile(blankFile, blankContent, 'utf8');

      const key = `k-blank-${kind}`;
      const res = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--source-plan',
        blankFile,
        '--input',
        inputFile(planJson(key)),
      ]);
      expect(res.exitCode).toBe(1);
      const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; path?: string } };
      expect(env.error.code).toBe('NO_INPUT');
      expect(env.error.path).toBe('source-plan');

      // Same regression guard as the missing-file case: the blank pin is
      // rejected BEFORE any idempotency row is committed, so re-capturing
      // with the same key creates a fresh artifact rather than replaying.
      const retry = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(planJson(key)),
      ]);
      expect(retry.exitCode).toBe(0);
      const out = JSON.parse(retry.stdout) as { idempotency_status: string };
      expect(out.idempotency_status).toBe('created');
    }
  );

  // ── Response echo (pin observability) ──────────────────────────────
  // The capture RESPONSE echoes a content-free source_plan view, so the
  // caller confirms the pin attached in the same breath as ok:true — no
  // follow-up `show` needed, and a real cloud pin never looks like a
  // silent no-op.
  it('echoes the content-free cloud source_plan in the capture response', async () => {
    await writePullCacheRecord(sourcePlanCacheDir(repo.path), cloudRecord());
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(planJson('k-echo-cloud')),
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      source_plan: {
        pinned: boolean;
        source_ref: { kind: string; locator: string; version: string };
        hash: string;
        content?: unknown;
      };
    };
    expect(out.source_plan.pinned).toBe(true);
    expect(out.source_plan.source_ref).toMatchObject({
      kind: 'cloud',
      locator: 'ext-1',
      version: '3',
    });
    expect(typeof out.source_plan.hash).toBe('string');
    // Content-free: the full pinned body must never ride the response.
    expect('content' in out.source_plan).toBe(false);
  });

  it('echoes the content-free local source_plan in the capture response', async () => {
    const planFile = path.join(inputDir, 'echo-local.md');
    await writeFile(planFile, '# local anchor\n\nbody\n', 'utf8');
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      inputFile(planJson('k-echo-local')),
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      source_plan: { pinned: boolean; source_ref: Record<string, unknown>; content?: unknown };
    };
    expect(out.source_plan.pinned).toBe(true);
    expect(out.source_plan.source_ref).toEqual({ kind: 'local', locator: planFile });
    expect('content' in out.source_plan).toBe(false);
  });

  it('echoes source_plan: null when --source-plan is omitted', async () => {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planJson('k-echo-null')),
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as { source_plan: unknown };
    expect(out.source_plan).toBeNull();
  });

  it('omits source_plan on an idempotent replay (the replay arm never re-pins)', async () => {
    const key = 'k-echo-replay';
    const first = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planJson(key)),
    ]);
    expect(first.exitCode).toBe(0);
    const replay = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planJson(key)),
    ]);
    expect(replay.exitCode).toBe(0);
    const out = JSON.parse(replay.stdout) as { idempotency_status: string };
    expect(out.idempotency_status).toBe('replay');
    expect('source_plan' in out).toBe(false);
  });
});
