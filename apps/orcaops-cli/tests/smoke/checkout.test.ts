import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
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

interface StatusOk {
  ok: true;
  branch: string;
  current_pin: { artifact_id: string; shell_key: { kind: string } } | null;
}

/**
 * Smoke surface for shell-key precedence resolution at spawn time.
 * `resolveShellKey` reads CLAUDE_SESSION_ID → CODEX_SESSION_ID →
 * TMUX_PANE → ... in order. In-process tests can override env via the
 * ALS frame, but only a real spawn proves the CLI reads what the OS
 * actually exported — the env crosses the fork boundary into the
 * child's `process.env`.
 *
 * Each case here passes a precise env subset (everything else cleared)
 * and runs `capture plan` then `status --json` to inspect the resulting
 * current_pin.shell_key.kind. When no shell-key is resolvable, the
 * auto-pin path stays silent and current_pin is null.
 */
describe('orcaops checkout: shell-key precedence (smoke)', () => {
  let repo: TempRepo;
  let xdgState: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-checkout-smoke-xdg-'));
    await runCli(['init', '--json', '--no-llm'], {
      cwd: repo.path,
      env: { ...process.env, ...withCleanSession({ XDG_STATE_HOME: xdgState }) },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function planAndStatus(extras: Record<string, string>): Promise<StatusOk> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...withCleanSession({ XDG_STATE_HOME: xdgState, ...extras }),
    };
    const planRes = await runCli(
      [
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-smoke-checkout-${Object.values(extras).join('-') || 'headless'}`,
            task: 't',
            label: `checkout-smoke`,
            plan_steps: [{ text: 's', label: 's1' }],
          })
        ),
      ],
      { cwd: repo.path, env }
    );
    expect(planRes.exitCode).toBe(0);
    const statusRes = await runCli(['status', '--json'], { cwd: repo.path, env });
    expect(statusRes.exitCode).toBe(0);
    return JSON.parse(statusRes.stdout) as StatusOk;
  }

  it('CLAUDE_SESSION_ID set → shell_key.kind === claude_session', async () => {
    const s = await planAndStatus({ CLAUDE_SESSION_ID: 'sess_claude' });
    expect(s.current_pin?.shell_key.kind).toBe('claude_session');
  });

  it('CODEX_SESSION_ID set (claude absent) → shell_key.kind === codex_session', async () => {
    const s = await planAndStatus({ CODEX_SESSION_ID: 'sess_codex' });
    expect(s.current_pin?.shell_key.kind).toBe('codex_session');
  });

  it('only TMUX_PANE set → shell_key.kind === tmux_pane', async () => {
    const s = await planAndStatus({ TMUX_PANE: '%0' });
    expect(s.current_pin?.shell_key.kind).toBe('tmux_pane');
  });

  it('all session env vars unset → no pin written, current_pin === null', async () => {
    const s = await planAndStatus({});
    expect(s.current_pin).toBeNull();
  });
});
