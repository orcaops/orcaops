import type Database from 'better-sqlite3';

import type { FixtureSnapshot, RestoredFixture } from './database-fixture.mjs';

type Definitions = FixtureSnapshot['definitions'];
type Rows = Record<string, Array<Record<string, unknown>>>;

export interface ReleasedSchemaDigests {
  objects: number;
  object_kinds: Record<string, number>;
  sql_sha256: string;
  whitespace_normalized_sql_sha256: string;
}
export interface ReleasedRetainedRef {
  ref: string;
  object: string;
  tree: string;
  named_by: string;
  role?: string;
  artifact_id?: string;
  artifact_label?: string;
  artifact_origin?: string;
  review_id?: string;
  review_branch?: string;
  checkpoint?: number;
  phase?: string;
}
export interface ReleasedProducer {
  package: string;
  version: string;
  registry: { integrity: string; shasum: string; tarball: string };
  tarball: { integrity: string; shasum: string; bytes: number };
  installed: { version: string; resolved: string; integrity: string; reported_version: string };
  dependencies: Array<{ path: string; version: string; integrity?: string; bundled?: true }>;
  runtime: {
    node: string;
    node_sha256?: string;
    modules_abi: string;
    platform: string;
    arch: string;
  };
  sqlite_driver?: {
    package: string;
    version: string;
    sqlite_version: string;
    addon: string;
    addon_sha256: string | null;
  };
}
export interface ReleasedManifest {
  fixture: string;
  producer: ReleasedProducer;
  legacy_producer?: ReleasedProducer;
  conversion?: {
    operation_id: string;
    source_profile: string;
    source_revision: string;
    source_manifest_sha256: string;
    counts: Record<string, number>;
    omitted_families: string[];
  };
  generation: {
    command: string;
    procedure_sha256: Record<string, string>;
    captured_events_between: [string, string];
    workflow: Array<{
      worktree: string;
      command: string;
      exit_code: number;
      ok: boolean;
      error?: string | null;
      cloud_sync?: string;
    }>;
    isolation: { user_directories: Array<{ path: string; exists: boolean; changed: string[] }> };
    integrity_check: string;
  };
  original_database: {
    note: string;
    files: Array<{
      name: string;
      bytes: number;
      sha256: string;
      stored_as: string;
      stored_sha256: string;
    }>;
    pragmas: Record<string, string | number>;
    total_rows: number;
    write_ahead_log: {
      page_size: number | null;
      checkpoint_sequence: number | null;
      frames: number;
      rows_in_main_file_alone: number;
      rows_only_in_the_log: number;
      main_file_alone_integrity_check: string;
    };
  };
  schema: ReleasedSchemaDigests & { user_version: number; file: string; shared_definition: string };
  content: {
    sha256: string;
    tables: Record<string, { rows: number; sha256: string }>;
    empty_tables: Record<
      string,
      { reason: string; basis?: string; insert_statements_in_the_bundle: number }
    >;
    empty_table_reasons: Record<string, string>;
    operations_by_kind: Record<string, number>;
    events_by_type: Record<string, number>;
    artifacts_by_origin_and_state: Record<string, number>;
    evaluator_verdicts_by_severity: Record<string, number>;
    import_origin_tool_versions: string[];
    review_evidence: { files: number; bytes: number; sha256: string };
    machine_specific_cells: {
      naming_the_run_directory: string[];
      identifying_the_repository: string[];
      note: string;
    };
  };
  retained_git_evidence: {
    bundle: { file: string; bytes: number; sha256: string };
    refs: ReleasedRetainedRef[];
  };
  not_exercised: string[];
}
export interface ReleasedEvidenceMember {
  relativePath: string;
  sha256: string;
  bytes: { blobHex: string };
}
export interface ReleasedFixture {
  manifest: ReleasedManifest;
  database: { schemaVersion: number; rows: Rows; evidence: ReleasedEvidenceMember[] };
  schema: { schemaVersion: number; definitions: Definitions };
  bundle: Buffer;
}
export interface FixtureImage {
  schemaVersion: number;
  definitions: Definitions;
  rows: Rows;
  evidence?: ReleasedEvidenceMember[];
}

export const RELEASED_FIXTURE_DIRECTORY: string;
export const RELEASED_SCHEMA_FILE: string;
export const RETAINED_REFS_BUNDLE: string;
export const ORIGINAL_FILE_SUFFIX: string;
export function releasedFixtureDirectory(name: string): string;
export function tableDigest(rows: Array<Record<string, unknown>>): string;
export function databaseDigest(rows: Rows): string;
export function schemaDigests(definitions: Definitions): ReleasedSchemaDigests;
export function countBy(
  rows: Array<Record<string, unknown>>,
  column: string
): Record<string, number>;
export function blobBytes(value: unknown): Buffer;
export function readReleasedFixture(name: string): Promise<ReleasedFixture>;
export function validateOwnDefinitions(
  database: Database.Database,
  saved: { schemaVersion: number; definitions: Definitions }
): void;
export function restoreFixtureImage(
  candidate: string,
  image: FixtureImage
): Promise<RestoredFixture>;
export function restoreReleasedFixture(candidate: string, name: string): Promise<RestoredFixture>;
export function materializeOriginalDatabase(
  name: string
): Promise<{ directory: string; main: string; cleanup(): Promise<void> }>;
