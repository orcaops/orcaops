import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { CliExit } from '../../src/io/exit.js';
import {
  fixture as databaseFixture,
  inventory as databaseInventory,
} from '../helpers/database-history.js';
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
              plan_steps: [
                {
                  text: 'step',
                  label: 'step',
                  acceptance_criteria: [{ text: 'the step is delivered' }],
                },
              ],
              touched_scope: [],
            },
            { noLlm: true }
          );
          return { agent, expectedArtifactId: plan.artifact_id, idx: i };
        })
      );

      const results = await Promise.all(setups.map((s) => s.agent.list()));

      setups.forEach((s, i) => {
        const ids = results[i].results.map((a) => a.id);
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
              plan_steps: [
                {
                  text: `s${i}`,
                  label: `s${i}`,
                  acceptance_criteria: [{ text: 'the step is delivered' }],
                },
              ],
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
        expect(listResult.results.map((a) => a.id)).toEqual([ids[i]]);
      });
    },
    STRESS_TIMEOUT_MS
  );

  it(
    'isolates concurrent database focus by original project and session',
    async () => {
      const { readProjectExecutionFocus } =
        await import('../../../../packages/storage/dist/history/database/execution-focus.js');
      const projects = [await databaseFixture(), await databaseFixture()];
      const tasks: Array<{
        f: Awaited<ReturnType<typeof databaseFixture>>;
        session: string;
        artifactId: string;
        agent: ReturnType<typeof makeAgent>;
      }> = [];
      for (const f of projects) {
        for (const session of ['session-a', 'session-b']) {
          const artifactId = await f.capture();
          tasks.push({
            f,
            session,
            artifactId,
            agent: makeAgent({
              cwd: f.main,
              env: {
                ORCAOPS_ROOT: f.main,
                ORCAOPS_DATA_DIR: f.root,
                ORCAOPS_DISABLE_DRAIN: '1',
                CLAUDE_SESSION_ID: '',
                CLAUDE_CODE_SESSION_ID: '',
                CODEX_SESSION_ID: session,
                TMUX_PANE: '',
                STY: '',
                WINDOW: '',
                TTY: '',
                XDG_STATE_HOME: f.temporary + '/unused-state',
              },
            }),
          });
        }
      }
      const outputs = await Promise.all(
        tasks.map(async ({ agent, artifactId }) => {
          const raw = await agent.runRaw(['checkout', artifactId, '--json']);
          expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
          return JSON.parse(raw.stdout);
        })
      );
      expect(new Set(outputs.map((x) => x.operation_id)).size).toBe(tasks.length);
      for (const { f, session, artifactId } of tasks) {
        expect(
          readProjectExecutionFocus(f.writer, {
            rootKey: f.authority.rootKey,
            projectId: f.authority.projectId,
            storeInstanceId: f.authority.storeInstanceId,
            repositoryInstanceId: f.authority.repositoryInstanceId,
            worktreeId: f.context.worktreeId!,
            shellKey: { kind: 'codex_session', value: session },
          })
        ).toMatchObject({ status: 'present', pin: { artifact_id: artifactId } });
      }
      const before = await Promise.all(projects.map((f) => databaseInventory(f.temporary)));
      const statuses = await Promise.all(
        tasks.map(({ agent }) => agent.runRaw(['status', '--json']))
      );
      statuses.forEach((raw, i) => {
        expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
        expect(JSON.parse(raw.stdout).focus).toContainEqual(
          expect.objectContaining({
            project_id: tasks[i].f.authority.projectId,
            pin: expect.objectContaining({ artifact_id: tasks[i].artifactId }),
          })
        );
      });
      expect(await Promise.all(projects.map((f) => databaseInventory(f.temporary)))).toEqual(
        before
      );
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
              plan_steps: [
                { text: 's', label: 's', acceptance_criteria: [{ text: 'the step is delivered' }] },
              ],
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
        expect(listResult.results.map((a) => a.id)).toEqual([setups[i].expectedArtifactId]);
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
