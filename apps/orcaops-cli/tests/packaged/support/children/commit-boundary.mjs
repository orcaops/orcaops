// A test-only Node preload that parks the packaged CLI at the SQLite COMMIT
// boundary of its first WRITE transaction so the parent can kill it there. It
// patches the driver inside the child's own process — production source is
// untouched, so the scenario qualifies exactly the code that ships.
//
// PACKAGED_GATE_BOUNDARY selects the side of the boundary:
//   before-commit  suspended with the write transaction still open
//   after-commit   suspended with the write transaction committed
//
// Only a COMMIT that closes a BEGIN IMMEDIATE counts. Short read transactions
// commit too, and the first COMMIT in the process is one of those — parking there
// would name a previously committed operation and prove nothing.
//
// Announcements go through fs.writeSync on fd 2 because the process suspends
// itself immediately afterwards, and a buffered stream write would never drain.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const mode = process.env.PACKAGED_GATE_BOUNDARY;
if (mode) {
  // Resolve the driver the way packages/storage/dist does, so the patch lands on
  // the same CJS module instance the CLI will use.
  const Database = createRequire(process.env.PACKAGED_GATE_DRIVER_ANCHOR)('better-sqlite3');
  const exec = Database.prototype.exec;
  const writing = new WeakSet();
  let announced = false;
  const announce = (database) => {
    announced = true;
    let operationId = '';
    try {
      operationId =
        database.prepare('SELECT operation_id FROM operations ORDER BY rowid DESC LIMIT 1').get()
          ?.operation_id ?? '';
    } catch {
      operationId = '';
    }
    fs.writeSync(2, `PACKAGED_GATE_BOUNDARY ${mode} ${operationId}\n`);
    process.kill(process.pid, 'SIGSTOP');
  };
  Database.prototype.exec = function patchedExec(sql) {
    if (/^\s*BEGIN\s+IMMEDIATE\b/i.test(sql)) {
      const result = exec.call(this, sql);
      writing.add(this);
      return result;
    }
    if (!/^\s*COMMIT\b/i.test(sql)) return exec.call(this, sql);
    const wasWriting = writing.delete(this);
    if (announced || !wasWriting) return exec.call(this, sql);
    if (mode === 'before-commit') {
      announce(this);
      return exec.call(this, sql);
    }
    const result = exec.call(this, sql);
    announce(this);
    return result;
  };
}
