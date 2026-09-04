import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
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
import { commitFile, effectiveConfigPath } from '../support/test-helpers.js';

/**
 * `--all-projects` on decisions / loose-ends. The load-bearing
 * case: project B's WORKTREE IS DELETED after capture, so its thread
 * content must come entirely from archive events via the rebuilders
 * (deferred_decisions and summary content are deliberately not
 * materialized in the index).
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

describe('--all-projects decisions/loose-ends', () => {
  let repoA: TempRepo;
  let repoB: TempRepo;
  let repoBGone = false;
  let env: Record<string, string>;
  let agentA: ReturnType<typeof makeAgent>;
  let artifactB: string;

  beforeEach(async () => {
    repoA = await createTempRepo({ initialBranch: 'main' });
    repoB = await createTempRepo({ initialBranch: 'main' });
    repoBGone = false;
    env = {
      ORCAOPS_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'orcaops-ins-data-')),
      XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-ins-cache-')),
    };
    agentA = makeAgent({ cwd: repoA.path, env });
    parseOk(await agentA.runRaw(['init', '--json', '--no-llm']));
    await enableArchive(repoA.path);

    // Project B: plan-time decision + checkpoint decision + an uncovered
    // step + no summary — then the worktree disappears.
    const agentB = makeAgent({ cwd: repoB.path, env });
    parseOk(await agentB.runRaw(['init', '--json', '--no-llm']));
    await enableArchive(repoB.path);
    const plan = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
      await agentB.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'beta caching work',
            label: 'beta caching work',
            plan_steps: [
              { text: 'implement the cache', label: 's1' },
              { text: 'wire the cache invalidation', label: 's2' },
            ],
            touched_scope: [],
            decisions: [
              {
                decision: 'use write-through caching for beta',
                reason: 'read-heavy traffic profile',
              },
            ],
          })
        ),
      ])
    );
    artifactB = plan.artifact_id;
    const stepId = plan.plan_steps[0].step_id;
    parseOk(
      await agentB.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `open-${randomUUID()}`,
            artifact_id: artifactB,
            declared_step_ids: [stepId],
          })
        ),
      ])
    );
    parseOk(
      await agentB.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `close-${randomUUID()}`,
            artifact_id: artifactB,
            n: 1,
            summary: 'cache implemented',
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [stepId],
            decisions: [
              {
                decision: 'LRU eviction over TTL for beta cache',
                reason: 'bounded memory matters more than freshness here',
              },
            ],
            uncertainty: ['eviction tuning under real load'],
          })
        ),
      ])
    );
    // The whole point: delete project B's worktree.
    await repoB.cleanup();
    repoBGone = true;
  }, 60_000);

  afterEach(async () => {
    await repoA.cleanup();
    if (!repoBGone) await repoB.cleanup();
  });

  async function enableArchive(repoPath: string): Promise<void> {
    const configPath = await effectiveConfigPath(repoPath);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.archive = { enabled: true, redact_secrets: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  it('decisions --all-projects surfaces an archived-only artifact (worktree deleted)', async () => {
    const r = parseOk<{
      all_projects: boolean;
      artifacts: Array<{
        artifact_id: string;
        project: string;
        records: Array<{ source: string; decision: string }>;
      }>;
    }>(await agentA.runRaw(['decisions', '--all-projects', '--json']));
    const beta = r.artifacts.find((a) => a.artifact_id === artifactB);
    expect(beta).toBeDefined();
    const sources = new Set(beta?.records.map((x) => x.source));
    expect(sources.has('plan')).toBe(true);
    expect(sources.has('checkpoint')).toBe(true);
    expect(beta?.records.some((x) => x.decision.includes('write-through'))).toBe(true);
    expect(beta?.records.some((x) => x.decision.includes('LRU eviction'))).toBe(true);
  });

  it('loose-ends --all-projects surfaces the archived-only artifact findings', async () => {
    const r = parseOk<{
      artifacts: Array<{
        artifact_id: string;
        project: string;
        no_summary: boolean;
        uncovered_steps: Array<{ label: string }>;
        uncertainty: Array<{ checkpoint_n: number; entries: string[] }>;
      }>;
    }>(await agentA.runRaw(['loose-ends', '--all-projects', '--json']));
    const beta = r.artifacts.find((a) => a.artifact_id === artifactB);
    expect(beta).toBeDefined();
    expect(beta?.no_summary).toBe(true);
    expect(beta?.uncovered_steps.some((s) => s.label === 's2')).toBe(true);
    expect(
      beta?.uncertainty.some((u) => u.entries.includes('eviction tuning under real load'))
    ).toBe(true);
  });

  it('serves decisions and loose ends captured in a linked worktree of the current project', async () => {
    const linked = await createLinkedWorktree(repoA.path, { branch: 'feature-insights' });
    try {
      // The shared personal install already enables the linked worktree.
      const linkedAgent = makeAgent({ cwd: linked.path, env });
      await enableArchive(linked.path);
      const plan = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
        await linkedAgent.runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(
            JSON.stringify({
              task: 'linked insight work',
              label: 'linked insight work',
              plan_steps: [
                { text: 'finish linked insight', label: 'linked-1' },
                { text: 'defer linked follow-up', label: 'linked-2' },
              ],
              touched_scope: [],
              decisions: [
                {
                  decision: 'use the linked insight path',
                  reason: 'the sibling worktree owns this work',
                },
              ],
            })
          ),
        ])
      );
      parseOk(
        await linkedAgent.runRaw([
          'capture',
          'checkpoint',
          'open',
          '--no-llm',
          '--input',
          inputFile(
            JSON.stringify({
              artifact_id: plan.artifact_id,
              declared_step_ids: [plan.plan_steps[0].step_id],
            })
          ),
        ])
      );
      parseOk(
        await linkedAgent.runRaw([
          'capture',
          'checkpoint',
          'close',
          '--no-llm',
          '--input',
          inputFile(
            JSON.stringify({
              artifact_id: plan.artifact_id,
              summary: 'linked insight checkpoint',
              verification: [{ command: 'test fixture', exit_code: 0 }],
              completed_step_ids: [plan.plan_steps[0].step_id],
              uncertainty: ['linked insight follow-up remains'],
            })
          ),
        ])
      );

      const decisions = parseOk<{
        artifacts: Array<{ artifact_id: string; records: Array<{ decision: string }> }>;
      }>(await agentA.runRaw(['decisions', '--all-projects', '--json']));
      expect(
        decisions.artifacts
          .find((artifact) => artifact.artifact_id === plan.artifact_id)
          ?.records.some((record) => record.decision === 'use the linked insight path')
      ).toBe(true);

      const looseEnds = parseOk<{
        artifacts: Array<{
          artifact_id: string;
          uncovered_steps: Array<{ label: string }>;
          uncertainty: Array<{ entries: string[] }>;
        }>;
      }>(await agentA.runRaw(['loose-ends', '--all-projects', '--json']));
      const linkedLooseEnds = looseEnds.artifacts.find(
        (artifact) => artifact.artifact_id === plan.artifact_id
      );
      expect(linkedLooseEnds?.uncovered_steps.map((step) => step.label)).toContain('linked-2');
      expect(linkedLooseEnds?.uncertainty.flatMap((entry) => entry.entries)).toContain(
        'linked insight follow-up remains'
      );

      const search = parseOk<{ results: Array<{ artifact_id: string }> }>(
        await agentA.runRaw(['search', 'linked insight', '--all-projects', '--json'])
      );
      expect(search.results.map((result) => result.artifact_id)).toContain(plan.artifact_id);
    } finally {
      await linked.cleanup();
    }
  });

  it('keeps a zero-finding hot row when its log becomes unreadable', async () => {
    const plan = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
      await agentA.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'quiet alpha work',
            label: 'quiet alpha work',
            plan_steps: [{ text: 'finish it', label: 'only' }],
            touched_scope: [],
          })
        ),
      ])
    );
    const stepId = plan.plan_steps[0].step_id;
    parseOk(
      await agentA.runRaw([
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
      await agentA.runRaw([
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
            summary: 'done quietly',
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [stepId],
          })
        ),
      ])
    );
    parseOk(
      await agentA.runRaw([
        'capture',
        'pre-pr-check',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `prepr-${randomUUID()}`,
            artifact_id: plan.artifact_id,
          })
        ),
      ])
    );
    parseOk(
      await agentA.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `summary-${randomUUID()}`,
            artifact_id: plan.artifact_id,
            outcome: 'done',
          })
        ),
      ])
    );
    await commitFile(repoA.path, 'src/later.ts', 'export const later = true;\n', 'later work');
    parseOk(await agentA.runRaw(['lineage', '--json']));
    const log = path.join(repoA.path, '.orcaops', 'artifacts', plan.artifact_id, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
    expect(lines.at(-1)).toContain('"branch_lineage_updated"');
    await writeFile(log, `${lines.slice(0, -1).join('\n')}\n`, 'utf8');

    const result = parseOk<{
      artifacts: Array<{ artifact_id: string; unreadable?: boolean; finding_count: number }>;
    }>(await agentA.runRaw(['loose-ends', '--all-projects', '--json']));
    const rows = result.artifacts.filter((artifact) => artifact.artifact_id === plan.artifact_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        artifact_id: plan.artifact_id,
        unreadable: true,
        finding_count: 1,
      })
    );
  });

  it('a lossy archived project is quarantined AND disclosed as degraded, not silently absent', async () => {
    // Rot an interior line of B's ARCHIVED log: the index refresh
    // quarantines the thread (never serving survivor-only rebuilds),
    // and both commands must name the artifact in degraded_artifacts
    // rather than letting it vanish with only a warnings[] entry.
    const { globSync } = await import('node:fs');
    const logs = globSync(path.join(env.ORCAOPS_DATA_DIR, '**', artifactB, 'events.ndjson'));
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      const lines = (await readFile(log, 'utf8')).trimEnd().split('\n');
      const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
      if (i === -1) continue;
      lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
      await writeFile(log, lines.join('\n') + '\n', 'utf8');
    }

    const dec = parseOk<{
      artifacts: Array<{ artifact_id: string }>;
      degraded_artifacts: string[];
    }>(await agentA.runRaw(['decisions', '--all-projects', '--json']));
    expect(dec.artifacts.map((a) => a.artifact_id)).not.toContain(artifactB);
    expect(dec.degraded_artifacts).toContain(artifactB);

    const le = parseOk<{
      artifacts: Array<{ artifact_id: string }>;
      degraded_artifacts: string[];
    }>(await agentA.runRaw(['loose-ends', '--all-projects', '--json']));
    expect(le.artifacts.map((a) => a.artifact_id)).not.toContain(artifactB);
    expect(le.degraded_artifacts).toContain(artifactB);
  });

  it('serves a healthy hot twin without labeling it degraded when the archive twin is quarantined', async () => {
    const plan = parseOk<{ artifact_id: string }>(
      await agentA.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'healthy hot insight work',
            label: 'healthy hot insight work',
            plan_steps: [
              { text: 'complete the healthy hot work', label: 'hot-1' },
              { text: 'retain the healthy hot follow-up', label: 'hot-2' },
            ],
            touched_scope: [],
            decisions: [
              {
                decision: 'serve the healthy hot projection',
                reason: 'the archive twin is not the selected source',
              },
            ],
          })
        ),
      ])
    );
    const projectId = (
      await gitClient(repoA.path).raw(['config', '--local', '--get', 'orcaops.projectId'])
    ).trim();
    const archiveLog = path.join(
      env.ORCAOPS_DATA_DIR,
      'projects',
      projectId,
      'artifacts',
      plan.artifact_id,
      'events.ndjson'
    );
    const lines = (await readFile(archiveLog, 'utf8')).trimEnd().split('\n');
    const planLine = lines.findIndex((line) => line.includes('"plan_captured"'));
    expect(planLine).toBeGreaterThanOrEqual(0);
    lines[planLine] = lines[planLine].replace(
      /"checksum":"[0-9a-f]{64}"/,
      `"checksum":"${'0'.repeat(64)}"`
    );
    await writeFile(archiveLog, `${lines.join('\n')}\n`, 'utf8');

    const decisions = parseOk<{
      artifacts: Array<{ artifact_id: string }>;
      degraded_artifacts: string[];
      warnings: Array<{ kind: string; artifact_id?: string }>;
    }>(await agentA.runRaw(['decisions', '--all-projects', '--json']));
    expect(decisions.artifacts.map((artifact) => artifact.artifact_id)).toContain(plan.artifact_id);
    expect(decisions.degraded_artifacts).not.toContain(plan.artifact_id);
    expect(decisions.warnings).toContainEqual(
      expect.objectContaining({ kind: 'artifact_unavailable', artifact_id: plan.artifact_id })
    );

    const looseEnds = parseOk<{
      artifacts: Array<{ artifact_id: string }>;
      degraded_artifacts: string[];
      warnings: Array<{ kind: string; artifact_id?: string }>;
    }>(await agentA.runRaw(['loose-ends', '--all-projects', '--json']));
    expect(looseEnds.artifacts.map((artifact) => artifact.artifact_id)).toContain(plan.artifact_id);
    expect(looseEnds.degraded_artifacts).not.toContain(plan.artifact_id);
    expect(looseEnds.warnings).toContainEqual(
      expect.objectContaining({ kind: 'artifact_unavailable', artifact_id: plan.artifact_id })
    );
  });

  it('search --all-projects marks hot-store hits from an unreadable artifact', async () => {
    // A hot artifact in project A whose log rots after indexing: the
    // all-projects arm substitutes the hot store, so the hit must carry
    // the same marker the single-project arm gained.
    const plan = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
      await agentA.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'alpha zebrafish work',
            label: 'alpha zebrafish work',
            plan_steps: [{ text: 'zebrafish step', label: 's1' }],
            touched_scope: [],
          })
        ),
      ])
    );
    const dir = path.join(repoA.path, '.orcaops', 'artifacts', plan.artifact_id);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"plan_captured"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');

    const res = parseOk<{
      degraded_artifacts: string[];
      results: Array<{ artifact_id: string; unreadable?: boolean }>;
    }>(await agentA.runRaw(['search', 'zebrafish', '--all-projects', '--json']));
    const hits = res.results.filter((r) => r.artifact_id === plan.artifact_id);
    expect(hits.length).toBeGreaterThan(0);
    for (const r of hits) expect(r.unreadable).toBe(true);
    expect(res.degraded_artifacts).toContain(plan.artifact_id);

    // Readable HOT multi-hit case: a healthy project-A artifact whose
    // task and summary both match — at least two hits, all unmarked and
    // undisclosed (the visited-pairs set keeps the probe to one per
    // pair; behavior pinned here, cardinality by code inspection).
    const healthy = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
      await agentA.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'wombat pipeline work',
            label: 'wombat pipeline work',
            plan_steps: [{ text: 'wombat step one', label: 's1' }],
            touched_scope: [],
          })
        ),
      ])
    );
    parseOk(
      await agentA.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `open-${randomUUID()}`,
            artifact_id: healthy.artifact_id,
            declared_step_ids: [healthy.plan_steps[0].step_id],
          })
        ),
      ])
    );
    parseOk(
      await agentA.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `close-${randomUUID()}`,
            artifact_id: healthy.artifact_id,
            n: 1,
            summary: 'wombat wiring finished',
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [healthy.plan_steps[0].step_id],
          })
        ),
      ])
    );
    const readable = parseOk<{
      degraded_artifacts: string[];
      results: Array<{ artifact_id: string; unreadable?: boolean }>;
    }>(await agentA.runRaw(['search', 'wombat', '--all-projects', '--json']));
    const readableHits = readable.results.filter((r) => r.artifact_id === healthy.artifact_id);
    expect(readableHits.length).toBeGreaterThanOrEqual(2);
    for (const r of readableHits) expect(r.unreadable).toBeUndefined();
    expect(readable.degraded_artifacts).not.toContain(healthy.artifact_id);
  });

  it('discloses malformed touched_scope when all-project scope filtering drops a hit', async () => {
    const plan = parseOk<{ artifact_id: string }>(
      await agentA.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'narwhal scope fixture',
            label: 'narwhal scope fixture',
            plan_steps: [{ text: 'narwhal work', label: 's1' }],
            touched_scope: ['src/narwhal.ts'],
          })
        ),
      ])
    );
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(repoA.path, '.orcaops', 'cache', 'orcaops.db'));
    try {
      db.prepare('UPDATE plans SET touched_scope = ? WHERE artifact_id = ?').run(
        '{not-json',
        plan.artifact_id
      );
    } finally {
      db.close();
    }
    const hotLog = path.join(
      repoA.path,
      '.orcaops',
      'artifacts',
      plan.artifact_id,
      'events.ndjson'
    );
    const hotNewer = new Date(Date.now() + 60_000);
    await utimes(hotLog, hotNewer, hotNewer);

    const result = parseOk<{
      warnings: Array<{ kind: string; project_id: string; message: string }>;
      results: Array<{ artifact_id: string }>;
    }>(await agentA.runRaw(['search', 'narwhal', '--all-projects', '--scope', 'src/**', '--json']));
    expect(result.results.map((row) => row.artifact_id)).not.toContain(plan.artifact_id);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        kind: 'project_index_degraded',
        message: expect.stringContaining(plan.artifact_id),
      })
    );
  });

  it('rejects --branch and --artifact with --all-projects', async () => {
    for (const args of [
      ['decisions', '--all-projects', '--branch', 'main', '--json'],
      ['decisions', '--all-projects', '--artifact', artifactB, '--json'],
      ['loose-ends', '--all-projects', '--branch', 'main', '--json'],
      ['loose-ends', '--all-projects', '--artifact', artifactB, '--json'],
    ]) {
      const r = await agentA.runRaw(args);
      expect(r.exitCode).not.toBe(0);
      const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
      expect(parsed.error.code).toBe('INVALID_INPUT');
    }
  });

  it('single-project envelopes are unchanged (no all_projects key)', async () => {
    const d = parseOk<Record<string, unknown>>(await agentA.runRaw(['decisions', '--json']));
    expect('all_projects' in d).toBe(false);
    const l = parseOk<Record<string, unknown>>(await agentA.runRaw(['loose-ends', '--json']));
    expect('all_projects' in l).toBe(false);
    expect(l.window_semantics).toBe('selects-artifacts-only');
  });
});
