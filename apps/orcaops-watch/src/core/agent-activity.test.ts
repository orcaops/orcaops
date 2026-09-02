import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentActivitySource } from '@orcaops/agent-activity';

import { AgentActivityReader, claudeTranscriptActivity } from './agent-activity.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seedTranscript(
  entries: object[]
): Promise<{ base: string; sid: string; file: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'watch-tx-'));
  roots.push(base);
  const projectDir = path.join(base, 'projects', 'some-encoded-cwd');
  await mkdir(projectDir, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  const file = path.join(projectDir, `${sid}.jsonl`);
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { base, sid, file };
}

describe('claudeTranscriptActivity', () => {
  it('returns the last real turn timestamp, ignoring the file mtime (housekeeping bumps)', async () => {
    const turn = '2031-02-03T04:05:06.000Z';
    const { base, sid, file } = await seedTranscript([
      { type: 'user', timestamp: turn, message: { role: 'user' } },
      { type: 'assistant', timestamp: turn, message: { role: 'assistant' } },
      // A housekeeping entry with no timestamp — this is what bumps the file mtime.
      { type: 'ai-title', title: 'idle-session housekeeping' },
    ]);
    // Push the FILE mtime far into the future — the function must NOT use it.
    const future = new Date('2035-06-07T08:09:10.000Z');
    await utimes(file, future, future);

    const found = await claudeTranscriptActivity(new Set([sid]), {
      CLAUDE_CONFIG_DIR: base,
    } as NodeJS.ProcessEnv);
    expect(found.get(sid)).toBe(Date.parse(turn));
  });

  it('is a quiet no-op for no sessions or a missing base dir', async () => {
    expect((await claudeTranscriptActivity(new Set(), {} as NodeJS.ProcessEnv)).size).toBe(0);
    const missing = await claudeTranscriptActivity(new Set(['x']), {
      CLAUDE_CONFIG_DIR: path.join(tmpdir(), 'watch-nope-does-not-exist'),
    } as NodeJS.ProcessEnv);
    expect(missing.size).toBe(0);
  });
});

describe('AgentActivityReader', () => {
  it('batches and namespaces sessions while retaining provider instances', async () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const claudeRead = vi.fn(async (_sessionIds: ReadonlySet<string>) =>
      Promise.resolve(new Map([[sessionId, 100]]))
    );
    const codexRead = vi.fn(async (_sessionIds: ReadonlySet<string>) =>
      Promise.resolve(new Map([[sessionId, 200]]))
    );
    const resolves: string[] = [];
    const reader = new AgentActivityReader({}, (agent) => {
      resolves.push(agent);
      const readLastActivity = agent === 'claude-code' ? claudeRead : codexRead;
      return { agent, readLastActivity } satisfies AgentActivitySource;
    });

    const sessions = [
      { agent: 'claude-code', session_id: sessionId },
      { agent: 'claude-code', session_id: sessionId },
      { agent: 'codex', session_id: sessionId },
    ];
    const first = await reader.readLastActivity(sessions);
    const second = await reader.readLastActivity(sessions);

    expect(first.get('claude-code')?.get(sessionId)).toBe(100);
    expect(first.get('codex')?.get(sessionId)).toBe(200);
    expect(second).toEqual(first);
    expect(resolves.sort()).toEqual(['claude-code', 'codex']);
    expect(claudeRead).toHaveBeenCalledTimes(2);
    expect(codexRead).toHaveBeenCalledTimes(2);
    expect([...claudeRead.mock.calls[0]![0]]).toEqual([sessionId]);
  });

  it('isolates a failed provider and caches unsupported providers', async () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const resolves: string[] = [];
    const reader = new AgentActivityReader({}, (agent) => {
      resolves.push(agent);
      if (agent === 'unsupported') return null;
      if (agent === 'claude-code') {
        return {
          agent,
          readLastActivity: async () => {
            throw new Error('transcript unavailable');
          },
        };
      }
      return {
        agent,
        readLastActivity: async () => new Map([[sessionId, 300]]),
      };
    });
    const sessions = [
      { agent: 'claude-code', session_id: sessionId },
      { agent: 'codex', session_id: sessionId },
      { agent: 'unsupported', session_id: sessionId },
    ];

    const first = await reader.readLastActivity(sessions);
    const second = await reader.readLastActivity(sessions);

    expect(first).toEqual(new Map([['codex', new Map([[sessionId, 300]])]]));
    expect(second).toEqual(first);
    expect(resolves.sort()).toEqual(['claude-code', 'codex', 'unsupported']);
  });
});
