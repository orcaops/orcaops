// The explicit upgrade of a released project database to the schema this build writes.
//
// Nothing else upgrades a store: a read or an ordinary write refuses one it cannot open. The
// upgrade takes a verified backup first and then makes the whole transition in one transaction,
// so an interruption leaves either the released file or the complete current one. It publishes
// no authored record, so it writes no receipt and moves neither project counter; its durable
// trace is the backup. It runs on its own connection and never through a settlement, whose SQL
// guard refuses every statement a schema change needs.
import type Database from 'better-sqlite3';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  configureWriter,
  databaseValidationFailure,
  type ProjectCounters,
  type ProjectDatabaseAuthority,
  readProjectCounters,
  validateProjectDatabaseLocation,
  validateProjectIdentity,
  validateProjectStoreIdentity,
} from './connection.js';
import { digestTable, digestTables, listTables, type TableDigest } from './content-digest.js';
import {
  BACKUP_DATABASE_FILE,
  BACKUP_DIRECTORY,
  BACKUP_MANIFEST_FILE,
  discardPendingBackup,
  type ProjectDatabaseBackupLocation,
  publishPendingBackup,
  reusablePublishedBackup,
  type VerifiedBackupContent,
  writePendingBackup,
} from './database-backup.js';
import { loadDatabase } from './driver.js';
import { isDatabaseContention, ProjectDatabaseError } from './errors.js';
import {
  readSchemaObjects,
  RELEASED_SCHEMA_SQL_SHA256,
  RELEASED_SCHEMA_VERSION,
  type SchemaObject,
  schemaSqlDigest,
} from './released-schema.js';
import {
  inspectRetainedReferences,
  type RetainedReferences,
  retainedReferencesNotFound,
} from './retained-references.js';
import { validateProjectSchemaDefinition } from './schema-validation.js';
import { developmentSchemaRefusal, newerSchemaRefusal } from './schema-version.js';
import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';

// The released tables rebuilt by the current schema, in the order their rows are copied back:
// a revision before the relationships that require it, and both before the adoptions that require
// either. Each value is what a released row means under a wider table; an empty value preserves a
// row when only a constraint changed. The upgrade invents no basis, standing or authorization.
const REBUILT_TABLES = [
  [
    'claim_revisions',
    {
      attributed_kind: "'actor'",
      attributed_basis: "'unknown'",
      source_standing: 'NULL',
      subject_id: 'NULL',
      subject_revision_id: 'NULL',
    },
  ],
  [
    'decision_revisions',
    {
      attributed_kind: "'actor'",
      attributed_basis: "'unknown'",
      source_standing: 'NULL',
      subject_id: 'NULL',
      subject_revision_id: 'NULL',
      derived_from_kind: 'NULL',
      derived_from_id: 'NULL',
      derived_from_revision_id: 'NULL',
    },
  ],
  [
    'record_relationships',
    {
      attributed_basis: "CASE attributed_kind WHEN 'author' THEN 'unknown' END",
      standing: "'established'",
      explanation: 'NULL',
      authorization_json: 'NULL',
      authorization_id: 'NULL',
    },
  ],
  [
    'adoptions',
    {
      approver_basis: "'unknown'",
      designation: "'adopted'",
      authorization_json: 'NULL',
      authorization_id: 'NULL',
    },
  ],
  [
    'pending_capture_requests',
    {
      // A released row records no invocation no-LLM choice, because the released
      // build had no background processing to make one about. An unknown choice
      // is never turned into a paid call: a capture staged before the upgrade
      // and resumed after it admits a job held until someone lifts it with
      // `orcaops knowledge resume --model`.
      without_model: '1',
    },
  ],
  ['remote_requests', {}],
] as const satisfies ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>;

/**
 * One transition between two consecutive schema versions: the whole definition a database holds
 * once it has been applied, and what a row of each table it rebuilds takes in the columns it
 * gains. The upgrade walks a chain of these rather than one transition, so a database released
 * several versions ago is carried through every step in a single transaction.
 */
export interface ProjectDatabaseUpgradeStep {
  readonly from: number;
  readonly to: number;
  readonly schema: string;
  readonly rebuiltTables: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>;
}

export const PROJECT_DATABASE_UPGRADE_STEPS: readonly ProjectDatabaseUpgradeStep[] = [
  {
    from: RELEASED_SCHEMA_VERSION,
    to: PROJECT_DATABASE_SCHEMA_VERSION,
    schema: PROJECT_DATABASE_SCHEMA,
    rebuiltTables: REBUILT_TABLES,
  },
];

const currentVersionOf = (steps: readonly ProjectDatabaseUpgradeStep[]): number =>
  steps[steps.length - 1]!.to;

/**
 * The steps that carry `version` to the last step's target, or none when it is already there or
 * no chain reaches it.
 */
function chainFrom(
  version: number,
  steps: readonly ProjectDatabaseUpgradeStep[]
): readonly ProjectDatabaseUpgradeStep[] {
  const chain: ProjectDatabaseUpgradeStep[] = [];
  let at = version;
  for (const step of steps) {
    if (step.from !== at) continue;
    chain.push(step);
    at = step.to;
  }
  return at === currentVersionOf(steps) ? chain : [];
}

export type ProjectDatabaseUpgradeState =
  | 'upgrade-required'
  | 'current'
  | 'definition-differs'
  | 'development-version'
  | 'newer-version';

export interface ProjectDatabaseUpgradeStepPlan {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly rebuiltTables: ReadonlyArray<{
    readonly table: string;
    readonly rows: number;
    readonly addedColumns: Readonly<Record<string, string>>;
  }>;
  readonly droppedObjects: ReadonlyArray<{ readonly type: string; readonly name: string }>;
  readonly createdObjects: ReadonlyArray<{
    readonly type: string;
    readonly name: string;
    readonly table: string;
  }>;
}

/** The whole walk, and the same fields aggregated over it for a reader who wants the outcome. */
export interface ProjectDatabaseUpgradePlan extends ProjectDatabaseUpgradeStepPlan {
  readonly steps: readonly ProjectDatabaseUpgradeStepPlan[];
}

export interface ProjectDatabaseUpgradePreview {
  readonly databasePath: string;
  readonly schemaVersion: number;
  readonly currentSchemaVersion: number;
  readonly state: ProjectDatabaseUpgradeState;
  readonly counters: ProjectCounters | null;
  readonly plan: ProjectDatabaseUpgradePlan | null;
  // A backup directory is named when it is taken: `schema-<version>-<id>` under `directory`.
  readonly backup: {
    readonly directory: string;
    readonly databaseFileName: string;
    readonly manifestFileName: string;
  } | null;
  readonly retainedReferencesNotFound: Pick<
    RetainedReferences,
    'gitReferences' | 'evidenceFiles'
  > | null;
}

export type ProjectDatabaseUpgradeResult =
  | { readonly outcome: 'already-current'; readonly schemaVersion: number }
  | {
      readonly outcome: 'upgraded';
      readonly plan: ProjectDatabaseUpgradePlan;
      readonly counters: ProjectCounters;
      readonly backup: ProjectDatabaseBackupLocation;
      // True when an earlier run had already published this backup of this database and it was
      // verified again instead of the database being copied a second time.
      readonly backupReused: boolean;
      readonly retainedReferencesNotFound: Pick<
        RetainedReferences,
        'gitReferences' | 'evidenceFiles'
      >;
    };

export type ProjectDatabaseUpgradeStage =
  | 'backup-verified'
  | 'backup-published'
  | `table-dropped:${string}`
  | 'objects-created'
  | 'rows-restored'
  | 'before-verification'
  | 'before-commit'
  | 'committed';

export interface UpgradeDatabaseFileInput {
  readonly file: string;
  readonly authority: ProjectDatabaseAuthority;
  readonly gitCommonDirectory?: string | null;
  readonly busyTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

interface TargetDefinition {
  readonly inCreationOrder: readonly SchemaObject[];
  readonly byName: ReadonlyMap<string, SchemaObject>;
  readonly columns: ReadonlyMap<string, readonly string[]>;
  readonly withoutRowid: ReadonlySet<string>;
}
const targets = new WeakMap<ProjectDatabaseUpgradeStep, TargetDefinition>();

// Table shapes come from the schema fragments, by initializing them once in memory: the upgrade
// keeps no second copy of any definition.
function targetDefinition(step: ProjectDatabaseUpgradeStep): TargetDefinition {
  const cached = targets.get(step);
  if (cached) return cached;
  const reference = new (loadDatabase())(':memory:');
  try {
    reference.exec(step.schema);
    const inCreationOrder = (
      reference
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid'
        )
        .all() as SchemaObject[]
    ).filter((object) => !object.name.startsWith('sqlite_'));
    const tables = inCreationOrder.filter((object) => object.type === 'table');
    const target: TargetDefinition = {
      inCreationOrder,
      byName: new Map(inCreationOrder.map((object) => [object.name, object])),
      columns: new Map(tables.map(({ name }) => [name, columnsOf(reference, name)] as const)),
      withoutRowid: new Set(
        tables.map(({ name }) => name).filter((name) => withoutRowid(reference, name))
      ),
    };
    targets.set(step, target);
    return target;
  } finally {
    reference.close();
  }
}

function columnsOf(database: Database.Database, table: string): string[] {
  return (
    database.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(table) as {
      name: string;
    }[]
  ).map((column) => column.name);
}

function withoutRowid(database: Database.Database, table: string): boolean {
  const entry = database
    .prepare('SELECT wr FROM pragma_table_list WHERE schema = ? AND name = ?')
    .get('main', table) as { wr: number } | undefined;
  return entry?.wr === 1;
}

// A failed invariant is this build contradicting itself, never a fact about the user's store.
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      `This build cannot upgrade a database: ${message}. Nothing was changed`
    );
}

// Each step's plan is the difference between the definition a database holds when the step begins
// and the one the step writes. It is refused unless that difference is exactly what the step knows
// how to carry rows across, so a fragment edited without the upgrade in mind cannot lose a column.
function planStep(
  step: ProjectDatabaseUpgradeStep,
  present: ReadonlyMap<string, SchemaObject>,
  columnsBefore: (table: string) => readonly string[],
  rowsInFile: (table: string) => number | null
): ProjectDatabaseUpgradeStepPlan {
  const expected = targetDefinition(step);
  const differing = [...present.values()].filter((object) => {
    const wanted = expected.byName.get(object.name);
    return wanted !== undefined && normalized(wanted.sql) !== normalized(object.sql);
  });
  const rebuilt = differing.filter((object) => object.type === 'table').map((o) => o.name);
  invariant(
    JSON.stringify([...rebuilt].sort()) ===
      JSON.stringify(step.rebuiltTables.map(([table]) => table).sort()),
    `the schema rebuilds ${rebuilt.join(', ')} between ${step.from} and ${step.to}, which is not what this upgrade carries rows across`
  );
  for (const object of differing)
    invariant(
      rebuilt.includes(object.tbl_name),
      `${object.name} changed and does not belong to a rebuilt table`
    );
  const dropped = [...present.values()].filter((object) => !expected.byName.has(object.name));
  for (const object of dropped)
    invariant(object.type !== 'table', `${object.name} would be dropped with its rows`);

  return {
    fromVersion: step.from,
    toVersion: step.to,
    rebuiltTables: step.rebuiltTables.map(([table, addedColumns]) => {
      const before = columnsBefore(table);
      const after = expected.columns.get(table)!;
      invariant(
        before.every((column) => after.includes(column)) &&
          JSON.stringify(after.filter((column) => !before.includes(column)).sort()) ===
            JSON.stringify(Object.keys(addedColumns).sort()),
        `${table} gains columns this upgrade has no value for`
      );
      // Readers order revisions by row id, and copy-back carries each row's own id across. A
      // WITHOUT ROWID table has none to carry, so it cannot be rebuilt this way.
      invariant(
        !expected.withoutRowid.has(table),
        `${table} is WITHOUT ROWID, so its rows have no row id to carry across`
      );
      return { table, rows: rowsInFile(table) ?? 0, addedColumns };
    }),
    droppedObjects: dropped.map(({ type, name }) => ({ type, name })),
    createdObjects: expected.inCreationOrder
      .filter((object) => !present.has(object.name))
      .map(({ type, name, tbl_name }) => ({ type, name, table: tbl_name })),
  };
}

function planUpgrade(
  database: Database.Database,
  steps: readonly ProjectDatabaseUpgradeStep[]
): ProjectDatabaseUpgradePlan {
  const chain = chainFrom(database.pragma('user_version', { simple: true }) as number, steps);
  invariant(chain.length > 0, 'this database has no chain of upgrade steps to the current schema');
  const inFile = new Set(listTables(database));
  const rowsInFile = (table: string): number | null =>
    inFile.has(table)
      ? (database.prepare(`SELECT count(*) AS n FROM ${quoted(table)}`).get() as { n: number }).n
      : null;
  let present = new Map(readSchemaObjects(database).map((object) => [object.name, object]));
  let columnsBefore = (table: string): readonly string[] =>
    inFile.has(table) ? columnsOf(database, table) : [];
  const planned: ProjectDatabaseUpgradeStepPlan[] = [];
  for (const step of chain) {
    for (const [table] of step.rebuiltTables)
      invariant(
        !inFile.has(table) || !withoutRowid(database, table),
        `${table} is WITHOUT ROWID, so its rows have no row id to carry across`
      );
    planned.push(planStep(step, present, columnsBefore, rowsInFile));
    const after = targetDefinition(step);
    present = new Map(after.byName);
    columnsBefore = (table: string) => after.columns.get(table) ?? [];
  }
  const rebuiltTables = new Map<string, ProjectDatabaseUpgradeStepPlan['rebuiltTables'][number]>();
  for (const step of planned)
    for (const entry of step.rebuiltTables)
      rebuiltTables.set(entry.table, {
        ...entry,
        addedColumns: { ...rebuiltTables.get(entry.table)?.addedColumns, ...entry.addedColumns },
      });
  return {
    fromVersion: chain[0]!.from,
    toVersion: chain[chain.length - 1]!.to,
    steps: planned,
    rebuiltTables: [...rebuiltTables.values()],
    droppedObjects: planned.flatMap((step) => step.droppedObjects),
    createdObjects: planned.flatMap((step) => step.createdObjects),
  };
}

interface Inspection {
  readonly schemaVersion: number;
  readonly state: ProjectDatabaseUpgradeState;
  readonly counters: ProjectCounters | null;
}

// The dedicated open. It admits what the normal open refuses, a released store, and nothing
// else: the version decides first, then the store has to be the caller's, and a released
// version has to come with the released definition object for object.
function inspect(
  database: Database.Database,
  authority: ProjectDatabaseAuthority,
  steps: readonly ProjectDatabaseUpgradeStep[]
): Inspection {
  const current = currentVersionOf(steps);
  const schemaVersion = database.pragma('user_version', { simple: true }) as number;
  if (schemaVersion > current) return { schemaVersion, state: 'newer-version', counters: null };
  if (schemaVersion !== RELEASED_SCHEMA_VERSION && schemaVersion !== current)
    return { schemaVersion, state: 'development-version', counters: null };
  validateProjectStoreIdentity(database, authority);
  const counters = readProjectCounters(database);
  if (database.pragma('journal_mode', { simple: true }) !== 'wal')
    throw new ProjectDatabaseError(
      'HISTORY_FORMAT_UNSUPPORTED',
      'Project history is not WAL storage; use explicit schema repair'
    );
  if (schemaVersion === current) {
    validateProjectSchemaDefinition(database, schemaVersion);
    return { schemaVersion, state: 'current', counters };
  }
  invariant(
    chainFrom(schemaVersion, steps).length > 0,
    `no chain of upgrade steps carries schema ${schemaVersion} to ${current}`
  );
  // A version number alone cannot establish that the released definition was preserved.
  const released = schemaSqlDigest(readSchemaObjects(database)) === RELEASED_SCHEMA_SQL_SHA256;
  return { schemaVersion, state: released ? 'upgrade-required' : 'definition-differs', counters };
}

// The refusal a state carries, so a preview and an apply say the same thing about the same
// database and a caller never has to compose the message itself.
export function projectDatabaseUpgradeRefusal(
  inspection: Pick<Inspection, 'schemaVersion' | 'state'>
): ProjectDatabaseError | null {
  switch (inspection.state) {
    case 'newer-version':
      return newerSchemaRefusal(inspection.schemaVersion);
    case 'development-version':
      return developmentSchemaRefusal(inspection.schemaVersion);
    case 'definition-differs':
      return new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        `This schema-${inspection.schemaVersion} database does not hold the released definition, so it is not upgraded; preserve it for explicit repair. Nothing was changed`
      );
    default:
      return null;
  }
}

function openReadOnly(file: string): Database.Database {
  try {
    const database = new (loadDatabase())(file, {
      readonly: true,
      fileMustExist: true,
      timeout: 100,
    });
    database.pragma('temp_store = MEMORY');
    return database;
  } catch (cause) {
    throw databaseValidationFailure(cause);
  }
}

function readConsistently<T>(file: string, read: (database: Database.Database) => T): T {
  const database = openReadOnly(file);
  try {
    database.exec('BEGIN');
    try {
      return read(database);
    } finally {
      if (database.inTransaction) database.exec('COMMIT');
    }
  } catch (cause) {
    throw databaseValidationFailure(cause);
  } finally {
    database.close();
  }
}

// Reads through a read-only connection and writes nothing of the database. Reading a
// write-ahead-log database is not free of the directory around it: SQLite creates or refreshes
// the shared-memory file beside it, and an empty log where there was none, so a preview needs a
// project directory it can write in and refuses one it cannot with HISTORY_INACCESSIBLE. It
// never checkpoints from a read-only connection, so the main file keeps its bytes and so does a
// log that holds anything.
export function previewDatabaseFileUpgrade(
  input: Pick<UpgradeDatabaseFileInput, 'file' | 'authority' | 'gitCommonDirectory'>,
  steps: readonly ProjectDatabaseUpgradeStep[] = PROJECT_DATABASE_UPGRADE_STEPS
): ProjectDatabaseUpgradePreview {
  const projectDirectory = path.dirname(input.file);
  return readConsistently(input.file, (database) => {
    const inspection = inspect(database, input.authority, steps);
    const upgradable = inspection.state === 'upgrade-required';
    return {
      databasePath: input.file,
      schemaVersion: inspection.schemaVersion,
      currentSchemaVersion: currentVersionOf(steps),
      state: inspection.state,
      counters: inspection.counters,
      plan: upgradable ? planUpgrade(database, steps) : null,
      backup: upgradable
        ? {
            directory: path.join(projectDirectory, BACKUP_DIRECTORY),
            databaseFileName: BACKUP_DATABASE_FILE,
            manifestFileName: BACKUP_MANIFEST_FILE,
          }
        : null,
      retainedReferencesNotFound: upgradable
        ? retainedReferencesNotFound(
            inspectRetainedReferences(database, {
              projectDirectory,
              gitCommonDirectory: input.gitCommonDirectory,
            })
          )
        : null,
    };
  });
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'The upgrade was cancelled before the database changed; run it again when ready'
    );
}

async function beginImmediate(
  database: Database.Database,
  busyTimeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + busyTimeoutMs;
  for (;;) {
    cancelled(signal);
    try {
      database.exec('BEGIN IMMEDIATE');
      return;
    } catch (cause) {
      if (database.inTransaction || !isDatabaseContention(cause)) throw cause;
      if (Date.now() >= deadline)
        throw new ProjectDatabaseError(
          'TRANSACTION_RETRY_EXHAUSTED',
          'Another writer holds the database; nothing was changed. Run the upgrade again when it is idle',
          { cause }
        );
      try {
        await delay(25, undefined, { signal });
      } catch {
        cancelled(signal);
      }
    }
  }
}

const sameDigest = (a: TableDigest | undefined, b: TableDigest | undefined) =>
  a !== undefined && b !== undefined && a.rows === b.rows && a.sha256 === b.sha256;

function sameTables(
  a: Readonly<Record<string, TableDigest>>,
  b: Readonly<Record<string, TableDigest>>
): boolean {
  const names = Object.keys(a);
  return (
    names.length === Object.keys(b).length && names.every((table) => sameDigest(a[table], b[table]))
  );
}

function failed(message: string): ProjectDatabaseError {
  return new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    `${message}; the upgrade was rolled back and the database is unchanged. Preserve it for explicit repair`
  );
}

// Each rebuilt table digested over its row ids together with the columns it had as released.
// Readers order revisions by row id, so a row that came back under a different one is a
// different history even when every value it holds survived, and only a digest that includes
// the row id can see that.
export function rowIdentities(
  database: Database.Database,
  releasedColumns: ReadonlyMap<string, readonly string[]>
): Map<string, TableDigest> {
  return new Map(
    [...releasedColumns].map(([table, columns]) => [
      table,
      digestTable(database, table, ['rowid', ...columns]),
    ])
  );
}

// The tables whose rows no longer sit under the row ids they sat under, in the order taken.
export function tablesWhoseRowIdsMoved(
  before: ReadonlyMap<string, TableDigest>,
  after: ReadonlyMap<string, TableDigest>
): string[] {
  return [...before.keys()].filter((table) => !sameDigest(before.get(table), after.get(table)));
}

// Everything between BEGIN IMMEDIATE and COMMIT. It is synchronous on purpose: no other work of
// this process can interleave with a half-made schema.
function transition(
  database: Database.Database,
  plan: ProjectDatabaseUpgradePlan,
  chain: readonly ProjectDatabaseUpgradeStep[],
  backup: VerifiedBackupContent,
  observe: (stage: ProjectDatabaseUpgradeStage) => void
): void {
  const expected = targetDefinition(chain[chain.length - 1]!);
  // The file's own columns and row ids, taken before the first drop: what every later comparison
  // against the backup is made of, whichever step rebuilt a table.
  const inFile = new Set(listTables(database));
  const releasedColumns = new Map(
    plan.rebuiltTables
      .map((entry) => entry.table)
      .filter((table) => inFile.has(table))
      .map((table) => [table, columnsOf(database, table)] as const)
  );
  const identities = rowIdentities(database, releasedColumns);

  for (const [index, step] of plan.steps.entries()) {
    const stepTarget = targetDefinition(chain[index]!);
    const rebuilt = step.rebuiltTables.map((entry) => entry.table);
    const columns = new Map(rebuilt.map((table) => [table, columnsOf(database, table)]));
    for (const table of rebuilt)
      database.exec(
        `CREATE TEMP TABLE ${quoted(`upgrade_rows_${table}`)} AS SELECT rowid AS upgrade_rowid, * FROM main.${quoted(table)} ORDER BY rowid`
      );
    for (const table of [...rebuilt].reverse()) {
      database.exec(`DROP TABLE main.${quoted(table)}`);
      observe(`table-dropped:${table}`);
    }
    for (const object of step.droppedObjects)
      database.exec(`DROP ${object.type.toUpperCase()} IF EXISTS main.${quoted(object.name)}`);

    const remaining = new Set(readSchemaObjects(database).map((object) => object.name));
    for (const object of stepTarget.inCreationOrder)
      if (!remaining.has(object.name)) database.exec(object.sql);
    observe('objects-created');

    // Rows return in their original rowid order with the triggers already in place, so the first
    // revision guard, the endpoint and target triggers and the replace guards all judge them. Each
    // row id is written back rather than assigned: readers order revisions by row id, and the
    // upgrade invents nothing, a row id least of all.
    for (const { table, addedColumns } of step.rebuiltTables) {
      const kept = columns.get(table)!.map(quoted).join(', ');
      const added = Object.keys(addedColumns);
      const targetColumns = ['rowid', kept, ...added.map(quoted)].filter(Boolean).join(', ');
      const selectedColumns = [
        'upgrade_rowid',
        kept,
        ...added.map((column) => addedColumns[column]),
      ]
        .filter(Boolean)
        .join(', ');
      database.exec(
        `INSERT INTO main.${quoted(table)} (${targetColumns})
       SELECT ${selectedColumns}
       FROM temp.${quoted(`upgrade_rows_${table}`)} ORDER BY upgrade_rowid`
      );
      database.exec(`DROP TABLE temp.${quoted(`upgrade_rows_${table}`)}`);
    }
    observe('rows-restored');
    database.pragma(`user_version = ${step.toVersion}`);
  }
  observe('before-verification');

  const definition = readSchemaObjects(database);
  const wanted = [...expected.byName.values()];
  if (
    definition.length !== wanted.length ||
    definition.some((object) => {
      const match = expected.byName.get(object.name);
      return (
        !match ||
        match.type !== object.type ||
        match.tbl_name !== object.tbl_name ||
        normalized(match.sql) !== normalized(object.sql)
      );
    })
  )
    throw failed('The upgraded definition is not the one a new database gets');
  if ((database.pragma('foreign_key_check') as unknown[]).length)
    throw failed('The upgraded database holds broken references');
  if (database.pragma('integrity_check', { simple: true }) !== 'ok')
    throw failed('The upgraded database failed its integrity check');
  const created = new Set(
    plan.createdObjects.filter((object) => object.type === 'table').map((object) => object.name)
  );
  for (const table of listTables(database)) {
    const after = digestTable(database, table, releasedColumns.get(table));
    const unchanged = created.has(table)
      ? after.rows === 0
      : sameDigest(after, backup.tables[table]);
    if (!unchanged) throw failed(`The rows of ${table} did not survive the upgrade`);
  }
  const moved = tablesWhoseRowIdsMoved(identities, rowIdentities(database, releasedColumns));
  if (moved.length) throw failed(`The row ids of ${moved.join(', ')} did not survive the upgrade`);
  observe('before-commit');
}

const PREPARATION_ATTEMPTS = 3;

interface PreparedBackup {
  readonly content: VerifiedBackupContent;
  readonly retainedReferences: RetainedReferences;
  readonly reused: boolean;
  publish(): ProjectDatabaseBackupLocation;
  discard(): void;
}

// The backup this attempt stands behind. A reused one is already under its published name, so
// there is nothing to publish and nothing that may ever discard it.
async function prepareBackup(input: UpgradeDatabaseFileInput): Promise<PreparedBackup> {
  const reusable = reusablePublishedBackup(input);
  if (reusable)
    return {
      content: reusable.content,
      retainedReferences: reusable.retainedReferences,
      reused: true,
      publish: () => reusable.location,
      discard: () => {},
    };
  const pending = await writePendingBackup(input);
  return {
    content: pending.content,
    retainedReferences: pending.retainedReferences,
    reused: false,
    publish: () => publishPendingBackup(pending),
    discard: () => discardPendingBackup(pending.pendingDirectory),
  };
}

export async function upgradeDatabaseFile(
  input: UpgradeDatabaseFileInput,
  observe: (stage: ProjectDatabaseUpgradeStage) => void = () => {},
  steps: readonly ProjectDatabaseUpgradeStep[] = PROJECT_DATABASE_UPGRADE_STEPS
): Promise<ProjectDatabaseUpgradeResult> {
  const { file, authority, signal } = input;
  cancelled(signal);
  const prepared = readConsistently(file, (database) => {
    const inspection = inspect(database, authority, steps);
    const refused = projectDatabaseUpgradeRefusal(inspection);
    if (refused) throw refused;
    if (inspection.state === 'current') return null;
    if ((database.pragma('foreign_key_check') as unknown[]).length)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The database holds broken references, so it is not upgraded; preserve it for explicit repair. Nothing was changed'
      );
    if (database.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The database failed its integrity check, so it is not upgraded; preserve it for explicit repair. Nothing was changed'
      );
    return planUpgrade(database, steps);
  });
  if (prepared === null)
    return { outcome: 'already-current', schemaVersion: currentVersionOf(steps) };

  // A writer that commits while the backup is being taken makes the backup stale. Preparation
  // then starts over, a bounded number of times, and the stale backup is never published.
  for (let attempt = 1; ; attempt++) {
    cancelled(signal);
    const backup = await prepareBackup(input);
    let published: ProjectDatabaseBackupLocation | null = null;
    let database: Database.Database | null = null;
    let committed = false;
    try {
      observe('backup-verified');
      database = new (loadDatabase())(file, { fileMustExist: true, timeout: 100 });
      configureWriter(database);
      await beginImmediate(database, input.busyTimeoutMs ?? 5_000, signal);
      database.pragma('defer_foreign_keys = ON');
      const inspection = inspect(database, authority, steps);
      const refused = projectDatabaseUpgradeRefusal(inspection);
      if (refused) throw refused;
      if (inspection.state === 'current') {
        database.exec('ROLLBACK');
        return { outcome: 'already-current', schemaVersion: currentVersionOf(steps) };
      }
      const counters = inspection.counters!;
      // The backup stands in for the source, so it has to be the same store in every respect the
      // upgrade relies on: the same released definition as well as the same rows. The schema
      // digest is a cross-check of the backup rather than a reachable refusal: the dedicated open
      // has already required the released definition of the live file, and the backup is a copy
      // of that file, taken or verified against it. What catches a racing writer is the counters
      // and the table digests, and a write that moves no counter is caught by the digests alone.
      const stale =
        counters.writeSequence !== backup.content.counters.writeSequence ||
        counters.intentChangeCounter !== backup.content.counters.intentChangeCounter ||
        schemaSqlDigest(readSchemaObjects(database)) !== backup.content.schemaSqlSha256 ||
        !sameTables(digestTables(database), backup.content.tables);
      if (stale) {
        database.exec('ROLLBACK');
        if (attempt === PREPARATION_ATTEMPTS)
          throw new ProjectDatabaseError(
            'STALE_CONTEXT',
            'The database kept changing while it was being backed up; nothing was changed. Run the upgrade again when it is idle'
          );
        continue;
      }
      const plan = planUpgrade(database, steps);
      // The stage says the backup is in place under its published name, which a reused one
      // already was before this attempt began.
      published = backup.publish();
      observe('backup-published');
      transition(database, plan, chainFrom(plan.fromVersion, steps), backup.content, observe);
      database.exec('COMMIT');
      committed = true;
      observe('committed');
      return {
        outcome: 'upgraded',
        plan,
        counters,
        backup: published,
        backupReused: backup.reused,
        retainedReferencesNotFound: retainedReferencesNotFound(backup.retainedReferences),
      };
    } catch (cause) {
      if (database?.inTransaction) database.exec('ROLLBACK');
      if (committed || cause instanceof ProjectDatabaseError) throw cause;
      throw new ProjectDatabaseError(
        'TRANSACTION_FAILED',
        'The upgrade failed and was rolled back; the database is unchanged',
        { cause }
      );
    } finally {
      if (!published) backup.discard();
      database?.close();
    }
  }
}

export async function previewProjectDatabaseUpgrade(input: {
  authority: ProjectDatabaseAuthority;
  gitCommonDirectory?: string | null;
}): Promise<ProjectDatabaseUpgradePreview> {
  const authority = Object.freeze({ ...input.authority });
  const file = await validateProjectDatabaseLocation(authority);
  return previewDatabaseFileUpgrade({ ...input, authority, file });
}

export async function upgradeProjectDatabase(input: {
  authority: ProjectDatabaseAuthority;
  gitCommonDirectory?: string | null;
  busyTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ProjectDatabaseUpgradeResult> {
  const authority = Object.freeze({ ...input.authority });
  const file = await validateProjectDatabaseLocation(authority);
  const result = await upgradeDatabaseFile({ ...input, authority, file });
  // The upgraded file has to be one the normal open admits.
  let reopened: Database.Database;
  try {
    reopened = new (loadDatabase())(file, { readonly: true, fileMustExist: true });
  } catch (cause) {
    throw databaseValidationFailure(cause);
  }
  try {
    validateProjectIdentity(reopened, authority);
    validateProjectSchemaDefinition(reopened, PROJECT_DATABASE_SCHEMA_VERSION);
  } finally {
    reopened.close();
  }
  return result;
}
