import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';
import { materializeLegacyFixture } from '@orcaops/history-convert';

import { buildProgram } from '../../src/cli/program.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';

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
  const errors: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
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
    output: argv.includes('--json') ? output : output + errors.join(''),
    exitCode,
  };
}

it.each(['unclassified', 'classification', 'inventory', 'mixed'] as const)(
  'names %s conversion blockers in human and JSON output',
  { timeout: 120_000 },
  async (failure) => {
    const legacy = await legacyRepository();
    const privateContent = 'retained-private-content-never-display';
    if (failure === 'unclassified' || failure === 'mixed') {
      for (const relative of ['unknown.json', 'nested/personal-manifest.json']) {
        const file = path.join(legacy.cwd, '.git/orcaops', relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, privateContent);
      }
    }
    if (failure === 'classification' || failure === 'mixed')
      await fs.writeFile(
        path.join(legacy.cwd, '.orcaops/artifacts', legacy.fixture.artifacts.one, 'events.ndjson'),
        privateContent
      );
    if (failure === 'inventory')
      await fs.symlink(
        path.join(legacy.root, 'absent'),
        path.join(legacy.cwd, '.orcaops/unknown-link')
      );
    const preview = await run(legacy, ['history', 'convert', '--json']);
    const issues = preview.envelope.issues as { location: string; code: string }[];
    const unclassified = preview.envelope.unclassified as { location: string }[];
    expect(preview.envelope.contentComplete).toBe(false);
    if (failure === 'unclassified') expect(issues).toEqual([]);
    if (failure === 'classification') expect(unclassified).toEqual([]);
    for (const json of [false, true]) {
      const result = await run(legacy, [
        'history',
        'convert',
        '--apply',
        '--offline',
        ...(json ? ['--json'] : []),
      ]);
      expect(result.exitCode).toBe(1);
      if (json)
        expect(result.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(result.output).toContain(
        `Inventory: ${failure === 'inventory' ? 'incomplete' : 'complete'}`
      );
      expect(result.output).toContain(`Issues (${issues.length})`);
      expect(result.output).toContain(`Unclassified sources (${unclassified.length})`);
      for (const issue of issues) {
        expect(result.output).toContain(issue.location);
        expect(result.output).toContain(issue.code);
      }
      for (const entry of unclassified) expect(result.output).toContain(entry.location);
      expect(result.output).toContain('orcaops history convert');
      if (unclassified.length)
        expect(result.output).toContain('report unrecognized Orcaops-owned state');
      expect(result.output).not.toContain(privateContent);
      expect(result.output).not.toContain('--ignore');
    }
    await expect(
      fs.stat(path.join(legacy.cwd, '.git/orcaops/registration.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(legacy.root, 'projects', legacy.projectId, 'history.sqlite3'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }
);
