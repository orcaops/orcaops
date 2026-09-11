import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { digest } from '../event-integrity.js';
import {
  type SeedCoverageReport,
  SeedCoverageReportSchema,
  type SeedJournal,
  SeedJournalSchema,
  type SeedJournalV1,
  SeedJournalV1Schema,
  type SeedPreciousState,
  SeedPreciousStateSchema,
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
} from './seed-preparation.js';

export type SeedStateKind = 'precious' | 'journal' | 'coverage';
export interface SeedStateSource extends SeedSource {
  readonly kind: SeedStateKind;
}
export interface PrepareProjectSeedState extends SeedPreparationInput, SeedAuthoredInput {
  readonly sources: readonly SeedStateSource[];
}
export interface PrepareImportedProjectSeedState extends SeedPreparationInput, SeedHistoricalInput {
  readonly sources: readonly SeedStateSource[];
}
export interface SeedStateView {
  precious: SeedPreciousState | null;
  journal: SeedJournal | null;
  legacyJournal: SeedJournalV1 | null;
  coverage: SeedCoverageReport | null;
  completeness: { complete: boolean; issues: string[] };
}
export interface SeedStateSourceRecord extends SeedSourceRecord {
  kind: SeedStateKind;
  schemaVersion: number;
}
export interface SeedStatePreparation extends SeedPreparationContext {
  sources: SeedStateSourceRecord[];
  selected: Record<SeedStateKind, string | null>;
  view: SeedStateView;
  contentHash: string;
}
declare const preparedState: unique symbol;
export interface PreparedProjectSeedState {
  readonly [preparedState]: 'authored';
}
export interface PreparedImportedProjectSeedState {
  readonly [preparedState]: 'historical';
}
const preparations = new WeakMap<object, SeedStatePreparation>();
const journalSchema = z.union([SeedJournalSchema, SeedJournalV1Schema]);
function prepare(
  input: PrepareProjectSeedState | PrepareImportedProjectSeedState,
  mode: 'authored' | 'historical'
): object {
  const context = seedPreparationContext(input, mode);
  if (!Array.isArray(input.sources)) invalidSeed('Provide an explicit original seed source array');
  const sources = input.sources.map((source: SeedStateSource) => {
    if (!source || typeof source !== 'object')
      invalidSeed('Provide typed original seed state sources');
    const kind = source.kind;
    if (kind !== 'precious' && kind !== 'journal' && kind !== 'coverage')
      invalidSeed('Seed state accepts only precious, journal and retained coverage sources');
    return { ...seedSourceRecord(source), kind };
  });
  assertUniqueSeedSources(sources);
  refuseSeedMetadata(
    sources.map(({ bytes: _bytes, ...source }) => source),
    context
  );
  const selected: Record<SeedStateKind, string | null> = {
    precious: null,
    journal: null,
    coverage: null,
  };
  const values = new Map<SeedStateKind, SeedSourceRecord>();
  const records: SeedStateSourceRecord[] = [];
  for (const source of sources) {
    const prior = values.get(source.kind);
    if (prior && prior.bytes !== source.bytes)
      invalidSeed('Different original bytes for one seed state kind require explicit resolution');
    values.set(source.kind, source);
    selected[source.kind] ??= source.sourceId;
    const decoded = decodeSeedSource<{ schema_version: number }>(
      source,
      source.kind === 'precious'
        ? SeedPreciousStateSchema
        : source.kind === 'coverage'
          ? SeedCoverageReportSchema
          : journalSchema,
      context
    );
    records.push({ ...source, schemaVersion: decoded.schema_version });
  }
  const preciousSource = values.get('precious');
  const journalSource = values.get('journal');
  const coverageSource = values.get('coverage');
  let precious = preciousSource
    ? decodeSeedSource(preciousSource, SeedPreciousStateSchema, context)
    : null;
  const originalJournal = journalSource
    ? decodeSeedSource(journalSource, journalSchema, context)
    : null;
  const legacyJournal = originalJournal?.schema_version === 1 ? originalJournal : null;
  let journal = originalJournal?.schema_version === 2 ? originalJournal : null;
  const coverage = coverageSource
    ? decodeSeedSource(coverageSource, SeedCoverageReportSchema, context)
    : null;
  if (precious && originalJournal && precious.install_nonce !== originalJournal.install_nonce)
    invalidSeed('Original seed state and journal install nonces conflict; resolve their ownership');
  if (legacyJournal) {
    precious ??= {
      schema_version: 1,
      install_nonce: legacyJournal.install_nonce,
      pr_context: legacyJournal.pr_context,
      pending_importance: legacyJournal.pending_importance,
      commit_graph_hint_shown: legacyJournal.commit_graph_hint_shown === true,
      discovery_areas: Object.fromEntries(
        legacyJournal.declined_discovery_areas
          .map((area) =>
            area.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
          )
          .filter(Boolean)
          .map((area) => [area, { declined_at: null }])
      ),
      updated_at: legacyJournal.updated_at,
    };
    journal = {
      schema_version: 2,
      install_nonce: legacyJournal.install_nonce,
      options_hash: legacyJournal.options_hash,
      updated_at: legacyJournal.updated_at,
      clusters: legacyJournal.clusters,
      jobs: {},
    };
  }
  const issues =
    sources.length && !precious ? ['Original seed install identity is unavailable'] : [];
  const view = {
    precious,
    journal,
    legacyJournal,
    coverage,
    completeness: { complete: issues.length === 0, issues },
  };
  const prepared = Object.freeze({});
  preparations.set(
    prepared,
    freezeSeed({
      ...context,
      sources: records,
      selected,
      view,
      contentHash: digest(Buffer.from(canonicalJson({ sources: records, selected }))),
    })
  );
  return prepared;
}
export function prepareProjectSeedState(input: PrepareProjectSeedState): PreparedProjectSeedState {
  return prepare(input, 'authored') as PreparedProjectSeedState;
}
export function prepareImportedProjectSeedState(
  input: PrepareImportedProjectSeedState
): PreparedImportedProjectSeedState {
  return prepare(input, 'historical') as PreparedImportedProjectSeedState;
}
export function seedStatePreparation(
  input: PreparedProjectSeedState | PreparedImportedProjectSeedState,
  mode: 'authored' | 'historical'
): SeedStatePreparation {
  const value = preparations.get(input);
  if (!value || value.mode !== mode)
    invalidSeed('Use a genuine seed preparation for the authorized publication path');
  return value;
}
