import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type SearchEntry, Store } from './sqlite.js';

// Real-shape but invalid GitHub PAT — passes the patterns in
// secrets.ts but isn't a usable token.
const FAKE_GH = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';

describe('FTS5 index-time redaction', () => {
  let tmpRoot: string;
  let store: Store;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-search-redaction-'));
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
    // Plant a stub artifact so the search FK isn't a problem.
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a-1',
      branch: 'main',
      task: 't',
      agent: 'claude-code',
      base_sha: 'sha-base',
      started_at: '2026-04-27T10:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('replaceSearchEntry redacts the content field before insertion', () => {
    store.replaceSearchEntry({
      artifact_id: 'a-1',
      source: 'plan',
      branch: 'main',
      ts: '2026-04-27T10:00:00.000Z',
      content: `embed ${FAKE_GH} into env`,
    });
    // Read the row directly out of FTS5 — bypasses snippet redaction
    // so any leak would surface immediately.
    const row = store.db
      .prepare(`SELECT content FROM search_idx WHERE artifact_id = ?`)
      .get('a-1') as { content: string };
    expect(row.content).not.toContain(FAKE_GH);
    expect(row.content).toContain('[REDACTED_SECRET]');
  });

  it('the search query path returns a redacted snippet (defense in depth confirms)', () => {
    store.replaceSearchEntry({
      artifact_id: 'a-1',
      source: 'plan',
      branch: 'main',
      ts: '2026-04-27T10:00:00.000Z',
      content: `uniquemarker quoted ${FAKE_GH}`,
    });
    const results = store.search('uniquemarker');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.snippet).not.toContain(FAKE_GH);
    }
  });

  it('plain content (no secrets) is stored verbatim — no marker leaks in', () => {
    store.replaceSearchEntry({
      artifact_id: 'a-1',
      source: 'plan',
      branch: 'main',
      ts: '2026-04-27T10:00:00.000Z',
      content: 'plain narrative with no secrets',
    });
    const row = store.db
      .prepare(`SELECT content FROM search_idx WHERE artifact_id = ?`)
      .get('a-1') as { content: string };
    expect(row.content).toBe('plain narrative with no secrets');
  });

  it('replacement is idempotent: re-inserting the same redacted content stays consistent', () => {
    const payload: SearchEntry = {
      artifact_id: 'a-1',
      source: 'plan',
      branch: 'main',
      ts: '2026-04-27T10:00:00.000Z',
      content: `embed ${FAKE_GH}`,
    };
    store.replaceSearchEntry(payload);
    store.replaceSearchEntry(payload);
    const rows = store.db
      .prepare(`SELECT content FROM search_idx WHERE artifact_id = ?`)
      .all('a-1') as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).not.toContain(FAKE_GH);
  });
});
