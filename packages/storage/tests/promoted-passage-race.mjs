// One process promoting one passage, so two of these can race for real: separate processes see
// an empty store in their own preparation and only the database serializes them. Loads the built
// package the way the other cross-process control scripts here do.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [candidate, payloadJson] = process.argv.slice(2);
const load = (file) =>
  import(pathToFileURL(path.join(path.resolve(candidate), 'packages/storage/dist', file)));
const api = await load('history/database/index.js');
const payload = JSON.parse(payloadJson);

if (typeof api.createProjectRequirement !== 'function') {
  process.stdout.write(JSON.stringify({ ok: false, code: 'BUILD_STALE' }));
  process.exit(0);
}

const handle = await api.openProjectDatabase({ authority: payload.authority, mode: 'writer' });
try {
  const result = await api.createProjectRequirement(handle, {
    operationId: payload.operationId,
    identity: payload.identity,
    revision: payload.revision,
    attributedTo: payload.attributedTo,
    secretAllow: [],
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      published: result.value.published,
      requirementId: result.value.requirementId,
    })
  );
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'UNKNOWN' }));
} finally {
  handle.close();
}
