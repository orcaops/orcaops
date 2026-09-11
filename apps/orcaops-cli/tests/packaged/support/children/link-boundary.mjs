// A test-only Node preload that parks the packaged CLI between the registration
// marker's temporary write and its hard link, so a real SIGKILL lands in that
// window. It patches node:fs/promises inside the spawned process and republishes
// the ESM bindings — the pattern already accepted in
// packages/core/src/history/setup/fixtures/setup-child.mjs and in the
// registration-files qualification script. Production source is untouched.
//
// The announcement uses fs.writeSync on fd 2 because the process suspends itself
// immediately afterwards and a buffered stream write would never drain.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (process.env.PACKAGED_GATE_LINK_BOUNDARY === '1') {
  const link = fs.promises.link;
  let parked = false;
  fs.promises.link = async function patchedLink(temporary, final, ...rest) {
    if (!parked) {
      parked = true;
      fs.writeSync(2, `PACKAGED_GATE_LINK ${JSON.stringify({ temporary, final })}\n`);
      process.kill(process.pid, 'SIGSTOP');
    }
    return link.call(this, temporary, final, ...rest);
  };
  syncBuiltinESMExports();
}
