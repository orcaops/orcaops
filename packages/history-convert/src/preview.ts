import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  assertDecodedLegacyArtifactBundle,
  decodeLegacyArtifactBundle,
  type LegacyArtifactBundle,
} from './artifact-bundle.js';
import { discoverLegacyRepository, type LegacyRepositoryInventory } from './discovery.js';
import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import {
  assertDecodedLegacyOperationalBundle,
  decodeLegacyOperationalBundle,
  type LegacyOperationalGraph,
} from './operational-bundle.js';
import {
  assertDecodedLegacyOperationalFile,
  decodeLegacyOperationalFile,
  type LegacyOperationalFile,
} from './operational.js';
import { LEGACY_PROFILE_ID } from './profile.js';
import {
  type LegacyLogSelection,
  type LegacyRepresentationChoice,
  selectLegacyRepresentation,
} from './representation.js';
import { type LegacySourceFile, observeLegacySourceFile } from './source-files.js';
import { assertDecodedLegacySqlite, decodeLegacySqlite, type LegacySqlite } from './sqlite.js';
import { decodeLegacyUsageBundle, type LegacyUsageBundle } from './usage-bundle.js';
import {
  assertLegacyUsageSelection,
  type LegacyUsageChoice,
  type LegacyUsageSelection,
  selectLegacyUsage,
} from './usage-selection.js';

interface SourceMember {
  root: string;
  relativePath: string;
  file: LegacySourceFile;
  scope?: import('./source-omissions.js').LegacySourceScope | null;
}
export interface LegacyPreviewResource {
  readonly source: string;
  readonly kind: 'artifact' | 'usage' | 'source-plan' | 'seed' | 'seed-state' | 'sqlite';
  readonly id: string | null;
  readonly state: 'verified' | 'unavailable';
  readonly sourceHash: string | null;
  readonly files: number;
  readonly records: number | null;
  readonly fidelity: LegacyArtifactBundle['auxiliaries'];
}
export interface LegacyPreviewRetained {
  readonly location: string;
  readonly family:
    | 'installer'
    | 'evaluator-config'
    | 'scratch'
    | 'artifact-backup'
    | 'filesystem-metadata';
  readonly sha256: string;
}
export interface LegacyPreview {
  readonly profile: typeof LEGACY_PROFILE_ID;
  readonly producerEvidence: 'unknown';
  readonly manifestHash: string;
  readonly projectId: string | null;
  readonly inventoryComplete: boolean;
  readonly contentComplete: boolean;
  readonly verifiedEmpty: boolean;
  readonly activationEligible: false;
  readonly omitted: LegacyRepositoryInventory['omitted'];
  readonly retained: readonly LegacyPreviewRetained[];
  readonly target: LegacyRepositoryInventory['target'];
  readonly gitResources: readonly {
    readonly ref: string;
    readonly oid: string;
    readonly symbolicTarget: string | null;
    readonly ownership: 'unknown';
  }[];
  readonly resources: readonly LegacyPreviewResource[];
  readonly representations: readonly {
    readonly artifactId: string;
    readonly selection: Omit<LegacyLogSelection, 'log'>;
  }[];
  readonly usageSelection: Pick<
    LegacyUsageSelection,
    'manifestHash' | 'counts' | 'records' | 'occurrences'
  > | null;
  readonly issues: readonly { location: string; code: string; reason: string }[];
  readonly unclassified: readonly { location: string; sha256: string }[];
}
const previews = new WeakMap<
  LegacyPreview,
  {
    inventory: LegacyRepositoryInventory;
    resources: ReadonlyMap<string, unknown>;
    selections: ReadonlyMap<string, LegacyLogSelection>;
    usageSelection: LegacyUsageSelection | null;
    discoveryInput: Parameters<typeof discoverLegacyRepository>[0];
  }
>();
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function changed(): never {
  throw new HistoryConversionError('SOURCE_CHANGED', 'Retained sources changed during preview');
}

export async function previewLegacyRepository(
  input: Parameters<typeof discoverLegacyRepository>[0] & {
    artifactRepresentations?: readonly {
      readonly artifactId: string;
      readonly choice: LegacyRepresentationChoice;
    }[];
    usageRepresentations?: readonly LegacyUsageChoice[];
  }
): Promise<LegacyPreview> {
  const options = {
    ...input,
    env: { ...(input.env ?? process.env) },
    additionalCheckouts: [...(input.additionalCheckouts ?? [])],
    additionalSourcePaths: [...(input.additionalSourcePaths ?? [])],
    artifactRepresentations: (input.artifactRepresentations ?? []).map(
      ({ artifactId, choice }) => ({
        artifactId,
        choice: {
          sourceId: choice.sourceId,
          sources: choice.sources.map((source) => ({ ...source })),
        },
      })
    ),
    usageRepresentations: (input.usageRepresentations ?? []).map((choice) => ({
      ...choice,
      sources: choice.sources.map((source) => ({ ...source })),
    })),
  };
  const inventory = await discoverLegacyRepository(options);
  const members = new Map<string, SourceMember>();
  const directories = new Set<string>();
  for (const source of inventory.sources) {
    if (source.file)
      members.set(path.join(source.root, source.relativePath), {
        root: source.root,
        relativePath: source.relativePath,
        file: source.file,
      });
    for (const file of source.inventory?.files ?? []) {
      const absolute = path.join(source.inventory!.root, file.relativePath);
      const existing = members.get(absolute);
      if (existing && canonicalJson(existing.file.identity) !== canonicalJson(file.identity))
        changed();
      members.set(absolute, {
        root: source.inventory!.root,
        relativePath: file.relativePath,
        file,
        scope: source.inventory!.scope,
      });
    }
    for (const directory of source.inventory?.directories ?? [])
      directories.add(path.join(source.inventory!.root, directory.relativePath));
  }
  const used = new Set<string>();
  const parsed = new Map<string, unknown>();
  const resources: LegacyPreviewResource[] = [];
  const issues = [...inventory.issues] as { location: string; code: string; reason: string }[];
  const bytes = async (absolute: string) => {
    options.signal?.throwIfAborted();
    const member = members.get(absolute);
    if (!member)
      throw new HistoryConversionError(
        'SOURCE_UNAVAILABLE',
        'Expected retained member is absent',
        absolute
      );
    const read = await observeLegacySourceFile({
      root: member.root,
      scope: member.scope,
      relativePath: member.relativePath,
      includeBytes: true,
      signal: options.signal,
    });
    if (canonicalJson(read.file) !== canonicalJson(member.file)) changed();
    return read.bytes!;
  };
  const under = (root: string) =>
    [...members.keys()]
      .filter((name) => name.startsWith(root + path.sep) && path.basename(name) !== '.DS_Store')
      .sort();
  const group = async (
    root: string,
    kind: LegacyPreviewResource['kind'],
    id: string | null,
    names: readonly string[],
    decode: (files: Map<string, Buffer>) =>
      | {
          value: unknown;
          records: number | null;
          sourceHash?: string;
          fidelity?: LegacyArtifactBundle['auxiliaries'];
        }
      | Promise<{
          value: unknown;
          records: number | null;
          sourceHash?: string;
          fidelity?: LegacyArtifactBundle['auxiliaries'];
        }>
  ) => {
    for (const name of names) {
      if (used.has(name))
        throw new HistoryConversionError(
          'SOURCE_CONFLICT',
          'Configured resource locations overlap',
          root
        );
      used.add(name);
    }
    try {
      const files = new Map<string, Buffer>();
      for (const name of names)
        files.set(path.relative(root, name).split(path.sep).join('/'), await bytes(name));
      const decoded = await decode(files);
      parsed.set(root, decoded.value);
      resources.push({
        source: root,
        kind,
        id,
        state: 'verified',
        sourceHash: decoded.sourceHash ?? null,
        files: files.size,
        records: decoded.records,
        fidelity: decoded.fidelity ?? [],
      });
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof HistoryConversionError && error.code === 'SOURCE_CHANGED')
      )
        throw error;
      issues.push({
        location: root,
        code: error instanceof HistoryConversionError ? error.code : 'SOURCE_INTEGRITY',
        reason:
          error instanceof HistoryConversionError
            ? error.message
            : 'Retained resource could not be verified against its frozen profile',
      });
      resources.push({
        source: root,
        kind,
        id,
        state: 'unavailable',
        sourceHash: null,
        files: names.length,
        records: null,
        fidelity: [],
      });
    }
  };
  const requireFile = (files: Map<string, Buffer>, name: string) => {
    const value = files.get(name);
    if (!value)
      throw new HistoryConversionError(
        'SOURCE_UNAVAILABLE',
        'Expected retained dependency is absent',
        name
      );
    return value;
  };
  for (const layout of inventory.layouts) {
    if (layout.configuration)
      used.add(path.join(layout.configuration.root, layout.configuration.relativePath));
    const artifactRoot = path.join(layout.root, layout.artifacts);
    const ids = new Set(
      [...under(artifactRoot), ...directories]
        .filter((name) => name.startsWith(artifactRoot + path.sep))
        .map((name) => path.relative(artifactRoot, name).split(path.sep)[0]!)
    );
    for (const id of [...ids].sort()) {
      const resourceRoot = path.join(artifactRoot, id);
      await group(resourceRoot, 'artifact', id, under(resourceRoot), async (files) => {
        const value = await decodeLegacyArtifactBundle({
          artifactId: id,
          members: [...files].map(([relativePath, bytes]) => ({ relativePath, bytes })),
        });
        return {
          value,
          records: value.artifact.log.events.length,
          fidelity: value.auxiliaries,
          sourceHash: value.artifact.log.sha256,
        };
      });
    }
    const usageRoot = path.join(layout.root, layout.usage);
    const usage = under(usageRoot);
    if (usage.length)
      await group(usageRoot, 'usage', null, usage, (files) => {
        const value = decodeLegacyUsageBundle(
          [...files].map(([relativePath, bytes]) => ({ relativePath, bytes }))
        );
        return { value, records: value.events.length, sourceHash: value.sha256 };
      });
    for (const [relative, kind] of [
      [layout.sourcePlan, 'source-plan'],
      [layout.seed, 'seed'],
    ] as const) {
      if (!relative) continue;
      const root = path.join(layout.root, relative);
      const names = under(root);
      if (names.length)
        await group(root, kind, null, names, (files) => {
          const value = decodeLegacyOperationalBundle({
            kind,
            members: [...files].map(([relativePath, bytes]) => ({ relativePath, bytes })),
          });
          return { value, records: value.members.filter((member) => member.file !== null).length };
        });
    }
    if (layout.seedState) {
      const name = path.join(layout.root, layout.seedState);
      if (members.has(name))
        await group(name, 'seed-state', null, [name], (files) => ({
          value: decodeLegacyOperationalFile('seed_state', requireFile(files, '')),
          records: 1,
        }));
    }
    if (layout.sqlite) {
      const name = path.join(layout.root, layout.sqlite);
      const names = [name, name + '-wal', name + '-shm', name + '-journal'].filter((file) =>
        members.has(file)
      );
      if (names.length)
        await group(path.dirname(name), 'sqlite', null, names, (files) => {
          const basename = path.basename(name);
          const value = decodeLegacySqlite({
            main: requireFile(files, basename),
            wal: files.get(basename + '-wal'),
            shm: files.get(basename + '-shm'),
            rollbackJournal: files.get(basename + '-journal'),
          });
          return {
            value,
            records: Object.values(value.rows).reduce((sum, rows) => sum + rows.length, 0),
          };
        });
    }
  }
  // Installer manifests, evaluator configuration and scratch state belong to the
  // installation owner: retained by hash, never decoded, never converted.
  const retained: LegacyPreviewRetained[] = [];
  for (const [location, member] of members) {
    if (used.has(location) || path.basename(location) !== '.DS_Store') continue;
    used.add(location);
    retained.push({ location, family: 'filesystem-metadata', sha256: member.file.sha256 });
  }
  for (const layout of inventory.layouts) {
    if (layout.kind !== 'checkout') continue;
    for (const [absolute, member] of members) {
      if (used.has(absolute) || !absolute.startsWith(layout.root + path.sep)) continue;
      const relative = path.relative(layout.root, absolute).split(path.sep).join('/');
      const family =
        relative === '.orcaops/install.json' || relative === '.orcaops/install.local.json'
          ? 'installer'
          : relative === '.orcaops/evaluators.yaml'
            ? 'evaluator-config'
            : relative.startsWith('.orcaops/tmp/')
              ? 'scratch'
              : relative === '.orcaops/artifacts.zip'
                ? 'artifact-backup'
                : path.posix.basename(relative) === '.DS_Store'
                  ? 'filesystem-metadata'
                  : null;
      if (!family) continue;
      used.add(absolute);
      retained.push({ location: absolute, family, sha256: member.file.sha256 });
    }
  }
  retained.sort((a, b) => a.location.localeCompare(b.location));
  const selections = new Map<string, LegacyLogSelection>();
  const representations: LegacyPreview['representations'][number][] = [];
  const artifactIds = new Set(
    resources.filter((resource) => resource.kind === 'artifact').map((resource) => resource.id!)
  );
  for (const artifactId of artifactIds) {
    const copies = resources.filter(
      (resource) => resource.kind === 'artifact' && resource.id === artifactId
    );
    const choices = options.artifactRepresentations.filter(
      (entry) => entry.artifactId === artifactId
    );
    try {
      if (choices.length > 1)
        throw new HistoryConversionError(
          'SOURCE_CONFLICT',
          'Artifact representation choice is repeated'
        );
      if (copies.some((copy) => copy.state !== 'verified')) continue;
      const selection = selectLegacyRepresentation(
        copies.map((copy) => ({
          sourceId: copy.source,
          log: (parsed.get(copy.source) as LegacyArtifactBundle).artifact.log,
        })),
        choices[0]?.choice
      );
      selections.set(artifactId, selection);
      const { log: _log, ...evidence } = selection;
      representations.push({ artifactId, selection: evidence });
    } catch (error) {
      issues.push({
        location: artifactId,
        code: error instanceof HistoryConversionError ? error.code : 'SOURCE_INTEGRITY',
        reason:
          error instanceof HistoryConversionError
            ? error.message
            : 'Retained artifact representations could not be selected',
      });
    }
  }
  for (const entry of options.artifactRepresentations)
    if (!artifactIds.has(entry.artifactId))
      issues.push({
        location: entry.artifactId,
        code: 'SOURCE_CONFLICT',
        reason: 'Reviewed artifact source is not present in the complete inventory',
      });
  let selectedUsage: LegacyUsageSelection | null = null;
  const usageCopies = resources.filter((resource) => resource.kind === 'usage');
  if (usageCopies.length && usageCopies.every((resource) => resource.state === 'verified')) {
    try {
      selectedUsage = selectLegacyUsage(
        usageCopies.map((resource) => ({
          sourceId: resource.source,
          bundle: parsed.get(resource.source) as LegacyUsageBundle,
        })),
        options.usageRepresentations
      );
    } catch (error) {
      issues.push({
        location: 'usage',
        code: error instanceof HistoryConversionError ? error.code : 'SOURCE_INTEGRITY',
        reason:
          error instanceof HistoryConversionError
            ? error.message
            : 'Retained usage sources could not be selected',
      });
    }
  } else if (!usageCopies.length && options.usageRepresentations.length) {
    issues.push({
      location: 'usage',
      code: 'SOURCE_CONFLICT',
      reason: 'Reviewed usage sources are absent from the complete inventory',
    });
  }
  const usageSelection = selectedUsage
    ? {
        manifestHash: selectedUsage.manifestHash,
        counts: selectedUsage.counts,
        records: selectedUsage.records,
        occurrences: selectedUsage.occurrences,
      }
    : null;
  for (const source of inventory.sources)
    if (
      source.kind === 'catalog' &&
      source.file &&
      !inventory.issues.some((issue) => issue.location === 'projects.json')
    )
      used.add(path.join(source.root, source.relativePath));
  const unclassified = [...members]
    .filter(([name]) => !used.has(name))
    .map(([location, member]) => ({ location, sha256: member.file.sha256 }))
    .sort((a, b) => a.location.localeCompare(b.location));
  const after = await discoverLegacyRepository(options);
  if (after.manifestHash !== inventory.manifestHash) changed();
  const contentComplete =
    inventory.inventoryComplete && issues.length === 0 && unclassified.length === 0;
  const report: LegacyPreview = freeze({
    profile: LEGACY_PROFILE_ID,
    producerEvidence: 'unknown' as const,
    manifestHash: createHash('sha256')
      .update(
        canonicalJson({
          source: inventory.manifestHash,
          resources,
          representations,
          usageSelection,
          issues,
          unclassified,
          retained,
        })
      )
      .digest('hex'),
    projectId: inventory.projectId,
    omitted: inventory.omitted,
    retained,
    target: inventory.target,
    inventoryComplete: inventory.inventoryComplete,
    contentComplete,
    verifiedEmpty: contentComplete && resources.length === 0 && inventory.gitResources.length === 0,
    activationEligible: false as const,
    gitResources: inventory.gitResources.map((resource) => ({
      ...resource,
      ownership: 'unknown' as const,
    })),
    resources,
    representations,
    usageSelection,
    issues,
    unclassified,
  });
  previews.set(report, {
    inventory,
    resources: parsed,
    selections,
    usageSelection: selectedUsage,
    discoveryInput: options,
  });
  return report;
}

export function assertLegacyPreview(preview: LegacyPreview): void {
  if (!previews.has(preview))
    throw new HistoryConversionError(
      'SOURCE_INTEGRITY',
      'Preview requires independently inspected source evidence'
    );
}

export function copyLegacyPreviewSources(preview: LegacyPreview) {
  assertLegacyPreview(preview);
  const state = previews.get(preview)!;
  return {
    inventory: structuredClone(state.inventory),
    discoveryInput: {
      ...state.discoveryInput,
      env: { ...state.discoveryInput.env },
      additionalCheckouts: [...(state.discoveryInput.additionalCheckouts ?? [])],
      additionalSourcePaths: [...(state.discoveryInput.additionalSourcePaths ?? [])],
    },
  };
}

export function readLegacyPreviewArtifact(preview: LegacyPreview, artifactId: string) {
  assertLegacyPreview(preview);
  const state = previews.get(preview)!;
  const selection = state.selections.get(artifactId);
  if (!preview.contentComplete || !selection)
    throw new HistoryConversionError(
      'SOURCE_UNAVAILABLE',
      'Artifact has no complete reviewed representation'
    );
  const bundle = state.resources.get(selection.sourceId) as LegacyArtifactBundle;
  assertDecodedLegacyArtifactBundle(bundle);
  if (bundle.artifact.log !== selection.log)
    throw new HistoryConversionError(
      'SOURCE_INTEGRITY',
      'Selected artifact differs from its original bundle'
    );
  return Object.freeze({ selection, bundle });
}

export function readLegacyPreviewUsage(preview: LegacyPreview): LegacyUsageSelection | null {
  assertLegacyPreview(preview);
  if (!preview.contentComplete)
    throw new HistoryConversionError(
      'SOURCE_UNAVAILABLE',
      'Usage has no complete reviewed source selection'
    );
  const selection = previews.get(preview)!.usageSelection;
  if (selection) assertLegacyUsageSelection(selection);
  return selection;
}

export function readLegacyPreviewSeedState(preview: LegacyPreview) {
  assertLegacyPreview(preview);
  if (!preview.contentComplete)
    throw new HistoryConversionError('SOURCE_UNAVAILABLE', 'Seed sources are not complete');
  const result: {
    key: 'precious' | 'journal' | 'coverage';
    originalPath: string;
    file: LegacyOperationalFile;
  }[] = [];
  const resources = previews.get(preview)!.resources;
  for (const resource of preview.resources) {
    if (resource.kind === 'seed-state') {
      const file = resources.get(resource.source) as LegacyOperationalFile;
      assertDecodedLegacyOperationalFile(file);
      result.push({ key: 'precious', originalPath: resource.source, file });
    } else if (resource.kind === 'seed') {
      const graph = resources.get(resource.source) as LegacyOperationalGraph;
      assertDecodedLegacyOperationalBundle(graph);
      for (const member of graph.members) {
        const key =
          member.relativePath === 'journal.json'
            ? 'journal'
            : member.relativePath === 'coverage.json'
              ? 'coverage'
              : null;
        if (!key) continue;
        const file = member.file!;
        assertDecodedLegacyOperationalFile(file);
        result.push({ key, originalPath: path.join(resource.source, member.relativePath), file });
      }
    }
  }
  return freeze(result);
}

export function readLegacyPreviewSqlite(preview: LegacyPreview) {
  assertLegacyPreview(preview);
  if (!preview.contentComplete)
    throw new HistoryConversionError('SOURCE_UNAVAILABLE', 'SQLite sources are not complete');
  const resources = previews.get(preview)!.resources;
  return freeze(
    preview.resources
      .filter((resource) => resource.kind === 'sqlite')
      .map((resource) => {
        const sqlite = resources.get(resource.source) as LegacySqlite;
        assertDecodedLegacySqlite(sqlite);
        return { source: resource.source, sqlite };
      })
  );
}

export function readLegacyPreviewRemote(preview: LegacyPreview) {
  assertLegacyPreview(preview);
  if (!preview.contentComplete)
    throw new HistoryConversionError('SOURCE_UNAVAILABLE', 'Remote sources are not complete');
  const resources = previews.get(preview)!.resources;
  return freeze(
    preview.resources
      .filter((resource) => resource.kind === 'source-plan')
      .map((resource) => {
        const graph = resources.get(resource.source) as LegacyOperationalGraph;
        assertDecodedLegacyOperationalBundle(graph);
        return { source: resource.source, graph };
      })
  );
}
