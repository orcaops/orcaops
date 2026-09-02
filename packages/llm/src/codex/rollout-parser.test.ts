import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CODEX_DISCOVERY_RECENCY_MS,
  CodexUsageSource,
  extractRolloutUsageEvents,
  parseRolloutMetaLine,
} from './rollout-parser.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'orcaops-llm-codex-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const SID = '019f0000-0000-7000-8000-00000000aaaa';
const CHILD = '019f0000-0000-7000-8000-00000000bbbb';
const GRANDCHILD = '019f0000-0000-7000-8000-00000000cccc';

/** The five raw codex counters, in `token_count` field names. */
function c(input: number, cached: number, output: number, reasoning: number) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function metaLine(o: {
  id: string;
  ts?: string;
  sessionId?: string;
  cwd?: string;
  threadSource?: string;
  parentThreadId?: string;
}): string {
  const ts = o.ts ?? '2026-07-01T10:00:00.000Z';
  return (
    JSON.stringify({
      timestamp: ts,
      type: 'session_meta',
      payload: {
        id: o.id,
        ...(o.sessionId !== undefined ? { session_id: o.sessionId } : {}),
        timestamp: ts,
        originator: 'codex-tui',
        cli_version: '0.142.5',
        ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
        ...(o.threadSource !== undefined ? { thread_source: o.threadSource } : {}),
        ...(o.parentThreadId !== undefined ? { parent_thread_id: o.parentThreadId } : {}),
      },
    }) + '\n'
  );
}

function turnContextLine(model: string, ts: string): string {
  return JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { model } }) + '\n';
}

function tokenCountLine(o: {
  ts: string;
  totals?: Record<string, number>;
  last?: Record<string, number>;
  infoNull?: boolean;
}): string {
  const info = o.infoNull
    ? null
    : {
        ...(o.totals !== undefined ? { total_token_usage: o.totals } : {}),
        ...(o.last !== undefined ? { last_token_usage: o.last } : {}),
        model_context_window: 258400,
      };
  return (
    JSON.stringify({ timestamp: o.ts, type: 'event_msg', payload: { type: 'token_count', info } }) +
    '\n'
  );
}

/** Write a rollout under `<root>/<tree>/<y>/<m>/<d>/rollout-<stamp>-<id>.jsonl`. */
async function writeRollout(o: {
  root?: string;
  tree?: 'sessions' | 'archived_sessions';
  date?: string; // 'YYYY/MM/DD'
  id: string;
  content: string;
  stamp?: string;
}): Promise<string> {
  const dir = path.join(o.root ?? tmp, o.tree ?? 'sessions', o.date ?? '2026/07/01');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${o.stamp ?? '2026-07-01T10-00-00'}-${o.id}.jsonl`);
  await writeFile(file, o.content, 'utf8');
  return file;
}

function source(env: Record<string, string | undefined> = {}): CodexUsageSource {
  return new CodexUsageSource({ CODEX_HOME: tmp, ...env });
}

describe('parseRolloutMetaLine', () => {
  it('parses a root session_meta (session_id present and equal to id)', () => {
    const meta = parseRolloutMetaLine(metaLine({ id: SID, sessionId: SID, cwd: '/repo/x' }));
    expect(meta).toEqual({ id: SID, rootSessionId: SID, cwd: '/repo/x', isSubagent: false });
  });

  it('falls back to payload.id when session_id is absent (older vintages)', () => {
    const meta = parseRolloutMetaLine(metaLine({ id: SID }));
    expect(meta).toEqual({ id: SID, rootSessionId: SID, isSubagent: false });
  });

  it('marks a subagent rollout and carries the parent link', () => {
    const meta = parseRolloutMetaLine(
      metaLine({ id: CHILD, sessionId: SID, threadSource: 'subagent', parentThreadId: SID })
    );
    expect(meta).toEqual({
      id: CHILD,
      rootSessionId: SID,
      isSubagent: true,
      parentThreadId: SID,
    });
  });

  it('returns null for blank, malformed, non-meta, and id-less lines', () => {
    expect(parseRolloutMetaLine('')).toBeNull();
    expect(parseRolloutMetaLine('not json')).toBeNull();
    expect(parseRolloutMetaLine(turnContextLine('gpt-5.5', '2026-07-01T10:00:00.000Z'))).toBeNull();
    expect(
      parseRolloutMetaLine(JSON.stringify({ type: 'session_meta', payload: { cwd: '/x' } }))
    ).toBeNull();
  });
});

describe('extractRolloutUsageEvents', () => {
  const meta = parseRolloutMetaLine(metaLine({ id: SID, sessionId: SID }));

  it('prefers last_token_usage and maps counters to Claude-native fields', () => {
    const content =
      turnContextLine('gpt-5.5', '2026-07-01T10:00:01.000Z') +
      tokenCountLine({
        ts: '2026-07-01T10:00:02.000Z',
        totals: c(1000, 200, 50, 10),
        last: c(1000, 200, 50, 10),
      }) +
      tokenCountLine({
        ts: '2026-07-01T10:01:02.000Z',
        totals: c(1800, 500, 120, 30),
        last: c(800, 300, 70, 20),
      });
    const events = extractRolloutUsageEvents(content, meta);
    expect(events).toHaveLength(2);
    expect(events[0].usage).toEqual({
      input_tokens: 800, // 1000 − 200 cached
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 200,
      dimensions: { reasoning_output_tokens: 10 },
    });
    expect(events[1].usage).toEqual({
      input_tokens: 500, // 800 − 300 cached
      output_tokens: 70,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 300,
      dimensions: { reasoning_output_tokens: 20 },
    });
    expect(events.every((e) => e.model === 'gpt-5.5')).toBe(true);
  });

  it('skips a null-info token_count (older sessions lead with one)', () => {
    const content =
      tokenCountLine({ ts: '2026-07-01T10:00:00.000Z', infoNull: true }) +
      turnContextLine('gpt-5.4', '2026-07-01T10:00:01.000Z') +
      tokenCountLine({ ts: '2026-07-01T10:00:02.000Z', totals: c(100, 0, 20, 0) });
    const events = extractRolloutUsageEvents(content, meta);
    expect(events).toHaveLength(1);
    expect(events[0].usage.input_tokens).toBe(100);
    expect(events[0].usage.output_tokens).toBe(20);
    expect(events[0].usage.dimensions).toBeUndefined();
  });

  it('falls back to saturating cumulative diffs and clamps a reset to zero', () => {
    const content =
      turnContextLine('gpt-5.5', '2026-07-01T10:00:00.000Z') +
      tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', totals: c(100, 10, 20, 5) }) +
      tokenCountLine({ ts: '2026-07-01T10:00:02.000Z', totals: c(250, 30, 60, 15) }) +
      // Reset: totals DROP (resume/compaction edge) → all-zero delta, skipped.
      tokenCountLine({ ts: '2026-07-01T10:00:03.000Z', totals: c(50, 5, 10, 2) }) +
      // Growth resumes from the reset baseline.
      tokenCountLine({ ts: '2026-07-01T10:00:04.000Z', totals: c(80, 10, 25, 4) });
    const events = extractRolloutUsageEvents(content, meta);
    expect(events).toHaveLength(3);
    // (100−10) + (150−20) + (30−5) non-cached input
    expect(events.reduce((n, e) => n + e.usage.input_tokens, 0)).toBe(90 + 130 + 25);
    expect(events.reduce((n, e) => n + e.usage.cache_read_input_tokens, 0)).toBe(10 + 20 + 5);
    expect(events.reduce((n, e) => n + e.usage.output_tokens, 0)).toBe(20 + 40 + 15);
  });

  it('clamps cached to input (cached ⊆ input invariant)', () => {
    const content = tokenCountLine({
      ts: '2026-07-01T10:00:01.000Z',
      last: { input_tokens: 50, cached_input_tokens: 80, output_tokens: 5, total_tokens: 55 },
    });
    const events = extractRolloutUsageEvents(content, meta);
    expect(events[0].usage.input_tokens).toBe(0);
    expect(events[0].usage.cache_read_input_tokens).toBe(50);
  });

  it('attributes each event to the model current at its line', () => {
    const content =
      turnContextLine('gpt-5.5', '2026-07-01T10:00:00.000Z') +
      tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', last: c(100, 0, 10, 0) }) +
      turnContextLine('gpt-5.4', '2026-07-01T10:01:00.000Z') +
      tokenCountLine({ ts: '2026-07-01T10:01:01.000Z', last: c(200, 0, 20, 0) });
    const events = extractRolloutUsageEvents(content, meta);
    expect(events.map((e) => e.model)).toEqual(['gpt-5.5', 'gpt-5.4']);
  });

  it('defaults the model to unknown before any turn_context', () => {
    const content = tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', last: c(10, 0, 1, 0) });
    expect(extractRolloutUsageEvents(content, meta)[0].model).toBe('unknown');
  });

  it('skips the leading same-second replay burst in a subagent rollout, carrying totals', () => {
    const subMeta = parseRolloutMetaLine(
      metaLine({ id: CHILD, sessionId: SID, threadSource: 'subagent', parentThreadId: SID })
    );
    const content =
      // Replayed parent history: two token_counts in the same second.
      tokenCountLine({ ts: '2026-07-01T10:00:00.100Z', totals: c(1000, 0, 500, 0) }) +
      tokenCountLine({ ts: '2026-07-01T10:00:00.900Z', totals: c(2000, 0, 900, 0) }) +
      // Genuine subagent turn, later second — delta vs the CARRIED totals.
      tokenCountLine({ ts: '2026-07-01T10:00:05.000Z', totals: c(2100, 0, 950, 0) });
    const events = extractRolloutUsageEvents(content, subMeta);
    expect(events).toHaveLength(1);
    expect(events[0].usage.input_tokens).toBe(100); // 2100 − 2000, not 2100
    expect(events[0].usage.output_tokens).toBe(50);
  });

  it('does not apply the replay guard to a root rollout', () => {
    const content =
      tokenCountLine({ ts: '2026-07-01T10:00:00.100Z', totals: c(100, 0, 10, 0) }) +
      tokenCountLine({ ts: '2026-07-01T10:00:00.900Z', totals: c(300, 0, 40, 0) });
    const events = extractRolloutUsageEvents(content, meta);
    expect(events).toHaveLength(2);
    expect(events[1].usage.input_tokens).toBe(200);
  });

  it('ignores garbage lines and unrelated event types', () => {
    const content =
      'not json\n\n' +
      JSON.stringify({ timestamp: '2026-07-01T10:00:00.000Z', type: 'compacted', payload: {} }) +
      '\n' +
      JSON.stringify({
        timestamp: '2026-07-01T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'exec_command_end' },
      }) +
      '\n' +
      tokenCountLine({ ts: '2026-07-01T10:00:02.000Z', last: c(10, 0, 1, 0) });
    expect(extractRolloutUsageEvents(content, meta)).toHaveLength(1);
  });
});

describe('CodexUsageSource.readUsage', () => {
  it('sums per-turn deltas into totals and a per-model breakdown', async () => {
    await writeRollout({
      id: SID,
      content:
        metaLine({ id: SID, sessionId: SID }) +
        turnContextLine('gpt-5.5', '2026-07-01T10:00:00.000Z') +
        tokenCountLine({
          ts: '2026-07-01T10:00:01.000Z',
          totals: c(1000, 200, 50, 10),
          last: c(1000, 200, 50, 10),
        }) +
        tokenCountLine({
          ts: '2026-07-01T10:01:01.000Z',
          totals: c(1800, 500, 120, 30),
          last: c(800, 300, 70, 20),
        }),
    });
    const snap = await source().readUsage(SID);
    expect(snap).not.toBeNull();
    expect(snap!.total).toEqual({
      input_tokens: 1300,
      output_tokens: 120,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 500,
      dimensions: { reasoning_output_tokens: 30 },
    });
    expect(snap!.recordCount).toBe(2);
    expect(snap!.modelBreakdown).toEqual([
      {
        model: 'gpt-5.5',
        usage: {
          input_tokens: 1300,
          output_tokens: 120,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 500,
          dimensions: { reasoning_output_tokens: 30 },
        },
      },
    ]);
    expect(snap!.asOf).toBe('2026-07-01T10:01:01.000Z');
  });

  it('splits the breakdown per model, byte-sorted', async () => {
    await writeRollout({
      id: SID,
      content:
        metaLine({ id: SID, sessionId: SID }) +
        turnContextLine('gpt-5.5', '2026-07-01T10:00:00.000Z') +
        tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', last: c(100, 0, 10, 0) }) +
        turnContextLine('gpt-5.4', '2026-07-01T10:01:00.000Z') +
        tokenCountLine({ ts: '2026-07-01T10:01:01.000Z', last: c(40, 0, 4, 0) }),
    });
    const snap = await source().readUsage(SID);
    expect(snap!.modelBreakdown.map((m) => m.model)).toEqual(['gpt-5.4', 'gpt-5.5']);
    expect(snap!.total.input_tokens).toBe(140);
  });

  it('honors the until cutoff (ts <= until, asOf=until) and nulls before all events', async () => {
    await writeRollout({
      id: SID,
      content:
        metaLine({ id: SID, sessionId: SID }) +
        tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', last: c(10, 0, 1, 0) }) +
        tokenCountLine({ ts: '2026-07-01T11:00:01.000Z', last: c(99, 0, 9, 0) }),
    });
    const snap = await source().readUsage(SID, { until: '2026-07-01T10:30:00.000Z' });
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(10);
    expect(snap!.asOf).toBe('2026-07-01T10:30:00.000Z');

    expect(await source().readUsage(SID, { until: '2026-07-01T09:00:00.000Z' })).toBeNull();
  });

  it('collapses an archived_sessions byte-copy via event dedup', async () => {
    const content =
      metaLine({ id: SID, sessionId: SID }) +
      turnContextLine('gpt-5.5', '2026-07-01T10:00:00.000Z') +
      tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', last: c(100, 20, 10, 5) });
    await writeRollout({ id: SID, content });
    await writeRollout({ id: SID, tree: 'archived_sessions', content });
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(80);
  });

  it('rolls subagent rollouts up into the root session, transitively', async () => {
    await writeRollout({
      id: SID,
      content:
        metaLine({ id: SID, sessionId: SID }) +
        turnContextLine('gpt-5.5', '2026-07-01T10:00:00.000Z') +
        tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', last: c(100, 0, 10, 0) }),
    });
    // Child: newer format (session_id = root).
    await writeRollout({
      id: CHILD,
      stamp: '2026-07-01T10-05-00',
      content:
        metaLine({ id: CHILD, sessionId: SID, threadSource: 'subagent', parentThreadId: SID }) +
        turnContextLine('gpt-5.5-mini', '2026-07-01T10:05:00.000Z') +
        tokenCountLine({ ts: '2026-07-01T10:05:01.000Z', last: c(40, 0, 4, 0) }),
    });
    // Grandchild: OLDER format — no session_id, linked only via parent_thread_id
    // to the child, so it matches only transitively.
    await writeRollout({
      id: GRANDCHILD,
      stamp: '2026-07-01T10-06-00',
      date: '2026/07/02',
      content:
        metaLine({ id: GRANDCHILD, threadSource: 'subagent', parentThreadId: CHILD }) +
        turnContextLine('gpt-5.5-mini', '2026-07-01T10:06:00.000Z') +
        tokenCountLine({ ts: '2026-07-01T10:06:01.000Z', last: c(7, 0, 2, 0) }),
    });
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(3);
    expect(snap!.total.input_tokens).toBe(147);
    expect(snap!.modelBreakdown.map((m) => m.model)).toEqual(['gpt-5.5', 'gpt-5.5-mini']);

    const childAnchored = await source().readUsage(CHILD);
    expect(childAnchored).toEqual(snap);
  });

  it('does not absorb an unrelated session in the same date dir', async () => {
    const other = '019f0000-0000-7000-8000-00000000ffff';
    await writeRollout({
      id: SID,
      content:
        metaLine({ id: SID, sessionId: SID }) +
        tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', last: c(10, 0, 1, 0) }),
    });
    await writeRollout({
      id: other,
      stamp: '2026-07-01T11-00-00',
      content:
        metaLine({ id: other, sessionId: other }) +
        tokenCountLine({ ts: '2026-07-01T11:00:01.000Z', last: c(999, 0, 99, 0) }),
    });
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(10);
  });

  it('returns null for a missing session, a usage-free rollout, and a blank sid', async () => {
    expect(await source().readUsage('no-such-session')).toBeNull();
    await writeRollout({ id: SID, content: metaLine({ id: SID, sessionId: SID }) });
    expect(await source().readUsage(SID)).toBeNull();
    expect(await source().readUsage('')).toBeNull();
    expect(await source().readUsage('   ')).toBeNull();
  });

  it('treats CODEX_HOME as a comma-separated list and expands ~', async () => {
    const homeA = path.join(tmp, 'home-a');
    const homeB = path.join(tmp, 'home-b');
    await writeRollout({
      root: homeB,
      id: SID,
      content:
        metaLine({ id: SID, sessionId: SID }) +
        tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', last: c(21, 0, 1, 0) }),
    });
    const csv = new CodexUsageSource({ CODEX_HOME: `${homeA}, ,${homeB}` });
    expect((await csv.readUsage(SID))!.total.input_tokens).toBe(21);

    const tilde = new CodexUsageSource({ HOME: tmp, CODEX_HOME: '~/home-b' });
    expect((await tilde.readUsage(SID))!.total.input_tokens).toBe(21);
  });

  it('defaults to ~/.codex when CODEX_HOME is unset', async () => {
    await writeRollout({
      root: path.join(tmp, '.codex'),
      id: SID,
      content:
        metaLine({ id: SID, sessionId: SID }) +
        tokenCountLine({ ts: '2026-07-01T10:00:01.000Z', last: c(33, 0, 3, 0) }),
    });
    const src = new CodexUsageSource({ HOME: tmp });
    expect((await src.readUsage(SID))!.total.input_tokens).toBe(33);
  });
});

describe('CodexUsageSource.discoverActiveSessionId', () => {
  const REPO = '/repo/project-x';

  /** Write a rollout under the date dir for `now` (UTC), so discovery scans it. */
  async function writeDiscoverable(o: {
    id: string;
    cwd?: string;
    now: Date;
    sessionId?: string;
    threadSource?: string;
    parentThreadId?: string;
    ageMs?: number;
  }): Promise<string> {
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${o.now.getUTCFullYear()}/${pad(o.now.getUTCMonth() + 1)}/${pad(o.now.getUTCDate())}`;
    const file = await writeRollout({
      id: o.id,
      date,
      content: metaLine({
        id: o.id,
        sessionId: o.sessionId ?? o.id,
        cwd: o.cwd ?? REPO,
        ...(o.threadSource !== undefined ? { threadSource: o.threadSource } : {}),
        ...(o.parentThreadId !== undefined ? { parentThreadId: o.parentThreadId } : {}),
      }),
    });
    if (o.ageMs !== undefined) {
      const then = new Date(o.now.getTime() - o.ageMs);
      await utimes(file, then, then);
    }
    return file;
  }

  it('returns the freshest cwd-matching session within the recency window', async () => {
    const now = new Date();
    const older = '019f0000-0000-7000-8000-00000000dddd';
    await writeDiscoverable({ id: older, now, ageMs: 10 * 60_000 }); // 10 min old, in window
    await writeDiscoverable({ id: SID, now }); // freshest
    const found = await source().discoverActiveSessionId({ cwd: REPO, now: now.toISOString() });
    expect(found).toBe(SID);
  });

  it('rejects stale sessions beyond the recency window', async () => {
    const now = new Date();
    await writeDiscoverable({ id: SID, now, ageMs: CODEX_DISCOVERY_RECENCY_MS + 60_000 });
    expect(
      await source().discoverActiveSessionId({ cwd: REPO, now: now.toISOString() })
    ).toBeNull();
  });

  it('rejects a cwd mismatch', async () => {
    const now = new Date();
    await writeDiscoverable({ id: SID, now, cwd: '/somewhere/else' });
    expect(
      await source().discoverActiveSessionId({ cwd: REPO, now: now.toISOString() })
    ).toBeNull();
  });

  it('resolves a subagent candidate to its root session id', async () => {
    const now = new Date();
    await writeDiscoverable({
      id: CHILD,
      sessionId: SID,
      threadSource: 'subagent',
      parentThreadId: SID,
      now,
    });
    const found = await source().discoverActiveSessionId({ cwd: REPO, now: now.toISOString() });
    expect(found).toBe(SID);
  });

  it('returns null without a cwd to match against', async () => {
    const now = new Date();
    await writeDiscoverable({ id: SID, now });
    expect(await source().discoverActiveSessionId({ now: now.toISOString() })).toBeNull();
    expect(
      await source().discoverActiveSessionId({ cwd: '  ', now: now.toISOString() })
    ).toBeNull();
  });
});

describe('CodexUsageSource.resolveActiveSessionId', () => {
  it('prefers CODEX_SESSION_ID and falls back to CODEX_THREAD_ID', () => {
    const src = new CodexUsageSource({
      CODEX_SESSION_ID: `  ${SID}  `,
      CODEX_THREAD_ID: CHILD,
    });
    expect(src.resolveActiveSessionId()).toBe(SID);
    expect(new CodexUsageSource({ CODEX_THREAD_ID: `  ${CHILD}  ` }).resolveActiveSessionId()).toBe(
      CHILD
    );
  });

  it('prefers an explicitly passed env over the constructor env', () => {
    const src = new CodexUsageSource({ CODEX_SESSION_ID: 'ctor' });
    expect(src.resolveActiveSessionId({ CODEX_SESSION_ID: 'param' })).toBe('param');
  });

  it('returns null when unset or blank', () => {
    expect(new CodexUsageSource({}).resolveActiveSessionId()).toBeNull();
    expect(
      new CodexUsageSource({
        CODEX_SESSION_ID: '   ',
        CODEX_THREAD_ID: '  ',
      }).resolveActiveSessionId()
    ).toBeNull();
  });

  it('canonicalizes a known thread to its available root', async () => {
    await writeRollout({
      id: SID,
      date: '2020/01/02',
      content: metaLine({ id: SID, sessionId: SID }),
    });
    await writeRollout({
      id: CHILD,
      date: '2024/05/06',
      content: metaLine({
        id: CHILD,
        sessionId: SID,
        threadSource: 'subagent',
        parentThreadId: SID,
      }),
    });
    const src = source({ CODEX_THREAD_ID: CHILD });

    expect(await src.canonicalizeSessionId(CHILD)).toBe(SID);
    expect(await src.canonicalizeSessionId(GRANDCHILD)).toBeNull();
    expect(await src.canonicalizeSessionId(SID, { CODEX_SESSION_ID: SID })).toBe(SID);
  });
});
