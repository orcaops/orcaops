import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectRetainedReferences,
  type RetainedEvidenceFile,
  type RetainedGitReference,
  retainedReferencesNotFound,
} from './retained-references.js';

// The columns a manifest of retained references reads, as the tables that hold them declare
// them. Nothing here constrains a value: this is a reader over named columns, and what it makes
// is a statement of what the database names, not a judgment of it.
const NAMING_TABLES = `
CREATE TABLE repository_creation (common_directory TEXT NOT NULL);
CREATE TABLE git_retention_publications (original_operation_id TEXT, full_ref TEXT, object_oid TEXT);
CREATE TABLE git_retention_current (original_operation_id TEXT, transition_id TEXT);
CREATE TABLE git_retention_transitions (transition_id TEXT, kind TEXT);
CREATE TABLE legacy_import (git_resources_json TEXT);
CREATE TABLE review_evidence_members (relative_path TEXT, sha256 TEXT, byte_length INTEGER);
CREATE TABLE pending_review_evidence_members (relative_path TEXT, sha256 TEXT, byte_length INTEGER);
CREATE TABLE review_semantic_terminals (model_relative_path TEXT, model_sha256 TEXT, model_byte_length INTEGER);
`;

const PRESENT_OID = 'a'.repeat(40);
const MOVED_OID = 'b'.repeat(40);
const SHA_OF_THE_LONGER_FORM = 'c'.repeat(64);

type EvidenceTable = RetainedEvidenceFile['namedBy'];

interface Naming {
  recordedCommonDirectory?: string;
  withoutRepositoryCreation?: boolean;
  publications?: Array<{ ref: string; oid: string; state?: string }>;
  importedResources?: string;
  evidence?: Array<{
    namedBy: EvidenceTable;
    relativePath: string;
    sha256: string;
    byteLength: number;
  }>;
}

const databases: Database.Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function naming(rows: Naming): Database.Database {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(NAMING_TABLES);
  if (rows.withoutRepositoryCreation) database.exec('DROP TABLE repository_creation');
  else if (rows.recordedCommonDirectory !== undefined)
    database
      .prepare('INSERT INTO repository_creation VALUES (?)')
      .run(rows.recordedCommonDirectory);
  for (const [index, publication] of (rows.publications ?? []).entries()) {
    const operation = `operation-${index}`;
    database
      .prepare('INSERT INTO git_retention_publications VALUES (?, ?, ?)')
      .run(operation, publication.ref, publication.oid);
    if (publication.state) {
      const transition = `transition-${index}`;
      database
        .prepare('INSERT INTO git_retention_transitions VALUES (?, ?)')
        .run(transition, publication.state);
      database
        .prepare('INSERT INTO git_retention_current VALUES (?, ?)')
        .run(operation, transition);
    }
  }
  if (rows.importedResources !== undefined)
    database.prepare('INSERT INTO legacy_import VALUES (?)').run(rows.importedResources);
  for (const file of rows.evidence ?? [])
    database
      .prepare(`INSERT INTO ${file.namedBy} VALUES (?, ?, ?)`)
      .run(file.relativePath, file.sha256, file.byteLength);
  return database;
}

interface Repository {
  loose?: Record<string, string>;
  packed?: Record<string, string>;
  reftable?: boolean;
}

function gitCommonDirectory(repository: Repository): string {
  const enclosing = temporary('retained-references-');
  const directory = path.join(enclosing, 'git');
  mkdirSync(directory);
  for (const [ref, oid] of Object.entries(repository.loose ?? {})) {
    const file = path.join(directory, ...ref.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${oid}\n`);
  }
  if (repository.packed)
    writeFileSync(
      path.join(directory, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted \n${Object.entries(repository.packed)
        .map(([ref, oid]) => `${oid} ${ref}`)
        .join('\n')}\n`
    );
  if (repository.reftable) mkdirSync(path.join(directory, 'reftable'));
  return directory;
}

const refs = (
  database: Database.Database,
  input: Parameters<typeof inspectRetainedReferences>[1]
) =>
  inspectRetainedReferences(database, input).gitReferences.map(
    (entry): Pick<RetainedGitReference, 'ref' | 'presence'> => ({
      ref: entry.ref,
      presence: entry.presence,
    })
  );
const files = (
  database: Database.Database,
  input: Parameters<typeof inspectRetainedReferences>[1]
) =>
  inspectRetainedReferences(database, input).evidenceFiles.map((entry) => ({
    relativePath: entry.relativePath,
    namedBy: entry.namedBy,
    presence: entry.presence,
  }));

describe('the Git refs a database names', () => {
  it('reads a loose ref as present, one that has moved as changed and one that is gone as absent', () => {
    const common = gitCommonDirectory({
      loose: { 'refs/orcaops/kept': PRESENT_OID, 'refs/orcaops/moved': MOVED_OID },
    });
    const database = naming({
      publications: [
        { ref: 'refs/orcaops/kept', oid: PRESENT_OID },
        { ref: 'refs/orcaops/moved', oid: PRESENT_OID },
        { ref: 'refs/orcaops/gone', oid: PRESENT_OID },
      ],
    });

    expect(
      refs(database, { projectDirectory: temporary('project-'), gitCommonDirectory: common })
    ).toEqual([
      { ref: 'refs/orcaops/gone', presence: 'absent' },
      { ref: 'refs/orcaops/kept', presence: 'present' },
      { ref: 'refs/orcaops/moved', presence: 'changed' },
    ]);
  });

  it('reads a ref that only packed-refs names, in either object id length', () => {
    const common = gitCommonDirectory({
      packed: {
        'refs/orcaops/kept': PRESENT_OID,
        'refs/orcaops/moved': MOVED_OID,
        'refs/orcaops/long': SHA_OF_THE_LONGER_FORM,
        'refs/orcaops/loose-wins': MOVED_OID,
      },
      loose: { 'refs/orcaops/loose-wins': PRESENT_OID },
    });
    const database = naming({
      publications: [
        { ref: 'refs/orcaops/kept', oid: PRESENT_OID },
        { ref: 'refs/orcaops/long', oid: SHA_OF_THE_LONGER_FORM },
        { ref: 'refs/orcaops/loose-wins', oid: PRESENT_OID },
        { ref: 'refs/orcaops/moved', oid: PRESENT_OID },
        { ref: 'refs/orcaops/unpacked', oid: PRESENT_OID },
      ],
    });

    expect(
      refs(database, { projectDirectory: temporary('project-'), gitCommonDirectory: common })
    ).toEqual([
      { ref: 'refs/orcaops/kept', presence: 'present' },
      { ref: 'refs/orcaops/long', presence: 'present' },
      { ref: 'refs/orcaops/loose-wins', presence: 'present' },
      { ref: 'refs/orcaops/moved', presence: 'changed' },
      { ref: 'refs/orcaops/unpacked', presence: 'absent' },
    ]);
  });

  // A lookup this cannot answer is unknown. Absent would say the ref is gone, which is a finding
  // about the repository rather than about the reading of it.
  it.each([
    [
      'a repository that keeps its refs in a reftable',
      (): string => gitCommonDirectory({ reftable: true }),
    ],
    [
      'a Git directory that is not there',
      (): string => path.join(temporary('project-'), 'missing'),
    ],
    [
      'a Git directory that is a file',
      (): string => {
        const file = path.join(temporary('project-'), 'git');
        writeFileSync(file, 'not a directory');
        return file;
      },
    ],
  ])('reads every ref as unknown against %s', (_repository, locate) => {
    const database = naming({ publications: [{ ref: 'refs/orcaops/kept', oid: PRESENT_OID }] });

    expect(
      refs(database, { projectDirectory: temporary('project-'), gitCommonDirectory: locate() })
    ).toEqual([{ ref: 'refs/orcaops/kept', presence: 'unknown' }]);
  });

  it('reads every ref as unknown when nothing says where the repository is', () => {
    const database = naming({
      withoutRepositoryCreation: true,
      publications: [{ ref: 'refs/orcaops/kept', oid: PRESENT_OID }],
    });

    const inspected = inspectRetainedReferences(database, {
      projectDirectory: temporary('project-'),
    });

    expect(inspected.gitCommonDirectory).toBeNull();
    expect(inspected.gitReferences.map((entry) => entry.presence)).toEqual(['unknown']);
  });

  it('never turns a name that is not a ref into a path', () => {
    const common = gitCommonDirectory({ loose: { 'refs/orcaops/kept': PRESENT_OID } });
    // A file the object id of every row below would match, where a name read as a path would
    // reach it. Anything but unknown here is a row that became a path.
    writeFileSync(path.join(path.dirname(common), 'escaped'), `${PRESENT_OID}\n`);
    const names = [
      'refs/../../escaped',
      'refs/orcaops/../../../escaped',
      'refs/orcaops/..\\..\\escaped',
      'refs/orcaops/./kept',
      'refs/orcaops/kept\0/../../escaped',
      'refs//orcaops',
      '../escaped',
      '/etc/passwd',
      'refs/',
      'escaped',
    ];
    const database = naming({
      publications: names.map((ref) => ({ ref, oid: PRESENT_OID })),
    });

    const inspected = refs(database, {
      projectDirectory: temporary('project-'),
      gitCommonDirectory: common,
    });

    expect(inspected).toHaveLength(names.length);
    expect(inspected.every((entry) => entry.presence === 'unknown')).toBe(true);
  });

  it('takes the Git directory the caller names over the one the database recorded', () => {
    const recorded = gitCommonDirectory({ loose: { 'refs/orcaops/kept': MOVED_OID } });
    const now = gitCommonDirectory({ loose: { 'refs/orcaops/kept': PRESENT_OID } });
    const database = naming({
      recordedCommonDirectory: recorded,
      publications: [{ ref: 'refs/orcaops/kept', oid: PRESENT_OID }],
    });
    const projectDirectory = temporary('project-');

    expect(inspectRetainedReferences(database, { projectDirectory })).toMatchObject({
      gitCommonDirectory: recorded,
      gitReferences: [{ presence: 'changed' }],
    });
    expect(
      inspectRetainedReferences(database, { projectDirectory, gitCommonDirectory: now })
    ).toMatchObject({ gitCommonDirectory: now, gitReferences: [{ presence: 'present' }] });
  });

  it('names every retained resource a legacy import holds, beside the publications', () => {
    const common = gitCommonDirectory({ loose: { 'refs/orcaops/imported': PRESENT_OID } });
    const database = naming({
      publications: [{ ref: 'refs/orcaops/published', oid: PRESENT_OID }],
      importedResources: JSON.stringify([{ ref: 'refs/orcaops/imported', oid: PRESENT_OID }]),
    });

    expect(
      inspectRetainedReferences(database, {
        projectDirectory: temporary('project-'),
        gitCommonDirectory: common,
      }).gitReferences
    ).toEqual([
      {
        ref: 'refs/orcaops/imported',
        objectOid: PRESENT_OID,
        namedBy: 'legacy_import.git_resources_json',
        retentionState: null,
        presence: 'present',
      },
      {
        ref: 'refs/orcaops/published',
        objectOid: PRESENT_OID,
        namedBy: 'git_retention_publications',
        retentionState: null,
        presence: 'absent',
      },
    ]);
  });
});

describe('the evidence files a database names', () => {
  function withEvidence(members: Array<{ relativePath: string; bytes: string }>): string {
    const projectDirectory = temporary('project-');
    for (const member of members) {
      const file = path.join(projectDirectory, ...member.relativePath.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, member.bytes);
    }
    return projectDirectory;
  }
  const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

  it('reads a file that matches as present, one whose bytes or size differ as changed, and a missing one as absent', () => {
    const kept = 'the bytes a review published';
    const projectDirectory = withEvidence([
      { relativePath: 'evidence/kept.json', bytes: kept },
      { relativePath: 'evidence/rewritten.json', bytes: 'the bytes a review publishe_' },
      { relativePath: 'evidence/grown.json', bytes: `${kept} and more` },
    ]);
    const database = naming({
      evidence: [
        {
          namedBy: 'review_evidence_members',
          relativePath: 'evidence/kept.json',
          sha256: digest(kept),
          byteLength: kept.length,
        },
        {
          namedBy: 'review_evidence_members',
          relativePath: 'evidence/rewritten.json',
          sha256: digest(kept),
          byteLength: kept.length,
        },
        {
          namedBy: 'review_evidence_members',
          relativePath: 'evidence/grown.json',
          sha256: digest(kept),
          byteLength: kept.length,
        },
        {
          namedBy: 'review_evidence_members',
          relativePath: 'evidence/gone.json',
          sha256: digest(kept),
          byteLength: kept.length,
        },
      ],
    });

    expect(files(database, { projectDirectory })).toEqual([
      {
        relativePath: 'evidence/gone.json',
        namedBy: 'review_evidence_members',
        presence: 'absent',
      },
      {
        relativePath: 'evidence/grown.json',
        namedBy: 'review_evidence_members',
        presence: 'changed',
      },
      {
        relativePath: 'evidence/kept.json',
        namedBy: 'review_evidence_members',
        presence: 'present',
      },
      {
        relativePath: 'evidence/rewritten.json',
        namedBy: 'review_evidence_members',
        presence: 'changed',
      },
    ]);
  });

  it('never reads a path that leaves the evidence directory', () => {
    const outside = 'what a row that became a path would reach';
    const projectDirectory = withEvidence([{ relativePath: 'secret.json', bytes: outside }]);
    const escaping = [
      'evidence/../secret.json',
      'evidence/reviews/../../secret.json',
      '../secret.json',
      'secret.json',
      '/etc/passwd',
      'evidence/./secret.json',
      'evidence//secret.json',
    ];
    const database = naming({
      evidence: escaping.map((relativePath) => ({
        namedBy: 'review_evidence_members' as const,
        relativePath,
        sha256: digest(outside),
        byteLength: outside.length,
      })),
    });

    const inspected = files(database, { projectDirectory });

    expect(inspected).toHaveLength(escaping.length);
    expect(inspected.every((entry) => entry.presence === 'unknown')).toBe(true);
  });

  it('reads a pending member and the published member of the same file as one file', () => {
    const kept = 'one file, published once and pending once';
    const projectDirectory = withEvidence([{ relativePath: 'evidence/floor.json', bytes: kept }]);
    const member = {
      relativePath: 'evidence/floor.json',
      sha256: digest(kept),
      byteLength: kept.length,
    };
    const database = naming({
      evidence: [
        { namedBy: 'pending_review_evidence_members', ...member },
        { namedBy: 'review_evidence_members', ...member },
        {
          namedBy: 'review_semantic_terminals',
          relativePath: 'evidence/model.json',
          sha256: digest(kept),
          byteLength: kept.length,
        },
      ],
    });

    expect(files(database, { projectDirectory })).toEqual([
      {
        relativePath: 'evidence/floor.json',
        namedBy: 'review_evidence_members',
        presence: 'present',
      },
      {
        relativePath: 'evidence/model.json',
        namedBy: 'review_semantic_terminals',
        presence: 'absent',
      },
    ]);
  });
});

describe('the references a backup reports as not found', () => {
  it('passes over a retired publication whose ref has been reclaimed, and over nothing else', () => {
    const common = gitCommonDirectory({
      loose: {
        'refs/orcaops/kept': PRESENT_OID,
        'refs/orcaops/retired-and-moved': PRESENT_OID,
      },
    });
    const database = naming({
      publications: [
        { ref: 'refs/orcaops/kept', oid: PRESENT_OID, state: 'selected' },
        { ref: 'refs/orcaops/retired-and-gone', oid: PRESENT_OID, state: 'retired' },
        { ref: 'refs/orcaops/retired-and-moved', oid: MOVED_OID, state: 'retired' },
        { ref: 'refs/orcaops/selected-and-gone', oid: PRESENT_OID, state: 'selected' },
      ],
    });
    const inspected = inspectRetainedReferences(database, {
      projectDirectory: temporary('project-'),
      gitCommonDirectory: common,
    });

    expect(
      inspected.gitReferences.map((entry) => [entry.ref, entry.retentionState, entry.presence])
    ).toEqual([
      ['refs/orcaops/kept', 'selected', 'present'],
      ['refs/orcaops/retired-and-gone', 'retired', 'absent'],
      ['refs/orcaops/retired-and-moved', 'retired', 'changed'],
      ['refs/orcaops/selected-and-gone', 'selected', 'absent'],
    ]);
    expect(retainedReferencesNotFound(inspected).gitReferences.map((entry) => entry.ref)).toEqual([
      'refs/orcaops/retired-and-moved',
      'refs/orcaops/selected-and-gone',
    ]);
  });
});
