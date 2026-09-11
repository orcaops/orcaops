import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import {
  type PersistedSeedEnrichment,
  PersistedSeedEnrichmentSchema,
  type SeedEnrichment,
  type SeedEnrichmentManifest,
  SeedEnrichmentManifestSchema,
  SeedEnrichmentSchema,
} from '../seed-schema.js';
import {
  assertUniqueSeedSources,
  decodeSeedSource,
  freezeSeed,
  invalidSeed,
  refuseSeedMetadata,
  type SeedAuthoredInput,
  type SeedHistoricalInput,
  type SeedPreparationContext,
  seedPreparationContext,
  type SeedPreparationInput,
  type SeedSource,
  type SeedSourceRecord,
  seedSourceRecord,
  seedSourceText,
} from './seed-preparation.js';

export type SeedBundleIdentity =
  | { kind: 'pending' }
  | { kind: 'amend' | 'accepted'; artifactId: string };
export interface SeedBundleSource extends SeedSource {
  readonly key: string;
}
export interface PrepareProjectSeedBundle extends SeedPreparationInput, SeedAuthoredInput {
  readonly identity: SeedBundleIdentity;
  readonly sources: readonly SeedBundleSource[];
}
export interface PrepareImportedProjectSeedBundle
  extends SeedPreparationInput, SeedHistoricalInput {
  readonly identity: SeedBundleIdentity;
  readonly sources: readonly SeedBundleSource[];
}
export interface SeedBundleAuthoring {
  sourceId: string;
  filename: string;
  enrichment: SeedEnrichment;
  selection: 'matching' | 'unmatched' | 'rejected';
  reasons: Array<'duplicate-cluster' | 'options-mismatch' | 'checkpoint-count-mismatch'>;
  acceptance: 'not-established';
}
export interface SeedBundleView {
  manifest: SeedEnrichmentManifest | null;
  enrichment: PersistedSeedEnrichment | null;
  authored: SeedBundleAuthoring[];
  completeness: { complete: boolean; issues: string[] };
}
export interface SeedBundleSourceRecord extends SeedSourceRecord {
  key: string;
}
export interface SeedBundlePreparation extends SeedPreparationContext {
  identity: SeedBundleIdentity;
  bundleKey: string;
  sources: SeedBundleSourceRecord[];
  view: SeedBundleView;
  contentHash: string;
}
declare const preparedBundle: unique symbol;
export interface PreparedProjectSeedBundle {
  readonly [preparedBundle]: 'authored';
}
export interface PreparedImportedProjectSeedBundle {
  readonly [preparedBundle]: 'historical';
}
const preparations = new WeakMap<object, SeedBundlePreparation>();
export function copySeedBundleIdentity(input: SeedBundleIdentity): SeedBundleIdentity {
  if (!input || typeof input !== 'object') invalidSeed('Select the exact seed bundle workflow');
  const kind = input.kind;
  if (kind === 'pending') {
    if ('artifactId' in input)
      invalidSeed('A pending seed bundle has no inferred artifact identity');
    return { kind };
  }
  if (kind !== 'amend' && kind !== 'accepted') invalidSeed('Select a supported seed bundle kind');
  const artifactId = input.artifactId;
  if (!isUuidV7(artifactId)) invalidSeed('Preserve the original seed bundle artifact UUIDv7');
  return { kind, artifactId };
}
export function seedBundleKey(identity: SeedBundleIdentity): string {
  return JSON.stringify([identity.kind, identity.kind === 'pending' ? null : identity.artifactId]);
}
function safeName(name: string, suffix: string): boolean {
  return name !== suffix && name.endsWith(suffix) && !/[\\/\0]/u.test(name);
}
function bundleView(
  identity: SeedBundleIdentity,
  sources: SeedBundleSourceRecord[],
  context: SeedPreparationContext
): SeedBundleView {
  const values = new Map<string, SeedBundleSourceRecord>();
  for (const source of sources) {
    const prior = values.get(source.key);
    if (prior && prior.bytes !== source.bytes)
      invalidSeed('Different original bytes for one bundle key require explicit resolution');
    values.set(source.key, source);
  }
  if (identity.kind === 'accepted') {
    if (sources.some((source) => source.key !== 'enrichment' && source.key !== 'authored'))
      invalidSeed('Accepted enrichment may retain only its original result and authored input');
    const source = values.get('enrichment');
    const enrichment = source
      ? decodeSeedSource(source, PersistedSeedEnrichmentSchema, context)
      : null;
    const authored = values.get('authored');
    if (authored) {
      const original = decodeSeedSource(authored, SeedEnrichmentSchema, context);
      const { enriched_at: _at, ...body } = enrichment ?? {};
      if (!enrichment || canonicalJson(body) !== canonicalJson(original))
        invalidSeed('Accepted enrichment must agree with its original authored fields');
    }
    return {
      manifest: null,
      enrichment,
      authored: [],
      completeness: { complete: true, issues: [] },
    };
  }
  const source = values.get('manifest');
  if (!source && sources.length) invalidSeed('A seed bundle must retain its original manifest');
  const manifest = source ? decodeSeedSource(source, SeedEnrichmentManifestSchema, context) : null;
  if (
    manifest &&
    (identity.kind === 'amend'
      ? manifest.amendment?.artifact_id !== identity.artifactId
      : manifest.amendment !== undefined)
  )
    invalidSeed('Seed manifest must belong to the original bundle workflow and artifact');
  const clusters = new Map<string, NonNullable<typeof manifest>['bundles'][number]>();
  const filenames = new Set<string>();
  const artifacts = new Set<string>();
  for (const entry of manifest?.bundles ?? []) {
    if (
      !safeName(entry.filename, '.md') ||
      filenames.has(entry.filename) ||
      clusters.has(entry.cluster_key) ||
      artifacts.has(entry.artifact_id) ||
      !values.has(`bundle:${entry.filename}`) ||
      (identity.kind === 'amend' && entry.artifact_id !== identity.artifactId)
    )
      invalidSeed('Seed manifest has unsafe, duplicate, missing or mismatched original members');
    filenames.add(entry.filename);
    artifacts.add(entry.artifact_id);
    clusters.set(entry.cluster_key, entry);
  }
  const authored: SeedBundleAuthoring[] = [];
  for (const [key, value] of values) {
    if (key === 'manifest') continue;
    if (key.startsWith('bundle:')) {
      const filename = key.slice(7);
      if (!safeName(filename, '.md') || !filenames.has(filename))
        invalidSeed('Seed bundle markdown must belong to a named original manifest member');
      refuseSeedMetadata(seedSourceText(value), context);
      continue;
    }
    if (!key.startsWith('authored:'))
      invalidSeed('Seed bundles cannot introduce workspace, preparation or executable envelopes');
    const filename = key.slice(9);
    if (!safeName(filename, '.json') || filename === 'manifest.json')
      invalidSeed('Seed authoring must have a safe original JSON member filename');
    const enrichment = decodeSeedSource(value, SeedEnrichmentSchema, context);
    authored.push({
      sourceId: value.sourceId,
      filename,
      enrichment,
      selection: 'unmatched',
      reasons: [],
      acceptance: 'not-established',
    });
  }
  for (const input of authored) {
    const entry = clusters.get(input.enrichment.cluster_key);
    if (!entry) continue;
    if (authored.filter((item) => item.enrichment.cluster_key === entry.cluster_key).length > 1)
      input.reasons.push('duplicate-cluster');
    if (input.enrichment.options_hash !== manifest!.options_hash)
      input.reasons.push('options-mismatch');
    if (
      input.enrichment.steps.length !== entry.checkpoint_count ||
      input.enrichment.checkpoint_summaries.length !== entry.checkpoint_count
    )
      input.reasons.push('checkpoint-count-mismatch');
    input.selection = input.reasons.length ? 'rejected' : 'matching';
  }
  return { manifest, enrichment: null, authored, completeness: { complete: true, issues: [] } };
}
function prepare(
  input: PrepareProjectSeedBundle | PrepareImportedProjectSeedBundle,
  mode: 'authored' | 'historical'
): object {
  const context = seedPreparationContext(input, mode);
  const identity = copySeedBundleIdentity(input.identity);
  if (!Array.isArray(input.sources)) invalidSeed('Provide explicit original seed bundle sources');
  const sources = input.sources.map((source) => {
    if (!source || typeof source !== 'object') invalidSeed('Provide a typed seed bundle member');
    const key = source.key;
    if (typeof key !== 'string') invalidSeed('Provide a typed seed bundle member key');
    return { ...seedSourceRecord(source), key };
  });
  assertUniqueSeedSources(sources);
  refuseSeedMetadata(
    sources.map(({ bytes: _bytes, ...source }) => source),
    context
  );
  const view = bundleView(identity, sources, context);
  const value = freezeSeed({
    ...context,
    identity,
    bundleKey: seedBundleKey(identity),
    sources,
    view,
    contentHash: digest(Buffer.from(canonicalJson({ identity, sources }))),
  });
  const prepared = Object.freeze({});
  preparations.set(prepared, value);
  return prepared;
}
export function prepareProjectSeedBundle(
  input: PrepareProjectSeedBundle
): PreparedProjectSeedBundle {
  return prepare(input, 'authored') as PreparedProjectSeedBundle;
}
export function prepareImportedProjectSeedBundle(
  input: PrepareImportedProjectSeedBundle
): PreparedImportedProjectSeedBundle {
  return prepare(input, 'historical') as PreparedImportedProjectSeedBundle;
}
export function seedBundlePreparation(
  input: PreparedProjectSeedBundle | PreparedImportedProjectSeedBundle,
  mode: 'authored' | 'historical'
): SeedBundlePreparation {
  const value = preparations.get(input);
  if (!value || value.mode !== mode)
    invalidSeed('Use a genuine seed bundle preparation for the authorized publication path');
  return value;
}
