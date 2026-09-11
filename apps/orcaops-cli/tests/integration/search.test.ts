import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { projectDatabasePath } from '@orcaops/storage/history/database';

import type { readCanonicalSearch } from '../../src/lib/history-search.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type SearchResult = Awaited<ReturnType<typeof readCanonicalSearch>> & { ok: true };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function agent(f: { main: string; root: string }) {
  return makeAgent({ cwd: f.main, env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' } });
}
async function search(f: Parameters<typeof agent>[0], query: string, flags: string[] = []) {
  const result = await agent(f).runRaw(['search', query, '--json', ...flags]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  const parsed = JSON.parse(result.stdout) as SearchResult;
  expect(parsed.ok).toBe(true);
  return parsed;
}
describe('registered database search', { timeout: 30_000 }, () => {
  it('rejects invalid input and retired flags without initializing history', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'search-refusal-'));
    roots.push(temporary);
    const f = { main: path.join(temporary, 'checkout'), root: path.join(temporary, 'history') };
    await mkdir(f.main);
    const before = await inventory(temporary);
    for (const args of [
      ['', '--json'],
      ['   ', '--json'],
      ['---', '--json'],
      ['history', '--type', 'unknown', '--json'],
      ['history', '--limit', '0', '--json'],
      ['history', '--offset', '-1', '--json'],
      ['history', '--scope', 'src/**', '--json'],
      ['history', '--touching', '../private', '--json'],
      ['history', '--all-projects'],
      ['history', '--no-imported'],
      ['history', '--cursor', 'old'],
    ])
      expect((await agent(f).runRaw(['search', ...args])).exitCode).not.toBe(0);
    expect(await inventory(temporary)).toEqual(before);
  });

  it('searches all branches by default and composes literal branch, type and limit', async () => {
    const f = await fixture();
    const main = await f.capture();
    await git(f.main, ['checkout', '-qb', 'feature']);
    const feature = await f.capture();
    const all = await search(f, 'project narrative', ['--type', 'plan']);
    expect(new Set(all.results.map((row) => row.artifact_id))).toEqual(new Set([main, feature]));
    expect(all.scope).toMatchObject({
      kind: 'project',
      selection: 'default',
      branch: { source: 'all', value: null },
    });
    expect(
      (
        await search(f, 'project narrative', ['--branch', 'main', '--type', 'plan', '--limit', '1'])
      ).results.map((row) => row.artifact_id)
    ).toEqual([main]);
    expect((await search(f, 'project narrative', ['--branch', 'ma*'])).results).toEqual([]);
  });

  it('normalizes punctuation without exposing FTS query syntax', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { task: 'Retain rate-limit middleware' });
    const result = await search(f, 'rate-limit', ['--type', 'plan']);
    expect(result.results.map((row) => row.artifact_id)).toEqual([id]);
  });

  it('discloses damaged search rows and never repairs them during viewing', async () => {
    const f = await fixture();
    await f.capture();
    const raw = new Database(projectDatabasePath(f.authority));
    raw.exec('DELETE FROM artifact_search_sources');
    raw.close();
    const counters = f.writer.read(() => null).counters;
    const before = await inventory(f.temporary);
    const result = await search(f, 'project narrative');
    expect(result.results).toEqual([]);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })],
    });
    expect(result.page.ranking_complete).toBe(false);
    expect(result.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(f.writer.read(() => null).counters).toEqual(counters);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reports deleted registered history and creates no replacement database', async () => {
    const f = await fixture();
    await f.capture();
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const result = await search(f, 'project narrative');
    expect(result.results).toEqual([]);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_MISSING' })],
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('retains distinct evaluator and disposition sources, pin history and derived digest search', async () => {
    const f = await fixture();
    const id = await f.capture();
    await f.mutate(id, 'Searchable retained evidence', async (draft) => {
      for (const run of ['one', 'two'])
        await draft.writeEvaluatorRunPayload(id, {
          schema: 'orcaops.evaluator_run/v1',
          run_id: run,
          artifact_id: id,
          evaluator_ref: 'test/search',
          package_id: 'test',
          evaluator_id: 'search',
          phase: 'pre-pr',
          severity: 'block',
          run_status: 'completed',
          verdict: run === 'one' ? 'violation' : 'pass',
          body: 'retained diagnostic marker',
          ts: '2026-09-05T09:01:00.000Z',
        });
      await draft.writeEvaluatorDisposition(id, {
        schema: 'orcaops.evaluator_disposition/v1',
        disposition_id: uuidv7(),
        artifact_id: id,
        run_id: 'one',
        evaluator_ref: 'test/search',
        disposition: 'dismissed',
        reason: 'retained disposition marker',
        agent_session_id: null,
        ts: '2026-09-05T09:02:00.000Z',
      });
      await draft.writePinDisplaced(id, {
        displaced_by_artifact_id: uuidv7(),
        shell_key: 'retained shell marker',
        reason: 'explicit-checkout',
      });
      await draft.writeSummary({
        schema_version: 1,
        artifact_id: id,
        outcome: 'retained summary marker',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: f.context.headOid!,
        ts: '2026-09-05T09:03:00.000Z',
      });
    });
    const evaluator = await search(f, 'diagnostic marker', ['--type', 'evaluator']);
    expect(evaluator.results).toHaveLength(2);
    expect(new Set(evaluator.results.map((row) => row.source_id)).size).toBe(2);
    for (const [kind, query] of [
      ['block-resolution', 'disposition marker'],
      ['pin-displaced', 'explicit checkout'],
      ['summary', 'summary marker'],
      ['digest', 'project narrative'],
    ]) {
      const result = await search(f, query, ['--type', kind]);
      expect(result.results.length, kind).toBeGreaterThan(0);
      expect(
        result.results.every((row) => row.source_kind === kind && row.artifact_id === id)
      ).toBe(true);
    }
  });
});
