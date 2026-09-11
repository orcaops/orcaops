import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  computeDiffFingerprintManifestHash,
  DiffFingerprintManifestSchema,
  summarizeManifest,
} from '@orcaops/diff-fingerprint';

import { decodeLegacyArtifact } from './artifact.js';
import { HistoryConversionError } from './errors.js';
import { decodeLegacyDerivedFingerprint } from './fingerprint.js';
import {
  checkpointMarkdown,
  planMarkdown,
  summaryMarkdown,
} from './legacy/storage/artifacts/store.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import type { EventRecord } from './legacy/storage/events/event-log.js';
import {
  rebuildArtifactJsonFromEvents,
  rebuildCheckpointFromEvents,
  rebuildEvaluatorLogFromEvents,
  rebuildPlanFromEvents,
  rebuildSummaryFromEvents,
} from './legacy/storage/events/rebuilders.js';
import { isUuidV7 } from './legacy/storage/ids/uuidv7.js';
import { ArtifactJsonSchema } from './legacy/storage/schema/artifact-json.js';
import { CheckpointSchema } from './legacy/storage/schema/checkpoint.js';
import { EvaluatorLogSchema } from './legacy/storage/schema/evaluator-run.js';
import { PlanSchema } from './legacy/storage/schema/plan.js';
import { SummarySchema } from './legacy/storage/schema/summary.js';

export interface LegacyArtifactBundle {
  readonly integrity: 'artifact_source';
  readonly artifact: ReturnType<typeof decodeLegacyArtifact>;
  readonly members: readonly {
    readonly relativePath: string;
    readonly sha256: string;
    readonly bytesBase64: string;
  }[];
  readonly auxiliaries: readonly {
    readonly relativePath: string;
    readonly kind: 'projection' | 'render' | 'digest-metadata' | 'derived-fingerprint';
    readonly authority: 'original-attachment';
    readonly fidelity: 'matches-current' | 'differs-from-current' | 'not-compared';
    readonly sourceEventId: string | null;
  }[];
}
const bundles = new WeakSet<LegacyArtifactBundle>();
function fail(resource: string, message: string, missing = false): never {
  throw new HistoryConversionError(
    missing ? 'SOURCE_UNAVAILABLE' : 'SOURCE_INTEGRITY',
    message,
    resource
  );
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export async function decodeLegacyArtifactBundle(input: {
  artifactId: string;
  members: readonly { relativePath: string; bytes: Buffer }[];
}): Promise<LegacyArtifactBundle> {
  const artifactId = input.artifactId;
  const files = new Map<string, Buffer>();
  for (const member of input.members) {
    if (
      !member.relativePath ||
      member.relativePath.includes('\\') ||
      member.relativePath.includes('\0') ||
      member.relativePath.split('/').some((part) => !part || part === '.' || part === '..') ||
      files.has(member.relativePath)
    )
      fail('artifact', 'Artifact member paths must be unique safe relative paths');
    files.set(member.relativePath, Buffer.from(member.bytes));
  }
  const log = files.get('events.ndjson');
  if (!log) fail('events.ndjson', 'Expected artifact event source is absent', true);
  const sidecars = new Map<string, Buffer>();
  for (const [name, bytes] of files) {
    const match = /^sidecars\/([^/]+)\.json$/.exec(name);
    if (match && isUuidV7(match[1]!)) sidecars.set(match[1]!, bytes);
  }
  const artifact = decodeLegacyArtifact({ artifactId, bytes: log, sidecars });
  const ids = new Set(artifact.log.events.map((event) => event.record.event_id));
  const events = artifact.log.events.map((event) => ({
    record: event.record as EventRecord,
    payload: event.payload as Record<string, unknown>,
  }));
  const checkpoints = new Map(artifact.checkpoints.map((checkpoint) => [checkpoint.n, checkpoint]));
  const auxiliary: LegacyArtifactBundle['auxiliaries'][number][] = [];
  for (const event of artifact.log.events) {
    if (event.record.type !== 'checkpoint_closed') continue;
    const payload = event.payload as Record<string, unknown>;
    const cp = checkpoints.get(payload.n as number);
    if (!cp || cp.status !== 'closed')
      fail('events.ndjson', 'Captured fingerprint lacks its closed checkpoint');
    const summary = cp.diff_fingerprint_summary;
    const raw = payload.diff_fingerprint_manifest;
    if (raw === undefined) {
      if (summary.status !== 'skipped' || summary.manifest_hash !== null)
        fail(
          'events.ndjson',
          'Captured fingerprint summary requires its missing original manifest',
          true
        );
      continue;
    }
    const parsed = DiffFingerprintManifestSchema.safeParse(raw);
    if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(raw))
      fail('events.ndjson', 'Captured fingerprint manifest differs from its frozen schema');
    const manifest = parsed.data;
    if (
      manifest.artifact_id !== artifactId ||
      manifest.checkpoint_n !== cp.n ||
      (cp.open_snapshot.tree_sha !== null &&
        cp.open_snapshot.tree_sha !== manifest.open_tree_sha) ||
      (cp.close_snapshot.tree_sha !== null &&
        cp.close_snapshot.tree_sha !== manifest.close_tree_sha)
    ) {
      auxiliary.push({
        relativePath: 'events.ndjson',
        kind: 'derived-fingerprint',
        authority: 'original-attachment',
        fidelity: 'differs-from-current',
        sourceEventId: event.record.event_id,
      });
      continue;
    }
    const hash = await computeDiffFingerprintManifestHash(manifest);
    if (canonicalJson(summarizeManifest(manifest, hash)) !== canonicalJson(summary))
      auxiliary.push({
        relativePath: 'events.ndjson',
        kind: 'derived-fingerprint',
        authority: 'original-attachment',
        fidelity: 'differs-from-current',
        sourceEventId: event.record.event_id,
      });
  }
  const text = (name: string) => {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(files.get(name)!);
    } catch {
      return fail(name, 'Artifact attachment is not complete UTF-8');
    }
  };
  const json = (name: string, schema: z.ZodType): Record<string, unknown> => {
    let raw: unknown;
    try {
      raw = JSON.parse(text(name));
    } catch {
      fail(name, 'Artifact attachment is not complete JSON');
    }
    const result = schema.safeParse(raw);
    if (!result.success || canonicalJson(result.data) !== canonicalJson(raw))
      fail(name, 'Artifact attachment differs from its complete frozen structure');
    return raw as Record<string, unknown>;
  };
  const requireSource = (name: string, eventId: unknown): string => {
    if (typeof eventId !== 'string' || !ids.has(eventId))
      fail(name, 'Artifact attachment names a missing source event', true);
    return eventId;
  };
  for (const name of [...files.keys()].sort()) {
    if (
      name === 'events.ndjson' ||
      (/^sidecars\/([^/]+)\.json$/.test(name) && sidecars.has(name.slice(9, -5)))
    )
      continue;
    const checkpoint = /^checkpoint-([1-9][0-9]*)\.(json|md)$/.exec(name);
    const cp = checkpoint ? checkpoints.get(Number(checkpoint[1])) : undefined;
    if (checkpoint && !cp) fail(name, 'Artifact attachment names an absent checkpoint', true);
    const derived = /^derived\/fingerprint-cp([1-9][0-9]*)\.json$/.exec(name);
    if (derived) {
      const value = await decodeLegacyDerivedFingerprint(files.get(name)!);
      const checkpoint = checkpoints.get(Number(derived[1]));
      if (
        !checkpoint ||
        checkpoint.status !== 'closed' ||
        value.value.artifact_id !== artifactId ||
        value.value.checkpoint_n !== checkpoint.n
      )
        fail(name, 'Derived fingerprint does not name a retained closed checkpoint');
      auxiliary.push({
        relativePath: name,
        kind: 'derived-fingerprint',
        authority: 'original-attachment',
        fidelity:
          value.value.verified === null
            ? 'not-compared'
            : value.value.verified &&
                value.value.manifest_hash_stored ===
                  checkpoint.diff_fingerprint_summary.manifest_hash
              ? 'matches-current'
              : 'differs-from-current',
        sourceEventId: checkpoint.source_event_id,
      });
      continue;
    }
    if (name === 'digest.meta.json') {
      if (!files.has('digest.md'))
        fail(name, 'Digest metadata names a missing retained render', true);
      const value = json(
        name,
        z.strictObject({ source_event_id: z.string().min(1), usage_fingerprint: z.string().min(1) })
      );
      const sourceEventId = requireSource(name, value.source_event_id);
      auxiliary.push({
        relativePath: name,
        kind: 'digest-metadata',
        authority: 'original-attachment',
        fidelity:
          sourceEventId === artifact.artifact.source_event_id
            ? 'matches-current'
            : 'differs-from-current',
        sourceEventId,
      });
      continue;
    }
    const projection =
      name === 'plan.json'
        ? { schema: PlanSchema, expected: artifact.plan }
        : name === 'artifact.json'
          ? { schema: ArtifactJsonSchema, expected: artifact.artifact }
          : name === 'summary.json'
            ? { schema: SummarySchema, expected: artifact.summary }
            : name === 'evaluators.json'
              ? { schema: EvaluatorLogSchema, expected: artifact.evaluatorLog }
              : checkpoint?.[2] === 'json'
                ? { schema: CheckpointSchema, expected: cp! }
                : null;
    if (projection) {
      const value = json(name, projection.schema);
      if ((value.artifact_id ?? value.id) !== artifactId || (cp && value.n !== cp.n))
        fail(name, 'Artifact projection belongs to another resource');
      const sourceEventId = requireSource(name, value.source_event_id);
      const prefix = events.slice(
        0,
        events.findIndex((event) => event.record.event_id === sourceEventId) + 1
      );
      const source =
        name === 'plan.json'
          ? rebuildPlanFromEvents(prefix)?.plan
          : name === 'artifact.json'
            ? rebuildArtifactJsonFromEvents(prefix)?.json
            : name === 'summary.json'
              ? rebuildSummaryFromEvents(prefix)?.summary
              : name === 'evaluators.json'
                ? rebuildEvaluatorLogFromEvents(prefix, artifactId)?.log
                : rebuildCheckpointFromEvents(prefix, cp!.n)?.checkpoint;
      if (!source || source.source_event_id !== sourceEventId)
        fail(name, 'Projection does not reference a source event that produces its recorded kind');
      auxiliary.push({
        relativePath: name,
        kind: 'projection',
        authority: 'original-attachment',
        fidelity:
          canonicalJson(value) === canonicalJson(projection.expected)
            ? 'matches-current'
            : 'differs-from-current',
        sourceEventId,
      });
      continue;
    }
    let expected: string | null = null;
    if (name === 'plan.md') expected = planMarkdown(artifact.plan);
    else if (name === 'summary.md') {
      if (!artifact.summary) fail(name, 'Summary render names an absent retained summary', true);
      expected = summaryMarkdown(artifact.summary);
    } else if (checkpoint?.[2] === 'md') expected = checkpointMarkdown(cp!);
    else if (!['digest.md', 'resume.md'].includes(name))
      throw new HistoryConversionError(
        'UNSUPPORTED_RESOURCE_SCHEMA',
        'Artifact inventory contains an unclassified auxiliary member',
        name
      );
    const value = text(name);
    auxiliary.push({
      relativePath: name,
      kind: 'render',
      authority: 'original-attachment',
      fidelity:
        expected === null
          ? 'not-compared'
          : expected === value
            ? 'matches-current'
            : 'differs-from-current',
      sourceEventId: null,
    });
  }
  const result = freeze({
    integrity: 'artifact_source' as const,
    artifact,
    auxiliaries: auxiliary,
    members: [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([relativePath, bytes]) => ({
        relativePath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytesBase64: bytes.toString('base64'),
      })),
  });
  bundles.add(result);
  return result;
}
export function assertDecodedLegacyArtifactBundle(bundle: LegacyArtifactBundle): void {
  if (!bundles.has(bundle))
    fail('artifact', 'Artifact source requires genuine independently decoded evidence');
}
