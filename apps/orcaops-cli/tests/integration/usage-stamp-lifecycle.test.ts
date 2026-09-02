import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * End-to-end coverage for coding-agent usage stamping across the full
 * capture lifecycle. Drives real CLI commands against a temp repo with a
 * synthetic Claude Code transcript, then reads the usage ledger directly.
 *
 * The load-bearing contract: the idempotent commands (summary, plan revise,
 * checkpoint abandon) stamp exactly ONCE even when re-invoked with the same
 * idempotency_key (the replay arm returns without a usageStamp), while
 * pre-pr-check deliberately RE-STAMPS on every invocation (fresh-uuid key) so
 * the final-boundary cumulative is never frozen at an earlier, lower read.
 *
 * Env seam: the session id is read from the ALS
 * invocation frame (so it rides `makeAgent({ env })`), but the transcript base
 * is read from `process.env.CLAUDE_CONFIG_DIR` directly by ClaudeCodeUsageSource
 * (`resolveAgentUsageSource` constructs it with no env), so it must be stubbed
 * on the real `process.env` via `vi.stubEnv`.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function parseOk<T = Record<string, unknown>>(r: CliResult): T & { ok: true } {
  expect(r.exitCode, r.stdout || r.stderr).toBe(0);
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed as T & { ok: true };
}

/** Write a minimal Claude Code transcript the usage source can read. */
async function writeTranscriptFixture(base: string, sid: string): Promise<void> {
  const dir = path.join(base, 'projects', 'proj');
  await mkdir(dir, { recursive: true });
  const line = (n: number): string =>
    JSON.stringify({
      type: 'assistant',
      sessionId: sid,
      requestId: `req-${n}`,
      uuid: `uuid-${n}`,
      isSidechain: false,
      // Comfortably in the past so any `until = now` read-cutoff includes it.
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
  await writeFile(path.join(dir, `${sid}.jsonl`), `${line(1)}\n${line(2)}\n`, 'utf8');
}

interface SnapshotRow {
  lifecycle_event: string;
  session_id: string;
  agent: string;
  idempotency_key: string;
  cumulative_input_tokens: number;
}

describe('usage stamping across the capture lifecycle', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let sid: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    sid = `sess-${randomUUID()}`;
    const claudeBase = path.join(repo.path, 'claude-config');
    await writeTranscriptFixture(claudeBase, sid);
    // Source reads CLAUDE_CONFIG_DIR from process.env directly (not the ALS frame).
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeBase);
    // Session id is read via the ALS frame → thread it through the harness env.
    agent = makeAgent({ cwd: repo.path, env: { CLAUDE_CODE_SESSION_ID: sid }, timeoutMs: 60_000 });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await repo.cleanup();
  });

  function readSnapshots(artifactId: string): SnapshotRow[] {
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    const store = new Store(dbPath);
    try {
      return store.readUsageSnapshots(artifactId) as unknown as SnapshotRow[];
    } finally {
      store.close();
    }
  }

  async function capturePlan(): Promise<{ artifactId: string; stepIds: string[] }> {
    parseOk(await agent.runRaw(['init', '--json', '--no-llm']));
    const ok = parseOk<{
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    }>(
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'usage stamp lifecycle e2e',
            label: 'usage-stamp-lifecycle-e2e',
            plan_steps: [
              { text: 'step a', label: 's1' },
              { text: 'step b', label: 's2' },
              { text: 'step c', label: 's3' },
            ],
            touched_scope: [],
          })
        ),
      ])
    );
    return { artifactId: ok.artifact_id, stepIds: ok.plan_steps.map((s) => s.step_id) };
  }

  it('stamps every lifecycle boundary; idempotent commands never duplicate', async () => {
    const { artifactId, stepIds } = await capturePlan();

    // plan revise — invoke twice with the SAME key; the second is a replay.
    const reviseKey = `rev-${randomUUID()}`;
    const revisePayload = {
      idempotency_key: reviseKey,
      artifact_id: artifactId,
      label: 'usage-stamp-lifecycle-e2e v2',
      rationale: 'tighten step wording for the e2e flow',
      prior_plan_event_id: null,
      plan_steps: stepIds.map((id, i) => ({
        step_id: id,
        text: `step ${i + 1} (revised)`,
        label: `s${i + 1}`,
      })),
      touched_scope: [],
    };
    parseOk(
      await agent.runRaw([
        'capture',
        'plan',
        'revise',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify(revisePayload)),
      ])
    );
    const reviseReplay = parseOk<{ idempotency_status?: string }>(
      await agent.runRaw([
        'capture',
        'plan',
        'revise',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify(revisePayload)),
      ])
    );
    expect(reviseReplay.idempotency_status).toBe('replay');

    // checkpoint open[1] → abandon[1] (twice, same key → replay).
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
            artifact_id: artifactId,
            declared_step_ids: [stepIds[0]],
          })
        ),
      ])
    );
    const abandonPayload = {
      idempotency_key: `aban-${randomUUID()}`,
      artifact_id: artifactId,
      n: 1,
      reason: 'rescope',
    };
    parseOk(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'abandon',
        '--input',
        inputFile(JSON.stringify(abandonPayload)),
      ])
    );
    const abandonReplay = parseOk<{ idempotency_status?: string }>(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'abandon',
        '--input',
        inputFile(JSON.stringify(abandonPayload)),
      ])
    );
    expect(abandonReplay.idempotency_status).toBe('replay');

    // checkpoint open[2] → close[2].
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
            artifact_id: artifactId,
            declared_step_ids: [stepIds[1]],
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
            artifact_id: artifactId,
            n: 2,
            summary: 'did step b',
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [stepIds[1]],
          })
        ),
      ])
    );

    // pre-pr-check (once here; the dedicated re-stamp test covers the doubling).
    parseOk(
      await agent.runRaw([
        'capture',
        'pre-pr-check',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({ idempotency_key: `pp-${randomUUID()}`, artifact_id: artifactId })
        ),
      ])
    );

    // summary — invoke twice with the SAME key; the second is a replay.
    const summaryPayload = {
      idempotency_key: `sum-${randomUUID()}`,
      artifact_id: artifactId,
      outcome: 'shipped',
    };
    parseOk(
      await agent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify(summaryPayload)),
      ])
    );
    const summaryReplay = parseOk<{ idempotency_status?: string }>(
      await agent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify(summaryPayload)),
      ])
    );
    expect(summaryReplay.idempotency_status).toBe('replay');

    // ── assert the ledger ──
    const snaps = readSnapshots(artifactId);
    const byEvent = (e: string): SnapshotRow[] => snaps.filter((s) => s.lifecycle_event === e);

    // Every lifecycle boundary recorded at least once (proves the stamps fire
    // AND that the transcript fixture was actually read — a broken env seam
    // would yield zero snapshots and fail here).
    for (const e of [
      'plan',
      'plan_revision',
      'checkpoint_open',
      'checkpoint_abandon',
      'checkpoint_close',
      'pre_pr_check',
      'summary',
    ]) {
      expect(byEvent(e).length, `expected at least one '${e}' snapshot`).toBeGreaterThanOrEqual(1);
    }

    // Real usage was attributed (not a silent no-op stamp).
    expect(byEvent('plan')[0].cumulative_input_tokens).toBeGreaterThan(0);
    expect(snaps.every((s) => s.session_id === sid && s.agent === 'claude-code')).toBe(true);

    // The load-bearing contract: idempotent commands stamp exactly once despite
    // the replay re-invocation.
    expect(byEvent('summary')).toHaveLength(1);
    expect(byEvent('plan_revision')).toHaveLength(1);
    expect(byEvent('checkpoint_abandon')).toHaveLength(1);
  });

  it('pre-pr-check re-stamps on every invocation, even with the same idempotency_key', async () => {
    const { artifactId } = await capturePlan();

    // Same idempotency_key both times — pre-pr-check ignores it and keys the
    // stamp on a fresh uuid, so each invocation appends a distinct snapshot.
    const sameKey = `pp-fixed-${randomUUID()}`;
    const prePr = (): Promise<CliResult> =>
      agent.runRaw([
        'capture',
        'pre-pr-check',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ idempotency_key: sameKey, artifact_id: artifactId })),
      ]);
    parseOk(await prePr());
    parseOk(await prePr());

    const prePrSnaps = readSnapshots(artifactId).filter(
      (s) => s.lifecycle_event === 'pre_pr_check'
    );
    expect(prePrSnaps).toHaveLength(2);
    // Two genuinely distinct ledger rows (distinct stamp keys), not a re-write.
    expect(new Set(prePrSnaps.map((s) => s.idempotency_key)).size).toBe(2);
  });
});
