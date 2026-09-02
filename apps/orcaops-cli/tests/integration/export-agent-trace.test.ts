import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops export agent-trace`.
 *
 * Covers: the v0.1.0 record shape with line-level ranges valid at the
 * commit, the coverage disclosure, `--notes` at the orcaops namespace
 * (and ONLY there), `--out` JSONL append + in-repo warning behavior.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TraceRecord {
  version: string;
  id: string;
  vcs: { type: string; revision: string };
  tool: { name: string; version: string };
  files: Array<{
    path: string;
    conversations: Array<{
      contributor: { type: string; model_id?: string };
      ranges: Array<{ start_line: number; end_line: number }>;
      match_kind?: string;
      related: Array<{ type: string; url: string }>;
    }>;
  }>;
  metadata: Record<
    string,
    { coverage: { added_lines: number; attributed_lines: number; cross_file_lines?: number } }
  >;
}

describe('orcaops export agent-trace', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--json',
        '--no-llm',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  /** Plan + one closed cp whose work is a COMMIT adding traced.ts. */
  async function artifactWithCommit(): Promise<{ artifactId: string; commitSha: string }> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'export fixture',
          label: `trace-export-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
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
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    await commitFile(
      repo.path,
      'traced.ts',
      'export function tracedByOrcaops(): number {\n  return 4242;\n}\n',
      'traced work'
    );
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path })
      .toString()
      .trim();
    const close = await agent.runRaw([
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
          summary: 'cp1',
          files_changed: ['traced.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    expect(close.exitCode).toBe(0);
    return { artifactId: plan.artifact_id, commitSha };
  }

  it('emits a v0.1.0 record with line ranges attributed to the checkpoint', async () => {
    const { artifactId, commitSha } = await artifactWithCommit();
    const r: CliResult = await agent.runRaw([
      'export',
      'agent-trace',
      '--commit',
      commitSha,
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { record: TraceRecord; notes_written: boolean };
    const record = out.record;

    expect(record.version).toBe('0.1.0');
    expect(record.vcs).toEqual({ type: 'git', revision: commitSha });
    expect(record.tool.name).toBe('orcaops');

    const traced = record.files.find((f) => f.path === 'traced.ts');
    expect(traced).toBeDefined();
    const convo = traced!.conversations[0];
    expect(convo.contributor.type).toBe('ai');
    // The commit adds lines 1-3 (3 non-trivial lines... the closer `}` is
    // trivial-guarded), so ranges cover at least lines 1-2.
    expect(convo.ranges[0].start_line).toBe(1);
    expect(convo.related[0].url).toBe(`orcaops://artifact/${artifactId}/checkpoint/1`);

    const coverage = record.metadata['ai.orcaops'].coverage;
    expect(coverage.added_lines).toBeGreaterThanOrEqual(3);
    expect(coverage.attributed_lines).toBeGreaterThanOrEqual(2);
    // Same-file membership → the plain line-content kind.
    expect(convo.match_kind).toBe('line_content');
    expect(out.notes_written).toBe(false);
  });

  it('refuses when any pooled artifact is unreadable instead of narrowing the ambiguity pool', async () => {
    const { commitSha } = await artifactWithCommit();
    // A second artifact on the branch rots: export pools EVERY artifact,
    // so its manifests are unknowable and any single-artifact
    // attribution could be confidently wrong.
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'rot fixture',
          label: `trace-rot-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 'step b', label: 'sb' }],
          touched_scope: [],
        })
      ),
    ]);
    const rotted = JSON.parse(pr.stdout) as { artifact_id: string };
    const dir = path.join(repo.path, '.orcaops', 'artifacts', rotted.artifact_id);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"plan_captured"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');

    const r: CliResult = await agent.runRaw([
      'export',
      'agent-trace',
      '--commit',
      commitSha,
      '--json',
    ]);
    expect(r.exitCode).not.toBe(0);
    const out = JSON.parse(r.stdout) as { error: { message: string } };
    expect(out.error.message).toContain(rotted.artifact_id);
    expect(out.error.message).toMatch(/ambiguity pool/);
    expect(out.error.message).toContain('orcaops doctor');

    // The documented expendable-artifact recovery: delete the directory,
    // then rebuild IMMEDIATELY so the cache row goes too. Without the
    // rebuild a stale row reads clean-and-empty and the export would
    // proceed over a silently incomplete pool.
    await rm(dir, { recursive: true, force: true });
    const rebuild = await agent.runRaw(['rebuild', '--json']);
    expect(rebuild.exitCode).toBe(0);
    const healed: CliResult = await agent.runRaw([
      'export',
      'agent-trace',
      '--commit',
      commitSha,
      '--json',
    ]);
    expect(healed.exitCode).toBe(0);
    expect(healed.stdout).not.toContain(rotted.artifact_id);
  });

  it('emits a distinct match kind for cross-file-only content matches', async () => {
    const { artifactId } = await artifactWithCommit();
    // Copy the checkpoint-captured line into a DIFFERENT file in a later
    // commit no checkpoint covers: the content matches cp1's manifest,
    // but only under traced.ts — cross-file evidence, distinctly kinded.
    const copySha = await commitFile(
      repo.path,
      'copied.ts',
      'export function tracedByOrcaops(): number {\n  return 4242;\n}\n',
      'copy the traced content elsewhere'
    );

    const r: CliResult = await agent.runRaw([
      'export',
      'agent-trace',
      '--commit',
      copySha,
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    const record = (JSON.parse(r.stdout) as { record: TraceRecord }).record;

    const copied = record.files.find((f) => f.path === 'copied.ts');
    expect(copied).toBeDefined();
    expect(copied!.conversations).toHaveLength(1);
    expect(copied!.conversations[0].match_kind).toBe('line_content_cross_file');
    expect(copied!.conversations[0].related[0].url).toBe(
      `orcaops://artifact/${artifactId}/checkpoint/1`
    );
    expect(record.metadata['ai.orcaops'].coverage.cross_file_lines).toBeGreaterThanOrEqual(2);
  });

  it('--notes attaches the record at refs/notes/orcaops/agent-trace and nowhere else', async () => {
    const { commitSha } = await artifactWithCommit();
    const r = await agent.runRaw([
      'export',
      'agent-trace',
      '--commit',
      commitSha,
      '--notes',
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.stdout) as { notes_written: boolean }).notes_written).toBe(true);

    const note = execFileSync(
      'git',
      ['notes', '--ref=refs/notes/orcaops/agent-trace', 'show', commitSha],
      { cwd: repo.path }
    ).toString();
    expect((JSON.parse(note) as TraceRecord).version).toBe('0.1.0');

    // git-ai's namespace must be untouched.
    expect(() =>
      execFileSync('git', ['notes', '--ref=refs/notes/ai', 'show', commitSha], {
        cwd: repo.path,
        stdio: 'pipe',
      })
    ).toThrow();
  });

  it('--out appends JSONL and warns for in-repo paths outside .agent-trace/', async () => {
    const { commitSha } = await artifactWithCommit();
    const inRepoOut = path.join(repo.path, 'traces.jsonl');
    const r = await agent.runRaw([
      'export',
      'agent-trace',
      '--commit',
      commitSha,
      '--out',
      inRepoOut,
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('.agent-trace/');

    const scrubbedOut = path.join(repo.path, '.agent-trace', 'traces.jsonl');
    const r2 = await agent.runRaw([
      'export',
      'agent-trace',
      '--commit',
      commitSha,
      '--out',
      scrubbedOut,
      '--json',
    ]);
    expect(r2.exitCode).toBe(0);
    expect(r2.stderr).not.toContain('gitignore it');

    const lines = (await readFile(scrubbedOut, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as TraceRecord).version).toBe('0.1.0');
  });
});
