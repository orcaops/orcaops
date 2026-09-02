import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { clearCloudLogin, seedCloudLogin } from '../support/test-helpers.js';

/**
 * Inject a recorded failure via Store.recordCloudSyncFailure (which is
 * what eagerPush calls internally). Calling it `failures` times reaches
 * the desired consecutive_failures count via the same atomic UPDATE
 * path the runtime uses, so the test exercises the public Store API
 * rather than poking columns directly.
 */
function seedFailure(
  cwd: string,
  artifactId: string,
  failures: number,
  attemptedAt: string,
  errorKind:
    | 'timeout'
    | 'http-4xx'
    | 'http-5xx'
    | 'network'
    | 'wire-invalid'
    | 'content-invalid'
    | 'upgrade-required'
    | 'server-behind'
    | 'unknown',
  errorMessage: string | null
): void {
  const dbPath = path.join(cwd, '.orcaops', 'cache', 'orcaops.db');
  const store = new Store(dbPath);
  try {
    for (let i = 0; i < failures; i++) {
      store.recordCloudSyncFailure(artifactId, {
        kind: errorKind,
        message: errorMessage,
        attemptedAt,
        attemptStartedAt: attemptedAt,
      });
    }
  } finally {
    store.close();
  }
}

describe('orcaops push-status + cloud_sync surfaces', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    // The cloud-sync surfaces under test are gated on credential presence, so
    // seed a real credential file rather than forcing the gate: that exercises
    // the same detection a user's machine performs. Paired with the drain
    // kill-switch so seeded creds never reach the network.
    seedCloudLogin();
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterEach(async () => {
    clearCloudLogin();
    await repo.cleanup();
  });

  it('reports an empty pending list on a fresh repo with no artifacts', async () => {
    await agent.init({ noLlm: true });
    const res = await agent.runRaw(['push-status', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as { ok: boolean; pending: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.pending).toEqual([]);
  });

  it('surfaces pending artifact + error state in JSON after a recorded failure', async () => {
    await agent.init({ noLlm: true });
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({ task: 'rate limit endpoint', plan_steps: [{ text: 's1', label: 's1' }] })
      ),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };

    seedFailure(
      repo.path,
      plan.artifact_id,
      3,
      new Date().toISOString(),
      'http-5xx',
      'cloud broke'
    );

    const res = await agent.runRaw(['push-status', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as {
      pending: Array<{
        artifact_id: string;
        consecutive_failures: number;
        last_push_error_kind: string;
        last_push_error_message: string;
        next_attempt_at: string | null;
        next_attempt_seconds_from_now: number | null;
      }>;
    };
    const row = r.pending.find((p) => p.artifact_id === plan.artifact_id);
    expect(row).toBeDefined();
    expect(row?.consecutive_failures).toBe(3);
    expect(row?.last_push_error_kind).toBe('http-5xx');
    expect(row?.last_push_error_message).toBe('cloud broke');
    // cf=3 → 30 * 2^2 = 120s
    expect(row?.next_attempt_at).not.toBeNull();
    expect(row?.next_attempt_seconds_from_now).toBeGreaterThan(60);
    expect(row?.next_attempt_seconds_from_now).toBeLessThanOrEqual(120);
  });

  it('orcaops status --json exposes a cloud_sync block with stuck count + last_failure', async () => {
    await agent.init({ noLlm: true });
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 'thing', plan_steps: [{ text: 's1', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    seedFailure(repo.path, plan.artifact_id, 2, new Date().toISOString(), 'timeout', null);

    const res = await agent.runRaw(['status', '--json']);
    expect(res.exitCode).toBe(0);
    const body = JSON.parse(res.stdout) as {
      cloud_sync: {
        pending_count: number;
        stuck_count: number;
        oldest_pending_age_seconds: number | null;
        last_failure: { artifact_id: string; kind: string; consecutive_failures: number } | null;
      };
    };
    expect(body.cloud_sync.pending_count).toBeGreaterThanOrEqual(1);
    expect(body.cloud_sync.stuck_count).toBe(1);
    expect(body.cloud_sync.last_failure?.artifact_id).toBe(plan.artifact_id);
    expect(body.cloud_sync.last_failure?.kind).toBe('timeout');
    expect(body.cloud_sync.last_failure?.consecutive_failures).toBe(2);
  });

  it('push-status does not recommend a bare force retry when only upgrade-required is stuck', async () => {
    await agent.init({ noLlm: true });
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 'thing', plan_steps: [{ text: 's1', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    seedFailure(
      repo.path,
      plan.artifact_id,
      2,
      new Date().toISOString(),
      'upgrade-required',
      'client below minimum'
    );

    const res = await agent.runRaw(['push-status']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('resync --force');
    expect(res.stdout).toMatch(/newer orcaops install/);
  });

  it('doctor suppresses the force-retry footer when only deterministic kinds are stuck', async () => {
    await agent.init({ noLlm: true });
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 'thing', plan_steps: [{ text: 's1', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    seedFailure(
      repo.path,
      plan.artifact_id,
      3,
      new Date().toISOString(),
      'upgrade-required',
      'client below minimum'
    );

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBeLessThanOrEqual(1);
    const r = JSON.parse(res.stdout) as {
      checks: Array<{ name: string; details?: string[] }>;
    };
    const probe = r.checks.find((c) => c.name === 'cloud-sync-pending');
    expect(probe).toBeDefined();
    const details = (probe?.details ?? []).join('\n');
    expect(details).toContain('upgrade your orcaops install');
    expect(details).not.toContain('resync --force');
  });

  it('orcaops doctor surfaces a cloud-sync-pending warn when a stuck artifact exists', async () => {
    await agent.init({ noLlm: true });
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 'thing', plan_steps: [{ text: 's1', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    seedFailure(repo.path, plan.artifact_id, 4, new Date().toISOString(), 'http-4xx', 'rejected');

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBeLessThanOrEqual(1); // warn does not fail-exit
    const r = JSON.parse(res.stdout) as {
      checks: Array<{ name: string; status: string; summary: string; details?: string[] }>;
    };
    const probe = r.checks.find((c) => c.name === 'cloud-sync-pending');
    expect(probe).toBeDefined();
    expect(probe?.status).toBe('warn');
    expect(probe?.summary).toMatch(/stuck on cloud sync/);
  });
});
