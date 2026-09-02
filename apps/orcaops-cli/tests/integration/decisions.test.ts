import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops decisions` end to end: three sources merged with
 * per-record `ts`, exact-scope `--artifact` fixing the artifact set, and
 * window flags filtering RECORDS inside that fixed set. Pure merge/filter
 * logic is unit-tested in `commands/decisions.test.ts`.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DecisionsOk {
  ok: true;
  artifacts: Array<{
    artifact_id: string;
    records: Array<{
      source: string;
      ts: string | null;
      decision: string;
      revision_n?: number;
      checkpoint_n?: number;
    }>;
  }>;
  record_window: { lower?: string; upper?: string } | null;
}

function parseOk(r: CliResult): DecisionsOk {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as DecisionsOk;
  expect(parsed.ok).toBe(true);
  return parsed;
}

describe('orcaops decisions', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let artifactId: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--json', '--no-llm']);

    // Plan (with a plan-time decision) → cp close (with a decision) →
    // summary (with a deferred decision): one artifact, three sources.
    const planR = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'decisions fixture',
          label: 'decisions-fixture',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
          decisions: [{ decision: 'use redis', reason: 'already deployed' }],
        })
      ),
    ]);
    const plan = JSON.parse(planR.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    artifactId = plan.artifact_id;
    const stepId = plan.plan_steps[0].step_id;

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
    await commitFile(repo.path, 'src/a.ts', 'export const a = 1;\n', 'work');
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
          summary: 'did the work',
          files_changed: ['src/a.ts'],
          decisions: [{ decision: 'adopt existing pattern', reason: 'less new surface' }],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepId],
        })
      ),
    ]);
    await agent.runRaw([
      'capture',
      'pre-pr-check',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({ idempotency_key: `prepr-${randomUUID()}`, artifact_id: artifactId })
      ),
    ]);
    await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: artifactId,
          outcome: 'done',
          open_items: [],
          deferred_decisions: ['revisit sharding later'],
        })
      ),
    ]);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('merges the three sources, each record carrying ts + provenance', async () => {
    const out = parseOk(await agent.runRaw(['decisions', '--json']));
    expect(out.artifacts).toHaveLength(1);
    expect(out.record_window).toBeNull();

    const records = out.artifacts[0].records;
    const sources = records.map((r) => r.source).sort();
    expect(sources).toEqual(['checkpoint', 'plan', 'summary_deferred']);
    for (const r of records) {
      expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(records.find((r) => r.source === 'plan')?.revision_n).toBe(0);
    expect(records.find((r) => r.source === 'checkpoint')?.checkpoint_n).toBe(1);
  });

  it('--artifact fixes the set; window flags then filter records within it', async () => {
    // All three records were captured "now" — an upper bound in 1970 keeps
    // the artifact set fixed but filters every record → artifact drops out.
    const filtered = parseOk(
      await agent.runRaw(['decisions', '--artifact', artifactId, '--until', '1970-01-01', '--json'])
    );
    expect(filtered.artifacts).toEqual([]);
    expect(filtered.record_window).not.toBeNull();

    // A window covering "now" keeps all three.
    const kept = parseOk(
      await agent.runRaw(['decisions', '--artifact', artifactId, '--since', '1970-01-01', '--json'])
    );
    expect(kept.artifacts).toHaveLength(1);
    expect(kept.artifacts[0].records).toHaveLength(3);
  });

  it('an unreadable artifact is omitted and disclosed by id only', async () => {
    // Decision records are log content — nothing verifiable remains for a
    // row, so the artifact drops with an id-only disclosure.
    const dir = path.join(repo.path, '.orcaops', 'artifacts', artifactId);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"plan_captured"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');
    await rm(path.join(dir, 'artifact.json'), { force: true });
    await rm(path.join(dir, 'plan.json'), { force: true });

    const res = await agent.runRaw(['decisions', '--json']);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toMatch(/unreadable in decisions/);
    const out = JSON.parse(res.stdout) as DecisionsOk & { degraded_artifacts: string[] };
    expect(out.artifacts).toEqual([]);
    expect(out.degraded_artifacts).toEqual([artifactId]);
  });

  it('unknown --artifact id errors with UNKNOWN_ARTIFACT', async () => {
    const r = await agent.runRaw([
      'decisions',
      '--artifact',
      '01890000-0000-7000-8000-000000000000',
      '--json',
    ]);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { ok: false; error: { code: string } };
    expect(err.error.code).toBe('UNKNOWN_ARTIFACT');
  });
});
