import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transcriptReadFault = vi.hoisted(() => ({
  path: null as string | null,
  closeCalls: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const openWithReadFault = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]) !== transcriptReadFault.path) return handle;
    return {
      stat: handle.stat.bind(handle),
      read: async () => {
        throw Object.assign(new Error('mocked transcript read failure'), { code: 'EIO' });
      },
      close: async () => {
        transcriptReadFault.closeCalls += 1;
        await handle.close();
      },
    } as unknown as typeof handle;
  };
  return { ...actual, open: openWithReadFault as typeof actual.open };
});

import { ClaudeCodeActivitySource, claudeTranscriptActivity } from './claude-code.js';

const roots: string[] = [];

afterEach(async () => {
  transcriptReadFault.path = null;
  transcriptReadFault.closeCalls = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-activity-'));
  roots.push(root);
  return root;
}

async function writeTranscript(
  base: string,
  project: string,
  sessionId: string,
  lines: ReadonlyArray<object | string>
): Promise<string> {
  const projectDir = path.join(base, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  await writeFile(
    file,
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
  );
  return file;
}

async function writeSubagentTranscript(
  base: string,
  project: string,
  sessionId: string,
  relativePath: string,
  lines: ReadonlyArray<object | string>
): Promise<string> {
  const file = path.join(base, 'projects', project, sessionId, 'subagents', relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
  );
  return file;
}

describe('claudeTranscriptActivity', () => {
  it('returns the last conversation turn instead of housekeeping mtime', async () => {
    const base = await temporaryRoot();
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const turn = '2031-02-03T04:05:06.000Z';
    const file = await writeTranscript(base, 'encoded-cwd', sessionId, [
      { type: 'user', timestamp: '2031-02-03T04:04:00.000Z' },
      { type: 'assistant', timestamp: turn },
      { type: 'ai-title', timestamp: '2035-06-07T08:09:10.000Z' },
    ]);
    const future = new Date('2036-07-08T09:10:11.000Z');
    await utimes(file, future, future);

    const found = await claudeTranscriptActivity(new Set([sessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse(turn));
  });

  it('reads multiple sessions in one batch and omits missing sessions', async () => {
    const base = await temporaryRoot();
    const first = '11111111-2222-3333-4444-555555555555';
    const second = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeTranscript(base, 'first-cwd', first, [
      { type: 'assistant', timestamp: '2031-01-01T00:00:01.000Z' },
    ]);
    await writeTranscript(base, 'second-cwd', second, [
      { type: 'user', timestamp: '2031-01-01T00:00:02.000Z' },
    ]);

    const source = new ClaudeCodeActivitySource({ CLAUDE_CONFIG_DIR: base });
    const found = await source.readLastActivity(new Set([first, second, 'missing']));

    expect(found.size).toBe(2);
    expect(found.get(first)).toBe(Date.parse('2031-01-01T00:00:01.000Z'));
    expect(found.get(second)).toBe(Date.parse('2031-01-01T00:00:02.000Z'));
  });

  it('continues past partial and malformed tail records', async () => {
    const base = await temporaryRoot();
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const expected = '2031-02-03T04:05:06.000Z';
    await writeTranscript(base, 'encoded-cwd', sessionId, [
      {
        type: 'user',
        timestamp: '2030-01-01T00:00:00.000Z',
        padding: 'x'.repeat(70 * 1024),
      },
      '{not-json',
      { type: 'assistant', timestamp: expected },
      { type: 'assistant', timestamp: 'not-a-date' },
    ]);

    const found = await claudeTranscriptActivity(new Set([sessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse(expected));
  });

  it('keeps newer main activity when all subagent turns are older', async () => {
    const base = await temporaryRoot();
    const sessionId = 'main-newer';
    const mainTurn = '2031-02-03T04:05:06.000Z';
    await writeTranscript(base, 'encoded-cwd', sessionId, [
      { type: 'assistant', timestamp: mainTurn },
    ]);
    await writeSubagentTranscript(base, 'encoded-cwd', sessionId, 'agent-a.jsonl', [
      { type: 'user', timestamp: '2031-02-03T04:05:05.000Z' },
    ]);

    const found = await claudeTranscriptActivity(new Set([sessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse(mainTurn));
  });

  it('uses the newest meaningful turn across nested subagent transcripts', async () => {
    const base = await temporaryRoot();
    const sessionId = 'subagent-newer';
    await writeTranscript(base, 'encoded-cwd', sessionId, [
      { type: 'assistant', timestamp: '2031-02-03T04:05:05.000Z' },
    ]);
    await writeSubagentTranscript(base, 'encoded-cwd', sessionId, 'agent-a.jsonl', [
      { type: 'user', timestamp: '2031-02-03T04:05:06.000Z' },
    ]);
    await writeSubagentTranscript(base, 'encoded-cwd', sessionId, 'nested/agent-b.jsonl', [
      { type: 'assistant', timestamp: '2031-02-03T04:05:07.000Z' },
      { type: 'ai-title', timestamp: '2035-06-07T08:09:10.000Z' },
    ]);

    const found = await claudeTranscriptActivity(new Set([sessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse('2031-02-03T04:05:07.000Z'));
  });

  it('bounds each subagent tail and skips malformed or partial records', async () => {
    const base = await temporaryRoot();
    const sessionId = 'bounded-tail';
    const expected = '2031-02-03T04:05:06.000Z';
    await writeTranscript(base, 'encoded-cwd', sessionId, [
      { type: 'assistant', timestamp: '2031-02-03T04:05:05.000Z' },
    ]);
    await writeSubagentTranscript(base, 'encoded-cwd', sessionId, 'agent-a.jsonl', [
      {
        type: 'assistant',
        timestamp: '2040-01-01T00:00:00.000Z',
        padding: 'x'.repeat(70 * 1024),
      },
      '{not-json',
      { type: 'assistant', timestamp: expected },
      '{partial',
    ]);

    const found = await claudeTranscriptActivity(new Set([sessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse(expected));
  });

  it('does not let housekeeping-only subagent files override meaningful turns', async () => {
    const base = await temporaryRoot();
    const sessionId = 'housekeeping';
    const meaningful = '2031-02-03T04:05:06.000Z';
    await writeTranscript(base, 'encoded-cwd', sessionId, [
      { type: 'assistant', timestamp: meaningful },
    ]);
    const housekeeping = await writeSubagentTranscript(
      base,
      'encoded-cwd',
      sessionId,
      'agent-a.jsonl',
      [{ type: 'ai-title', timestamp: '2035-06-07T08:09:10.000Z' }]
    );
    const future = new Date('2036-07-08T09:10:11.000Z');
    await utimes(housekeeping, future, future);

    const found = await claudeTranscriptActivity(new Set([sessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse(meaningful));
  });

  it('ignores sibling-session, flat sibling, symlinked, and non-JSONL files', async () => {
    const base = await temporaryRoot();
    const sessionId = 'target-session';
    const expected = '2031-02-03T04:05:06.000Z';
    await writeTranscript(base, 'encoded-cwd', sessionId, [
      { type: 'assistant', timestamp: expected },
    ]);
    const sibling = await writeSubagentTranscript(
      base,
      'encoded-cwd',
      'sibling-session',
      'agent-a.jsonl',
      [{ type: 'assistant', timestamp: '2040-01-01T00:00:00.000Z' }]
    );
    await writeTranscript(base, 'encoded-cwd', 'flat-sibling', [
      { type: 'assistant', timestamp: '2041-01-01T00:00:00.000Z' },
    ]);
    await writeSubagentTranscript(base, 'encoded-cwd', sessionId, 'agent-a.txt', [
      { type: 'assistant', timestamp: '2042-01-01T00:00:00.000Z' },
    ]);
    const linked = path.join(
      base,
      'projects',
      'encoded-cwd',
      sessionId,
      'subagents',
      'linked.jsonl'
    );
    await symlink(sibling, linked);

    const found = await claudeTranscriptActivity(new Set([sessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse(expected));
  });

  it('skips a subagent when its tail read fails', async () => {
    const base = await temporaryRoot();
    const sessionId = 'failed-subagent-read';
    const expected = '2031-02-03T04:05:06.000Z';
    await writeTranscript(base, 'encoded-cwd', sessionId, [
      { type: 'assistant', timestamp: expected },
    ]);
    const unreadable = await writeSubagentTranscript(
      base,
      'encoded-cwd',
      sessionId,
      'nested/agent-a.jsonl',
      [{ type: 'assistant', timestamp: '2040-01-01T00:00:00.000Z' }]
    );
    transcriptReadFault.path = unreadable;

    const found = await claudeTranscriptActivity(new Set([sessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse(expected));
    expect(transcriptReadFault.closeCalls).toBe(1);
  });

  it('uses subagent activity and continues the batch when a main tail read fails', async () => {
    const base = await temporaryRoot();
    const sessionId = 'failed-main-read';
    const otherSessionId = 'readable-main';
    const failedMain = await writeTranscript(base, 'encoded-cwd', sessionId, [
      { type: 'assistant', timestamp: '2031-02-03T04:05:07.000Z' },
    ]);
    await writeSubagentTranscript(base, 'encoded-cwd', sessionId, 'agent-a.jsonl', [
      { type: 'assistant', timestamp: '2031-02-03T04:05:06.000Z' },
    ]);
    await writeTranscript(base, 'encoded-cwd', otherSessionId, [
      { type: 'user', timestamp: '2031-02-03T04:05:07.000Z' },
    ]);
    transcriptReadFault.path = failedMain;

    const found = await claudeTranscriptActivity(new Set([sessionId, otherSessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse('2031-02-03T04:05:06.000Z'));
    expect(found.get(otherSessionId)).toBe(Date.parse('2031-02-03T04:05:07.000Z'));
    expect(transcriptReadFault.closeCalls).toBe(1);
  });

  it('preserves main-transcript behavior when no subagent subtree exists', async () => {
    const base = await temporaryRoot();
    const sessionId = 'no-subagents';
    const expected = '2031-02-03T04:05:06.000Z';
    await writeTranscript(base, 'encoded-cwd', sessionId, [
      { type: 'assistant', timestamp: expected },
      { type: 'ai-title', timestamp: '2035-06-07T08:09:10.000Z' },
    ]);

    const found = await claudeTranscriptActivity(new Set([sessionId]), {
      CLAUDE_CONFIG_DIR: base,
    });

    expect(found.get(sessionId)).toBe(Date.parse(expected));
  });

  it('is a quiet no-op for no sessions or a missing base', async () => {
    expect((await claudeTranscriptActivity(new Set(), {})).size).toBe(0);
    const missing = await claudeTranscriptActivity(new Set(['missing']), {
      CLAUDE_CONFIG_DIR: path.join(await temporaryRoot(), 'absent'),
    });
    expect(missing.size).toBe(0);
  });
});
