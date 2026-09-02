import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OPENCODE_DISCOVERY_RECENCY_MS,
  OpenCodeUsageSource,
  parseOpenCodeMessage,
} from './db-reader.js';

let tmp: string;
let seq = 0;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'orcaops-llm-opencode-'));
  seq = 0;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const SID = 'ses_root0000000000000000001';
const CHILD = 'ses_child000000000000000001';
const GRANDCHILD = 'ses_grand000000000000000001';
const T0 = Date.parse('2026-07-01T10:00:00.000Z');

/** Build one assistant message-data JSON value. */
function msg(o: {
  id?: string;
  sessionID?: string;
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  created?: number;
  cache?: unknown;
}): Record<string, unknown> {
  const n = seq++;
  return {
    id: o.id ?? `msg_${n}`,
    sessionID: o.sessionID ?? SID,
    role: 'assistant',
    providerID: o.provider ?? 'anthropic',
    modelID: o.model ?? 'claude-sonnet-4-5',
    time: { created: o.created ?? T0 + n * 60_000 },
    cost: 0, // known-unreliable upstream — must be ignored
    tokens: {
      input: o.input ?? 0,
      output: o.output ?? 0,
      reasoning: o.reasoning ?? 0,
      cache: o.cache !== undefined ? o.cache : { read: o.cacheRead ?? 0, write: o.cacheWrite ?? 0 },
    },
  };
}

interface SessionRowSpec {
  id: string;
  parentID?: string;
  directory?: string;
  updated?: number;
}

/** Create `<dir>/<name>` with `message` (+ optional `session`) tables. */
function makeDb(o: {
  dir?: string;
  name?: string;
  messages?: Array<Record<string, unknown>>;
  sessions?: SessionRowSpec[];
  sessionTable?: boolean;
}): string {
  const dir = o.dir ?? tmp;
  const dbPath = path.join(dir, o.name ?? 'opencode.db');
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
    if (o.sessionTable !== false) {
      db.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, data TEXT)');
    }
    const insertMsg = db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)');
    for (const m of o.messages ?? []) {
      insertMsg.run(m.id, m.sessionID, JSON.stringify(m));
    }
    if (o.sessionTable !== false) {
      const insertSes = db.prepare('INSERT INTO session (id, data) VALUES (?, ?)');
      for (const s of o.sessions ?? []) {
        insertSes.run(
          s.id,
          JSON.stringify({
            id: s.id,
            ...(s.parentID !== undefined ? { parentID: s.parentID } : {}),
            ...(s.directory !== undefined ? { directory: s.directory } : {}),
            time: { created: T0, updated: s.updated ?? T0 },
          })
        );
      }
    }
  } finally {
    db.close();
  }
  return dbPath;
}

async function writeLegacyMessage(
  dir: string,
  sessionId: string,
  messageId: string,
  data: Record<string, unknown>
): Promise<void> {
  const msgDir = path.join(dir, 'storage', 'message', sessionId);
  await mkdir(msgDir, { recursive: true });
  await writeFile(path.join(msgDir, `${messageId}.json`), JSON.stringify(data), 'utf8');
}

function source(env: Record<string, string | undefined> = {}): OpenCodeUsageSource {
  return new OpenCodeUsageSource({ OPENCODE_DATA_DIR: tmp, ...env });
}

describe('parseOpenCodeMessage', () => {
  it('maps tokens to Claude-native fields with a composite provider/model key', () => {
    const rec = parseOpenCodeMessage(
      msg({ input: 100, output: 50, reasoning: 7, cacheRead: 10, cacheWrite: 20 })
    );
    expect(rec).not.toBeNull();
    expect(rec!.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 10,
      dimensions: { reasoning_output_tokens: 7 },
    });
    expect(rec!.model).toBe('anthropic/claude-sonnet-4-5');
    expect(rec!.sessionId).toBe(SID);
  });

  it('falls back to a bare modelID, then unknown, for the model key', () => {
    const noProvider = msg({ input: 1 });
    delete noProvider.providerID;
    expect(parseOpenCodeMessage(noProvider)!.model).toBe('claude-sonnet-4-5');

    const neither = msg({ input: 1 });
    delete neither.providerID;
    delete neither.modelID;
    expect(parseOpenCodeMessage(neither)!.model).toBe('unknown');
  });

  it('tolerates a non-object cache and missing time', () => {
    const weird = msg({ input: 5, cache: 'nope' });
    delete weird.time;
    const rec = parseOpenCodeMessage(weird);
    expect(rec!.usage.cache_read_input_tokens).toBe(0);
    expect(rec!.usage.cache_creation_input_tokens).toBe(0);
    expect(rec!.tsMs).toBe(0);
    expect(rec!.ts).toBe('');
  });

  it('returns null for user messages, zero-usage rows, and id-less data', () => {
    expect(parseOpenCodeMessage({ role: 'user', id: 'msg_u' })).toBeNull();
    expect(parseOpenCodeMessage(msg({}))).toBeNull(); // all-zero tokens
    const noId = msg({ input: 1 });
    delete noId.id;
    expect(parseOpenCodeMessage(noId)).toBeNull(); // no id and no fallback
    expect(parseOpenCodeMessage(noId, 'row-id')!.id).toBe('row-id');
    expect(parseOpenCodeMessage('not an object')).toBeNull();
  });
});

describe('OpenCodeUsageSource.readUsage — SQLite', () => {
  it('sums a session from the DB and ignores the stored cost field', async () => {
    makeDb({
      messages: [
        msg({ input: 100, output: 10, cacheRead: 5, cacheWrite: 3 }),
        msg({ input: 40, output: 4, reasoning: 6 }),
        { id: 'msg_user', sessionID: SID, role: 'user' }, // no tokens → skipped
        msg({ sessionID: 'ses_other', input: 999 }), // other session → filtered by query
      ],
      sessions: [{ id: SID }],
    });
    const snap = await source().readUsage(SID);
    expect(snap).not.toBeNull();
    expect(snap!.total).toEqual({
      input_tokens: 140,
      output_tokens: 14,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 5,
      dimensions: { reasoning_output_tokens: 6 },
    });
    expect(snap!.recordCount).toBe(2);
    expect(snap!.modelBreakdown).toHaveLength(1);
    expect(snap!.modelBreakdown[0].model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('splits the breakdown per provider/model composite, byte-sorted', async () => {
    makeDb({
      messages: [
        msg({ input: 10, provider: 'openrouter', model: 'claude-sonnet-4-5' }),
        msg({ input: 20, provider: 'anthropic', model: 'claude-sonnet-4-5' }),
      ],
    });
    const snap = await source().readUsage(SID);
    expect(snap!.modelBreakdown.map((m) => m.model)).toEqual([
      'anthropic/claude-sonnet-4-5',
      'openrouter/claude-sonnet-4-5',
    ]);
  });

  it('honors the until cutoff via time.created and reports asOf accordingly', async () => {
    makeDb({
      messages: [msg({ input: 10, created: T0 }), msg({ input: 99, created: T0 + 60 * 60_000 })],
    });
    const until = new Date(T0 + 30 * 60_000).toISOString();
    const snap = await source().readUsage(SID, { until });
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(10);
    expect(snap!.asOf).toBe(until);

    const all = await source().readUsage(SID);
    expect(all!.recordCount).toBe(2);
    expect(all!.asOf).toBe(new Date(T0 + 60 * 60_000).toISOString());

    expect(await source().readUsage(SID, { until: '2020-01-01T00:00:00.000Z' })).toBeNull();
  });

  it('rolls descendant sessions (parentID BFS) up into the root read', async () => {
    makeDb({
      messages: [
        msg({ input: 100, sessionID: SID }),
        msg({ input: 40, sessionID: CHILD, model: 'claude-haiku-4-5' }),
        msg({ input: 7, sessionID: GRANDCHILD, model: 'claude-haiku-4-5' }),
      ],
      sessions: [{ id: SID }, { id: CHILD, parentID: SID }, { id: GRANDCHILD, parentID: CHILD }],
    });
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(3);
    expect(snap!.total.input_tokens).toBe(147);
    // A read for the child covers only its own subtree.
    const childSnap = await source().readUsage(CHILD);
    expect(childSnap!.total.input_tokens).toBe(47);
  });

  it('degrades to exact-session capture when the session table is absent', async () => {
    makeDb({
      sessionTable: false,
      messages: [msg({ input: 100, sessionID: SID }), msg({ input: 40, sessionID: CHILD })],
    });
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(100);
  });

  it('falls back to a channel DB (opencode-<channel>.db) when opencode.db is absent', async () => {
    makeDb({ name: 'opencode-beta.db', messages: [msg({ input: 55 })] });
    const snap = await source().readUsage(SID);
    expect(snap!.total.input_tokens).toBe(55);
  });
});

describe('OpenCodeUsageSource.readUsage — legacy JSON', () => {
  it('reads a legacy-JSON-only session (no DB present)', async () => {
    await writeLegacyMessage(tmp, SID, 'msg_a', msg({ id: 'msg_a', input: 12, output: 3 }));
    await writeLegacyMessage(tmp, SID, 'msg_b', msg({ id: 'msg_b', input: 8 }));
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(2);
    expect(snap!.total.input_tokens).toBe(20);
    expect(snap!.total.output_tokens).toBe(3);
  });

  it('prefers the DB row over a legacy JSON copy of the same message id', async () => {
    makeDb({ messages: [msg({ id: 'msg_dup', input: 10 })] });
    await writeLegacyMessage(tmp, SID, 'msg_dup', msg({ id: 'msg_dup', input: 9999 }));
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(10);
  });

  it('merges distinct legacy messages alongside DB rows', async () => {
    makeDb({ messages: [msg({ id: 'msg_db', input: 10 })] });
    await writeLegacyMessage(tmp, SID, 'msg_legacy', msg({ id: 'msg_legacy', input: 5 }));
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(2);
    expect(snap!.total.input_tokens).toBe(15);
  });

  it('skips unparseable legacy files', async () => {
    const msgDir = path.join(tmp, 'storage', 'message', SID);
    await mkdir(msgDir, { recursive: true });
    await writeFile(path.join(msgDir, 'msg_bad.json'), 'not json', 'utf8');
    await writeLegacyMessage(tmp, SID, 'msg_ok', msg({ id: 'msg_ok', input: 4 }));
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(4);
  });
});

describe('OpenCodeUsageSource.readUsage — misc', () => {
  it('returns null for a missing data dir, an unknown session, and a blank sid', async () => {
    const src = new OpenCodeUsageSource({ OPENCODE_DATA_DIR: path.join(tmp, 'nope') });
    expect(await src.readUsage(SID)).toBeNull();
    makeDb({ messages: [] });
    expect(await source().readUsage('ses_unknown')).toBeNull();
    expect(await source().readUsage('')).toBeNull();
    expect(await source().readUsage('   ')).toBeNull();
  });

  it('treats OPENCODE_DATA_DIR as a comma-separated list and expands ~', async () => {
    const dirA = path.join(tmp, 'dir-a');
    const dirB = path.join(tmp, 'dir-b');
    await mkdir(dirB, { recursive: true });
    makeDb({ dir: dirB, messages: [msg({ input: 21 })] });
    const csv = new OpenCodeUsageSource({ OPENCODE_DATA_DIR: `${dirA}, ,${dirB}` });
    expect((await csv.readUsage(SID))!.total.input_tokens).toBe(21);

    const tilde = new OpenCodeUsageSource({ HOME: tmp, OPENCODE_DATA_DIR: '~/dir-b' });
    expect((await tilde.readUsage(SID))!.total.input_tokens).toBe(21);
  });

  it('defaults to $XDG_DATA_HOME/opencode and ~/.local/share/opencode', async () => {
    const xdgDir = path.join(tmp, 'xdg-data', 'opencode');
    await mkdir(xdgDir, { recursive: true });
    makeDb({ dir: xdgDir, messages: [msg({ input: 31 })] });
    const viaXdg = new OpenCodeUsageSource({
      HOME: tmp,
      XDG_DATA_HOME: path.join(tmp, 'xdg-data'),
    });
    expect((await viaXdg.readUsage(SID))!.total.input_tokens).toBe(31);

    const defaultDir = path.join(tmp, '.local', 'share', 'opencode');
    await mkdir(defaultDir, { recursive: true });
    makeDb({ dir: defaultDir, messages: [msg({ input: 32 })] });
    const viaHome = new OpenCodeUsageSource({ HOME: tmp });
    expect((await viaHome.readUsage(SID))!.total.input_tokens).toBe(32);
  });
});

describe('OpenCodeUsageSource.discoverActiveSessionId', () => {
  const REPO = '/repo/project-x';

  it('returns the most-recently-updated fresh root session matching cwd', async () => {
    const now = T0 + 10 * 60_000;
    makeDb({
      sessions: [
        { id: 'ses_older', directory: REPO, updated: now - 5 * 60_000 },
        { id: SID, directory: REPO, updated: now - 60_000 },
        { id: 'ses_elsewhere', directory: '/other', updated: now },
      ],
    });
    const found = await source().discoverActiveSessionId({
      cwd: REPO,
      now: new Date(now).toISOString(),
    });
    expect(found).toBe(SID);
  });

  it('rejects stale sessions beyond the recency window', async () => {
    const now = T0 + 10 * 60_000;
    makeDb({
      sessions: [{ id: SID, directory: REPO, updated: now - OPENCODE_DISCOVERY_RECENCY_MS - 1 }],
    });
    expect(
      await source().discoverActiveSessionId({ cwd: REPO, now: new Date(now).toISOString() })
    ).toBeNull();
  });

  it('never returns a child session as the discovery candidate', async () => {
    const now = T0;
    makeDb({
      sessions: [{ id: CHILD, parentID: SID, directory: REPO, updated: now }],
    });
    expect(
      await source().discoverActiveSessionId({ cwd: REPO, now: new Date(now).toISOString() })
    ).toBeNull();
  });

  it('reads column-shaped session rows (parent_id/directory/time_updated)', async () => {
    const now = T0;
    const dbPath = path.join(tmp, 'opencode.db');
    const db = new Database(dbPath);
    try {
      db.exec(
        'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);' +
          'CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_updated INTEGER)'
      );
      db.prepare(
        'INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)'
      ).run(SID, null, REPO, now);
    } finally {
      db.close();
    }
    expect(
      await source().discoverActiveSessionId({ cwd: REPO, now: new Date(now).toISOString() })
    ).toBe(SID);
  });

  it('returns null without a cwd, without a DB, or on a directory mismatch', async () => {
    const now = new Date(T0).toISOString();
    expect(await source().discoverActiveSessionId({ now })).toBeNull();
    expect(await source().discoverActiveSessionId({ cwd: REPO, now })).toBeNull(); // no DB yet
    makeDb({ sessions: [{ id: SID, directory: '/somewhere/else', updated: T0 }] });
    expect(await source().discoverActiveSessionId({ cwd: REPO, now })).toBeNull();
  });
});

describe('OpenCodeUsageSource.resolveActiveSessionId', () => {
  it('reads OPENCODE_SESSION_ID, trimmed; null when unset or blank', () => {
    expect(
      new OpenCodeUsageSource({ OPENCODE_SESSION_ID: `  ${SID}  ` }).resolveActiveSessionId()
    ).toBe(SID);
    expect(new OpenCodeUsageSource({}).resolveActiveSessionId()).toBeNull();
    expect(
      new OpenCodeUsageSource({ OPENCODE_SESSION_ID: '   ' }).resolveActiveSessionId()
    ).toBeNull();
  });
});
