import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { CliExit } from '../../src/io/exit.js';
import { makeAgent } from '../support/test-agent.js';

// Permanent regression guard: exercises the
// AsyncLocalStorage isolation that makes the in-process test harness
// safe under concurrent multi-agent workloads. A failure here means
// two parallel tests can leak cwd/env/stdout into each other.

/**
 * Mint a fresh isolated $XDG_STATE_HOME for a single agent. Each parallel
 * agent needs its own pin store dir so this test verifies pin file
 * isolation alongside shell-key isolation.
 */
async function makeXdgState(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'orcaops-concurrency-xdg-'));
}

/**
 * Mint a fresh isolated $ORCAOPS_GLOBAL_ROOT for a single agent.
 *
 * The install-state lock lives under the global root, which is `~/.orcaops`
 * unless this is set — so every parallel agent contended for one lock with a
 * ten-second acquire budget, and the guard failed under full-suite load while
 * describing itself as a permanent regression guard. `XDG_STATE_HOME` does not
 * cover it: the two roots are separate.
 */
async function makeGlobalRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'orcaops-concurrency-global-'));
}

/**
 * These cases spin up eight real repositories and drive a full init and capture
 * through each. Vitest's ten-second default is not a budget for that under a
 * loaded suite — racing it measures the machine rather than the isolation this
 * guard exists to check, which is how it came to fail routinely and be read as
 * noise.
 */
const STRESS_TIMEOUT_MS = 120_000;

describe('InProcessAgent concurrency (stress test)', () => {
  const repos: TempRepo[] = [];

  beforeEach(() => {
    repos.length = 0;
  });

  afterEach(async () => {
    await Promise.all(repos.map((r) => r.cleanup()));
  });

  async function spinUpRepo(): Promise<TempRepo> {
    const repo = await createTempRepo({ initialBranch: 'main' });
    repos.push(repo);
    return repo;
  }

  it(
    '8 parallel list() calls across 8 distinct repos see only their own artifacts',
    async () => {
      const N = 8;
      const setups = await Promise.all(
        Array.from({ length: N }, async (_, i) => {
          const repo = await spinUpRepo();
          const xdg = await makeXdgState();
          const globalRoot = await makeGlobalRoot();
          const agent = makeAgent({
            cwd: repo.path,
            env: {
              CLAUDE_SESSION_ID: `concurrency-list-${i}`,
              XDG_STATE_HOME: xdg,
              ORCAOPS_GLOBAL_ROOT: globalRoot,
            },
          });
          await agent.init({ noLlm: true });
          const plan = await agent.capturePlan(
            {
              task: `task-${i}`,
              label: `repo-${i}`,
              plan_steps: [{ text: 'step', label: 'step' }],
              touched_scope: [],
            },
            { noLlm: true }
          );
          return { agent, expectedArtifactId: plan.artifact_id, idx: i };
        })
      );

      const results = await Promise.all(setups.map((s) => s.agent.list()));

      setups.forEach((s, i) => {
        const ids = results[i].artifacts.map((a) => a.id);
        expect(ids, `agent ${i} should see exactly its own artifact`).toEqual([
          s.expectedArtifactId,
        ]);
      });
    },
    STRESS_TIMEOUT_MS
  );

  it(
    '8 parallel capturePlan() calls write to distinct artifact stores',
    async () => {
      const N = 8;
      const agents = await Promise.all(
        Array.from({ length: N }, async (_, i) => {
          const repo = await spinUpRepo();
          const xdg = await makeXdgState();
          const globalRoot = await makeGlobalRoot();
          const agent = makeAgent({
            cwd: repo.path,
            env: {
              CLAUDE_SESSION_ID: `concurrency-cap-${i}`,
              XDG_STATE_HOME: xdg,
              ORCAOPS_GLOBAL_ROOT: globalRoot,
            },
          });
          await agent.init({ noLlm: true });
          return agent;
        })
      );

      const plans = await Promise.all(
        agents.map((agent, i) =>
          agent.capturePlan(
            {
              task: `parallel-task-${i}`,
              label: `parallel-${i}`,
              plan_steps: [{ text: `s${i}`, label: `s${i}` }],
              touched_scope: [],
            },
            { noLlm: true }
          )
        )
      );

      const ids = plans.map((p) => p.artifact_id);
      expect(new Set(ids).size, 'all artifact_ids must be unique').toBe(N);

      // Cross-verify: each agent's list() sees its own artifact only.
      const lists = await Promise.all(agents.map((a) => a.list()));
      lists.forEach((listResult, i) => {
        expect(listResult.artifacts.map((a) => a.id)).toEqual([ids[i]]);
      });
    },
    STRESS_TIMEOUT_MS
  );

  it(
    'parallel pin operations with distinct CLAUDE_SESSION_IDs land in distinct shell-key dirs',
    async () => {
      // Each agent runs in its OWN repo (separate repoId) AND its own
      // CLAUDE_SESSION_ID. Both axes contribute to pin file path
      // isolation; this test confirms neither axis is collapsed by a
      // global mutation.
      const N = 6;
      const xdgRoot = await makeXdgState();
      const agents = await Promise.all(
        Array.from({ length: N }, async (_, i) => {
          const repo = await spinUpRepo();
          // One shared XDG root on purpose — this test's subject is that repo id
          // and session id are what separate the pin paths. The global root is
          // still per-agent: the install lock under it is not what is being
          // measured, and sharing it serializes the agents against a ten-second
          // acquire budget.
          const agent = makeAgent({
            cwd: repo.path,
            env: {
              CLAUDE_SESSION_ID: `concurrency-pin-${i}`,
              XDG_STATE_HOME: xdgRoot,
              ORCAOPS_GLOBAL_ROOT: await makeGlobalRoot(),
            },
          });
          await agent.init({ noLlm: true });
          const plan = await agent.capturePlan(
            {
              task: `pin-task-${i}`,
              label: `pin-${i}`,
              plan_steps: [{ text: 's', label: 's' }],
              touched_scope: [],
            },
            { noLlm: true }
          );
          return { agent, repoPath: repo.path, artifactId: plan.artifact_id, idx: i };
        })
      );

      // Drive a pin write on each agent in parallel (explicit checkout).
      const pinResults = await Promise.all(
        agents.map((s) =>
          s.agent.run<{
            ok: true;
            pin_file: string;
            shell_key: { kind: string; value: string };
          }>(['checkout', s.artifactId, '--json'])
        )
      );

      pinResults.forEach((r, i) => {
        if (r.ok !== true) {
          throw new Error(
            `agent ${i}: expected ok:true from checkout, got error envelope: ${JSON.stringify(r)}`
          );
        }
        // Each pin file should embed this agent's session id in its
        // path (via the shell-key hash). Two pin files must not collide.
        expect(typeof r.pin_file).toBe('string');
      });

      const pinFiles = pinResults.map((r) => (r as { ok: true; pin_file: string }).pin_file);
      expect(new Set(pinFiles).size, 'all pin files must have distinct paths').toBe(N);

      // Each agent's status() should report its own pin, not anyone else's.
      const statuses = await Promise.all(agents.map((a) => a.agent.status()));
      statuses.forEach((s, i) => {
        const pin = (s as unknown as { current_pin: { artifact_id: string } | null }).current_pin;
        expect(pin, `agent ${i} status.current_pin must be non-null`).not.toBe(null);
        expect(pin!.artifact_id).toBe(agents[i].artifactId);
      });
    },
    STRESS_TIMEOUT_MS
  );

  it(
    'parallel expectError() calls unwind ALS cleanly so a follow-up list() still works',
    async () => {
      // Exercises CliExit propagation through the ALS frame: an error
      // path that throws should NOT leave ALS state pointing at the
      // failed agent's context, otherwise the next list() on a different
      // agent would see the wrong cwd.
      const N = 6;
      const setups = await Promise.all(
        Array.from({ length: N }, async (_, i) => {
          const repo = await spinUpRepo();
          const xdg = await makeXdgState();
          const globalRoot = await makeGlobalRoot();
          const agent = makeAgent({
            cwd: repo.path,
            env: {
              CLAUDE_SESSION_ID: `concurrency-unwind-${i}`,
              XDG_STATE_HOME: xdg,
              ORCAOPS_GLOBAL_ROOT: globalRoot,
            },
          });
          await agent.init({ noLlm: true });
          const plan = await agent.capturePlan(
            {
              task: `unwind-${i}`,
              label: `unwind-${i}`,
              plan_steps: [{ text: 's', label: 's' }],
              touched_scope: [],
            },
            { noLlm: true }
          );
          return { agent, expectedArtifactId: plan.artifact_id };
        })
      );

      // First, drive an error path on each agent concurrently
      // (UNKNOWN_ARTIFACT on a bogus id).
      await Promise.all(
        setups.map((s) => s.agent.expectError(['show', 'does-not-exist', '--json']))
      );

      // Then, after all the throws have unwound, run a normal list() on
      // each. Each agent should still see ITS OWN artifact only.
      const lists = await Promise.all(setups.map((s) => s.agent.list()));
      lists.forEach((listResult, i) => {
        expect(listResult.artifacts.map((a) => a.id)).toEqual([setups[i].expectedArtifactId]);
      });
    },
    STRESS_TIMEOUT_MS
  );

  it('CliExit is the actual sentinel thrown by emitError', async () => {
    // Sanity: confirm the runtime symbol the harness duck-types against
    // is the one imported here. If a future refactor splits CliExit
    // across multiple class definitions, this test catches it.
    expect(CliExit.name).toBe('CliExit');
    const sentinel = new CliExit(1);
    expect(sentinel.name).toBe('CliExit');
    expect(sentinel.code).toBe(1);
  });
});
