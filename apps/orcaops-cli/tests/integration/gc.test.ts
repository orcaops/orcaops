import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { ArtifactStore, pinFilePath, slugifyBranch } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { withCleanSession } from '../support/test-helpers.js';

interface GcCandidates {
  stale_pins: Array<{ artifact_id: string; reason: string; pin_file: string }>;
  abandoned_summarized: Array<{ artifact_id: string }>;
  stale_review_dirs: Array<{ slug: string; branch: string; reason: string; last_modified: string }>;
  git_uncertainties: Array<{ operation: string; subject: string }>;
  storage_uncertainties?: Array<{ operation: string; subject: string; reason: string }>;
}

interface GcOk {
  ok: true;
  applied: boolean;
  retention_days: number;
  projection_health: 'healthy' | 'rebuild_pending' | 'degraded';
  candidates: GcCandidates;
  reports: {
    unreachable_nonterminal_artifacts: Array<{ artifact_id: string; state: string }>;
  };
  would_prune_snapshot_refs: number | null;
  would_prune_baseline_refs: number | null;
  would_prune_review_refs: number | null;
  deleted: {
    stale_pins: number;
    abandoned_summarized: number;
    snapshot_refs: number;
    baseline_refs: number;
    stale_review_dirs: number;
    review_refs: number;
  };
}

describe('orcaops gc', () => {
  let repo: TempRepo;
  let xdgState: string;
  let dataRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-gc-xdg-'));
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-gc-data-'));
    const init = makeAgent({
      cwd: repo.path,
      env: withCleanSession({ XDG_STATE_HOME: xdgState, ORCAOPS_DATA_DIR: dataRoot }),
    });
    await init.init({ noLlm: true });
    // Snapshot refs are captured by default (auth-independent);
    // the capture-agent factories below set ORCAOPS_DISABLE_DRAIN so there's no cloud I/O.
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  function agentWithSession(): ReturnType<typeof makeAgent> {
    return makeAgent({
      cwd: repo.path,
      env: withCleanSession({
        XDG_STATE_HOME: xdgState,
        ORCAOPS_DATA_DIR: dataRoot,
        CLAUDE_SESSION_ID: 'sess_gc',
        ORCAOPS_DISABLE_DRAIN: '1',
      }),
    });
  }

  function agentHeadless(): ReturnType<typeof makeAgent> {
    return makeAgent({
      cwd: repo.path,
      env: withCleanSession({
        XDG_STATE_HOME: xdgState,
        ORCAOPS_DATA_DIR: dataRoot,
        ORCAOPS_DISABLE_DRAIN: '1',
      }),
    });
  }

  function danglingCommit(message: string): string {
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo.path })
      .toString()
      .trim();
    return execFileSync('git', ['commit-tree', tree, '-m', message], { cwd: repo.path })
      .toString()
      .trim();
  }

  async function plantArtifactWithUnreachableLineage(
    summarizedAt?: string,
    active = false
  ): Promise<string> {
    const artifactId = `01999999-9999-7000-8000-${randomUUID().slice(0, 12).replace(/-/g, '')}`;
    const unreachableSha = danglingCommit(`unreachable ${artifactId}`);
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      await store.writePlan({
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'main',
        base_sha: unreachableSha,
        agent: 'claude-code',
        agent_session_id: null,
        task: 'orphan task',
        label: 'orphan-plan',
        plan_steps: [
          {
            step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
            text: 's',
            label: 's1',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-04-25T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      });
      if (active) {
        await store.writeCheckpointOpened(
          {
            artifact_id: artifactId,
            declared_step_ids: ['01HX0K8N6ZQF8M5R2V8DZ7T3KX'],
          },
          { idempotencyKey: `open-${artifactId}`, headSha: unreachableSha }
        );
        await store.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: 1,
            summary: 'activate artifact',
            files_changed: [],
            decisions: [],
            uncertainty: [],
            done_criteria: [],
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: ['01HX0K8N6ZQF8M5R2V8DZ7T3KX'],
            head_sha: unreachableSha,
          },
          { idempotencyKey: `close-${artifactId}` }
        );
      }
      if (summarizedAt !== undefined) {
        await store.writeSummary({
          schema_version: 1,
          artifact_id: artifactId,
          outcome: 'shipped',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          head_sha: unreachableSha,
          ts: summarizedAt,
        });
      }
    } finally {
      store.close();
    }
    return artifactId;
  }

  async function plantStalePin(): Promise<string> {
    const planRes = await agentWithSession().runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      await store.deleteArtifact(plan.artifact_id);
    } finally {
      store.close();
    }
    const projectId = execFileSync('git', ['config', '--local', '--get', 'orcaops.projectid'], {
      cwd: repo.path,
    })
      .toString()
      .trim();
    await rm(path.join(dataRoot, 'projects', projectId, 'artifacts', plan.artifact_id), {
      recursive: true,
      force: true,
    });
    return plan.artifact_id;
  }

  it('dry-run: reports unreachable nonterminal artifacts separately from candidates', async () => {
    const artifactId = await plantArtifactWithUnreachableLineage();
    const res = await agentHeadless().runRaw(['gc', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as GcOk;
    expect(out.applied).toBe(false);
    expect(out.reports.unreachable_nonterminal_artifacts).toContainEqual(
      expect.objectContaining({ artifact_id: artifactId, state: 'planned' })
    );
    expect(out.candidates.abandoned_summarized).toEqual([]);

    const config = await loadConfig(repo.path);
    const dir = path.join(repo.path, config.artifacts.path, artifactId);
    await expect(access(dir)).resolves.toBeUndefined();
  });

  it('--apply preserves unreachable pinned nonterminal work without an archive', async () => {
    const artifactId = await plantArtifactWithUnreachableLineage(undefined, true);
    const checkout = await agentWithSession().runRaw(['checkout', artifactId, '--json']);
    expect(checkout.exitCode).toBe(0);

    const res = await agentHeadless().runRaw(['gc', '--apply', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as GcOk;
    expect(out.applied).toBe(true);
    expect(out.reports.unreachable_nonterminal_artifacts).toContainEqual(
      expect.objectContaining({ artifact_id: artifactId, state: 'active' })
    );
    expect(out.candidates.stale_pins).toEqual([]);

    const config = await loadConfig(repo.path);
    const dir = path.join(repo.path, config.artifacts.path, artifactId);
    await expect(access(dir)).resolves.toBeUndefined();
    const clear = await agentWithSession().runRaw(['checkout', '--clear', '--json']);
    expect(JSON.parse(clear.stdout)).toMatchObject({
      ok: true,
      cleared: true,
      previous_artifact_id: artifactId,
    });
  });

  it('--apply removes a stale pin pointing at a missing artifact', async () => {
    await plantStalePin();

    const res = await agentHeadless().runRaw(['gc', '--apply', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as GcOk;
    expect(out.deleted.stale_pins).toBeGreaterThanOrEqual(1);
  });

  it('refuses apply when a partial rebuild omits a pinned durable artifact', async () => {
    const agent = agentWithSession();
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'pinned corrupt artifact',
          plan_steps: [{ text: 's', label: 's1' }],
        })
      ),
    ]);
    expect(planRes.exitCode).toBe(0);
    const artifactId = (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;
    const config = await loadConfig(repo.path);
    const artifactDir = path.join(repo.path, config.artifacts.path, artifactId);
    await rm(path.join(artifactDir, 'events.ndjson'));

    const rebuild = await agentHeadless().runRaw(['rebuild', '--json']);
    expect(rebuild.exitCode).toBe(0);
    expect(JSON.parse(rebuild.stdout)).toMatchObject({ skipped_artifacts: 1 });

    const dry = JSON.parse((await agentHeadless().runRaw(['gc', '--json'])).stdout) as GcOk;
    expect(dry.projection_health).toBe('degraded');
    expect(dry.candidates.stale_pins).toEqual([]);
    expect(dry.candidates.storage_uncertainties).toContainEqual(
      expect.objectContaining({
        operation: 'hot_artifact_presence',
        subject: artifactId,
      })
    );
    const pinFile = pinFilePath(
      execFileSync('git', ['config', '--local', '--get', 'orcaops.projectid'], {
        cwd: repo.path,
        encoding: 'utf8',
      }).trim(),
      { kind: 'claude_session', value: 'sess_gc' },
      { XDG_STATE_HOME: xdgState }
    );
    await expect(access(pinFile)).resolves.toBeUndefined();

    const apply = await agentHeadless().runRaw(['gc', '--apply', '--json']);
    expect(apply.exitCode).toBe(1);
    expect(JSON.parse(apply.stdout)).toMatchObject({
      ok: false,
      error: { code: 'GC_PROJECTION_UNHEALTHY' },
    });
    await expect(access(pinFile)).resolves.toBeUndefined();
    await expect(access(artifactDir)).resolves.toBeUndefined();

    const doctor = JSON.parse((await agentHeadless().runRaw(['doctor', '--json'])).stdout) as {
      checks: Array<{ name: string; summary: string; details?: string[] }>;
    };
    const cache = doctor.checks.find((check) => check.name === 'cache');
    expect(cache?.summary).toMatch(/projection degraded.*1 skipped artifact/);
    expect(cache?.details?.join('\n')).toMatch(
      /Restore.*archive.*move.*explicitly accept.*rebuild/s
    );
  });

  it('refuses apply when a healthy-looking cache omits a durable pinned artifact', async () => {
    const agent = agentWithSession();
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'durable artifact missing from cache',
          plan_steps: [{ text: 's', label: 's1' }],
        })
      ),
    ]);
    expect(planRes.exitCode).toBe(0);
    const artifactId = (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;
    const config = await loadConfig(repo.path);
    const artifactDir = path.join(repo.path, config.artifacts.path, artifactId);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      store.store.deleteArtifact(artifactId);
      expect(store.store.projectionHealth).toBe('healthy');
    } finally {
      store.close();
    }

    const dry = JSON.parse((await agentHeadless().runRaw(['gc', '--json'])).stdout) as GcOk;
    expect(dry.candidates.stale_pins).toEqual([]);
    expect(dry.candidates.storage_uncertainties).toContainEqual(
      expect.objectContaining({
        operation: 'hot_artifact_presence',
        subject: artifactId,
      })
    );

    const apply = await agentHeadless().runRaw(['gc', '--apply', '--json']);
    expect(apply.exitCode).toBe(1);
    expect(JSON.parse(apply.stdout)).toMatchObject({
      ok: false,
      error: { code: 'GC_STORAGE_UNCERTAIN' },
    });
    await expect(access(artifactDir)).resolves.toBeUndefined();
  });

  it('--retention-days override changes the abandoned threshold', async () => {
    const artifactId = '01999999-9999-7000-8000-000000000099';
    const unreachableSha = danglingCommit('old summarized work');
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      await store.writePlan({
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'main',
        base_sha: unreachableSha,
        agent: 'claude-code',
        agent_session_id: null,
        task: 'old summarized work',
        label: 'lbl',
        plan_steps: [
          {
            step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3LY',
            text: 's',
            label: 's1',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-04-25T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      });
      await store.writeSummary({
        schema_version: 1,
        artifact_id: artifactId,
        outcome: 'shipped',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: unreachableSha,
        ts: '2024-01-01T00:00:00.000Z',
      });
    } finally {
      store.close();
    }

    const res = await agentHeadless().runRaw(['gc', '--json']);
    const out = JSON.parse(res.stdout) as GcOk;
    expect(out.candidates.abandoned_summarized.map((a) => a.artifact_id)).toContain(artifactId);

    const wide = await agentHeadless().runRaw(['gc', '--retention-days', '100000', '--json']);
    const wideOut = JSON.parse(wide.stdout) as GcOk;
    expect(wideOut.candidates.abandoned_summarized.map((a) => a.artifact_id)).not.toContain(
      artifactId
    );
  });

  it('rejects --retention-days <= 0 with INVALID_INPUT', async () => {
    const res = await agentHeadless().runRaw(['gc', '--retention-days', '0', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  it('human format reports counts and notes dry-run vs applied', async () => {
    await plantArtifactWithUnreachableLineage();
    const dry = await agentHeadless().runRaw(['gc']);
    expect(dry.stdout).toMatch(/dry-run/);
    expect(dry.stdout).toMatch(/--apply/);
    expect(dry.stdout).toMatch(/unreachable_nonterminal_artifacts:\s+1/);
    expect(dry.stdout).toMatch(/report only; never deleted by gc/);

    const applied = await agentHeadless().runRaw(['gc', '--apply']);
    expect(applied.stdout).toMatch(/applied/);
    expect(applied.stdout).toMatch(/report only; never deleted by gc/);
  });

  it('empty candidate set: dry-run reports zeros, applied reports zeros', async () => {
    const res = await agentHeadless().runRaw(['gc', '--apply', '--json']);
    const out = JSON.parse(res.stdout) as GcOk;
    expect(out.applied).toBe(true);
    expect(out.candidates.stale_pins).toEqual([]);
    expect(out.reports.unreachable_nonterminal_artifacts).toEqual([]);
    expect(out.candidates.abandoned_summarized).toEqual([]);
    expect(out.deleted.stale_pins).toBe(0);
  });

  // ── gc prunes a deleted artifact's snapshot refs ───────────────────

  async function writeSnapRef(artifactId: string, n: number, phase: string): Promise<void> {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path }).toString().trim();
    const dir = path.join(repo.path, '.git', 'refs', 'orcaops', 'snap', artifactId, String(n));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, phase), head + '\n', 'utf8');
  }

  function snapRefCount(): number {
    return execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/orcaops/snap/'], {
      cwd: repo.path,
    })
      .toString()
      .split('\n')
      .filter((s) => s.trim().length > 0).length;
  }

  function writeBaselineRef(artifactId: string): void {
    execFileSync(
      'git',
      ['update-ref', `refs/orcaops/baseline/${artifactId}`, gitTrim(['rev-parse', 'HEAD'])],
      { cwd: repo.path }
    );
  }

  function baselineRefCount(): number {
    return execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/orcaops/baseline/'], {
      cwd: repo.path,
    })
      .toString()
      .split('\n')
      .filter((s) => s.trim().length > 0).length;
  }

  it('gc --apply prunes a collected summarized artifact’s snapshot refs', async () => {
    const artifactId = await plantArtifactWithUnreachableLineage('2020-01-01T00:00:00.000Z');
    await writeSnapRef(artifactId, 1, 'open');
    await writeSnapRef(artifactId, 1, 'close');
    expect(snapRefCount()).toBe(2);

    const res = await agentHeadless().runRaw(['gc', '--apply', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as GcOk;
    expect(out.deleted.abandoned_summarized).toBeGreaterThanOrEqual(1);
    expect(out.deleted.snapshot_refs).toBeGreaterThanOrEqual(2);
    expect(snapRefCount()).toBe(0);

    const config = await loadConfig(repo.path);
    const dir = path.join(repo.path, config.artifacts.path, artifactId);
    await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gc dry-run reports would_prune_snapshot_refs without deleting them', async () => {
    const artifactId = await plantArtifactWithUnreachableLineage('2020-01-01T00:00:00.000Z');
    await writeSnapRef(artifactId, 1, 'open');
    await writeSnapRef(artifactId, 1, 'close');

    const res = await agentHeadless().runRaw(['gc', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as GcOk;
    expect(out.applied).toBe(false);
    expect(out.would_prune_snapshot_refs).toBe(2);
    expect(out.deleted.snapshot_refs).toBe(0);
    expect(snapRefCount()).toBe(2); // untouched in dry-run
  });

  it('gc with no candidates reports snapshot_refs: 0 and human line', async () => {
    const json = JSON.parse((await agentHeadless().runRaw(['gc', '--json'])).stdout) as GcOk;
    expect(json.would_prune_snapshot_refs).toBe(0);
    expect(json.deleted.snapshot_refs).toBe(0);

    const artifactId = await plantArtifactWithUnreachableLineage('2020-01-01T00:00:00.000Z');
    await writeSnapRef(artifactId, 1, 'open');
    const human = await agentHeadless().runRaw(['gc', '--apply']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toMatch(/snapshot_refs:\s+\d+ → deleted \d+/);
  });

  // ── Stale review dirs: `.orcaops/reviews/<slug>/` + their pinned refs ──

  function gitTrim(args: string[]): string {
    return execFileSync('git', args, { cwd: repo.path }).toString().trim();
  }

  function reviewRefNames(): string[] {
    return execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/orcaops/review/'], {
      cwd: repo.path,
    })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort();
  }

  function reviewDirPath(branch: string): string {
    return path.join(repo.path, '.orcaops', 'reviews', slugifyBranch(branch));
  }

  /** Create a review dir + its two pins, backdated past the retention window. */
  async function plantStaleReviewDir(branch: string, headSha: string): Promise<void> {
    const slug = slugifyBranch(branch);
    const dir = reviewDirPath(branch);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'floor.json'), '{}\n', 'utf8');
    await writeFile(path.join(dir, 'diff.patch'), '', 'utf8');
    // Backdate the files THEN the dir (writing a file bumps the dir's mtime) so
    // the dir's max-mtime predates the default 30-day retention window.
    const old = new Date('2020-01-01T00:00:00.000Z');
    await utimes(path.join(dir, 'floor.json'), old, old);
    await utimes(path.join(dir, 'diff.patch'), old, old);
    await utimes(dir, old, old);
    execFileSync('git', ['update-ref', `refs/orcaops/review/${slug}`, headSha], { cwd: repo.path });
    execFileSync('git', ['update-ref', `refs/orcaops/review/${slug}-base`, headSha], {
      cwd: repo.path,
    });
  }

  it('reports unknown ref counts and preserves every candidate class when ref enumeration fails', async () => {
    const nonterminalId = await plantArtifactWithUnreachableLineage();
    const abandonedId = await plantArtifactWithUnreachableLineage('2020-01-01T00:00:00.000Z');
    const stalePinArtifactId = await plantStalePin();
    await writeSnapRef(abandonedId, 1, 'open');
    await writeSnapRef(abandonedId, 1, 'close');
    writeBaselineRef(abandonedId);
    const head = gitTrim(['rev-parse', 'HEAD']);
    await plantStaleReviewDir('deleted-under-uncertainty', head);

    const config = await loadConfig(repo.path);
    const artifactDir = path.join(repo.path, config.artifacts.path, abandonedId);
    const reviewDir = reviewDirPath('deleted-under-uncertainty');
    const refsBefore = reviewRefNames();
    const baselineRefsBefore = baselineRefCount();
    expect(snapRefCount()).toBe(2);
    expect(baselineRefsBefore).toBeGreaterThanOrEqual(1);

    const shimDir = await mkdtemp(path.join(tmpdir(), 'orcaops-gc-git-shim-'));
    const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    await writeFile(
      path.join(shimDir, 'git'),
      '#!/bin/sh\n' +
        'case "$*" in\n' +
        '  *refs/orcaops/snap/*|*refs/orcaops/baseline/*|*refs/orcaops/review/*) exit 128 ;;\n' +
        'esac\n' +
        `exec ${JSON.stringify(realGit)} "$@"\n`,
      { encoding: 'utf8', mode: 0o700 }
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const dryJson = await agentHeadless().runRaw(['gc', '--json']);
      expect(dryJson.exitCode).toBe(0);
      const dry = JSON.parse(dryJson.stdout) as GcOk;
      expect(dry.would_prune_snapshot_refs).toBeNull();
      expect(dry.would_prune_baseline_refs).toBeNull();
      expect(dry.would_prune_review_refs).toBeNull();
      expect(dry.candidates.git_uncertainties.map((entry) => entry.operation).sort()).toEqual([
        'baseline_ref_enumeration',
        'review_ref_enumeration',
        'snapshot_ref_enumeration',
      ]);

      const dryHuman = await agentHeadless().runRaw(['gc']);
      expect(dryHuman.exitCode).toBe(0);
      expect(dryHuman.stdout).toMatch(/snapshot_refs:\s+unknown \(Git state unavailable\)/);
      expect(dryHuman.stdout).toMatch(/baseline_refs:\s+unknown \(Git state unavailable\)/);
      expect(dryHuman.stdout).toMatch(/review_refs:\s+unknown \(Git state unavailable\)/);

      const res = await agentHeadless().runRaw(['gc', '--apply', '--json']);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;

      expect(res.exitCode).toBe(1);
      const envelope = JSON.parse(res.stdout) as {
        ok: false;
        error: { code: string; message: string };
      };
      expect(envelope.error.code, envelope.error.message).toBe('GC_GIT_UNCERTAIN');

      await expect(access(artifactDir)).resolves.toBeUndefined();
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        expect(store.store.getArtifact(abandonedId)).not.toBeNull();
      } finally {
        store.close();
      }
      expect(snapRefCount()).toBe(2);
      expect(baselineRefCount()).toBe(baselineRefsBefore);
      await expect(access(reviewDir)).resolves.toBeUndefined();
      expect(reviewRefNames()).toEqual(refsBefore);

      const after = JSON.parse((await agentHeadless().runRaw(['gc', '--json'])).stdout) as GcOk;
      expect(after.candidates.stale_pins.map((pin) => pin.artifact_id)).toContain(
        stalePinArtifactId
      );
      expect(
        after.reports.unreachable_nonterminal_artifacts.map((artifact) => artifact.artifact_id)
      ).toContain(nonterminalId);
      expect(
        after.candidates.abandoned_summarized.map((artifact) => artifact.artifact_id)
      ).toContain(abandonedId);
      expect(after.candidates.stale_review_dirs.map((dir) => dir.branch)).toContain(
        'deleted-under-uncertainty'
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });

  it('aborts the entire apply when the exact candidate set changes during validation', async () => {
    const artifactId = await plantArtifactWithUnreachableLineage('2020-01-01T00:00:00.000Z');
    const config = await loadConfig(repo.path);
    const artifactDir = path.join(repo.path, config.artifacts.path, artifactId);
    const lineageStore = new ArtifactStore({ repoRoot: repo.path, config });
    let unreachableSha: string;
    try {
      const row = lineageStore.store.db
        .prepare('SELECT latest_lineage_sha FROM lineage_by_latest_sha WHERE artifact_id = ?')
        .get(artifactId) as { latest_lineage_sha: string };
      unreachableSha = row.latest_lineage_sha;
    } finally {
      lineageStore.close();
    }

    const shimDir = await mkdtemp(path.join(tmpdir(), 'orcaops-gc-race-shim-'));
    const countFile = path.join(shimDir, 'head-scan-count');
    const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    await writeFile(
      path.join(shimDir, 'git'),
      '#!/bin/sh\n' +
        'last=""\n' +
        'for arg in "$@"; do last="$arg"; done\n' +
        'if [ "$last" = "refs/heads" ]; then\n' +
        '  count=0\n' +
        `  [ ! -f ${JSON.stringify(countFile)} ] || read count < ${JSON.stringify(countFile)}\n` +
        '  count=$((count + 1))\n' +
        `  echo "$count" > ${JSON.stringify(countFile)}\n` +
        '  if [ "$count" -eq 2 ]; then\n' +
        `    ${JSON.stringify(realGit)} update-ref refs/heads/gc-race ${JSON.stringify(unreachableSha)} || exit $?\n` +
        '  fi\n' +
        'fi\n' +
        `exec ${JSON.stringify(realGit)} "$@"\n`,
      { encoding: 'utf8', mode: 0o700 }
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const res = await agentHeadless().runRaw(['gc', '--apply', '--json']);
      expect(res.exitCode).toBe(1);
      const envelope = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
      expect(envelope.error.code).toBe('GC_CANDIDATES_CHANGED');
      await expect(access(artifactDir)).resolves.toBeUndefined();
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        expect(store.store.getArtifact(artifactId)).not.toBeNull();
      } finally {
        store.close();
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });

  it('aborts without mutation when only the ref inventory changes during validation', async () => {
    const artifactId = await plantArtifactWithUnreachableLineage('2020-01-01T00:00:00.000Z');
    await writeSnapRef(artifactId, 1, 'open');
    writeBaselineRef(artifactId);
    const head = gitTrim(['rev-parse', 'HEAD']);
    await plantStaleReviewDir('deleted-with-ref-race', head);

    const config = await loadConfig(repo.path);
    const artifactDir = path.join(repo.path, config.artifacts.path, artifactId);
    const reviewDir = reviewDirPath('deleted-with-ref-race');
    const baselineRefsBefore = baselineRefCount();
    const reviewRefsBefore = reviewRefNames();
    const injectedRef = `refs/orcaops/snap/${artifactId}/99/open`;

    const shimDir = await mkdtemp(path.join(tmpdir(), 'orcaops-gc-ref-race-shim-'));
    const countFile = path.join(shimDir, 'snapshot-scan-count');
    const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    await writeFile(
      path.join(shimDir, 'git'),
      '#!/bin/sh\n' +
        'last=""\n' +
        'for arg in "$@"; do last="$arg"; done\n' +
        'if [ "$last" = "refs/orcaops/snap/" ]; then\n' +
        '  count=0\n' +
        `  [ ! -f ${JSON.stringify(countFile)} ] || read count < ${JSON.stringify(countFile)}\n` +
        '  count=$((count + 1))\n' +
        `  echo "$count" > ${JSON.stringify(countFile)}\n` +
        '  if [ "$count" -eq 2 ]; then\n' +
        `    ${JSON.stringify(realGit)} update-ref ${JSON.stringify(injectedRef)} ${JSON.stringify(head)} || exit $?\n` +
        '  fi\n' +
        'fi\n' +
        `exec ${JSON.stringify(realGit)} "$@"\n`,
      { encoding: 'utf8', mode: 0o700 }
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const res = await agentHeadless().runRaw(['gc', '--apply', '--json']);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;

      expect(res.exitCode).toBe(1);
      const envelope = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
      expect(envelope.error.code).toBe('GC_CANDIDATES_CHANGED');

      await expect(access(artifactDir)).resolves.toBeUndefined();
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        expect(store.store.getArtifact(artifactId)).not.toBeNull();
      } finally {
        store.close();
      }
      expect(snapRefCount()).toBe(2);
      expect(gitTrim(['show-ref', '--verify', injectedRef])).toContain(injectedRef);
      expect(baselineRefCount()).toBe(baselineRefsBefore);
      await expect(access(reviewDir)).resolves.toBeUndefined();
      expect(reviewRefNames()).toEqual(reviewRefsBefore);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });

  it('preserves a concurrently changed ref and reports the committed artifact deletion', async () => {
    await plantArtifactWithUnreachableLineage('2020-01-01T00:00:00.000Z');
    await plantArtifactWithUnreachableLineage('2020-01-01T00:00:00.000Z');
    const before = JSON.parse((await agentHeadless().runRaw(['gc', '--json'])).stdout) as GcOk;
    const [artifactId, untouchedId] = before.candidates.abandoned_summarized.map(
      (candidate) => candidate.artifact_id
    );
    expect(artifactId).toBeTruthy();
    expect(untouchedId).toBeTruthy();
    await writeSnapRef(artifactId, 1, 'open');
    writeBaselineRef(artifactId);
    const targetRef = `refs/orcaops/snap/${artifactId}/1/open`;
    const replacement = danglingCommit('concurrent snapshot replacement');
    const config = await loadConfig(repo.path);
    const artifactDir = path.join(repo.path, config.artifacts.path, artifactId);
    const untouchedDir = path.join(repo.path, config.artifacts.path, untouchedId);
    const baselineRefsBefore = baselineRefCount();

    const shimDir = await mkdtemp(path.join(tmpdir(), 'orcaops-gc-cas-shim-'));
    const injected = path.join(shimDir, 'injected');
    const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    await writeFile(
      path.join(shimDir, 'git'),
      '#!/bin/sh\n' +
        'if [ "$1" = "update-ref" ] && [ "$2" = "--stdin" ] && ' +
        `[ ! -f ${JSON.stringify(injected)} ]; then\n` +
        `  echo injected > ${JSON.stringify(injected)}\n` +
        `  ${JSON.stringify(realGit)} update-ref ${JSON.stringify(targetRef)} ${JSON.stringify(replacement)} || exit $?\n` +
        'fi\n' +
        `exec ${JSON.stringify(realGit)} "$@"\n`,
      { encoding: 'utf8', mode: 0o700 }
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const res = await agentHeadless().runRaw(['gc', '--apply', '--json']);
      expect(res.exitCode).toBe(1);
      const envelope = JSON.parse(res.stdout) as {
        ok: false;
        error: {
          code: string;
          gc_progress: {
            state: string;
            completed: { abandoned_summarized: number; snapshot_refs: number };
            failed_candidate: { kind: string; id: string };
          };
        };
      };
      expect(envelope.error.code).toBe('GC_APPLY_FAILED');
      expect(envelope.error.gc_progress).toMatchObject({
        state: 'recoverable_in_progress',
        completed: { abandoned_summarized: 1, snapshot_refs: 0 },
        failed_candidate: { kind: 'abandoned_summarized', id: artifactId },
      });
      await expect(access(artifactDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(untouchedDir)).resolves.toBeUndefined();
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        expect(store.store.getArtifact(untouchedId)).not.toBeNull();
      } finally {
        store.close();
      }
      expect(gitTrim(['rev-parse', targetRef])).toBe(replacement);
      expect(baselineRefCount()).toBe(baselineRefsBefore);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });

  it('dry-run lists merged + deleted review dirs (not current); --apply removes them and their refs', async () => {
    const head = gitTrim(['rev-parse', 'HEAD']);
    // Merged branch: leave its tip at the OLD head, then advance main past it
    // so the branch tip is a strict ancestor of main (not equal to main's tip,
    // which would read as the default branch itself and be kept).
    execFileSync('git', ['branch', 'feature-merged'], { cwd: repo.path });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'advance main'], { cwd: repo.path });

    await plantStaleReviewDir('feature-merged', head); // branch exists + merged
    await plantStaleReviewDir('deleted-branch', head); // no such branch → deleted
    await plantStaleReviewDir('main', gitTrim(['rev-parse', 'HEAD'])); // current branch → survivor

    // ── dry-run ──
    const dry = JSON.parse((await agentHeadless().runRaw(['gc', '--json'])).stdout) as GcOk;
    expect(dry.applied).toBe(false);
    const listed = dry.candidates.stale_review_dirs;
    expect(listed.map((d) => d.branch).sort()).toEqual(['deleted-branch', 'feature-merged']);
    expect(listed.map((d) => d.branch)).not.toContain('main');
    expect(listed.find((d) => d.branch === 'feature-merged')?.reason).toBe('branch_merged');
    expect(listed.find((d) => d.branch === 'deleted-branch')?.reason).toBe('branch_deleted');
    expect(dry.would_prune_review_refs).toBe(4);
    expect(dry.deleted.stale_review_dirs).toBe(0);
    // Nothing removed in dry-run.
    await expect(access(reviewDirPath('feature-merged'))).resolves.toBeUndefined();
    expect(reviewRefNames()).toHaveLength(6);

    // ── apply ──
    const applied = JSON.parse(
      (await agentHeadless().runRaw(['gc', '--apply', '--json'])).stdout
    ) as GcOk;
    expect(applied.deleted.stale_review_dirs).toBe(2);
    expect(applied.deleted.review_refs).toBe(4);
    // Stale dirs gone; the current-branch dir survives.
    await expect(access(reviewDirPath('feature-merged'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(reviewDirPath('deleted-branch'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(reviewDirPath('main'))).resolves.toBeUndefined();
    // Only the survivor's two refs remain.
    expect(reviewRefNames()).toEqual(['refs/orcaops/review/main', 'refs/orcaops/review/main-base']);
    // The root store is untouched.
    await expect(access(path.join(repo.path, '.orcaops', 'config.json'))).resolves.toBeUndefined();
  });

  it('refuses a symlinked reviews root without deleting external data', async () => {
    const reviewsRoot = path.join(repo.path, '.orcaops', 'reviews');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-gc-external-reviews-'));
    const externalReview = path.join(outside, slugifyBranch('deleted-branch'));
    const sentinel = path.join(externalReview, 'comments.ndjson');
    try {
      await rm(reviewsRoot, { recursive: true, force: true });
      await mkdir(externalReview, { recursive: true });
      await writeFile(sentinel, '{"external":true}\n', 'utf8');
      const old = new Date('2020-01-01T00:00:00.000Z');
      await utimes(sentinel, old, old);
      await utimes(externalReview, old, old);
      await symlink(outside, reviewsRoot);

      const res = await agentHeadless().runRaw([
        'gc',
        '--apply',
        '--retention-days',
        '1',
        '--json',
      ]);

      expect(res.exitCode).toBe(1);
      const envelope = JSON.parse(res.stdout) as {
        ok: false;
        error: { code: string; message: string };
      };
      expect(envelope).toMatchObject({
        ok: false,
        error: { code: 'GC_STORAGE_UNCERTAIN' },
      });
      await expect(access(sentinel)).resolves.toBeUndefined();
      await expect(access(externalReview)).resolves.toBeUndefined();
    } finally {
      await rm(reviewsRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked review trash root before deleting a review directory', async () => {
    const head = gitTrim(['rev-parse', 'HEAD']);
    await plantStaleReviewDir('deleted-with-external-trash', head);
    const reviewDir = reviewDirPath('deleted-with-external-trash');
    const trashRoot = path.join(repo.path, '.orcaops', 'tmp', 'trash');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-gc-external-trash-'));
    const sentinel = path.join(outside, 'sentinel');
    try {
      await mkdir(path.dirname(trashRoot), { recursive: true });
      await rm(trashRoot, { recursive: true, force: true });
      await writeFile(sentinel, 'external\n', 'utf8');
      await symlink(outside, trashRoot);

      const res = await agentHeadless().runRaw(['gc', '--apply', '--json']);

      expect(res.exitCode).toBe(1);
      expect(JSON.parse(res.stdout)).toMatchObject({
        ok: false,
        error: { code: 'GC_STORAGE_UNCERTAIN' },
      });
      await expect(access(reviewDir)).resolves.toBeUndefined();
      await expect(access(sentinel)).resolves.toBeUndefined();
    } finally {
      await rm(trashRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does NOT flag a stale review dir modified within the retention window', async () => {
    // Fresh (not backdated) dir for a nonexistent branch — inside the 30-day window.
    const dir = reviewDirPath('recent-gone');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'floor.json'), '{}\n', 'utf8');
    const out = JSON.parse((await agentHeadless().runRaw(['gc', '--json'])).stdout) as GcOk;
    expect(out.candidates.stale_review_dirs.map((d) => d.branch)).not.toContain('recent-gone');
  });

  it('does NOT flag a review dir with a recently modified nested run file', async () => {
    const branch = 'nested-run-active';
    const dir = reviewDirPath(branch);
    const twolaneDir = path.join(dir, 'twolane');
    const runDir = path.join(twolaneDir, randomUUID());
    await plantStaleReviewDir(branch, gitTrim(['rev-parse', 'HEAD']));
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'run-v2.json'), '{}\n', 'utf8');

    const old = new Date('2020-01-01T00:00:00.000Z');
    await utimes(runDir, old, old);
    await utimes(twolaneDir, old, old);
    await utimes(dir, old, old);

    const out = JSON.parse((await agentHeadless().runRaw(['gc', '--json'])).stdout) as GcOk;
    expect(out.candidates.stale_review_dirs.map((candidate) => candidate.branch)).not.toContain(
      branch
    );
  });
});
