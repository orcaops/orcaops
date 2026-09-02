// UI-side journal loader/appender. Mirrors reviewSource.ts: spawn the app's own
// Node sidecar (`review journal --branch <b> [--input -]`) so the locked
// append + replay stay off the Bun UI (ArtifactLock pulls sqlite via storage).
// The event/batch JSON travels over the child's STDIN (`--input -`), never
// argv — a row-coverage event can exceed argv limits. The verb prints the
// replayed ledger JSON to stdout; since coverage entries carry those manifests,
// stdout is collected incrementally under an explicit generous cap
// (JOURNAL_IO_CAP_BYTES) instead of execFile's fixed 4MB maxBuffer. An
// over-cap ledger fails rather than returning partial JSON.
// Renderer-free (the src/data rule).

import { spawn } from 'node:child_process';

import type { JournalEvent, ReviewLedgerV2 } from '@orcaops/review-core';
import {
  JOURNAL_APPEND_REJECTION_CODE,
  type JournalAppendRejection,
  type JournalAppendRejectionCode,
  type ReviewArchiveWarning,
} from '@orcaops/review-engine';

import { resolveRoot } from './reviewSource';
import { resolveSidecar, sidecarMissingError } from './sidecarPath';

/**
 * Cap on collected stdout and the retained stderr diagnostic prefix. Stdout
 * crossing the cap is an error because partial ledger JSON is unusable;
 * additional stderr bytes are discarded to keep failure reporting bounded.
 */
export const JOURNAL_IO_CAP_BYTES = 64 * 1024 * 1024;

export interface JournalSourceOptions {
  /** Repo root; when omitted, resolved from git-toplevel (like reviewSource). */
  root?: string;
  branch: string;
  env?: NodeJS.ProcessEnv;
  /** Node binary to run the sidecar under (default: `node` on PATH). */
  nodeBin?: string;
}

interface ReviewLedgerWire extends Omit<ReviewLedgerV2, 'ledgerGeneration'> {
  ledger_generation: string;
  warnings?: ReviewArchiveWarning[];
}

const ARCHIVE_WARNING_CODES = new Set<string>([
  'REVIEW_ARCHIVE_SETUP_FAILED',
  'REVIEW_ARCHIVE_WRITE_FAILED',
]);

function parseArchiveWarnings(value: unknown): ReviewArchiveWarning[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (warning) =>
        warning === null ||
        typeof warning !== 'object' ||
        !ARCHIVE_WARNING_CODES.has(String((warning as { code?: unknown }).code)) ||
        typeof (warning as { message?: unknown }).message !== 'string'
    )
  ) {
    throw new Error('unexpected review archive warning shape');
  }
  return value as ReviewArchiveWarning[];
}

interface ParsedJournalResponse {
  ledger: ReviewLedgerV2;
  warnings?: ReviewArchiveWarning[];
}

/** Translate the persisted CLI vocabulary exactly once at the Watch boundary. */
export function parseJournalResponse(text: string): ParsedJournalResponse {
  const data = JSON.parse(text) as ReviewLedgerWire;
  if (
    data === null ||
    typeof data !== 'object' ||
    !Array.isArray(data.sections) ||
    !Array.isArray(data.findings) ||
    !Array.isArray(data.uncertainties) ||
    !Array.isArray(data.coverage) ||
    !Array.isArray(data.prompts) ||
    data.unassigned === null ||
    typeof data.unassigned !== 'object' ||
    data.lifecycle === null ||
    typeof data.lifecycle !== 'object' ||
    !Array.isArray(data.lifecycle.history) ||
    typeof data.ledger_generation !== 'string'
  ) {
    throw new Error('unexpected review ledger shape');
  }
  const warnings = parseArchiveWarnings(data.warnings);
  const { ledger_generation, ...ledger } = data;
  delete ledger.warnings;
  return {
    ledger: { ...ledger, ledgerGeneration: ledger_generation },
    ...(warnings !== undefined ? { warnings } : {}),
  };
}

export function parseLedger(text: string): ReviewLedgerV2 {
  return parseJournalResponse(text).ledger;
}

/**
 * Spawn the sidecar, pipe `stdinPayload` (when non-null) to its stdin, and
 * collect stdout incrementally. Nonzero exit rejects with the child's stderr
 * text (the sidecar's violations are written there); stdout past the cap
 * rejects loudly — the ledger must never be silently cut.
 */
interface JournalProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnJournalVerb(
  node: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stdinPayload: string | null
): Promise<JournalProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    child.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > JOURNAL_IO_CAP_BYTES) {
        child.kill();
        fail(
          new Error(
            `review journal: ledger output exceeded the ${
              JOURNAL_IO_CAP_BYTES / (1024 * 1024)
            }MB cap — refusing to truncate`
          )
        );
        return;
      }
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= JOURNAL_IO_CAP_BYTES) errChunks.push(chunk);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8').trim(),
      });
    });
    // A child that exits before draining stdin EPIPEs the write; the close
    // handler above reports the real failure (exit code + stderr), so the
    // stream error itself is swallowed rather than crashing the UI.
    child.stdin.on('error', () => {});
    if (stdinPayload !== null) child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

async function runJournalVerb(
  opts: JournalSourceOptions,
  addEvent: JournalEvent | readonly JournalEvent[] | null
): Promise<ReviewLedgerV2> {
  const sidecar = resolveSidecar();
  if (sidecar === null) {
    throw sidecarMissingError();
  }
  const root = await resolveRoot(opts.root);
  const env = { ...(opts.env ?? process.env) };
  env.ORCAOPS_ROOT = root;
  const node = opts.nodeBin ?? env.ORCAOPS_WATCH_NODE ?? 'node';
  const argv = [sidecar, 'review', 'journal', '--branch', opts.branch];
  // The event — or a batch, as a JSON ARRAY — travels over STDIN (`--input -`),
  // never argv: a rows manifest can exceed argv limits, and stdin has none.
  if (addEvent !== null) argv.push('--input', '-');
  const result = await spawnJournalVerb(
    node,
    argv,
    env,
    addEvent !== null ? JSON.stringify(addEvent) : null
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || `review journal exited with code ${result.code}`);
  }
  return parseLedger(result.stdout);
}

export type WatchJournalAppendRejectionCode = JournalAppendRejectionCode | 'TRANSPORT_ERROR';
export type JournalAppendResult =
  | { status: 'appended'; ledger: ReviewLedgerV2; warnings?: ReviewArchiveWarning[] }
  | {
      status: 'rejected';
      code: WatchJournalAppendRejectionCode;
      message: string;
      warnings?: ReviewArchiveWarning[];
    };

const REJECTION_CODES = new Set<string>(Object.values(JOURNAL_APPEND_REJECTION_CODE));

export function parseAppendRejection(text: string): JournalAppendRejection | null {
  try {
    const value = JSON.parse(text) as Partial<JournalAppendRejection>;
    if (
      value.ok !== false ||
      !REJECTION_CODES.has(String(value.code)) ||
      typeof value.message !== 'string'
    ) {
      return null;
    }
    const warnings = parseArchiveWarnings(value.warnings);
    return {
      ok: false,
      code: value.code as JournalAppendRejectionCode,
      message: value.message,
      ...(warnings !== undefined ? { warnings } : {}),
    };
  } catch {
    return null;
  }
}

async function runJournalAppend(
  opts: JournalSourceOptions,
  addEvent: JournalEvent | readonly JournalEvent[]
): Promise<JournalAppendResult> {
  try {
    const sidecar = resolveSidecar();
    if (sidecar === null) throw sidecarMissingError();
    const root = await resolveRoot(opts.root);
    const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), ORCAOPS_ROOT: root };
    const node = opts.nodeBin ?? env.ORCAOPS_WATCH_NODE ?? 'node';
    const result = await spawnJournalVerb(
      node,
      [sidecar, 'review', 'journal', '--branch', opts.branch, '--input', '-', '--json'],
      env,
      JSON.stringify(addEvent)
    );
    if (result.code === 0) {
      const response = parseJournalResponse(result.stdout);
      return { status: 'appended', ...response };
    }
    const rejection = parseAppendRejection(result.stderr);
    return rejection === null
      ? {
          status: 'rejected',
          code: 'TRANSPORT_ERROR',
          message: result.stderr || `review journal exited with code ${result.code}`,
        }
      : {
          status: 'rejected',
          code: rejection.code,
          message: rejection.message,
          ...(rejection.warnings !== undefined ? { warnings: rejection.warnings } : {}),
        };
  } catch (error) {
    return {
      status: 'rejected',
      code: 'TRANSPORT_ERROR',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Replay the branch's journal into its ledger (empty journal ⇒ empty ledger). */
export function loadLedger(opts: JournalSourceOptions): Promise<ReviewLedgerV2> {
  return runJournalVerb(opts, null);
}

/**
 * Validate + append one journal event (the sidecar enforces the schema
 * reason-gate) and return either the post-append ledger or a typed rejection.
 */
export function appendJournalEvent(
  opts: JournalSourceOptions,
  event: JournalEvent
): Promise<JournalAppendResult> {
  return runJournalAppend(opts, event);
}

/**
 * Validate + append a BATCH of journal events through ONE sidecar spawn (the
 * bulk-acknowledge path). The sidecar validates every event before appending
 * any — all-or-nothing under a single lock acquisition — and returns a typed
 * result.
 */
export function appendJournalEvents(
  opts: JournalSourceOptions,
  events: readonly JournalEvent[]
): Promise<JournalAppendResult> {
  return runJournalAppend(opts, events);
}
