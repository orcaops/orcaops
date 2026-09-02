import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { ArtifactStore } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'orcaops.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    child.stdin.end();
  });
}

describe('CLI error code remaps (smoke)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await runCli(['init', '--no-llm'], repo.path);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('SCHEMA_AHEAD: bumping schema_meta.version above CURRENT_VERSION surfaces the code', async () => {
    // Plant a future schema version through the storage Store (uses
    // the same better-sqlite3 instance the CLI will open). This test
    // spawns the real binary because the storage version-gate fires at
    // startup before any in-process harness can intercept.
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      store.store.db.prepare(`UPDATE schema_meta SET value = '999' WHERE key = 'version'`).run();
    } finally {
      store.close();
    }

    const res = await runCli(['list', '--json'], repo.path);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(env.error.code).toBe('SCHEMA_AHEAD');
    expect(env.error.message).toMatch(/999/);
    expect(env.error.message).toMatch(/Upgrade orcaops/);
  });

  it('error registry exposes the documentation-only codes for skill bodies', async () => {
    // The codes themselves are constants; consumers (skill bodies,
    // external tooling) can pattern-match without hitting a CLI
    // path. This test just confirms they're present in the runtime
    // bundle by importing the module path.
    const errors = await import('../../src/io/errors.js');
    const codes = errors.ErrorCodes;
    expect(codes.LOCK_TIMEOUT).toBe('LOCK_TIMEOUT');
    expect(codes.AMBIGUOUS_RESUME).toBe('AMBIGUOUS_RESUME');
    expect(codes.PIN_DISPLACED).toBe('PIN_DISPLACED');
    expect(codes.PIN_RESOLUTION_FAILED).toBe('PIN_RESOLUTION_FAILED');
    expect(codes.EVENT_LOG_CORRUPT).toBe('EVENT_LOG_CORRUPT');
    expect(codes.ARCHIVE_INCOMPLETE).toBe('ARCHIVE_INCOMPLETE');
    expect(codes.SCHEMA_AHEAD).toBe('SCHEMA_AHEAD');
    expect(codes.NO_SHELL_KEY).toBe('NO_SHELL_KEY');
    expect(codes.BLOCKED).toBe('BLOCKED');
    expect(codes.BLOCK_NOT_ACKNOWLEDGEABLE).toBe('BLOCK_NOT_ACKNOWLEDGEABLE');
    expect(codes.IDEMPOTENCY_CONFLICT).toBe('IDEMPOTENCY_CONFLICT');
    expect(codes.INVALID_CONFIG).toBe('INVALID_CONFIG');
    expect(errors.InfoCodes.IDEMPOTENT_REPLAY).toBe('IDEMPOTENT_REPLAY');
  });
});
