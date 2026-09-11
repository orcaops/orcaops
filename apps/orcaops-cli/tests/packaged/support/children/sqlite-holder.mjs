// A raw better-sqlite3 writer that takes the WAL write lock and then holds it.
// It never mutates a row: BEGIN IMMEDIATE alone is the contention, so anything a
// scenario observes in the store came from the packaged process under test.
import { createRequire } from 'node:module';

const Database = createRequire(import.meta.url)('better-sqlite3');
const database = new Database(process.argv[2]);

database.exec('BEGIN IMMEDIATE');
process.send({ kind: 'holding', pid: process.pid });

process.on('message', (message) => {
  if (message !== 'release') return;
  database.exec('ROLLBACK');
  database.close();
  process.disconnect();
  process.exit(0);
});
