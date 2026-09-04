import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createLinkedWorktree,
  createTempRepo,
  gitClient,
  inputFile,
  type TempRepo,
} from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

/**
 * `--all-projects` on list / search / stats. Two archived projects (real CLI
 * lifecycles, archive enabled); queries fan out from inside and outside a repo.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function parseOk<T>(r: CliResult): T {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed as T;
}

describe('--all-projects', () => {
  let repoA: TempRepo;
  let repoB: TempRepo;
  let outside: string;
  let env: Record<string, string>;
  let agentA: ReturnType<typeof makeAgent>;
  let artifactA: string;
  let artifactB: string;

  /**
   * `alreadyEnabled`: a linked worktree of an initialized repo shares its
   * personal config from the git common dir, so it is neither initialized
   * again nor given its own archive setting.
   */
  async function setupProject(
    repo: TempRepo,
    task: string,
    opts: { alreadyEnabled?: boolean } = {}
  ): Promise<string> {
    const agent = makeAgent({ cwd: repo.path, env });
    if (!opts.alreadyEnabled) {
      parseOk(await agent.runRaw(['init', '--json', '--no-llm']));
      const configPath = await effectiveConfigPath(repo.path);
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      config.archive = { enabled: true, redact_secrets: false };
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    }
    const plan = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task,
            label: `${task} label`,
            plan_steps: [{ text: `do ${task}`, label: 's1' }],
            touched_scope: [],
          })
        ),
      ])
    );
    const stepId = plan.plan_steps[0].step_id;
    parseOk(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `open-${randomUUID()}`,
            artifact_id: plan.artifact_id,
            declared_step_ids: [stepId],
          })
        ),
      ])
    );
    parseOk(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `close-${randomUUID()}`,
            artifact_id: plan.artifact_id,
            n: 1,
            summary: `finished ${task} via zanzibar approach`,
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [stepId],
          })
        ),
      ])
    );
    return plan.artifact_id;
  }

  async function capturePlanOnly(
    agent: ReturnType<typeof makeAgent>,
    task: string
  ): Promise<string> {
    const plan = parseOk<{ artifact_id: string }>(
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task,
            label: `${task} label`,
            plan_steps: [{ text: `do ${task}`, label: 's1' }],
            touched_scope: [],
          })
        ),
      ])
    );
    return plan.artifact_id;
  }

  /** Unattributable non-tail rot: every projection read for the artifact refuses. */
  async function rotHotArtifact(repoPath: string, artifactId: string): Promise<void> {
    const dir = path.join(repoPath, '.orcaops', 'artifacts', artifactId);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"plan_captured"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');
    await rm(path.join(dir, 'artifact.json'), { force: true });
    await rm(path.join(dir, 'plan.json'), { force: true });
  }

  beforeEach(async () => {
    repoA = await createTempRepo({ initialBranch: 'main' });
    repoB = await createTempRepo({ initialBranch: 'main' });
    outside = await mkdtemp(path.join(tmpdir(), 'orcaops-nowhere-'));
    env = {
      ORCAOPS_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'orcaops-ap-data-')),
      XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-ap-cache-')),
    };
    agentA = makeAgent({ cwd: repoA.path, env });
    artifactA = await setupProject(repoA, 'alpha payments work');
    artifactB = await setupProject(repoB, 'beta search work');
  }, 60_000);

  afterEach(async () => {
    await repoA.cleanup();
    await repoB.cleanup();
  });

  it('list --all-projects merges both projects from inside a repo', async () => {
    const r = parseOk<{
      all_projects: boolean;
      projects: number;
      artifacts: Array<{ id: string; project: string; project_id: string }>;
    }>(await agentA.runRaw(['list', '--all-projects', '--json']));
    expect(r.projects).toBe(2);
    expect(r.artifacts).toHaveLength(2);
    const projectNames = new Set(r.artifacts.map((a) => a.project));
    expect(projectNames.size).toBe(2);
    expect(r.artifacts.every((a) => a.project_id.length > 0)).toBe(true);
  });

  it('includes archive-resident work from a linked worktree of the current project', async () => {
    const linked = await createLinkedWorktree(repoA.path, { branch: 'feature-linked' });
    try {
      const linkedArtifact = await setupProject(linked, 'linked worktree work', {
        alreadyEnabled: true,
      });
      const configPath = await effectiveConfigPath(repoA.path);
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      config.archive = { enabled: false, redact_secrets: false };
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

      const inside = parseOk<{ artifacts: Array<{ id: string }> }>(
        await agentA.runRaw(['list', '--all-projects', '--json'])
      );
      const neutral = parseOk<{ artifacts: Array<{ id: string }> }>(
        await makeAgent({ cwd: outside, env }).runRaw(['list', '--all-projects', '--json'])
      );
      const insideIds = inside.artifacts.map((artifact) => artifact.id).sort();
      expect(insideIds).toContain(linkedArtifact);
      expect(insideIds).toEqual(neutral.artifacts.map((artifact) => artifact.id).sort());
    } finally {
      await linked.cleanup();
    }
  });

  it('stats counts linked-worktree artifacts once in the current project rollup', async () => {
    const linked = await createLinkedWorktree(repoA.path, { branch: 'feature-stats' });
    try {
      await setupProject(linked, 'linked stats work', { alreadyEnabled: true });
      const inside = parseOk<{
        projects: Array<{ hot: boolean; artifacts: { total: number } }>;
        totals: { artifacts: number; checkpoints: number };
      }>(await agentA.runRaw(['stats', '--all-projects', '--json']));
      const neutral = parseOk<{ totals: { artifacts: number; checkpoints: number } }>(
        await makeAgent({ cwd: outside, env }).runRaw(['stats', '--all-projects', '--json'])
      );
      expect(inside.projects.find((project) => project.hot)?.artifacts.total).toBe(2);
      expect(inside.totals).toEqual(neutral.totals);
    } finally {
      await linked.cleanup();
    }
  });

  it('hot rows carry the probed lifecycle state, not the coarse status fold', async () => {
    const plannedId = await capturePlanOnly(agentA, 'gamma planned work');
    const r = parseOk<{
      artifacts: Array<{ id: string; state: string | null }>;
    }>(await agentA.runRaw(['list', '--all-projects', '--json']));
    const planned = r.artifacts.find((a) => a.id === plannedId);
    expect(planned?.state).toBe('planned');
    expect(planned).not.toHaveProperty('unreadable');
  });

  it('an unreadable hot row serves its index facts under the marker with state unknown', async () => {
    type Row = Record<string, unknown> & { id: string; state: string | null };
    const before = parseOk<{ artifacts: Row[] }>(
      await agentA.runRaw(['list', '--all-projects', '--json'])
    );
    const healthy = before.artifacts.find((a) => a.id === artifactA);
    expect(healthy?.state).toBe('active');
    expect(healthy).not.toHaveProperty('unreadable');

    await rotHotArtifact(repoA.path, artifactA);
    const after = parseOk<Record<string, unknown> & { artifacts: Row[] }>(
      await agentA.runRaw(['list', '--all-projects', '--json'])
    );
    const rotted = after.artifacts.find((a) => a.id === artifactA);
    // Index facts verbatim, store-derived state unknown — never substituted.
    expect(rotted).toEqual({ ...healthy, state: null, unreadable: true });
    // Row-level disclosure only: the S5 envelope carries no
    // degraded_artifacts key during the freeze.
    expect('degraded_artifacts' in after).toBe(false);
  });

  it('a --state filter keeps unreadable hot rows in-band across coarse buckets', async () => {
    const plannedId = await capturePlanOnly(agentA, 'gamma planned work');
    await rotHotArtifact(repoA.path, artifactA);

    // The rotted artifact sits in SQLite's active bucket; a summarized
    // filter must still surface it as a degraded row.
    const summarized = parseOk<{
      artifacts: Array<{ id: string; state: string | null; unreadable?: boolean }>;
    }>(await agentA.runRaw(['list', '--all-projects', '--state', 'summarized', '--json']));
    expect(summarized.artifacts.map((a) => a.id)).toEqual([artifactA]);
    expect(summarized.artifacts[0].state).toBeNull();
    expect(summarized.artifacts[0].unreadable).toBe(true);

    const planned = parseOk<{
      artifacts: Array<{ id: string; state: string | null }>;
    }>(await agentA.runRaw(['list', '--all-projects', '--state', 'planned', '--json']));
    expect(planned.artifacts.map((a) => a.id).sort()).toEqual([plannedId, artifactA].sort());
    expect(planned.artifacts.find((a) => a.id === plannedId)?.state).toBe('planned');
  });

  it('archive-served rows keep the coarse fold and honor the coarse prefilter', async () => {
    const r = parseOk<{
      artifacts: Array<{ id: string; state: string | null }>;
    }>(await agentA.runRaw(['list', '--all-projects', '--json']));
    const beta = r.artifacts.find((a) => a.id === artifactB);
    expect(beta?.state).toBe('active');
    expect(beta).not.toHaveProperty('unreadable');

    // artifactB is in the archive's active bucket: the archive arm's
    // coarse prefilter excludes it from a summarized sweep.
    const filtered = parseOk<{ artifacts: Array<{ id: string }> }>(
      await agentA.runRaw(['list', '--all-projects', '--state', 'summarized', '--json'])
    );
    expect(filtered.artifacts.map((a) => a.id)).not.toContain(artifactB);
  });

  it.each(['planned', 'blocked'] as const)(
    'discloses archive-only projects that cannot evaluate a %s state filter',
    async (state) => {
      const result = parseOk<{
        artifacts: Array<{ id: string }>;
        warnings: Array<{
          kind: string;
          state: string;
          projects: Array<{ project_id: string; project: string }>;
          message: string;
        }>;
      }>(await agentA.runRaw(['list', '--all-projects', '--state', state, '--json']));
      expect(result.warnings).toEqual([
        {
          kind: 'archive_state_filter_unevaluable',
          state,
          projects: [
            expect.objectContaining({
              project_id: expect.any(String),
              project: expect.any(String),
            }),
          ],
          message: `Archive-only projects do not retain exact ${state} state; matching artifacts may be omitted.`,
        },
      ]);

      const human = await agentA.runRaw(['list', '--all-projects', '--state', state]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('No evaluable artifacts matched this state filter.');
      expect(human.stdout).not.toContain('No artifacts captured in any archived project.');
      expect(human.stdout).toContain('Warning: Partial state results');
      expect(human.stdout).toContain('matching artifacts may be omitted');
      expect(human.stdout).toContain(result.warnings[0].projects[0].project_id);
    }
  );

  it('does not warn for archive state filters that remain evaluable', async () => {
    const result = parseOk<Record<string, unknown>>(
      await agentA.runRaw(['list', '--all-projects', '--state', 'active', '--json'])
    );
    expect(result).not.toHaveProperty('warnings');
  });

  it('an unminted hot repo is disclosed in warnings while archived projects still serve', async () => {
    const repoC = await createTempRepo({ initialBranch: 'main' });
    try {
      const agentC = makeAgent({ cwd: repoC.path, env });
      parseOk(await agentC.runRaw(['init', '--json', '--no-llm']));
      // Init mints the project id eagerly and default-ON registers the repo
      // in the archive, so unwind both to reach the unminted state this
      // disclosure path exists for (a repo whose identity was never minted,
      // or was unset by hand).
      const mintedProjectId = (
        await gitClient(repoC.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
      ).trim();
      parseOk(await agentC.runRaw(['archive', 'disable', '--json']));
      parseOk(
        await agentC.runRaw(['archive', 'prune', '--project', mintedProjectId, '--apply', '--json'])
      );
      await gitClient(repoC.path).raw(['config', '--local', '--unset', 'orcaops.projectid']);
      const r = parseOk<{
        projects: number;
        artifacts: Array<{ id: string }>;
        warnings: Array<{
          kind: string;
          source: string;
          project_id: string | null;
          message: string;
        }>;
      }>(await agentC.runRaw(['list', '--all-projects', '--json']));
      expect(r.projects).toBe(2);
      expect(r.artifacts.map((a) => a.id).sort()).toEqual([artifactA, artifactB].sort());
      expect(r.warnings).toEqual([
        expect.objectContaining({
          kind: 'project_identity_unavailable',
          source: 'hot',
          project_id: null,
          message: expect.stringContaining('restore it with `git config --local orcaops.projectid'),
        }),
      ]);

      const human = await agentC.runRaw(['list', '--all-projects']);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('Partial project data');

      // The disclosure lives in the shared seam, so every --all-projects
      // surface carries it — pinned here on one non-list arm.
      const stats = parseOk<{
        warnings: Array<{ kind: string }>;
      }>(await agentC.runRaw(['stats', '--all-projects', '--json']));
      expect(stats.warnings).toEqual([
        expect.objectContaining({ kind: 'project_identity_unavailable' }),
      ]);
    } finally {
      await repoC.cleanup();
    }
  });

  it('fails loudly when the included hot project cannot be opened', async () => {
    await writeFile(await effectiveConfigPath(repoA.path), '{not-json', 'utf8');

    const result = await agentA.runRaw(['list', '--all-projects', '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL' },
    });
  });

  it('validates a poisoned hot store before returning identity guidance', async () => {
    const repoC = await createTempRepo({ initialBranch: 'main' });
    try {
      const agentC = makeAgent({ cwd: repoC.path, env });
      parseOk(await agentC.runRaw(['init', '--json', '--no-llm']));
      const configPath = await effectiveConfigPath(repoC.path);
      const healthyConfig = await readFile(configPath, 'utf8');

      await writeFile(configPath, '{not-json', 'utf8');
      const unminted = await agentC.runRaw(['list', '--all-projects', '--json']);
      expect(unminted.exitCode).toBe(1);
      expect(JSON.parse(unminted.stdout)).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL' },
      });

      await writeFile(configPath, healthyConfig, 'utf8');
      await gitClient(repoC.path).raw(['config', '--local', 'orcaops.projectid', 'not-a-uuid']);
      await writeFile(configPath, '{not-json', 'utf8');
      const invalidIdentity = await agentC.runRaw(['list', '--all-projects', '--json']);
      expect(invalidIdentity.exitCode).toBe(1);
      expect(JSON.parse(invalidIdentity.stdout)).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL' },
      });
    } finally {
      await repoC.cleanup();
    }
  });

  it('documents current-project archive inclusion and freshness selection', async () => {
    for (const command of ['list', 'decisions', 'loose-ends', 'stats', 'search']) {
      const result = await agentA.runRaw([command, '--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('retained archive');
      expect(result.stdout).toMatch(/ties\s+use hot/);
    }
  });

  it('returns archived projects with an actionable warning when the hot identity is invalid', async () => {
    await gitClient(repoA.path).raw(['config', '--local', 'orcaops.projectid', 'not-a-uuid']);
    const r = parseOk<{
      projects: number;
      artifacts: Array<{ id: string }>;
      warnings: Array<{ kind: string; source: string; message: string }>;
    }>(await agentA.runRaw(['list', '--all-projects', '--json']));

    expect(r.projects).toBe(2);
    expect(r.artifacts).toHaveLength(2);
    expect(r.warnings).toEqual([
      expect.objectContaining({
        kind: 'project_identity_unavailable',
        source: 'hot',
        message: expect.stringContaining('git config --local --unset orcaops.projectid'),
      }),
    ]);

    const human = await agentA.runRaw(['list', '--all-projects']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('Partial project data');
    expect(human.stdout).toContain('git config --local --unset orcaops.projectid');
  });

  it('returns archived projects when hot identity cannot be read from a subdirectory', async () => {
    const nested = path.join(repoA.path, 'nested');
    await mkdir(nested);
    const configPath = path.join(repoA.path, '.git', 'config');
    const healthyConfig = await readFile(configPath);
    await writeFile(configPath, '[broken\n', 'utf8');
    let raw: CliResult;
    try {
      raw = await makeAgent({ cwd: nested, env }).runRaw(['list', '--all-projects', '--json']);
    } finally {
      await writeFile(configPath, healthyConfig);
    }
    const result = parseOk<{
      projects: number;
      artifacts: Array<{ id: string }>;
      warnings: Array<{ kind: string; source: string; message: string }>;
    }>(raw);

    expect(result.projects).toBe(2);
    expect(result.artifacts).toHaveLength(2);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        kind: 'project_identity_unavailable',
        source: 'hot',
        message: expect.stringContaining('could not read git config orcaops.projectid'),
      }),
    ]);
  });

  it('keeps archive repair guidance when identity and artifact issues coexist', async () => {
    const projectId = (
      await gitClient(repoB.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const logPath = path.join(
      env.ORCAOPS_DATA_DIR,
      'projects',
      projectId,
      'artifacts',
      artifactB,
      'events.ndjson'
    );
    const lines = (await readFile(logPath, 'utf8')).trimEnd().split('\n');
    await writeFile(
      logPath,
      `${lines
        .filter((line) => (JSON.parse(line) as { type: string }).type !== 'checkpoint_opened')
        .join('\n')}\n`,
      'utf8'
    );
    await gitClient(repoA.path).raw(['config', '--local', 'orcaops.projectid', 'not-a-uuid']);

    const human = await agentA.runRaw(['search', 'zanzibar', '--all-projects']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('Partial project data');
    expect(human.stdout).toContain('not a canonical UUIDv7');
    expect(human.stdout).toContain('no matching prior checkpoint_opened');
    expect(human.stdout).toContain('orcaops archive repair');
  });

  it('list/search/stats --all-projects work from OUTSIDE any repo', async () => {
    const agent = makeAgent({ cwd: outside, env });
    const list = parseOk<{ artifacts: Array<{ id: string }> }>(
      await agent.runRaw(['list', '--all-projects', '--json'])
    );
    expect(list.artifacts).toHaveLength(2);

    const search = parseOk<{
      count: number;
      results: Array<{ artifact_id: string; project: string }>;
    }>(await agent.runRaw(['search', 'zanzibar', '--all-projects', '--json']));
    expect(search.count).toBeGreaterThanOrEqual(2);
    expect(search.results.some((x) => x.artifact_id === artifactB)).toBe(true);

    const stats = parseOk<{
      projects: Array<{ project_id: string; artifacts: { total: number } }>;
      totals: { artifacts: number };
    }>(await agent.runRaw(['stats', '--all-projects', '--json']));
    expect(stats.projects).toHaveLength(2);
    expect(stats.totals.artifacts).toBe(2);
  });

  it('stats --all-projects keeps its envelope and store counts with an unreadable hot artifact', async () => {
    await rotHotArtifact(repoA.path, artifactA);
    const r = parseOk<
      Record<string, unknown> & {
        projects: Array<Record<string, unknown> & { hot: boolean; artifacts: { total: number } }>;
        totals: { artifacts: number };
      }
    >(await agentA.runRaw(['stats', '--all-projects', '--json']));
    // No probe, no disclosure key: the named deferred gap, pinned as-is.
    expect(Object.keys(r).sort()).toEqual(['all_projects', 'ok', 'projects', 'totals']);
    for (const p of r.projects) {
      expect(Object.keys(p).sort()).toEqual([
        'artifacts',
        'checkpoints',
        'coding_sessions',
        'hot',
        'project',
        'project_id',
        'summaries',
      ]);
    }
    // Store counts are index facts and still include the unreadable member.
    const hot = r.projects.find((p) => p.hot);
    expect(hot?.artifacts.total).toBe(1);
    expect(r.totals.artifacts).toBe(2);
  });

  it('interval-overlap activity window works cross-project', async () => {
    const agent = makeAgent({ cwd: outside, env });
    const r = parseOk<{ artifacts: Array<{ id: string }> }>(
      await agent.runRaw(['list', '--all-projects', '--active-since', '2000-01-01', '--json'])
    );
    expect(r.artifacts).toHaveLength(2);
    const none = parseOk<{ artifacts: Array<{ id: string }> }>(
      await agent.runRaw(['list', '--all-projects', '--active-until', '2001-01-01', '--json'])
    );
    expect(none.artifacts).toHaveLength(0);
  });

  it('search quarantines one incomplete artifact and returns healthy results with a visible warning', async () => {
    const projectId = (
      await gitClient(repoB.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const logPath = path.join(
      env.ORCAOPS_DATA_DIR,
      'projects',
      projectId,
      'artifacts',
      artifactB,
      'events.ndjson'
    );
    const lines = (await readFile(logPath, 'utf8')).trimEnd().split('\n');
    await writeFile(
      logPath,
      `${lines
        .filter((line) => (JSON.parse(line) as { type: string }).type !== 'checkpoint_opened')
        .join('\n')}\n`,
      'utf8'
    );

    const agent = makeAgent({ cwd: outside, env });
    const result = parseOk<{
      count: number;
      results: Array<{ artifact_id: string }>;
      warnings: Array<{
        kind: string;
        project_id: string;
        artifact_id: string;
        message: string;
      }>;
    }>(await agent.runRaw(['search', 'zanzibar', '--all-projects', '--json']));
    expect(result.results.some((row) => row.artifact_id === artifactB)).toBe(false);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        kind: 'artifact_unavailable',
        project_id: projectId,
        artifact_id: artifactB,
        message: expect.stringContaining('no matching prior checkpoint_opened'),
      }),
    ]);

    const human = await agent.runRaw(['search', 'zanzibar', '--all-projects']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('Partial archive data');
    expect(human.stdout).toContain('orcaops archive repair');
  });

  it('rejects --branch and repo-anchored selectors with --all-projects', async () => {
    for (const args of [
      ['list', '--all-projects', '--branch', 'main', '--json'],
      ['list', '--all-projects', '--touching', 'src/x.ts', '--json'],
      ['list', '--all-projects', '--between', 'a..b', '--json'],
      ['search', 'x', '--all-projects', '--branch', 'main', '--json'],
    ]) {
      const r = await agentA.runRaw(args);
      expect(r.exitCode).not.toBe(0);
      const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
      expect(parsed.error.code).toBe('INVALID_INPUT');
    }
  });

  it('single-project search stays byte-compatible (no prefilter_truncated key below the cap)', async () => {
    const r = parseOk<Record<string, unknown>>(
      await agentA.runRaw(['search', 'zanzibar', '--scope', 'src/**', '--json'])
    );
    expect('prefilter_truncated' in r).toBe(false);
  });
});
