import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { projectDatabasePath } from '@orcaops/storage/history/database';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * Missing expected history is never a fresh install. The four readers this unit ported
 * refuse it; `decisions` and `loose-ends` are collection reads owned by the accepted
 * insights unit and answer with an empty result whose completeness carries the issue.
 * Either way nothing is created.
 */
describe('registered public readers on missing history', { timeout: 90_000 }, () => {
  it('refuses the exact and provenance reads and discloses it on the collection reads', async () => {
    const f = await fixture();
    const id = await f.capture();
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const agent = makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    const run = async (args: string[]) => {
      const raw = await agent.runRaw([...args, '--json']);
      return { exitCode: raw.exitCode, body: JSON.parse(raw.stdout) as Record<string, never> };
    };
    for (const args of [
      ['digest', id],
      ['digest'],
      ['why', 'src/a.ts:1'],
      ['diff', '--attribution'],
      ['export', 'agent-trace'],
    ]) {
      const result = await run(args);
      expect(result.exitCode, args.join(' ')).toBe(1);
      const error = result.body.error as unknown as { code: string; message: string };
      expect(error.code, args.join(' ')).toBe('HISTORY_MISSING');
      expect(error.message).not.toMatch(/\binit\b|fresh install/iu);
    }
    for (const args of [['decisions'], ['loose-ends']]) {
      const result = await run(args);
      expect(result.exitCode, args.join(' ')).toBe(0);
      const body = result.body as unknown as {
        ok: boolean;
        results: unknown[];
        completeness: { complete: boolean; issues: Array<{ code: string }> };
      };
      expect(body).toMatchObject({ ok: true, results: [] });
      expect(body.completeness.complete).toBe(false);
      expect(body.completeness.issues.map((issue) => issue.code)).toContain('HISTORY_MISSING');
    }
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
