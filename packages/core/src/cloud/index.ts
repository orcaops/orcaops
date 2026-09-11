// Only the setter leaves the package — the getter is client.ts's internal
// fallback and exporting it would invite reads around the explicit option.
export { setDefaultCliVersion } from './cli-version.js';
export * from './client.js';
export * from './cloud-access.js';
export * from './errors.js';
export * from './handshake.js';
export * from './hardened-fetch.js';
export * from './hash.js';
export * from './scrub-error.js';
export * from './source-plan-baseline.js';
export { toWireEvaluators, toWireUsage } from './sync-wire.js';
export * from './trpc-errors.js';
export * from './url.js';

export { classifyCloudSyncFailure } from './cloud-sync-failure.js';
