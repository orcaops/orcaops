import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const configuration = JSON.parse(process.argv[2]);
const controller = new globalThis.AbortController();
// process.send is asynchronous: a large trace must drain before the channel closes.
const send = (message) =>
  new Promise((resolve) => {
    if (!process.send) resolve();
    else process.send(message, resolve);
  });
let release = () => {};
const released = new Promise((resolve) => {
  release = resolve;
});
process.on('message', (message) => {
  if (message === 'cancel') controller.abort();
  if (message === 'start') release();
});

// Announced on stderr rather than the message channel because the process suspends
// itself on the next line and a queued message would never drain.
const park = (name) => {
  fs.writeSync(2, `PARKED ${name}\n`);
  process.kill(process.pid, 'SIGSTOP');
};

// Observations are recorded so a refusing initializer can be traced back to the exact
// filesystem state it saw, not just to the code it returned.
const observations = [];
const now = () => performance.timeOrigin + performance.now();
const record = (call, target, outcome) => {
  const location = String(target);
  if (!configuration.watch.some((prefix) => location.startsWith(prefix))) return;
  observations.push({ at: now(), call, path: location, outcome });
  if (observations.length > 4000) observations.shift();
};
const observe = (owner, name, describe, boundary) => {
  const original = owner[name];
  let parked = false;
  owner[name] = async function (target, ...rest) {
    let value;
    let failure;
    try {
      value = await original.call(this, target, ...rest);
      record(name, target, describe(value));
    } catch (cause) {
      failure = cause;
      record(name, target, cause.code ?? 'failed');
    }
    if (!parked && boundary?.(String(target), failure)) {
      parked = true;
      park(configuration.boundary);
    }
    if (failure) throw failure;
    return value;
  };
};
const absentProjects = (target, failure) =>
  configuration.boundary === 'absent-projects' &&
  target === path.join(configuration.input.root, 'projects') &&
  failure?.code === 'ENOENT';
const beforeRegistration = (target, failure) =>
  configuration.boundary === 'before-registration' &&
  target.includes('registration.json') &&
  !failure;
observe(
  fs.promises,
  'lstat',
  (value) => (value.isDirectory() ? 'directory' : value.isFile() ? `file ${value.size}` : 'other'),
  absentProjects
);
observe(fs.promises, 'readdir', (value) => `[${value.slice(0, 24).join(' ')}]`);
observe(fs.promises, 'open', () => 'opened', beforeRegistration);
observe(
  fs.promises,
  'mkdir',
  () => 'created',
  (target, failure) =>
    configuration.boundary === 'project-directory' &&
    target === path.join(configuration.input.root, 'projects', configuration.input.projectId) &&
    !failure
);
syncBuiltinESMExports();

const chain = (cause) => {
  const entries = [];
  let value = cause;
  while (value instanceof Error && entries.length < 8) {
    entries.push({
      name: value.name,
      code: value.code ?? null,
      reason: value.reason ?? null,
      message: value.message,
      path: value.context?.path ?? null,
    });
    value = value.cause ?? value.context?.cause;
  }
  return entries;
};

const { setupProjectDatabase } = await import(configuration.module);
await send({ type: 'ready' });
if (configuration.barrier) await released;
const started = now();
try {
  const result = await setupProjectDatabase(configuration.input, {
    signal: controller.signal,
    onWait: (wait) => void send({ type: 'wait', wait }),
  });
  await send({
    type: 'result',
    started,
    settled: now(),
    result,
    observationCount: observations.length,
    observations: observations.slice(-40),
  });
} catch (cause) {
  await send({
    type: 'error',
    started,
    settled: now(),
    code: cause.code,
    message: cause.message,
    chain: chain(cause),
    observationCount: observations.length,
    observations: observations.slice(-220),
  });
} finally {
  process.disconnect();
}
