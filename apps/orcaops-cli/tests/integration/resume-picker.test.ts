import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { withCleanSession } from '../support/test-helpers.js';

interface PickerCandidate {
  id: string;
  task: string;
  state: string;
  checkpoint_count: number;
  last_activity_at: string;
}

interface AmbiguousPayload {
  ok: true;
  schema_version: 2;
  resolved: false;
  reason: string;
  shell_key: { kind: string };
  candidates: PickerCandidate[];
  default_candidate_id: string;
  default_rationale: string;
  next_actions: Array<{ verb: string; command: string; effect: string }>;
}

interface ResolvedPayload {
  ok: true;
  schema_version: 2;
  resolved: true;
  resolution_via: 'pin' | 'single-active' | 'explicit-flag' | 'no-active-artifacts';
  artifact: {
    artifact_id: string;
    branch: string;
    task: string;
  } | null;
  next_actions?: Array<{ verb: string; command: string }>;
}

describe('orcaops resume — picker', () => {
  let repo: TempRepo;
  let xdgState: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-pickr-xdg-'));
    const initAgent = makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, CLAUDE_SESSION_ID: 'sess_test' }),
    });
    await initAgent.runRaw(['init', '--no-llm']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  function agentForSession(sessionId = 'sess_test') {
    return makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, CLAUDE_SESSION_ID: sessionId }),
    });
  }

  function agentHeadless() {
    return makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState }),
    });
  }

  async function planArtifactHeadless(task: string): Promise<string> {
    const planRes = await agentHeadless().runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task, plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(planRes.exitCode).toBe(0);
    return (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;
  }

  async function firstStepId(artifactId: string): Promise<string> {
    const res = await agentHeadless().runRaw(['show', artifactId, '--json']);
    const json = JSON.parse(res.stdout) as {
      artifact?: { plan?: { plan_steps?: Array<{ step_id: string }> } };
    };
    return json.artifact!.plan!.plan_steps![0].step_id;
  }

  it('two in-flight artifacts → ambiguous picker payload, exit 1', async () => {
    const a = await planArtifactHeadless('first task');
    const b = await planArtifactHeadless('second task');
    const res = await agentForSession().runRaw(['resume', '--json']);
    expect(res.exitCode).toBe(1);
    const payload = JSON.parse(res.stdout) as AmbiguousPayload;
    expect(payload.ok).toBe(true);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('multiple-active-no-pin');
    expect(payload.candidates.map((c) => c.id).sort()).toEqual([a, b].sort());
    expect(payload.shell_key.kind).toBe('claude_session');
    expect(payload.next_actions.map((a) => a.verb)).toEqual([
      'checkout',
      'resume-once',
      'accept-default',
    ]);
  });

  it('default_candidate_id is most-recently-active (latest last_activity_at)', async () => {
    const a = await planArtifactHeadless('older');
    // Add a checkpoint to b so its updated_at is later.
    const b = await planArtifactHeadless('newer');
    const bStep = await firstStepId(b);
    const cpOpen = await agentHeadless().runRaw([
      'capture',
      'checkpoint',
      'open',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: b,
          declared_step_ids: [bStep],
        })
      ),
    ]);
    expect(cpOpen.exitCode).toBe(0);
    const cp = await agentHeadless().runRaw([
      'capture',
      'checkpoint',
      'close',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: b,
          n: 1,
          summary: 'cp',
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [bStep],
        })
      ),
    ]);
    expect(cp.exitCode).toBe(0);
    const res = await agentForSession().runRaw(['resume', '--json']);
    expect(res.exitCode).toBe(1);
    const payload = JSON.parse(res.stdout) as AmbiguousPayload;
    expect(payload.default_candidate_id).toBe(b);
    expect(payload.default_rationale).toBe('most-recently-active');
    void a;
  });

  it('--accept-default resolves with via=explicit-flag and writes a pin', async () => {
    const a = await planArtifactHeadless('older');
    const b = await planArtifactHeadless('newer');
    const bStep = await firstStepId(b);
    const cpOpen = await agentHeadless().runRaw([
      'capture',
      'checkpoint',
      'open',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: b,
          declared_step_ids: [bStep],
        })
      ),
    ]);
    expect(cpOpen.exitCode).toBe(0);
    const cp = await agentHeadless().runRaw([
      'capture',
      'checkpoint',
      'close',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: b,
          n: 1,
          summary: 'cp',
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [bStep],
        })
      ),
    ]);
    expect(cp.exitCode).toBe(0);

    const res = await agentForSession().runRaw(['resume', '--accept-default', '--json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as ResolvedPayload;
    expect(payload.resolved).toBe(true);
    expect(payload.resolution_via).toBe('explicit-flag');
    expect(payload.artifact?.artifact_id).toBe(b);
    void a;

    // Pin file exists.
    const fs = await import('node:fs/promises');
    const pinDir = path.join(xdgState, 'orcaops', 'pins');
    const repoEntries = await fs.readdir(pinDir);
    expect(repoEntries.length).toBeGreaterThan(0);
  });

  it('--accept-default --no-pin resolves but does not write a pin', async () => {
    await planArtifactHeadless('older');
    await planArtifactHeadless('newer');
    const res = await agentForSession().runRaw([
      'resume',
      '--accept-default',
      '--no-pin',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as ResolvedPayload;
    expect(payload.resolved).toBe(true);
    expect(payload.resolution_via).toBe('explicit-flag');

    // No pin file written.
    const fs = await import('node:fs/promises');
    const pinDir = path.join(xdgState, 'orcaops', 'pins');
    let entries: string[] = [];
    try {
      entries = await fs.readdir(pinDir);
    } catch {
      // dir may not exist — also acceptable
    }
    expect(entries).toHaveLength(0);
  });

  it('pin overrides single-active resolution: via=pin', async () => {
    const a = await planArtifactHeadless('first');
    // Pin a explicitly. Single-active would pick a anyway, but the
    // resolution_via differs.
    const checkout = await agentForSession().runRaw(['checkout', a, '--json']);
    expect(checkout.exitCode).toBe(0);

    const res = await agentForSession().runRaw(['resume', '--json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as ResolvedPayload;
    expect(payload.resolution_via).toBe('pin');
    expect(payload.artifact?.artifact_id).toBe(a);
  });

  it('pin to a SUMMARIZED artifact is treated as stale: falls through to single-active', async () => {
    const a = await planArtifactHeadless('first');
    // Pin a, then summarize a — pin now points at a summarized
    // artifact. Per spec, "loadable" excludes summarized.
    await agentForSession().runRaw(['checkout', a, '--json']);
    await agentForSession().runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(JSON.stringify({ artifact_id: a, outcome: 'shipped' })),
    ]);
    // After capture summary, the pin auto-cleared. Re-pin a.
    await agentForSession().runRaw(['checkout', a, '--json']);
    // Plant a new in-flight artifact b.
    const b = await planArtifactHeadless('next');
    const res = await agentForSession().runRaw(['resume', '--json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as ResolvedPayload;
    // a is summarized (pin stale), b is the only in-flight → single-active.
    expect(payload.resolution_via).toBe('single-active');
    expect(payload.artifact?.artifact_id).toBe(b);
  });

  it('multiple in-flight + headless shell-key still picks correctly with --accept-default', async () => {
    await planArtifactHeadless('first');
    await planArtifactHeadless('second');
    const res = await agentHeadless().runRaw(['resume', '--accept-default', '--json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as ResolvedPayload;
    expect(payload.resolved).toBe(true);
    expect(payload.resolution_via).toBe('explicit-flag');
    // Headless: no pin written (kind=none → the pin code skips silently).
    const fs = await import('node:fs/promises');
    const pinDir = path.join(xdgState, 'orcaops', 'pins');
    let entries: string[] = [];
    try {
      entries = await fs.readdir(pinDir);
    } catch {
      // ok
    }
    expect(entries).toHaveLength(0);
  });
});

describe('orcaops status — current_pin field', () => {
  let repo: TempRepo;
  let xdgState: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-status-xdg-'));
    const initAgent = makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, CLAUDE_SESSION_ID: 'sess_test' }),
    });
    await initAgent.runRaw(['init', '--no-llm']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  function agentForSession() {
    return makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, CLAUDE_SESSION_ID: 'sess_test' }),
    });
  }

  function agentHeadless() {
    return makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState }),
    });
  }

  it('current_pin: null when no pin exists for this shell-key', async () => {
    // Headless capture leaves no pin.
    await agentHeadless().runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const res = await agentForSession().runRaw(['status', '--json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      ok: true;
      schema_version: number;
      branch: string;
      current_pin: unknown;
    };
    expect(payload.schema_version).toBe(2);
    expect(payload.current_pin).toBeNull();
  });

  it('current_pin: populated after capture plan auto-pins (same shell)', async () => {
    const planRes = await agentForSession().runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };

    const res = await agentForSession().runRaw(['status', '--json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      ok: true;
      schema_version: number;
      current_pin: { artifact_id: string; pinned_via: string } | null;
    };
    expect(payload.current_pin?.artifact_id).toBe(plan.artifact_id);
    expect(payload.current_pin?.pinned_via).toBe('auto-on-capture-plan');
  });

  it('current_pin: null in headless shell even when other shells have pins', async () => {
    // Pin in session A.
    await agentForSession().runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    // Status in headless shell: kind=none → current_pin null.
    const res = await agentHeadless().runRaw(['status', '--json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as { current_pin: unknown };
    expect(payload.current_pin).toBeNull();
  });
});
