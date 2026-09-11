import { createHash } from 'node:crypto';

import { HistoryConversionError } from './errors.js';
import { redactSecretsInValue } from './legacy/protocol/secrets.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { assertDecodedLegacyLog, type LegacyLog, type LegacyLogEvent } from './log.js';

export interface LegacyLogSource {
  readonly sourceId: string;
  readonly log: LegacyLog;
}
export interface LegacyRepresentationChoice {
  readonly sourceId: string;
  readonly sources: readonly { readonly sourceId: string; readonly sha256: string }[];
}
export interface LegacyLogSelection {
  readonly sourceId: string;
  readonly log: LegacyLog;
  readonly manifestHash: string;
  readonly reviewed: boolean;
  readonly sources: readonly {
    readonly sourceId: string;
    readonly sha256: string;
    readonly records: number;
    readonly relation: 'equal' | 'prefix';
    readonly fidelity: 'same-payload' | 'selected-redacted' | 'selected-unredacted' | 'mixed';
    readonly differentPayloads: number;
  }[];
}
const selections = new WeakSet<LegacyLogSelection>();
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function conflict(message: string): never {
  throw new HistoryConversionError('SOURCE_CONFLICT', message);
}
function envelope(event: LegacyLogEvent) {
  const { event_id, type, ts, schema_version, idempotency_key } = event.record;
  return { event_id, type, ts, schema_version, idempotency_key };
}

export function compareLegacyEventRepresentation(
  original: LegacyLogEvent,
  target: LegacyLogEvent
): 'same-payload' | 'selected-redacted' | 'selected-unredacted' | 'conflict' {
  if (!same(envelope(original), envelope(target))) return 'conflict';
  if (same(original.payload, target.payload)) return 'same-payload';
  if (same(redactSecretsInValue(original.payload), target.payload)) return 'selected-redacted';
  if (same(original.payload, redactSecretsInValue(target.payload))) return 'selected-unredacted';
  return 'conflict';
}

export function selectLegacyRepresentation(
  input: readonly LegacyLogSource[],
  choice?: LegacyRepresentationChoice
): LegacyLogSelection {
  const sources = input
    .map((source) => ({ ...source }))
    .sort((a, b) => compare(a.sourceId, b.sourceId));
  if (!sources.length || new Set(sources.map((source) => source.sourceId)).size !== sources.length)
    conflict('Representation selection requires distinct source identities');
  for (const source of sources) {
    if (!source.sourceId) conflict('Representation source identity is absent');
    assertDecodedLegacyLog(source.log);
  }
  const sourceHashes = sources.map(({ sourceId, log }) => ({ sourceId, sha256: log.sha256 }));
  if (
    choice &&
    !same(
      [...choice.sources].sort((a, b) => compare(a.sourceId, b.sourceId)),
      sourceHashes
    )
  )
    conflict('Reviewed representation choice does not match the complete source manifest');
  const longest = sources.reduce((prior, next) =>
    next.log.events.length > prior.log.events.length ? next : prior
  );
  const selected = choice ? sources.find((source) => source.sourceId === choice.sourceId) : longest;
  if (!selected || selected.log.events.length !== longest.log.events.length)
    conflict('Selected representation would omit retained continuation evidence');
  let different = false;
  const evidence: LegacyLogSelection['sources'][number][] = [];
  for (const source of sources) {
    if (source.log.kind !== selected.log.kind) conflict('Retained log kinds disagree');
    let redacted = false;
    let unredacted = false;
    let differentPayloads = 0;
    for (let index = 0; index < source.log.events.length; index++) {
      const original = source.log.events[index]!;
      const target = selected.log.events[index]!;
      if (!same(envelope(original), envelope(target)))
        conflict('Retained ordered event identities diverge');
      if (same(original.payload, target.payload)) continue;
      different = true;
      differentPayloads += 1;
      if (same(redactSecretsInValue(original.payload), target.payload)) redacted = true;
      else if (same(original.payload, redactSecretsInValue(target.payload))) unredacted = true;
      else conflict('Retained payloads diverge beyond the frozen redaction policy');
    }
    evidence.push({
      sourceId: source.sourceId,
      sha256: source.log.sha256,
      records: source.log.events.length,
      relation: source.log.events.length === selected.log.events.length ? 'equal' : 'prefix',
      fidelity:
        redacted && unredacted
          ? 'mixed'
          : redacted
            ? 'selected-redacted'
            : unredacted
              ? 'selected-unredacted'
              : 'same-payload',
      differentPayloads,
    });
  }
  if (different && !choice)
    conflict('Retained fidelity differences require a hash-bound reviewed representation choice');
  const manifest = {
    sourceId: selected.sourceId,
    reviewed: choice !== undefined,
    sources: evidence.map((source) => Object.freeze(source)),
  };
  const result = Object.freeze({
    ...manifest,
    log: selected.log,
    sources: Object.freeze(manifest.sources),
    manifestHash: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
  });
  selections.add(result);
  return result;
}

export function assertLegacyLogSelection(selection: LegacyLogSelection): void {
  if (!selections.has(selection))
    conflict('Representation selection requires independently verified source evidence');
}
