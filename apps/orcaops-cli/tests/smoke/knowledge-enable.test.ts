import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { processingGrantsFilePath } from '../../src/lib/knowledge-processing-grants.js';

/**
 * Consent refuses anything but a person at a terminal, and only the real
 * process can prove it: an in-process test can always hand the flow a stdin
 * that claims to be one. Spawning with pipes is what a skill, hook or
 * background job would get.
 */

const BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bin',
  'orcaops.js'
);

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runOrcaops(args: string[], cwd: string, stdin: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo({ initialBranch: 'main' });
  await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(repo.path, '.orcaops', 'config.json'),
    `${JSON.stringify({ schema_version: 6, install: { scope: 'project' } }, null, 2)}\n`,
    'utf8'
  );
});

afterEach(async () => {
  await repo.cleanup();
});

describe('orcaops knowledge enable (smoke: real spawn)', () => {
  it('refuses a piped answer, records nothing, and says what to run instead', async () => {
    const result = await runOrcaops(['knowledge', 'enable'], repo.path, 'yes\n');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('can only be given at an interactive terminal');
    expect(result.stderr).toContain('Run `orcaops knowledge enable` yourself in a terminal');
    expect(result.stderr).toContain(
      'no flag, environment variable or non-interactive option grants it'
    );
    expect(result.stderr).not.toContain('Provider:');
    // The suite's hermetic config home; the real one is never opened.
    expect(existsSync(processingGrantsFilePath(process.env.ORCAOPS_CONFIG_HOME))).toBe(false);
  }, 20_000);

  it('refuses a piped model resume before it reads anything', async () => {
    const result = await runOrcaops(
      ['knowledge', 'resume', '--model', '--all'],
      repo.path,
      'yes\n'
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('only be given at an interactive terminal');
    expect(result.stderr).toContain(
      'no flag, environment variable or non-interactive option lifts'
    );
    // No terms, so nothing about any capture was printed to a pipe either.
    expect(result.stderr).not.toContain('Provider:');
  }, 20_000);

  it('refuses the same way under --json, as the error envelope', async () => {
    const result = await runOrcaops(['knowledge', 'enable', '--json'], repo.path, 'yes\n');

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: expect.stringContaining('interactive terminal'),
      },
    });
    expect(existsSync(processingGrantsFilePath(process.env.ORCAOPS_CONFIG_HOME))).toBe(false);
  }, 20_000);
});
