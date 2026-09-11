// Runs the compiled setupProjectDatabase in its own process and parks it at a
// named registration boundary so the parent can kill it there.
//
// The boundaries are reached by patching node:fs/promises in this child and
// republishing the ESM bindings. Production code needs no test hooks.
//
//   before-link   the complete temporary marker exists, the final name does not
//   after-init    the project database is initialized, the marker is not written
//   empty-created the exclusive database file exists before initialization commits
//
// The announcement uses fs.writeSync on fd 2 because the process suspends itself
// immediately afterwards.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const input = JSON.parse(process.argv[2]);
const boundary = input.boundary ?? null;

const park = (detail) => {
  fs.writeSync(2, `PACKAGED_GATE_REGISTRATION ${boundary} ${JSON.stringify(detail)}\n`);
  process.kill(process.pid, 'SIGSTOP');
};

if (boundary === 'before-link') {
  const link = fs.promises.link;
  let parked = false;
  fs.promises.link = async function patchedLink(temporary, final) {
    if (!parked) {
      parked = true;
      park({ temporary, final });
    }
    return link.call(this, temporary, final);
  };
  syncBuiltinESMExports();
} else if (boundary === 'after-init') {
  const open = fs.promises.open;
  let parked = false;
  fs.promises.open = async function patchedOpen(file, flags, ...rest) {
    const handle = await open.call(this, file, flags, ...rest);
    if (!parked && typeof file === 'string' && file.includes('registration.json')) {
      parked = true;
      park({ file: String(file), flags: String(flags) });
    }
    return handle;
  };
  syncBuiltinESMExports();
} else if (boundary === 'empty-created') {
  const openSync = fs.openSync;
  const database = `${input.root}/projects/${input.projectId}/history.sqlite3`;
  let parked = false;
  fs.openSync = function patchedOpenSync(file, flags, ...rest) {
    const descriptor = openSync.call(this, file, flags, ...rest);
    if (!parked && file === database && flags === 'wx') {
      parked = true;
      park({ file: String(file), flags: String(flags) });
    }
    return descriptor;
  };
  syncBuiltinESMExports();
}

const { setupProjectDatabase } = await import(input.modules.databaseSetup);
try {
  const result = await setupProjectDatabase({
    cwd: input.cwd,
    root: input.root,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    authoredPayloads: [],
    secretAllow: [],
  });
  process.stdout.write(`${JSON.stringify({ kind: 'result', status: result.status })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ kind: 'failure', code: error.code, message: error.message })}\n`
  );
  process.exitCode = 1;
}
