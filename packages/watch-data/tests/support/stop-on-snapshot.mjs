import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const originalWrite = process.stdout.write;
let stopped = false;

function trackStartup(fn, name) {
  return function (...args) {
    if (stopped) process.stderr.write(`${name} started after shutdown\n`);
    return Reflect.apply(fn, this, args);
  };
}

fs.watch = trackStartup(fs.watch, 'watcher');
syncBuiltinESMExports();
globalThis.setInterval = trackStartup(globalThis.setInterval, 'timer');
process.stdin.resume = trackStartup(process.stdin.resume, 'stdin');

process.stdout.write = function (...args) {
  const result = Reflect.apply(originalWrite, this, args);
  if (!stopped && String(args[0]).startsWith('{')) {
    stopped = true;
    // Deliver shutdown before engine.start() returns, without relying on OS scheduling.
    const event = process.env.WATCH_TEST_STOP;
    const handled = event === 'stdin' ? process.stdin.emit('end') : process.emit(event);
    if (!handled) throw new Error(`No shutdown handler at first snapshot: ${event}`);
  }
  return result;
};
