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
 * Smoke surface for the --input flag. Verifies that the real binary
 * exits 1 with a NO_INPUT envelope when --input points at a missing
 * file. In-process tests catch the CliExit sentinel via the harness
 * fuse; this confirms the same code path lands a real `process.exit`
 * at the OS level — --input is a path where a stray `process.exit`
 * would otherwise leak.
 */
describe('orcaops --input (smoke)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await runCli(['init', '--json', '--no-llm'], { cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('--input <missing>: emits NO_INPUT envelope + exit code 1 from the real process', async () => {
    const missing = path.join(repo.path, 'does-not-exist.json');
    const res = await runCli(['capture', 'plan', '--input', missing], {
      cwd: repo.path,
    });
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('NO_INPUT');
  });

  it('--input - : reads a YAML heredoc payload from stdin (block scalars + plain labels)', async () => {
    // Authored the way the shipped skills document: |- block scalars for
    // prose, plain scalars for labels. Proves the end-to-end stdin → YAML
    // parse → Zod path the in-process harness cannot exercise.
    const yamlPlan = [
      'task: |-',
      '  author a plan via YAML on stdin (block scalar prose, no escaping)',
      'label: yaml-stdin-smoke',
      'plan_steps:',
      '  - text: |-',
      '      wire the thing',
      '    label: wire the thing',
    ].join('\n');
    const res = await runCli(['capture', 'plan', '--no-llm', '--input', '-'], {
      cwd: repo.path,
      stdin: yamlPlan,
    });
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as {
      ok: boolean;
      plan_steps: { text: string; label: string }[];
    };
    expect(env.ok).toBe(true);
    // Block-scalar prose round-trips literally.
    expect(env.plan_steps[0].text).toBe('wire the thing');
    expect(env.plan_steps[0].label).toBe('wire the thing');
  });

  it('the retired --yaml payload alias is rejected as an unknown option', async () => {
    const res = await runCli(['capture', 'plan', '--no-llm', '--yaml', '-'], {
      cwd: repo.path,
      stdin: 'task: alias via the yaml flag',
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/unknown option/);
  });
});
