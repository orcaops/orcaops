import type {
  LegacyImportCloudFact,
  LegacyImportLifecycle,
  LegacyImportPlanIdempotency,
} from '@orcaops/storage/history/database';

import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';

function conflict(message: string, resource: string): never {
  throw new HistoryConversionError('SOURCE_CONFLICT', message, resource);
}

function earlierSource<T extends { readonly source: { readonly locator: string } }>(
  left: T,
  right: T
): T {
  return left.source.locator.localeCompare(right.source.locator) <= 0 ? left : right;
}

export function reconcilePlanIdempotency(
  records: readonly LegacyImportPlanIdempotency[]
): LegacyImportPlanIdempotency[] {
  const selected = new Map<string, LegacyImportPlanIdempotency>();
  for (const record of records) {
    const prior = selected.get(record.idempotencyKey);
    if (!prior) {
      selected.set(record.idempotencyKey, record);
      continue;
    }
    if (prior.artifactId !== record.artifactId || prior.createdAt !== record.createdAt)
      conflict(
        'Replicated plan-key records disagree about their original mapping',
        record.idempotencyKey
      );
    selected.set(record.idempotencyKey, earlierSource(prior, record));
  }
  return [...selected.values()].sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
}

interface LifecycleIdentity {
  readonly fires_at: string;
  readonly cp_n: number;
  readonly triggered_at: string;
}

function lifecycleIdentity(record: LegacyImportLifecycle): LifecycleIdentity {
  return JSON.parse(Buffer.from(record.bytes).toString('utf8')) as LifecycleIdentity;
}

export function reconcileLifecycles(
  records: readonly LegacyImportLifecycle[]
): LegacyImportLifecycle[] {
  const slots = new Map<string, Map<string, LegacyImportLifecycle>>();
  for (const record of records) {
    const row = lifecycleIdentity(record);
    const key = canonicalJson([record.artifactId, row.fires_at, row.cp_n]);
    const observations = slots.get(key) ?? new Map<string, LegacyImportLifecycle>();
    const bytes = Buffer.from(record.bytes).toString('base64');
    const prior = observations.get(bytes);
    observations.set(bytes, prior ? earlierSource(prior, record) : record);
    slots.set(key, observations);
  }
  return [...slots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, observations]) =>
      [...observations.values()].sort((a, b) => {
        const left = lifecycleIdentity(a);
        const right = lifecycleIdentity(b);
        return (
          left.triggered_at.localeCompare(right.triggered_at) ||
          a.source.locator.localeCompare(b.source.locator)
        );
      })
    );
}

function cloudObservationTime(record: LegacyImportCloudFact): string {
  return (
    [record.syncedAt, record.lastPushAttemptAt]
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? ''
  );
}

function cloudContent(record: LegacyImportCloudFact): string {
  const { sourceLocation: _sourceLocation, ...content } = record;
  return canonicalJson(content);
}

export function reconcileCloudFacts(
  records: readonly LegacyImportCloudFact[]
): LegacyImportCloudFact[] {
  const selected = new Map<string, LegacyImportCloudFact>();
  for (const record of records) {
    const prior = selected.get(record.artifactId);
    if (!prior) {
      selected.set(record.artifactId, record);
      continue;
    }
    const priorTime = cloudObservationTime(prior);
    const recordTime = cloudObservationTime(record);
    if (recordTime > priorTime) selected.set(record.artifactId, record);
    else if (recordTime === priorTime) {
      if (cloudContent(prior) !== cloudContent(record))
        conflict(
          'Replicated cloud-state records disagree at the same observation time',
          record.artifactId
        );
      if (record.sourceLocation.localeCompare(prior.sourceLocation) < 0)
        selected.set(record.artifactId, record);
    }
  }
  return [...selected.values()].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
}
