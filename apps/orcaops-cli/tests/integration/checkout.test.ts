import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { artifactPathsFor, readEventLog } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { plantBlockViolation, withCleanSession } from '../support/test-helpers.js';

interface CheckoutOk {
  ok: true;
  action: 'pinned' | 'cleared';
  artifact_id?: string;
  branch?: string;
  shell_key: { kind: string; value?: string };
  pin_file?: string;
  displaced_artifact_id?: string | null;
  cleared?: boolean;
  previous_artifact_id?: string | null;
}

interface ErrEnvelope {
  ok: false;
  error: { code: string; message: string };
}

async function readPinDisplacedEvents(repoCwd: string, artifactId: string): Promise<unknown[]> {
  const config = await loadConfig(repoCwd);
  const paths = artifactPathsFor(repoCwd, config, artifactId);
  const result = await readEventLog({
    eventLogPath: paths.eventsNdjson,
    sidecarsDir: paths.sidecarsDir,
  });
  return result.events.filter((e) => e.type === 'pin_displaced');
}

describe('orcaops checkout', () => {
  let repo: TempRepo;
  let xdgState: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-checkout-xdg-'));
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

  async function planArtifact(): Promise<string> {
    const planRes = await agentForSession().runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    return plan.artifact_id;
  }

  /**
   * Plan an artifact in a headless env (no shell-key) so the auto-pin
   * stays silent. Tests below that exercise the EXPLICIT checkout flow
   * use this helper to avoid mixing auto-pin pin_displaced events into
   * their assertions.
   */
  async function planArtifactHeadless(): Promise<string> {
    const planRes = await agentHeadless().runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    return plan.artifact_id;
  }

  it('--json: pins an existing artifact and writes a pin file under XDG_STATE_HOME', async () => {
    const artifactId = await planArtifact();
    const res = await agentForSession().runRaw(['checkout', artifactId, '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as CheckoutOk;
    expect(out.ok).toBe(true);
    expect(out.action).toBe('pinned');
    expect(out.artifact_id).toBe(artifactId);
    expect(out.shell_key.kind).toBe('claude_session');
    expect(out.pin_file).toBeDefined();
    expect(out.pin_file?.startsWith(xdgState)).toBe(true);
    expect(out.displaced_artifact_id).toBeNull();
  });

  it('rejects an unknown artifact id with UNKNOWN_ARTIFACT', async () => {
    const res = await agentForSession().runRaw(['checkout', 'no-such-id', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as ErrEnvelope;
    expect(env.error.code).toBe('UNKNOWN_ARTIFACT');
  });

  it('rejects a summarized artifact instead of creating a stale pin', async () => {
    const artifactId = await planArtifactHeadless();
    const summary = await agentHeadless().runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: 'summarize-before-checkout',
          artifact_id: artifactId,
          outcome: 'complete',
        })
      ),
    ]);
    expect(summary.exitCode, summary.stdout).toBe(0);

    const res = await agentForSession().runRaw(['checkout', artifactId, '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as ErrEnvelope;
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toMatch(/Cannot pin summarized artifact/);
  });

  it('rejects with INVALID_INPUT when called with neither an id nor --clear', async () => {
    const res = await agentForSession().runRaw(['checkout', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as ErrEnvelope;
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects with INVALID_INPUT when --clear is mixed with an id', async () => {
    const artifactId = await planArtifact();
    const res = await agentForSession().runRaw(['checkout', artifactId, '--clear', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as ErrEnvelope;
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('rejects with NO_SHELL_KEY when env has no recognized session var', async () => {
    const artifactId = await planArtifact();
    const res = await agentHeadless().runRaw(['checkout', artifactId, '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as ErrEnvelope;
    expect(env.error.code).toBe('NO_SHELL_KEY');
  });

  it('--clear removes the pin and reports cleared:true', async () => {
    const artifactId = await planArtifact();
    await agentForSession().runRaw(['checkout', artifactId, '--json']);
    const res = await agentForSession().runRaw(['checkout', '--clear', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as CheckoutOk;
    expect(out.action).toBe('cleared');
    expect(out.cleared).toBe(true);
    expect(out.previous_artifact_id).toBe(artifactId);
  });

  it('--clear is idempotent when no pin exists (cleared:false)', async () => {
    const res = await agentForSession().runRaw(['checkout', '--clear', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as CheckoutOk;
    expect(out.cleared).toBe(false);
    expect(out.previous_artifact_id).toBeNull();
  });

  async function captureCheckpointHeadless(artifactId: string, n: number): Promise<void> {
    const agent = agentHeadless();
    const showRes = await agent.runRaw(['show', artifactId, '--json']);
    const showJson = JSON.parse(showRes.stdout) as {
      artifact?: { plan?: { plan_steps?: Array<{ step_id: string }> } };
    };
    const stepIds = showJson.artifact?.plan?.plan_steps?.map((s) => s.step_id) ?? [];
    const openRes = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          declared_step_ids: [stepIds[n - 1]],
        })
      ),
    ]);
    expect(openRes.exitCode).toBe(0);
    const res = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          n,
          summary: `cp-${n}`,
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepIds[n - 1]],
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
  }

  it('overwriting a pin pointing to an active artifact emits pin_displaced on the prior', async () => {
    // Plan in headless so the auto-pin path stays silent; the explicit
    // checkouts below are the only source of pin_displaced events.
    const a = await planArtifactHeadless();
    await captureCheckpointHeadless(a, 1); // planned → active
    const b = await planArtifactHeadless();
    // Pin A first.
    await agentForSession().runRaw(['checkout', a, '--json']);
    // Now pin B — A is active; pin_displaced should fire on A.
    const res = await agentForSession().runRaw(['checkout', b, '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as CheckoutOk;
    expect(out.displaced_artifact_id).toBe(a);
    const events = await readPinDisplacedEvents(repo.path, a);
    expect(events).toHaveLength(1);
  });

  it('overwriting a pin pointing to a PLANNED artifact does NOT emit pin_displaced', async () => {
    // Spec: displacement only fires when prior is `active` or `blocked`.
    // A pure planned artifact (no checkpoints) is treated like summarized.
    const a = await planArtifactHeadless();
    const b = await planArtifactHeadless();
    await agentForSession().runRaw(['checkout', a, '--json']);
    const res = await agentForSession().runRaw(['checkout', b, '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as CheckoutOk;
    expect(out.displaced_artifact_id).toBeNull();
    const events = await readPinDisplacedEvents(repo.path, a);
    expect(events).toHaveLength(0);
  });

  it('overwriting a pin pointing to a SUMMARIZED artifact does NOT emit pin_displaced', async () => {
    const a = await planArtifactHeadless();
    const b = await planArtifactHeadless();
    // Pin A, then summarize A.
    await agentForSession().runRaw(['checkout', a, '--json']);
    const sum = await agentForSession().runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(JSON.stringify({ artifact_id: a, outcome: 'shipped' })),
    ]);
    expect(sum.exitCode).toBe(0);
    // Now pin B — A is summarized, so the overwrite is silent.
    const res = await agentForSession().runRaw(['checkout', b, '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as CheckoutOk;
    expect(out.displaced_artifact_id).toBeNull();
    const events = await readPinDisplacedEvents(repo.path, a);
    expect(events).toHaveLength(0);
  });

  it('overwriting a pin pointing to a BLOCKED artifact emits pin_displaced', async () => {
    const a = await planArtifactHeadless();
    const b = await planArtifactHeadless();
    await agentForSession().runRaw(['checkout', a, '--json']);
    await plantBlockViolation({
      cwd: repo.path,
      artifactId: a,
      evaluatorRef: 'test-pack/api-stub',
    });
    const res = await agentForSession().runRaw(['checkout', b, '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as CheckoutOk;
    expect(out.displaced_artifact_id).toBe(a);
  });

  it('different shell-keys (different sessions) do not displace each other', async () => {
    const a = await planArtifactHeadless();
    const b = await planArtifactHeadless();
    await agentForSession('sess_one').runRaw(['checkout', a, '--json']);
    const res = await agentForSession('sess_two').runRaw(['checkout', b, '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as CheckoutOk;
    // Different shell-key means no displacement of A.
    expect(out.displaced_artifact_id).toBeNull();

    // And the on-disk pin file count is 2 (one per shell-key).
    const repoIdDir = path.dirname(out.pin_file as string);
    const entries = await readdir(repoIdDir);
    expect(entries.filter((e) => e.endsWith('.json'))).toHaveLength(2);
  });

  it('checkout against the same artifact a second time is silent (no displaced event)', async () => {
    const a = await planArtifactHeadless();
    await agentForSession().runRaw(['checkout', a, '--json']);
    const res = await agentForSession().runRaw(['checkout', a, '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as CheckoutOk;
    expect(out.displaced_artifact_id).toBeNull();
    const events = await readPinDisplacedEvents(repo.path, a);
    expect(events).toHaveLength(0);
  });
});
