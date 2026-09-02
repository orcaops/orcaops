import { ZodError } from 'zod';

import { scrubAndBound, scrubError } from '@orcaops/core';
import {
  stringifyTerminalSafeJson,
  stripTerminalFormatting,
} from '@orcaops/evaluator-protocol/terminal';
import { CliAuthError } from '@orcaops/sdk';
import { ArtifactLockLeaseLostError } from '@orcaops/storage';

import { ErrorCodes, type ErrorEnvelope, OrcaopsError } from './errors.js';
import { CliExit } from './exit.js';
import { formatZodIssues, zodIssueHint } from '../lib/zod-issues.js';

/**
 * Disclose a confirmed lease loss that rode along as the cause of a failed
 * operation. STDERR ONLY: the JSON error envelope is a frozen launch
 * contract, so it gains no field and a `--json` consumer's parse stays
 * byte-clean. Both error exits call this, so the disclosure does not depend
 * on which output mode the command used.
 */
function discloseLeaseLossCause(err: unknown): void {
  const cause = err instanceof Error ? err.cause : undefined;
  if (!(cause instanceof ArtifactLockLeaseLostError)) return;
  process.stderr.write(
    stripTerminalFormatting(
      `note: ${cause.message} The operation above failed in the same window, so another ` +
        `process may have run concurrently — re-check the result before retrying.\n`
    )
  );
}

/**
 * Emit a JSON success envelope to stdout (newline-terminated).
 * Always includes `ok: true`.
 */
export function emitOk(data: object): void {
  process.stdout.write(stringifyTerminalSafeJson({ ok: true, ...data }) + '\n');
}

/**
 * Emit a JSON error envelope to stdout, then throw CliExit to request the
 * non-zero exit (default 1; `exitCode` for codes that scripts branch on, e.g.
 * `plan review approve --wait`'s timeout exits 2). Synchronous write before
 * throw preserves flush ordering — the top-level handler converts the throw
 * into the actual `process.exit`.
 */
export function emitError(err: unknown, opts?: { exitCode?: number }): never {
  const envelope = toErrorEnvelope(err);
  process.stdout.write(stringifyTerminalSafeJson(envelope) + '\n');
  discloseLeaseLossCause(err);
  throw new CliExit(opts?.exitCode ?? 1);
}

/**
 * Write a scrubbed `Error: <message>` line to stderr — the human-mode
 * counterpart of `emitError`.
 *
 * Human mode used to interpolate `err.message` straight into stderr while
 * only the JSON envelope went through the scrubber, so the SAME error leaked
 * a token in the default output mode and not in `--json`. Both modes now
 * leave through `toErrorEnvelope`, which is the single scrubbing exit.
 */
export function writeErrorLine(err: unknown): void {
  process.stderr.write(stripTerminalFormatting(`Error: ${toErrorEnvelope(err).error.message}\n`));
  discloseLeaseLossCause(err);
}

/**
 * Scrub-at-exit for prose that interpolates raw error text — an fs or parse
 * failure message can echo file content (Node 20+ SyntaxError excerpts).
 * Same bound as doctor's check sanitizer.
 */
export function scrubOutboundText(text: string): string {
  return scrubAndBound(text, 8192);
}

export function writeTerminalSafeStdout(text: string): void {
  process.stdout.write(stripTerminalFormatting(text));
}

export function writeTerminalSafeStderr(text: string): void {
  process.stderr.write(stripTerminalFormatting(text));
}

/** Preserve pipe payloads byte-for-byte, but neutralize controls on an interactive terminal. */
export function writePipeFriendlyStdout(value: string | Uint8Array): void {
  if (!process.stdout.isTTY) {
    process.stdout.write(value);
    return;
  }
  const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
  process.stdout.write(stripTerminalFormatting(text));
}

/**
 * Bound for AUTHORED messages. Far larger than the 200 the cloud scrubber
 * uses, because these are audited strings carrying deliberate guidance — the
 * candidate list in AMBIGUOUS_ARTIFACT — and cutting those to 200 would destroy the diagnostic
 * without protecting anything. Still bounded, so no error path can emit an
 * unbounded payload.
 */
const AUTHORED_MAX_LEN = 4096;

/** Caps on structured error detail, so no envelope is unbounded. */
const MAX_DETAIL_ITEMS = 50;
const MAX_DETAIL_DEPTH = 6;

/**
 * Every envelope leaves through here, and every envelope is scrubbed here.
 *
 * Doing it per-branch was the bug: the authored branches (OrcaopsError and
 * friends) emitted `err.message` untouched, and `toCloudErrorEnvelope` wraps
 * ANY unknown error — a wire error, a fetch failure, an upstream body echo —
 * into an OrcaopsError, which moved it out of the scrubbed branch and into
 * an unscrubbed one. Scrubbing at the single exit closes that without
 * needing every call site audited, and keeps closing it as new wrappers are
 * added.
 */
export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  const envelope = buildErrorEnvelope(err);
  const dropped: string[] = [];
  // The WHOLE error object, not just `message`. Structured extras carry
  // user-authored content too — AMBIGUOUS_ARTIFACT's `candidates` embed each
  // artifact's `label` and `task`, so a secret planted in a plan survives
  // there even when the prose beside it is clean. They are also unbounded,
  // which is why the scrub bounds their length as well as redacting them.
  const error = scrubErrorDetail(
    envelope.error,
    AUTHORED_MAX_LEN,
    0,
    dropped
  ) as ErrorEnvelope['error'];
  if (envelope.error.message.trim().length > 0 && error.message.trim().length === 0) {
    error.message = '[diagnostic removed]';
  }
  if (dropped.length > 0) {
    // Disclosed in the MESSAGE, never by pushing a marker into the array.
    // `candidates` is typed `ArtifactCandidate[]`, so an appended string
    // hands a machine consumer an element with no `id` — a contract break
    // dressed up as a courtesy.
    error.message = scrubAndBound(`${error.message} (${dropped.join('; ')})`, AUTHORED_MAX_LEN);
  }
  return { ...envelope, error };
}

/**
 * Scrub and bound every string reachable in an error payload, preserving
 * shape EXACTLY — the scrubbed value must stay assignable to the declared
 * envelope type. Arrays are capped so a large candidate list cannot emit an
 * unbounded envelope; what was dropped is pushed onto `dropped` for the
 * caller to disclose, because the one place it must not go is into the array
 * itself.
 */
function scrubErrorDetail(
  value: unknown,
  maxLen: number,
  depth = 0,
  dropped: string[] = [],
  key = 'detail'
): unknown {
  if (typeof value === 'string') return scrubAndBound(value, maxLen);
  if (depth >= MAX_DETAIL_DEPTH) return '[omitted: too deeply nested]';
  if (Array.isArray(value)) {
    if (value.length > MAX_DETAIL_ITEMS) {
      dropped.push(`${value.length - MAX_DETAIL_ITEMS} of ${value.length} ${key} omitted`);
    }
    return value
      .slice(0, MAX_DETAIL_ITEMS)
      .map((v) => scrubErrorDetail(v, maxLen, depth + 1, dropped, key));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        scrubErrorDetail(v, maxLen, depth + 1, dropped, k),
      ])
    );
  }
  return value;
}

function buildErrorEnvelope(err: unknown): ErrorEnvelope {
  if (err instanceof CliAuthError) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        actionable: err.actionable,
      },
    };
  }
  if (err instanceof OrcaopsError) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.inputPath !== undefined ? { path: err.inputPath } : {}),
        ...(err.details ?? {}),
      },
    };
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = first?.path?.length ? first.path.join('.') : undefined;
    // The message keeps the bare first-issue text when there is only one, so
    // the common single-mistake envelope reads exactly as it always has. Two
    // or more report all of them: a caller re-running after each fix pays one
    // round trip per mistake.
    const message =
      first === undefined
        ? 'Invalid input'
        : err.issues.length === 1
          ? `${first.message}${zodIssueHint(first)}`
          : formatZodIssues(err.issues);
    return {
      ok: false,
      error: {
        code: ErrorCodes.INVALID_INPUT,
        message,
        ...(path !== undefined ? { path } : {}),
      },
    };
  }
  if (err instanceof Error) {
    return {
      ok: false,
      error: {
        code: ErrorCodes.INTERNAL,
        // scrubError strips bearer tokens, JWT triples, query params, and
        // Authorization-header content from the message. CliAuthError and
        // OrcaopsError have authored, audited messages; the unknown-Error
        // branch can reach raw SDK / fetch errors whose .message may
        // reflect an upstream response body that named the offending
        // token. Scrub before the message ever lands in stdout JSON.
        message: scrubError(err.message),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: ErrorCodes.INTERNAL,
      message: scrubError(String(err)),
    },
  };
}
