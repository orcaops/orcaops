import { createHash } from 'node:crypto';

import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { type EventRecord, EventRecordSchema } from './legacy/storage/events/event-log.js';
import {
  AgentUsageSnapshotPayloadSchema,
  SourcePlanLinkPayloadSchema,
  type UsageLedgerRecord,
  UsageLedgerRecordSchema,
} from './legacy/storage/schema/usage-ledger.js';
import { isValidUsagePayload } from './legacy/storage/usage/ledger-log.js';

export interface LegacyLogEvent {
  readonly record: EventRecord | UsageLedgerRecord;
  readonly payload: unknown;
  readonly line: string;
}

export interface LegacyLog {
  readonly kind: 'artifact' | 'usage';
  readonly sha256: string;
  readonly bytesBase64: string;
  readonly events: readonly LegacyLogEvent[];
  readonly sidecars: readonly {
    eventId: string;
    sha256: string;
    bytesBase64: string;
  }[];
}

const decodedLogs = new WeakSet<LegacyLog>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function integrity(message: string): never {
  throw new HistoryConversionError('SOURCE_INTEGRITY', message);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return integrity('Retained source is not valid UTF-8');
  }
}

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return integrity('Retained source contains malformed JSON');
  }
}

export function decodeLegacyLog(input: {
  kind: 'artifact' | 'usage';
  bytes: Buffer;
  sidecars?: ReadonlyMap<string, Buffer>;
}): LegacyLog {
  if (input.kind !== 'artifact' && input.kind !== 'usage')
    integrity('Retained log kind is unsupported');
  const bytes = Buffer.from(input.bytes);
  const sidecars = new Map(
    [...(input.sidecars ?? [])].map(([id, value]) => [id, Buffer.from(value)])
  );
  const text = decodeText(bytes);
  if (text.length && !text.endsWith('\n'))
    integrity('Retained log has an unterminated tail that cannot be certified as complete');
  const lines = text.length ? text.slice(0, -1).split('\n') : [];
  const ids = new Set<string>();
  const usedSidecars = new Set<string>();
  const events = lines.map((line): LegacyLogEvent => {
    const raw = decodeJson(line);
    const parsed = (
      input.kind === 'artifact' ? EventRecordSchema : UsageLedgerRecordSchema
    ).safeParse(raw);
    if (!parsed.success) integrity('Retained log record does not match its frozen source schema');
    const record = parsed.data;
    if (canonicalJson(raw) !== canonicalJson(record))
      integrity('Retained record requires a representation-changing normalization');
    const { checksum, ...unsigned } = record;
    if (hash(canonicalJson(unsigned)) !== checksum)
      integrity('Retained log record checksum does not match its content');
    if (ids.has(record.event_id)) integrity('Retained log repeats an event identity');
    ids.add(record.event_id);
    let payload: unknown;
    if ('payload' in record) payload = record.payload;
    else {
      const sidecar = sidecars.get(record.event_id);
      if (
        !sidecar ||
        sidecar.length !== record.sidecar_size ||
        hash(sidecar) !== record.sidecar_sha256
      )
        integrity('Retained sidecar is missing or differs from the recorded size or hash');
      usedSidecars.add(record.event_id);
      payload = decodeJson(decodeText(sidecar));
    }
    if (input.kind === 'usage') {
      const schema =
        record.type === 'agent_usage_snapshot_recorded'
          ? AgentUsageSnapshotPayloadSchema
          : SourcePlanLinkPayloadSchema;
      const checked = schema.safeParse(payload);
      if (!checked.success || canonicalJson(checked.data) !== canonicalJson(payload))
        integrity('Retained usage payload does not match its complete frozen representation');
      if (
        !isValidUsagePayload(
          record.type as UsageLedgerRecord['type'],
          record.idempotency_key,
          payload
        )
      )
        integrity('Retained usage payload and envelope idempotency keys disagree');
    }
    return freeze({ record, payload, line });
  });
  if ([...sidecars.keys()].some((id) => !usedSidecars.has(id)))
    integrity('An unreferenced sidecar requires explicit preservation review');
  const result: LegacyLog = freeze({
    kind: input.kind,
    sha256: hash(bytes),
    bytesBase64: bytes.toString('base64'),
    events,
    sidecars: [...sidecars]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([eventId, value]) => ({
        eventId,
        sha256: hash(value),
        bytesBase64: value.toString('base64'),
      })),
  });
  decodedLogs.add(result);
  return result;
}

export function selectLegacyContinuation(input: readonly { sourceId: string; log: LegacyLog }[]): {
  sourceId: string;
  log: LegacyLog;
  sources: readonly { sourceId: string; sha256: string; relation: 'equal' | 'prefix' }[];
} {
  if (!input.length || new Set(input.map((source) => source.sourceId)).size !== input.length)
    integrity('Source selection requires distinct explicit source identities');
  const sources = input
    .map((source) => ({ ...source }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  for (const source of sources)
    if (!source.sourceId || !decodedLogs.has(source.log))
      integrity('Source selection requires an independently decoded log');
  const selected = sources.reduce((prior, next) =>
    next.log.events.length > prior.log.events.length ? next : prior
  );
  for (const source of sources) {
    if (
      source.log.kind !== selected.log.kind ||
      source.log.events.some(
        (event, index) =>
          canonicalJson(event.record) !== canonicalJson(selected.log.events[index]!.record)
      )
    )
      throw new HistoryConversionError(
        'SOURCE_CONFLICT',
        'Retained histories diverge; timestamps cannot select a replacement'
      );
  }
  return freeze({
    ...selected,
    sources: sources.map(({ sourceId, log }) => ({
      sourceId,
      sha256: log.sha256,
      relation: log.events.length === selected.log.events.length ? 'equal' : 'prefix',
    })),
  });
}

export function assertDecodedLegacyLog(log: LegacyLog): void {
  if (!decodedLogs.has(log)) integrity('Source selection requires an independently decoded log');
}
