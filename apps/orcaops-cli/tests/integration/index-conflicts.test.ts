import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * Read-surface disclosure of an unmerged git index: `status`
 * and `doctor` keep the degraded state visible until the index is clean;
 * `diff --attribution` proceeds with disclosure and downgraded matches;
 * `stats` keeps its hygiene pct null; `why` annotates matches on paths a
 * checkpoint's `attribution_degraded` record names.
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

function forgeConflict(repoPath: string, filePath: string): void {
  const stageLine = (content: string, stage: number): string => {
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repoPath,
      input: content,
      encoding: 'utf8',
    }).trim();
    return `100644 ${sha} ${stage}\t${filePath}`;
  };
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: repoPath,
    input: `${[
      stageLine(`base of ${filePath}\n`, 1),
      stageLine(`ours of ${filePath}\n`, 2),
      stageLine(`theirs of ${filePath}\n`, 3),
    ].join('\n')}\n`,
  });
}

function resolveConflict(repoPath: string, filePath: string, resolved: string): void {
  execFileSync('sh', ['-c', `cat > "$1"`, 'sh', filePath], { cwd: repoPath, input: resolved });
  execFileSync('git', ['add', '--', filePath], { cwd: repoPath });
}

describe('unmerged-index read surfaces', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function capturePlan(): Promise<{ artifact_id: string; step_ids: string[] }> {
    const r = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'index-conflict read-surface test',
          label: 'index-conflict-surfaces',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const ok = parseOk<{
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    }>(r);
    return { artifact_id: ok.artifact_id, step_ids: ok.plan_steps.map((s) => s.step_id) };
  }

  it('status: index_conflicts + stderr nudge only while conflicted', async () => {
    const clean = await agent.runRaw(['status', '--json']);
    expect(
      (JSON.parse(clean.stdout) as { index_conflicts?: unknown }).index_conflicts
    ).toBeUndefined();
    const cleanHuman = await agent.runRaw(['status']);
    expect(cleanHuman.stderr).not.toMatch(/unresolved merge conflicts/);

    forgeConflict(repo.path, 'conflict.txt');
    const json = await agent.runRaw(['status', '--json']);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      index_conflicts?: { unmerged_paths: string[] };
    };
    expect(parsed.index_conflicts).toEqual({ unmerged_paths: ['conflict.txt'] });
    const human = await agent.runRaw(['status']);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toMatch(/unresolved merge conflicts/);
    expect(human.stderr).toMatch(/conflict\.txt/);
    expect(human.stdout).toMatch(/Branch:/); // report still renders to stdout

    resolveConflict(repo.path, 'conflict.txt', 'resolved\n');
    const after = await agent.runRaw(['status', '--json']);
    expect(
      (JSON.parse(after.stdout) as { index_conflicts?: unknown }).index_conflicts
    ).toBeUndefined();
  });

  it('doctor: index-conflicts passes clean, warns with paths while conflicted', async () => {
    interface DoctorReport {
      checks: Array<{ name: string; status: string; details?: string[] }>;
    }
    const findCheck = (r: CliResult, name: string) => {
      const report = JSON.parse(r.stdout) as DoctorReport;
      const check = report.checks.find((c) => c.name === name);
      if (!check) throw new Error(`check ${name} missing`);
      return check;
    };

    const clean = await agent.runRaw(['doctor', '--json']);
    expect(findCheck(clean, 'index-conflicts').status).toBe('pass');

    forgeConflict(repo.path, 'conflict.txt');
    const conflicted = await agent.runRaw(['doctor', '--json']);
    const check = findCheck(conflicted, 'index-conflicts');
    expect(check.status).toBe('warn');
    expect(check.details?.join('\n')).toMatch(/conflict\.txt/);
    // Warn does not fail doctor.
    expect(conflicted.exitCode).toBe(0);
  });

  it('diff --attribution proceeds under a conflicted index with disclosure', async () => {
    await capturePlan();
    forgeConflict(repo.path, 'conflict.txt');

    const r = await agent.runRaw(['diff', '--attribution', '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      disclosure: { live_unmerged_paths?: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.disclosure.live_unmerged_paths).toEqual(['conflict.txt']);
    expect(r.stderr).toMatch(/unmerged path/);
    expect(r.stderr).toMatch(/downgraded/);
  });

  it('stats: diff_attributed_pct stays null while the index is conflicted', async () => {
    const plan = await capturePlan();
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
            declared_step_ids: [plan.step_ids[0]],
          })
        ),
      ])
    );
    await writeFile(path.join(repo.path, 'work.ts'), 'export const w = 1;\n', 'utf8');
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
            summary: 'work',
            files_changed: ['work.ts'],
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [plan.step_ids[0]],
          })
        ),
      ])
    );

    interface StatsJson {
      hygiene?: { diff_attributed_pct: number | null };
    }
    const clean = JSON.parse((await agent.runRaw(['stats', '--json'])).stdout) as StatsJson;
    expect(clean.hygiene?.diff_attributed_pct).not.toBeNull();

    forgeConflict(repo.path, 'conflict.txt');
    const conflicted = JSON.parse((await agent.runRaw(['stats', '--json'])).stdout) as StatsJson;
    expect(conflicted.hygiene?.diff_attributed_pct).toBeNull();
  });

  it('a failed unmerged probe persists an unverified window end to end', async () => {
    const plan = await capturePlan();
    // Corrupting the real index breaks EXACTLY the ls-files -u probe — the
    // snapshot pipeline itself never reads it (temp GIT_INDEX_FILE).
    const indexPath = path.join(repo.path, '.git', 'index');
    await writeFile(indexPath, 'not an index\n', 'utf8');

    const openKey = `open-${randomUUID()}`;
    const o = parseOk<{ warnings?: Array<{ code: string; message: string }> }>(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: openKey,
            artifact_id: plan.artifact_id,
            declared_step_ids: [plan.step_ids[0]],
          })
        ),
      ])
    );
    expect(o.warnings?.some((w) => w.code === 'unmerged-probe-failed')).toBe(true);

    await writeFile(path.join(repo.path, 'work.ts'), 'export const w = 1;\n', 'utf8');
    const closeKey = `close-${randomUUID()}`;
    const closePayload = {
      idempotency_key: closeKey,
      artifact_id: plan.artifact_id,
      n: 1,
      summary: 'work under a failed probe',
      files_changed: ['work.ts'],
      verification: [{ command: 'test fixture', exit_code: 0 }],
      completed_step_ids: [plan.step_ids[0]],
    };
    const c = parseOk<{ warnings?: Array<{ code: string; message: string }> }>(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify(closePayload)),
      ])
    );
    // Boundary-neutral probe warning, and NO path-list warning (empty union).
    expect(c.warnings?.some((w) => w.code === 'unmerged-probe-failed')).toBe(true);
    expect(c.warnings?.some((w) => w.code === 'unmerged-paths-degraded')).toBe(false);

    // The unverified window is durably persisted.
    const projPath = path.join(
      repo.path,
      '.orcaops',
      'artifacts',
      plan.artifact_id,
      'checkpoint-1.json'
    );
    const proj = JSON.parse(await readFile(projPath, 'utf8')) as {
      attribution_degraded?: { unmerged_paths: string[]; probe_failed?: true };
      diff_fingerprint_summary: { status: string };
    };
    expect(proj.attribution_degraded).toEqual({ unmerged_paths: [], probe_failed: true });
    expect(proj.diff_fingerprint_summary.status).toBe('captured');

    // Restore the index for the follow-on git work.
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: repo.path });

    // A replayed close re-emits the probe warning from the persisted record.
    const replay = parseOk<{ warnings?: Array<{ code: string; message: string }> }>(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify(closePayload)),
      ])
    );
    expect(replay.warnings?.some((w) => w.code === 'unmerged-probe-failed')).toBe(true);

    // Derive still verifies: the empty exclusion list replays as a no-op.
    const derived = parseOk<{ verified: boolean | null }>(
      await agent.runRaw([
        'fingerprint',
        'derive',
        '--artifact',
        plan.artifact_id,
        '--checkpoint',
        '1',
        '--json',
      ])
    );
    expect(derived.verified).toBe(true);

    // why downgrades WINDOW-WIDE: work.ts was never unmerged, but the
    // checkpoint's exclusion set is unverified.
    interface WhyJson {
      best: { degraded?: string; reason: string } | null;
    }
    const why = parseOk<WhyJson>(await agent.runRaw(['why', 'work.ts', '--json']));
    expect(why.best?.degraded).toBe('probe_failed');
    expect(why.best?.reason).toMatch(/could not be verified, window-wide/);
  });

  it('why annotates a degraded path in whole-file and line mode', async () => {
    const plan = await capturePlan();
    forgeConflict(repo.path, 'conflict.txt');
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
            declared_step_ids: [plan.step_ids[0]],
          })
        ),
      ])
    );
    resolveConflict(repo.path, 'conflict.txt', 'resolved line\n');
    execFileSync('git', ['commit', '-m', 'resolve conflict'], { cwd: repo.path });
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
            summary: 'resolved the conflict',
            files_changed: ['conflict.txt'],
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [plan.step_ids[0]],
          })
        ),
      ])
    );

    interface WhyJson {
      best: { degraded?: string; reason: string } | null;
    }
    const whole = parseOk<WhyJson>(await agent.runRaw(['why', 'conflict.txt', '--json']));
    expect(whole.best).not.toBeNull();
    expect(whole.best?.degraded).toBe('unmerged_paths');
    expect(whole.best?.reason).toMatch(/degraded attribution/);

    const line = parseOk<WhyJson>(await agent.runRaw(['why', 'conflict.txt:1', '--json']));
    expect(line.best).not.toBeNull();
    expect(line.best?.degraded).toBe('unmerged_paths');
    expect(line.best?.reason).toMatch(/degraded attribution/);
  });
});
