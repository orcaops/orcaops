import type { RestoredFixture } from './database-fixture.mjs';
import type { ReleasedFixture } from './released-fixture.mjs';

type Rows = ReleasedFixture['database']['rows'];

export interface SyntheticManifest {
  fixture: string;
  synthetic: true;
  statement: string;
  writers: {
    commit: string;
    exact_revision: Array<{ function: string; module: string; tables: string[] }>;
    source_plan: Array<{ function: string; module: string; tables: string[] }>;
  };
  storage_code_identity: {
    directory: string;
    compared: string;
    files: number;
    blob_listing_sha256: string;
    head_commit: string;
    working_tree_matches_head: boolean;
    releases: Array<{ tag: string; commit: string; differing_files: string[] }>;
    writer_import_closure: {
      entry_points: string[];
      files: number;
      packages: string[];
      packages_outside_the_workspace: string[];
      files_that_differ_from_a_release: Array<{
        file: string;
        differs_from: string[];
        effect_on_the_writers: string;
      }>;
    };
  };
  base: {
    released_fixture: string;
    released_content_sha256: string;
    tables_the_writers_changed: string[];
    unchanged_tables: number;
    released_receipts_kept_as_prefix: number;
    identity_cells_restored: string[];
  };
  generation: {
    command: string;
    procedure_sha256: string;
    node: string;
    sqlite_driver: { package: string; version: string; sqlite_version: string };
  };
  schema: {
    user_version: number;
    file: string;
    objects: number;
    object_kinds: Record<string, number>;
    sql_sha256: string;
    whitespace_normalized_sql_sha256: string;
  };
  content: {
    composed_sha256: string;
    tables: Record<string, { rows: number; sha256: string }>;
    operations_by_kind: Record<string, number>;
    coverage: {
      criterion_lineage_by_kind_and_scope: Record<string, number>;
      claim_revisions_with_and_without_verification: Record<string, number>;
      decision_revisions: number;
      relationships_by_relation_and_scope: Record<string, number>;
      relationship_still_naming_a_first_revision: {
        relationship_id: string;
        to_revision_id: string;
        later_revision_id: string;
      };
      same_relationship_at_two_scopes: [string, string];
      same_relationship_on_two_branches: [string, string];
      same_adoption_on_two_branches: {
        target_revision_id: string;
        approver: string;
        branches: string[];
      };
      relationships_by_endpoint_kinds: Record<string, number>;
      relationships_joining_two_records: number;
      adoptions_by_approver: Record<string, number>;
      revisions_whose_id_sorts_before_their_predecessor: string[];
      tables_inserted_against_primary_key_order: string[];
      adoptions_by_target_and_scope: Record<string, number>;
      assessment_observed_counters: Array<{
        write_sequence: number;
        intent_change_counter: number;
      }>;
    };
  };
  covers: string[];
  not_covered: string[];
}
export interface SyntheticFixture {
  manifest: SyntheticManifest;
  database: { schemaVersion: number; base: string; rows: Rows };
  base: ReleasedFixture;
  schema: ReleasedFixture['schema'];
  rows: Rows;
}

export const SYNTHETIC_FIXTURE_DIRECTORY: string;
export const SYNTHETIC_BASE_RELEASE: string;
export function readSyntheticFixture(): Promise<SyntheticFixture>;
export function restoreSyntheticFixture(candidate: string): Promise<RestoredFixture>;
