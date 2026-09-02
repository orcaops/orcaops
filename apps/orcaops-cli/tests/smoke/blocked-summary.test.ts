import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { plantBlockViolation } from '../support/test-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'orcaops.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], opts: { cwd: string; stdin?: string }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd,
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
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/**
 * Smoke surface for `capture summary` rejecting a BLOCKED artifact.
 * In-process tests verify the envelope shape via the CliExit sentinel;
 * this confirms the same code path lands a real exit-1 at the OS
 * level — the BLOCKED rejection is an error path worth verifying at
 * spawn level.
 */
describe('orcaops capture summary BLOCKED rejection (smoke)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await runCli(['init', '--json', '--no-llm'], { cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('BLOCKED on summary: envelope + exit code 1 from the real process', async () => {
    const planRes = await runCli(
      [
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: 'plan-smoke-blocked',
            task: 't',
            label: 'blocked-smoke',
            plan_steps: [{ text: 's', label: 's1' }],
          })
        ),
      ],
      { cwd: repo.path }
    );
    expect(planRes.exitCode).toBe(0);
    const { artifact_id } = JSON.parse(planRes.stdout) as { artifact_id: string };
    await plantBlockViolation({
      cwd: repo.path,
      artifactId: artifact_id,
      evaluatorRef: 'test-pack/api-stub',
    });

    const summary = await runCli(
      [
        'capture',
        'summary',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: 'summary-smoke-blocked',
            artifact_id,
            outcome: 'shipping anyway',
          })
        ),
      ],
      { cwd: repo.path }
    );
    expect(summary.exitCode).toBe(1);
    const err = JSON.parse(summary.stdout) as { ok: false; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('BLOCKED');
  });
});
