import { createHash } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';

import {
  type AppendUsageRecordInput,
  computeUsageRecordChecksum,
  deriveUsageLedgerRecord,
  loadUsageRecordPayload,
} from './record.js';
import { canonicalJson } from '../events/canonical-json.js';
import { appendDurable, fsyncDir, mkdirDurable, writeDurable } from '../fs/durable.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { assertResolvedWithin } from '../paths/containment.js';
import {
  AgentUsageSnapshotPayloadSchema,
  SourcePlanLinkPayloadSchema,
  type UsageLedgerEventType,
  type UsageLedgerRecord,
  UsageLedgerRecordSchema,
} from '../schema/usage-ledger.js';

export type { AppendUsageRecordInput } from './record.js';

/**
 * Low-level append/read for the repo-level usage ledger ndjson.
 *
 * Deliberately a sibling of `events/event-log.ts` rather than a reuse of it:
 * the ledger has its own event types (which the artifact log's strict read
 * schema would reject) and its own on-disk location. The integrity mechanics
 * — canonical-JSON payloads, 8 KB inline budget with sidecar spill, per-line
 * sha256 checksum, crash-safe sidecar temp→fsync→rename — mirror the event
 * log exactly, including its ACKNOWLEDGED durability contract: appends are
 * fsynced because this ndjson is the source of truth and the SQLite usage
 * projection is rebuilt FROM it (the "rebuildable" note elsewhere in this
 * module refers to that projection, never to this log). As there, the file
 * bytes are fsynced and the directory entry is best-effort.
 *
 * Concurrency: NOT lock-managed internally — the caller (`UsageLedger`) holds
 * the repo-level lock around read-baseline + append + project.
 */

export interface UsageLedgerPaths {
  ledgerPath: string;
  sidecarsDir: string;
  containmentRoot?: string;
  /** Called once for each non-empty record skipped as invalid or unreadable. */
  onInvalidRecord?: () => void;
  /** Called after checksum, sidecar, and payload validation. */
  onValidRecord?: (record: UsageLedgerRecord, payload: unknown) => void;
}

/** A ledger record paired with its loaded (inline or sidecar) payload. */
export interface LoadedUsageEvent {
  event_id: string;
  type: UsageLedgerEventType;
  ts: string;
  idempotency_key: string;
  payload: unknown;
}

export async function appendUsageLedgerRecord(
  input: AppendUsageRecordInput,
  opts: UsageLedgerPaths
): Promise<UsageLedgerRecord> {
  const prepared = deriveUsageLedgerRecord(input);
  const record = prepared.record;
  if (prepared.sidecarJson !== null) {
    await writeSidecar(
      record.event_id,
      prepared.sidecarJson,
      opts.sidecarsDir,
      opts.containmentRoot
    );
  }

  await mkdirDurable(path.dirname(opts.ledgerPath), 0o700, undefined, opts.containmentRoot);
  // Acknowledged append: the ledger is the source of truth for usage, and
  // the SQLite projection is rebuilt from it, so a lost tail is a real loss
  // rather than a cache miss.
  await appendDurable(opts.ledgerPath, JSON.stringify(record) + '\n', opts.containmentRoot);
  return record;
}

/**
 * Read every valid ledger event, in append order, with payloads loaded.
 * Corrupt / unparseable lines are skipped (the ledger is rebuildable and a
 * single bad line must not abort a rebuild).
 */
export async function readUsageLedger(opts: UsageLedgerPaths): Promise<LoadedUsageEvent[]> {
  const ledgerPath =
    opts.containmentRoot === undefined
      ? opts.ledgerPath
      : assertResolvedWithin(opts.ledgerPath, opts.containmentRoot, 'usage ledger read', {
          rejectSymlinks: true,
        });
  let raw: string;
  try {
    raw = await readFile(ledgerPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: LoadedUsageEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      opts.onInvalidRecord?.();
      continue;
    }
    const validated = UsageLedgerRecordSchema.safeParse(parsed);
    if (!validated.success) {
      opts.onInvalidRecord?.();
      continue;
    }
    const record = validated.data;
    if (computeUsageRecordChecksum(stripChecksum(record)) !== record.checksum) {
      opts.onInvalidRecord?.();
      continue;
    }

    const loaded = await loadUsageRecordPayload(record, opts.sidecarsDir, opts.containmentRoot);
    if (!loaded.ok) {
      opts.onInvalidRecord?.();
      continue;
    }
    const payload = loaded.payload;
    if (!isValidUsagePayload(record.type, record.idempotency_key, payload)) {
      opts.onInvalidRecord?.();
      continue;
    }
    opts.onValidRecord?.(record, payload);
    out.push({
      event_id: record.event_id,
      type: record.type,
      ts: record.ts,
      idempotency_key: record.idempotency_key,
      payload,
    });
  }
  return out;
}

/**
 * The canonical per-line integrity check `readUsageLedger` applies. Exported
 * so every OTHER usage-record reader (archive lag calculation, mirror
 * repair) applies the SAME validation — a schema-valid record with a bad
 * checksum must never participate in repair or be copied anywhere.
 */
export function verifyUsageRecordChecksum(record: UsageLedgerRecord): boolean {
  return computeUsageRecordChecksum(stripChecksum(record)) === record.checksum;
}

/** Stable identity for the validated envelope and canonical payload content. */
export function usageRecordContentIdentity(
  record: Pick<UsageLedgerRecord, 'event_id' | 'type' | 'ts' | 'idempotency_key'>,
  payload: unknown
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        event_id: record.event_id,
        type: record.type,
        ts: record.ts,
        idempotency_key: record.idempotency_key,
        payload,
      }),
      'utf8'
    )
    .digest('hex');
}

// ── internals (mirror events/event-log.ts) ───────────────────────────────

function isValidUsagePayload(
  type: UsageLedgerEventType,
  idempotencyKey: string,
  payload: unknown
): boolean {
  if (type === 'source_plan_linked') return SourcePlanLinkPayloadSchema.safeParse(payload).success;
  const parsed = AgentUsageSnapshotPayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.idempotency_key === idempotencyKey;
}

function stripChecksum(record: UsageLedgerRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy.checksum;
  return copy;
}

async function writeSidecar(
  eventId: string,
  canonicalPayloadJson: string,
  sidecarsDir: string,
  containmentRoot?: string
): Promise<void> {
  await mkdirDurable(sidecarsDir, 0o700, undefined, containmentRoot);
  const resolveSidecar = (target: string, label: string): string =>
    containmentRoot === undefined
      ? target
      : assertResolvedWithin(target, containmentRoot, label, { rejectSymlinks: true });
  const declaredFinalPath = path.join(sidecarsDir, `${eventId}.json`);
  let finalPath = resolveSidecar(declaredFinalPath, 'usage sidecar write');
  let tempPath = resolveSidecar(
    `${finalPath}.tmp.${process.pid}.${uuidv7()}`,
    'usage sidecar temporary file'
  );
  const buf = Buffer.from(canonicalPayloadJson, 'utf8');
  await writeDurable(tempPath, buf, 0o600, containmentRoot);
  tempPath = resolveSidecar(tempPath, 'usage sidecar temporary file');
  finalPath = resolveSidecar(declaredFinalPath, 'usage sidecar write');
  await rename(tempPath, finalPath);
  await fsyncDir(sidecarsDir, containmentRoot);
}
