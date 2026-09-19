import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { renderSessionStartGuidance } from '../../src/lib/session-start-guidance.js';
import { readSessionStartState } from '../../src/lib/session-start-state.js';

/**
 * What the CLI should have printed, derived the way the CLI derives it. A
 * hand-built state literal would only prove the renderer is deterministic; it
 * cannot catch the state loader handing the renderer different content than the
 * repo on disk implies.
 */
async function expectedGuidance(repoRoot: string): Promise<string> {
  return `${renderSessionStartGuidance(await readSessionStartState(repoRoot)) as string}\n`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'orcaops.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Non-null when the process was signalled — the hook deadline SIGKILLs. */
  signal: NodeJS.Signals | null;
}

async function which(bin: string): Promise<string> {
  return execFileSync('command', ['-v', bin], { shell: '/bin/sh', encoding: 'utf8' }).trim();
}

function runCli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> }
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
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
    child.on('close', (code, signal) => resolve({ stdout, stderr, exitCode: code, signal }));
    child.stdin.end();
  });
}

/**
 * Spawn-only surface of the `hook session-start` FAST PATH in
 * `src/cli/index.ts` — the argv sniff runs before `program.js` loads, so the
 * in-process suite (which enters through `buildProgram().parseAsync`) can
 * never exercise it. Under test: the never-banner contract from the real
 * process (exit 0 + empty stdout on every failure), output parity with the
 * pure renderer, the per-agent output shapes including the deliberate
 * unknown-`--agent` degrade-to-text (commander would exit 1), the
 * fall-through to commander for non-matching argv, and independence from the
 * better-sqlite3 native addon on the static path.
 */
describe('orcaops hook session-start (smoke: real spawn, fast path)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    vi.stubEnv('ORCAOPS_DISABLE_DRAIN', '1');
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await repo.cleanup();
  });

  it('non-git dir and uninitialized repo → exit 0, empty stdout', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-smoke-'));
    const noGit = await runCli(['hook', 'session-start'], { cwd: dir });
    expect(noGit.exitCode).toBe(0);
    expect(noGit.stdout).toBe('');

    const noInit = await runCli(['hook', 'session-start'], { cwd: repo.path });
    expect(noInit.exitCode).toBe(0);
    expect(noInit.stdout).toBe('');
  });

  it('initialized static repo: output is exactly the rendered guidance; per-agent shapes hold', async () => {
    const init = await runCli(
      ['init', '--scope', 'project', '--json', '--no-llm', '--prefix', 'oo', '--session-hooks'],
      {
        cwd: repo.path,
      }
    );
    expect(init.exitCode).toBe(0);

    const plain = await runCli(['hook', 'session-start'], { cwd: repo.path });
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toBe(await expectedGuidance(repo.path));
    expect(plain.stdout).toContain('close the thread: oo-finish');
    expect(plain.stdout).not.toContain('oo-pre-pr');

    const cursor = await runCli(['hook', 'session-start', '--agent', 'cursor'], {
      cwd: repo.path,
    });
    expect(cursor.exitCode).toBe(0);
    const parsed = JSON.parse(cursor.stdout) as { additional_context: string };
    expect(parsed.additional_context).toContain('[orcaops]');

    // Deliberate contract change from commander's `.choices()`: a mangled
    // `--agent` value degrades to plain text + exit 0 instead of a per-session
    // error banner.
    const bogus = await runCli(['hook', 'session-start', '--agent', 'bogus'], {
      cwd: repo.path,
    });
    expect(bogus.exitCode).toBe(0);
    expect(bogus.stdout.startsWith('[orcaops]')).toBe(true);
  });

  it('non-matching argv falls through to commander (help still works)', async () => {
    const help = await runCli(['hook', 'session-start', '--help'], { cwd: repo.path });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('session-start');
    expect(help.stdout).toContain('--agent');
  });

  it('a truncated --agent flag exits silently through the fast path', async () => {
    const result = await runCli(['hook', 'session-start', '--agent'], { cwd: repo.path });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '', signal: null });
  });

  it('a commitless state-aware repo falls back to the static reminder', async () => {
    const init = await runCli(
      [
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--session-hooks',
        '--session-hook-payload',
        'state-aware',
      ],
      { cwd: repo.path }
    );
    expect(init.exitCode).toBe(0);
    await gitClient(repo.path).raw(['checkout', '--orphan', 'unborn']);

    const result = await runCli(['hook', 'session-start'], { cwd: repo.path });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[orcaops] This repo captures AI coding sessions');
  });

  it('a backpressured stdout write drains before the fast path exits', async () => {
    const init = await runCli(
      ['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks'],
      { cwd: repo.path }
    );
    expect(init.exitCode).toBe(0);
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-backpressure-'));
    const preload = path.join(dir, 'delay-stdout.mjs');
    await writeFile(
      preload,
      [
        'const write = process.stdout.write.bind(process.stdout);',
        'process.stdout.write = (chunk, encoding, callback) => {',
        '  setTimeout(() => write(chunk, encoding, callback), 25);',
        '  return false;',
        '};',
        '',
      ].join('\n'),
      'utf8'
    );

    const result = await runCli(['hook', 'session-start'], {
      cwd: repo.path,
      env: { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(await expectedGuidance(repo.path));
  });

  it('project arbitration and state loading share one git-root discovery', async () => {
    const init = await runCli(
      [
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--session-hooks',
        '--session-hook-entries',
        'none',
      ],
      { cwd: repo.path }
    );
    expect(init.exitCode).toBe(0);
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-git-count-'));
    const log = path.join(dir, 'git.log');
    const wrapper = path.join(dir, 'git');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"\n`,
      'utf8'
    );
    await chmod(wrapper, 0o755);

    const result = await runCli(['hook', 'session-start', '--agent', 'claude-code', '--user'], {
      cwd: repo.path,
      env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe('');
    const rootLookups = (await readFile(log, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('rev-parse --show-toplevel'));
    expect(rootLookups).toHaveLength(1);
  });

  it('a slow but finishing session start is not cut off by the deadline', async () => {
    const init = await runCli(
      ['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks'],
      { cwd: repo.path }
    );
    expect(init.exitCode).toBe(0);

    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-slow-'));
    const wrapper = path.join(dir, 'git');
    await writeFile(
      wrapper,
      ['#!/bin/sh', 'sleep 1', `exec ${await which('git')} "$@"`, ''].join('\n'),
      'utf8'
    );
    await chmod(wrapper, 0o755);

    const result = await runCli(['hook', 'session-start'], {
      cwd: repo.path,
      env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
    });

    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[orcaops]');
  });

  it('a hanging git subprocess is cut off by the fail-silent deadline', async () => {
    const init = await runCli(
      [
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--session-hooks',
        '--session-hook-payload',
        'state-aware',
      ],
      { cwd: repo.path }
    );
    expect(init.exitCode).toBe(0);
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-deadline-'));
    const wrapper = path.join(dir, 'git');
    await writeFile(
      wrapper,
      [
        '#!/bin/sh',
        'parent="$PPID"',
        'exec >/dev/null 2>&1',
        'while kill -0 "$parent"; do sleep 0.1; done',
        '',
      ].join('\n'),
      'utf8'
    );
    await chmod(wrapper, 0o755);

    const startedAt = Date.now();
    const result = await runCli(['hook', 'session-start'], {
      cwd: repo.path,
      env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    expect(Date.now() - startedAt).toBeLessThan(7_000);
    expect(result).toEqual({ exitCode: null, stdout: '', stderr: '', signal: 'SIGKILL' });
  });

  it('an instruction file that is a FIFO cannot stall the hook', async () => {
    // Managed bootstrap: only then does the hook read the instruction files to
    // decide whether a block already carries routing.
    const init = await runCli(
      ['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks', '--agents-md'],
      { cwd: repo.path }
    );
    expect(init.exitCode).toBe(0);
    await rm(path.join(repo.path, 'CLAUDE.md'), { force: true });
    await rm(path.join(repo.path, 'AGENTS.md'), { force: true });
    execFileSync('mkfifo', [path.join(repo.path, 'AGENTS.md')]);

    const startedAt = Date.now();
    const result = await runCli(['hook', 'session-start', '--agent', 'claude-code'], {
      cwd: repo.path,
    });
    // Well inside the deadline: the routing probe must skip the FIFO, not be
    // rescued from it.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('[orcaops] This repo captures AI coding sessions');
  });

  it('the deadline terminates a session start a blocked threadpool thread keeps alive', async () => {
    const init = await runCli(
      [
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--session-hooks',
        '--session-hook-payload',
        'state-aware',
      ],
      { cwd: repo.path }
    );
    expect(init.exitCode).toBe(0);
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-blocked-'));
    const wrapper = path.join(dir, 'git');
    await writeFile(
      wrapper,
      [
        '#!/bin/sh',
        'parent="$PPID"',
        'exec >/dev/null 2>&1',
        'while kill -0 "$parent"; do sleep 0.1; done',
        '',
      ].join('\n'),
      'utf8'
    );
    await chmod(wrapper, 0o755);
    const fifo = path.join(dir, 'never-written');
    execFileSync('mkfifo', [fifo]);
    const preload = path.join(dir, 'block-threadpool.mjs');
    // open() on a writerless FIFO never returns, so the threadpool thread it
    // occupies keeps Node's shutdown from ever completing: with a hung git
    // holding the hook open past the deadline, process.exit(0) would leave
    // this process alive forever. Only a signal ends it.
    await writeFile(
      preload,
      [
        "import { readFile } from 'node:fs/promises';",
        `void readFile(${JSON.stringify(fifo)}, 'utf8').catch(() => {});`,
        '',
      ].join('\n'),
      'utf8'
    );

    const startedAt = Date.now();
    const result = await runCli(['hook', 'session-start'], {
      cwd: repo.path,
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result.signal).toBe('SIGKILL');
  });

  it('static path never loads better-sqlite3: guidance still emits with the addon blocked', async () => {
    const init = await runCli(
      ['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks'],
      {
        cwd: repo.path,
      }
    );
    expect(init.exitCode).toBe(0);

    // Block BOTH resolution paths — an off-thread ESM resolve hook via
    // register() plus a Module._load patch for require/createRequire —
    // proving the fast path + lazy Store loader keep the native addon
    // entirely off the static path, so a broken prebuild can never banner
    // a session start. (The sync registerHooks API would cover both in one
    // shot, but it needs Node >= 22.15 and .nvmrc pins 22.14.)
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-loader-'));
    const hooks = path.join(dir, 'block-sqlite-esm-hooks.mjs');
    await writeFile(
      hooks,
      [
        'export function resolve(specifier, context, nextResolve) {',
        "  if (specifier === 'better-sqlite3') {",
        "    throw new Error('better-sqlite3 blocked by test');",
        '  }',
        '  return nextResolve(specifier, context);',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    const loader = path.join(dir, 'block-sqlite.mjs');
    await writeFile(
      loader,
      [
        "import Module, { register } from 'node:module';",
        '',
        'const originalLoad = Module._load;',
        'Module._load = function (request, parent, isMain) {',
        "  if (request === 'better-sqlite3') {",
        "    throw new Error('better-sqlite3 blocked by test');",
        '  }',
        '  return originalLoad.call(this, request, parent, isMain);',
        '};',
        '',
        `register(${JSON.stringify(pathToFileURL(hooks).href)});`,
        '',
      ].join('\n'),
      'utf8'
    );

    const r = await runCli(['hook', 'session-start'], {
      cwd: repo.path,
      env: { NODE_OPTIONS: `--import ${pathToFileURL(loader).href}` },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[orcaops] This repo captures AI coding sessions');
  });
});
