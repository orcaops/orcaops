import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

interface ListItem {
  id: string;
  branch: string;
  state: string;
}

describe('list / status / show: strict lineage-name filter', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function capturePlan(task: string): Promise<{ artifact_id: string }> {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task, plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    return JSON.parse(planRes.stdout) as { artifact_id: string };
  }

  async function jsonList(args: string[]): Promise<{ ok: boolean; artifacts: ListItem[] }> {
    const res = await agent.runRaw(args);
    expect(res.exitCode).toBe(0);
    return JSON.parse(res.stdout) as { ok: boolean; artifacts: ListItem[] };
  }

  describe('list', () => {
    it('defaults to current branch via lineage; an artifact captured on feat/x is hidden on main', async () => {
      const git = gitClient(repo.path);
      await git.checkoutLocalBranch('feat/x');
      await capturePlan('work on x');

      const onFeat = await jsonList(['list', '--json']);
      expect(onFeat.artifacts.map((a) => a.id)).toHaveLength(1);

      await git.checkout('main');
      const onMain = await jsonList(['list', '--json']);
      expect(onMain.artifacts).toEqual([]);
    });

    it('--all-branches lists every artifact regardless of current branch', async () => {
      const git = gitClient(repo.path);
      await git.checkoutLocalBranch('feat/x');
      await capturePlan('on x');
      await git.checkout('main');
      await capturePlan('on main');

      const all = await jsonList(['list', '--all-branches', '--json']);
      expect(all.artifacts).toHaveLength(2);
    });

    it('--branch <name> overrides the lineage filter to a different branch', async () => {
      const git = gitClient(repo.path);
      await git.checkoutLocalBranch('feat/x');
      await capturePlan('on x');
      await git.checkout('main');
      const onFeat = await jsonList(['list', '--branch', 'feat/x', '--json']);
      expect(onFeat.artifacts).toHaveLength(1);
    });

    it('after sync appends a new branch lineage entry, the artifact appears under both', async () => {
      const git = gitClient(repo.path);
      await git.checkoutLocalBranch('feat/x');
      const plan = await capturePlan('on x');

      await commitFile(repo.path, 'a.ts', 'a\n', 'extra commit');
      await agent.runRaw(['lineage', '--json']);

      const onFeat = await jsonList(['list', '--json']);
      expect(onFeat.artifacts.map((a) => a.id)).toEqual([plan.artifact_id]);

      await git.checkout('main');
      const onMain = await jsonList(['list', '--branch', 'feat/x', '--json']);
      expect(onMain.artifacts.map((a) => a.id)).toEqual([plan.artifact_id]);
    });

    it('--limit caps the number of artifacts returned', async () => {
      for (const task of ['t1', 't2', 't3']) {
        await capturePlan(task);
      }

      const all = await jsonList(['list', '--json']);
      expect(all.artifacts).toHaveLength(3);

      const capped = await jsonList(['list', '--limit', '2', '--json']);
      expect(capped.artifacts).toHaveLength(2);
    });

    it('--limit rejects non-positive values', async () => {
      const res = await agent.runRaw(['list', '--limit', '0', '--json']);
      expect(res.exitCode).toBe(1);
      const err = JSON.parse(res.stdout) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(err.ok).toBe(false);
      expect(err.error.code).toBe('INVALID_INPUT');
      expect(err.error.message).toBe('--limit must be a positive integer.');
    });

    it('--state filter combines with the lineage join', async () => {
      await capturePlan('t1');
      const all = await jsonList(['list', '--state', 'planned', '--json']);
      expect(all.artifacts).toHaveLength(1);
      expect(all.artifacts[0].state).toBe('planned');
      const summarizedOnly = await jsonList(['list', '--state', 'summarized', '--json']);
      expect(summarizedOnly.artifacts).toEqual([]);
    });
  });

  describe('status', () => {
    it('uses lineage filter (artifact captured on feat/x not in main status)', async () => {
      const git = gitClient(repo.path);
      await git.checkoutLocalBranch('feat/x');
      await capturePlan('on x');
      await git.checkout('main');
      const res = await agent.runRaw(['status', '--json']);
      const r = JSON.parse(res.stdout) as { branch: string; artifacts: unknown[] };
      expect(r.branch).toBe('main');
      expect(r.artifacts).toEqual([]);
    });

    it('survives a rotted sibling artifact, degrading that row with a warning', async () => {
      const a = await capturePlan('will rot');
      const b = await capturePlan('stays healthy');

      // Make A's artifact.json read refuse: delete the projection and rot
      // its plan line so the loss is unattributable.
      const aDir = path.join(repo.path, '.orcaops', 'artifacts', a.artifact_id);
      const aLog = path.join(aDir, 'events.ndjson');
      const lines = (await readFile(aLog, 'utf8')).split('\n');
      const i = lines.findIndex((l) => l.includes('"plan_captured"'));
      lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
      await writeFile(aLog, lines.join('\n'), 'utf8');
      await rm(path.join(aDir, 'artifact.json'), { force: true });
      await rm(path.join(aDir, 'plan.json'), { force: true });

      const res = await agent.runRaw(['status', '--json']);
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toMatch(/unreadable in status/);
      const out = JSON.parse(res.stdout) as Record<string, unknown> & {
        schema_version: number;
        artifacts: Array<{
          id: string;
          task: string;
          branch: string;
          started_at: string;
          completed_at: string | null;
          state: string | null;
          source_plan: unknown;
          open_checkpoints: unknown[];
          thread: { plan: { status: string } };
          capture_health: string;
          blocking_evaluators: unknown[];
          next_actions: unknown[];
          unreadable?: boolean;
        }>;
      };
      expect(out.artifacts.map((x) => x.id)).toContain(b.artifact_id);
      // The rotted artifact's true state is `planned` — the row must say
      // UNKNOWN, never a substituted state like "active".
      const rotted = out.artifacts.find((x) => x.id === a.artifact_id);
      expect(rotted?.state).toBeNull();
      expect(rotted?.unreadable).toBe(true);
      // Store-derived values follow their settled refusal vocabulary under
      // the marker (null here; [] for next_actions below); index facts and
      // index folds served verbatim/computed.
      expect(rotted?.source_plan).toBeNull();
      expect(rotted?.task).toBe('will rot');
      expect(rotted?.branch).toBe('main');
      expect(rotted?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(rotted?.completed_at).toBeNull();
      expect(rotted?.open_checkpoints).toEqual([]);
      expect(rotted?.thread.plan).toEqual({ status: 'done' });
      expect(rotted?.capture_health).toBe('ok');
      expect(rotted?.blocking_evaluators).toEqual([]);
      // next_actions rereads store projections and folds refusal to [] —
      // an empty list on a row marked unreadable means "unknown".
      expect(rotted?.next_actions).toEqual([]);
      // Rows disclose in-band; the v2 envelope itself has no disclosure key.
      expect(out.schema_version).toBe(2);
      expect('degraded_artifacts' in out).toBe(false);
    });

    it('plain list survives a rotted sibling: unknown state inline, degraded ids disclosed', async () => {
      const a = await capturePlan('will rot');
      const b = await capturePlan('stays healthy');
      const aDir = path.join(repo.path, '.orcaops', 'artifacts', a.artifact_id);
      const aLog = path.join(aDir, 'events.ndjson');
      const lines = (await readFile(aLog, 'utf8')).split('\n');
      const i = lines.findIndex((l) => l.includes('"plan_captured"'));
      lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
      await writeFile(aLog, lines.join('\n'), 'utf8');
      await rm(path.join(aDir, 'artifact.json'), { force: true });
      await rm(path.join(aDir, 'plan.json'), { force: true });

      const res = await agent.runRaw(['list', '--json']);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as {
        artifacts: Array<{ id: string; state: string | null; unreadable?: boolean }>;
        degraded_artifacts: string[];
      };
      expect(out.artifacts.map((x) => x.id)).toContain(b.artifact_id);
      expect(out.degraded_artifacts).toEqual([a.artifact_id]);
      const rotted = out.artifacts.find((x) => x.id === a.artifact_id);
      expect(rotted?.state).toBeNull();
      expect(rotted?.unreadable).toBe(true);

      // A state filter cannot evaluate the degraded row: it is excluded
      // from the match but still disclosed.
      const filtered = await agent.runRaw(['list', '--json', '--state', 'planned']);
      expect(filtered.exitCode).toBe(0);
      const fout = JSON.parse(filtered.stdout) as {
        artifacts: Array<{ id: string }>;
        degraded_artifacts: string[];
      };
      expect(fout.artifacts.map((x) => x.id)).not.toContain(a.artifact_id);
      expect(fout.degraded_artifacts).toEqual([a.artifact_id]);

      // CROSS-BUCKET: the rotted artifact sits in SQLite's active
      // bucket, but a summarized filter must still disclose it — a
      // coarse status prefilter would silently drop it before the
      // degradation path ever ran.
      const crossBucket = await agent.runRaw(['list', '--json', '--state', 'summarized']);
      expect(crossBucket.exitCode).toBe(0);
      const cOut = JSON.parse(crossBucket.stdout) as {
        artifacts: Array<{ id: string }>;
        degraded_artifacts: string[];
      };
      expect(cOut.artifacts.map((x) => x.id)).not.toContain(a.artifact_id);
      expect(cOut.degraded_artifacts).toEqual([a.artifact_id]);
    });

    it('neutralizes carriage returns in captured prose before human rendering', async () => {
      const task = 'visible task\rspoofed artifact id';
      await capturePlan(task);

      const res = await agent.runRaw(['status']);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain('\r');
      expect(res.stdout).toContain('visible taskspoofed artifact id');
    });
  });

  describe('show', () => {
    it('emits lineage_sha_drift: null when current HEAD matches the lineage entry', async () => {
      const plan = await capturePlan('t');
      const showRes = await agent.runRaw(['show', plan.artifact_id, '--json']);
      expect(showRes.exitCode).toBe(0);
      const show = JSON.parse(showRes.stdout) as {
        artifact: { lineage_sha_drift: unknown; branch_lineage: Array<{ branch: string }> };
      };
      expect(show.artifact.lineage_sha_drift).toBeNull();
      expect(show.artifact.branch_lineage[0].branch).toBe('main');
    });

    it('emits lineage_sha_drift when HEAD has moved past the recorded entry', async () => {
      const plan = await capturePlan('t');
      await commitFile(repo.path, 'b.ts', 'b\n', 'after artifact');

      const showRes = await agent.runRaw(['show', plan.artifact_id, '--json']);
      const show = JSON.parse(showRes.stdout) as {
        artifact: {
          lineage_sha_drift: { branch: string; recorded_sha: string; current_sha: string } | null;
        };
      };
      expect(show.artifact.lineage_sha_drift).not.toBeNull();
      expect(show.artifact.lineage_sha_drift?.branch).toBe('main');
      expect(show.artifact.lineage_sha_drift?.recorded_sha).not.toBe(
        show.artifact.lineage_sha_drift?.current_sha
      );
    });

    it('emits lineage_sha_drift: null when the current branch is not in the lineage at all', async () => {
      const plan = await capturePlan('on main');
      const git = gitClient(repo.path);
      await git.checkoutLocalBranch('feat/y');
      const showRes = await agent.runRaw(['show', plan.artifact_id, '--json']);
      const show = JSON.parse(showRes.stdout) as {
        artifact: { lineage_sha_drift: unknown };
      };
      expect(show.artifact.lineage_sha_drift).toBeNull();
    });
  });
});
