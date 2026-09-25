import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, realpathSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type ProjectDatabaseAuthority,
  projectDatabasePath,
} from '@orcaops/storage/history/database';

import { isCi } from '../lib/invocation-context.js';

/**
 * Starting the background worker after a capture. It is best effort in the
 * strongest sense: it never waits for the worker, never reports its result, and
 * never fails or delays the caller, because provider discovery, model calls and
 * worker startup are not on the capture success path.
 *
 * Everything it does is synchronous, so a caller cannot drop a promise it never
 * meant to await and no capture path acquires an await it did not have.
 */

/**
 * Set on the worker's own environment. A worker never wakes a worker: the
 * lease already stops a second owner, and this stops the spawn entirely, so a
 * failure to take the lease cannot become a fork bomb.
 */
export const WORKER_PROCESS_MARKER = 'ORCAOPS_KNOWLEDGE_WORKER';

/**
 * The developer and CI switch, not a product setting: set it falsey and no
 * worker is ever started from this process. The CLI's own test setup sets it,
 * because those tests run commands in-process where re-running this process's
 * entry would spawn a vitest worker, not orcaops. A test that wants a real
 * worker asks for one by clearing it and naming the entry.
 */
export const WORKER_START_SWITCH = 'ORCAOPS_KNOWLEDGE_WORKER_START';

export const WORKER_LOG_FILE = 'knowledge-worker.log';

/** Rotated at this size, keeping one previous file: a detached process appends unattended. */
const LOG_ROTATE_BYTES = 1024 * 1024;

export interface WorkerEntry {
  execPath: string;
  script: string;
}

export interface StartProcessingWorkerInput {
  /** The checkout the capture was made in; the worker resolves per-job origins itself. */
  repoRoot: string;
  /** The project database the worker owns. Its directory holds the worker's log. */
  authority: ProjectDatabaseAuthority;
  env?: NodeJS.ProcessEnv;
  /**
   * The entry to re-run. Omitted, it is this build's own `bin/orcaops.js`, and
   * only when this process is running that entry: anything else re-running it
   * is not orcaops and is refused.
   */
  entry?: WorkerEntry;
}

export interface ProcessingWorkerStart {
  started: boolean;
  pid: number | null;
  logPath: string | null;
  detail: string;
}

export function workerLogPath(authority: ProjectDatabaseAuthority): string {
  return path.join(path.dirname(projectDatabasePath(authority)), WORKER_LOG_FILE);
}

/** This build's own command-line entry, beside the `dist` this module is in. */
export function orcaopsEntryScript(): string {
  return fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url));
}

/**
 * The entry to re-run when the caller named none: this build's own bin, and
 * only when this very process is running it. Under vitest, a hook, or anything
 * else that loaded these modules without being the CLI, `process.argv[1]` is
 * some other script, and re-running THAT as `knowledge worker` would spawn
 * whatever it happens to be.
 */
function ownEntry(): { entry: WorkerEntry } | { refusal: string } {
  const script = orcaopsEntryScript();
  const running = process.argv[1];
  if (running === undefined || !isSameScript(running, script)) {
    return {
      refusal:
        `No worker was started: this process is running ` +
        `${running === undefined ? 'no entry script' : JSON.stringify(path.resolve(running))}, ` +
        `not the orcaops entry ${JSON.stringify(script)}, so there is nothing safe to re-run.`,
    };
  }
  return { entry: { execPath: process.execPath, script } };
}

/**
 * A global install runs the bin through a symlink, and Node leaves
 * `process.argv[1]` as the link while `import.meta.url` is the real file, so
 * the two are compared as real paths. A path that cannot be resolved is
 * compared as written.
 */
export function isSameScript(running: string, script: string): boolean {
  const real = (file: string): string => {
    try {
      return realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return real(running) === real(script);
}

function rotate(logPath: string): void {
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size < LOG_ROTATE_BYTES) return;
  try {
    renameSync(logPath, `${logPath}.1`);
  } catch {
    /* A log that cannot be rotated is appended to instead. */
  }
}

export function startProcessingWorker(input: StartProcessingWorkerInput): ProcessingWorkerStart {
  const refuse = (detail: string, logPath: string | null = null): ProcessingWorkerStart => ({
    started: false,
    pid: null,
    logPath,
    detail,
  });
  const env = { ...(input.env ?? process.env) };
  if (env[WORKER_PROCESS_MARKER] !== undefined) {
    return refuse('A worker does not start another worker.');
  }
  if (WORKER_START_SWITCH in env && !isCi(env[WORKER_START_SWITCH])) {
    return refuse(`No worker was started: ${WORKER_START_SWITCH} is off in this environment.`);
  }
  const resolved = input.entry ? { entry: input.entry } : ownEntry();
  if ('refusal' in resolved) return refuse(resolved.refusal);
  const { execPath, script } = resolved.entry;

  let logPath: string;
  let fd: number;
  try {
    logPath = workerLogPath(input.authority);
    mkdirSync(path.dirname(logPath), { recursive: true });
    rotate(logPath);
    fd = openSync(logPath, 'a');
  } catch (err) {
    return refuse(`No worker was started: its log could not be opened (${describe(err)}).`);
  }

  try {
    const child = spawn(execPath, [script, 'knowledge', 'worker', '--root', input.repoRoot], {
      cwd: input.repoRoot,
      // Its own process group, so the caller's terminal signals do not reach
      // it and it outlives the invocation that woke it.
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env, [WORKER_PROCESS_MARKER]: '1' },
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
    return {
      started: true,
      pid: child.pid ?? null,
      logPath,
      detail: `Started a background knowledge worker; it writes to ${logPath}.`,
    };
  } catch (err) {
    return refuse(`No worker was started: ${describe(err)}`, logPath);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* The child holds its own descriptor; this one is ours to drop. */
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
