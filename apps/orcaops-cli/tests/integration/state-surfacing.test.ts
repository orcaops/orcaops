import { beforeEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { openProjectDatabase } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { createDatabasePlanPullPersistence } from '../../src/lib/database-source-plan-pull.js';
import { fixture } from '../helpers/database-history.js';
import { cloudRecord } from '../support/source-plan-test-helpers.js';
import { makeAgent } from '../support/test-agent.js';

describe('state surfacing in list / status / show', { timeout: 60_000 }, () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    f = await fixture();
    agent = makeAgent({
      cwd: f.main,
      env: {
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
        CODEX_SESSION_ID: 'state-session',
        CLAUDE_SESSION_ID: '',
        CLAUDE_CODE_SESSION_ID: '',
      },
    });
  });

  it('list --json: a freshly-planned artifact reports state=planned', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(planRes.exitCode, planRes.stdout + planRes.stderr).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const listRes = await agent.runRaw(['list', '--json']);
    expect(listRes.exitCode, listRes.stdout + listRes.stderr).toBe(0);
    const r = JSON.parse(listRes.stdout) as {
      results: Array<{ id: string; state: string }>;
    };
    const found = r.results.find((a) => a.id === plan.artifact_id);
    expect(found?.state).toBe('planned');
  });

  it('list --json: state moves to blocked when a block violation lands', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(planRes.exitCode, planRes.stdout + planRes.stderr).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    await f.mutate(plan.artifact_id, { blocked: true }, (semantics) =>
      semantics.writeEvaluatorRunPayload(
        plan.artifact_id,
        {
          schema: 'orcaops.evaluator_run/v1',
          run_id: uuidv7(),
          artifact_id: plan.artifact_id,
          evaluator_ref: 'test-pack/api-stub',
          package_id: 'test-pack',
          evaluator_id: 'api-stub',
          phase: 'pre-pr',
          severity: 'block',
          run_status: 'completed',
          verdict: 'violation',
          body: 'Retained blocking evidence',
          ts: '2026-09-05T00:00:01.000Z',
        },
        { idempotencyKey: uuidv7() }
      )
    );
    const listRes = await agent.runRaw(['list', '--json']);
    expect(listRes.exitCode, listRes.stdout + listRes.stderr).toBe(0);
    const r = JSON.parse(listRes.stdout) as {
      results: Array<{ id: string; state: string }>;
    };
    expect(r.results.find((a) => a.id === plan.artifact_id)?.state).toBe('blocked');
  });

  it('status --json: reports state per artifact', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(planRes.exitCode, planRes.stdout + planRes.stderr).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const res = await agent.runRaw(['status', '--json']);
    const r = JSON.parse(res.stdout) as {
      artifacts: Array<{ id: string; state: string }>;
    };
    expect(r.artifacts.find((a) => a.id === plan.artifact_id)?.state).toBe('planned');
  });

  it('show --json: reports the derived state and no coarse status column', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(planRes.exitCode, planRes.stdout + planRes.stderr).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const res = await agent.runRaw(['show', plan.artifact_id, '--json']);
    const r = JSON.parse(res.stdout) as {
      artifact: { id: string; state: string; status?: string };
    };
    expect(r.artifact.state).toBe('planned');
    expect(r.artifact.status).toBeUndefined();
  });

  it('show --json: state=summarized after capture summary completes', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(planRes.exitCode, planRes.stdout + planRes.stderr).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const summary = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped' })),
    ]);
    expect(summary.exitCode, summary.stdout + summary.stderr).toBe(0);
    const res = await agent.runRaw(['show', plan.artifact_id, '--json']);
    const r = JSON.parse(res.stdout) as { artifact: { state: string } };
    expect(r.artifact.state).toBe('summarized');
  });

  it('list human format includes the STATE column', async () => {
    await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const res = await agent.runRaw(['list']);
    expect(res.stdout).toMatch(/STATE/);
    expect(res.stdout).toMatch(/planned/);
  });

  it('status --json: surfaces a per-artifact source_plan, distinct from execution focus', async () => {
    await createDatabasePlanPullPersistence({
      reader: f.writer,
      target: { server_url: 'https://cloud.example', org_id: 'org_1', account_id: 'account_1' },
      secretAllow: [],
      openWriter: () => openProjectDatabase({ authority: f.authority, mode: 'writer' }),
    }).writeRecord(cloudRecord());
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(
        JSON.stringify({
          task: 't',
          label: 'pinned-status',
          plan_steps: [{ text: 's', label: 's1' }],
        })
      ),
    ]);
    expect(planRes.exitCode, planRes.stdout + planRes.stderr).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const res = await agent.runRaw(['status', '--json']);
    const r = JSON.parse(res.stdout) as {
      focus: Array<{ pin: { artifact_id: string } | null }>;
      artifacts: Array<{
        id: string;
        source_plan: {
          pinned?: boolean;
          source_ref?: { kind?: string; locator?: string; version?: string };
          content?: unknown;
        } | null;
      }>;
    };
    const found = r.artifacts.find((a) => a.id === plan.artifact_id);
    expect(found?.source_plan?.pinned).toBe(true);
    expect(found?.source_plan?.source_ref).toMatchObject({
      kind: 'cloud',
      locator: 'ext-1',
      version: '3',
    });
    expect('content' in (found!.source_plan as object)).toBe(false);
    expect(r.focus.some((selection) => selection.pin?.artifact_id === plan.artifact_id)).toBe(true);
  });

  it('status --json: source_plan is null for an unpinned artifact', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(planRes.exitCode, planRes.stdout + planRes.stderr).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const res = await agent.runRaw(['status', '--json']);
    const r = JSON.parse(res.stdout) as {
      artifacts: Array<{ id: string; source_plan: unknown }>;
    };
    expect(r.artifacts.find((a) => a.id === plan.artifact_id)?.source_plan).toBeNull();
  });
});
