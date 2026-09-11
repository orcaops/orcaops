// A test-only Node preload that parks the packaged CLI after its project database
// has been created and before registration publishes anything, so a real SIGKILL
// lands in that interval.
//
// The boundary is the first open of a path naming the registration marker — the
// temporary write that precedes the hard link — so at the park point the database
// exists and no marker or catalog entry has been published. It is the same
// technique row 9's link boundary uses and the same fs patch plus
// syncBuiltinESMExports pattern already accepted in the compiled-child
// registration scenarios. Production source is untouched.
//
// The announcement uses fs.writeSync on fd 2 because the process suspends itself
// immediately afterwards and a buffered stream write would never drain.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (process.env.PACKAGED_GATE_PUBLISH_BOUNDARY === '1') {
  const open = fs.promises.open;
  let parked = false;
  fs.promises.open = async function patchedOpen(file, flags, ...rest) {
    const name = typeof file === 'string' ? file : String(file);
    if (!parked && name.includes('registration.json')) {
      parked = true;
      fs.writeSync(2, `PACKAGED_GATE_PUBLISH ${JSON.stringify({ file: name })}\n`);
      process.kill(process.pid, 'SIGSTOP');
    }
    return open.call(this, file, flags, ...rest);
  };
  syncBuiltinESMExports();
}
