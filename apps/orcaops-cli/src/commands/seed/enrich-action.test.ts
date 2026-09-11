import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { getDefaultConfig, uuidv7 } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import {
  createDatabaseSeedEnrichAction,
  type SeedEnrichContext,
  type SeedEnrichOptions,
  type SeedEnrichPersistence,
  type SeedEnrichResult,
} from './enrich.js';
import { prepareDatabaseSeedEnrichmentSources } from '../../lib/database-seed-enrichment.js';

const cleanups: string[] = [];

function fixture() {
  const close = vi.fn();
  const operationOptions = { signal: new AbortController().signal, onWait: vi.fn() };
  const resolveContext = vi.fn(async (_options: unknown) => ({
    repoRoot: '/repo',
    repo: { cwd: '/repo' },
    config: getDefaultConfig(),
    database: {},
    operationOptions,
    close,
  }));
  const prepareSources = vi.fn(async ({ directory }: { directory: string }) => ({
    directory,
    sources: [],
  }));
  const result = {
    mode: 'dry-run' as const,
    artifact_id: uuidv7(),
    bundle_directory: '/repo/.orcaops/seed/amend',
    bundle_file: 'bundle.md',
    decision_mode: 'replace' as const,
    confirmation_required: true,
    ready: true,
    totals: { amended: 0, unchanged: 0, invalid: 0, failed: 0 },
    invalid: [],
    warnings: [],
    failures: [],
  };
  const run = vi.fn(
    async (
      _context: SeedEnrichContext,
      _options: SeedEnrichOptions,
      _persistence?: SeedEnrichPersistence
    ): Promise<SeedEnrichResult> => result
  );
  const action = createDatabaseSeedEnrichAction({ resolveContext, run, prepareSources } as never);
  const stdout: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { action, close, operationOptions, prepareSources, resolveContext, result, run, stdout };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    cleanups.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

it('rejects invalid enrichment options before resolving project history', async () => {
  const f = fixture();
  await expect(
    f.action({ artifact: 'invalid', dryRun: true, yes: true, json: true })
  ).rejects.toMatchObject({ code: 1 });
  expect(f.resolveContext).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
  expect(JSON.parse(f.stdout.join('')).error.code).toBe('INVALID_INPUT');
});

it('refuses raw authored input before opening an enrichment writer', async () => {
  const f = fixture();
  f.resolveContext.mockRejectedValue(
    new ProjectDatabaseError('SECRET_IN_PAYLOAD', 'Refused original input')
  );
  const options = { artifact: uuidv7(), enrichmentDir: 'refused', yes: true, json: true };
  await expect(f.action(options)).rejects.toMatchObject({ code: 1 });
  expect(f.resolveContext).toHaveBeenCalledWith(
    expect.objectContaining({
      write: false,
      initialize: false,
      authoredPayloads: [options],
      signal: expect.any(AbortSignal),
      onWait: expect.any(Function),
    })
  );
  expect(f.run).not.toHaveBeenCalled();
  expect(JSON.parse(f.stdout.join('')).error.code).toBe('SECRET_IN_PAYLOAD');
});

it('cancels during context resolution without running enrichment writes', async () => {
  const f = fixture();
  f.resolveContext.mockImplementation(async (received: unknown) => {
    const options = received as { signal: AbortSignal };
    process.emit('SIGINT');
    expect(options.signal.aborted).toBe(true);
    return {
      repoRoot: '/repo',
      repo: { cwd: '/repo' },
      config: getDefaultConfig(),
      database: {},
      operationOptions: { signal: options.signal, onWait: f.operationOptions.onWait },
      close: f.close,
    };
  });
  await expect(f.action({ artifact: uuidv7(), yes: true, json: true })).rejects.toMatchObject({
    code: 1,
  });
  expect(f.run).not.toHaveBeenCalled();
  expect(f.prepareSources).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
  expect(JSON.parse(f.stdout.join('')).error.code).toBe('CANCELLED');
});

it('forwards cancellation and reports a named wait once', async () => {
  const f = fixture();
  f.resolveContext.mockImplementation(async (received: unknown) => {
    const options = received as { signal: AbortSignal; onWait(): void };
    options.onWait();
    options.onWait();
    return {
      repoRoot: '/repo',
      repo: { cwd: '/repo' },
      config: getDefaultConfig(),
      database: {},
      operationOptions: { signal: options.signal, onWait: vi.fn(options.onWait) },
      close: f.close,
    };
  });
  const artifact = uuidv7();
  await f.action({ artifact, json: true });
  expect(f.run).toHaveBeenCalledWith(
    expect.objectContaining({ repo: { cwd: '/repo' } }),
    { artifact, json: true },
    expect.objectContaining({ bundle: expect.any(Object), enrichment: expect.any(Object) })
  );
  expect(f.resolveContext).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ write: false, signal: expect.any(AbortSignal) })
  );
  expect(f.resolveContext).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ write: true, signal: expect.any(AbortSignal) })
  );
  expect(
    vi
      .mocked(process.stderr.write)
      .mock.calls.filter(([value]) => String(value).startsWith('Waiting for seed enrichment'))
  ).toHaveLength(1);
  expect(f.close).toHaveBeenCalledTimes(2);
});

it.each([
  { kind: 'literal', source: JSON.stringify({ token: `ghp_${'A'.repeat(36)}` }) },
  { kind: 'escaped', source: `{"token":"ghp_\\u0041${'A'.repeat(35)}"}` },
  {
    kind: 'escaped overwritten duplicate',
    source: `{"token":"ghp_\\u0041${'A'.repeat(35)}","token":"safe"}`,
  },
])('refuses $kind authored file secrets before resolving a writer', async ({ source }) => {
  const f = fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-seed-enrichment-secret-'));
  cleanups.push(directory);
  await writeFile(path.join(directory, 'authored.json'), source);
  const action = createDatabaseSeedEnrichAction({
    resolveContext: f.resolveContext,
    run: f.run,
    prepareSources: prepareDatabaseSeedEnrichmentSources,
  } as never);

  await expect(
    action({ artifact: uuidv7(), enrichmentDir: directory, yes: true, json: true })
  ).rejects.toMatchObject({ code: 1 });
  expect(f.resolveContext).toHaveBeenCalledOnce();
  expect(f.resolveContext).toHaveBeenCalledWith(expect.objectContaining({ write: false }));
  expect(f.run).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
  expect(JSON.parse(f.stdout.join('')).error.code).toBe('SECRET_IN_PAYLOAD');
});

it('refuses an authored filename secret before resolving a writer', async () => {
  const f = fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-seed-enrichment-secret-'));
  cleanups.push(directory);
  await writeFile(path.join(directory, `ghp_${'A'.repeat(36)}.json`), '{"outcome":"safe"}');
  const action = createDatabaseSeedEnrichAction({
    resolveContext: f.resolveContext,
    run: f.run,
    prepareSources: prepareDatabaseSeedEnrichmentSources,
  } as never);

  await expect(
    action({ artifact: uuidv7(), enrichmentDir: directory, yes: true, json: true })
  ).rejects.toMatchObject({ code: 1 });
  expect(f.resolveContext).toHaveBeenCalledOnce();
  expect(f.resolveContext).toHaveBeenCalledWith(expect.objectContaining({ write: false }));
  expect(f.run).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
  expect(JSON.parse(f.stdout.join('')).error.code).toBe('SECRET_IN_PAYLOAD');
});

it('retains prepared authored bytes when the file changes before writer open', async () => {
  const f = fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-seed-enrichment-source-'));
  cleanups.push(directory);
  const sourceFile = path.join(directory, 'authored.json');
  await writeFile(sourceFile, '{"outcome":"prepared"}\n');
  f.resolveContext.mockImplementation(async (options: unknown) => {
    if ((options as { write: boolean }).write)
      await writeFile(sourceFile, '{"outcome":"changed"}\n');
    return {
      repoRoot: '/repo',
      repo: { cwd: '/repo' },
      config: getDefaultConfig(),
      database: {},
      operationOptions: f.operationOptions,
      close: f.close,
    };
  });
  f.run.mockImplementationOnce(async (_context, _options, persistence) => {
    const sources = await persistence!.enrichment.readAuthored!(directory);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.bytes?.toString('utf8')).toBe('{"outcome":"prepared"}\n');
    return f.result;
  });
  const action = createDatabaseSeedEnrichAction({
    resolveContext: f.resolveContext,
    run: f.run,
    prepareSources: prepareDatabaseSeedEnrichmentSources,
  } as never);

  await action({ artifact: uuidv7(), enrichmentDir: directory, json: true });
  expect(f.resolveContext).toHaveBeenCalledTimes(2);
  expect(f.close).toHaveBeenCalledTimes(2);
});
