import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexActivitySource } from './activity.js';

const ROOT = '11111111-2222-4333-8444-555555555555';
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = '99999999-8888-4777-8666-555555555555';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-activity-'));
  roots.push(root);
  return root;
}

function meta(id: string, root = id, parent?: string): object {
  return {
    timestamp: '2030-01-01T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      session_id: root,
      ...(parent ? { parent_thread_id: parent, thread_source: 'subagent' } : {}),
    },
  };
}

async function writeRollout(
  codexHome: string,
  id: string,
  lines: ReadonlyArray<object | string>,
  date = '2027/01/02'
): Promise<string> {
  const dir = path.join(codexHome, 'sessions', ...date.split('/'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2027-01-02T03-04-05-${id}.jsonl`);
  await writeFile(
    file,
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
  );
  return file;
}

describe('CodexActivitySource', () => {
  it('batches discovery, includes linked activity, and reuses unchanged tail reads', async () => {
    const codexHome = await temporaryRoot();
    const rootFile = await writeRollout(
      codexHome,
      ROOT,
      [meta(ROOT), { timestamp: '2030-01-01T00:01:00.000Z', type: 'event_msg' }],
      '2024/01/02'
    );
    await writeRollout(
      codexHome,
      CHILD,
      [meta(CHILD, ROOT, ROOT), { timestamp: '2030-01-01T00:03:00.000Z', type: 'response_item' }],
      '2025/02/03'
    );
    await writeRollout(codexHome, OTHER, [
      meta(OTHER),
      { timestamp: '2030-01-01T00:02:00.000Z', type: 'event_msg' },
    ]);

    let scans = 0;
    const tailReads: string[] = [];
    const source = new CodexActivitySource(
      { CODEX_HOME: codexHome },
      {
        indexRefreshMs: Number.POSITIVE_INFINITY,
        onScan: () => scans++,
        onTailRead: (file) => tailReads.push(file),
      }
    );

    const first = await source.readLastActivity(new Set([ROOT, OTHER]));
    expect(first.get(ROOT)).toBe(Date.parse('2030-01-01T00:03:00.000Z'));
    expect(first.get(OTHER)).toBe(Date.parse('2030-01-01T00:02:00.000Z'));
    expect(scans).toBe(1);
    expect(tailReads).toHaveLength(3);

    const unchanged = await source.readLastActivity(new Set([ROOT, OTHER]));
    expect(unchanged).toEqual(first);
    expect(scans).toBe(1);
    expect(tailReads).toHaveLength(3);

    await appendFile(
      rootFile,
      `${JSON.stringify({ timestamp: '2030-01-01T00:04:00.000Z', type: 'event_msg' })}\n`
    );
    const advanced = await source.readLastActivity(new Set([ROOT]));
    expect(advanced.get(ROOT)).toBe(Date.parse('2030-01-01T00:04:00.000Z'));
    expect(scans).toBe(1);
    expect(tailReads).toHaveLength(4);
  });

  it('ignores a truncated first tail record and malformed later records', async () => {
    const codexHome = await temporaryRoot();
    await writeRollout(codexHome, ROOT, [
      meta(ROOT),
      { timestamp: '2030-01-01T00:01:00.000Z', padding: 'x'.repeat(70 * 1024) },
      '{not-json',
      { timestamp: '2030-01-01T00:05:00.000Z', type: 'event_msg' },
      { timestamp: 'not-a-date', type: 'event_msg' },
    ]);
    const source = new CodexActivitySource(
      { CODEX_HOME: codexHome },
      { indexRefreshMs: Number.POSITIVE_INFINITY }
    );

    const found = await source.readLastActivity(new Set([ROOT]));

    expect(found.get(ROOT)).toBe(Date.parse('2030-01-01T00:05:00.000Z'));
  });

  it('uses mtime when a known rollout has no valid timestamp', async () => {
    const codexHome = await temporaryRoot();
    const file = await writeRollout(codexHome, ROOT, ['{not-json', '{still-not-json']);
    const fallback = new Date('2031-02-03T04:05:06.000Z');
    await utimes(file, fallback, fallback);
    const source = new CodexActivitySource(
      { CODEX_HOME: codexHome },
      { indexRefreshMs: Number.POSITIVE_INFINITY }
    );

    const found = await source.readLastActivity(new Set([ROOT, 'missing']));

    expect(found.get(ROOT)).toBe(fallback.getTime());
    expect(found.has('missing')).toBe(false);
  });

  it('is a quiet no-op for empty input or missing rollout roots', async () => {
    const codexHome = await temporaryRoot();
    const source = new CodexActivitySource({ CODEX_HOME: path.join(codexHome, 'absent') });
    expect((await source.readLastActivity(new Set())).size).toBe(0);
    expect((await source.readLastActivity(new Set([ROOT]))).size).toBe(0);
  });
});
