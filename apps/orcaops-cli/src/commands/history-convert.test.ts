import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';
import { readRepositoryRegistration } from '@orcaops/core/history/registration';
import { materializeLegacyFixture } from '@orcaops/history-convert';
import { canonicalJson } from '@orcaops/storage';
import {
  listProjectArtifacts,
  normalizeHistoryRoot,
  openProjectDatabase,
  projectDatabasePath,
  readProjectDisplayName,
  readProjectHistoryImport,
} from '@orcaops/storage/history/database';

import { buildProgram } from '../cli/program.js';
import { runInInvocationContext } from '../lib/invocation-context.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

async function legacyRepository() {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'orcaops-cli-convert-'))
  );
  directories.push(directory);
  return materializeLegacyFixture({ directory });
}

async function run(
  legacy: Awaited<ReturnType<typeof legacyRepository>>,
  argv: readonly string[]
): Promise<{ envelope: Record<string, unknown>; output: string; exitCode: number | null }> {
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let exitCode: number | null = null;
  try {
    await runInInvocationContext(
      {
        cwd: legacy.cwd,
        env: { ...legacy.env, ORCAOPS_DATA_DIR: legacy.root, ORCAOPS_CLOUD_FEATURES: '0' },
      },
      async () => {
        const program = buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL });
        program.exitOverride();
        try {
          await program.parseAsync([...argv], { from: 'user' });
        } catch (cause) {
          exitCode = (cause as { code?: number }).code ?? 1;
        }
      }
    );
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  const output = writes.join('');
  return {
    envelope: argv.includes('--json') ? (JSON.parse(output) as Record<string, unknown>) : {},
    output,
    exitCode,
  };
}

it(
  'previews, converts, registers and then refuses a second conversion of the same repository',
  { timeout: 180_000 },
  async () => {
    const legacy = await legacyRepository();
    const artifactId = legacy.fixture.artifacts.one;
    const originals = new Map<string, string>();
    for (const base of [
      path.join(legacy.cwd, '.orcaops'),
      path.join(legacy.root, 'projects', legacy.projectId),
    ]) {
      const file = path.join(base, 'artifacts', artifactId, 'events.ndjson');
      const records = (await fs.readFile(file, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      const closed = [...records]
        .reverse()
        .find(
          (entry) => entry.type === 'checkpoint_closed' && entry.payload?.diff_fingerprint_manifest
        );
      expect(closed).toBeDefined();
      closed.payload.diff_fingerprint_manifest.checkpoint_n += 100;
      const { checksum: _checksum, ...unsigned } = closed;
      closed.checksum = createHash('sha256').update(canonicalJson(unsigned)).digest('hex');
      const bytes = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
      await fs.writeFile(file, bytes);
      originals.set(file, bytes);
    }
    const preview = await run(legacy, ['history', 'convert', '--json']);
    expect(preview.envelope).toMatchObject({
      ok: true,
      mode: 'preview',
      profile: 'orcaops-0.2.0-rc.2',
      producerEvidence: 'unknown',
      projectId: legacy.projectId,
      contentComplete: true,
      unclassified: [],
    });
    expect(preview.envelope.disclosures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId,
          kind: 'derived-fingerprint',
          fidelity: 'differs-from-current',
          relativePath: 'events.ndjson',
        }),
      ])
    );
    const human = await run(legacy, ['history', 'convert']);
    expect(human.output).toContain('derived-fingerprint differs-from-current');
    expect(human.output).toContain('readers validate fingerprints before using them as evidence');
    expect(preview.envelope.target).toMatchObject({ database: { state: 'absent' } });
    expect(JSON.stringify(preview.envelope)).toContain('intentionally-not-inspected');
    expect(JSON.stringify(preview.envelope)).not.toContain('Ship the gamma module behind a flag');

    const root = await normalizeHistoryRoot({ root: legacy.root });
    const target = path.join(root.resolvedRoot, 'projects', legacy.projectId, 'history.sqlite3');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const applied = await run(legacy, ['history', 'convert', '--apply', '--offline', '--json']);
    expect(applied.exitCode).toBeNull();
    expect(applied.envelope).toMatchObject({
      ok: true,
      mode: 'apply',
      producerEvidence: 'unknown',
      projectId: legacy.projectId,
      replayed: false,
      convertedDatabase: target,
      registration: { repository: 'created', catalog: 'created', worktree: 'created' },
    });
    expect(applied.envelope.disclosures).toEqual(preview.envelope.disclosures);
    for (const [file, bytes] of originals) expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    expect((applied.envelope.comparison as { ok: boolean }).ok).toBe(true);
    expect((applied.envelope.comparison as { differences: string[] }).differences).toEqual([]);

    const registration = await readRepositoryRegistration({
      commonDir: path.join(legacy.cwd, '.git'),
    });
    expect(registration).toMatchObject({ authority: { project_id: legacy.projectId } });
    await expect(
      fs.stat(path.join(root.resolvedRoot, 'projects', 'catalog', `${legacy.projectId}.json`))
    ).resolves.toBeTruthy();

    const authority = {
      ...root,
      projectId: legacy.projectId,
      storeInstanceId: registration!.authority.store_instance_id,
      repositoryInstanceId: registration!.repository_instance_id,
    };
    expect(projectDatabasePath(authority)).toEqual(target);
    const handle = await openProjectDatabase({ authority, mode: 'reader' });
    try {
      expect(readProjectDisplayName(handle)).toBe(path.basename(legacy.cwd));
      const listed = listProjectArtifacts(handle, { limit: 50 }).artifacts;
      expect(listed).toHaveLength(6);
      expect(listed.map((row) => row.artifactId)).toContain(legacy.fixture.artifacts.one);
      expect(readProjectHistoryImport(handle)!.sourceProfile).toBe('orcaops-0.2.0-rc.2');
    } finally {
      handle.close();
    }

    const resumed = await run(legacy, [
      'history',
      'convert',
      '--apply',
      '--offline',
      '--operation-id',
      String(applied.envelope.operationId),
      '--json',
    ]);
    expect(resumed.envelope).toMatchObject({
      ok: true,
      replayed: true,
      producerEvidence: 'unknown',
      comparison: null,
      disclosures: null,
    });

    const again = await run(legacy, ['history', 'convert', '--apply', '--offline', '--json']);
    expect(again.exitCode).toBe(1);
    expect(again.envelope).toMatchObject({ ok: false, error: { code: 'IDENTITY_CONFLICT' } });
  }
);

it('refuses an apply without an explicit offline window', { timeout: 120_000 }, async () => {
  const legacy = await legacyRepository();
  const result = await run(legacy, ['history', 'convert', '--apply', '--json']);
  expect(result.exitCode).toBe(1);
  expect(result.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  await expect(
    fs.stat(path.join(legacy.root, 'projects', legacy.projectId, 'history.sqlite3'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses an offline window on a preview', { timeout: 120_000 }, async () => {
  const legacy = await legacyRepository();
  const result = await run(legacy, ['history', 'convert', '--offline', '--json']);
  expect(result.exitCode).toBe(1);
  expect(result.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});

// The personal layout is an explicit augmentation of frozen producer bytes,
// not a claim that the committed fixture was generated by a personal install.
async function personalRepository(evaluators: boolean, linked: boolean) {
  const legacy = await legacyRepository();
  const common = path.join(legacy.cwd, '.git', 'orcaops');
  await fs.mkdir(common, { recursive: true });
  const configPath = path.join(legacy.cwd, '.orcaops/config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.install.scope = 'personal';
  await fs.writeFile(path.join(common, 'config.json'), JSON.stringify(config) + '\n');
  await fs.rm(configPath);
  await fs.copyFile(
    path.join(legacy.cwd, '.orcaops/install.local.json'),
    path.join(common, 'personal-manifest.json')
  );
  if (evaluators)
    await fs.copyFile(
      path.join(legacy.cwd, '.orcaops/evaluators.yaml'),
      path.join(common, 'evaluators.yaml')
    );
  const originals = new Map<string, Buffer>();
  for (const name of await fs.readdir(common)) {
    const file = path.join(common, name);
    originals.set(file, await fs.readFile(file));
  }
  await fs.mkdir(path.join(common, 'locks'));
  if (!linked) return { legacy, originals };
  const cwd = path.join(path.dirname(legacy.cwd), 'linked');
  await promisify(execFile)('git', ['-C', legacy.cwd, 'worktree', 'add', '-qb', 'linked', cwd], {
    env: legacy.env,
  });
  return { legacy: { ...legacy, cwd }, originals };
}

it.each(
  [false, true].flatMap((evaluators) => [false, true].map((linked) => ({ evaluators, linked })))
)(
  'converts retained personal installation state with evaluators=$evaluators linked=$linked',
  { timeout: 180_000 },
  async ({ evaluators, linked }) => {
    const { legacy, originals } = await personalRepository(evaluators, linked);
    const preview = await run(legacy, ['history', 'convert', '--json']);
    expect
      .soft(preview.envelope)
      .toMatchObject({ ok: true, contentComplete: true, unclassified: [] });
    const applied = await run(legacy, ['history', 'convert', '--apply', '--offline', '--json']);
    expect(applied.envelope).toMatchObject({
      ok: true,
      mode: 'apply',
      projectId: legacy.projectId,
    });
    const retained = preview.envelope.retained as {
      location: string;
      family: string;
      sha256: string;
    }[];
    for (const [location, bytes] of originals) {
      if (location.endsWith('config.json')) continue;
      expect(retained.filter((entry) => entry.location === location)).toEqual([
        {
          location,
          family: location.endsWith('evaluators.yaml') ? 'evaluator-config' : 'installer',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ]);
    }
    expect(applied.exitCode).toBeNull();
    for (const [location, bytes] of originals) expect(await fs.readFile(location)).toEqual(bytes);
    const listed = await run(legacy, ['list', '--json']);
    expect(listed.envelope.ok).toBe(true);
    expect(JSON.stringify(listed.envelope)).toContain(legacy.fixture.artifacts.one);
    const root = await normalizeHistoryRoot({ root: legacy.root });
    const registration = await readRepositoryRegistration({
      commonDir: path.dirname(path.dirname([...originals.keys()][0]!)),
    });
    const database = await openProjectDatabase({
      authority: {
        ...root,
        projectId: legacy.projectId,
        storeInstanceId: registration!.authority.store_instance_id,
        repositoryInstanceId: registration!.repository_instance_id,
      },
      mode: 'reader',
    });
    try {
      const artifacts = listProjectArtifacts(database, { limit: 50 }).artifacts;
      expect(artifacts).toHaveLength(6);
      expect(artifacts.map((artifact) => artifact.artifactId)).toEqual(
        expect.arrayContaining(Object.values(legacy.fixture.artifacts))
      );
    } finally {
      database.close();
    }
  }
);
