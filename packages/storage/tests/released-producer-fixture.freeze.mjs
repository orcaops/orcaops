#!/usr/bin/env node
// Freezes one run of released-producer-database.generate.mjs, or of
// released-legacy-conversion.generate.mjs, into the released fixtures: the rows that release
// wrote, its review evidence, the original database files, a manifest, and a bundle of the
// Git refs the rows name.
//
//   node packages/storage/tests/released-producer-fixture.freeze.mjs <summary.json> <run-dir>
//
// <summary.json> is the generation procedure's stdout for <run-dir>. A frozen release is
// never overwritten: a baseline regenerated later would no longer be what that release wrote.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { brotliCompressSync, constants as zlib } from 'node:zlib';

import { snapshot } from './database-fixture.mjs';
import {
  countBy,
  databaseDigest,
  ORIGINAL_FILE_SUFFIX,
  RELEASED_SCHEMA_FILE,
  releasedFixtureDirectory,
  RETAINED_REFS_BUNDLE,
  schemaDigests,
  tableDigest,
} from './released-fixture.mjs';

const BUNDLE_BYTE_LIMIT = 300 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Every empty table has to match one reason, and `basis` says how far this script checked it.
// The bundle itself establishes an absent INSERT statement, and two producer strings establish
// the writer that is never reached. The cloud, racing-writer and legacy reasons are assigned
// by table name: the script confirms only that the bundle can insert into the table, and the
// reason records what a person established by reading and running the release. The last reason
// takes whatever is left of a converted database unchecked; the fixture tests hold it to its
// statement.
const EMPTY_TABLE_REASONS = [
  {
    reason: 'no_writer_in_the_release',
    statement:
      'The released bundle holds no INSERT statement for this table, so no released build can write it.',
    basis: 'bundle_scan',
    covers: (table, converted, bundle) => insertStatements(bundle, table) === 0,
    verify: () => true,
  },
  {
    reason: 'writer_never_reached_in_the_release',
    statement:
      'The bundle can insert here but never produces a row to insert: checkpoint recovery records have no producer, and no code builds the keyed authored sources the seed bundle authoring rows come from.',
    basis: 'producer_strings',
    covers: (table) => ['execution_checkpoint_recoveries', 'seed_bundle_authoring'].includes(table),
    // The one quoted occurrence of the key prefix is the reader's own check.
    verify: (bundle) =>
      !bundle.includes('checkpoint_recovery_history.push') &&
      (bundle.match(/["'`]authored:/g) ?? []).length === 1,
  },
  {
    reason: 'needs_the_cloud_service',
    statement:
      'Written only inside an authenticated cloud session: pushes, remote transport, cloud sync, session-branch observations, review feedback cursors, and pulled or uploaded source plans.',
    basis: 'assigned_by_table_name',
    covers: (table) =>
      /^(artifact_push_|remote_|cloud_sync_|session_branch_|source_plan_)/.test(table) ||
      table === 'review_feedback_watch_cursors',
    verify: (bundle, table) => insertStatements(bundle, table) > 0,
  },
  {
    reason: 'needs_racing_writers',
    statement:
      'A retained Git publication is retired only when a concurrent capture wins a race, and only a retired publication can be reclaimed. A single offline writer cannot produce that.',
    basis: 'assigned_by_table_name',
    covers: (table) => table === 'git_retention_reclamations',
    verify: (bundle, table) => insertStatements(bundle, table) > 0,
  },
  {
    reason: 'needs_cloud_state_in_the_legacy_history',
    statement:
      'Conversion fills this table only from cloud facts, session-branch state or pulled source plans retained by the legacy history, which an offline legacy history does not hold.',
    basis: 'assigned_by_table_name',
    covers: (table, converted) =>
      converted &&
      [
        'legacy_artifact_cloud_facts',
        'legacy_session_branch_state',
        'legacy_source_plan_records',
      ].includes(table),
    verify: (bundle, table) => insertStatements(bundle, table) > 0,
  },
  {
    reason: 'written_only_by_legacy_conversion',
    statement:
      'Only the conversion of a legacy file-backed history writes this table; the converted fixture beside this one holds it.',
    basis: 'assigned_by_table_name',
    covers: (table, converted) =>
      !converted && (table.startsWith('legacy_') || table === 'plan_idempotency_records'),
    verify: (bundle, table) => insertStatements(bundle, table) > 0,
  },
  {
    reason: 'outside_this_conversion',
    statement:
      'Conversion of this small legacy history writes nothing here. The fixture of the converting release, written by ordinary use, holds the table.',
    basis: 'remainder_of_a_conversion',
    covers: (table, converted) => converted,
    verify: () => true,
  },
];

function insertStatements(bundle, table) {
  return (bundle.match(new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, 'gi')) ?? [])
    .length;
}

function git(repository, home, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: repository,
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed\n${result.stderr}`);
  return result.stdout;
}

function originalFiles(summary, databasePath) {
  return summary.database.files
    .filter((file) => !file.name.endsWith('-shm'))
    .map((recorded) => {
      const bytes = readFileSync(path.join(path.dirname(databasePath), recorded.name));
      if (sha256(bytes) !== recorded.sha256 || bytes.length !== recorded.bytes) {
        throw new Error(`${recorded.name} is not the file the generation summary describes`);
      }
      return { ...recorded, content: bytes };
    });
}

function assertExactNumbers(rows) {
  for (const [table, records] of Object.entries(rows)) {
    for (const record of records) {
      for (const [column, value] of Object.entries(record)) {
        if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
          throw new Error(`${table}.${column} holds an integer JSON cannot carry exactly`);
        }
      }
    }
  }
}

// Review evidence is immutable files beside the database. The rows name each one with its
// hash and length, so the files and the rows have to agree before either is frozen.
function reviewEvidence(rows, databasePath) {
  const root = path.join(path.dirname(databasePath), 'evidence');
  const members = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(location);
      else {
        const bytes = readFileSync(location);
        members.push({
          relativePath: path.relative(root, location).split(path.sep).join('/'),
          sha256: sha256(bytes),
          bytes: { blobHex: bytes.toString('hex') },
        });
      }
    }
  };
  if (existsSync(root)) visit(root);
  members.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));

  const named = [
    ...rows.review_evidence_members.map(
      (row) => `${row.relative_path} ${row.sha256} ${row.byte_length}`
    ),
    ...rows.review_semantic_terminals
      .filter((row) => row.model_relative_path !== null)
      .map((row) => `${row.model_relative_path} ${row.model_sha256} ${row.model_byte_length}`),
  ].sort();
  const held = members
    .map((file) => `evidence/${file.relativePath} ${file.sha256} ${file.bytes.blobHex.length / 2}`)
    .sort();
  if (JSON.stringify(named) !== JSON.stringify(held)) {
    throw new Error('the evidence files differ from the evidence members the rows name');
  }
  return members;
}

function namedRefs(rows) {
  const artifacts = new Map(rows.artifact_metadata.map((row) => [row.artifact_id, row]));
  const describe = (ref) => {
    const artifactId = [...artifacts.keys()].find((id) => ref.includes(id));
    if (artifactId) {
      return {
        artifact_id: artifactId,
        artifact_label: artifacts.get(artifactId).label,
        artifact_origin: artifacts.get(artifactId).origin_kind,
      };
    }
    const review = rows.reviews.find((row) => ref.includes(row.review_id));
    if (!review) throw new Error(`${ref} names no recorded artifact or review`);
    return { review_id: review.review_id, review_branch: review.branch };
  };
  const published = rows.git_retention_publications.map((publication) => ({
    ref: publication.full_ref,
    object: publication.object_oid,
    tree: publication.tree_oid,
    named_by: 'git_retention_publications',
    role: publication.role,
    ...describe(publication.full_ref),
    ...(publication.role === 'checkpoint'
      ? { checkpoint: publication.checkpoint_number, phase: publication.checkpoint_phase }
      : {}),
  }));
  const legacy = rows.legacy_import.flatMap((row) =>
    JSON.parse(row.git_resources_json).map((resource) => ({
      ref: resource.ref,
      object: resource.oid,
      tree: null,
      named_by: 'legacy_import.git_resources_json',
      ...describe(resource.ref),
    }))
  );
  return [...published, ...legacy].sort((a, b) => (a.ref < b.ref ? -1 : 1));
}

function retainedEvidence(rows, run, summary) {
  const refs = namedRefs(rows);
  const repository = path.join(run, 'repo');
  const home = path.join(run, 'home');
  const inRepository = new Map(
    summary.repository.retained_refs.map(({ ref, object }) => [ref, object])
  );
  if (inRepository.size !== refs.length) {
    throw new Error('the repository retains refs the database does not name, or the reverse');
  }
  for (const entry of refs) {
    const resolve = (spec) =>
      git(repository, home, ['rev-parse', '--verify', spec], { encoding: 'utf8' }).trim();
    entry.tree ??= resolve(`${entry.ref}^{tree}`);
    if (
      resolve(entry.ref) !== entry.object ||
      resolve(`${entry.ref}^{tree}`) !== entry.tree ||
      inRepository.get(entry.ref) !== entry.object
    ) {
      throw new Error(`${entry.ref} does not resolve to the objects the database names`);
    }
  }
  const bundle = git(repository, home, ['bundle', 'create', '-', ...refs.map(({ ref }) => ref)]);
  return { refs, bundle };
}

function explainEmptyTables(rows, bundle, converted) {
  const explained = {};
  for (const table of Object.keys(rows).filter((name) => rows[name].length === 0)) {
    const rule = EMPTY_TABLE_REASONS.find((candidate) =>
      candidate.covers(table, converted, bundle)
    );
    if (!rule) throw new Error(`${table} is empty and no reason covers it`);
    if (!rule.verify(bundle, table)) {
      throw new Error(`${table}: the released bundle contradicts the reason ${rule.reason}`);
    }
    explained[table] = {
      reason: rule.reason,
      basis: rule.basis,
      insert_statements_in_the_bundle: insertStatements(bundle, table),
    };
  }
  const used = new Set(Object.values(explained).map((entry) => entry.reason));
  return {
    explained,
    reasons: Object.fromEntries(
      EMPTY_TABLE_REASONS.filter((rule) => used.has(rule.reason)).map((rule) => [
        rule.reason,
        rule.statement,
      ])
    ),
  };
}

function eventPayloads(rows, type) {
  return rows.artifact_events
    .filter((row) => row.event_type === type)
    .map((row) => JSON.parse(Buffer.from(row.record_bytes.blobHex, 'hex')).payload);
}

function cellsNaming(rows, needle) {
  const cells = new Set();
  for (const [table, records] of Object.entries(rows)) {
    for (const record of records) {
      for (const [column, value] of Object.entries(record)) {
        const text =
          typeof value === 'string'
            ? value
            : value?.blobHex
              ? Buffer.from(value.blobHex, 'hex').toString('latin1')
              : '';
        if (text.includes(needle)) cells.add(`${table}.${column}`);
      }
    }
  }
  return [...cells].sort();
}

// Imported artifacts carry the dates of the commits they came from, so only events of
// captured artifacts say when the run happened.
function capturedEventWindow(rows) {
  const captured = new Set(
    rows.artifact_metadata
      .filter((row) => row.origin_kind === 'captured')
      .map((row) => row.artifact_id)
  );
  const times = rows.artifact_events
    .filter((row) => captured.has(row.artifact_id))
    .map((row) => JSON.parse(Buffer.from(row.record_bytes.blobHex, 'hex')).ts)
    .sort();
  return [times[0], times.at(-1)];
}

function compressed(bytes) {
  const packed = brotliCompressSync(bytes, {
    params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_LGWIN]: 24 },
  });
  return `${packed.toString('base64').replace(/(.{76})/g, '$1\n')}\n`;
}

function main() {
  const [summaryFile, runDirectory, ...rest] = process.argv.slice(2);
  if (!summaryFile || !runDirectory || rest.length > 0 || summaryFile.startsWith('--')) {
    throw new Error('usage: released-producer-fixture.freeze.mjs <summary.json> <run-dir>');
  }
  const run = realpathSync(runDirectory);
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  const version = summary.producer.version;
  const converted = summary.legacy_producer !== undefined;
  const changed = summary.isolation.user_directories.filter((entry) => entry.changed.length);
  if (changed.length) throw new Error('the run reported a change to a real user location');

  const target = releasedFixtureDirectory(
    converted ? `${version}-converted-from-${summary.legacy_producer.version}` : version
  );
  if (existsSync(target)) {
    throw new Error(`${target} exists; a frozen release is never regenerated`);
  }
  const databasePath = realpathSync(summary.database.path);
  if (path.relative(run, databasePath).startsWith('..')) {
    throw new Error('the summary describes a database outside the run directory');
  }

  const originals = originalFiles(summary, databasePath);
  const Database = createRequire(path.join(run, 'prefix', 'package.json'))('better-sqlite3');
  const {
    version: schemaVersion,
    definitions,
    foreignKeys,
    rows,
  } = snapshot(Database, databasePath);
  originalFiles(summary, databasePath);
  assertExactNumbers(rows);
  if (foreignKeys.length) throw new Error('the released database has foreign key violations');

  const schema = schemaDigests(definitions);
  if (schema.whitespace_normalized_sql_sha256 !== summary.database.schema.sha256) {
    throw new Error('the schema read here differs from the one the generation summary hashed');
  }
  if (existsSync(RELEASED_SCHEMA_FILE)) {
    const shared = JSON.parse(readFileSync(RELEASED_SCHEMA_FILE, 'utf8'));
    if (JSON.stringify(shared.definitions) !== JSON.stringify(definitions)) {
      throw new Error(`${version} has a different schema definition; store it separately`);
    }
  }

  const evidence = reviewEvidence(rows, databasePath);
  const { refs, bundle } = retainedEvidence(rows, run, summary);
  if (bundle.length > BUNDLE_BYTE_LIMIT) {
    throw new Error(`the ref bundle is ${bundle.length} bytes; keep only its manifest`);
  }
  const released = readFileSync(
    path.join(run, 'prefix', 'node_modules', summary.producer.package, 'dist', 'cli', 'index.js'),
    'utf8'
  );
  const emptyTables = explainEmptyTables(rows, released, converted);
  const procedure = converted
    ? 'released-legacy-conversion.generate.mjs'
    : 'released-producer-database.generate.mjs';
  const procedureFile = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
  const packedOriginals = originals.map((file) => ({
    file,
    name: `${file.name}${ORIGINAL_FILE_SUFFIX}`,
    text: compressed(file.content),
  }));

  const manifest = {
    fixture: converted
      ? `Project database the published ${summary.producer.package} ${version} wrote by converting a legacy history that the published ${summary.legacy_producer.version} wrote`
      : `Project database written by the published ${summary.producer.package} ${version}`,
    producer: summary.producer,
    ...(converted
      ? { legacy_producer: summary.legacy_producer, conversion: summary.conversion }
      : {}),
    generation: {
      command: `node packages/storage/tests/${procedure} ${
        converted ? `${summary.legacy_producer.version} ` : ''
      }${version} <output-dir>`,
      procedure_sha256: {
        [procedure]: sha256(readFileSync(procedureFile(procedure))),
        'released-producer-support.mjs': sha256(
          readFileSync(procedureFile('released-producer-support.mjs'))
        ),
      },
      captured_events_between: capturedEventWindow(rows),
      workflow: summary.workflow,
      isolation: summary.isolation,
      integrity_check: summary.database.integrity_check,
    },
    original_database: {
      note: 'The files the release left, brotli-compressed and base64-encoded. The rows were read through the write-ahead log; a copy of the main file alone holds fewer rows.',
      files: packedOriginals.map(({ file, name, text }) => ({
        name: file.name,
        bytes: file.bytes,
        sha256: file.sha256,
        stored_as: name,
        stored_sha256: sha256(text),
      })),
      pragmas: summary.database.pragmas,
      total_rows: summary.database.total_rows,
      write_ahead_log: summary.database.write_ahead_log,
    },
    schema: {
      user_version: schemaVersion,
      file: '../schema.json',
      ...schema,
      shared_definition:
        'The definitions in ../schema.json were compared byte for byte with this database when it was frozen. Releases that share them can still write different rows: compare content and generation.workflow.',
    },
    content: {
      sha256: databaseDigest(rows),
      tables: Object.fromEntries(
        Object.entries(rows)
          .filter(([, records]) => records.length > 0)
          .map(([table, records]) => [
            table,
            { rows: records.length, sha256: tableDigest(records) },
          ])
      ),
      empty_tables: emptyTables.explained,
      empty_table_reasons: emptyTables.reasons,
      operations_by_kind: countBy(rows.operations, 'operation_kind'),
      events_by_type: countBy(rows.artifact_events, 'event_type'),
      artifacts_by_origin_and_state: countBy(
        rows.artifact_metadata.map((row) => ({ key: `${row.origin_kind}:${row.state}` })),
        'key'
      ),
      evaluator_verdicts_by_severity: countBy(
        eventPayloads(rows, 'evaluator_run_recorded').map((payload) => ({
          key: `${payload.severity}:${payload.verdict}`,
        })),
        'key'
      ),
      import_origin_tool_versions: [
        ...new Set(
          eventPayloads(rows, 'plan_captured')
            .filter((payload) => payload.origin?.kind === 'git-import')
            .map((payload) => payload.origin.tool_version)
        ),
      ],
      review_evidence: {
        files: evidence.length,
        bytes: evidence.reduce((sum, file) => sum + file.bytes.blobHex.length / 2, 0),
        sha256: sha256(evidence.map((file) => `${file.relativePath} ${file.sha256}`).join('\n')),
      },
      machine_specific_cells: {
        naming_the_run_directory: cellsNaming(rows, run),
        identifying_the_repository: [
          'repository_creation.device',
          'repository_creation.inode',
          'repository_creation.birthtime_ns',
        ],
        note: 'The run directory sits under the per-user temporary root of the machine that generated the fixture, so its path carries that user token. Restoring a fixture replaces the store root. The repository directory no longer exists and its device, inode and birth time belong to the deleted directory, so repository identity cannot match after a restore.',
      },
    },
    retained_git_evidence: {
      bundle: { file: RETAINED_REFS_BUNDLE, bytes: bundle.length, sha256: sha256(bundle) },
      refs,
    },
    not_exercised: converted
      ? [
          'One summarized legacy artifact with a revision, an abandoned checkpoint and a refused capture; no legacy seed import and no legacy cloud state.',
          'The converter omits legacy Task Review history by design, so none is here.',
        ]
      : [
          'No LLM evaluator ran: the pack was installed with its deterministic profile and every capture passed --no-llm.',
          'The Task Review ended FULL with both lanes accepted; no degraded or failed run, and the review lifecycle stops at a reopen because completing it needs every row dispositioned.',
          'One block-severity violation was dismissed; none was acknowledged, because the only deterministic block evaluator does not permit acknowledgement.',
        ],
  };

  mkdirSync(target, { recursive: true });
  const write = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  if (!existsSync(RELEASED_SCHEMA_FILE)) {
    write(RELEASED_SCHEMA_FILE, { schemaVersion, definitions });
  }
  write(path.join(target, 'database.json'), { schemaVersion, rows, evidence });
  write(path.join(target, 'manifest.json'), manifest);
  for (const { name, text } of packedOriginals) writeFileSync(path.join(target, name), text);
  writeFileSync(
    path.join(target, RETAINED_REFS_BUNDLE),
    `${bundle.toString('base64').replace(/(.{76})/g, '$1\n')}\n`
  );
  process.stdout.write(
    `${JSON.stringify({ version, target, content: manifest.content.sha256 })}\n`
  );
  process.stderr.write('Format the new JSON files with prettier before committing them.\n');
}

main();
