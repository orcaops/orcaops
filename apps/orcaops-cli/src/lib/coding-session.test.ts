import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAgentSession, resolveCodingSessionId } from './coding-session.js';

describe('resolveCodingSessionId', () => {
  it('reads CLAUDE_CODE_SESSION_ID, trimmed', () => {
    expect(resolveCodingSessionId({ CLAUDE_CODE_SESSION_ID: '  abc  ' })).toBe('abc');
  });

  it('returns null when unset or blank', () => {
    expect(resolveCodingSessionId({})).toBeNull();
    expect(resolveCodingSessionId({ CLAUDE_CODE_SESSION_ID: '   ' })).toBeNull();
  });
});

describe('resolveAgentSession', () => {
  const REPO = '/repo/project-x';
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'orcaops-cli-session-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  /** Write a codex rollout under the requested UTC start-date directory. */
  async function writeCodexRollout(o: {
    id: string;
    cwd?: string;
    now: Date;
    ageMs?: number;
    dateOf?: Date;
    rootSessionId?: string;
    parentThreadId?: string;
  }): Promise<string> {
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = o.dateOf ?? o.now;
    const dir = path.join(
      tmp,
      'sessions',
      String(date.getUTCFullYear()),
      pad(date.getUTCMonth() + 1),
      pad(date.getUTCDate())
    );
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-07-01T10-00-00-${o.id}.jsonl`);
    const meta =
      JSON.stringify({
        timestamp: o.now.toISOString(),
        type: 'session_meta',
        payload: {
          id: o.id,
          session_id: o.rootSessionId ?? o.id,
          cwd: o.cwd ?? REPO,
          ...(o.parentThreadId
            ? { parent_thread_id: o.parentThreadId, thread_source: 'subagent' }
            : {}),
        },
      }) + '\n';
    await writeFile(file, meta, 'utf8');
    if (o.ageMs !== undefined) {
      const then = new Date(o.now.getTime() - o.ageMs);
      await utimes(file, then, then);
    }
    return file;
  }

  it('claude env evidence beats a codex invoking-agent hint', async () => {
    const resolved = await resolveAgentSession({
      env: { CLAUDE_CODE_SESSION_ID: 'claude-sess' },
      cwd: REPO,
      invokingAgent: 'codex',
    });
    expect(resolved).toMatchObject({ agent: 'claude-code', sessionId: 'claude-sess', via: 'env' });
  });

  it('resolves github-copilot, codex, and opencode from their env vars', async () => {
    expect(
      await resolveAgentSession({ env: { COPILOT_AGENT_SESSION_ID: 'cop-1' }, cwd: REPO })
    ).toMatchObject({ agent: 'github-copilot', sessionId: 'cop-1', via: 'env' });
    expect(
      await resolveAgentSession({ env: { CODEX_SESSION_ID: 'cdx-1' }, cwd: REPO })
    ).toMatchObject({ agent: 'codex', sessionId: 'cdx-1', via: 'env' });
    expect(
      await resolveAgentSession({ env: { OPENCODE_SESSION_ID: 'ses-1' }, cwd: REPO })
    ).toMatchObject({ agent: 'opencode', sessionId: 'ses-1', via: 'env' });
  });

  it('falls back to invoking-agent discovery for codex (fresh cwd-matching rollout)', async () => {
    const now = new Date();
    await writeCodexRollout({ id: 'sess-fresh', now });
    const resolved = await resolveAgentSession({
      env: { CODEX_HOME: tmp },
      cwd: REPO,
      invokingAgent: 'codex',
      now: now.toISOString(),
    });
    expect(resolved).toMatchObject({
      agent: 'codex',
      sessionId: 'sess-fresh',
      via: 'invoking-agent-discovery',
    });
  });

  it('discovery rejects stale sessions and cwd mismatches', async () => {
    const now = new Date();
    await writeCodexRollout({ id: 'sess-stale', now, ageMs: 2 * 60 * 60_000 });
    expect(
      await resolveAgentSession({
        env: { CODEX_HOME: tmp },
        cwd: REPO,
        invokingAgent: 'codex',
        now: now.toISOString(),
      })
    ).toBeNull();

    await writeCodexRollout({ id: 'sess-elsewhere', now, cwd: '/somewhere/else' });
    expect(
      await resolveAgentSession({
        env: { CODEX_HOME: tmp },
        cwd: REPO,
        invokingAgent: 'codex',
        now: now.toISOString(),
      })
    ).toBeNull();
  });

  it('resolves old root and subagent thread IDs without cwd recency discovery', async () => {
    const root = '11111111-2222-4333-8444-555555555555';
    const child = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const now = new Date();
    const oldStart = new Date('2020-01-02T00:00:00.000Z');
    await writeCodexRollout({ id: root, now, dateOf: oldStart });
    await writeCodexRollout({
      id: child,
      now,
      dateOf: oldStart,
      rootSessionId: root,
      parentThreadId: root,
    });

    await expect(
      resolveAgentSession({ env: { CODEX_HOME: tmp, CODEX_THREAD_ID: root }, cwd: '/unrelated' })
    ).resolves.toMatchObject({ agent: 'codex', sessionId: root, via: 'env' });
    await expect(
      resolveAgentSession({ env: { CODEX_HOME: tmp, CODEX_THREAD_ID: child }, cwd: '/unrelated' })
    ).resolves.toMatchObject({ agent: 'codex', sessionId: root, via: 'env' });
  });

  it('prefers a root session variable and rejects an unverifiable thread', async () => {
    const root = '11111111-2222-4333-8444-555555555555';
    const missing = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    await expect(
      resolveAgentSession({
        env: { CODEX_HOME: tmp, CODEX_SESSION_ID: root, CODEX_THREAD_ID: missing },
        cwd: REPO,
      })
    ).resolves.toMatchObject({ agent: 'codex', sessionId: root, via: 'env' });
    await expect(
      resolveAgentSession({
        env: { CODEX_HOME: tmp, CODEX_THREAD_ID: missing },
        cwd: REPO,
        invokingAgent: 'codex',
      })
    ).resolves.toBeNull();
  });

  it('returns null for a claude-code invoking-agent hint with no discovery method', async () => {
    expect(
      await resolveAgentSession({ env: {}, cwd: REPO, invokingAgent: 'claude-code' })
    ).toBeNull();
  });

  it('returns null for agents without a usage source and for no invoking-agent hint', async () => {
    expect(await resolveAgentSession({ env: {}, cwd: REPO, invokingAgent: 'cursor' })).toBeNull();
    expect(await resolveAgentSession({ env: {}, cwd: REPO, invokingAgent: 'aider' })).toBeNull();
    expect(await resolveAgentSession({ env: {}, cwd: REPO, invokingAgent: 'other' })).toBeNull();
    expect(await resolveAgentSession({ env: {}, cwd: REPO })).toBeNull();
  });

  it('returns null for a github-copilot invoking-agent hint without its required env var', async () => {
    expect(
      await resolveAgentSession({ env: {}, cwd: REPO, invokingAgent: 'github-copilot' })
    ).toBeNull();
  });
});
