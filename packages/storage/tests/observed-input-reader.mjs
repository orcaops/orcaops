// A real process that reads exactly the inputs a runner handed it and says what it read: one
// `{name, sha256}` per input, hashed from the bytes this process opened, on stdout as JSON.
//
// Nothing here is told what the digests are supposed to be, so a test comparing them with the ones
// an observation names is comparing what was consumed with what was claimed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// A test that changes an input under this process needs the change to land before this process
// reads, and to be undone before it exits: that is the window a runner that handed over originals
// would leave open. So this announces when it has started, waits to be told to read, announces
// what it read, and waits again before exiting.
const announce = (file, body = '') => {
  if (file !== undefined) writeFileSync(file, body);
};
const until = async (file) => {
  while (file !== undefined && !existsSync(file)) await delay(5);
};

announce(process.env.OBSERVED_RUN_ANNOUNCE);
await until(process.env.OBSERVED_RUN_WAIT_FOR);

const handed = JSON.parse(process.env.ORCAOPS_OBSERVED_INPUTS ?? '[]');
const read = handed.map((input) => ({
  name: input.name,
  sha256: createHash('sha256').update(readFileSync(input.path)).digest('hex'),
}));
announce(process.env.OBSERVED_RUN_READ, JSON.stringify(read));
// A process rewriting or removing its own copy is the one change a private copy cannot rule out.
if (process.env.OBSERVED_RUN_REWRITE !== undefined)
  for (const input of handed) writeFileSync(input.path, 'rewritten by the process\n');
if (process.env.OBSERVED_RUN_REMOVE !== undefined) for (const input of handed) rmSync(input.path);
await until(process.env.OBSERVED_RUN_WAIT_TO_EXIT);
process.stdout.write(`${JSON.stringify(read)}\n`);
process.exit(
  process.env.OBSERVED_RUN_EXIT === undefined ? 0 : Number(process.env.OBSERVED_RUN_EXIT)
);
