import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops list --touching <path>` end to end: closed-cp-only
 * rollup with the fixed provenance note, lineage-membership branch scoping,
 * `--all-branches` widening, and the window-flag rejection. Pure rollup math
 * is unit-tested in `commands/list.test.ts`.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TouchingOk {
  ok: true;
  touching: string;
  note: string;
  artifacts: Array<{
    id: string;
    label: string;
    branch: string;
    state: string;
    first_touched_at: string;
    last_touched_at: string;
    checkpoints: Array<{ n: number; closed_at: string; summary: string }>;
  }>;
}

function parseOk(r: CliResult): TouchingOk {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as TouchingOk;
  expect(parsed.ok).toBe(true);
  return parsed;
}

async function captureArtifact(
  agent: ReturnType<typeof makeAgent>,
  label: string
): Promise<{ artifactId: string; stepId: string }> {
  const planR = await agent.runRaw([
    'capture',
    'plan',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `plan-${randomUUID()}`,
        task: `${label} task`,
        label,
        plan_steps: [{ text: 'only step', label: 'only' }],
        touched_scope: [],
      })
    ),
  ]);
  const plan = JSON.parse(planR.stdout) as {
    artifact_id: string;
    plan_steps: Array<{ step_id: string }>;
  };
  return { artifactId: plan.artifact_id, stepId: plan.plan_steps[0].step_id };
}

async function closeCpTouching(
  agent: ReturnType<typeof makeAgent>,
  artifactId: string,
  stepId: string,
  files: string[]
): Promise<void> {
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
  ]);
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
        summary: `touched ${files.join(', ')}`,
        files_changed: files,
        verification: [{ command: 'test fixture', exit_code: 0 }],
        completed_step_ids: [stepId],
      })
    ),
  ]);
}

describe('orcaops list --touching', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let touchingId: string;
  let otherId: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--json', '--no-llm']);
    await commitFile(repo.path, 'src/a.ts', 'export const a = 1;\n', 'seed');

    const first = await captureArtifact(agent, 'touches-a');
    touchingId = first.artifactId;
    await closeCpTouching(agent, first.artifactId, first.stepId, ['src/a.ts']);

    const second = await captureArtifact(agent, 'touches-b');
    otherId = second.artifactId;
    await closeCpTouching(agent, second.artifactId, second.stepId, ['src/b.ts']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('rolls up only artifacts whose closed cps touched the path, with the note', async () => {
    const out = parseOk(await agent.runRaw(['list', '--touching', 'src/a.ts', '--json']));
    expect(out.touching).toBe('src/a.ts');
    expect(out.note).toBe(
      'closed checkpoints only — open checkpoints have no files_changed until close'
    );
    expect(out.artifacts.map((a) => a.id)).toEqual([touchingId]);
    const a = out.artifacts[0];
    expect(a.label).toBe('touches-a');
    expect(a.checkpoints).toHaveLength(1);
    expect(a.first_touched_at).toBe(a.last_touched_at);
  });

  it('an open checkpoint declaring pending work on the path is invisible', async () => {
    // Third artifact: open cp only (files_changed does not exist until close).
    const third = await captureArtifact(agent, 'open-only');
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: third.artifactId,
          declared_step_ids: [third.stepId],
        })
      ),
    ]);
    const out = parseOk(await agent.runRaw(['list', '--touching', 'src/a.ts', '--json']));
    expect(out.artifacts.map((a) => a.id)).toEqual([touchingId]);
  });

  it('substring paths do not match (exact re-filter beats the LIKE scan)', async () => {
    const out = parseOk(await agent.runRaw(['list', '--touching', 'src/a', '--json']));
    expect(out.artifacts).toEqual([]);
  });

  it('branch scoping uses lineage membership; --all-branches widens', async () => {
    const onMain = parseOk(await agent.runRaw(['list', '--touching', 'src/b.ts', '--json']));
    expect(onMain.artifacts.map((a) => a.id)).toEqual([otherId]);

    // A branch with no lineage members sees nothing…
    await gitClient(repo.path).checkoutLocalBranch('feature/empty');
    const onFeature = parseOk(await agent.runRaw(['list', '--touching', 'src/b.ts', '--json']));
    expect(onFeature.artifacts).toEqual([]);
    // …until --all-branches drops the membership filter.
    const widened = parseOk(
      await agent.runRaw(['list', '--touching', 'src/b.ts', '--all-branches', '--json'])
    );
    expect(widened.artifacts.map((a) => a.id)).toEqual([otherId]);
  });

  it('an unreadable touching artifact keeps its rollup with state unknown; a state filter discloses it', async () => {
    // Unattributable non-tail rot: every projection read for it refuses.
    const dir = path.join(repo.path, '.orcaops', 'artifacts', touchingId);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"plan_captured"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');
    await rm(path.join(dir, 'artifact.json'), { force: true });
    await rm(path.join(dir, 'plan.json'), { force: true });

    const res = await agent.runRaw(['list', '--touching', 'src/a.ts', '--json']);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toMatch(/unreadable in list --touching/);
    const out = JSON.parse(res.stdout) as {
      artifacts: Array<{
        id: string;
        label: string;
        state: string | null;
        unreadable?: boolean;
        first_touched_at: string;
        last_touched_at: string;
        checkpoints: Array<{ n: number; closed_at: string; summary: string }>;
      }>;
      degraded_artifacts: string[];
    };
    const row = out.artifacts.find((a) => a.id === touchingId);
    // Rollup kept: state unknown under the marker, index facts verbatim.
    expect(row?.state).toBeNull();
    expect(row?.unreadable).toBe(true);
    expect(row?.label).toBe('touches-a');
    expect(row?.checkpoints).toHaveLength(1);
    expect(row?.checkpoints[0].summary).toBe('touched src/a.ts');
    expect(row?.first_touched_at).toBe(row?.checkpoints[0].closed_at);
    expect(row?.last_touched_at).toBe(row?.checkpoints[0].closed_at);
    expect(out.degraded_artifacts).toEqual([touchingId]);

    // A state filter cannot evaluate the row: excluded but disclosed.
    const filtered = await agent.runRaw([
      'list',
      '--touching',
      'src/a.ts',
      '--state',
      'planned',
      '--json',
    ]);
    expect(filtered.exitCode).toBe(0);
    const fOut = JSON.parse(filtered.stdout) as {
      artifacts: Array<{ id: string }>;
      degraded_artifacts: string[];
    };
    expect(fOut.artifacts.map((a) => a.id)).not.toContain(touchingId);
    expect(fOut.degraded_artifacts).toEqual([touchingId]);
  });

  it('window flags are rejected with INVALID_INPUT (provenance is current state)', async () => {
    for (const flags of [
      ['--since', '2026-01-01'],
      ['--until', '2026-12-31'],
      ['--active-since', '2026-01-01'],
      ['--active-until', '2026-12-31'],
    ]) {
      const r = await agent.runRaw(['list', '--touching', 'src/a.ts', ...flags, '--json']);
      expect(r.exitCode).toBe(1);
      const err = JSON.parse(r.stdout) as { ok: false; error: { code: string; message: string } };
      expect(err.error.code).toBe('INVALID_INPUT');
      expect(err.error.message).toMatch(/current state/);
    }
  });

  it('--limit truncates the artifact rollup after ordering', async () => {
    // Make the second artifact also touch src/a.ts so two artifacts match.
    const third = await captureArtifact(agent, 'touches-a-later');
    await closeCpTouching(agent, third.artifactId, third.stepId, ['src/a.ts']);

    const all = parseOk(await agent.runRaw(['list', '--touching', 'src/a.ts', '--json']));
    expect(all.artifacts).toHaveLength(2);
    // Most recently touching artifact first.
    expect(all.artifacts[0].id).toBe(third.artifactId);

    const limited = parseOk(
      await agent.runRaw(['list', '--touching', 'src/a.ts', '--limit', '1', '--json'])
    );
    expect(limited.artifacts.map((a) => a.id)).toEqual([third.artifactId]);
  });
});
