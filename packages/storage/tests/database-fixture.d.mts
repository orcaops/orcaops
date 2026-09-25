import type Database from 'better-sqlite3';
import type { ProjectDatabaseAuthority } from '@orcaops/storage/history/database';
export interface FixtureSnapshot {
  version: number;
  definitions: Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  foreignKeys: unknown[];
  rows: Record<string, Array<Record<string, unknown>>>;
}
export interface RestoredFixture {
  Database: typeof Database;
  saved: { rows: FixtureSnapshot['rows']; requests?: unknown[]; evidence?: unknown[] };
  authority: ProjectDatabaseAuthority;
  file: string;
  temporary: string;
  cleanup(): Promise<void>;
}
export function snapshot(driver: typeof Database, file: string): FixtureSnapshot;
export function restoreFixture(
  candidate: string,
  fixture: string,
  expectedVersion?: number,
  options?: {
    validateSchema?(
      database: Database.Database,
      saved: { schemaVersion: number; definitions: FixtureSnapshot['definitions'] }
    ): void;
  }
): Promise<RestoredFixture>;
export function encode(value: unknown): unknown;
export function decode(value: unknown): unknown;
