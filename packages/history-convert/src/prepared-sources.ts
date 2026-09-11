import { createHash } from 'node:crypto';
import path from 'node:path';

import { discoverLegacyRepository } from './discovery.js';
import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import {
  copyLegacyPreviewSources,
  type LegacyPreview,
  readLegacyPreviewArtifact,
  readLegacyPreviewRemote,
  readLegacyPreviewSeedState,
  readLegacyPreviewSqlite,
  readLegacyPreviewUsage,
} from './preview.js';
import {
  type LegacyFileIdentity,
  type LegacySourceDirectory,
  type LegacySourceFile,
  observeLegacySourceFile,
} from './source-files.js';

export interface PreparedLegacySources {
  readonly manifestSha256: string;
  readonly manifest: {
    readonly schema_version: 1;
    readonly profile: LegacyPreview['profile'];
    readonly preview_manifest_sha256: string;
    readonly decisions: { readonly sha256: string; readonly byte_length: number };
    readonly inventory_manifest_sha256: string;
    readonly root: { readonly resolvedRoot: string; readonly rootKey: string };
    readonly project_id: string | null;
    readonly git_common_dir: string;
    readonly git_inventory_hash: string;
    readonly git_resources_hash: string;
    readonly git_resources: readonly {
      readonly ref: string;
      readonly oid: string;
      readonly symbolicTarget: string | null;
    }[];
    readonly files: readonly {
      readonly location: string;
      readonly identity: Readonly<LegacyFileIdentity>;
      readonly sha256: string;
      readonly size: number;
    }[];
    readonly directories: readonly {
      readonly location: string;
      readonly identity: Readonly<LegacySourceDirectory['identity']>;
      readonly members: readonly string[];
    }[];
    readonly absent: readonly string[];
    readonly omitted: LegacyPreview['omitted'];
  };
}
const preparations = new WeakMap<
  PreparedLegacySources,
  {
    preview: LegacyPreview;
    source: ReturnType<typeof copyLegacyPreviewSources>;
    bytes: ReadonlyMap<string, string>;
  }
>();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function changed(): never {
  throw new HistoryConversionError(
    'SOURCE_CHANGED',
    'Original source changed after its reviewed preview'
  );
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function prepareLegacySources(
  preview: LegacyPreview,
  signal?: AbortSignal
): Promise<PreparedLegacySources> {
  const source = copyLegacyPreviewSources(preview);
  if (!preview.contentComplete) {
    const named = [
      ...preview.issues.map((issue) => `${issue.location} (${issue.code})`),
      ...preview.unclassified.map((entry) => `${entry.location} (unclassified)`),
    ];
    throw new HistoryConversionError(
      'SOURCE_UNAVAILABLE',
      'Conversion preparation requires complete verified source classification and choices' +
        (named.length ? `; unresolved: ${named.join(', ')}` : ''),
      named[0]
    );
  }
  signal?.throwIfAborted();
  const files = new Map<
    string,
    {
      root: string;
      file: LegacySourceFile;
      scope?: import('./source-omissions.js').LegacySourceScope | null;
    }
  >();
  const directories = new Map<string, Omit<LegacySourceDirectory, 'relativePath'>>();
  const absent = new Set<string>();
  const add = (
    root: string,
    file: LegacySourceFile,
    scope?: import('./source-omissions.js').LegacySourceScope | null
  ) => {
    const location = path.join(root, file.relativePath);
    const prior = files.get(location);
    if (
      prior &&
      !same(
        { identity: prior.file.identity, sha256: prior.file.sha256 },
        { identity: file.identity, sha256: file.sha256 }
      )
    )
      changed();
    files.set(location, { root, file, scope });
  };
  for (const entry of source.inventory.sources) {
    if (entry.state === 'unavailable')
      throw new HistoryConversionError('SOURCE_UNAVAILABLE', 'An original source is unavailable');
    if (entry.state === 'absent') absent.add(path.join(entry.root, entry.relativePath));
    if (entry.file) add(entry.root, entry.file);
    if (entry.inventory) {
      for (const file of entry.inventory.files)
        add(entry.inventory.root, file, entry.inventory.scope);
      for (const directory of entry.inventory.directories) {
        const location = path.join(entry.inventory.root, directory.relativePath);
        const prior = directories.get(location);
        const value = { identity: directory.identity, members: directory.members };
        if (prior && !same(prior, value)) changed();
        directories.set(location, value);
      }
    }
  }
  const retained = new Map<string, string>();
  const members: PreparedLegacySources['manifest']['files'][number][] = [];
  for (const [location, { root, file, scope }] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    const read = await observeLegacySourceFile({
      root,
      scope,
      relativePath: file.relativePath,
      includeBytes: true,
      signal,
    });
    if (!same(read.file, file)) changed();
    retained.set(location, read.bytes!.toString('base64'));
    members.push({
      location,
      identity: file.identity,
      sha256: file.sha256,
      size: read.bytes!.length,
    });
  }
  const after = await discoverLegacyRepository({ ...source.discoveryInput, signal });
  if (after.manifestHash !== source.inventory.manifestHash) changed();
  const decisions = reviewedDecisions(preview);
  const manifest = freeze({
    schema_version: 1 as const,
    profile: preview.profile,
    preview_manifest_sha256: preview.manifestHash,
    decisions: {
      sha256: createHash('sha256').update(decisions).digest('hex'),
      byte_length: decisions.length,
    },
    inventory_manifest_sha256: source.inventory.manifestHash,
    root: { ...source.inventory.root },
    project_id: source.inventory.projectId,
    git_common_dir: source.inventory.current.commonDir,
    git_inventory_hash: source.inventory.gitInventoryHash,
    git_resources_hash: source.inventory.gitResourcesHash,
    git_resources: source.inventory.gitResources.map((resource) => ({ ...resource })),
    files: members,
    directories: [...directories]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([location, value]) => ({ location, ...value })),
    omitted: source.inventory.omitted,
    absent: [...absent].sort(),
  });
  const prepared = Object.freeze({
    manifestSha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
    manifest,
  });
  preparations.set(prepared, { preview, source, bytes: retained });
  return prepared;
}

// Canonical target presence is observed by name, never as a source, so it stays out of the
// reviewed decisions exactly as it stays out of the inventory manifest. Including it would make
// the prepared source hash change the moment the conversion creates its own target, and a retry
// by the original operation ID would then look like a different conversion.
function reviewedDecisions(preview: LegacyPreview): Buffer {
  const { target: _target, ...reviewed } = preview;
  return Buffer.from(canonicalJson(reviewed));
}

export function readPreparedLegacyDecisions(prepared: PreparedLegacySources): Buffer {
  assertPreparedLegacySources(prepared);
  return reviewedDecisions(preparations.get(prepared)!.preview);
}

export function readPreparedLegacyArtifact(prepared: PreparedLegacySources, artifactId: string) {
  assertPreparedLegacySources(prepared);
  return readLegacyPreviewArtifact(preparations.get(prepared)!.preview, artifactId);
}

export function assertPreparedLegacySources(prepared: PreparedLegacySources): void {
  if (!preparations.has(prepared))
    throw new HistoryConversionError(
      'SOURCE_INTEGRITY',
      'Conversion preparation requires genuinely verified original bytes'
    );
}

export function readPreparedLegacySource(
  prepared: PreparedLegacySources,
  location: string
): Buffer {
  assertPreparedLegacySources(prepared);
  const bytes = preparations.get(prepared)!.bytes.get(location);
  if (bytes === undefined)
    throw new HistoryConversionError(
      'SOURCE_UNAVAILABLE',
      'Original member is not covered by the prepared source manifest',
      location
    );
  return Buffer.from(bytes, 'base64');
}

export function readPreparedLegacyUsage(prepared: PreparedLegacySources) {
  assertPreparedLegacySources(prepared);
  return readLegacyPreviewUsage(preparations.get(prepared)!.preview);
}

export function readPreparedLegacySeedState(prepared: PreparedLegacySources) {
  assertPreparedLegacySources(prepared);
  return readLegacyPreviewSeedState(preparations.get(prepared)!.preview);
}

export function readPreparedLegacyRemote(prepared: PreparedLegacySources) {
  assertPreparedLegacySources(prepared);
  return readLegacyPreviewRemote(preparations.get(prepared)!.preview);
}

export function readPreparedLegacySqlite(prepared: PreparedLegacySources) {
  assertPreparedLegacySources(prepared);
  return readLegacyPreviewSqlite(preparations.get(prepared)!.preview);
}
