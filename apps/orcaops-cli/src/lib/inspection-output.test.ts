import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import {
  emitInspectionError,
  EXPORT_BYTES,
  exportInspection,
  INSPECTION_BYTES,
  inspectionArgument,
  inspectionBytes,
  measuredInspection,
} from './inspection-output.js';
import { OrcaopsError } from '../io/errors.js';

const directories: string[] = [];
it('quotes selectors containing shell punctuation without changing plain selectors', () => {
  expect(inspectionArgument('decision:retained')).toBe('decision:retained');
  expect(inspectionArgument('decision:$(whoami)')).toBe("'decision:$(whoami)'");
  expect(inspectionArgument("decision:owner's rule")).toBe("'decision:owner'\\''s rule'");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

it('bounds verbose errors without publishing their oversized details', () => {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    written.push(String(value));
    return true;
  });
  expect(() =>
    emitInspectionError(
      new OrcaopsError('INVALID_INPUT', 'Failed', undefined, {
        history_candidates: Array.from({ length: 50 }, () => ({
          id: '00000000-0000-4000-8000-000000000001',
          project_id: '00000000-0000-4000-8000-000000000002',
          command: 'x'.repeat(4000),
        })),
      })
    )
  ).toThrow();
  expect(Buffer.byteLength(written.join(''))).toBeLessThanOrEqual(INSPECTION_BYTES);
  expect(JSON.parse(written.join('')).error.message).toContain('omitted');
});

it('does not publish or leave staging files when the export exceeds its operational allowance', async () => {
  const root = await directory();
  await expect(
    exportInspection(path.join(root, 'large.json'), { body: 'x'.repeat(EXPORT_BYTES) })
  ).rejects.toThrow('64 MiB');
  expect(await readdir(root)).toEqual([]);
});
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), 'inspection-export-'));
  directories.push(value);
  return value;
}

it('measures escaped UTF-8 bytes including its own byte count and newline', () => {
  const result = measuredInspection({ text: '雪🦉\u001b[31m\n'.repeat(15) }, 2048);
  expect(result.output.bytes).toBe(inspectionBytes(result));
  expect(
    measuredInspection({ text: '雪🦉\u001b[31m\n'.repeat(15) }, result.output.bytes).output.bytes
  ).toBeLessThanOrEqual(result.output.bytes);
  expect(() => measuredInspection({ text: 'x'.repeat(2000) }, 1000)).toThrow('allowance');
});

it('exports complete JSON once with restrictive permissions and an exact byte count', async () => {
  const root = await directory();
  const file = path.join(root, 'record.json');
  const value = {
    account: { reason: 'Do not remove the qualification. '.repeat(4000) },
    missing: undefined,
  };
  const receipt = await exportInspection(file, value);
  const content = await readFile(file);
  expect(JSON.parse(content.toString())).toEqual({ ok: true, account: value.account });
  expect(receipt.bytes).toBe(content.length);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readdir(root)).toEqual(['record.json']);
});

it('never replaces existing files or symlinks and removes failed staging files', async () => {
  const root = await directory();
  const original = path.join(root, 'original.json');
  const alias = path.join(root, 'alias.json');
  await writeFile(original, 'original');
  await symlink(original, alias);
  for (const file of [original, alias])
    await expect(exportInspection(file, { changed: true })).rejects.toThrow();
  expect(await readFile(original, 'utf8')).toBe('original');
  expect((await readdir(root)).sort()).toEqual(['alias.json', 'original.json']);
  await expect(exportInspection('-', {})).rejects.toThrow('not stdout');
});

it('refuses an existing destination as invalid input that names it, not the staging file', async () => {
  const root = await directory();
  const file = path.join(root, 'out.json');
  await exportInspection(file, { first: true });
  const before = await readFile(file, 'utf8');

  const refusal = exportInspection(file, { second: true });
  await expect(refusal).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const message = await refusal.catch((err: Error) => err.message);
  expect(message).toContain(file);
  expect(message).toContain('already exists');
  expect(message).not.toContain('.orcaops-export-');
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await readdir(root)).toEqual(['out.json']);
});

it('refuses a destination whose directory does not exist as invalid input', async () => {
  const root = await directory();
  const missing = path.join(root, 'absent');

  const refusal = exportInspection(path.join(missing, 'out.json'), {});
  await expect(refusal).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const message = await refusal.catch((err: Error) => err.message);
  expect(message).toContain(missing);
  expect(message).not.toContain('.orcaops-export-');
});
