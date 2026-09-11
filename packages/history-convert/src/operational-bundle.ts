import { createHash } from 'node:crypto';

import { HistoryConversionError } from './errors.js';
import { isUuidV7 } from './legacy/storage/ids/uuidv7.js';
import { canonicalizeBaseUrl } from './legacy-operations/storage/source-plan/canonical-base-url.js';
import {
  decodeLegacyOperationalFile,
  type LegacyOperationalFile,
  type LegacyOperationalKind,
} from './operational.js';

export interface LegacyOperationalMember {
  readonly relativePath: string;
  readonly bytes: Buffer;
}
export interface LegacyOperationalGraph {
  readonly kind: 'source-plan' | 'seed';
  readonly integrity: 'reference_graph';
  readonly members: readonly {
    readonly relativePath: string;
    readonly sha256: string;
    readonly bytesBase64: string;
    readonly file: LegacyOperationalFile | null;
  }[];
  readonly references: readonly {
    readonly from: string;
    readonly to: string;
    readonly relation: 'approved-plan' | 'bundle-input' | 'authored-enrichment';
  }[];
  readonly unknownIdentity: readonly string[];
  readonly authoredInputs: readonly {
    readonly relativePath: string;
    readonly selection: 'matching' | 'unmatched' | 'rejected';
    readonly reasons: readonly (
      | 'duplicate-cluster'
      | 'options-mismatch'
      | 'checkpoint-count-mismatch'
    )[];
    readonly acceptance: 'not-established';
  }[];
}
const graphs = new WeakSet<LegacyOperationalGraph>();
const hex = '[0-9a-f]{64}';
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const namespace = (value: Record<string, unknown>) =>
  hash(`${canonicalizeBaseUrl(value.base_url as string)}|${value.org_id as string}`);

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

export function decodeLegacyOperationalBundle(input: {
  kind: LegacyOperationalGraph['kind'];
  members: readonly LegacyOperationalMember[];
}): LegacyOperationalGraph {
  const kind = input.kind;
  if (!['source-plan', 'seed'].includes(kind))
    fail('operational', 'Operational bundle kind is unsupported');
  const bytes = new Map<string, Buffer>();
  for (const member of input.members) {
    const name = member.relativePath;
    if (
      !name ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').some((part) => !part || part === '.' || part === '..') ||
      bytes.has(name)
    )
      fail(name, 'Operational member paths must be distinct safe relative paths');
    bytes.set(name, Buffer.from(member.bytes));
  }
  const files = new Map<string, LegacyOperationalFile | null>();
  const references: LegacyOperationalGraph['references'][number][] = [];
  const unknownIdentity: string[] = [];
  const authoredInputs: LegacyOperationalGraph['authoredInputs'][number][] = [];
  const decode = (name: string, resource: LegacyOperationalKind): Record<string, unknown> => {
    const source = bytes.get(name);
    if (!source) fail(name, 'Operational reference names a missing retained member', true);
    const file = decodeLegacyOperationalFile(resource, source);
    files.set(name, file);
    return file.value as Record<string, unknown>;
  };
  const equalPath = (name: string, expected: string) => {
    if (name !== expected)
      fail(name, 'Operational identity disagrees with its recorded namespace or key');
  };
  const text = (name: string) => {
    const source = bytes.get(name);
    if (!source) fail(name, 'Operational reference names a missing retained member', true);
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
    } catch {
      fail(name, 'Retained operational text is not complete UTF-8');
    }
    files.set(name, null);
  };
  const names = [...bytes.keys()].sort();
  if (kind === 'source-plan') {
    for (const name of names) {
      if (new RegExp(`^pull/${hex}/by-id/${hex}@[1-9][0-9]*\\.json$`).test(name)) {
        const value = decode(name, 'source_plan_pull');
        equalPath(
          name,
          `pull/${namespace(value)}/by-id/${hash(value.external_id as string)}@${value.version_number}.json`
        );
      } else if (
        new RegExp(`^review-pull/${hex}/(?:by-id|by-proposal)/${hex}\\.json$`).test(name)
      ) {
        const value = decode(name, 'source_plan_review_pull');
        const target =
          value.target === 'candidate'
            ? `by-id/${hash(value.external_id as string)}`
            : `by-proposal/${hash(value.proposal_id as string)}`;
        equalPath(name, `review-pull/${namespace(value)}/${target}.json`);
      } else if (new RegExp(`^uploads/${hex}\\.json$`).test(name)) {
        decode(name, 'source_plan_upload');
        // The old index retains only a hash of server/org/path, so none can be inferred from its payload.
        unknownIdentity.push(name);
      }
    }
    for (const name of names) {
      const pointer = new RegExp(`^pull/(${hex})/by-path/${hex}\\.json$`).exec(name);
      if (!pointer) continue;
      const value = decode(name, 'source_plan_path');
      const target = `pull/${pointer[1]}/by-id/${hash(value.external_id as string)}@${value.version_number}.json`;
      if (!files.has(target))
        fail(name, 'Source-plan pointer names a missing verified approved record', true);
      references.push({ from: name, to: target, relation: 'approved-plan' });
      unknownIdentity.push(name);
    }
  } else {
    if (bytes.has('journal.json')) decode('journal.json', 'seed_journal');
    if (bytes.has('coverage.json')) decode('coverage.json', 'seed_coverage');
    const bundleRoots = new Set<string>();
    for (const name of names) {
      if (name.startsWith('pending/')) bundleRoots.add('pending');
      const amend = /^amend\/([^/]+)\//.exec(name);
      if (amend) {
        if (!isUuidV7(amend[1]!)) fail(name, 'Seed amendment path does not name a valid artifact');
        bundleRoots.add(`amend/${amend[1]}`);
      }
      const retained = /^enrichment\/([^/]+)\.json$/.exec(name);
      if (retained) {
        if (!isUuidV7(retained[1]!))
          fail(name, 'Seed enrichment path does not name a valid artifact');
        decode(name, 'seed_enrichment_retained');
      }
    }
    for (const root of [...bundleRoots].sort()) {
      const manifestPath = `${root}/manifest.json`;
      const manifest = decode(manifestPath, 'seed_bundle');
      const amendment = manifest.amendment as { artifact_id: string } | undefined;
      if (
        (root === 'pending' && amendment !== undefined) ||
        (root.startsWith('amend/') && amendment?.artifact_id !== root.slice(6))
      )
        fail(manifestPath, 'Seed manifest belongs to another workflow or artifact');
      const entries = manifest.bundles as {
        filename: string;
        artifact_id: string;
        cluster_key: string;
        checkpoint_count: number;
      }[];
      const clusters = new Map<string, (typeof entries)[number]>();
      const artifactIds = new Set<string>();
      const filenames = new Set<string>();
      for (const entry of entries) {
        if (
          !isUuidV7(entry.artifact_id) ||
          !entry.filename.endsWith('.md') ||
          entry.filename.includes('/') ||
          entry.filename.includes('\\') ||
          entry.filename !== `${encodeURIComponent(entry.cluster_key)}.md` ||
          clusters.has(entry.cluster_key) ||
          artifactIds.has(entry.artifact_id) ||
          filenames.has(entry.filename)
        )
          fail(manifestPath, 'Seed manifest repeats or changes a source bundle identity');
        if (amendment && entry.artifact_id !== amendment.artifact_id)
          fail(manifestPath, 'Seed amendment bundle belongs to another artifact');
        clusters.set(entry.cluster_key, entry);
        artifactIds.add(entry.artifact_id);
        filenames.add(entry.filename);
        const target = `${root}/${entry.filename}`;
        text(target);
        references.push({ from: manifestPath, to: target, relation: 'bundle-input' });
      }
      const authored = new Map<string, { name: string; value: Record<string, unknown> }[]>();
      for (const name of names.filter(
        (name) =>
          name.startsWith(root + '/') &&
          name !== manifestPath &&
          !name.slice(root.length + 1).includes('/') &&
          name.endsWith('.json')
      )) {
        const value = decode(name, 'seed_enrichment');
        const cluster = value.cluster_key as string;
        authored.set(cluster, [...(authored.get(cluster) ?? []), { name, value }]);
      }
      for (const [cluster, inputs] of authored) {
        const entry = clusters.get(cluster);
        for (const { name, value } of inputs) {
          const reasons: LegacyOperationalGraph['authoredInputs'][number]['reasons'][number][] = [];
          if (entry) {
            if (inputs.length > 1) reasons.push('duplicate-cluster');
            if (value.options_hash !== manifest.options_hash) reasons.push('options-mismatch');
            if (
              (value.steps as unknown[]).length !== entry.checkpoint_count ||
              (value.checkpoint_summaries as unknown[]).length !== entry.checkpoint_count
            )
              reasons.push('checkpoint-count-mismatch');
            references.push({
              from: name,
              to: `${root}/${entry.filename}`,
              relation: 'authored-enrichment',
            });
          } else unknownIdentity.push(name);
          authoredInputs.push({
            relativePath: name,
            selection: !entry ? 'unmatched' : reasons.length ? 'rejected' : 'matching',
            reasons,
            acceptance: 'not-established',
          });
        }
      }
    }
  }
  for (const name of names)
    if (!files.has(name))
      fail(name, 'Retained operational member is not part of the complete frozen profile');
  const graph = freeze({
    kind,
    integrity: 'reference_graph' as const,
    members: names.map((relativePath) => ({
      relativePath,
      sha256: hash(bytes.get(relativePath)!),
      bytesBase64: bytes.get(relativePath)!.toString('base64'),
      file: files.get(relativePath)!,
    })),
    references,
    unknownIdentity,
    authoredInputs,
  });
  graphs.add(graph);
  return graph;
}

export function assertDecodedLegacyOperationalBundle(graph: LegacyOperationalGraph): void {
  if (!graphs.has(graph))
    fail('operational', 'Operational references require a genuinely decoded bundle');
}
