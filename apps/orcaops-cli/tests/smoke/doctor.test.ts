import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'orcaops.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
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

/**
 * Smoke surface for `orcaops doctor`'s human-text rendering. The
 * `✓/⚠/✗` glyphs are produced synchronously by `emitOk` before the
 * process exits; this test confirms the stdout flush ordering survives
 * the real `process.exit` — a known regression risk. The in-process
 * harness captures stdout buffered by the patched
 * `process.stdout.write`, so it cannot observe the OS-level
 * flush race.
 */
describe('orcaops doctor (smoke)', () => {
  // Inject a session-id env so the `shell-key` check in doctor.ts
  // resolves cleanly (kind!=none → pass). Without this the parent shell's
  // env leaks through; CI environments (no tty, no tmux, no
  // CLAUDE_SESSION_ID) would add an unrelated shell warning. The in-process
  // `tests/integration/doctor.test.ts` does the same.
  const DETERMINISTIC_ENV = { ...process.env, CLAUDE_SESSION_ID: 'test-doctor-smoke' };
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await runCli(['init', '--no-llm'], { cwd: repo.path, env: DETERMINISTIC_ENV });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('flushes human-format warnings before process.exit', async () => {
    const res = await runCli(['doctor'], { cwd: repo.path, env: DETERMINISTIC_ENV });
    expect(res.exitCode).toBe(0);
    // ✓ repository is pass-by-construction after init --no-llm in a temp git
    // repo (init only runs in a valid repo with a HEAD; healthy checks
    // condense into section summaries by default). Asserting this line
    // proves emitOk's synchronous write reached the OS pipe.
    expect(res.stdout).toMatch(/✓ repository/);
    // The final summary line is the load-bearing assertion — it's what
    // would be lost if process.exit raced the stdout flush.
    expect(res.stdout).toMatch(/^Overall: WARN \(1 warning\(s\)\)$/m);
    // Warnings write nothing to stderr (doctor.ts emitError only fires on
    // the CliExit path).
    expect(res.stderr).toBe('');
  });
});
