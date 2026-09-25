// One process adopting one revision against the state it observed, so two of these can race for
// real: each preparation sees a store nothing governs yet, and only the database serializes them.
// Loads the built package the way the other cross-process control scripts here do.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [candidate, payloadJson] = process.argv.slice(2);
const load = (file) =>
  import(pathToFileURL(path.join(path.resolve(candidate), 'packages/storage/dist', file)));
const api = await load('history/database/index.js');
const payload = JSON.parse(payloadJson);

if (typeof api.publishProjectSelection !== 'function') {
  process.stdout.write(JSON.stringify({ ok: false, code: 'BUILD_STALE' }));
  process.exit(0);
}

const handle = await api.openProjectDatabase({ authority: payload.authority, mode: 'writer' });
try {
  const result = await api.publishProjectSelection(handle, {
    operationId: payload.operationId,
    selection: payload.selection,
    selectedBy: payload.selectedBy,
    acceptedAt: payload.acceptedAt,
    secretAllow: [],
  });
  process.stdout.write(JSON.stringify({ ok: true, selectionId: result.value.selectionId }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'UNKNOWN' }));
} finally {
  handle.close();
}
