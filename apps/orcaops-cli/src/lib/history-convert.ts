import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { suggestRepositoryDisplayName } from '@orcaops/core/history/database-setup';
import {
  publishProjectCatalogEntry,
  publishRepositoryRegistration,
  publishWorktreeRegistration,
  readRepositoryRegistration,
} from '@orcaops/core/history/registration';
import {
  compareLegacyImport,
  LEGACY_SOURCE_REVISION,
  type LegacyImportComparison,
  type LegacyPreview,
  prepareLegacyImport,
  prepareLegacySources,
  previewLegacyRepository,
} from '@orcaops/history-convert';
import { isUuidV7, uuidv7 } from '@orcaops/storage';
import {
  derivedImportOperationId,
  importProjectHistory,
  normalizeHistoryRoot,
  openProjectDatabase,
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  projectDatabasePath,
  type ProjectHistoryImportReceipt,
  readProjectDisplayName,
  readProjectHistoryImport,
  readProjectInitializationCandidate,
  retainProjectDisplayName,
} from '@orcaops/storage/history/database';

const execute = promisify(execFile);

export interface HistoryConvertOptions {
  readonly cwd: string;
  readonly root?: string;
  readonly apply?: boolean;
  readonly offline?: boolean;
  readonly operationId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onOperationId?: (
    operationId: string,
    context: { cwd: string; resolvedRoot: string }
  ) => void;
}

type ConversionDisclosure = LegacyPreview['resources'][number]['fidelity'][number] & {
  readonly location: string;
  readonly artifactId: string | null;
};

function conversionDisclosures(preview: LegacyPreview): readonly ConversionDisclosure[] {
  return Object.freeze(
    preview.resources.flatMap((resource) =>
      resource.fidelity
        .filter((entry) => entry.fidelity !== 'matches-current')
        .map((entry) =>
          Object.freeze({ ...entry, location: resource.source, artifactId: resource.id })
        )
    )
  );
}

export interface HistoryConvertPreview {
  readonly mode: 'preview';
  readonly profile: string;
  readonly producerEvidence: LegacyPreview['producerEvidence'];
  readonly projectId: string;
  readonly sourceManifestSha256: string;
  readonly previewManifestSha256: string;
  readonly contentComplete: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly omitted: LegacyPreview['omitted'];
  readonly retained: LegacyPreview['retained'];
  readonly unclassified: LegacyPreview['unclassified'];
  readonly disclosures: readonly ConversionDisclosure[];
  readonly target: LegacyPreview['target'];
  readonly issues: LegacyPreview['issues'];
}

export interface HistoryConvertApply {
  readonly mode: 'apply';
  readonly producerEvidence: LegacyPreview['producerEvidence'];
  readonly operationId: string;
  readonly projectId: string;
  readonly convertedDatabase: string;
  readonly replayed: boolean;
  readonly receipt: ProjectHistoryImportReceipt;
  /**
   * Null only when this run completed the registration of an import that had already committed:
   * the comparison belongs to the attempt that committed it, and re-deriving it would mean
   * re-reading sources whose observed tree that attempt's own markers have already changed.
   */
  readonly comparison: LegacyImportComparison | null;
  readonly disclosures: readonly ConversionDisclosure[] | null;
  readonly registration: {
    readonly repository: 'created' | 'existing';
    readonly catalog: 'created' | 'existing';
    readonly worktree: 'created' | 'existing';
  };
}

function refuse(code: 'INVALID_INPUT' | 'IDENTITY_CONFLICT', message: string): never {
  throw new ProjectDatabaseError(code, message);
}

async function gitContext(cwd: string, env: NodeJS.ProcessEnv) {
  const run = async (...args: string[]) =>
    (await execute('git', ['-C', cwd, ...args], { env })).stdout.trim();
  return {
    worktreeRoot: await realpath(await run('rev-parse', '--show-toplevel')),
    commonDir: path.resolve(
      cwd,
      await run('rev-parse', '--path-format=absolute', '--git-common-dir')
    ),
    gitDir: path.resolve(
      cwd,
      await run('rev-parse', '--path-format=absolute', '--absolute-git-dir')
    ),
  };
}

async function creationFacts(commonDir: string) {
  const info = await lstat(commonDir, { bigint: true });
  if (!info.isDirectory())
    refuse(
      'INVALID_INPUT',
      'The Git common directory is not a directory; conversion needs a repository'
    );
  return {
    commonDirectory: commonDir,
    device: info.dev.toString(),
    inode: info.ino.toString(),
    birthtimeNs: info.birthtimeNs > 0n ? info.birthtimeNs.toString() : null,
  };
}

async function previewSources(options: HistoryConvertOptions) {
  const env = options.env ?? process.env;
  const preview = await previewLegacyRepository({
    cwd: options.cwd,
    root: options.root,
    env,
    signal: options.signal,
  });
  return { env, preview };
}

function previewCounts(preview: LegacyPreview): Record<string, number> {
  const counts: Record<string, number> = {
    resources: preview.resources.length,
    artifacts: preview.representations.length,
    gitResources: preview.gitResources.length,
    omitted: preview.omitted.length,
    retained: preview.retained.length,
    unclassified: preview.unclassified.length,
    issues: preview.issues.length,
  };
  for (const resource of preview.resources)
    counts[`records.${resource.kind}`] =
      (counts[`records.${resource.kind}`] ?? 0) + (resource.records ?? 0);
  return counts;
}

export async function previewHistoryConversion(
  options: HistoryConvertOptions
): Promise<HistoryConvertPreview> {
  const { preview } = await previewSources(options);
  if (!preview.projectId)
    refuse('INVALID_INPUT', 'This repository has no legacy project identity to convert');
  return Object.freeze({
    mode: 'preview' as const,
    profile: preview.profile,
    producerEvidence: preview.producerEvidence,
    projectId: preview.projectId,
    sourceManifestSha256: preview.manifestHash,
    previewManifestSha256: preview.manifestHash,
    contentComplete: preview.contentComplete,
    counts: Object.freeze(previewCounts(preview)),
    omitted: preview.omitted,
    retained: preview.retained,
    unclassified: preview.unclassified,
    disclosures: conversionDisclosures(preview),
    target: preview.target,
    issues: preview.issues,
  });
}

export async function applyHistoryConversion(
  options: HistoryConvertOptions
): Promise<HistoryConvertApply> {
  if (options.offline !== true)
    refuse(
      'INVALID_INPUT',
      'Conversion runs only in an explicit offline window; pass --offline with --apply'
    );
  const { env, preview } = await previewSources(options);
  if (!preview.projectId)
    refuse('INVALID_INPUT', 'This repository has no legacy project identity to convert');
  const git = await gitContext(options.cwd, env);
  const root = await normalizeHistoryRoot({ root: options.root, env });
  if (options.operationId !== undefined && !isUuidV7(options.operationId))
    refuse('INVALID_INPUT', 'Provide the original conversion operation UUID');
  const existing = await readRepositoryRegistration({
    commonDir: git.commonDir,
    requestedRoot: root,
  });
  if (existing && options.operationId === undefined)
    refuse(
      'IDENTITY_CONFLICT',
      'This repository is already registered; retry its original conversion operation ID explicitly'
    );
  if (!existing && !preview.contentComplete)
    refuse(
      'INVALID_INPUT',
      [
        'The legacy sources are not completely classified.',
        `Inventory: ${preview.inventoryComplete ? 'complete' : 'incomplete'}.`,
        `Issues (${preview.issues.length}): ${preview.issues.map((issue) => `${issue.location} (${issue.code})`).join(', ') || 'none'}.`,
        `Unclassified sources (${preview.unclassified.length}): ${preview.unclassified.map((entry) => entry.location).join(', ') || 'none'}.`,
        'Inspect `orcaops history convert --json` before retrying.',
        ...(preview.unclassified.length
          ? ['Inspect the unclassified paths and report unrecognized Orcaops-owned state.']
          : []),
      ].join(' ')
    );
  const prepared = existing ? null : await prepareLegacySources(preview, options.signal);
  const operationId =
    options.operationId ??
    (await resumableConversionId(root, preview, prepared!.manifestSha256)) ??
    uuidv7();
  const operationContext = { cwd: git.worktreeRoot, resolvedRoot: root.resolvedRoot };
  const authority: ProjectDatabaseAuthority = {
    ...root,
    projectId: preview.projectId,
    storeInstanceId: derivedIdentity(operationId, 'store-instance'),
    repositoryInstanceId: derivedIdentity(operationId, 'repository-instance'),
  };
  if (existing) {
    if (
      !(
        existing.initialization_operation_id === operationId &&
        existing.repository_instance_id === authority.repositoryInstanceId &&
        existing.authority.project_id === authority.projectId &&
        existing.authority.store_instance_id === authority.storeInstanceId &&
        existing.authority.resolved_root === authority.resolvedRoot &&
        existing.authority.root_key === authority.rootKey
      )
    )
      refuse(
        'IDENTITY_CONFLICT',
        'This repository is already registered to a different project database or conversion; conversion never re-registers'
      );
    options.onOperationId?.(operationId, operationContext);
    return completeRegistration(authority, operationId, git, options);
  }
  const { source, expected } = prepareLegacyImport(prepared!, {
    conversionOperationId: operationId,
  });
  options.onOperationId?.(operationId, operationContext);
  const displayName = await suggestRepositoryDisplayName(git.commonDir, options.signal);
  const imported = await importProjectHistory({
    authority,
    operationId,
    importedAt: new Date().toISOString(),
    repositoryCreation: await creationFacts(git.commonDir),
    source,
    authorize() {},
    signal: options.signal,
  });
  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  let comparison: LegacyImportComparison;
  let receipt: ProjectHistoryImportReceipt;
  try {
    comparison = handle.read((view) => compareLegacyImport(expected, view)).value;
    receipt = readProjectHistoryImport(handle)!;
  } finally {
    handle.close();
  }
  // A comparison failure leaves the committed, activated target on disk and unregistered. That
  // is deliberate: the store is evidence for the repair, never something to delete, and without
  // a registration nothing will read it as this repository's history. The message names the
  // target so the operator can find it.
  if (!comparison.ok)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      `The converted database differs from its original sources and was left unregistered at ${projectDatabasePath(authority)} for inspection: ${comparison.differences.join('; ')}`
    );
  return Object.freeze({
    mode: 'apply' as const,
    producerEvidence: 'unknown' as const,
    operationId,
    projectId: authority.projectId,
    convertedDatabase: projectDatabasePath(authority),
    replayed: imported.replayed,
    receipt,
    comparison,
    disclosures: conversionDisclosures(preview),
    registration: await publishRegistration(authority, operationId, git, options, displayName),
  });
}

async function resumableConversionId(
  root: Awaited<ReturnType<typeof normalizeHistoryRoot>>,
  preview: LegacyPreview,
  sourceManifestHash: string
): Promise<string | null> {
  let candidate;
  try {
    candidate = await readProjectInitializationCandidate({
      root: root.resolvedRoot,
      projectId: preview.projectId!,
    });
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'HISTORY_MISSING') return null;
    throw cause;
  }
  const operationId = candidate.initializationOperationId;
  if (
    candidate.authority.rootKey !== root.rootKey ||
    candidate.authority.storeInstanceId !== derivedIdentity(operationId, 'store-instance') ||
    candidate.authority.repositoryInstanceId !== derivedIdentity(operationId, 'repository-instance')
  )
    refuse(
      'IDENTITY_CONFLICT',
      'The occupied project database does not identify this conversion; preserve it and use its original operation'
    );
  const handle = await openProjectDatabase({ authority: candidate.authority, mode: 'reader' });
  try {
    const receipt = readProjectHistoryImport(handle);
    if (
      !receipt ||
      receipt.operationId !== operationId ||
      receipt.sourceProfile !== preview.profile ||
      receipt.sourceRevision !== LEGACY_SOURCE_REVISION ||
      receipt.sourceManifestHash !== sourceManifestHash
    )
      refuse(
        'IDENTITY_CONFLICT',
        'The occupied project database does not match these original conversion sources; preserve it and inspect the original operation'
      );
  } finally {
    handle.close();
  }
  return operationId;
}

/**
 * The three create-once publications, in the same order fresh setup uses. Each returns
 * `existing` when this operation already published it, so a run that resumes after any one of
 * them completes the rest without touching what is already there.
 */
async function publishRegistration(
  authority: ProjectDatabaseAuthority,
  operationId: string,
  git: { commonDir: string; gitDir: string },
  options: HistoryConvertOptions,
  preparedDisplayName?: string
): Promise<HistoryConvertApply['registration']> {
  const displayName =
    preparedDisplayName ?? (await suggestRepositoryDisplayName(git.commonDir, options.signal));
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  let hasName: boolean;
  try {
    hasName = readProjectDisplayName(reader) !== null;
  } finally {
    reader.close();
  }
  if (!hasName) {
    const writer = await openProjectDatabase({ authority, mode: 'writer', signal: options.signal });
    try {
      await retainProjectDisplayName(
        writer,
        { operationId: uuidv7(), displayName },
        { signal: options.signal }
      );
    } finally {
      writer.close();
    }
  }
  const repository = await publishRepositoryRegistration({
    commonDir: git.commonDir,
    expected: authority,
    initializationOperationId: operationId,
    signal: options.signal,
  });
  const catalog = await publishProjectCatalogEntry({
    expected: authority,
    initializationOperationId: operationId,
    signal: options.signal,
  });
  const worktree = await publishWorktreeRegistration({
    gitDir: git.gitDir,
    repositoryInstanceId: authority.repositoryInstanceId,
    worktreeId: derivedIdentity(operationId, 'worktree'),
    operationId,
    signal: options.signal,
  });
  return Object.freeze({
    repository: repository.publication,
    catalog: catalog.publication,
    worktree: worktree.publication,
  });
}

/**
 * Finishes a conversion whose import committed and whose registration was interrupted partway
 * through. The committed conversion receipt is what authorises this: it names this same
 * operation, and the publishers re-certify the database's original initialization themselves.
 */
async function completeRegistration(
  authority: ProjectDatabaseAuthority,
  operationId: string,
  git: { commonDir: string; gitDir: string },
  options: HistoryConvertOptions
): Promise<HistoryConvertApply> {
  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  let receipt: ProjectHistoryImportReceipt | null;
  try {
    receipt = readProjectHistoryImport(handle);
  } finally {
    handle.close();
  }
  if (!receipt)
    refuse(
      'IDENTITY_CONFLICT',
      'The registered database records no conversion; an existing store is never relabelled converted'
    );
  if (receipt.operationId !== operationId)
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The registered database records a different original conversion; retry that operation instead'
    );
  return Object.freeze({
    mode: 'apply' as const,
    producerEvidence: 'unknown' as const,
    operationId,
    projectId: authority.projectId,
    convertedDatabase: projectDatabasePath(authority),
    replayed: true,
    receipt,
    comparison: null,
    disclosures: null,
    registration: await publishRegistration(authority, operationId, git, options),
  });
}

// The store, repository and worktree identities a conversion mints must come back identical on
// a retry of the same operation, or the retry would address a different database.
function derivedIdentity(operationId: string, scope: string): string {
  return derivedImportOperationId(operationId, scope);
}
