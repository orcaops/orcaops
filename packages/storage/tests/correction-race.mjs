// One process appending a correction against the state it observed, so two of these can race for
// real: each preparation sees the same governing state, and only the database serializes them.
// Loads the built package the way the other cross-process control scripts here do.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [candidate, payloadJson] = process.argv.slice(2);
const load = (file) =>
  import(pathToFileURL(path.join(path.resolve(candidate), 'packages/storage/dist', file)));
const api = await load('history/database/index.js');
const payload = JSON.parse(payloadJson);

if (typeof api.appendProjectCorrection !== 'function') {
  process.stdout.write(JSON.stringify({ ok: false, code: 'BUILD_STALE' }));
  process.exit(0);
}

const handle = await api.openProjectDatabase({ authority: payload.authority, mode: 'writer' });
try {
  const result = await api.appendProjectCorrection(handle, {
    operationId: payload.operationId,
    action: payload.action,
    attributedTo: payload.attributedTo,
    recordedAt: payload.recordedAt,
    secretAllow: [],
  });
  process.stdout.write(JSON.stringify({ ok: true, actionId: result.value.actionId }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'UNKNOWN' }));
} finally {
  handle.close();
}
