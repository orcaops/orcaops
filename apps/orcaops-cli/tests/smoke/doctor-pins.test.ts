import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
 * Smoke surface for cross-process focus propagation. A plan capture binds
 * the current session in the canonical project database, and a separate
 * process must observe that same binding.
 */
describe('orcaops cross-process database focus (smoke)', () => {
  let repo: TempRepo;
  let dataRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-focus-smoke-history-'));
    await runCli(['init', '--json', '--no-llm'], {
      cwd: repo.path,
      env: { ...process.env, ...withCleanSession({ ORCAOPS_DATA_DIR: dataRoot }) },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('a captured plan is focused for the same session in a new process', async () => {
    const sessionEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...withCleanSession({
        ORCAOPS_DATA_DIR: dataRoot,
        CLAUDE_SESSION_ID: 'smoke-pin-session',
      }),
    };
    const planRes = await runCli(
      [
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: 'plan-smoke-pins',
            task: 't',
            label: 'pin-smoke',
            plan_steps: [{ text: 's', label: 's1' }],
          })
        ),
      ],
      { cwd: repo.path, env: sessionEnv }
    );
    expect(planRes.exitCode).toBe(0);
    const artifactId = (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;
    const status = await runCli(['status', '--json'], { cwd: repo.path, env: sessionEnv });
    expect(status.exitCode).toBe(0);
    const focus = (JSON.parse(status.stdout) as { focus: Array<{ pin: { artifact_id: string } }> })
      .focus;
    expect(focus[0]?.pin.artifact_id).toBe(artifactId);
  });
});
