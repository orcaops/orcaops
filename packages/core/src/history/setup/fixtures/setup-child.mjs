import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const configuration = JSON.parse(process.argv[2]);
const controller = new globalThis.AbortController();
process.on('message', (message) => {
  if (message === 'cancel') controller.abort();
});
const send = (message) => process.send?.(message);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const pause = (type) => {
  send({ type });
  // A release must survive arriving between the announcement and the synchronous wait.
  const release = path.join(configuration.controlDirectory, type);
  while (!fs.existsSync(release)) Atomics.wait(sleeper, 0, 0, 10);
  fs.unlinkSync(release);
};
const projectDirectory = path.join(
  configuration.input.root,
  'projects',
  configuration.input.projectId
);
const mkdir = fs.promises.mkdir;
let pausedDirectory = false;
fs.promises.mkdir = async function (directory, ...args) {
  if (!pausedDirectory && directory === projectDirectory) {
    pausedDirectory = true;
    pause('before-project-directory');
  }
  return mkdir.call(this, directory, ...args);
};
const openSync = fs.openSync;
fs.openSync = function (file, flags, ...args) {
  const descriptor = openSync.call(this, file, flags, ...args);
  if (
    configuration.pauseEmpty &&
    file === path.join(projectDirectory, 'history.sqlite3') &&
    flags === 'wx'
  )
    pause('empty-created');
  return descriptor;
};
syncBuiltinESMExports();
try {
  const { setupProjectDatabase } = await import(configuration.module);
  const result = await setupProjectDatabase(configuration.input, {
    signal: controller.signal,
    onWait: (wait) => {
      send({ type: 'wait', wait });
      if (configuration.pauseWaitAttempts?.includes(wait.attempt)) pause(`wait-${wait.attempt}`);
    },
  });
  send({ type: 'result', result });
} catch (cause) {
  send({ type: 'error', code: cause.code, message: cause.message });
} finally {
  process.disconnect();
}
