import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * End-to-end coverage for AGENT-AWARE usage stamping: codex (env path AND
 * config-agent discovery), opencode (config-agent discovery against a real
 * SQLite fixture), github-copilot (env path against an OTel fixture), and
 * the silent no-op invariant when nothing resolves.
 *
 * Session identity and source roots ride the ALS invocation frame created by
 * `makeAgent({ env })`; root fixtures are stubbed before agent construction so
 * they enter that merged environment. This suite may itself run under a coding agent, so
 * every non-claude test BLANKS `CLAUDE_CODE_SESSION_ID` (and the other
 * session vars) in the agent env — blank means "unset" to the resolvers, and
 * without it the host's real session id would win the env-evidence race.
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

/** Blank every session-id env var, then apply overrides. */
function cleanSessionEnv(extras: Record<string, string> = {}): Record<string, string> {
  return {
    CLAUDE_CODE_SESSION_ID: '',
    COPILOT_AGENT_SESSION_ID: '',
    CODEX_SESSION_ID: '',
    CODEX_THREAD_ID: '',
    OPENCODE_SESSION_ID: '',
    ...extras,
  };
}

interface SnapshotRow {
  lifecycle_event: string;
  session_id: string;
  agent: string;
  cumulative_input_tokens: number;
  cumulative_output_tokens: number;
  cumulative_cache_read_input_tokens: number;
  record_count: number;
  model_breakdown: string;
}

describe('agent-aware usage stamping (codex / opencode / github-copilot)', () => {
  let repo: TempRepo;
  let fixtureDirs: string[];

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    fixtureDirs = [];
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await repo.cleanup();
    await Promise.all(fixtureDirs.map((d) => rm(d, { recursive: true, force: true })));
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

  async function initAndPlan(
    agent: ReturnType<typeof makeAgent>,
    captureAgent: string
  ): Promise<string> {
    parseOk(await agent.runRaw(['init', '--json', '--no-llm', '--agents', captureAgent, '--yes']));
    const ok = parseOk<{ artifact_id: string }>(
      await agent.runRaw([
        'capture',
        'plan',
        '--invoked-by-agent',
        captureAgent,
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: `${captureAgent} usage stamping e2e`,
            label: `usage-agents-e2e-${captureAgent}`,
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
    return ok.artifact_id;
  }

  /** Write a codex rollout with usage; under today's UTC date dir by default. */
  async function writeCodexFixture(o: {
    home: string;
    sid: string;
    cwd: string;
    dateOf?: Date;
    rootSessionId?: string;
    parentThreadId?: string;
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    eventTimestamp?: string;
  }): Promise<string> {
    const d = o.dateOf ?? new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dir = path.join(
      o.home,
      'sessions',
      String(d.getUTCFullYear()),
      pad(d.getUTCMonth() + 1),
      pad(d.getUTCDate())
    );
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-01-01T00-00-00-${o.sid}.jsonl`);
    const inputTokens = o.inputTokens ?? 1000;
    const cachedTokens = o.cachedTokens ?? 200;
    const outputTokens = o.outputTokens ?? 50;
    const eventTimestamp = o.eventTimestamp ?? '2024-01-01T00:00:02.000Z';
    const counters = {
      input_tokens: inputTokens,
      cached_input_tokens: cachedTokens,
      output_tokens: outputTokens,
      reasoning_output_tokens: 10,
      total_tokens: inputTokens + outputTokens,
    };
    const lines = [
      {
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: o.sid,
          session_id: o.rootSessionId ?? o.sid,
          cwd: o.cwd,
          ...(o.parentThreadId
            ? { parent_thread_id: o.parentThreadId, thread_source: 'subagent' }
            : {}),
        },
      },
      {
        timestamp: '2024-01-01T00:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5' },
      },
      {
        timestamp: eventTimestamp,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: counters,
            last_token_usage: counters,
          },
        },
      },
    ];
    await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
    return file;
  }

  it('codex via config-agent discovery: agent-correct row with mapped tokens', async () => {
    const sid = randomUUID();
    const codexHome = await createIsolatedDir('codex-home');
    await writeCodexFixture({ home: codexHome, sid, cwd: repo.path });
    vi.stubEnv('CODEX_HOME', codexHome);

    const agent = makeAgent({ cwd: repo.path, env: cleanSessionEnv(), timeoutMs: 60_000 });
    const artifactId = await initAndPlan(agent, 'codex');

    const snaps = readSnapshots(artifactId).filter((s) => s.lifecycle_event === 'plan');
    expect(snaps).toHaveLength(1);
    expect(snaps[0].agent).toBe('codex');
    expect(snaps[0].session_id).toBe(sid);
    expect(snaps[0].cumulative_input_tokens).toBe(800); // 1000 − 200 cached
    expect(snaps[0].cumulative_cache_read_input_tokens).toBe(200);
    expect(snaps[0].model_breakdown).toContain('gpt-5.5');
  });

  it('codex via CODEX_SESSION_ID env: no freshness requirement', async () => {
    const sid = randomUUID();
    const codexHome = await createIsolatedDir('codex-home-env');
    const file = await writeCodexFixture({ home: codexHome, sid, cwd: '/somewhere/unrelated' });
    // Stale mtime: discovery would reject it; the env path must not care.
    const old = new Date('2024-01-01T00:00:00.000Z');
    await utimes(file, old, old);
    vi.stubEnv('CODEX_HOME', codexHome);

    const agent = makeAgent({
      cwd: repo.path,
      env: cleanSessionEnv({ CODEX_SESSION_ID: sid }),
      timeoutMs: 60_000,
    });
    // Config agent is claude-code (default) — env evidence must still win.
    const artifactId = await initAndPlan(agent, 'claude-code');

    const snaps = readSnapshots(artifactId).filter((s) => s.lifecycle_event === 'plan');
    expect(snaps).toHaveLength(1);
    expect(snaps[0].agent).toBe('codex');
    expect(snaps[0].session_id).toBe(sid);
    expect(snaps[0].cumulative_input_tokens).toBe(800);
  });

  it('codex subagent thread identity stamps root-scoped cumulative usage', async () => {
    const root = randomUUID();
    const child = randomUUID();
    const codexHome = await createIsolatedDir('codex-home-thread');
    const oldStart = new Date('2020-01-02T00:00:00.000Z');
    await writeCodexFixture({ home: codexHome, sid: root, cwd: repo.path, dateOf: oldStart });
    await writeCodexFixture({
      home: codexHome,
      sid: child,
      cwd: repo.path,
      dateOf: oldStart,
      rootSessionId: root,
      parentThreadId: root,
      inputTokens: 400,
      cachedTokens: 100,
      outputTokens: 20,
      eventTimestamp: '2024-01-01T00:00:03.000Z',
    });
    vi.stubEnv('CODEX_HOME', codexHome);

    const agent = makeAgent({
      cwd: repo.path,
      env: cleanSessionEnv({ CODEX_THREAD_ID: child }),
      timeoutMs: 60_000,
    });
    const artifactId = await initAndPlan(agent, 'claude-code');

    const snaps = readSnapshots(artifactId).filter(
      (snapshot) => snapshot.lifecycle_event === 'plan'
    );
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      agent: 'codex',
      session_id: root,
      cumulative_input_tokens: 1100,
      cumulative_output_tokens: 70,
      cumulative_cache_read_input_tokens: 300,
      record_count: 2,
    });
  });

  it('codex missing thread identity records no usage association', async () => {
    const codexHome = await createIsolatedDir('codex-home-missing-thread');
    vi.stubEnv('CODEX_HOME', codexHome);
    const agent = makeAgent({
      cwd: repo.path,
      env: cleanSessionEnv({ CODEX_THREAD_ID: randomUUID() }),
      timeoutMs: 60_000,
    });

    const artifactId = await initAndPlan(agent, 'codex');

    expect(readSnapshots(artifactId)).toEqual([]);
  });

  it('opencode via config-agent discovery against a SQLite fixture', async () => {
    const sid = `ses_${randomUUID().replaceAll('-', '')}`;
    const dataDir = await createIsolatedDir('opencode-data');
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(
        'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);' +
          'CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT)'
      );
      db.prepare('INSERT INTO session (id, data) VALUES (?, ?)').run(
        sid,
        JSON.stringify({
          id: sid,
          directory: repo.path,
          time: { created: Date.now() - 60_000, updated: Date.now() },
        })
      );
      db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
        'msg_1',
        sid,
        JSON.stringify({
          id: 'msg_1',
          sessionID: sid,
          role: 'assistant',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          time: { created: Date.parse('2024-01-01T00:00:00.000Z') },
          cost: 0,
          tokens: { input: 120, output: 30, reasoning: 5, cache: { read: 7, write: 11 } },
        })
      );
    } finally {
      db.close();
    }
    vi.stubEnv('OPENCODE_DATA_DIR', dataDir);

    const agent = makeAgent({ cwd: repo.path, env: cleanSessionEnv(), timeoutMs: 60_000 });
    const artifactId = await initAndPlan(agent, 'opencode');

    const snaps = readSnapshots(artifactId).filter((s) => s.lifecycle_event === 'plan');
    expect(snaps).toHaveLength(1);
    expect(snaps[0].agent).toBe('opencode');
    expect(snaps[0].session_id).toBe(sid);
    expect(snaps[0].cumulative_input_tokens).toBe(120);
    expect(snaps[0].cumulative_cache_read_input_tokens).toBe(7);
    expect(snaps[0].model_breakdown).toContain('anthropic/claude-sonnet-4-5');
  });

  it('github-copilot via COPILOT_AGENT_SESSION_ID against an OTel fixture', async () => {
    const sid = `conv-${randomUUID()}`;
    const otelDir = await createIsolatedDir('copilot-otel');
    const otelFile = path.join(otelDir, 'copilot-otel.jsonl');
    await writeFile(
      otelFile,
      `${JSON.stringify({
        type: 'span',
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'chat claude-sonnet-4.6',
        endTime: [Math.floor(Date.parse('2024-01-01T00:00:00.000Z') / 1000), 0],
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.response.model': 'claude-sonnet-4.6',
          'gen_ai.conversation.id': sid,
          'gen_ai.usage.input_tokens': 500,
          'gen_ai.usage.output_tokens': 60,
          'gen_ai.usage.cache_read.input_tokens': 100,
        },
      })}\n`,
      'utf8'
    );
    // The explicit exporter path alone must be enough; the conventional
    // $HOME/.copilot/otel dir (real HOME, possibly holding real exports) is
    // still scanned but its records are filtered out by the random session id.
    vi.stubEnv('COPILOT_OTEL_FILE_EXPORTER_PATH', otelFile);

    const agent = makeAgent({
      cwd: repo.path,
      env: cleanSessionEnv({ COPILOT_AGENT_SESSION_ID: sid }),
      timeoutMs: 60_000,
    });
    const artifactId = await initAndPlan(agent, 'github-copilot');

    const snaps = readSnapshots(artifactId).filter((s) => s.lifecycle_event === 'plan');
    expect(snaps).toHaveLength(1);
    expect(snaps[0].agent).toBe('github-copilot');
    expect(snaps[0].session_id).toBe(sid);
    expect(snaps[0].cumulative_input_tokens).toBe(400); // 500 − 100 cache-inclusive
    expect(snaps[0].cumulative_cache_read_input_tokens).toBe(100);
    expect(snaps[0].model_breakdown).toContain('claude-sonnet-4.6');
  });

  it('silent no-op when the config agent has no discoverable session', async () => {
    const codexHome = await createIsolatedDir('codex-home-empty');
    vi.stubEnv('CODEX_HOME', codexHome);

    const agent = makeAgent({ cwd: repo.path, env: cleanSessionEnv(), timeoutMs: 60_000 });
    const artifactId = await initAndPlan(agent, 'codex'); // verb succeeds…
    expect(readSnapshots(artifactId)).toHaveLength(0); // …with zero usage rows
  });

  /** Isolated per-test fixture dir, removed in afterEach. */
  async function createIsolatedDir(name: string): Promise<string> {
    const dir = path.join(os.tmpdir(), `orcaops-usage-e2e-${name}-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    fixtureDirs.push(dir);
    return dir;
  }
});
