import { type ChildProcess, spawn } from 'node:child_process';

import { registerCleanup } from './cleanup.js';
import { packagedCli, packagedSidecar } from './paths.js';
import type { DisposableRoot } from './roots.js';

export type ProcessOutcome = {
  pid: number | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Parsed --json envelope, or null when the process printed something else. */
  json: unknown;
  wallMs: number;
};

export type LiveProcess = {
  pid: number;
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves once the pattern appears on the named stream, or rejects on exit/timeout. */
  waitFor(stream: 'stdout' | 'stderr', pattern: RegExp, timeoutMs?: number): Promise<string>;
  /**
   * Resolves once a whole NDJSON line satisfying the predicate arrives on stdout.
   * The cursor is per-process and only ever advances, so a second call waits for a
   * line published after the first one returned rather than re-reading the buffer.
   */
  waitForLine(accept: (value: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
  /**
   * Advances the cursor past every complete line already buffered and returns how
   * many have been observed. A scenario calls this to make the next waitForLine
   * mean "published after this point".
   */
  drainLines(): number;
  /** How many complete NDJSON lines the cursor has passed. */
  linesSeen(): number;
  send(signal: NodeJS.Signals): void;
  exited: Promise<ProcessOutcome>;
  settled(): ProcessOutcome | undefined;
};

/**
 * Every spawned pid, so a scenario that fails mid-flight still leaves nothing
 * suspended or orphaned: cleanup resumes each child before killing it, because a
 * SIGSTOPped process never reaches its exit handlers.
 */
const live = new Set<ChildProcess>();
const observedPids: number[] = [];

export function spawnedPids(): number[] {
  return [...observedPids];
}

registerCleanup('children', async () => {
  await Promise.all(
    [...live].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        child.kill('SIGCONT');
        child.kill('SIGKILL');
      } catch {
        return;
      }
      await exited;
    })
  );
  live.clear();
});

type LaunchOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra stdin bytes; the stream is closed immediately unless keepStdinOpen is set. */
  stdin?: string;
  keepStdinOpen?: boolean;
  /** Node arguments placed before the entry point, e.g. a test-only `--import` preload. */
  nodeArgs?: string[];
};

function launch(entry: string, root: DisposableRoot, args: string[], options: LaunchOptions = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), entry, ...args], {
    cwd: options.cwd ?? root.repo,
    env: { ...root.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  live.add(child);
  if (child.pid !== undefined) observedPids.push(child.pid);
  let stdout = '';
  let stderr = '';
  const listeners = new Set<() => void>();
  const announce = () => {
    for (const listener of [...listeners]) listener();
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    announce();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
    announce();
  });
  child.stdin.on('error', () => {});
  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  if (!options.keepStdinOpen) child.stdin.end();

  // Shared across every waitForLine call on this process: a per-call cursor would
  // rewind to the start of the buffer and resolve instantly on a stale line.
  let consumedLines = 0;
  let outcome: ProcessOutcome | undefined;
  const exited = new Promise<ProcessOutcome>((resolve) => {
    child.once('close', (code, signal) => {
      live.delete(child);
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      outcome = {
        pid: child.pid ?? null,
        code,
        signal,
        stdout,
        stderr,
        json,
        wallMs: Date.now() - started,
      };
      resolve(outcome);
      announce();
    });
  });

  function waitFor(stream: 'stdout' | 'stderr', pattern: RegExp, timeoutMs = 15_000) {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(new Error(`Timed out waiting for ${pattern} on ${stream}\n${stdout}\n${stderr}`));
      }, timeoutMs);
      function finish(error?: Error, value?: string) {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error);
        else resolve(value!);
      }
      function check() {
        const text = stream === 'stdout' ? stdout : stderr;
        const match = pattern.exec(text);
        if (match) finish(undefined, match[0]);
        else if (outcome)
          finish(new Error(`Exited before ${pattern} on ${stream}\n${stdout}\n${stderr}`));
      }
      listeners.add(check);
      check();
    });
  }

  const completeLines = () => {
    const lines = stdout.split('\n');
    return lines.slice(0, -1);
  };

  function drainLines() {
    consumedLines = completeLines().length;
    return consumedLines;
  }

  function waitForLine(accept: (value: unknown) => boolean, timeoutMs = 30_000) {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(new Error(`Timed out waiting for an accepted NDJSON line\n${stdout}\n${stderr}`));
      }, timeoutMs);
      function finish(error?: Error, value?: unknown) {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error);
        else resolve(value);
      }
      function check() {
        const complete = completeLines();
        for (; consumedLines < complete.length; consumedLines += 1) {
          const line = complete[consumedLines]!.trim();
          if (!line) continue;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          if (accept(value)) {
            consumedLines += 1;
            return finish(undefined, value);
          }
        }
        if (outcome) finish(new Error(`Exited before an accepted line\n${stdout}\n${stderr}`));
      }
      listeners.add(check);
      check();
    });
  }

  const handle: LiveProcess = {
    pid: child.pid!,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitFor,
    waitForLine,
    drainLines,
    linesSeen: () => consumedLines,
    send: (signal) => {
      child.kill(signal);
    },
    exited,
    settled: () => outcome,
  };
  return handle;
}

/** Start the packaged CLI and leave it running. */
export function startCli(root: DisposableRoot, args: string[], options?: LaunchOptions) {
  return launch(packagedCli, root, args, options);
}

/** Run the packaged CLI to completion. */
export function runCli(root: DisposableRoot, args: string[], options?: LaunchOptions) {
  return startCli(root, args, options).exited;
}

/** Start the compiled Node sidecar. With no argv it streams NDJSON snapshots. */
export function startSidecar(root: DisposableRoot, args: string[] = [], options?: LaunchOptions) {
  return launch(packagedSidecar, root, args, { keepStdinOpen: args.length === 0, ...options });
}

/** Run the compiled sidecar's one-shot verbs to completion. */
export function runSidecar(root: DisposableRoot, args: string[], options?: LaunchOptions) {
  return startSidecar(root, args, options).exited;
}

/**
 * Start any Node script under the same pinned environment and pid tracking —
 * used for the boundary children that drive compiled modules with no packaged
 * trigger of their own.
 */
export function startNode(
  root: DisposableRoot,
  script: string,
  args: string[],
  options?: LaunchOptions
) {
  return launch(script, root, args, options);
}
