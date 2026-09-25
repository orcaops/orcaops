// What a passive open says about a schema version it cannot read.
//
// Three distinct outcomes, each a typed error a caller can branch on: the released predecessor
// needs the explicit upgrade, a development version was never released, and a newer version
// belongs to a newer build. None of them changes the file and none of them offers rebuilding,
// reinitializing or deleting as a recovery, because a database this build cannot open is still
// the whole of someone's history.
import { ProjectDatabaseError } from './errors.js';
import { RELEASED_SCHEMA_VERSION } from './released-schema.js';
import { PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';

export const PROJECT_DATABASE_UPGRADE_COMMAND = 'orcaops history upgrade';

export function newerSchemaRefusal(version: number): ProjectDatabaseError {
  return new ProjectDatabaseError(
    'HISTORY_FORMAT_NEWER',
    `This database is schema ${version}, written by a newer build; use that build. Nothing was changed`
  );
}

export function developmentSchemaRefusal(version: number): ProjectDatabaseError {
  return new ProjectDatabaseError(
    'HISTORY_FORMAT_UNSUPPORTED',
    `Schema ${version} was never released and has no upgrade; preserve the database. Nothing was changed`
  );
}

export function upgradeRequiredRefusal(version: number): ProjectDatabaseError {
  return new ProjectDatabaseError(
    'HISTORY_UPGRADE_REQUIRED',
    `This database is schema ${version}, the released format; this build reads schema ${PROJECT_DATABASE_SCHEMA_VERSION} and never upgrades a database on its own. Preview the upgrade with \`${PROJECT_DATABASE_UPGRADE_COMMAND}\` and perform it with \`${PROJECT_DATABASE_UPGRADE_COMMAND} --apply\`, which takes a verified backup first. Nothing was changed`
  );
}

// Only released definitions may enter the upgrade path.
export function projectSchemaVersionRefusal(version: number): ProjectDatabaseError | null {
  if (version === PROJECT_DATABASE_SCHEMA_VERSION) return null;
  if (version > PROJECT_DATABASE_SCHEMA_VERSION) return newerSchemaRefusal(version);
  if (version === RELEASED_SCHEMA_VERSION) return upgradeRequiredRefusal(version);
  return developmentSchemaRefusal(version);
}
