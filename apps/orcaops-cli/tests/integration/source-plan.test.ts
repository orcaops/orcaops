import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { openProjectDatabase, readProjectArtifact } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { createDatabasePlanPullPersistence } from '../../src/lib/database-source-plan-pull.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { cloudRecord } from '../support/source-plan-test-helpers.js';
import { makeAgent } from '../support/test-agent.js';

describe('capture plan --source-plan', { timeout: 60_000 }, () => {
  let f: Awaited<ReturnType<typeof fixture>>;
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

  function readArtifact(artifactId: string): Record<string, unknown> {
    return readProjectArtifact(f.writer, artifactId)!.thread.artifactJson!;
  }

  async function retainApprovedPlan() {
    const persistence = createDatabasePlanPullPersistence({
      reader: f.writer,
      target: { server_url: 'https://cloud.example', org_id: 'org_1', account_id: 'account_1' },
      secretAllow: [],
      openWriter: () => openProjectDatabase({ authority: f.authority, mode: 'writer' }),
    });
    await persistence.writeRecord(cloudRecord());
  }

  beforeEach(async () => {
    f = await fixture();
    inputDir = f.temporary;
    agent = makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
  });

  it('plan upload rejects a dirty body locally, before any credential or network work', async () => {
    const planFile = path.join(inputDir, 'dirty-plan.md');
    await writeFile(planFile, '# Plan\n\nbody\u0085tail\n', 'utf8');

    const res = await agent.runRaw(['plan', 'upload', planFile, '--title', 'Dirty', '--json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout + res.stderr).toContain('U+0085 at offset 12');
  });

  it('retains the source plan content and hash on the captured artifact', async () => {
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

    const artifact = readArtifact(out.artifact_id);
    const pin = artifact.source_plan as {
      content: string;
      hash: string;
      source_ref: { kind: string; locator: string };
      baseline: { repo_url: string | null; branch: string | null; head_sha: string | null };
    };
    expect(pin).not.toBeNull();
    expect(pin.content).toBe(content);
    const expectedHash = createHash('sha256').update(content, 'utf8').digest('hex');
    expect(pin.hash).toBe(expectedHash);
    expect(pin.source_ref).toEqual({ kind: 'local', locator: planFile });
    const lineage = artifact.branch_lineage as Array<{ branch: string; head_sha: string }>;
    expect(pin.baseline).toEqual({
      repo_url: null,
      branch: 'main',
      head_sha: lineage[0]!.head_sha,
    });
  });

  it('captures a cloud-ref pin with baseline null (local pins only)', async () => {
    await retainApprovedPlan();

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

    const artifact = readArtifact(out.artifact_id);
    const pin = artifact.source_plan as { source_ref: { kind: string }; baseline: unknown };
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
    const artifact = readArtifact(out.artifact_id);
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

  it('echoes the content-free cloud source_plan in the capture response', async () => {
    await retainApprovedPlan();
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

  it('returns the retained content-free pin on replay without changing history', async () => {
    await retainApprovedPlan();
    const args = [
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(planJson('retained-pin-replay')),
    ];
    const first = await agent.runRaw(args);
    expect(first.exitCode, first.stderr || first.stdout).toBe(0);
    const original = JSON.parse(first.stdout);
    const before = await inventory(f.temporary);
    const replay = await agent.runRaw(args);
    expect(replay.exitCode, replay.stderr || replay.stdout).toBe(0);
    const out = JSON.parse(replay.stdout);
    expect(out.idempotency_status).toBe('replay');
    expect(out.artifact_id).toBe(original.artifact_id);
    expect(out.source_plan).toEqual(original.source_plan);
    expect(out.source_plan).not.toHaveProperty('content');
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
