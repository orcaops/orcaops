import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

import { INSPECTION_BYTES } from '../../src/lib/inspection-output.js';
import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

it('pages checkpoint identities and inspects a later checkpoint without exporting its artifact', async () => {
  const f = await fixture();
  const id = await f.capture();
  for (let index = 0; index < 7; index++) await f.recordFiles(id, [`src/worker-${index}.ts`]);
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const run = async (flags: string[] = []) => {
    const result = await agent.runRaw(['show', id, '--json', ...flags]);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(INSPECTION_BYTES);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.output.bytes).toBe(Buffer.byteLength(result.stdout));
    expect(parsed.results).toBeUndefined();
    return parsed;
  };
  const first = await run();
  expect(first.schema_version).toBe(4);
  expect(first.checkpoints.map((row: { n: number }) => row.n)).toEqual([1, 2, 3, 4, 5]);
  const second = await run(['--cursor', first.pagination.next_cursor]);
  expect(second.checkpoints.map((row: { n: number }) => row.n)).toEqual([6, 7]);
  expect(second.pagination.next_cursor).toBeNull();
  const checkpoint = await run(['--anchor', first.selection.reference, '--checkpoint', '7']);
  expect(checkpoint.content.files_changed).toContain('src/worker-6.ts');
  for (const flags of [
    ['--cursor', 'invalid'],
    ['--checkpoint', '0'],
    ['--limit', '21'],
    ['--anchor', first.selection.reference, '--at-boundary', '0'],
  ]) {
    const invalid = await agent.runRaw(['show', id, '--json', ...flags]);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).error.code).toBe('INVALID_INPUT');
    expect(Buffer.byteLength(invalid.stdout)).toBeLessThanOrEqual(INSPECTION_BYTES);
  }
  await f.recordFiles(id, ['src/new.ts']);
  const stale = await agent.runRaw([
    'show',
    id,
    '--json',
    '--cursor',
    first.pagination.next_cursor,
  ]);
  expect(stale.exitCode).toBe(1);
  expect(JSON.parse(stale.stdout).error.code).toBe('STALE_CONTEXT');
});

it('omits an oversized decision whole and exports its reason and alternatives on request', async () => {
  const f = await fixture();
  const reason = 'The exception is material; do not apply this to expired jobs. '.repeat(600);
  const decision = {
    decision: 'Reuse delivery identifiers',
    reason,
    revision_n: 0,
    alternatives_considered: [
      { option: 'Generate a new identifier', rejected_because: 'Duplicates delivery' },
    ],
  };
  const id = await f.capture(undefined, { decisions: [decision] });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const result = await agent.runRaw(['show', id, '--decision', '1', '--json']);
  expect(result.exitCode, result.stderr).toBe(0);
  const omission = JSON.parse(result.stdout);
  expect(omission.status).toBe('omitted_oversized');
  expect(omission.content).toBeNull();
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(INSPECTION_BYTES);
  const destination = path.join(f.temporary, 'decision.json');
  const exported = await agent.runRaw([
    'show',
    id,
    '--anchor',
    omission.selection.reference,
    '--decision',
    '1',
    '--output',
    destination,
    '--json',
  ]);
  expect(exported.exitCode, exported.stderr).toBe(0);
  expect(JSON.parse(exported.stdout).status).toBe('exported');
  expect(JSON.parse(await readFile(destination, 'utf8')).content).toMatchObject(decision);
  expect(exported.stdout).not.toContain(reason);
});

it('exports one full artifact without a duplicate representation', async () => {
  const f = await fixture();
  const id = await f.capture();
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const destination = path.join(f.temporary, 'artifact.json');
  const result = await agent.runRaw(['show', id, '--output', destination, '--json']);
  expect(result.exitCode, result.stderr).toBe(0);
  const output = JSON.parse(await readFile(destination, 'utf8'));
  expect(output.artifact.id).toBe(id);
  expect(output.schema_version).toBe(4);
  expect(output.results).toBeUndefined();
});
