// The explicit project-database upgrade and its backups, at the terminal.
//
// Nothing here runs by itself: a read refuses an older database and names `orcaops history
// upgrade`, and the upgrade previews by default, the way `history convert` does. Only `--apply`
// writes, and only after storage has taken and verified a backup.
import path from 'node:path';

import { Repo } from '@orcaops/core';
import { readRepositoryRegistration } from '@orcaops/core/history/registration';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  type ListedProjectDatabaseBackup,
  listProjectDatabaseBackups,
  previewProjectDatabaseUpgrade,
  type ProjectCounters,
  type ProjectDatabaseAuthority,
  type ProjectDatabaseBackupSummary,
  ProjectDatabaseError,
  projectDatabasePath,
  type ProjectDatabaseUpgradePreview,
  projectDatabaseUpgradeRefusal,
  type ProjectDatabaseUpgradeResult,
  restoreProjectDatabaseBackup,
  type RestoreProjectDatabaseBackupResult,
  upgradeProjectDatabase,
} from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import {
  getInvocationCwd,
  getInvocationEnv,
  getInvocationRootOverride,
} from '../lib/invocation-context.js';

export interface HistoryUpgradeCommandOptions {
  readonly apply?: boolean;
  readonly json?: boolean;
}

export interface HistoryBackupsCommandOptions {
  readonly json?: boolean;
}

export interface HistoryRestoreCommandOptions {
  readonly apply?: boolean;
  readonly json?: boolean;
}

interface RegisteredProject {
  readonly authority: ProjectDatabaseAuthority;
  readonly gitCommonDirectory: string;
}

// Ctrl-C and a terminating signal both cancel through the abort signal storage already takes,
// which it observes only where nothing has changed yet.
async function withInterrupt<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    return await run(controller.signal);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

// The repository's registration marker, never the database. Every command here exists for a
// database the ordinary open refuses, and the shared registered-context reader opens it.
async function registeredProject(): Promise<RegisteredProject> {
  const invocationCwd = getInvocationCwd();
  const env = { ...getInvocationEnv() };
  const override = getInvocationRootOverride() ?? env.ORCAOPS_ROOT;
  const cwd = override?.trim() ? path.resolve(invocationCwd, override) : invocationCwd;
  const root = await normalizeHistoryRoot({ cwd: invocationCwd, env });
  let commonDir: string;
  try {
    commonDir = await new Repo(cwd).getCommonDirAbsolute();
  } catch (cause) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Run this from the Git repository whose project database you mean. Nothing was changed',
      { cause }
    );
  }
  const registration = await readRepositoryRegistration({ commonDir, requestedRoot: root });
  if (!registration)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'This repository has no registered project database. Run `orcaops doctor` to inspect it. Nothing was changed'
    );
  return {
    authority: {
      resolvedRoot: registration.authority.resolved_root,
      rootKey: registration.authority.root_key,
      projectId: registration.authority.project_id,
      storeInstanceId: registration.authority.store_instance_id,
      repositoryInstanceId: registration.repository_instance_id,
    },
    gitCommonDirectory: commonDir,
  };
}

function refuse(cause: unknown, json: boolean): never {
  if (json) emitError(cause);
  writeErrorLine(cause);
  throw new CliExit(1);
}

const counterFields = (counters: ProjectCounters | null) => ({
  write_sequence: counters?.writeSequence ?? null,
  intent_change_counter: counters?.intentChangeCounter ?? null,
});

const notFoundFields = (notFound: ProjectDatabaseUpgradePreview['retainedReferencesNotFound']) => ({
  git_references: (notFound?.gitReferences ?? []).map((entry) => ({
    ref: entry.ref,
    object_oid: entry.objectOid,
    named_by: entry.namedBy,
    presence: entry.presence,
  })),
  evidence_files: (notFound?.evidenceFiles ?? []).map((entry) => ({
    relative_path: entry.relativePath,
    sha256: entry.sha256,
    named_by: entry.namedBy,
    presence: entry.presence,
  })),
});

function renderNotFound(
  notFound: ProjectDatabaseUpgradePreview['retainedReferencesNotFound']
): string[] {
  const references = notFound?.gitReferences ?? [];
  const files = notFound?.evidenceFiles ?? [];
  if (!references.length && !files.length)
    return [
      'Retained references     every Git ref and evidence file the database names is present',
    ];
  return [
    `Retained references     ${references.length + files.length} the database names could not be found`,
    ...references.map((entry) => `  git ${entry.ref} (${entry.presence})`),
    ...files.map((entry) => `  evidence ${entry.relativePath} (${entry.presence})`),
  ];
}

function renderPlan(plan: ProjectDatabaseUpgradePreview['plan']): string[] {
  if (!plan) return [];
  return [
    'Rebuilt tables',
    ...plan.rebuiltTables.map((entry) => `  ${entry.table.padEnd(22)} ${entry.rows} row(s)`),
  ];
}

function previewEnvelope(preview: ProjectDatabaseUpgradePreview) {
  return {
    schema_version: 1,
    mode: 'preview' as const,
    changed: false,
    state: preview.state,
    database: preview.databasePath,
    from_version: preview.schemaVersion,
    to_version: preview.currentSchemaVersion,
    counters: counterFields(preview.counters),
    rebuilt_tables: (preview.plan?.rebuiltTables ?? []).map((entry) => ({
      table: entry.table,
      rows: entry.rows,
      added_columns: Object.keys(entry.addedColumns),
    })),
    backup_directory: preview.backup?.directory ?? null,
    retained_references_not_found: notFoundFields(preview.retainedReferencesNotFound),
  };
}

function renderPreview(preview: ProjectDatabaseUpgradePreview): string {
  if (preview.state === 'current')
    return (
      [
        `Project database        ${preview.databasePath}`,
        `Schema                  ${preview.schemaVersion}`,
        'This database is already the schema this build writes; no upgrade is required and no backup was taken.',
      ].join('\n') + '\n'
    );
  return (
    [
      `Project database        ${preview.databasePath}`,
      `State                   upgrade required`,
      `From schema             ${preview.schemaVersion}`,
      `To schema               ${preview.currentSchemaVersion}`,
      ...renderPlan(preview.plan),
      `Backup directory        ${preview.backup!.directory}`,
      ...renderNotFound(preview.retainedReferencesNotFound),
      'Nothing was changed. Run `orcaops history upgrade --apply` to take a verified backup and perform the upgrade.',
    ].join('\n') + '\n'
  );
}

function applyEnvelope(result: ProjectDatabaseUpgradeResult, databasePath: string) {
  if (result.outcome === 'already-current')
    return {
      schema_version: 1,
      mode: 'apply' as const,
      changed: false,
      state: 'current' as const,
      database: databasePath,
      from_version: result.schemaVersion,
      to_version: result.schemaVersion,
      backup: null,
    };
  return {
    schema_version: 1,
    mode: 'apply' as const,
    changed: true,
    state: 'upgraded' as const,
    database: databasePath,
    from_version: result.plan.fromVersion,
    to_version: result.plan.toVersion,
    counters: counterFields(result.counters),
    rebuilt_tables: result.plan.rebuiltTables.map((entry) => ({
      table: entry.table,
      rows: entry.rows,
      added_columns: Object.keys(entry.addedColumns),
    })),
    backup: {
      name: result.backup.name,
      directory: result.backup.directory,
      database_file: result.backup.databaseFile,
      manifest_file: result.backup.manifestFile,
      reused: result.backupReused,
    },
    retained_references_not_found: notFoundFields(result.retainedReferencesNotFound),
  };
}

function renderApply(result: ProjectDatabaseUpgradeResult, databasePath: string): string {
  if (result.outcome === 'already-current')
    return (
      [
        `Project database        ${databasePath}`,
        `Schema                  ${result.schemaVersion}`,
        'This database is already the schema this build writes; nothing was changed and no backup was taken.',
      ].join('\n') + '\n'
    );
  return (
    [
      `Project database        ${databasePath}`,
      `Upgraded                schema ${result.plan.fromVersion} to ${result.plan.toVersion}`,
      ...renderPlan(result.plan),
      `Backup                  ${result.backup.directory}${
        result.backupReused ? ' (already held this database, verified again and reused)' : ''
      }`,
      `  database              ${result.backup.databaseFile}`,
      `  manifest              ${result.backup.manifestFile}`,
      ...renderNotFound(result.retainedReferencesNotFound),
      `The upgrade is committed. Restore that backup with \`orcaops history restore ${result.backup.name} --apply\`.`,
    ].join('\n') + '\n'
  );
}

export function createHistoryUpgradeAction() {
  return async (input: HistoryUpgradeCommandOptions = {}): Promise<void> => {
    const json = input !== null && typeof input === 'object' && input.json === true;
    try {
      await withInterrupt(async (signal) => {
        const project = await registeredProject();
        if (input.apply === true) {
          const result = await upgradeProjectDatabase({ ...project, signal });
          const file = projectDatabasePath(project.authority);
          if (json) emitOk(applyEnvelope(result, file));
          else writeTerminalSafeStdout(renderApply(result, file));
          return;
        }
        const preview = await previewProjectDatabaseUpgrade(project);
        const refused = projectDatabaseUpgradeRefusal(preview);
        if (refused) throw refused;
        if (json) emitOk(previewEnvelope(preview));
        else writeTerminalSafeStdout(renderPreview(preview));
      });
    } catch (cause) {
      refuse(cause, json);
    }
  };
}

const backupFields = (backup: ProjectDatabaseBackupSummary) => ({
  name: backup.name,
  directory: backup.directory,
  database_file: backup.databaseFile,
  manifest_file: backup.manifestFile,
  created_at: backup.createdAt,
  source_schema_version: backup.schemaVersion,
  write_sequence: backup.counters.writeSequence,
  intent_change_counter: backup.counters.intentChangeCounter,
});

// A directory of the published shape whose manifest cannot be read is listed with the reason,
// so someone looking for their backup sees that it is there and why it cannot be used.
const listedBackupFields = (backup: ListedProjectDatabaseBackup) =>
  backup.unreadable === undefined
    ? { ...backupFields(backup), unreadable: null }
    : {
        name: backup.name,
        directory: backup.directory,
        database_file: backup.databaseFile,
        manifest_file: backup.manifestFile,
        unreadable: backup.unreadable,
      };

const renderListedBackup = (backup: ListedProjectDatabaseBackup) =>
  backup.unreadable === undefined
    ? `  ${backup.name}  ${backup.createdAt}  schema ${backup.schemaVersion}  ` +
      `write sequence ${backup.counters.writeSequence}, intent changes ${backup.counters.intentChangeCounter}`
    : `  ${backup.name}  cannot be used: ${backup.unreadable}`;

export function createHistoryBackupsAction() {
  return async (input: HistoryBackupsCommandOptions = {}): Promise<void> => {
    const json = input !== null && typeof input === 'object' && input.json === true;
    try {
      await withInterrupt(async () => {
        const project = await registeredProject();
        const backups = await listProjectDatabaseBackups({ authority: project.authority });
        if (json) {
          emitOk({ schema_version: 1, backups: backups.map(listedBackupFields) });
          return;
        }
        writeTerminalSafeStdout(
          (backups.length
            ? [`${backups.length} upgrade backup(s)`, ...backups.map(renderListedBackup)]
            : ['No upgrade backups have been taken of this project database.']
          ).join('\n') + '\n'
        );
      });
    } catch (cause) {
      refuse(cause, json);
    }
  };
}

function restorePreviewEnvelope(backup: ProjectDatabaseBackupSummary, databasePath: string) {
  return {
    schema_version: 1,
    mode: 'preview' as const,
    changed: false,
    database: databasePath,
    backup: backupFields(backup),
    work_written_after_backup: 'not-restored' as const,
    replaced_database_kept_in: path.dirname(databasePath),
  };
}

function renderRestorePreview(backup: ProjectDatabaseBackupSummary, databasePath: string): string {
  return (
    [
      `Project database        ${databasePath}`,
      `Would be replaced by    ${backup.databaseFile}`,
      `Backup taken            ${backup.createdAt}`,
      `Backup schema           ${backup.schemaVersion}`,
      `Backup counters         write sequence ${backup.counters.writeSequence}, intent changes ${backup.counters.intentChangeCounter}`,
      'Work written after that backup is NOT in it and will not be restored.',
      `The database now in place is kept whole beside it in ${path.dirname(databasePath)}; an apply prints its exact name.`,
      'Nothing was changed. Run the same command with --apply to perform the restore.',
    ].join('\n') + '\n'
  );
}

function restoreApplyEnvelope(result: RestoreProjectDatabaseBackupResult) {
  return {
    schema_version: 1,
    mode: 'apply' as const,
    changed: true,
    database: result.databasePath,
    backup: backupFields(result.backup),
    work_written_after_backup: result.workWrittenAfterBackup,
    other_sessions: result.otherSessions,
    replaced: result.replaced
      ? {
          database_file: result.replaced.databaseFile,
          schema_version: result.replaced.schemaVersion,
          ...counterFields(result.replaced.counters),
        }
      : null,
  };
}

function renderRestoreApply(result: RestoreProjectDatabaseBackupResult): string {
  return (
    [
      `Project database        ${result.databasePath}`,
      `Restored from           ${result.backup.databaseFile}`,
      `Backup taken            ${result.backup.createdAt}`,
      `Backup schema           ${result.backup.schemaVersion}`,
      result.replaced
        ? `Replaced database kept  ${result.replaced.databaseFile}`
        : 'Replaced database kept  nothing was in place to set aside',
      'Work written after that backup is not in the restored database; it exists only in the database set aside.',
      result.otherSessions === 'refused-across-the-swap'
        ? 'The database was held for this restore alone while it was exchanged, so no other session wrote to it meanwhile.'
        : 'The file in place could not be opened as this store, so it was set aside as it was and could not be held against other sessions.',
    ].join('\n') + '\n'
  );
}

export function createHistoryRestoreAction() {
  return async (backupName: string, input: HistoryRestoreCommandOptions = {}): Promise<void> => {
    const json = input !== null && typeof input === 'object' && input.json === true;
    try {
      await withInterrupt(async (signal) => {
        const project = await registeredProject();
        if (input.apply === true) {
          const result = await restoreProjectDatabaseBackup({
            authority: project.authority,
            backup: backupName,
            signal,
          });
          if (json) emitOk(restoreApplyEnvelope(result));
          else writeTerminalSafeStdout(renderRestoreApply(result));
          return;
        }
        // A preview verifies nothing and touches nothing: it reports what the named backup's
        // own manifest says, and what replacing the database with it would and would not bring
        // back. The apply is where the copy is verified against that manifest.
        const backups = await listProjectDatabaseBackups({ authority: project.authority });
        const selected = backups.find((backup) => backup.name === backupName);
        if (!selected)
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `No upgrade backup named ${backupName} is beside this project database; list them with \`orcaops history backups\`. Nothing was changed`
          );
        if (selected.unreadable !== undefined)
          throw new ProjectDatabaseError(
            'HISTORY_BACKUP_UNVERIFIED',
            `${selected.unreadable}. Nothing was changed`
          );
        const file = projectDatabasePath(project.authority);
        if (json) emitOk(restorePreviewEnvelope(selected, file));
        else writeTerminalSafeStdout(renderRestorePreview(selected, file));
      });
    } catch (cause) {
      refuse(cause, json);
    }
  };
}
