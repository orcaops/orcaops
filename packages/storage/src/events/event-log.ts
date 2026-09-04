import { createHash } from 'node:crypto';
import { readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { canonicalJson } from './canonical-json.js';
import {
  appendDurable,
  appendUnflushed,
  flushDurableAppend,
  fsyncDir,
  mkdirDurable,
  writeDurable,
} from '../fs/durable.js';
import { isUuidV7, uuidv7, UuidV7Schema } from '../ids/uuidv7.js';
import { assertResolvedWithin } from '../paths/containment.js';

/**
 * Append-only event log per artifact.
 *
 * Layout (relative to the artifact dir):
 *   - `events.ndjson` — one event record per line; tail is the live log.
 *   - `sidecars/<event_id>.json` — oversized payloads referenced by
 *     event records whose payload exceeds the inline budget.
 *
 * On-disk record shape:
 * ```
 *   { event_id, type, ts, schema_version, idempotency_key,
 *     payload? OR (sidecar_sha256 + sidecar_size),
 *     checksum }
 * ```
 *
 * Per-line SHA-256 checksum is computed over the canonical JSON of the
 * record minus the `checksum` field. Tampering with any other field
 * (including `sidecar_sha256` / `sidecar_size`) breaks the checksum;
 * tampering with the sidecar without modifying the event line means
 * the recomputed sidecar SHA-256 won't match the embedded one.
 *
 * This module exposes the IO primitive only.
 */

/** Event types written by the capture lifecycle. */
export const EventTypeSchema = z.enum([
  'plan_captured',
  /**
   * Plan revision: full-supersede payload that replaces the latest
   * plan. Event payload carries the complete new `plan_steps`
   * (each with stable UUIDv7 step_id), the server-computed
   * `step_lineage` diff, the agent's `rationale`, the
   * `prior_plan_event_id` token, and the new `revision_n`. Latest
   * `plan_captured | plan_revised` event wins in the projection.
   */
  'plan_revised',
  /**
   * Two-phase checkpoint lifecycle.
   * `checkpoint_opened` declares which plan step_ids a cp will cover;
   * `checkpoint_closed` finalizes the open at `n`;
   * `checkpoint_abandoned` cancels the open at `n` without claiming any
   * work, releasing its declared step_ids.
   *
   * There is no legacy ordinal-step-number reader.
   */
  'checkpoint_opened',
  'checkpoint_closed',
  'checkpoint_abandoned',
  /**
   * The persisted shape carries `run_status`,
   * `verdict`, and `error` as distinct fields; dispositions are NOT
   * folded into this payload. Payload schema:
   * `EvaluatorRunPayloadSchema` (re-exported from
   * `@orcaops/evaluator-protocol`).
   */
  'evaluator_run_recorded',
  /**
   * A separate event keyed to a specific
   * `run_id`, recording the human/agent disposition
   * (acknowledged | dismissed | policy-excepted). Materialized
   * back onto the targeted run by the projection rebuilder.
   * Payload schema: `EvaluatorDispositionPayloadSchema`
   * (re-exported from `@orcaops/evaluator-protocol`).
   */
  'evaluator_disposition_recorded',
  'pre_pr_checked',
  'block_acknowledged',
  'block_dismissed',
  'summary_captured',
  'git_import_enriched',
  /**
   * Branch lineage append: emitted by `orcaops lineage` after rebase /
   * merge / squash. Payload is a single `BranchLineageEntry`
   * ({ branch, head_sha, ts, event: 'rebased' | 'merged' }) appended
   * to artifact.json.branch_lineage. The initial 'created' entry is
   * seeded by `plan_captured`, not by this event type.
   */
  'branch_lineage_updated',
  /**
   * Pin lifecycle event. Logged on the **previously-pinned**
   * artifact when a pin is overwritten while that artifact is still
   * `active` or `blocked`. The `summarized` overwrite case is silent
   * (no event). Payload shape:
   *   { displaced_by_artifact_id: string,
   *     shell_key: ShellKey,
   *     reason?: 'auto-on-capture-plan' | 'explicit-checkout' }
   * Doctor surfaces these on still-active artifacts ("was A
   * abandoned?"); search indexing folds in their reasons.
   */
  'pin_displaced',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Inline event record (payload stored directly in the line). Most
 * captures are this shape; only oversized payloads (>8KB canonical
 * JSON) cross over into the sidecar variant.
 *
 * `.strict()` is load-bearing: it rejects records carrying sidecar
 * fields, so the `EventRecordSchema` union picks the correct variant.
 * Without strict, a sidecar record would parse as Inline (with sidecar
 * fields stripped), and the checksum recompute would silently fail
 * because it would be missing the sidecar fields the writer included.
 */
export const InlineEventRecordSchema = z
  .object({
    event_id: UuidV7Schema,
    type: EventTypeSchema,
    ts: z.string().datetime(),
    schema_version: z.literal(1),
    idempotency_key: z.string().min(1),
    payload: z.unknown(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/**
 * Sidecar event record. Payload lives at `sidecars/<event_id>.json`;
 * the line carries the hash + size of that file so on-read corruption
 * detection works against either tampering vector.
 *
 * `.strict()` per the same rationale as `InlineEventRecordSchema`.
 */
export const SidecarEventRecordSchema = z
  .object({
    event_id: UuidV7Schema,
    type: EventTypeSchema,
    ts: z.string().datetime(),
    schema_version: z.literal(1),
    idempotency_key: z.string().min(1),
    sidecar_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sidecar_size: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const EventRecordSchema = z.union([InlineEventRecordSchema, SidecarEventRecordSchema]);
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type InlineEventRecord = z.infer<typeof InlineEventRecordSchema>;
export type SidecarEventRecord = z.infer<typeof SidecarEventRecordSchema>;

/**
 * Canonical JSON byte-budget for inline payloads. Above this, the
 * payload spills to a sidecar file. 8 KB matches the architecture spec.
 */
export const INLINE_PAYLOAD_BUDGET_BYTES = 8 * 1024;

export interface AppendEventInput {
  type: EventType;
  /** ISO timestamp; caller controls (lets tests pin exact values). */
  ts: string;
  idempotency_key: string;
  /**
   * Arbitrary JSON-shaped payload. Persisted inline iff its canonical
   * JSON byte length is <= `INLINE_PAYLOAD_BUDGET_BYTES`; otherwise
   * spilled to `<sidecarsDir>/<event_id>.json`.
   */
  payload: unknown;
  /**
   * Optional event_id override. Defaults to a freshly-minted UUIDv7.
   * Exposed for deterministic test fixtures; production callers should
   * never set this.
   */
  event_id?: string;
}

export interface AppendEventOptions {
  /** Path to the artifact's `events.ndjson`. */
  eventLogPath: string;
  /**
   * Path to the artifact's `sidecars/` directory. Created lazily on
   * first sidecar write.
   */
  sidecarsDir: string;
  /**
   * Directory tree this caller OWNS, if any. When given, every level from it
   * down to the artifact directory is narrowed to 0700 — which is how a
   * pre-existing permissive artifacts root gets tightened when a new artifact
   * is created under it. Omitted (tests, direct consumers writing into their
   * own scratch directory), only the directory being created is touched: this
   * function must never infer authority over whatever sits above a path it
   * was handed.
   */
  ownedRoot?: string;
  /** Repository root that must contain every hot-artifact filesystem operation. */
  containmentRoot?: string;
  /** Store-owned artifact batch; its outer seam flushes before acknowledging success. */
  deferSync?: boolean;
}

/**
 * Append a single event record to the log, spilling oversized payloads
 * to a sidecar first. Returns the on-disk record (with checksum).
 *
 * **Concurrency:** this writer is NOT lock-managed internally — it
 * presumes the caller holds the per-artifact `ArtifactLock`. The
 * architecture mandates lock-around-write to prevent torn appends.
 *
 * **Durability contract — ACKNOWLEDGED (file bytes), BEST-EFFORT (directory
 * entries).** Returning from this function is
 * an acknowledgement: the CLI reports the checkpoint closed or the plan
 * captured, and every projection is rebuilt from this log, so a lost tail is
 * recoverable from nowhere and the reader treats a truncated final line as
 * corruption. The line is therefore fsynced before return, and a sidecar
 * lands via `temp → fsync → rename → fsync(dir)` BEFORE the event line that
 * references it, so a crash in between leaves an orphan sidecar
 * (GC-cleanable) rather than an event referencing a half-written one. The
 * ordering is not an absolute guarantee: the sidecar's DIRECTORY sync is
 * best-effort (see fsyncDir), so on a filesystem that refuses it a crash can
 * preserve the fsynced event line while losing the sidecar's directory
 * entry. The sidecar's own bytes are always fsynced before the rename. (The
 * pre-D3 version of this comment claimed the fsync that had never been
 * written.) The one thing NOT promised unconditionally: directory fsync is
 * advisory — some filesystems refuse it and there is no portable fallback —
 * so a brand-new log's containing directory may be less durable than the
 * bytes inside it.
 */
export async function appendEvent(
  input: AppendEventInput,
  opts: AppendEventOptions
): Promise<EventRecord> {
  // Write-side backstop for the keyless-event footgun: the read schemas
  // require `idempotency_key: z.string().min(1)`, so a missing/empty key
  // is silently dropped on read — surfacing three layers away as a
  // confusing "no <type> event" rebuilder invariant. Reject it here,
  // loud and early, mirroring the read-side min(1) exactly so the
  // write-guard and read-guard stay symmetric. The auto-mint writers
  // resolve `opts.idempotencyKey ?? uuidv7()` before reaching this; the
  // required writers (revisePlan, checkpoints) must pass a real key.
  if (typeof input.idempotency_key !== 'string' || input.idempotency_key.length === 0) {
    throw new Error(
      `appendEvent: refusing to write a "${input.type}" event with a missing or empty ` +
        `idempotency_key. Every event must carry a non-empty key — keyless events are ` +
        `silently dropped by the strict read-schema and resurface as a confusing ` +
        `"no <type> event" invariant. Auto-mint writers should resolve ` +
        `opts.idempotencyKey ?? uuidv7() before appending.`
    );
  }
  if (input.event_id !== undefined && !isUuidV7(input.event_id)) {
    // The ID becomes a sidecar/mirror path segment; refuse a non-UUIDv7
    // override at the write ingress rather than persisting a traversal.
    throw new Error(
      `appendEvent: event_id override "${input.event_id}" is not a canonical UUIDv7.`
    );
  }
  const eventId = input.event_id ?? uuidv7();
  const payloadJson = canonicalJson(input.payload);
  const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');

  const useSidecar = payloadBytes > INLINE_PAYLOAD_BUDGET_BYTES;

  let record: EventRecord;
  if (useSidecar) {
    const { sha256, size } = await writeSidecar(
      eventId,
      payloadJson,
      opts.sidecarsDir,
      opts.ownedRoot,
      opts.containmentRoot
    );
    const base = {
      event_id: eventId,
      type: input.type,
      ts: input.ts,
      schema_version: 1 as const,
      idempotency_key: input.idempotency_key,
      sidecar_sha256: sha256,
      sidecar_size: size,
    };
    record = { ...base, checksum: computeChecksum(base) };
  } else {
    const base = {
      event_id: eventId,
      type: input.type,
      ts: input.ts,
      schema_version: 1 as const,
      idempotency_key: input.idempotency_key,
      payload: input.payload,
    };
    record = { ...base, checksum: computeChecksum(base) };
  }

  // Only the directory we are creating. The ancestor is deliberately NOT
  // inferred from the path: `dirname(dirname(eventLogPath))` is the artifacts
  // root in production but the OS temp directory for a caller that puts a log
  // in an mkdtemp, and tightening (or refusing) something like /tmp is an
  // authority this function must never take. Ancestor tightening is granted
  // explicitly by whoever owns the root — see ArtifactStore.
  await mkdirDurable(path.dirname(opts.eventLogPath), 0o700, opts.ownedRoot, opts.containmentRoot);
  // Whole record per line — `JSON.stringify` is fine here (object key
  // order doesn't matter for the on-disk line; readers re-canonicalize
  // before recomputing the checksum).
  //
  // fsynced because this append is ACKNOWLEDGED: once it returns, the CLI
  // tells the agent the checkpoint closed or the plan was captured, and
  // every projection is rebuilt FROM this log. A lost tail is not
  // reconstructible from anywhere else, and the reader treats a truncated
  // final line as corruption.
  const line = JSON.stringify(record) + '\n';
  if (opts.deferSync) await appendUnflushed(opts.eventLogPath, line, opts.containmentRoot);
  else await appendDurable(opts.eventLogPath, line, opts.containmentRoot);
  return record;
}

/** Complete the durability acknowledgement for a store-owned event batch. */
export function flushEventLog(eventLogPath: string, containmentRoot?: string): Promise<void> {
  return flushDurableAppend(eventLogPath, containmentRoot);
}

export interface CorruptEntry {
  /** 1-based line number in `events.ndjson` (matches editor jumps). */
  line: number;
  /** Raw line content as read from disk; useful for the doctor surface. */
  raw: string;
  /**
   * Which check failed. Drives recovery's loss accounting: a
   * `truncated_tail` was never acknowledged (crash mid-write), so it is
   * "never written" rather than lost data; every other kind is an
   * acknowledged event whose content is gone.
   */
  kind:
    | 'truncated_tail'
    | 'invalid_json'
    | 'schema_mismatch'
    | 'checksum_mismatch'
    | 'duplicate_id'
    | 'sidecar_corrupt';
  /** Single-sentence reason why the entry was rejected. */
  reason: string;
  /** When the entry parsed but its referenced sidecar was the source of corruption. */
  event_id?: string;
  /**
   * The fully validated inline record, present ONLY when the sidecar was
   * the sole source of corruption — schema and checksum both passed, so
   * the header (type, ts) is trustworthy even though the payload is gone.
   * Consumers that only need the header (e.g. lifecycle derivation) can
   * use it instead of re-proving the line themselves.
   */
  record?: EventRecord;
}

export interface ReadEventLogResult {
  /** Records that passed checksum + sidecar-integrity checks, in log order. */
  events: EventRecord[];
  /** Lines that failed any check; preserved so doctor can surface them. */
  corrupt: CorruptEntry[];
  /**
   * 1-based line number per surviving event id. Recovery orders
   * survivors against corrupt lines with this to decide whether a
   * served snapshot is complete.
   */
  lineByEventId: Map<string, number>;
}

export interface ReadEventLogOptions {
  eventLogPath: string;
  sidecarsDir: string;
  containmentRoot?: string;
}

/**
 * Read + validate every line in the event log.
 *
 * Per the architecture's recovery rules:
 *   - Missing log file → empty result, no corruption.
 *   - Trailing partial line (truncated tail from a crash mid-write) →
 *     last entry treated as never written (recorded as corrupt for
 *     diagnostics).
 *   - Per-line checksum mismatch → entry treated as corrupt. The
 *     recovery layer refuses the whole artifact on any non-tail
 *     corruption (artifact-level contract); this reader only flags
 *     individual lines.
 *   - Sidecar referenced by event but missing on disk → corrupt.
 *   - Sidecar SHA-256 or size mismatch → corrupt.
 */
export async function readEventLog(opts: ReadEventLogOptions): Promise<ReadEventLogResult> {
  const eventLogPath =
    opts.containmentRoot === undefined
      ? opts.eventLogPath
      : assertResolvedWithin(opts.eventLogPath, opts.containmentRoot, 'event log read', {
          rejectSymlinks: true,
        });
  let raw: string;
  try {
    raw = await readFile(eventLogPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], corrupt: [], lineByEventId: new Map() };
    }
    throw err;
  }

  const events: EventRecord[] = [];
  const corrupt: CorruptEntry[] = [];
  const lineByEventId = new Map<string, number>();
  // Every checksum-parseable id ever seen — survivors AND corrupt lines —
  // so a reuse of a corrupt first occurrence is still flagged. Distinct
  // from lineByEventId, which positions only survivors.
  const firstSeenLineById = new Map<string, number>();

  // Splitting on '\n' with a final newline produces an empty trailing
  // element — that's the well-formed case. A non-empty trailing element
  // means the last line was not terminated (truncated tail).
  const parts = raw.split('\n');
  const lastIsEmpty = parts.length > 0 && parts[parts.length - 1] === '';
  const lineCount = parts.length - (lastIsEmpty ? 1 : 0);

  for (let i = 0; i < lineCount; i++) {
    const lineNo = i + 1;
    const text = parts[i];
    const isLastLine = i === lineCount - 1;

    // ANY non-newline-terminated final line is crash residue — even one
    // that parses and checksums clean. The append fsyncs record+newline
    // as one write, so a missing terminator proves the ack never fired;
    // folding the record would serve never-acknowledged state as real.
    if (isLastLine && !lastIsEmpty) {
      corrupt.push({
        line: lineNo,
        raw: text,
        kind: 'truncated_tail',
        reason:
          'truncated tail: last line is not newline-terminated (crash mid-write; ' +
          'never acknowledged)',
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      corrupt.push({
        line: lineNo,
        raw: text,
        kind: 'invalid_json',
        reason: 'line is not valid JSON',
      });
      continue;
    }

    // A checksum proves a line is well-formed, not unique: anyone can
    // recompute one over altered content that reuses an existing id. Two
    // lines claiming the same identity are an unresolvable conflict —
    // report the later one, never fold it (folding it would silently
    // roll projections back to whatever it carries). Reservation happens
    // IMMEDIATELY after JSON parsing so even a schema-invalid first
    // occurrence blocks a later reuse of its id.
    const claimedId = (parsed as { event_id?: unknown } | null)?.event_id;
    const bestEffortId =
      typeof claimedId === 'string' && claimedId.length > 0 ? claimedId : undefined;
    if (bestEffortId !== undefined) {
      if (firstSeenLineById.has(bestEffortId)) {
        corrupt.push({
          line: lineNo,
          raw: text,
          kind: 'duplicate_id',
          reason: `event_id ${bestEffortId} already appeared at line ${String(firstSeenLineById.get(bestEffortId))} — duplicate identity is integrity corruption`,
          event_id: bestEffortId,
        });
        continue;
      }
      firstSeenLineById.set(bestEffortId, lineNo);
    }

    const validated = EventRecordSchema.safeParse(parsed);
    if (!validated.success) {
      corrupt.push({
        line: lineNo,
        raw: text,
        kind: 'schema_mismatch',
        reason: `event record fails schema: ${validated.error.issues[0]?.message ?? 'unknown'}`,
        ...(bestEffortId !== undefined ? { event_id: bestEffortId } : {}),
      });
      continue;
    }

    const record = validated.data;

    const recomputed = computeChecksum(stripChecksum(record));
    if (recomputed !== record.checksum) {
      corrupt.push({
        line: lineNo,
        raw: text,
        kind: 'checksum_mismatch',
        reason: 'checksum mismatch (event record was tampered with or the line is corrupt)',
        event_id: record.event_id,
      });
      continue;
    }

    if ('sidecar_sha256' in record) {
      const sidecarPath = path.join(opts.sidecarsDir, `${record.event_id}.json`);
      const sidecarCheck = await verifySidecar(
        sidecarPath,
        record.sidecar_sha256,
        record.sidecar_size,
        opts.containmentRoot
      );
      if (!sidecarCheck.ok) {
        corrupt.push({
          line: lineNo,
          raw: text,
          kind: 'sidecar_corrupt',
          reason: sidecarCheck.reason,
          event_id: record.event_id,
          record,
        });
        continue;
      }
    }

    events.push(record);
    lineByEventId.set(record.event_id, lineNo);
  }

  return { events, corrupt, lineByEventId };
}

/**
 * Read the inline payload OR the sidecar payload for an event. Sidecar
 * reads return the parsed JSON; the caller is responsible for any
 * downstream Zod validation against the event's `type`.
 *
 * Throws if a sidecar event references a missing or corrupt sidecar.
 * Production callers should normally have the event vetted by
 * `readEventLog` first; this helper is the building block for both
 * `readEventLog` (for inline) and recovery-from-events (which needs the
 * actual payload, not just integrity).
 */
export async function loadEventPayload(
  record: EventRecord,
  opts: { sidecarsDir: string; containmentRoot?: string }
): Promise<unknown> {
  if ('payload' in record) return record.payload;
  const declaredSidecarPath = path.join(opts.sidecarsDir, `${record.event_id}.json`);
  const sidecarPath =
    opts.containmentRoot === undefined
      ? declaredSidecarPath
      : assertResolvedWithin(declaredSidecarPath, opts.containmentRoot, 'event sidecar read', {
          rejectSymlinks: true,
        });
  const raw = await readFile(sidecarPath, 'utf8');
  return JSON.parse(raw);
}

// ── internals ────────────────────────────────────────────────────────

function computeChecksum(recordWithoutChecksum: Record<string, unknown>): string {
  const canonical = canonicalJson(recordWithoutChecksum);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function stripChecksum(record: EventRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy.checksum;
  return copy;
}

async function writeSidecar(
  eventId: string,
  canonicalPayloadJson: string,
  sidecarsDir: string,
  ownedRoot?: string,
  containmentRoot?: string
): Promise<{ sha256: string; size: number }> {
  await mkdirDurable(sidecarsDir, 0o700, ownedRoot, containmentRoot);
  const declaredFinalPath = path.join(sidecarsDir, `${eventId}.json`);
  const resolveSidecarPath = (target: string, label: string): string =>
    containmentRoot === undefined
      ? target
      : assertResolvedWithin(target, containmentRoot, label, { rejectSymlinks: true });
  let finalPath = resolveSidecarPath(declaredFinalPath, 'event sidecar write');
  // Sibling temp + rename: rename is POSIX-atomic on the same filesystem.
  // A crash here leaves either nothing (rename never started) or a fully
  // written final file, never a partial visible at finalPath. The bytes are
  // fsynced BEFORE the rename because the ordering guarantee (sidecar
  // durable before its log line) is worthless if the sidecar's contents are
  // still only in page cache when the line lands.
  let tempPath = resolveSidecarPath(
    `${finalPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    'event sidecar temporary file'
  );
  const buf = Buffer.from(canonicalPayloadJson, 'utf8');
  await writeDurable(tempPath, buf, 0o600, containmentRoot);
  tempPath = resolveSidecarPath(tempPath, 'event sidecar temporary file');
  finalPath = resolveSidecarPath(declaredFinalPath, 'event sidecar write');
  await rename(tempPath, finalPath);
  await fsyncDir(sidecarsDir, containmentRoot);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { sha256, size: buf.byteLength };
}

async function verifySidecar(
  sidecarPath: string,
  expectedSha: string,
  expectedSize: number,
  containmentRoot?: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const target =
    containmentRoot === undefined
      ? sidecarPath
      : assertResolvedWithin(sidecarPath, containmentRoot, 'event sidecar verification', {
          rejectSymlinks: true,
        });
  let stats;
  try {
    stats = await stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        reason: `event references sidecar ${path.basename(target)} but the file is missing`,
      };
    }
    throw err;
  }
  if (stats.size !== expectedSize) {
    return {
      ok: false,
      reason: `sidecar size ${stats.size} does not match event's sidecar_size ${expectedSize}`,
    };
  }
  const buf = await readFile(target);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== expectedSha) {
    return { ok: false, reason: "sidecar SHA-256 does not match event's sidecar_sha256" };
  }
  return { ok: true };
}
