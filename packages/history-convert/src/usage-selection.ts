import { createHash } from 'node:crypto';

import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { usageRecordContentIdentity } from './legacy/storage/usage/ledger-log.js';
import {
  compareLegacyEventRepresentation,
  type LegacyRepresentationChoice,
} from './representation.js';
import { assertDecodedLegacyUsageBundle, type LegacyUsageBundle } from './usage-bundle.js';

export interface LegacyUsageSource {
  readonly sourceId: string;
  readonly bundle: LegacyUsageBundle;
}
export interface LegacyUsageChoice extends LegacyRepresentationChoice {
  readonly key: string;
}
export interface LegacyUsageSelection {
  readonly manifestHash: string;
  readonly eventBytesBase64: string;
  readonly sidecars: readonly { readonly eventId: string; readonly bytesBase64: string }[];
  readonly sources: readonly LegacyUsageSource[];
  readonly counts: {
    readonly originalOccurrences: number;
    readonly selectedSnapshots: number;
    readonly selectedLinks: number;
    readonly retainedEvidenceOccurrences: number;
  };
  readonly occurrences: readonly {
    readonly sourceId: string;
    readonly ordinal: number;
    readonly eventId: string;
    readonly lineSha256: string;
    readonly contentIdentity: string;
    readonly canonicalRecordIndex: number;
    readonly disposition: 'selected-original' | 'retained-source-evidence';
  }[];
  readonly records: readonly {
    readonly key: string;
    readonly sourceId: string;
    readonly ordinal: number;
    readonly eventId: string;
    readonly lineSha256: string;
    readonly reviewed: boolean;
    readonly fidelity: readonly {
      readonly sourceId: string;
      readonly sha256: string;
      readonly records: number;
      readonly selectedRedacted: number;
      readonly selectedUnredacted: number;
    }[];
  }[];
}
const selections = new WeakSet<LegacyUsageSelection>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = ({ event }: LegacyUsageBundle['events'][number]) =>
  hash(canonicalJson([event.record.type, event.record.idempotency_key]));
function conflict(message: string): never {
  throw new HistoryConversionError('SOURCE_CONFLICT', message, 'usage');
}

export function selectLegacyUsage(
  input: readonly LegacyUsageSource[],
  reviewed: readonly LegacyUsageChoice[] = []
): LegacyUsageSelection {
  const sources = input
    .map((source) => ({ ...source }))
    .sort((a, b) => compare(a.sourceId, b.sourceId));
  if (!sources.length || new Set(sources.map((source) => source.sourceId)).size !== sources.length)
    conflict('Usage selection requires distinct complete source identities');
  for (const source of sources) {
    if (!source.sourceId) conflict('Usage source identity is absent');
    assertDecodedLegacyUsageBundle(source.bundle);
  }
  const byKey = new Map<
    string,
    { source: LegacyUsageSource; events: LegacyUsageBundle['events'][number][] }[]
  >();
  for (const source of sources) {
    const events = new Map<string, LegacyUsageBundle['events'][number][]>();
    for (const event of source.bundle.events) {
      const key = keyOf(event);
      const sequence = events.get(key) ?? [];
      sequence.push(event);
      events.set(key, sequence);
    }
    for (const [key, sequence] of events) {
      const copies = byKey.get(key) ?? [];
      copies.push({ source, events: sequence });
      byKey.set(key, copies);
    }
  }
  const selected = new Map<
    string,
    {
      source: LegacyUsageSource;
      event: LegacyUsageBundle['events'][number];
      evidence: LegacyUsageSelection['records'][number];
    }
  >();
  for (const [key, copies] of byKey) {
    const choices = reviewed.filter((choice) => choice.key === key);
    if (choices.length > 1) conflict('Usage representation choice is repeated');
    const choice = choices[0];
    const hashes = copies.map(({ source }) => ({
      sourceId: source.sourceId,
      sha256: source.bundle.sha256,
    }));
    if (
      choice &&
      canonicalJson([...choice.sources].sort((a, b) => compare(a.sourceId, b.sourceId))) !==
        canonicalJson(hashes)
    )
      conflict('Reviewed usage choice does not match its complete source manifest');
    const longest = copies.reduce((prior, next) =>
      next.events.length > prior.events.length ? next : prior
    );
    const target = choice
      ? copies.find((copy) => copy.source.sourceId === choice.sourceId)
      : longest;
    if (!target || target.events.length !== longest.events.length)
      conflict('Selected usage representation would omit a retained repair continuation');
    const fidelity = copies.map((copy) => {
      let selectedRedacted = 0;
      let selectedUnredacted = 0;
      for (let n = 0; n < copy.events.length; n++) {
        const relation = compareLegacyEventRepresentation(
          copy.events[n]!.event,
          target.events[n]!.event
        );
        if (relation === 'conflict')
          conflict('Usage stable-key histories have divergent ordered semantic content');
        if (relation === 'selected-redacted') selectedRedacted += 1;
        if (relation === 'selected-unredacted') selectedUnredacted += 1;
      }
      if ((selectedRedacted || selectedUnredacted) && !choice)
        conflict('Usage fidelity differences require a hash-bound reviewed representation choice');
      return Object.freeze({
        sourceId: copy.source.sourceId,
        sha256: copy.source.bundle.sha256,
        records: copy.events.length,
        selectedRedacted,
        selectedUnredacted,
      });
    });
    const event = target.events.at(-1)!;
    selected.set(key, {
      source: target.source,
      event,
      evidence: Object.freeze({
        key,
        sourceId: target.source.sourceId,
        ordinal: event.ordinal,
        eventId: event.event.record.event_id,
        lineSha256: hash(event.event.line),
        reviewed: choice !== undefined,
        fidelity: Object.freeze(fidelity),
      }),
    });
  }
  if (reviewed.some((choice) => !byKey.has(choice.key)))
    conflict('Reviewed usage key is absent from the complete source inventory');
  const ids = new Set<string>();
  const snapshotIds = new Set<string>();
  for (const { event } of selected.values()) {
    if (ids.has(event.event.record.event_id))
      conflict('Usage terminal records reuse an event identity across semantic keys');
    ids.add(event.event.record.event_id);
    if (event.event.record.type === 'agent_usage_snapshot_recorded') {
      const snapshotId = (event.event.payload as { snapshot_id: string }).snapshot_id;
      if (snapshotIds.has(snapshotId))
        conflict('Usage terminal snapshots reuse a snapshot identity across semantic keys');
      snapshotIds.add(snapshotId);
    }
  }
  const edges = new Map([...byKey.keys()].map((key) => [key, new Set<string>()]));
  const degrees = new Map([...byKey.keys()].map((key) => [key, 0]));
  for (const source of sources) {
    const superseded = sources.some(
      (other) =>
        source.bundle.events.length < other.bundle.events.length &&
        source.bundle.events.every(
          (event, n) =>
            compareLegacyEventRepresentation(event.event, other.bundle.events[n]!.event) !==
            'conflict'
        )
    );
    if (superseded) continue;
    const positions = new Map<string, number>();
    for (const event of source.bundle.events) positions.set(keyOf(event), event.ordinal);
    const order = [...positions].sort((a, b) => a[1] - b[1]).map(([key]) => key);
    for (const type of ['agent_usage_snapshot_recorded', 'source_plan_linked']) {
      const phase = order.filter((key) => selected.get(key)!.event.event.record.type === type);
      for (let n = 1; n < phase.length; n++) {
        const from = phase[n - 1]!;
        const to = phase[n]!;
        if (!edges.get(from)!.has(to)) {
          edges.get(from)!.add(to);
          degrees.set(to, degrees.get(to)! + 1);
        }
      }
    }
  }
  const ready: string[] = [];
  const add = (key: string) => {
    ready.push(key);
    let n = ready.length - 1;
    while (n > 0) {
      const parent = (n - 1) >> 1;
      if (compare(ready[parent]!, key) <= 0) break;
      ready[n] = ready[parent]!;
      n = parent;
    }
    ready[n] = key;
  };
  const take = () => {
    const first = ready[0]!;
    const tail = ready.pop()!;
    if (ready.length) {
      let n = 0;
      while (2 * n + 1 < ready.length) {
        let child = 2 * n + 1;
        if (child + 1 < ready.length && compare(ready[child + 1]!, ready[child]!) < 0) child += 1;
        if (compare(tail, ready[child]!) <= 0) break;
        ready[n] = ready[child]!;
        n = child;
      }
      ready[n] = tail;
    }
    return first;
  };
  for (const [key, count] of degrees) if (count === 0) add(key);
  const ordered: string[] = [];
  while (ready.length) {
    const key = take();
    ordered.push(key);
    for (const target of edges.get(key)!) {
      const degree = degrees.get(target)! - 1;
      degrees.set(target, degree);
      if (!degree) add(target);
    }
  }
  if (ordered.length !== selected.size)
    conflict('Retained usage sources impose conflicting semantic replay order');
  const snapshots = ordered.filter(
    (key) => selected.get(key)!.event.event.record.type === 'agent_usage_snapshot_recorded'
  );
  const links = ordered.filter(
    (key) => selected.get(key)!.event.event.record.type === 'source_plan_linked'
  );
  const records = [...snapshots, ...links].map((key) => selected.get(key)!);
  const sidecars = records.flatMap(({ source, event }) => {
    if (!event.sidecarRelativePath) return [];
    const member = source.bundle.members.find(
      (member) => member.relativePath === event.sidecarRelativePath
    )!;
    return [
      Object.freeze({ eventId: event.event.record.event_id, bytesBase64: member.bytesBase64 }),
    ];
  });
  const evidence = records.map(({ evidence }) => evidence);
  const recordIndices = new Map(evidence.map((record, index) => [record.key, index]));
  const occurrences = sources.flatMap(({ sourceId, bundle }) =>
    bundle.events.map(({ ordinal, event }) => {
      const key = hash(canonicalJson([event.record.type, event.record.idempotency_key]));
      const canonicalRecordIndex = recordIndices.get(key)!;
      const target = evidence[canonicalRecordIndex]!;
      return Object.freeze({
        sourceId,
        ordinal,
        eventId: event.record.event_id,
        lineSha256: hash(event.line),
        contentIdentity: usageRecordContentIdentity(event.record, event.payload),
        canonicalRecordIndex,
        disposition:
          sourceId === target.sourceId && ordinal === target.ordinal
            ? ('selected-original' as const)
            : ('retained-source-evidence' as const),
      });
    })
  );
  const counts = Object.freeze({
    originalOccurrences: occurrences.length,
    selectedSnapshots: snapshots.length,
    selectedLinks: links.length,
    retainedEvidenceOccurrences: occurrences.length - records.length,
  });
  const eventBytesBase64 = Buffer.from(
    records.map(({ event }) => event.event.line + '\n').join('')
  ).toString('base64');
  const result = Object.freeze({
    manifestHash: hash(
      canonicalJson({
        sources: sources.map(({ sourceId, bundle }) => ({ sourceId, sha256: bundle.sha256 })),
        records: evidence,
        occurrences,
        counts,
        eventBytesBase64,
      })
    ),
    eventBytesBase64,
    sidecars: Object.freeze(sidecars),
    sources: Object.freeze(sources.map((source) => Object.freeze(source))),
    records: Object.freeze(evidence),
    occurrences: Object.freeze(occurrences),
    counts,
  });
  selections.add(result);
  return result;
}

export function assertLegacyUsageSelection(selection: LegacyUsageSelection): void {
  if (!selections.has(selection))
    conflict('Usage selection requires independently verified original evidence');
}
