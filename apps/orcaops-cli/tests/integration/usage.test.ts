import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * `orcaops usage` end to end: empty-store repo scope,
 * UNKNOWN_ARTIFACT, and the artifact scope (exact session totals, labelled
 * attribution estimate, per-model aggregates, per-checkpoint high-water
 * spans) against a synthetic Claude Code transcript. Pure aggregation math
 * is unit-tested in `commands/usage.test.ts`.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function parseOk<T>(r: CliResult): T & { ok: true } {
  expect(r.exitCode, r.stdout || r.stderr).toBe(0);
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed as T & { ok: true };
}

interface RepoUsageOk {
  scope: 'repo';
  sessions: {
    total: number;
    tokens: { input_tokens: number; output_tokens: number };
    per_session: Array<{ agent: string; session_id: string }>;
  };
  models: Array<{ model: string; input_tokens: number; output_tokens: number }>;
  note: string;
}

interface ArtifactUsageOk {
  scope: 'artifact';
  artifact_id: string;
  session_totals_exact: Array<{ agent: string; session_id: string }>;
  attributed_estimate: { input_tokens: number };
  note: string;
  models: Array<{ model: string; input_tokens: number }>;
  checkpoints: Array<{
    checkpoint_n: number;
    agent: string;
    session_id: string;
    lifecycle_event: string;
    deltas: { input_tokens: number; output_tokens: number };
  }>;
  checkpoints_note: string;
}

const transcriptLine = (sid: string, n: number): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: sid,
    requestId: `req-${n}`,
    uuid: `uuid-${n}`,
    isSidechain: false,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: {
      id: `msg-${n}`,
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 100 * n,
        output_tokens: 40 * n,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

describe('orcaops usage', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let sid: string;
  let transcriptPath: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    sid = `sess-${randomUUID()}`;
    const claudeBase = path.join(repo.path, 'claude-config');
    const dir = path.join(claudeBase, 'projects', 'proj');
    await mkdir(dir, { recursive: true });
    transcriptPath = path.join(dir, `${sid}.jsonl`);
    await writeFile(
      transcriptPath,
      `${transcriptLine(sid, 1)}\n${transcriptLine(sid, 2)}\n`,
      'utf8'
    );
    // The usage source reads CLAUDE_CONFIG_DIR from process.env directly.
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeBase);
    agent = makeAgent({
      cwd: repo.path,
      env: { CLAUDE_CODE_SESSION_ID: sid, ORCAOPS_DISABLE_DRAIN: '1' },
      timeoutMs: 60_000,
    });
    await agent.runRaw(['init', '--json', '--no-llm']);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await repo.cleanup();
  });

  it('repo scope on an empty store: zero sessions, empty models', async () => {
    // A fresh agent without a session id records nothing.
    const bare = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    const out = parseOk<RepoUsageOk>(await bare.runRaw(['usage', '--json']));
    expect(out.scope).toBe('repo');
    expect(out.sessions.total).toBe(0);
    expect(out.sessions.tokens.input_tokens).toBe(0);
    expect(out.models).toEqual([]);
  });

  it('unknown --artifact returns UNKNOWN_ARTIFACT', async () => {
    const err = await agent.expectError(['usage', '--artifact', 'no-such-id', '--json']);
    expect(err.error.code).toBe('UNKNOWN_ARTIFACT');
  });

  it('artifact scope: exact sessions, labelled estimate, models, per-checkpoint spans', async () => {
    const plan = await agent.capturePlan(
      { task: 'usage read surface e2e', plan_steps: [{ text: 's1', label: 's1' }] },
      { noLlm: true }
    );
    const artifactId = plan.artifact_id;
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
    // Usage lands BETWEEN open and close → the close stamp's
    // cumulative-since-open delta picks it up.
    await appendFile(transcriptPath, `${transcriptLine(sid, 3)}\n`, 'utf8');
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
          summary: 'work with usage',
          files_changed: ['src/x.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);

    const out = parseOk<ArtifactUsageOk>(
      await agent.runRaw(['usage', '--artifact', artifactId, '--json'])
    );
    expect(out.scope).toBe('artifact');
    expect(out.artifact_id).toBe(artifactId);
    expect(out.session_totals_exact.map((s) => s.session_id)).toContain(sid);
    expect(out.note).toMatch(/ESTIMATE, never additive across artifacts/);
    expect(out.models.map((m) => m.model)).toEqual(['claude-opus-4-8']);
    // 100+200+300 across the three transcript lines.
    expect(out.models[0].input_tokens).toBe(600);

    const cp1 = out.checkpoints.filter((c) => c.checkpoint_n === 1);
    expect(cp1).toHaveLength(1);
    expect(cp1[0].session_id).toBe(sid);
    // The third transcript line (300 in / 120 out) landed inside the window.
    expect(cp1[0].deltas.input_tokens).toBe(300);
    expect(cp1[0].deltas.output_tokens).toBe(120);
    expect(out.checkpoints_note).toMatch(/never sum rows/);

    // Repo scope sees the same session as the accounting base.
    const repoOut = parseOk<RepoUsageOk>(await agent.runRaw(['usage', '--json']));
    expect(repoOut.sessions.total).toBe(1);
    expect(repoOut.sessions.tokens.input_tokens).toBe(600);
  });
});
