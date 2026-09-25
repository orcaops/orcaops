import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

// What a project database names outside itself: the Git refs its publications own and the
// immutable evidence files beside it. A copy of the database alone does not carry them, so a
// backup records each one with its identity and whether it could be found when it was taken.
export type RetainedReferencePresence = 'present' | 'changed' | 'absent' | 'unknown';

export interface RetainedGitReference {
  readonly ref: string;
  readonly objectOid: string;
  readonly namedBy: 'git_retention_publications' | 'legacy_import.git_resources_json';
  readonly retentionState: string | null;
  readonly presence: RetainedReferencePresence;
}

export interface RetainedEvidenceFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly namedBy:
    | 'review_evidence_members'
    | 'pending_review_evidence_members'
    | 'review_semantic_terminals';
  readonly presence: RetainedReferencePresence;
}

export interface RetainedReferences {
  readonly gitCommonDirectory: string | null;
  readonly gitReferences: readonly RetainedGitReference[];
  readonly evidenceFiles: readonly RetainedEvidenceFile[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const hasTable = (database: Database.Database, table: string) =>
  !!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);

// Refs are read from the files Git keeps them in. Storage runs no Git process, and a lookup
// that cannot be answered this way is reported as unknown, never as absent.
function readGitRefs(commonDirectory: string | null): ((ref: string) => string | null) | null {
  if (commonDirectory === null) return null;
  try {
    if (!lstatSync(commonDirectory).isDirectory()) return null;
    if (lstatSync(path.join(commonDirectory, 'reftable'), { throwIfNoEntry: false })) return null;
  } catch {
    return null;
  }
  const packed = new Map<string, string>();
  try {
    for (const line of readFileSync(path.join(commonDirectory, 'packed-refs'), 'utf8').split(
      '\n'
    )) {
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(line);
      if (match) packed.set(match[2]!, match[1]!);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  return (ref) => {
    try {
      const loose = readFileSync(path.join(commonDirectory, ...ref.split('/')), 'utf8').trim();
      return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(loose) ? loose : null;
    } catch {
      return packed.get(ref) ?? null;
    }
  };
}

// A ref name comes from a row, so it is held to the shape of a ref before it becomes a path.
const isRefName = (ref: string) =>
  ref.startsWith('refs/') &&
  ref.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
  !ref.includes('\\') &&
  !ref.includes('\u0000');

// The stored column is held to valid JSON and to nothing else, and this is a manifest of what
// the database names rather than a validator: a value that is not a list of named resources
// contributes nothing instead of stopping the backup that carries it.
function namedGitResources(value: string): Array<{ ref: string; oid: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? (parsed as unknown[]) : []).filter(
    (resource): resource is { ref: string; oid: string } =>
      typeof resource === 'object' &&
      resource !== null &&
      typeof (resource as { ref?: unknown }).ref === 'string' &&
      typeof (resource as { oid?: unknown }).oid === 'string'
  );
}

function evidencePresence(
  projectDirectory: string,
  file: Pick<RetainedEvidenceFile, 'relativePath' | 'sha256' | 'byteLength'>
): RetainedReferencePresence {
  const parts = file.relativePath.split('/');
  if (parts[0] !== 'evidence' || parts.some((part) => part === '' || part === '.' || part === '..'))
    return 'unknown';
  const location = path.join(projectDirectory, ...parts);
  try {
    const info = lstatSync(location, { throwIfNoEntry: false });
    if (!info) return 'absent';
    if (!info.isFile()) return 'changed';
    if (info.size !== file.byteLength) return 'changed';
    return createHash('sha256').update(readFileSync(location)).digest('hex') === file.sha256
      ? 'present'
      : 'changed';
  } catch {
    return 'unknown';
  }
}

export function inspectRetainedReferences(
  database: Database.Database,
  input: { projectDirectory: string; gitCommonDirectory?: string | null }
): RetainedReferences {
  // Where the repository was when the store was created is the only locator a store keeps. A
  // caller that knows where the repository is now says so.
  const recorded = hasTable(database, 'repository_creation')
    ? ((
        database.prepare('SELECT common_directory FROM repository_creation').get() as
          | { common_directory: string }
          | undefined
      )?.common_directory ?? null)
    : null;
  const gitCommonDirectory = input.gitCommonDirectory ?? recorded;
  const resolve = readGitRefs(gitCommonDirectory);
  const gitPresence = (ref: string, oid: string): RetainedReferencePresence => {
    if (!resolve || !isRefName(ref)) return 'unknown';
    const found = resolve(ref);
    if (found === null) return 'absent';
    return found === oid ? 'present' : 'changed';
  };

  const published = (
    database
      .prepare(
        `SELECT p.full_ref AS ref, p.object_oid AS oid, t.kind AS state
         FROM git_retention_publications p
         LEFT JOIN git_retention_current c ON c.original_operation_id = p.original_operation_id
         LEFT JOIN git_retention_transitions t ON t.transition_id = c.transition_id`
      )
      .all() as { ref: string; oid: string; state: string | null }[]
  ).map(
    (row): RetainedGitReference => ({
      ref: row.ref,
      objectOid: row.oid,
      namedBy: 'git_retention_publications',
      retentionState: row.state,
      presence: gitPresence(row.ref, row.oid),
    })
  );
  const imported = (
    database.prepare('SELECT git_resources_json FROM legacy_import').all() as {
      git_resources_json: string;
    }[]
  ).flatMap((row) =>
    namedGitResources(row.git_resources_json).map(
      (resource): RetainedGitReference => ({
        ref: resource.ref,
        objectOid: resource.oid,
        namedBy: 'legacy_import.git_resources_json',
        retentionState: null,
        presence: gitPresence(resource.ref, resource.oid),
      })
    )
  );

  const evidence = (
    [
      [
        'review_evidence_members',
        'SELECT relative_path, sha256, byte_length FROM review_evidence_members',
      ],
      [
        'pending_review_evidence_members',
        'SELECT relative_path, sha256, byte_length FROM pending_review_evidence_members',
      ],
      [
        'review_semantic_terminals',
        'SELECT model_relative_path AS relative_path, model_sha256 AS sha256, model_byte_length AS byte_length FROM review_semantic_terminals WHERE model_relative_path IS NOT NULL',
      ],
    ] as const
  ).flatMap(([namedBy, sql]) =>
    (
      database.prepare(sql).all() as {
        relative_path: string;
        sha256: string;
        byte_length: number;
      }[]
    ).map((row) => ({
      relativePath: row.relative_path,
      sha256: row.sha256,
      byteLength: row.byte_length,
      namedBy,
    }))
  );
  // A pending member and its published member name one file.
  const files = new Map<string, Omit<RetainedEvidenceFile, 'presence'>>();
  for (const file of evidence)
    if (!files.has(`${file.relativePath} ${file.sha256}`))
      files.set(`${file.relativePath} ${file.sha256}`, file);

  return {
    gitCommonDirectory,
    gitReferences: [...published, ...imported].sort((a, b) => compare(a.ref, b.ref)),
    evidenceFiles: [...files.values()]
      .sort((a, b) => compare(a.relativePath, b.relativePath))
      .map((file) => ({ ...file, presence: evidencePresence(input.projectDirectory, file) })),
  };
}

// A retired publication's ref may have been reclaimed, so its absence is not a finding.
export function retainedReferencesNotFound(
  references: RetainedReferences
): Pick<RetainedReferences, 'gitReferences' | 'evidenceFiles'> {
  return {
    gitReferences: references.gitReferences.filter(
      (entry) =>
        entry.presence !== 'present' &&
        !(entry.presence === 'absent' && entry.retentionState === 'retired')
    ),
    evidenceFiles: references.evidenceFiles.filter((entry) => entry.presence !== 'present'),
  };
}
