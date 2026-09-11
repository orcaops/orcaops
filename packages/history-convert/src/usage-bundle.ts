import { createHash } from 'node:crypto';

import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { isUuidV7 } from './legacy/storage/ids/uuidv7.js';
import {
  AgentUsageSnapshotPayloadSchema,
  MAX_USAGE_SIDECAR_BYTES,
  SourcePlanLinkPayloadSchema,
  type UsageLedgerRecord,
  UsageLedgerRecordSchema,
} from './legacy/storage/schema/usage-ledger.js';
import { decodeLegacyLog, type LegacyLogEvent } from './log.js';
import {
  type LegacySourceMember,
  type RetainedSourceMember,
  SourceMembers,
} from './source-members.js';

export type LegacyUsageEvent = Omit<LegacyLogEvent, 'record'> & {
  readonly record: UsageLedgerRecord;
};

export interface LegacyUsageBundle {
  readonly sha256: string;
  readonly events: readonly {
    readonly ordinal: number;
    readonly event: LegacyUsageEvent;
    readonly sidecarRelativePath: string | null;
  }[];
  readonly members: readonly RetainedSourceMember[];
  readonly sidecars: readonly {
    readonly relativePath: string;
    readonly eventId: string;
    readonly sha256: string;
    readonly role: 'canonical' | 'displaced';
    readonly references: readonly number[];
    readonly payloadType: 'snapshot' | 'link';
  }[];
}
const bundles = new WeakSet<LegacyUsageBundle>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function invalid(resource: string, message: string): never {
  throw new HistoryConversionError('SOURCE_INTEGRITY', message, resource);
}
function decodeJson(bytes: Buffer, resource: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return invalid(resource, 'Retained usage member is not complete UTF-8 JSON');
  }
}

export function decodeLegacyUsageBundle(input: readonly LegacySourceMember[]): LegacyUsageBundle {
  const files = new SourceMembers(input);
  const bytes = files.bytes('ledger.ndjson');
  if (bytes.length && bytes[bytes.length - 1] !== 10)
    invalid('ledger.ndjson', 'Retained usage ledger has an unterminated tail');
  const sidecars = new Map<
    string,
    {
      relativePath: string;
      eventId: string;
      sha256: string;
      role: 'canonical' | 'displaced';
      references: number[];
      payloadType: 'snapshot' | 'link';
      bytes: Buffer;
    }
  >();
  for (const relativePath of files.names) {
    if (relativePath === 'ledger.ndjson') continue;
    const canonical = /^sidecars\/([^/]+)\.json$/.exec(relativePath);
    const displaced = /^sidecar-conflicts\/([^/]+)\/([a-f0-9]{64})\.json$/.exec(relativePath);
    const eventId = (canonical ?? displaced)?.[1];
    if (!eventId || !isUuidV7(eventId))
      throw new HistoryConversionError(
        'UNSUPPORTED_RESOURCE_SCHEMA',
        'Retained usage bundle has an unclassified member',
        relativePath
      );
    const payloadBytes = files.bytes(relativePath);
    const sha256 = hash(payloadBytes);
    if (payloadBytes.length > MAX_USAGE_SIDECAR_BYTES || (displaced && displaced[2] !== sha256))
      invalid(
        relativePath,
        'Retained usage sidecar exceeds its bound or content-addressed identity'
      );
    const payload = decodeJson(payloadBytes, relativePath);
    const snapshot = AgentUsageSnapshotPayloadSchema.safeParse(payload);
    const link = SourcePlanLinkPayloadSchema.safeParse(payload);
    const parsed = snapshot.success ? snapshot.data : link.success ? link.data : null;
    if (!parsed || canonicalJson(parsed) !== canonicalJson(payload))
      invalid(
        relativePath,
        'Retained usage sidecar does not match its complete frozen payload schema'
      );
    sidecars.set(relativePath, {
      relativePath,
      eventId,
      sha256,
      role: displaced ? 'displaced' : 'canonical',
      references: [],
      payloadType: snapshot.success ? 'snapshot' : 'link',
      bytes: payloadBytes,
    });
  }
  const lines = bytes.length ? bytes.subarray(0, -1).toString('binary').split('\n') : [];
  const events = lines.map((line, ordinal) => {
    const lineBytes = Buffer.from(line, 'binary');
    const raw = decodeJson(lineBytes, 'ledger.ndjson');
    const parsed = UsageLedgerRecordSchema.safeParse(raw);
    if (!parsed.success)
      invalid('ledger.ndjson', 'Retained usage envelope does not match its frozen schema');
    const record = parsed.data;
    let sidecarRelativePath: string | null = null;
    const payloads = new Map<string, Buffer>();
    if ('sidecar_sha256' in record) {
      const canonical = sidecars.get(`sidecars/${record.event_id}.json`);
      const found =
        canonical?.sha256 === record.sidecar_sha256
          ? canonical
          : sidecars.get(`sidecar-conflicts/${record.event_id}/${record.sidecar_sha256}.json`);
      if (!found)
        throw new HistoryConversionError(
          'SOURCE_UNAVAILABLE',
          'Retained usage record requires a missing original sidecar representation',
          'ledger.ndjson'
        );
      found.references.push(ordinal);
      payloads.set(record.event_id, found.bytes);
      sidecarRelativePath = found.relativePath;
    }
    const decoded = decodeLegacyLog({
      kind: 'usage',
      bytes: Buffer.concat([lineBytes, Buffer.from('\n')]),
      sidecars: payloads,
    });
    return Object.freeze({
      ordinal,
      event: decoded.events[0]! as LegacyUsageEvent,
      sidecarRelativePath,
    });
  });
  const members = files.retain();
  const result = Object.freeze({
    sha256: hash(
      canonicalJson(members.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })))
    ),
    events: Object.freeze(events),
    members,
    sidecars: Object.freeze(
      [...sidecars.values()].map(({ bytes: _bytes, references, ...sidecar }) =>
        Object.freeze({ ...sidecar, references: Object.freeze(references) })
      )
    ),
  });
  bundles.add(result);
  return result;
}

export function assertDecodedLegacyUsageBundle(bundle: LegacyUsageBundle): void {
  if (!bundles.has(bundle))
    invalid('usage', 'Usage source requires independently decoded original evidence');
}
