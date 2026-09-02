import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * Runtime invoking-agent attribution, end-to-end through the real CLI:
 * the flag, the ambient markers, the fallback notice, cross-agent
 * handoffs, and replay safety. The vitest setup scrubs ambient markers
 * from `process.env`, so every marker seen here is test-injected.
 */
describe('--invoked-by-agent runtime attribution', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    const agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const PLAN_PAYLOAD = JSON.stringify({
    task: 'attribution test task',
    label: 'attribution-test',
    plan_steps: [{ text: 'step one', label: 's1' }],
    touched_scope: [],
  });

  async function capturePlan(
    agent: ReturnType<typeof makeAgent>,
    extraArgs: string[] = []
  ): Promise<{ artifact_id: string; plan_steps: Array<{ step_id: string }>; stderr: string }> {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      ...extraArgs,
      '--input',
      inputFile(PLAN_PAYLOAD),
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    return { ...out, stderr: res.stderr };
  }

  async function readArtifactJson(
    artifactId: string,
    file: string
  ): Promise<Record<string, unknown>> {
    const p = path.join(repo.path, '.orcaops', 'artifacts', artifactId, file);
    return JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
  }

  it('stamps plan.agent from --invoked-by-agent', async () => {
    const agent = makeAgent({ cwd: repo.path });
    const { artifact_id } = await capturePlan(agent, ['--invoked-by-agent', 'codex']);
    const plan = await readArtifactJson(artifact_id, 'plan.json');
    expect(plan.agent).toBe('codex');
  });

  it('stamps plan.agent from the CLAUDECODE ambient marker when no flag is given', async () => {
    const agent = makeAgent({ cwd: repo.path, env: { CLAUDECODE: '1' } });
    const { artifact_id } = await capturePlan(agent);
    const plan = await readArtifactJson(artifact_id, 'plan.json');
    expect(plan.agent).toBe('claude-code');
  });

  it('stamps plan.agent from ORCAOPS_INVOKED_BY_AGENT', async () => {
    const agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_INVOKED_BY_AGENT: 'opencode' } });
    const { artifact_id } = await capturePlan(agent);
    const plan = await readArtifactJson(artifact_id, 'plan.json');
    expect(plan.agent).toBe('opencode');
  });

  it('falls back to other with a stderr note on a bare invocation', async () => {
    const agent = makeAgent({ cwd: repo.path });
    const { artifact_id, stderr } = await capturePlan(agent);
    const plan = await readArtifactJson(artifact_id, 'plan.json');
    expect(plan.agent).toBe('other');
    expect(stderr).toContain('attributing to "other"');
    expect(stderr).toContain('--invoked-by-agent');
  });

  it('rejects an unknown --invoked-by-agent value with INVALID_INPUT', async () => {
    const agent = makeAgent({ cwd: repo.path });
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--invoked-by-agent',
      'gpt-shell',
      '--input',
      inputFile(PLAN_PAYLOAD),
    ]);
    expect(res.exitCode).not.toBe(0);
    const out = JSON.parse(res.stdout) as { ok: boolean; error: { code: string } };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('INVALID_INPUT');
  });

  it('attributes a full cross-agent handoff per lifecycle event', async () => {
    // Plan authored by claude-code (ambient marker).
    const claude = makeAgent({ cwd: repo.path, env: { CLAUDECODE: '1' } });
    const { artifact_id, plan_steps } = await capturePlan(claude);
    const stepId = plan_steps[0].step_id;

    // Checkpoint opened by codex (self-declared flag beats the inherited
    // claude-code marker — the nested-agent case).
    const codex = makeAgent({ cwd: repo.path, env: { CLAUDECODE: '1' } });
    const openRes = await codex.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--invoked-by-agent',
      'codex',
      '--input',
      inputFile(JSON.stringify({ artifact_id, declared_step_ids: [stepId] })),
    ]);
    expect(openRes.exitCode).toBe(0);
    let cp = await readArtifactJson(artifact_id, 'checkpoint-1.json');
    expect(cp.agent).toBe('codex');

    // ...and closed by cursor.
    const cursor = makeAgent({ cwd: repo.path });
    const closeRes = await cursor.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--invoked-by-agent',
      'cursor',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id,
          n: 1,
          summary: 'closed by a different agent',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepId],
        })
      ),
    ]);
    expect(closeRes.exitCode).toBe(0);
    cp = await readArtifactJson(artifact_id, 'checkpoint-1.json');
    expect(cp.agent).toBe('codex');
    expect(cp.closed_by_agent).toBe('cursor');

    // Plan revised by opencode → revised_by_agent, authoring agent frozen.
    const opencode = makeAgent({ cwd: repo.path });
    const reviseRes = await opencode.runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--invoked-by-agent',
      'opencode',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id,
          label: 'attribution-test-r1',
          rationale: 'handoff revision',
          prior_plan_event_id: null,
          plan_steps: [
            { step_id: stepId, text: 'step one', label: 's1' },
            { text: 'step two', label: 's2' },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(reviseRes.exitCode).toBe(0);
    const plan = await readArtifactJson(artifact_id, 'plan.json');
    expect(plan.agent).toBe('claude-code');
    expect(plan.revised_by_agent).toBe('opencode');

    // Summary captured by github-copilot.
    const copilot = makeAgent({ cwd: repo.path });
    const summaryRes = await copilot.runRaw([
      'capture',
      'summary',
      '--invoked-by-agent',
      'github-copilot',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id,
          outcome: 'handoff complete',
          tests_written: [],
          tests_run: [],
          open_items: [],
        })
      ),
    ]);
    expect(summaryRes.exitCode).toBe(0);
    const summary = await readArtifactJson(artifact_id, 'summary.json');
    expect(summary.agent).toBe('github-copilot');

    // The digest surfaces the handoffs — attribution suffixes render
    // only because these events' agents differ from plan.agent.
    const digestRes = await copilot.runRaw(['digest', '--artifact', artifact_id]);
    expect(digestRes.exitCode).toBe(0);
    expect(digestRes.stdout).toContain('by `cursor` (opened by `codex`)');
    expect(digestRes.stdout).toContain('authored by `claude-code`; summarized by `github-copilot`');
  });

  it('replays (never conflicts) when the same idempotency key retries from another agent', async () => {
    const agent = makeAgent({ cwd: repo.path });
    const { artifact_id, plan_steps } = await capturePlan(agent, ['--invoked-by-agent', 'codex']);
    const openPayload = JSON.stringify({
      artifact_id,
      idempotency_key: 'cross-agent-open-retry',
      declared_step_ids: [plan_steps[0].step_id],
    });

    const first = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--invoked-by-agent',
      'codex',
      '--input',
      inputFile(openPayload),
    ]);
    expect(first.exitCode).toBe(0);

    const retry = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--invoked-by-agent',
      'cursor',
      '--input',
      inputFile(openPayload),
    ]);
    // Provenance is not intent: the retry replays and the ORIGINAL
    // attribution is preserved.
    expect(retry.exitCode).toBe(0);
    const cp = await readArtifactJson(artifact_id, 'checkpoint-1.json');
    expect(cp.agent).toBe('codex');
  });
});
