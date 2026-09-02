import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeCodeUsageSource, parseTranscriptUsageLine } from './transcript-parser.js';

let tmp: string;
let seq = 0;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'orcaops-llm-usage-'));
  seq = 0;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Build one `assistant` transcript line (with a trailing newline). `usage` is a
 *  raw usage object — the four scalar fields, plus optional nested
 *  `cache_creation` / `server_tool_use` and `speed` / `service_tier` /
 *  `inference_geo` siblings. */
function al(o: {
  sid: string;
  model: string;
  ts: string;
  usage: Record<string, unknown>;
  id?: string;
  requestId?: string;
  uuid?: string;
  isSidechain?: boolean;
}): string {
  const n = seq++;
  return (
    JSON.stringify({
      type: 'assistant',
      sessionId: o.sid,
      requestId: o.requestId ?? `req-${n}`,
      uuid: o.uuid ?? `uuid-${n}`,
      isSidechain: o.isSidechain ?? false,
      timestamp: o.ts,
      message: { id: o.id ?? `msg-${n}`, role: 'assistant', model: o.model, usage: o.usage },
    }) + '\n'
  );
}

async function writeTranscript(
  base: string,
  projDir: string,
  fileName: string,
  content: string
): Promise<void> {
  const dir = path.join(base, 'projects', projDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, 'utf8');
}

function source(): ClaudeCodeUsageSource {
  return new ClaudeCodeUsageSource({ CLAUDE_CONFIG_DIR: tmp });
}

describe('ClaudeCodeUsageSource.readUsage', () => {
  it('sums token usage for a session and reports asOf as the latest record', async () => {
    const sid = 'sess-1';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'claude-opus-4-8',
        ts: '2026-01-01T00:00:00.000Z',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      }) +
        al({
          sid,
          model: 'claude-opus-4-8',
          ts: '2026-01-01T00:01:00.000Z',
          usage: { input_tokens: 3, output_tokens: 7 },
        })
    );

    const snap = await source().readUsage(sid);
    expect(snap).not.toBeNull();
    expect(snap!.total).toEqual({
      input_tokens: 13,
      output_tokens: 12,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    });
    expect(snap!.recordCount).toBe(2);
    expect(snap!.modelBreakdown).toEqual([
      {
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 13,
          output_tokens: 12,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      },
    ]);
    expect(snap!.asOf).toBe('2026-01-01T00:01:00.000Z');
  });

  it('counts inline subagent (sidechain) records sharing the session id', async () => {
    const sid = 'sess-2';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'claude-opus-4-8',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 10, output_tokens: 1 },
        isSidechain: false,
      }) +
        al({
          sid,
          model: 'claude-opus-4-8',
          ts: '2026-01-01T00:00:30.000Z',
          usage: { input_tokens: 4, output_tokens: 2 },
          isSidechain: true,
        })
    );

    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(2);
    expect(snap!.total.input_tokens).toBe(14);
    expect(snap!.total.output_tokens).toBe(3);
  });

  it('counts subagent records from a sibling *.jsonl in the same project dir', async () => {
    const sid = 'sess-3';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'm',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 10, output_tokens: 1 },
      })
    );
    await writeTranscript(
      tmp,
      'proj-a',
      'subagent-sidechain.jsonl',
      al({
        sid,
        model: 'm',
        ts: '2026-01-01T00:00:30.000Z',
        usage: { input_tokens: 5, output_tokens: 2 },
      })
    );

    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(2);
    expect(snap!.total.input_tokens).toBe(15);
    expect(snap!.total.output_tokens).toBe(3);
  });

  it('counts subagent records from a real <sid>/subagents/ subdir (recursive scan)', async () => {
    const sid = 'sess-subdir';
    // Main chain (Opus) in the flat project dir.
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'claude-opus-4-8',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 10, output_tokens: 1 },
      })
    );
    // Subagent (Haiku) in the session's OWN <sid>/subagents/ subdir — NOT a flat
    // sibling. This is the case the flat readdir missed; a flat sibling would pass
    // without the recursive scan, so the subdir placement is the real guard.
    await writeTranscript(
      tmp,
      path.join('proj-a', sid, 'subagents'),
      'agent-abc123.jsonl',
      al({
        sid,
        model: 'claude-haiku-4-5-20251001',
        ts: '2026-01-01T00:00:30.000Z',
        usage: { input_tokens: 5, output_tokens: 2 },
      })
    );

    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(2);
    expect(snap!.total.input_tokens).toBe(15);
    expect(snap!.total.output_tokens).toBe(3);
    expect(snap!.modelBreakdown.map((m) => m.model)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
    ]);
  });

  it('excludes subagent-subdir records past the until cutoff', async () => {
    const sid = 'sess-subdir-until';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({ sid, model: 'm', ts: '2026-01-01T00:00:00.000Z', usage: { input_tokens: 10 } })
    );
    await writeTranscript(
      tmp,
      path.join('proj-a', sid, 'subagents'),
      'agent-late.jsonl',
      al({ sid, model: 'm', ts: '2026-01-01T01:00:00.000Z', usage: { input_tokens: 99 } })
    );
    const snap = await source().readUsage(sid, { until: '2026-01-01T00:30:00.000Z' });
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(10);
  });

  it('does not double-count a message duplicated across the main file and the subagent subdir', async () => {
    const sid = 'sess-subdir-dedup';
    const dup = al({
      sid,
      id: 'msg-DUP',
      requestId: 'req-DUP',
      model: 'm',
      ts: '2026-01-01T00:00:00.000Z',
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    await writeTranscript(tmp, 'proj-a', `${sid}.jsonl`, dup);
    await writeTranscript(tmp, path.join('proj-a', sid, 'subagents'), 'agent-dup.jsonl', dup);
    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(1); // (message.id, requestId) dedup across files
    expect(snap!.total.input_tokens).toBe(10);
  });

  it('drops a zero-usage <synthetic> model row from modelBreakdown without changing the total', async () => {
    const sid = 'sess-synthetic';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'claude-opus-4-8',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 10, output_tokens: 2 },
      }) + al({ sid, model: '<synthetic>', ts: '2026-01-01T00:01:00.000Z', usage: {} })
    );
    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(2); // both records counted...
    expect(snap!.modelBreakdown.map((m) => m.model)).toEqual(['claude-opus-4-8']); // ...zero row dropped
    expect(snap!.total).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it('keeps the more-complete record on an exact scalar-total tie (completeness tiebreak)', async () => {
    const sid = 'sess-complete';
    // Two records share (id, requestId) and the SAME scalar total (10), but one
    // populates more fields. The more-complete record must win — not the later ts.
    const sparse = al({
      sid,
      id: 'm1',
      requestId: 'r1',
      uuid: 'u1',
      model: 'm',
      ts: '2026-01-01T00:00:02.000Z', // LATER ts — would win a ts-only tiebreak
      usage: { input_tokens: 10 },
    });
    const complete = al({
      sid,
      id: 'm1',
      requestId: 'r1',
      uuid: 'u2',
      model: 'm',
      ts: '2026-01-01T00:00:01.000Z',
      usage: { input_tokens: 5, output_tokens: 5 }, // same total (10), 2 fields
    });
    await writeTranscript(tmp, 'proj-a', `${sid}.jsonl`, sparse);
    await writeTranscript(tmp, 'proj-a', 'sibling.jsonl', complete);
    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total).toEqual({
      input_tokens: 5,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it('de-dups the same (message.id, requestId) across files, ignoring uuid', async () => {
    const sid = 'sess-4';
    const a = al({
      sid,
      id: 'msg-DUP',
      requestId: 'req-DUP',
      uuid: 'u1',
      model: 'm',
      ts: '2026-01-01T00:00:00.000Z',
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const b = al({
      sid,
      id: 'msg-DUP',
      requestId: 'req-DUP',
      uuid: 'u2',
      model: 'm',
      ts: '2026-01-01T00:00:05.000Z',
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    await writeTranscript(tmp, 'proj-a', `${sid}.jsonl`, a);
    await writeTranscript(tmp, 'proj-a', 'sibling.jsonl', b);

    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(10);
  });

  it('keeps the max-token record among (id, requestId) duplicates regardless of file order', async () => {
    const sid = 'sess-dupmax';
    // A streaming partial (5) and the complete record (20) share id+requestId.
    const partial = al({
      sid,
      id: 'm1',
      requestId: 'r1',
      uuid: 'u1',
      model: 'm',
      ts: '2026-01-01T00:00:00.000Z',
      usage: { input_tokens: 5 },
    });
    const complete = al({
      sid,
      id: 'm1',
      requestId: 'r1',
      uuid: 'u2',
      model: 'm',
      ts: '2026-01-01T00:00:01.000Z',
      usage: { input_tokens: 20 },
    });
    // Partial in the sort-EARLIER file, complete in the later one — so the
    // complete record wins on TOKEN COUNT, not scan order.
    await writeTranscript(tmp, 'proj-a', `${sid}.jsonl`, partial);
    await writeTranscript(tmp, 'proj-a', 'zzz-sibling.jsonl', complete);

    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(20); // complete dominates the partial
  });

  it('counts a sibling transcript whose mtime is far older than the anchor (no prune)', async () => {
    const sid = 'sess-mtime';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({ sid, model: 'm', ts: '2026-01-01T00:00:00.000Z', usage: { input_tokens: 10 } })
    );
    await writeTranscript(
      tmp,
      'proj-a',
      'old-subagent.jsonl',
      al({ sid, model: 'm', ts: '2026-01-02T00:00:00.000Z', usage: { input_tokens: 5 } })
    );
    // Backdate the sibling years into the past — transcript scanning never
    // prunes by mtime.
    const sib = path.join(tmp, 'projects', 'proj-a', 'old-subagent.jsonl');
    const old = new Date('2020-01-01T00:00:00.000Z');
    await utimes(sib, old, old);

    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(2); // sibling NOT pruned by its old mtime
    expect(snap!.total.input_tokens).toBe(15);
  });

  it('groups usage per model (sorted) and sums the total', async () => {
    const sid = 'sess-5';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'claude-opus-4-8',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 10, output_tokens: 2 },
      }) +
        al({
          sid,
          model: 'claude-sonnet-4-6',
          ts: '2026-01-01T00:01:00.000Z',
          usage: { input_tokens: 4, output_tokens: 8 },
        }) +
        al({
          sid,
          model: 'claude-opus-4-8',
          ts: '2026-01-01T00:02:00.000Z',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
    );

    const snap = await source().readUsage(sid);
    expect(snap!.modelBreakdown).toEqual([
      {
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 11,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      {
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 4,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);
    expect(snap!.total).toEqual({
      input_tokens: 15,
      output_tokens: 11,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it('honors the until cutoff (ts <= until) and reports asOf=until', async () => {
    const sid = 'sess-6';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'm',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 10, output_tokens: 1 },
      }) +
        al({
          sid,
          model: 'm',
          ts: '2026-01-01T01:00:00.000Z',
          usage: { input_tokens: 99, output_tokens: 1 },
        })
    );

    const snap = await source().readUsage(sid, { until: '2026-01-01T00:30:00.000Z' });
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(10);
    expect(snap!.asOf).toBe('2026-01-01T00:30:00.000Z');
  });

  it('includes a record whose timestamp equals until (inclusive bound)', async () => {
    const sid = 'sess-6b';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({ sid, model: 'm', ts: '2026-01-01T00:00:00.000Z', usage: { input_tokens: 7 } })
    );
    const snap = await source().readUsage(sid, { until: '2026-01-01T00:00:00.000Z' });
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(7);
  });

  it('excludes records belonging to a different session in the same file', async () => {
    const sid = 'sess-7';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'm',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 10, output_tokens: 0 },
      }) +
        al({
          sid: 'other-session',
          model: 'm',
          ts: '2026-01-01T00:00:01.000Z',
          usage: { input_tokens: 999, output_tokens: 0 },
        })
    );
    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(10);
  });

  it('returns null when the session transcript is absent', async () => {
    await mkdir(path.join(tmp, 'projects'), { recursive: true });
    expect(await source().readUsage('nope')).toBeNull();
  });

  it('returns null when the base dir does not exist', async () => {
    const src = new ClaudeCodeUsageSource({ CLAUDE_CONFIG_DIR: path.join(tmp, 'no-such-dir') });
    expect(await src.readUsage('x')).toBeNull();
  });

  it('returns null when the transcript has no usage records for the session', async () => {
    const sid = 'sess-empty';
    const userLine =
      JSON.stringify({
        type: 'user',
        sessionId: sid,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'hi' },
      }) + '\n';
    await writeTranscript(tmp, 'proj-a', `${sid}.jsonl`, userLine);
    expect(await source().readUsage(sid)).toBeNull();
  });

  it('returns null for a blank session id', async () => {
    expect(await source().readUsage('')).toBeNull();
    expect(await source().readUsage('   ')).toBeNull();
  });

  it('honors CLAUDE_CONFIG_DIR for the transcript base', async () => {
    const sid = 'sess-cfg';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({ sid, model: 'm', ts: '2026-01-01T00:00:00.000Z', usage: { input_tokens: 42 } })
    );
    expect((await source().readUsage(sid))!.total.input_tokens).toBe(42);

    const other = await mkdtemp(path.join(os.tmpdir(), 'orcaops-llm-other-'));
    try {
      const elsewhere = new ClaudeCodeUsageSource({ CLAUDE_CONFIG_DIR: other });
      expect(await elsewhere.readUsage(sid)).toBeNull();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('ClaudeCodeUsageSource.readUsage — base-dir discovery', () => {
  // `tmp` (a fresh mkdtemp per test) doubles as the fake HOME, so the real `~`
  // is never touched. `writeTranscript(base, ...)` writes `<base>/projects/...`,
  // so `base` is a config ROOT.
  const line = (sid: string, input: number) =>
    al({ sid, model: 'm', ts: '2026-01-01T00:00:00.000Z', usage: { input_tokens: input } });

  it('scans the XDG default base (~/.config/claude) when CLAUDE_CONFIG_DIR is unset', async () => {
    const sid = 'sess-xdg';
    await writeTranscript(
      path.join(tmp, '.config', 'claude'),
      'proj-a',
      `${sid}.jsonl`,
      line(sid, 11)
    );
    const src = new ClaudeCodeUsageSource({ HOME: tmp });
    expect((await src.readUsage(sid))!.total.input_tokens).toBe(11);
  });

  it('honors XDG_CONFIG_HOME for the XDG base', async () => {
    const sid = 'sess-xdg-override';
    const xdg = path.join(tmp, 'custom-xdg');
    await writeTranscript(path.join(xdg, 'claude'), 'proj-a', `${sid}.jsonl`, line(sid, 12));
    const src = new ClaudeCodeUsageSource({ HOME: tmp, XDG_CONFIG_HOME: xdg });
    expect((await src.readUsage(sid))!.total.input_tokens).toBe(12);
  });

  it('still scans ~/.claude when CLAUDE_CONFIG_DIR is unset', async () => {
    const sid = 'sess-home';
    await writeTranscript(path.join(tmp, '.claude'), 'proj-a', `${sid}.jsonl`, line(sid, 13));
    const src = new ClaudeCodeUsageSource({ HOME: tmp });
    expect((await src.readUsage(sid))!.total.input_tokens).toBe(13);
  });

  it('prefers the XDG base over ~/.claude when both hold the session', async () => {
    const sid = 'sess-both';
    await writeTranscript(
      path.join(tmp, '.config', 'claude'),
      'proj-a',
      `${sid}.jsonl`,
      line(sid, 100)
    );
    await writeTranscript(path.join(tmp, '.claude'), 'proj-a', `${sid}.jsonl`, line(sid, 999));
    const src = new ClaudeCodeUsageSource({ HOME: tmp });
    // XDG is discovered first, so its anchor wins; ~/.claude is never read.
    expect((await src.readUsage(sid))!.total.input_tokens).toBe(100);
  });

  it('treats CLAUDE_CONFIG_DIR as a comma-separated list (session under the 2nd entry)', async () => {
    const sid = 'sess-comma';
    const a = path.join(tmp, 'dir-a');
    const b = path.join(tmp, 'dir-b');
    await writeTranscript(b, 'proj-a', `${sid}.jsonl`, line(sid, 21));
    const src = new ClaudeCodeUsageSource({ CLAUDE_CONFIG_DIR: `${a},${b}` });
    expect((await src.readUsage(sid))!.total.input_tokens).toBe(21);
  });

  it('ignores empty/whitespace entries in a comma-separated CLAUDE_CONFIG_DIR', async () => {
    const sid = 'sess-comma-empty';
    const a = path.join(tmp, 'dir-a');
    const b = path.join(tmp, 'dir-b');
    await writeTranscript(b, 'proj-a', `${sid}.jsonl`, line(sid, 22));
    const src = new ClaudeCodeUsageSource({ CLAUDE_CONFIG_DIR: `${a}, ,${b}` });
    expect((await src.readUsage(sid))!.total.input_tokens).toBe(22);
  });

  it('expands a leading ~ in a CLAUDE_CONFIG_DIR entry', async () => {
    const sid = 'sess-tilde';
    await writeTranscript(path.join(tmp, 'myclaude'), 'proj-a', `${sid}.jsonl`, line(sid, 31));
    const src = new ClaudeCodeUsageSource({ HOME: tmp, CLAUDE_CONFIG_DIR: '~/myclaude' });
    expect((await src.readUsage(sid))!.total.input_tokens).toBe(31);
  });

  it('accepts a CLAUDE_CONFIG_DIR pointed straight at a projects dir', async () => {
    const sid = 'sess-projects-direct';
    await writeTranscript(tmp, 'proj-a', `${sid}.jsonl`, line(sid, 32));
    const src = new ClaudeCodeUsageSource({ CLAUDE_CONFIG_DIR: path.join(tmp, 'projects') });
    expect((await src.readUsage(sid))!.total.input_tokens).toBe(32);
  });

  it('does not consult ~/.claude when CLAUDE_CONFIG_DIR is set', async () => {
    const sid = 'sess-override-ignores-home';
    // Session exists only under ~/.claude ...
    await writeTranscript(path.join(tmp, '.claude'), 'proj-a', `${sid}.jsonl`, line(sid, 41));
    // ... but CLAUDE_CONFIG_DIR points at a (real, empty) config dir, so the
    // home base is never consulted and the session must NOT be found.
    const empty = path.join(tmp, 'empty-cfg');
    await mkdir(path.join(empty, 'projects'), { recursive: true });
    const src = new ClaudeCodeUsageSource({ HOME: tmp, CLAUDE_CONFIG_DIR: empty });
    expect(await src.readUsage(sid)).toBeNull();
  });
});

describe('ClaudeCodeUsageSource.readUsage — dimensions + rate classes', () => {
  it('extracts numeric dimensions from cache_creation tiers and server_tool_use', async () => {
    const sid = 'sess-dims';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'claude-opus-4-8',
        ts: '2026-01-01T00:00:00.000Z',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 5,
          cache_creation: { ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 10 },
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
        },
      })
    );
    const snap = await source().readUsage(sid);
    expect(snap!.total.dimensions).toEqual({
      cache_creation_1h_input_tokens: 20,
      cache_creation_5m_input_tokens: 10,
      web_search_requests: 2,
      web_fetch_requests: 1,
    });
    // The 1h + 5m split sums back to the flat cache_creation total (refinement).
    expect(snap!.total.cache_creation_input_tokens).toBe(30);
    expect(snap!.modelBreakdown[0].usage.dimensions).toEqual(snap!.total.dimensions);
  });

  it('partitions the breakdown by rate class (fast vs standard), omitting defaults', async () => {
    const sid = 'sess-rateclass';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'claude-opus-4-8',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 10, output_tokens: 1, speed: 'standard', service_tier: 'standard' },
      }) +
        al({
          sid,
          model: 'claude-opus-4-8',
          ts: '2026-01-01T00:01:00.000Z',
          usage: { input_tokens: 4, output_tokens: 2, speed: 'fast' },
        })
    );
    const snap = await source().readUsage(sid);
    // Same model, two rate classes → two breakdown rows.
    expect(snap!.modelBreakdown).toHaveLength(2);
    const standard = snap!.modelBreakdown.find((m) => m.speed === undefined);
    const fast = snap!.modelBreakdown.find((m) => m.speed === 'fast');
    expect(standard).toBeDefined();
    expect(standard!.service_tier).toBeUndefined(); // 'standard' is the default → omitted
    expect(standard!.usage.input_tokens).toBe(10);
    expect(fast!.speed).toBe('fast');
    expect(fast!.usage.input_tokens).toBe(4);
    expect(snap!.total.input_tokens).toBe(14); // total sums across rate classes
  });

  it('carries non-default service_tier / inference_geo and collapses default geo', async () => {
    const sid = 'sess-tier-geo';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'm',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 5, service_tier: 'batch', inference_geo: 'us' },
      }) +
        al({
          sid,
          model: 'm',
          ts: '2026-01-01T00:01:00.000Z',
          usage: { input_tokens: 7, service_tier: 'standard', inference_geo: 'not_available' },
        })
    );
    const snap = await source().readUsage(sid);
    expect(snap!.modelBreakdown).toHaveLength(2);
    const premium = snap!.modelBreakdown.find((m) => m.service_tier === 'batch');
    expect(premium!.inference_geo).toBe('us');
    expect(premium!.usage.input_tokens).toBe(5);
    const def = snap!.modelBreakdown.find((m) => m.service_tier === undefined);
    expect(def!.inference_geo).toBeUndefined(); // not_available collapses to the default
    expect(def!.usage.input_tokens).toBe(7);
  });

  it('keeps a model row with zero scalar tokens but a non-zero billable dimension', async () => {
    const sid = 'sess-dim-only';
    await writeTranscript(
      tmp,
      'proj-a',
      `${sid}.jsonl`,
      al({
        sid,
        model: 'claude-opus-4-8',
        ts: '2026-01-01T00:00:00.000Z',
        usage: { input_tokens: 10, output_tokens: 2 },
      }) +
        // All-zero scalars but a web_search request — the widened drop predicate
        // must KEEP this (a <synthetic> all-zero-no-dimension row is still dropped).
        al({
          sid,
          model: 'tool-runner',
          ts: '2026-01-01T00:01:00.000Z',
          usage: { server_tool_use: { web_search_requests: 3 } },
        })
    );
    const snap = await source().readUsage(sid);
    expect(snap!.modelBreakdown.map((m) => m.model).sort()).toEqual([
      'claude-opus-4-8',
      'tool-runner',
    ]);
    const toolRow = snap!.modelBreakdown.find((m) => m.model === 'tool-runner');
    expect(toolRow!.usage.dimensions).toEqual({ web_search_requests: 3 });
  });

  it('breaks a scalar-total tie toward the record with richer dimensions/rate class', async () => {
    const sid = 'sess-complete2';
    // Same (id, requestId), same scalar total (10), but `rich` adds a dimension and
    // a non-default rate class → it must win despite the EARLIER ts.
    const plain = al({
      sid,
      id: 'm1',
      requestId: 'r1',
      uuid: 'u1',
      model: 'm',
      ts: '2026-01-01T00:00:02.000Z',
      usage: { input_tokens: 10 },
    });
    const rich = al({
      sid,
      id: 'm1',
      requestId: 'r1',
      uuid: 'u2',
      model: 'm',
      ts: '2026-01-01T00:00:01.000Z',
      usage: { input_tokens: 10, speed: 'fast', cache_creation: { ephemeral_1h_input_tokens: 5 } },
    });
    await writeTranscript(tmp, 'proj-a', `${sid}.jsonl`, plain);
    await writeTranscript(tmp, 'proj-a', 'sibling.jsonl', rich);
    const snap = await source().readUsage(sid);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.modelBreakdown).toHaveLength(1);
    expect(snap!.modelBreakdown[0].speed).toBe('fast');
    expect(snap!.modelBreakdown[0].usage.dimensions).toEqual({
      cache_creation_1h_input_tokens: 5,
    });
  });
});

describe('ClaudeCodeUsageSource.resolveActiveSessionId', () => {
  it('reads CLAUDE_CODE_SESSION_ID, trimmed', () => {
    const src = new ClaudeCodeUsageSource({ CLAUDE_CODE_SESSION_ID: '  abc  ' });
    expect(src.resolveActiveSessionId()).toBe('abc');
  });

  it('prefers an explicitly passed env over the constructor env', () => {
    const src = new ClaudeCodeUsageSource({ CLAUDE_CODE_SESSION_ID: 'ctor' });
    expect(src.resolveActiveSessionId({ CLAUDE_CODE_SESSION_ID: 'param' })).toBe('param');
  });

  it('returns null when unset or blank', () => {
    expect(new ClaudeCodeUsageSource({}).resolveActiveSessionId()).toBeNull();
    expect(
      new ClaudeCodeUsageSource({ CLAUDE_CODE_SESSION_ID: '   ' }).resolveActiveSessionId()
    ).toBeNull();
  });
});

describe('parseTranscriptUsageLine', () => {
  it('extracts the four Claude-native token fields, ignoring extras', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 's',
      requestId: 'r',
      uuid: 'u',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        id: 'm',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
          service_tier: 'standard',
          iterations: [{ input_tokens: 1 }],
        },
      },
    });
    const rec = parseTranscriptUsageLine(line, 's');
    expect(rec).not.toBeNull();
    expect(rec!.usage).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
    });
    expect(rec!.model).toBe('claude-opus-4-8');
  });

  it('returns null for blank, malformed, other-session, and usage-less lines', () => {
    expect(parseTranscriptUsageLine('', 's')).toBeNull();
    expect(parseTranscriptUsageLine('not json', 's')).toBeNull();
    expect(
      parseTranscriptUsageLine(
        JSON.stringify({
          sessionId: 'other',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { usage: { input_tokens: 1 } },
        }),
        's'
      )
    ).toBeNull();
    expect(
      parseTranscriptUsageLine(
        JSON.stringify({
          sessionId: 's',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user' },
        }),
        's'
      )
    ).toBeNull();
  });

  it('defaults a missing model to "unknown" and absent token fields to 0', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 's',
      requestId: 'r',
      uuid: 'u',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { id: 'm', usage: { input_tokens: 5 } },
    });
    const rec = parseTranscriptUsageLine(line, 's');
    expect(rec!.model).toBe('unknown');
    expect(rec!.usage).toEqual({
      input_tokens: 5,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('normalizes rate classes: default/absent omitted, non-default carried', () => {
    const line = (usage: Record<string, unknown>) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: 's',
        requestId: 'r',
        uuid: 'u',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { id: 'm', model: 'x', usage },
      });
    const def = parseTranscriptUsageLine(
      line({
        input_tokens: 1,
        speed: 'standard',
        service_tier: 'standard',
        inference_geo: 'not_available',
      }),
      's'
    );
    expect(def!.speed).toBeUndefined();
    expect(def!.service_tier).toBeUndefined();
    expect(def!.inference_geo).toBeUndefined();
    const prem = parseTranscriptUsageLine(
      line({ input_tokens: 1, speed: 'fast', service_tier: 'batch', inference_geo: 'us' }),
      's'
    );
    expect(prem!.speed).toBe('fast');
    expect(prem!.service_tier).toBe('batch');
    expect(prem!.inference_geo).toBe('us');
  });
});
