import Database from 'better-sqlite3';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { projectDatabasePath } from '@orcaops/storage/history/database';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
function run(f: Fixture, verb: 'show' | 'derive', artifact: string, checkpoint = 1, json = true) {
  return makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  }).runRaw([
    'fingerprint',
    verb,
    '--artifact',
    artifact,
    '--checkpoint',
    String(checkpoint),
    ...(json ? ['--json'] : []),
  ]);
}
async function captured(content: string | null = 'export const retained = 1;\n') {
  const f = await fixture();
  const id = await f.capture();
  const base = f.context.headOid!;
  const head = content === null ? base : await commitFile(f, 'src/retained.ts', content);
  const closed = await closeFingerprintedCheckpoint(f, id, {
    files: content === null ? [] : ['src/retained.ts'],
    openRef: base,
    closeRef: head,
  });
  return { f, id, closed };
}
function noRawCode(output: string) {
  expect(output).not.toContain('export const retained');
  expect(output).not.toMatch(/@@ -\d/);
  expect(output).not.toContain('--- a/');
  expect(output).not.toContain('+++ b/');
}

describe('database fingerprint commands', () => {
  it.each([
    { kind: 'captured', content: 'export const retained = 1;\n' },
    { kind: 'empty', content: null },
    {
      kind: 'large',
      content: Array.from({ length: 1500 }, (_, i) => `export const retained${i} = ${i};\n`).join(
        ''
      ),
    },
  ])(
    'shows and reproduces a $kind manifest without publishing a cache',
    async ({ kind, content }) => {
      const { f, id } = await captured(content);
      const before = await inventory(f.temporary);
      const shown = await run(f, 'show', id);
      expect(shown.exitCode, shown.stdout + shown.stderr).toBe(0);
      const body = JSON.parse(shown.stdout);
      expect(body.summary.status).toBe(kind === 'empty' ? 'empty' : 'captured');
      expect(body.summary.manifest_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.manifest.hunks.length).toBe(kind === 'empty' ? 0 : 1);
      for (const selected of [id, id.slice(0, 12)]) {
        const derived = await run(f, 'derive', selected);
        expect(derived.exitCode, derived.stdout + derived.stderr).toBe(0);
        const result = JSON.parse(derived.stdout);
        expect(result.artifact).toBe(id);
        expect(result.verified).toBe(true);
        expect(result.derived.manifest_hash).toBe(body.summary.manifest_hash);
        expect(result.cached).toBeUndefined();
        noRawCode(derived.stdout);
      }
      for (const verb of ['show', 'derive'] as const) {
        const human = await run(f, verb, id, 1, false);
        expect(human.exitCode, human.stderr).toBe(0);
        noRawCode(human.stdout);
      }
      noRawCode(shown.stdout);
      expect(await inventory(f.temporary)).toEqual(before);
    }
  );

  it('reports changed truncation settings without changing captured evidence', async () => {
    const { f, id } = await captured('export const retained = 1;\n'.repeat(200));
    await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(f.main, '.orcaops/config.json'),
      JSON.stringify({ schema_version: 6, diff_fingerprint: { max_diff_bytes: 64 } })
    );
    const before = await inventory(f.temporary);
    const result = await run(f, 'derive', id);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      verified: false,
      note: expect.stringContaining('truncation mismatch'),
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('shows a skipped capture and refuses derivation without both trees', async () => {
    const f = await fixture();
    const id = await f.capture();
    await f.recordFiles(id, []);
    const before = await inventory(f.temporary);
    const shown = await run(f, 'show', id);
    expect(shown.exitCode, shown.stdout + shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      manifest: null,
      summary: { status: 'skipped', manifest_hash: null },
    });
    const derived = await run(f, 'derive', id);
    expect(derived.exitCode).toBe(1);
    expect(JSON.parse(derived.stdout).error).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('no derivable trees'),
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it.each(['show', 'derive'] as const)(
    'refuses %s when declared manifest evidence is absent',
    async (verb) => {
      const f = await fixture();
      const id = await f.capture();
      const head = await commitFile(f, 'src/retained.ts', 'export const retained = 1;\n');
      await closeFingerprintedCheckpoint(f, id, {
        files: ['src/retained.ts'],
        openRef: f.context.headOid!,
        closeRef: head,
        withoutManifest: true,
      });
      const before = await inventory(f.temporary);
      const result = await run(f, verb, id);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'EVENT_LOG_CORRUPT',
        message: expect.stringContaining('explicit repair'),
      });
      expect(await inventory(f.temporary)).toEqual(before);
    }
  );

  it.each(['show', 'derive'] as const)(
    'refuses %s on corrupt retained artifact bytes',
    async (verb) => {
      const { f, id } = await captured();
      const raw = new Database(projectDatabasePath(f.authority));
      try {
        const trigger = raw
          .prepare("SELECT sql FROM sqlite_schema WHERE name='artifact_revisions_no_update'")
          .get() as { sql: string };
        raw.exec('DROP TRIGGER artifact_revisions_no_update');
        raw
          .prepare('UPDATE artifact_revisions SET ordered_hash=? WHERE artifact_id=?')
          .run('0'.repeat(64), id);
        raw.exec(trigger.sql);
      } finally {
        raw.close();
      }
      const before = await inventory(f.temporary);
      const result = await run(f, verb, id);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('HISTORY_INTEGRITY_REQUIRED');
      expect(await inventory(f.temporary)).toEqual(before);
    }
  );

  it.each(['show', 'derive'] as const)(
    'distinguishes invalid targets and open checkpoints for %s',
    async (verb) => {
      const f = await fixture();
      const id = await f.capture();
      await f.mutate(id, {}, async (semantics) => {
        const plan = await semantics.readPlan(id);
        return semantics.writeCheckpointOpened(
          { artifact_id: id, declared_step_ids: [plan!.plan_steps[0].step_id] },
          { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
        );
      });
      const before = await inventory(f.temporary);
      for (const [selected, n, code] of [
        [uuidv7(), 1, 'UNKNOWN_ARTIFACT'],
        [id, 9, 'INVALID_INPUT'],
        [id, 1, 'INVALID_INPUT'],
      ] as const) {
        const result = await run(f, verb, selected, n);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe(code);
      }
      expect(await inventory(f.temporary)).toEqual(before);
    }
  );

  it('does not replace a missing registered database', async () => {
    const { f, id } = await captured();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const result = await run(f, 'show', id);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('HISTORY_MISSING');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reports missing Git evidence without regenerating it', async () => {
    const { f, id, closed } = await captured();
    await rm(
      path.join(f.main, '.git', 'objects', closed.closeTree.slice(0, 2), closed.closeTree.slice(2))
    );
    const before = await inventory(f.temporary);
    const result = await run(f, 'derive', id);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('trees are unavailable'),
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
