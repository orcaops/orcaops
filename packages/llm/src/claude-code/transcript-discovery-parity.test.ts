import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeCodeActivitySource, type EnvLike } from '@orcaops/agent-activity';

import { ClaudeCodeUsageSource } from './transcript-parser.js';

const SESSION_ID = 'shared-discovery-session';
const TURN_TIMESTAMP = '2031-02-03T04:05:06.000Z';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'claude-discovery-parity-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function assistantRecord(sessionId: string, inputTokens: number, timestamp: string) {
  return {
    type: 'assistant',
    sessionId,
    requestId: `request-${sessionId}-${inputTokens}`,
    uuid: `uuid-${sessionId}-${inputTokens}`,
    timestamp,
    message: {
      id: `message-${sessionId}-${inputTokens}`,
      role: 'assistant',
      model: 'claude-test',
      usage: { input_tokens: inputTokens },
    },
  };
}

async function writeSession(projectsDir: string, inputTokens: number, timestamp = TURN_TIMESTAMP) {
  const projectDir = path.join(projectsDir, 'encoded-project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, `${SESSION_ID}.jsonl`),
    `${JSON.stringify(assistantRecord(SESSION_ID, inputTokens, timestamp))}\n`
  );
}

async function expectBothConsumersFind(env: EnvLike, expectedInputTokens = 42): Promise<void> {
  const activitySource = new ClaudeCodeActivitySource(env);
  const usageSource = new ClaudeCodeUsageSource(env);

  const [activity, usage] = await Promise.all([
    activitySource.readLastActivity(new Set([SESSION_ID])),
    usageSource.readUsage(SESSION_ID),
  ]);

  expect(activity.get(SESSION_ID)).toBe(Date.parse(TURN_TIMESTAMP));
  expect(usage?.total.input_tokens).toBe(expectedInputTokens);
}

const discoveryCases: ReadonlyArray<{
  name: string;
  env: (homeDir: string) => EnvLike;
  projectsDir: (homeDir: string) => string;
}> = [
  {
    name: 'a comma-separated CLAUDE_CONFIG_DIR entry',
    env: (homeDir) => ({
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: `${path.join(homeDir, 'missing')}, ,${path.join(homeDir, 'configured')}`,
    }),
    projectsDir: (homeDir) => path.join(homeDir, 'configured', 'projects'),
  },
  {
    name: 'a leading tilde in CLAUDE_CONFIG_DIR',
    env: (homeDir) => ({ HOME: homeDir, CLAUDE_CONFIG_DIR: '~/configured' }),
    projectsDir: (homeDir) => path.join(homeDir, 'configured', 'projects'),
  },
  {
    name: 'CLAUDE_CONFIG_DIR ending in projects',
    env: (homeDir) => ({
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: path.join(homeDir, 'configured', 'projects'),
    }),
    projectsDir: (homeDir) => path.join(homeDir, 'configured', 'projects'),
  },
  {
    name: 'an explicit XDG_CONFIG_HOME',
    env: (homeDir) => ({ HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, 'xdg') }),
    projectsDir: (homeDir) => path.join(homeDir, 'xdg', 'claude', 'projects'),
  },
  {
    name: 'the default ~/.config/claude/projects root',
    env: (homeDir) => ({ HOME: homeDir }),
    projectsDir: (homeDir) => path.join(homeDir, '.config', 'claude', 'projects'),
  },
  {
    name: 'the default ~/.claude/projects root',
    env: (homeDir) => ({ HOME: homeDir }),
    projectsDir: (homeDir) => path.join(homeDir, '.claude', 'projects'),
  },
];

describe('Claude transcript discovery parity', () => {
  it.each(discoveryCases)('finds the same session under $name', async ({ env, projectsDir }) => {
    await writeSession(projectsDir(home), 42);

    await expectBothConsumersFind(env(home));
  });

  it('keeps the first XDG anchor even when the ~/.claude transcript is newer', async () => {
    await writeSession(path.join(home, '.config', 'claude', 'projects'), 11);
    await writeSession(path.join(home, '.claude', 'projects'), 99, '2031-02-03T04:05:07.000Z');

    await expectBothConsumersFind({ HOME: home }, 11);
  });

  it('falls back to default roots when CLAUDE_CONFIG_DIR has no entries', async () => {
    await writeSession(path.join(home, '.config', 'claude', 'projects'), 42);

    await expectBothConsumersFind({ HOME: home, CLAUDE_CONFIG_DIR: ' , , ' });
  });

  it('does not fall through to defaults when CLAUDE_CONFIG_DIR is set', async () => {
    await writeSession(path.join(home, '.claude', 'projects'), 42);
    const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'configured') };
    const activitySource = new ClaudeCodeActivitySource(env);
    const usageSource = new ClaudeCodeUsageSource(env);

    expect(await activitySource.readLastActivity(new Set([SESSION_ID]))).toEqual(new Map());
    expect(await usageSource.readUsage(SESSION_ID)).toBeNull();
  });

  it('returns not found for an unavailable configured root', async () => {
    const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'missing') };
    const activitySource = new ClaudeCodeActivitySource(env);
    const usageSource = new ClaudeCodeUsageSource(env);

    expect(await activitySource.readLastActivity(new Set([SESSION_ID]))).toEqual(new Map());
    expect(await usageSource.readUsage(SESSION_ID)).toBeNull();
  });

  it('rejects path-like ids in both activity and usage readers', async () => {
    const configured = path.join(home, 'configured');
    const projectsDir = path.join(configured, 'projects');
    await writeSession(projectsDir, 42);
    await writeFile(
      path.join(projectsDir, 'outside.jsonl'),
      `${JSON.stringify(assistantRecord('../outside', 99, '2040-01-01T00:00:00.000Z'))}\n`
    );
    const escapedSubagents = path.join(projectsDir, 'outside', 'subagents');
    await mkdir(escapedSubagents, { recursive: true });
    await writeFile(
      path.join(escapedSubagents, 'agent-a.jsonl'),
      `${JSON.stringify(assistantRecord('../outside', 99, '2040-01-01T00:00:01.000Z'))}\n`
    );
    const env = { HOME: home, CLAUDE_CONFIG_DIR: configured };
    const activitySource = new ClaudeCodeActivitySource(env);
    const usageSource = new ClaudeCodeUsageSource(env);
    const invalidIds = [
      '../outside',
      '..\\outside',
      '/absolute/session',
      'C:\\absolute\\session',
      '.',
      '..',
      '',
      '   ',
    ];

    const activity = await activitySource.readLastActivity(new Set([SESSION_ID, ...invalidIds]));
    expect(activity).toEqual(new Map([[SESSION_ID, Date.parse(TURN_TIMESTAMP)]]));
    for (const sessionId of invalidIds) {
      expect(await usageSource.readUsage(sessionId), sessionId).toBeNull();
    }
    expect((await usageSource.readUsage(SESSION_ID))?.total.input_tokens).toBe(42);
  });
});
