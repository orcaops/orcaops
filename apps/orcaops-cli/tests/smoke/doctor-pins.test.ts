import { spawn } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
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
 * Smoke surface for cross-process XDG_STATE_HOME propagation. The pin
 * lookup path resolves under `$XDG_STATE_HOME/orcaops/pins/<repo-id>/`
 * at every entry point (capture-plan auto-pin, doctor, checkout,
 * resume). In-process tests can override XDG_STATE_HOME via the
 * AsyncLocalStorage frame, but only a real spawn proves that the env
 * propagates through the OS-level fork boundary — every CLI process
 * must read what the parent shell exported.
 */
describe('orcaops doctor pin path with spawn-set XDG_STATE_HOME (smoke)', () => {
  let repo: TempRepo;
  let xdgState: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-pins-smoke-xdg-'));
    await runCli(['init', '--json', '--no-llm'], {
      cwd: repo.path,
      env: { ...process.env, ...withCleanSession({ XDG_STATE_HOME: xdgState }) },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('capture plan with CLAUDE_SESSION_ID + XDG_STATE_HOME → pin lands at the spawn-passed path', async () => {
    const sessionEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...withCleanSession({
        XDG_STATE_HOME: xdgState,
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

    // pin file lives somewhere under $XDG_STATE_HOME/orcaops/pins/<repoId>/
    const pinsRoot = path.join(xdgState, 'orcaops', 'pins');
    const repoDirs = await readdir(pinsRoot);
    expect(repoDirs.length).toBeGreaterThan(0);
    const pinFiles = await readdir(path.join(pinsRoot, repoDirs[0]));
    const pinFile = pinFiles.find((f) => f.endsWith('.json'));
    expect(pinFile).toBeTruthy();
  });
});
