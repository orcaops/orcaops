import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';

// Static commands import storage without needing an installed SQLite driver.
export function loadDatabase(): typeof Database {
  return createRequire(import.meta.url)('better-sqlite3') as typeof Database;
}
