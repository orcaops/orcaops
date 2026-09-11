import { fileURLToPath } from 'node:url';

const from = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** The published CLI entry point. Scenarios spawn this file, never the TS sources. */
export const packagedCli = from('../../../bin/orcaops.js');

/**
 * The unbundled Node data sidecar. `apps/orcaops-watch/dist/sidecar.js` is a Bun
 * bundle of the same entry; the gate drives the Node build because better-sqlite3's
 * native addon only loads under Node.
 */
export const packagedSidecar = from('../../../../../packages/watch-data/dist/sidecar.js');

/** Compiled modules the seeding and boundary children import. */
export const compiled = {
  databaseSetup: from('../../../../../packages/core/dist/history/setup/setup.js'),
  databaseContext: from('../../../../../packages/core/dist/history/context/execution.js'),
  registrationFiles: from('../../../../../packages/core/dist/history/registration-files.js'),
  storage: from('../../../../../packages/storage/dist/index.js'),
  storageDatabase: from('../../../../../packages/storage/dist/history/database/index.js'),
  draftPreparation: from('../../../../../packages/storage/dist/artifacts/draft-preparation.js'),
  executionCapture: from(
    '../../../../../packages/storage/dist/history/database/execution-capture.js'
  ),
  /** The module whose createRequire resolves the driver the CLI actually loads. */
  storageConnection: from('../../../../../packages/storage/dist/history/database/connection.js'),
};

export const children = {
  seed: from('./children/seed.mjs'),
  sqliteHolder: from('./children/sqlite-holder.mjs'),
  commitBoundary: from('./children/commit-boundary.mjs'),
  registrationBoundary: from('./children/registration-boundary.mjs'),
  linkBoundary: from('./children/link-boundary.mjs'),
  publishBoundary: from('./children/registration-publish-boundary.mjs'),
};
