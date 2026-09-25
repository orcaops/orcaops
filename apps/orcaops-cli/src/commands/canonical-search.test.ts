import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { getDefaultConfig } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { createCanonicalSearchAction } from './canonical-search.js';
import { fixture } from '../../tests/helpers/database-history.js';
import { CliExit } from '../io/exit.js';
import type { CanonicalSearchOptions } from '../lib/history-search.js';

afterEach(() => {
  vi.restoreAllMocks();
});
describe('canonical search action', { timeout: 30_000 }, () => {
  it('rejects invalid and retired options before constructing context', async () => {
    const openContext = vi.fn();
    const action = createCanonicalSearchAction({ openContext });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (const options of [
      { scope: 'src/**' },
      { allProjects: true },
      { imported: false },
      { project: 'invalid' },
      { scope: 'all-projects', project: '01a0721c-3cbf-7342-98bd-a25cf0300625' },
      { touching: '../secret' },
      { type: 'fuzzy' },
      { origin: 'archive' },
      { limit: 0 },
      { cursor: '' },
      { cursor: 'retired-cursor' },
      { offset: -1 },
      { offset: 1.5 },
      { offset: Number.MAX_SAFE_INTEGER },
    ])
      await expect(
        action('project narrative', options as CanonicalSearchOptions)
      ).rejects.toBeInstanceOf(CliExit);
    await expect(action('---')).rejects.toBeInstanceOf(CliExit);
    expect(openContext).not.toHaveBeenCalled();
  });

  it('preserves domain failure codes in JSON instead of reporting internal errors', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const openContext = vi.fn(async () => {
      throw new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Existing database is inaccessible');
    });
    const action = createCanonicalSearchAction({ openContext });
    await expect(
      action('project narrative', { json: true, scope: 'worktree' })
    ).rejects.toBeInstanceOf(CliExit);
    expect(JSON.parse(chunks.join(''))).toMatchObject({
      ok: false,
      error: { code: 'HISTORY_INACCESSIBLE' },
    });
    chunks.length = 0;
    await expect(action('---', { json: true })).rejects.toBeInstanceOf(CliExit);
    expect(JSON.parse(chunks.join(''))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_QUERY' },
    });
    expect(openContext).toHaveBeenCalledTimes(1);
  });

  it('emits the canonical JSON envelope and closes its database context', async () => {
    const f = await fixture();
    const id = await f.capture();
    let closed = 0;
    const action = createCanonicalSearchAction({
      async openContext(selector) {
        const scope = await resolveDatabaseHistoryScope({
          root: f.root,
          cwd: f.main,
          profile: 'collection',
          selector,
        });
        const close = scope.close.bind(scope);
        scope.close = () => {
          closed++;
          close();
        };
        return { scope, config: getDefaultConfig() };
      },
    });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    await action('project narrative', { json: true, type: 'plan' });
    const result = JSON.parse(chunks.join(''));
    expect(result).toMatchObject({
      ok: true,
      schema_version: 4,
      count: 1,
      scope: { kind: 'project', selection: 'default', branch: { source: 'all', value: null } },
      page: { ranking_complete: true, source_complete: true, candidate_complete: true },
      origin_counts: {
        returned: { captured: 1, imported: 0 },
        matching: { captured: 1, imported: 0 },
      },
    });
    expect(result.results[0]).toMatchObject({
      artifact_id: id,
      match_class: 'intent_phrase',
      origin: 'captured',
    });
    expect(result.results[0]).not.toHaveProperty('body_fields');
    expect(closed).toBe(1);
  });
});
