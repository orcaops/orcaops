import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HistoryScopeError } from '@orcaops/project-scope/history';

import { createCanonicalWhyAction } from './canonical-why.js';
import {
  closeFingerprintedCheckpoint,
  commitFile,
} from '../../tests/helpers/database-fingerprint.js';
import { fixture, inventory } from '../../tests/helpers/database-history.js';
import { CliExit } from '../io/exit.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { type CanonicalWhyOptions, validateCanonicalWhy } from '../lib/history-provenance.js';

afterEach(() => {
  vi.restoreAllMocks();
});
describe('canonical why action', { timeout: 30_000 }, () => {
  it('defaults to a small candidate page without changing explicit pagination', () => {
    expect(validateCanonicalWhy('src/a.ts').filters.limit).toBe(5);
    expect(validateCanonicalWhy('src/a.ts', { all: true }).filters.limit).toBe(1000);
    expect(validateCanonicalWhy('src/a.ts', { all: true, limit: 2 }).filters.limit).toBe(2);
  });
  it('rejects malformed and retired inputs before opening project context', async () => {
    const openContext = vi.fn();
    const action = createCanonicalWhyAction({ openContext });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (const options of [
      { scope: 'src/**' },
      { allProjects: true },
      { imported: false },
      { project: 'invalid' },
      { scope: 'all-projects' },
      { touching: '../secret' },
      { origin: 'archive' },
      { limit: 0 },
      { at: '--all' },
      { details: 'yes' },
    ])
      await expect(action('code.ts:1', options as CanonicalWhyOptions)).rejects.toBeInstanceOf(
        CliExit
      );
    for (const target of ['', 'code.ts:0', 'code.ts:-3', 'code.ts:NaN', 'code.ts:1.2'])
      await expect(action(target)).rejects.toBeInstanceOf(CliExit);
    expect(openContext).not.toHaveBeenCalled();
    expect(validateCanonicalWhy('src/a:b.ts:1')).toMatchObject({ file: 'src/a:b.ts', line: 1 });
  });
  it('preserves scoped errors in machine output', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const action = createCanonicalWhyAction({
      async openContext() {
        throw new HistoryScopeError('GIT_CONTEXT_UNAVAILABLE', 'No checkout');
      },
    });
    await expect(action('code.ts:1', { json: true })).rejects.toBeInstanceOf(CliExit);
    expect(JSON.parse(chunks.join(''))).toMatchObject({
      ok: false,
      error: { code: 'GIT_CONTEXT_UNAVAILABLE' },
    });
  });
  it('emits qualified narrative and closes the borrowed scope after a passive read', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const id = await f.capture();
    const closeRef = await commitFile(f, 'code.ts', 'const value = true;\n');
    await closeFingerprintedCheckpoint(f, id, {
      files: ['code.ts'],
      openRef,
      closeRef,
    });
    const before = await inventory(f.temporary);
    let closed = 0;
    const action = createCanonicalWhyAction({
      async openContext(selector) {
        const context = await resolveDatabaseHistoryCommandContext({
          dataRoot: f.root,
          cwd: f.main,
          profile: 'git-history',
          selector,
        });
        const close = context.scope.close.bind(context.scope);
        context.scope.close = () => {
          closed++;
          close();
        };
        return context;
      },
    });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    await action(path.join(f.main, 'code.ts:1'), { json: true });
    const result = JSON.parse(chunks.join(''));
    expect(result).toMatchObject({
      ok: true,
      schema_version: 8,
      context: { project_id: f.authority.projectId },
      diagnostics: { candidate_selection: { complete: true } },
    });
    expect(result.diagnostics.seed_guidance).toBeUndefined();
    expect(result.results[0]).toMatchObject({
      artifact_id: id,
      confidence: 'exact',
    });
    expect(closed).toBe(1);
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
