import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  assertNoSecretsInPayload,
  atomicWriteFile,
  canonicalJson,
  computeMemberShasHash,
  findArtifactScopedReplay,
  GitImportEnrichmentInvalidTargetError,
  GitImportEnrichmentLegacyError,
  type GitImportEnrichmentPayload,
  GitImportEnrichmentPayloadSchema,
  GitImportEnrichmentValidationError,
  type GitImportEnrichmentWriteResult,
  PlanInputSchema,
  SecretInPayloadError,
  StaleGitImportEnrichmentError,
  uuidv7,
} from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  appendProjectImportedArtifact,
  prepareProjectSeedBundle,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  type ProjectSeedBundleSnapshot,
  publishProjectSeedBundle,
  readProjectArtifact,
  readProjectSeedBundle,
  refuseJsonBytes,
  type SeedBundleIdentity,
  type SeedBundleSource,
} from '@orcaops/storage/history/database';
import { digest, encodeArtifactEvent } from '@orcaops/storage/history/primitives';
import {
  type PersistedSeedEnrichment,
  PersistedSeedEnrichmentSchema,
  type SeedEnrichmentManifest,
  SeedEnrichmentManifestSchema,
} from '@orcaops/storage/history/seed-schema';

import type { SeedEnrichContext, SeedEnrichPersistence } from '../commands/seed/enrich.js';
import {
  type SeedBundlePersistence,
  type SeedBundlePreparationInput,
  type SeedBundleWriteResult,
  type SeedEnrichmentPersistence,
  splitEvidenceCitation,
} from '../commands/seed/enrichment.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

const manifestFilename = 'manifest.json';

export interface PreparedDatabaseSeedEnrichmentSources {
  readonly directory: string;
  readonly sources: readonly {
    originalPath: string;
    bytes: Buffer | null;
    readError: string | null;
  }[];
}

export async function prepareDatabaseSeedEnrichmentSources(input: {
  directory: string;
  secretAllow: readonly string[];
}): Promise<PreparedDatabaseSeedEnrichmentSources> {
  const directory = path.resolve(input.directory);
  let entries;
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== manifestFilename
      )
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
      return Object.freeze({ directory, sources: Object.freeze([]) });
    throw cause;
  }
  const sources = [] as Array<{
    originalPath: string;
    bytes: Buffer | null;
    readError: string | null;
  }>;
  for (const entry of entries) {
    const originalPath = path.join(directory, entry.name);
    try {
      assertNoSecretsInPayload({ source_location: originalPath }, input.secretAllow);
      const bytes = await readFile(originalPath);
      refuseJsonBytes(bytes, input.secretAllow);
      sources.push({ originalPath, bytes: Buffer.from(bytes), readError: null });
    } catch (cause) {
      if (cause instanceof SecretInPayloadError)
        throw new ProjectDatabaseError('SECRET_IN_PAYLOAD', cause.message, { cause });
      if (cause instanceof ProjectDatabaseError && cause.code === 'SECRET_IN_PAYLOAD') throw cause;
      sources.push({
        originalPath,
        bytes: null,
        readError: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return Object.freeze({
    directory,
    sources: Object.freeze(sources.map((source) => Object.freeze(source))),
  });
}

function semanticEnrichment(bytes: Buffer): string {
  const { enriched_at: _at, ...value } = PersistedSeedEnrichmentSchema.parse(
    JSON.parse(bytes.toString('utf8'))
  );
  return canonicalJson(value);
}

function acceptedDecisionMatches(
  accepted: PersistedSeedEnrichment['decisions'][number],
  applied: Omit<
    Extract<GitImportEnrichmentPayload['decisions'], { mode: 'replace' }>['decisions'][number],
    'revision_n'
  > & { revision_n: number }
): boolean {
  const citation = splitEvidenceCitation(accepted.reason);
  return (
    citation !== null &&
    applied.decision === accepted.decision &&
    applied.reason === citation.prose &&
    canonicalJson(applied.alternatives_considered ?? null) ===
      canonicalJson(accepted.alternatives_considered ?? null) &&
    applied.revision_n === 0 &&
    applied.evidence.kind === 'git-commit' &&
    applied.evidence.commit_sha.startsWith(citation.sha) &&
    applied.evidence.quote === citation.quote
  );
}

function acceptedEnrichmentApplied(
  artifactId: string,
  accepted: PersistedSeedEnrichment,
  applied: { eventId: string; payload: GitImportEnrichmentPayload } | null,
  amendment: ProjectSeedBundleSnapshot | null,
  sourceRevisionId: string | null
): boolean {
  if (
    !applied ||
    applied.payload.artifact_id !== artifactId ||
    applied.payload.cluster_key !== accepted.cluster_key ||
    applied.payload.enriched_at !== accepted.enriched_at ||
    applied.payload.label !== accepted.label ||
    applied.payload.task !== accepted.task ||
    canonicalJson(applied.payload.steps) !== canonicalJson(accepted.steps) ||
    canonicalJson(applied.payload.checkpoint_summaries) !==
      canonicalJson(
        accepted.checkpoint_summaries.map((summary, index) => ({ n: index + 1, summary }))
      ) ||
    applied.payload.outcome !== accepted.outcome
  )
    return false;
  if (applied.payload.decisions.mode === 'preserve') {
    const requested = amendment?.manifest?.amendment;
    if (
      requested?.artifact_id === artifactId &&
      requested.decision_mode === 'preserve' &&
      amendment !== null &&
      sourceRevisionId === amendment.revision.revisionId &&
      requested.prior_enrichment_event_id === applied.eventId
    )
      return false;
    return true;
  }
  return (
    applied.payload.decisions.decisions.length === accepted.decisions.length &&
    applied.payload.decisions.decisions.every((decision, index) =>
      acceptedDecisionMatches(accepted.decisions[index]!, decision)
    )
  );
}

function sourceKey(filename: string): string {
  return filename === manifestFilename ? 'manifest' : `bundle:${filename}`;
}

function safeGeneratedName(filename: string): boolean {
  return (
    filename === manifestFilename ||
    (!path.isAbsolute(filename) && path.basename(filename) === filename && filename.endsWith('.md'))
  );
}

function exactSources(
  snapshot: ProjectSeedBundleSnapshot | null,
  sources: readonly {
    key: string;
    bytes: Buffer;
    sourceLocation: string;
    sourceRevisionId?: string;
  }[]
): boolean {
  return (
    snapshot !== null &&
    snapshot.sources.length === sources.length &&
    snapshot.sources.every(
      (source, index) =>
        source.key === sources[index]!.key &&
        source.sourceLocation === sources[index]!.sourceLocation &&
        (source.sourceRevisionId ?? null) === (sources[index]!.sourceRevisionId ?? null) &&
        Buffer.from(source.bytes).equals(sources[index]!.bytes)
    )
  );
}

function bundleResult(directory: string, manifest: SeedEnrichmentManifest): SeedBundleWriteResult {
  const candidateCueCount = manifest.bundles.reduce(
    (total, bundle) => total + bundle.nomination_count,
    0
  );
  const cueBearingCount = manifest.bundles.filter((bundle) => bundle.nomination_count > 0).length;
  return {
    directory,
    count: manifest.bundles.length,
    cueBearingCount,
    cueFreeCount: manifest.bundles.length - cueBearingCount,
    candidateCueCount,
    estimatedReadingTasks: manifest.bundles.reduce(
      (total, bundle) => total + bundle.distinct_task_count,
      0
    ),
  };
}

function preparedSources(
  operationId: string,
  files: readonly {
    key: string;
    bytes: Buffer;
    sourceLocation: string;
    sourceRevisionId?: string;
  }[]
): SeedBundleSource[] {
  return files.map((file) => {
    const sourceSha256 = digest(file.bytes);
    return {
      sourceId: artifactOperationId(operationId, file.key, 'seed_bundle_source'),
      sourceIdentity: sourceSha256,
      sourceLocation: file.sourceLocation,
      ...(file.sourceRevisionId === undefined ? {} : { sourceRevisionId: file.sourceRevisionId }),
      sourceOperationId: operationId,
      sourceSha256,
      key: file.key,
      bytes: file.bytes,
    };
  });
}

async function publishBundle(input: {
  handle: ProjectDatabase;
  identity: SeedBundleIdentity;
  files: readonly {
    key: string;
    bytes: Buffer;
    sourceLocation: string;
    sourceRevisionId?: string;
  }[];
  operationOptions: ProjectOperationOptions;
  secretAllow: readonly string[];
  operationFamily: string;
  beforePublish?: (before: ProjectSeedBundleSnapshot | null) => Promise<void>;
}): Promise<ProjectSeedBundleSnapshot> {
  const before = readProjectSeedBundle(input.handle, input.identity);
  const contentKey = digest(
    Buffer.from(
      canonicalJson(
        input.files.map((file) => [
          file.key,
          file.sourceLocation,
          file.sourceRevisionId ?? null,
          digest(file.bytes),
        ])
      )
    )
  );
  const operationId = artifactOperationId(
    input.identity.kind === 'pending'
      ? input.handle.authority.projectId
      : input.identity.artifactId,
    contentKey,
    input.operationFamily
  );
  const revisionId = artifactOperationId(operationId, 'revision', 'seed_bundle_revision');
  const prepared = prepareProjectSeedBundle({
    operationId,
    revisionId,
    expectedRevision: before?.revision ?? null,
    secretAllow: [...input.secretAllow],
    identity: input.identity,
    sources: preparedSources(operationId, input.files),
  });
  await input.beforePublish?.(before);
  if (exactSources(before, input.files)) return before!;
  try {
    await publishProjectSeedBundle(input.handle, prepared, input.operationOptions);
  } catch (cause) {
    if (!(cause instanceof ProjectDatabaseError) || cause.code !== 'STALE_CONTEXT') throw cause;
    const concurrent = readProjectSeedBundle(input.handle, input.identity);
    if (!exactSources(concurrent, input.files)) throw cause;
  }
  const published = readProjectSeedBundle(input.handle, input.identity);
  if (!published || !exactSources(published, input.files))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Published seed bundle cannot be reconstructed from its retained sources'
    );
  return published;
}

async function assertWorkspaceSafe(
  directory: string,
  files: readonly { filename: string; bytes: Buffer }[],
  owned: ReadonlySet<string>
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const entries = new Map(
    (await readdir(directory, { withFileTypes: true })).map((e) => [e.name, e])
  );
  for (const file of files) {
    if (!safeGeneratedName(file.filename))
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'Seed bundle contains an unsafe filename');
    const entry = entries.get(file.filename);
    if (!entry) continue;
    if (!entry.isFile())
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `${path.join(directory, file.filename)} is not a regular file.`
      );
    if (!owned.has(file.filename)) {
      const current = await readFile(path.join(directory, file.filename));
      if (!current.equals(file.bytes))
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Refusing to overwrite unowned file ${path.join(directory, file.filename)}.`
        );
    }
  }
}

async function materializeWorkspace(
  repoRoot: string,
  directory: string,
  files: readonly { filename: string; bytes: Buffer }[],
  owned: ReadonlySet<string>
): Promise<void> {
  const next = new Set(files.map((file) => file.filename));
  await Promise.all(
    [...owned]
      .filter((filename) => !next.has(filename))
      .map(async (filename) => {
        try {
          await unlink(path.join(directory, filename));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
      })
  );
  for (const file of files)
    await atomicWriteFile(path.join(directory, file.filename), file.bytes, repoRoot);
}

export interface PreparedDatabasePendingSeedBundle {
  readonly directory: string;
  readonly manifest: SeedEnrichmentManifest;
  readonly files: readonly { filename: string; bytes: Buffer }[];
}

export async function prepareDatabasePendingSeedBundle(input: {
  directory: string;
  secretAllow: readonly string[];
}): Promise<PreparedDatabasePendingSeedBundle | null> {
  const directory = path.resolve(input.directory);
  const manifestPath = path.join(directory, manifestFilename);
  let manifestBytes: Buffer;
  try {
    assertNoSecretsInPayload({ source_location: manifestPath }, input.secretAllow);
    manifestBytes = await readFile(manifestPath);
    refuseJsonBytes(manifestBytes, input.secretAllow);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (cause instanceof SecretInPayloadError)
      throw new ProjectDatabaseError('SECRET_IN_PAYLOAD', cause.message, { cause });
    if (cause instanceof ProjectDatabaseError && cause.code === 'SECRET_IN_PAYLOAD') throw cause;
    throw cause;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Initial seed preview manifest is invalid', {
      cause,
    });
  }
  const parsed = SeedEnrichmentManifestSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.amendment !== undefined)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Initial seed preview manifest is invalid or belongs to an amendment workflow',
      { cause: parsed.success ? undefined : parsed.error }
    );
  const files: Array<{ filename: string; bytes: Buffer }> = [];
  const names = new Set<string>();
  for (const bundle of parsed.data.bundles) {
    if (!safeGeneratedName(bundle.filename) || names.has(bundle.filename))
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Initial seed preview manifest contains an unsafe or repeated bundle filename'
      );
    names.add(bundle.filename);
    const sourceLocation = path.join(directory, bundle.filename);
    try {
      assertNoSecretsInPayload({ source_location: sourceLocation }, input.secretAllow);
      const bytes = await readFile(sourceLocation);
      assertNoSecretsInPayload({ source_bytes: bytes.toString('utf8') }, input.secretAllow);
      files.push({ filename: bundle.filename, bytes: Buffer.from(bytes) });
    } catch (cause) {
      if (cause instanceof SecretInPayloadError)
        throw new ProjectDatabaseError('SECRET_IN_PAYLOAD', cause.message, { cause });
      throw cause;
    }
  }
  files.push({ filename: manifestFilename, bytes: Buffer.from(manifestBytes) });
  return Object.freeze({
    directory,
    manifest: structuredClone(parsed.data),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
}

type DatabaseSeedBundlePersistenceInput = {
  handle: ProjectDatabase;
  repoRoot: string;
  directory: string;
  operationOptions?: ProjectOperationOptions;
  secretAllow?: readonly string[];
  onManifestRead?: (snapshot: ProjectSeedBundleSnapshot | null) => void;
} & (
  | { artifactId: string; identity?: never }
  | { artifactId?: never; identity: Extract<SeedBundleIdentity, { kind: 'pending' }> }
);

export function createDatabaseSeedBundlePersistence(
  input: DatabaseSeedBundlePersistenceInput
): SeedBundlePersistence {
  const identity: SeedBundleIdentity = input.identity ?? {
    kind: 'amend',
    artifactId: input.artifactId!,
  };
  const operationOptions = input.operationOptions ?? {};
  const directory = path.resolve(input.directory);
  let preparedInput: SeedBundlePreparationInput | null = null;
  return {
    directory,
    async preflight(value) {
      preparedInput = structuredClone(value);
      return null;
    },
    async publish(files) {
      if (!preparedInput)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Prepare the seed bundle before publishing its retained sources'
        );
      const manifestFile = files.find((file) => file.filename === manifestFilename);
      if (!manifestFile)
        throw new ProjectDatabaseError('INVALID_INPUT', 'Seed bundle manifest is missing');
      const manifest = SeedEnrichmentManifestSchema.parse(
        JSON.parse(manifestFile.bytes.toString('utf8'))
      );
      if (identity.kind === 'pending') {
        if (
          manifest.amendment !== undefined ||
          manifest.options_hash !== preparedInput.optionsHash ||
          canonicalJson(manifest.selection ?? null) !==
            canonicalJson(preparedInput.selection ?? null) ||
          canonicalJson(
            manifest.bundles.map(({ artifact_id, cluster_key }) => [artifact_id, cluster_key])
          ) !==
            canonicalJson(
              preparedInput.syntheses.map(({ artifactId, cluster }) => [artifactId, cluster.key])
            )
        )
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            'Pending seed bundle differs from the selected initial seed input'
          );
      }
      const before = readProjectSeedBundle(input.handle, identity);
      const owned = new Set(
        before
          ? [manifestFilename, ...(before.manifest?.bundles.map((bundle) => bundle.filename) ?? [])]
          : []
      );
      const sources = files.map((file) => ({
        key: sourceKey(file.filename),
        bytes: Buffer.from(file.bytes),
        sourceLocation: path.join(directory, file.filename),
      }));
      await publishBundle({
        handle: input.handle,
        identity,
        files: sources,
        operationOptions,
        secretAllow: input.secretAllow ?? [],
        operationFamily:
          identity.kind === 'pending' ? 'seed_bundle_pending' : 'seed_bundle_amendment',
        beforePublish: () => assertWorkspaceSafe(directory, files, owned),
      });
      await materializeWorkspace(input.repoRoot, directory, files, owned);
      return bundleResult(directory, manifest);
    },
    async readManifest() {
      const snapshot = readProjectSeedBundle(input.handle, identity);
      input.onManifestRead?.(snapshot);
      return snapshot?.manifest ?? null;
    },
  };
}

export function createDatabaseSeedEnrichmentPersistence(input: {
  handle: ProjectDatabase;
  artifactId?: string;
  operationOptions?: ProjectOperationOptions;
  secretAllow?: readonly string[];
  preparedAuthored?: PreparedDatabaseSeedEnrichmentSources;
  retainedAcceptedOnly?: boolean;
  selectedAmendment?: (artifactId: string) => ProjectSeedBundleSnapshot | null | undefined;
}): SeedEnrichmentPersistence {
  const operationOptions = input.operationOptions ?? {};
  const selected = (artifactId: string) => {
    if (input.artifactId !== undefined && artifactId !== input.artifactId)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Seed enrichment artifact was not selected before preparation'
      );
  };
  const identity = (artifactId: string) => ({ kind: 'accepted' as const, artifactId });
  return {
    async preflight() {
      if (input.artifactId !== undefined)
        readProjectSeedBundle(input.handle, identity(input.artifactId));
    },
    async readAuthored(directory) {
      if (!input.preparedAuthored)
        return (
          await prepareDatabaseSeedEnrichmentSources({
            directory,
            secretAllow: input.secretAllow ?? [],
          })
        ).sources;
      if (path.resolve(directory) !== input.preparedAuthored.directory)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Seed enrichment authoring directory changed after preparation'
        );
      return input.preparedAuthored.sources.map((source) => ({
        ...source,
        bytes: source.bytes ? Buffer.from(source.bytes) : null,
      }));
    },
    async readAccepted(artifactId) {
      selected(artifactId);
      const current = readProjectSeedBundle(input.handle, identity(artifactId));
      const source = current?.sources.find((item) => item.key === 'enrichment');
      return source ? Buffer.from(source.bytes) : null;
    },
    async readOriginalAccepted(artifactId) {
      selected(artifactId);
      const current = readProjectSeedBundle(input.handle, identity(artifactId));
      const accepted = current?.sources.find((item) => item.key === 'enrichment');
      const authored = current?.sources.find((item) => item.key === 'authored');
      if (!accepted || !authored) return null;
      const parsed = PersistedSeedEnrichmentSchema.parse(
        JSON.parse(Buffer.from(accepted.bytes).toString('utf8'))
      );
      const artifact = readProjectArtifact(input.handle, artifactId);
      const latestEvent = artifact?.thread.events
        .filter((event) => event.record.type === 'git_import_enriched')
        .at(-1);
      const latest = latestEvent
        ? {
            eventId: latestEvent.record.event_id,
            payload: GitImportEnrichmentPayloadSchema.parse(latestEvent.payload),
          }
        : null;
      const selectedAmendment = input.selectedAmendment?.(artifactId);
      const amendment =
        selectedAmendment === undefined
          ? readProjectSeedBundle(input.handle, { kind: 'amend', artifactId })
          : selectedAmendment;
      // The artifact-bound initial bundle uses a raw Git grouping key; the captured origin
      // hashes that key. Match the materialized content instead of treating it as an amendment.
      const plan = artifact?.thread.plan;
      if (
        artifact !== null &&
        !latestEvent &&
        (amendment === null || accepted.sourceRevisionId !== amendment.revision.revisionId) &&
        plan?.origin?.kind === 'git-import' &&
        plan.origin.enriched_at === parsed.enriched_at &&
        plan.label === parsed.label &&
        plan.task === parsed.task &&
        canonicalJson(plan.plan_steps.map(({ label, text }) => ({ label, text }))) ===
          canonicalJson(parsed.steps) &&
        canonicalJson(
          artifact.thread.checkpoints.map((checkpoint) =>
            checkpoint.status === 'closed' ? checkpoint.summary : null
          )
        ) === canonicalJson(parsed.checkpoint_summaries) &&
        artifact.thread.summary?.outcome === parsed.outcome &&
        plan.decisions.length === parsed.decisions.length &&
        plan.decisions.every(
          (decision, index) =>
            decision.evidence?.kind === 'git-commit' &&
            acceptedDecisionMatches(parsed.decisions[index]!, {
              ...decision,
              evidence: decision.evidence,
            })
        )
      )
        return null;
      if (
        acceptedEnrichmentApplied(
          artifactId,
          parsed,
          latest,
          amendment,
          accepted.sourceRevisionId ?? null
        )
      )
        return null;
      if (input.preparedAuthored) {
        const currentSource = input.preparedAuthored.sources.find(
          (source) => path.resolve(source.originalPath) === path.resolve(authored.sourceLocation)
        );
        if (currentSource?.readError) throw new Error(currentSource.readError);
        if (currentSource?.bytes && !currentSource.bytes.equals(Buffer.from(authored.bytes)))
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            'Seed enrichment retry changed its original authored input'
          );
      } else if (!input.retainedAcceptedOnly) {
        try {
          const currentSource = await readFile(authored.sourceLocation);
          if (!currentSource.equals(Buffer.from(authored.bytes)))
            throw new ProjectDatabaseError(
              'IDEMPOTENCY_CONFLICT',
              'Seed enrichment retry changed its original authored input'
            );
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
      }
      return {
        bytes: Buffer.from(accepted.bytes),
        originalPath: authored.sourceLocation,
      };
    },
    async writeAccepted(value) {
      selected(value.artifactId);
      const current = readProjectSeedBundle(input.handle, identity(value.artifactId));
      const selectedAmendment = input.selectedAmendment?.(value.artifactId);
      const amendment =
        selectedAmendment === undefined
          ? readProjectSeedBundle(input.handle, {
              kind: 'amend',
              artifactId: value.artifactId,
            })
          : selectedAmendment;
      const currentAccepted = current?.sources.find((item) => item.key === 'enrichment');
      const acceptedBytes =
        currentAccepted &&
        semanticEnrichment(Buffer.from(currentAccepted.bytes)) === semanticEnrichment(value.bytes)
          ? Buffer.from(currentAccepted.bytes)
          : Buffer.from(value.bytes);
      const files = [
        {
          key: 'enrichment',
          bytes: acceptedBytes,
          sourceLocation: `seed/enrichment/${value.artifactId}.json`,
          ...(amendment ? { sourceRevisionId: amendment.revision.revisionId } : {}),
        },
        {
          key: 'authored',
          bytes: Buffer.from(value.source.bytes),
          sourceLocation: path.resolve(value.source.originalPath),
          ...(amendment ? { sourceRevisionId: amendment.revision.revisionId } : {}),
        },
      ];
      const published = await publishBundle({
        handle: input.handle,
        identity: identity(value.artifactId),
        files,
        operationOptions,
        secretAllow: input.secretAllow ?? [],
        operationFamily: 'seed_enrichment',
      });
      const retained = published.sources.find((source) => source.key === 'enrichment');
      if (!retained)
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'Accepted seed enrichment is missing from its retained bundle'
        );
      return Buffer.from(retained.bytes);
    },
  };
}

export async function writeDatabaseGitImportEnrichment(
  handle: ProjectDatabase,
  received: GitImportEnrichmentPayload,
  options: {
    idempotencyKey: string;
    operationOptions?: ProjectOperationOptions;
    secretAllow?: string[];
  }
): Promise<GitImportEnrichmentWriteResult> {
  const enrichment = GitImportEnrichmentPayloadSchema.parse(received);
  const before = readProjectSeedArtifact(handle, enrichment.artifact_id);
  const plan = before.thread.plan;
  if (!plan)
    throw new GitImportEnrichmentInvalidTargetError(
      `Cannot enrich unknown artifact "${enrichment.artifact_id}".`,
      enrichment.artifact_id
    );
  const origin = plan.origin;
  if (origin?.kind !== 'git-import')
    throw new GitImportEnrichmentInvalidTargetError(
      `Artifact "${enrichment.artifact_id}" is not a git import.`,
      enrichment.artifact_id
    );
  if (!origin.cluster_key || !origin.member_shas || !origin.member_shas_hash)
    throw new GitImportEnrichmentLegacyError(
      `Artifact "${enrichment.artifact_id}" predates exact seed membership. Re-seed it with a current Orcaops build before enriching it.`,
      enrichment.artifact_id
    );
  if (
    enrichment.cluster_key !== origin.cluster_key ||
    enrichment.member_shas_hash !== origin.member_shas_hash ||
    computeMemberShasHash(origin.member_shas) !== origin.member_shas_hash
  )
    throw new GitImportEnrichmentValidationError(
      `Artifact "${enrichment.artifact_id}" enrichment does not match its immutable ` +
        'cluster identity and member hash.',
      enrichment.artifact_id
    );
  if (
    !before.thread.summary ||
    before.thread.checkpoints.length !== plan.plan_steps.length ||
    before.thread.checkpoints.some((checkpoint) => checkpoint.status !== 'closed')
  )
    throw new GitImportEnrichmentInvalidTargetError(
      `Artifact "${enrichment.artifact_id}" is not a complete imported thread.`,
      enrichment.artifact_id
    );
  const memberShas = new Set(origin.member_shas);
  if (
    enrichment.decisions.mode === 'replace' &&
    enrichment.decisions.decisions.some((decision) => !memberShas.has(decision.evidence.commit_sha))
  )
    throw new GitImportEnrichmentValidationError(
      `Seed enrichment decision evidence is outside artifact "${enrichment.artifact_id}".`,
      enrichment.artifact_id
    );
  const candidate = PlanInputSchema.safeParse({
    ...plan,
    label: enrichment.label,
    task: enrichment.task,
    plan_steps: plan.plan_steps.map((step, index) => ({ ...step, ...enrichment.steps[index] })),
    decisions:
      enrichment.decisions.mode === 'replace' ? enrichment.decisions.decisions : plan.decisions,
  });
  const checkpointNumbers = plan.plan_steps.map((_, index) => index + 1);
  if (
    !candidate.success ||
    enrichment.steps.length !== plan.plan_steps.length ||
    canonicalJson(enrichment.checkpoint_summaries.map((entry) => entry.n)) !==
      canonicalJson(checkpointNumbers)
  )
    throw new GitImportEnrichmentValidationError(
      `Artifact "${enrichment.artifact_id}" enrichment must preserve its imported plan and checkpoint shape.`,
      enrichment.artifact_id
    );
  const replayShape = (value: GitImportEnrichmentPayload) => {
    const { enriched_at: _at, ...content } = value;
    return content;
  };
  const events = before.thread.events;
  const replay = await findArtifactScopedReplay({
    events: events.map((event) => event.record),
    type: 'git_import_enriched',
    idempotencyKey: options.idempotencyKey,
    payload: replayShape(enrichment),
    loadPriorPayload: (record) =>
      replayShape(
        GitImportEnrichmentPayloadSchema.parse(
          events.find((event) => event.record.event_id === record.event_id)?.payload
        )
      ),
  });
  const prior = events.filter((event) => event.record.type === 'git_import_enriched');
  const latestEventId = prior.at(-1)?.record.event_id ?? null;
  if (replay.kind === 'replay') {
    if (replay.priorEventId !== latestEventId)
      throw new StaleGitImportEnrichmentError(
        `Enrichment event ${replay.priorEventId} for artifact ` +
          `"${enrichment.artifact_id}" has been superseded by ${latestEventId}. ` +
          'Re-read the artifact and create a new preview.',
        enrichment.artifact_id,
        latestEventId
      );
    return {
      outcome: 'replay',
      priorEventId: replay.priorEventId,
      enrichment: GitImportEnrichmentPayloadSchema.parse(
        events.find((event) => event.record.event_id === replay.priorEventId)?.payload
      ),
    };
  }
  if (replay.kind === 'conflict') return { outcome: 'conflict', priorEventId: replay.priorEventId };
  if (enrichment.prior_enrichment_event_id !== latestEventId)
    throw new StaleGitImportEnrichmentError(
      `Stale prior_enrichment_event_id for artifact "${enrichment.artifact_id}". ` +
        'Re-read the artifact and create a new preview.',
      enrichment.artifact_id,
      latestEventId
    );
  const eventTime = Date.parse(enrichment.enriched_at);
  const event = encodeArtifactEvent({
    event_id: uuidv7({
      now: eventTime,
      random: () =>
        Buffer.from(
          digest(
            Buffer.from(
              canonicalJson([
                enrichment.artifact_id,
                options.idempotencyKey,
                'git_import_enriched_event',
              ])
            )
          ),
          'hex'
        ),
    }),
    type: 'git_import_enriched',
    ts: enrichment.enriched_at,
    idempotency_key: options.idempotencyKey,
    payload: enrichment,
  });
  await appendProjectImportedArtifact(
    handle,
    {
      artifactId: enrichment.artifact_id,
      operationId: artifactOperationId(
        enrichment.artifact_id,
        options.idempotencyKey,
        'seed_enrichment'
      ),
      expectedRevision: before.revision,
      eventBytes: event.eventBytes,
      sidecarPayloads: event.sidecar
        ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }]
        : [],
      secretAllow: options.secretAllow ?? [],
    },
    options.operationOptions
  );
  return { outcome: 'created', event_id: event.record.event_id, enrichment };
}

function readProjectSeedArtifact(handle: ProjectDatabase, artifactId: string) {
  const snapshot = readProjectArtifact(handle, artifactId);
  if (!snapshot)
    throw new GitImportEnrichmentInvalidTargetError(
      `Cannot enrich unknown artifact "${artifactId}".`,
      artifactId
    );
  return snapshot;
}

export function databaseSeedEnrichContext(input: {
  handle: ProjectDatabase;
  repo: SeedEnrichContext['repo'];
  config: SeedEnrichContext['config'];
  operationOptions?: ProjectOperationOptions;
}): SeedEnrichContext {
  const retained = (artifactId: string) => readProjectArtifact(input.handle, artifactId)?.thread;
  return {
    repo: input.repo,
    config: input.config,
    store: {
      async readPlan(artifactId) {
        return retained(artifactId)?.plan ?? null;
      },
      async readCheckpoints(artifactId) {
        return retained(artifactId)?.checkpoints ?? [];
      },
      async readSummary(artifactId) {
        return retained(artifactId)?.summary ?? null;
      },
      async readLatestGitImportEnrichmentEventId(artifactId) {
        return (
          retained(artifactId)
            ?.events.filter((event) => event.record.type === 'git_import_enriched')
            .at(-1)?.record.event_id ?? null
        );
      },
      writeGitImportEnrichment(payload, options) {
        return writeDatabaseGitImportEnrichment(input.handle, payload, {
          ...options,
          operationOptions: input.operationOptions,
          secretAllow: input.config.redact.allow,
        });
      },
    },
  };
}

export function databaseSeedEnrichPersistence(input: {
  handle: ProjectDatabase;
  artifactId: string;
  repoRoot: string;
  directory: string;
  operationOptions?: ProjectOperationOptions;
  secretAllow?: readonly string[];
  preparedAuthored?: PreparedDatabaseSeedEnrichmentSources;
}): SeedEnrichPersistence {
  let selectedAmendment: ProjectSeedBundleSnapshot | null | undefined;
  return {
    bundle: createDatabaseSeedBundlePersistence({
      ...input,
      onManifestRead(snapshot) {
        selectedAmendment = snapshot;
      },
    }),
    enrichment: createDatabaseSeedEnrichmentPersistence({
      ...input,
      selectedAmendment: () => selectedAmendment,
    }),
  };
}

export function databaseInitialSeedPersistence(input: {
  handle: ProjectDatabase;
  repoRoot: string;
  directory: string;
  operationOptions?: ProjectOperationOptions;
  secretAllow?: readonly string[];
  preparedAuthored?: PreparedDatabaseSeedEnrichmentSources;
  linkPending?: boolean;
}) {
  return {
    bundle: createDatabaseSeedBundlePersistence({
      handle: input.handle,
      identity: { kind: 'pending' },
      repoRoot: input.repoRoot,
      directory: input.directory,
      operationOptions: input.operationOptions,
      secretAllow: input.secretAllow,
    }),
    enrichment: createDatabaseSeedEnrichmentPersistence({
      handle: input.handle,
      operationOptions: input.operationOptions,
      secretAllow: input.secretAllow,
      preparedAuthored: input.preparedAuthored,
      retainedAcceptedOnly: true,
      selectedAmendment: () =>
        input.linkPending === false
          ? null
          : readProjectSeedBundle(input.handle, { kind: 'pending' }),
    }),
  };
}
