import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops list --between <ref1>..<ref2>` end to end, with commit-after-close
 * reproduced: close records the PRE-commit HEAD, the work commit lands after,
 * and only summary/pre-pr shas carry the final commit — so the summary-sha
 * match path is the one that keeps a single-checkpoint artifact visible.
 * Pure matching is unit-tested in
 * `commands/list.test.ts`.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface BetweenOk {
  ok: true;
  between: {
    from: string;
    to: string;
    from_sha: string;
    to_sha: string;
    commit_count: number;
    ref2_branch: string | null;
  };
  matched: Array<{
    id: string;
    label: string;
    matched_shas: Array<{ source: string; n?: number; head_sha: string }>;
  }>;
  unmatched_candidates: Array<{ id: string; label: string; branch: string; reason: string }>;
}

function parseOk(r: CliResult): BetweenOk {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as BetweenOk;
  expect(parsed.ok).toBe(true);
  return parsed;
}

function expectInvalidInput(r: CliResult, pattern: RegExp): void {
  expect(r.exitCode).toBe(1);
  const err = JSON.parse(r.stdout) as { ok: false; error: { code: string; message: string } };
  expect(err.error.code).toBe('INVALID_INPUT');
  expect(err.error.message).toMatch(pattern);
}

describe('orcaops list --between', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let baseSha: string;
  let artifactId: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--json', '--no-llm']);
    await commitFile(repo.path, 'seed.ts', 'export const s = 0;\n', 'baseline');
    baseSha = (await gitClient(repo.path).revparse(['HEAD'])).trim();

    // Single-checkpoint artifact under the commit-at-close cadence:
    // open → close (head_sha = baseSha, the PRE-commit HEAD) → commit → summary.
    const planR = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'slice work',
          label: 'slice-work',
          plan_steps: [{ text: 'only step', label: 'only' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(planR.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    artifactId = plan.artifact_id;
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: artifactId,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: artifactId,
          summary: 'slice done',
          files_changed: ['src/slice.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    // The work commit lands AFTER close.
    await commitFile(repo.path, 'src/slice.ts', 'export const x = 1;\n', 'slice commit');
    await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: artifactId,
          outcome: 'done',
        })
      ),
    ]);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('matches a single-checkpoint artifact via its summary sha (commit-at-close off-by-one)', async () => {
    const out = parseOk(await agent.runRaw(['list', '--between', `${baseSha}..main`, '--json']));
    expect(out.between.from_sha).toBe(baseSha);
    expect(out.between.ref2_branch).toBe('main');
    expect(out.matched.map((m) => m.id)).toEqual([artifactId]);
    // The cp head_sha IS the range base (excluded by rev-list); the match
    // came from the post-commit summary sha.
    const sources = out.matched[0].matched_shas.map((s) => s.source);
    expect(sources).toContain('summary');
    expect(sources).not.toContain('checkpoint');
    expect(out.unmatched_candidates).toEqual([]);
  });

  it('matches archive-resident work captured from a linked worktree', async () => {
    const linked = await createLinkedWorktree(repo.path, { branch: 'feature-between' });
    try {
      const linkedAgent = makeAgent({
        cwd: linked.path,
        env: { ORCAOPS_DISABLE_DRAIN: '1' },
      });
      await linkedAgent.runRaw(['init', '--json', '--no-llm']);
      const plan = JSON.parse(
        (
          await linkedAgent.runRaw([
            'capture',
            'plan',
            '--no-llm',
            '--input',
            inputFile(
              JSON.stringify({
                task: 'linked range work',
                label: 'linked-range',
                plan_steps: [{ text: 'linked step', label: 'linked' }],
                touched_scope: [],
              })
            ),
          ])
        ).stdout
      ) as { artifact_id: string; plan_steps: Array<{ step_id: string }> };
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
      ]);
      await linkedAgent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: plan.artifact_id,
            summary: 'linked range done',
            files_changed: ['src/linked.ts'],
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [plan.plan_steps[0].step_id],
          })
        ),
      ]);
      await commitFile(linked.path, 'src/linked.ts', 'export const linked = 1;\n', 'linked work');
      await linkedAgent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'linked done' })),
      ]);

      const out = parseOk(
        await agent.runRaw(['list', '--between', `${baseSha}..feature-between`, '--json'])
      );
      expect(out.matched.map((match) => match.id)).toContain(plan.artifact_id);
    } finally {
      await linked.cleanup();
    }
  });

  it('equal refs are a valid empty range; a tag ref2 disables the candidates bucket', async () => {
    const empty = parseOk(await agent.runRaw(['list', '--between', 'main..main', '--json']));
    expect(empty.between.commit_count).toBe(0);
    expect(empty.matched).toEqual([]);

    await gitClient(repo.path).tag(['v0']);
    // v0 == current main tip; range baseSha..v0 still matches via summary.
    const tagged = parseOk(await agent.runRaw(['list', '--between', `${baseSha}..v0`, '--json']));
    expect(tagged.between.ref2_branch).toBeNull();
    expect(tagged.matched.map((m) => m.id)).toEqual([artifactId]);
    // And an empty tag range yields no candidates (ref2 is not a branch).
    const emptyTag = parseOk(await agent.runRaw(['list', '--between', 'v0..v0', '--json']));
    expect(emptyTag.matched).toEqual([]);
    expect(emptyTag.unmatched_candidates).toEqual([]);
  });

  it('an unreadable artifact is dropped from the range walk and disclosed by id', async () => {
    // Its head SHAs are unknowable, so the row cannot exist — omit-row
    // with id-only disclosure.
    const dir = path.join(repo.path, '.orcaops', 'artifacts', artifactId);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"plan_captured"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');
    await rm(path.join(dir, 'artifact.json'), { force: true });
    await rm(path.join(dir, 'plan.json'), { force: true });

    const res = await agent.runRaw(['list', '--between', `${baseSha}..main`, '--json']);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toMatch(/unreadable in list --between/);
    const out = JSON.parse(res.stdout) as BetweenOk & { degraded_artifacts: string[] };
    expect(out.matched).toEqual([]);
    expect(out.degraded_artifacts).toEqual([artifactId]);
  });

  it('serves a healthy hot twin without calling its quarantined archive twin unreadable', async () => {
    const localEnv = {
      ORCAOPS_DISABLE_DRAIN: '1',
      ORCAOPS_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'orcaops-between-data-')),
      XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-between-cache-')),
    };
    const localAgent = makeAgent({ cwd: repo.path, env: localEnv });
    const enabled = await localAgent.runRaw(['archive', 'enable', '--json']);
    expect(enabled.exitCode).toBe(0);
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectId'])
    ).trim();
    const archiveLog = path.join(
      localEnv.ORCAOPS_DATA_DIR,
      'projects',
      projectId,
      'artifacts',
      artifactId,
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

    const jsonResult = await localAgent.runRaw(['list', '--between', `${baseSha}..main`, '--json']);
    const json = parseOk(jsonResult) as BetweenOk & { degraded_artifacts: string[] };
    expect(json.matched.map((match) => match.id)).toContain(artifactId);
    expect(json.degraded_artifacts).not.toContain(artifactId);
    expect(jsonResult.stderr).toContain(artifactId);

    const human = await localAgent.runRaw(['list', '--between', `${baseSha}..main`]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('slice-work');
    expect(human.stdout).not.toMatch(/unreadable|head SHAs are unknown/);
    expect(human.stderr).toContain(artifactId);
  });

  it('a lineage artifact with no sha in range is disclosed as a candidate for a branch ref2', async () => {
    // Range that excludes all of the artifact's shas: from current tip to a
    // new commit — the artifact's cp/summary shas predate it.
    await commitFile(repo.path, 'later.ts', 'export const l = 1;\n', 'later work');
    const out = parseOk(await agent.runRaw(['list', '--between', 'main~1..main', '--json']));
    expect(out.matched).toEqual([]);
    expect(out.unmatched_candidates.map((c) => c.id)).toEqual([artifactId]);
    expect(out.unmatched_candidates[0].reason).toBe('no_head_sha_in_range');
  });

  it('rejects malformed ranges and unresolvable refs', async () => {
    expectInvalidInput(
      await agent.runRaw(['list', '--between', 'main...feature', '--json']),
      /two-dot/
    );
    expectInvalidInput(await agent.runRaw(['list', '--between', 'main', '--json']), /two-dot/);
    expectInvalidInput(
      await agent.runRaw(['list', '--between', 'no-such-ref..main', '--json']),
      /could not resolve "no-such-ref"/
    );
    expectInvalidInput(
      await agent.runRaw(['list', '--between', 'main..nope', '--json']),
      /could not resolve "nope"/
    );
  });

  it('rejects --branch/--all-branches, window flags, and --touching combinations', async () => {
    expectInvalidInput(
      await agent.runRaw(['list', '--between', 'main..main', '--branch', 'main', '--json']),
      /branch-agnostic/
    );
    expectInvalidInput(
      await agent.runRaw(['list', '--between', 'main..main', '--all-branches', '--json']),
      /branch-agnostic/
    );
    expectInvalidInput(
      await agent.runRaw(['list', '--between', 'main..main', '--since', '2026-01-01', '--json']),
      /range IS the window/
    );
    expectInvalidInput(
      await agent.runRaw(['list', '--between', 'main..main', '--touching', 'src/a.ts', '--json']),
      /both artifact selectors/
    );
  });
});
