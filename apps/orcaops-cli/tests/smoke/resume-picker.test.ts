import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { withCleanSession } from '../support/test-helpers.js';

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
 * Smoke surface for the ambiguous-resume picker. The combo `ok: true,
 * resolved: false` + `exit code 1` is the known weirdness — the
 * envelope is structurally a success (it carries valid picker
 * candidates) but the spawn exits non-zero so shell pipelines can
 * detect "I didn't pick anything for you". The in-process harness's
 * CliExit sentinel observes the code, but only a real spawn proves
 * the OS sees exit-1 on a non-error envelope.
 */
describe('orcaops resume picker (smoke)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    // Run init headless so the lifecycle's auto-pin path stays a no-op
    // and the picker can see two un-pinned artifacts later.
    await runCli(['init', '--json', '--no-llm'], {
      cwd: repo.path,
      env: { ...process.env, ...withCleanSession({}) },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('two un-pinned artifacts on the branch: ok:true + resolved:false + exit 1', async () => {
    const headless: NodeJS.ProcessEnv = { ...process.env, ...withCleanSession({}) };
    for (const i of [1, 2]) {
      const planRes = await runCli(
        [
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(
            JSON.stringify({
              idempotency_key: `plan-smoke-amb-${i}`,
              task: `t${i}`,
              label: `picker-amb-${i}`,
              plan_steps: [{ text: 's', label: 's1' }],
            })
          ),
        ],
        { cwd: repo.path, env: headless }
      );
      expect(planRes.exitCode).toBe(0);
    }

    const res = await runCli(['resume', '--json'], { cwd: repo.path, env: headless });
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as {
      ok: boolean;
      resolved: boolean;
      reason?: string;
      candidates?: Array<{ id: string }>;
    };
    expect(env.ok).toBe(true);
    expect(env.resolved).toBe(false);
    expect(env.reason).toBe('multiple-active-no-pin');
    expect(env.candidates?.length).toBe(2);
  });
});
