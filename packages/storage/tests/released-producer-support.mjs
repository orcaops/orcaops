// Shared by the procedures that drive published @orcaops/cli packages: a throwaway layout, an
// environment built from nothing, registry verification, and read-only database inspection.
//
// The isolation guard reports WRITES only: it compares size and modification time of the
// listed user locations before and after a run, so it cannot see a read. It watches the
// orcaops data and config directories, the agent configuration a released tool can write
// (Claude Code skills, commands and settings; Codex config, hooks, skills and prompts; the
// shared agents directory) and the user's git configuration. It does not watch agent
// session logs or Claude Code's synced skills, which the agent running this procedure
// rewrites itself.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

export const PACKAGE_NAME = '@orcaops/cli';
const REGISTRY = 'https://registry.npmjs.org/';

export function progress(message) {
  process.stderr.write(`[released-producer] ${message}\n`);
}

export function exactVersion(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error(`"${version}" is not an exact version; ranges and tags identify no producer`);
  }
  return version;
}

export function requireSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 14) {
    throw new Error(`run under Node 22.14 or a later 22.x; this is v${process.versions.node}`);
  }
}

function locateExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory && existsSync(path.join(directory, name))) return path.join(directory, name);
  }
  throw new Error(`${name} is not on PATH`);
}

export function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${path.basename(command)} ${args.join(' ')} exited ${result.status ?? result.signal}\n${result.stderr}`
    );
  }
  return result;
}

export function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

export function prepareLayout(output, worktrees) {
  if (existsSync(output) && readdirSync(output).length > 0) {
    throw new Error(`${output} is not empty; a produced database is never overwritten`);
  }
  const git = locateExecutable('git');
  let existingAncestor = output;
  while (!existsSync(existingAncestor)) existingAncestor = path.dirname(existingAncestor);
  const enclosingRepository = execute(git, ['rev-parse', '--git-dir'], {
    cwd: existingAncestor,
    allowFailure: true,
  });
  if (enclosingRepository.status === 0) {
    throw new Error(`${output} is inside a git repository; choose a directory outside any repo`);
  }
  mkdirSync(output, { recursive: true });
  const layout = { output };
  for (const name of [
    'bin',
    'npm-home',
    'npm-cache',
    'tarball',
    'tmp',
    'inputs',
    'home',
    'data',
    'config',
    'xdg-data',
    'xdg-config',
    'xdg-cache',
  ]) {
    layout[name] = path.join(output, name);
    mkdirSync(layout[name]);
  }
  for (const name of worktrees) layout[name] = path.join(output, name);

  // The release records the path of the node binary that runs it, in review run records and
  // their receipts. A copy inside the run directory keeps the user's own node path, which
  // usually sits under their home directory, out of the database.
  layout.node = path.join(output, 'runtime', 'node');
  mkdirSync(path.dirname(layout.node));
  copyFileSync(process.execPath, layout.node);
  chmodSync(layout.node, 0o755);

  // PATH holds these three commands and the system directories only. An agent CLI installed
  // beside node would otherwise be discoverable by the released tool.
  const commands = { git, node: layout.node, npm: locateExecutable('npm') };
  for (const [name, target] of Object.entries(commands)) {
    const wrapper = path.join(layout.bin, name);
    writeFileSync(wrapper, `#!/bin/sh\nexec '${target.replaceAll("'", "'\\''")}' "$@"\n`);
    chmodSync(wrapper, 0o755);
  }
  return layout;
}

// Built from nothing rather than from process.env. An inherited ORCAOPS_TOKEN or
// ORCAOPS_CREDENTIAL_STORE=keyring reaches real cloud credentials that redirecting HOME does
// not isolate, and an inherited agent session id would be written into the database.
export function isolatedEnvironment(layout, home, extra = {}) {
  return {
    PATH: [layout.bin, '/usr/bin', '/bin'].join(path.delimiter),
    HOME: home,
    TMPDIR: layout.tmp,
    TZ: 'UTC',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export function producerEnvironment(layout, sessionId) {
  return isolatedEnvironment(layout, layout.home, {
    ORCAOPS_DATA_DIR: layout.data,
    ORCAOPS_CONFIG_HOME: layout.config,
    XDG_DATA_HOME: layout['xdg-data'],
    XDG_CONFIG_HOME: layout['xdg-config'],
    XDG_CACHE_HOME: layout['xdg-cache'],
    CLAUDE_CODE_SESSION_ID: sessionId,
  });
}

// Installs one published version into its own prefix and proves, three ways, that what runs
// is what the registry published: the tarball hashed here, the lockfile npm verified, and the
// version the installed binary reports.
export function installProducer(version, layout, prefixName = 'prefix') {
  const spec = `${PACKAGE_NAME}@${version}`;
  const prefix = path.join(layout.output, prefixName);
  const tarballDirectory = path.join(layout.tarball, version);
  mkdirSync(prefix);
  mkdirSync(tarballDirectory);
  const env = isolatedEnvironment(layout, layout['npm-home'], {
    npm_config_update_notifier: 'false',
  });
  const npm = (args) =>
    execute(
      path.join(layout.bin, 'npm'),
      [...args, '--registry', REGISTRY, '--cache', layout['npm-cache']],
      { cwd: tarballDirectory, env }
    ).stdout;

  progress(`reading the registry record for ${spec}`);
  const registry = JSON.parse(npm(['view', spec, 'dist', '--json']));

  progress('hashing the published tarball');
  npm(['pack', spec, '--pack-destination', tarballDirectory]);
  const [tarballName] = readdirSync(tarballDirectory).filter((name) => name.endsWith('.tgz'));
  const tarballBytes = readFileSync(path.join(tarballDirectory, tarballName));
  const tarball = {
    integrity: `sha512-${digest('sha512', tarballBytes, 'base64')}`,
    shasum: digest('sha1', tarballBytes, 'hex'),
    bytes: tarballBytes.length,
  };

  progress(`installing ${spec}`);
  npm(['install', '--prefix', prefix, spec, '--no-audit', '--no-fund']);
  const lock = JSON.parse(readFileSync(path.join(prefix, 'package-lock.json'), 'utf8'));
  const packageRoot = path.join(prefix, 'node_modules', PACKAGE_NAME);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const locked = lock.packages[`node_modules/${PACKAGE_NAME}`];
  const entry = path.join(packageRoot, manifest.bin.orcaops);
  const reportedVersion = execute(layout.node, [entry, '--version'], {
    env: producerEnvironment(layout, 'version-probe'),
  }).stdout.trim();

  const expectations = [
    ['tarball integrity', tarball.integrity, registry.integrity],
    ['tarball shasum', tarball.shasum, registry.shasum],
    ['installed integrity', locked.integrity, registry.integrity],
    ['installed tarball', locked.resolved, registry.tarball],
    ['installed version', locked.version, version],
    ['manifest version', manifest.version, version],
    ['reported version', reportedVersion, version],
  ];
  for (const [label, actual, expected] of expectations) {
    if (actual !== expected) {
      throw new Error(`${label} is ${actual}; the registry says ${expected}`);
    }
  }

  // The lockfile also lists optional packages for other platforms, which are never installed.
  const dependencies = Object.entries(lock.packages)
    .filter(([location]) => location !== '' && location !== `node_modules/${PACKAGE_NAME}`)
    .filter(([location]) => existsSync(path.join(prefix, location)))
    .map(([location, record]) => ({
      path: location,
      version: record.version,
      ...(record.inBundle ? { bundled: true } : { integrity: record.integrity }),
    }));

  return {
    entry,
    prefix,
    identity: {
      package: PACKAGE_NAME,
      version,
      registry: {
        integrity: registry.integrity,
        shasum: registry.shasum,
        tarball: registry.tarball,
      },
      tarball,
      installed: {
        version: manifest.version,
        resolved: locked.resolved,
        integrity: locked.integrity,
        reported_version: reportedVersion,
      },
      dependencies,
      runtime: {
        node: process.version,
        node_sha256: digest('sha256', readFileSync(layout.node), 'hex'),
        modules_abi: process.versions.modules,
        platform: process.platform,
        arch: process.arch,
      },
    },
  };
}

// Claude Code rewrites its own synced skills while it runs; no orcaops release writes there.
const WATCH_EXCLUSIONS = [path.join('.claude', 'skills', 'synced')];

function snapshotLocation(root) {
  const entries = new Map();
  const stats = lstatSync(root, { throwIfNoEntry: false });
  if (!stats) return entries;
  entries.set('.', `${stats.isDirectory() ? '' : stats.size}:${stats.mtimeMs}`);
  if (!stats.isDirectory()) return entries;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (WATCH_EXCLUSIONS.some((excluded) => location.endsWith(excluded))) continue;
      const found = lstatSync(location, { throwIfNoEntry: false });
      if (!found) continue;
      entries.set(path.relative(root, location), `${found.size}:${found.mtimeMs}`);
      if (entry.isDirectory()) visit(location);
    }
  };
  visit(root);
  return entries;
}

function changedEntries(before, after) {
  const changed = [];
  for (const [location, state] of after) {
    if (before.get(location) !== state) changed.push(location);
  }
  for (const location of before.keys()) {
    if (!after.has(location)) changed.push(location);
  }
  return changed.sort();
}

export function watchUserLocations() {
  const home = homedir();
  const locations = new Set(
    [
      '.orcaops',
      '.config/orcaops',
      '.claude/skills',
      '.claude/commands',
      '.claude/settings.json',
      '.codex/config.toml',
      '.codex/hooks.json',
      '.codex/skills',
      '.codex/prompts',
      '.codex/AGENTS.md',
      '.agents',
      '.gitconfig',
      '.config/git',
    ].map((relative) => path.join(home, relative))
  );
  for (const name of ['ORCAOPS_DATA_DIR', 'ORCAOPS_CONFIG_HOME', 'ORCAOPS_GLOBAL_ROOT']) {
    if (process.env[name]) locations.add(path.resolve(process.env[name]));
  }
  const watched = [...locations].map((location) => ({
    location,
    label: location.startsWith(home) ? `~${location.slice(home.length)}` : location,
    before: snapshotLocation(location),
  }));
  return () =>
    watched.map(({ location, label, before }) => ({
      path: label,
      exists: existsSync(location),
      changed: changedEntries(before, snapshotLocation(location)),
    }));
}

export function createRunner(layout, entry, sessionIds) {
  const log = [];
  let inputCount = 0;

  const git = (worktree, args, env = {}) =>
    execute(path.join(layout.bin, 'git'), args, {
      cwd: layout[worktree],
      env: isolatedEnvironment(layout, layout.home, env),
    }).stdout.trim();

  const commit = (worktree, message, files, date) => {
    for (const [name, content] of Object.entries(files)) {
      const location = path.join(layout[worktree], name);
      mkdirSync(path.dirname(location), { recursive: true });
      writeFileSync(location, content);
    }
    git(worktree, ['add', '--', ...Object.keys(files)]);
    const messages = (Array.isArray(message) ? message : [message]).flatMap((text) => ['-m', text]);
    git(
      worktree,
      ['commit', '--quiet', ...messages],
      date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}
    );
  };

  const writeInput = (label, value) => {
    inputCount += 1;
    const name = `${String(inputCount).padStart(2, '0')}-${label}.json`;
    writeFileSync(path.join(layout.inputs, name), `${JSON.stringify(value, null, 2)}\n`);
    return path.join(layout.inputs, name);
  };

  // `tolerated` names the refusal a step is meant to provoke, by error code or by a pattern
  // over the message for the verbs that report no code. Any other failure stops the run.
  const orcaops = (worktree, args, options = {}) => {
    const argv = [...args];
    if (options.input) {
      const firstFlag = args.findIndex((arg) => arg.startsWith('--'));
      const verb = args.slice(0, firstFlag === -1 ? args.length : firstFlag).join('-');
      argv.push('--input', writeInput(verb, options.input));
    }
    progress(`${worktree}: orcaops ${args.join(' ')}`);
    const result = execute(layout.node, [options.entry ?? entry, ...argv], {
      cwd: layout[worktree],
      env: producerEnvironment(layout, sessionIds[worktree]),
      allowFailure: true,
    });
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `orcaops ${args.join(' ')} printed no JSON\n${result.stdout}${result.stderr}`
      );
    }
    const refused = response.ok === false || (result.status !== 0 && response.ok !== true);
    const refusal =
      response.error?.code ?? response.code ?? response.error?.message ?? response.message ?? null;
    const cloudSync = response.cloud_sync
      ? `${response.cloud_sync.status}:${response.cloud_sync.reason ?? ''}`
      : null;
    log.push({
      worktree,
      command: argv
        .map((arg) => (arg.startsWith(layout.output) ? path.relative(layout.output, arg) : arg))
        .join(' '),
      exit_code: result.status,
      ok: !refused,
      ...(refused ? { error: refusal } : {}),
      ...(cloudSync ? { cloud_sync: cloudSync } : {}),
    });
    if (response.cloud_sync && response.cloud_sync.status !== 'skipped') {
      throw new Error(`orcaops ${args.join(' ')} reached cloud sync: ${cloudSync}`);
    }
    const tolerated =
      options.tolerated instanceof RegExp
        ? options.tolerated.test(String(refusal))
        : options.tolerated !== undefined && options.tolerated === refusal;
    if (refused && !tolerated) {
      throw new Error(`orcaops ${args.join(' ')} failed: ${JSON.stringify(response)}`);
    }
    if (!refused && options.tolerated !== undefined && options.mustRefuse) {
      throw new Error(`orcaops ${args.join(' ')} was expected to be refused`);
    }
    return { ...response, refused };
  };

  return { log, git, commit, orcaops, writeInput };
}

export function retainedRefs(runner, worktree) {
  return runner
    .git(worktree, ['for-each-ref', '--format=%(refname) %(objectname)'])
    .split('\n')
    .map((line) => line.split(' '))
    .filter(([ref]) => ref && !ref.startsWith('refs/heads/'))
    .map(([ref, object]) => ({ ref, object }));
}

function describeDatabaseFiles(databasePath) {
  return ['', '-wal', '-shm']
    .map((suffix) => `${databasePath}${suffix}`)
    .filter((location) => existsSync(location))
    .map((location) => {
      const bytes = readFileSync(location);
      return {
        name: path.basename(location),
        bytes: bytes.length,
        sha256: digest('sha256', bytes, 'hex'),
      };
    });
}

function countRows(database) {
  const counts = {};
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  for (const { name } of tables) {
    counts[name] = database.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n;
  }
  return counts;
}

// What the main file holds without its write-ahead log, read from a copy so the original is
// never opened without the log beside it.
export function writeAheadLogFacts(Database, databasePath, totalRows, scratchDirectory) {
  const log = `${databasePath}-wal`;
  // A clean close can leave the log present and empty, with no header to read.
  const header = existsSync(log) ? readFileSync(log).subarray(0, 32) : Buffer.alloc(0);
  const pageSize = header.length === 32 ? header.readUInt32BE(8) : null;
  const directory = mkdtempSync(path.join(scratchDirectory, 'main-alone-'));
  try {
    const copy = path.join(directory, path.basename(databasePath));
    copyFileSync(databasePath, copy);
    const alone = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      const rows = Object.values(countRows(alone)).reduce((sum, n) => sum + n, 0);
      return {
        page_size: pageSize,
        checkpoint_sequence: pageSize === null ? null : header.readUInt32BE(12),
        frames: pageSize === null ? 0 : (lstatSync(log).size - 32) / (pageSize + 24),
        rows_in_main_file_alone: rows,
        rows_only_in_the_log: totalRows - rows,
        main_file_alone_integrity_check: alone.pragma('integrity_check', { simple: true }),
      };
    } finally {
      alone.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function inspectDatabase(prefix, databasePath, scratchDirectory) {
  // The release's own driver: the SQLite library that wrote the file also reads it, and
  // this procedure needs no dependency installed in the checkout.
  const require = createRequire(path.join(prefix, 'package.json'));
  const Database = require('better-sqlite3');
  const driverRoot = path.dirname(require.resolve('better-sqlite3/package.json'));
  const addon = path.join('prebuilds', `${process.platform}-${process.arch}.node`);

  const files = describeDatabaseFiles(databasePath);
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let facts;
  let sqliteVersion;
  try {
    const objects = database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
      )
      .all()
      .map((object) => ({ ...object, sql: object.sql?.replace(/\s+/g, ' ').trim() ?? null }));
    const rowCounts = countRows(database);
    const pragma = (name) => database.pragma(name, { simple: true });
    facts = {
      user_version: pragma('user_version'),
      journal_mode: pragma('journal_mode'),
      pragmas: {
        application_id: pragma('application_id'),
        user_version: pragma('user_version'),
        journal_mode: pragma('journal_mode'),
        page_size: pragma('page_size'),
        auto_vacuum: pragma('auto_vacuum'),
        encoding: pragma('encoding'),
        schema_version: pragma('schema_version'),
      },
      integrity_check: pragma('integrity_check'),
      foreign_key_violations: database.pragma('foreign_key_check').length,
      schema: {
        objects: objects.length,
        sha256: digest('sha256', JSON.stringify(objects), 'hex'),
      },
      row_counts: rowCounts,
      empty_tables: Object.keys(rowCounts).filter((name) => rowCounts[name] === 0),
    };
    sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
  } finally {
    database.close();
  }
  const totalRows = Object.values(facts.row_counts).reduce((sum, n) => sum + n, 0);
  const writeAheadLog = writeAheadLogFacts(Database, databasePath, totalRows, scratchDirectory);

  const reread = describeDatabaseFiles(databasePath);
  for (const written of files.filter((file) => !file.name.endsWith('-shm'))) {
    if (reread.find((file) => file.name === written.name)?.sha256 !== written.sha256) {
      throw new Error(`reading the database changed ${written.name}, which the release wrote`);
    }
  }

  return {
    database: {
      path: databasePath,
      files,
      ...facts,
      total_rows: totalRows,
      write_ahead_log: writeAheadLog,
    },
    driver: {
      package: 'better-sqlite3',
      version: JSON.parse(readFileSync(path.join(driverRoot, 'package.json'), 'utf8')).version,
      sqlite_version: sqliteVersion,
      addon,
      addon_sha256: existsSync(path.join(driverRoot, addon))
        ? digest('sha256', readFileSync(path.join(driverRoot, addon)), 'hex')
        : null,
    },
  };
}

export function syntheticTranscriptLine(sessionId, sequence) {
  const number = String(sequence).padStart(4, '0');
  return `${JSON.stringify({
    type: 'assistant',
    sessionId,
    requestId: `req_synthetic_${number}`,
    uuid: `00000000-0000-4000-8000-00000000${number}`,
    timestamp: new Date().toISOString(),
    message: {
      id: `msg_synthetic_${number}`,
      model: 'synthetic-model',
      role: 'assistant',
      content: [{ type: 'text', text: 'Synthetic transcript line written for a fixture.' }],
      usage: {
        input_tokens: 100 + sequence,
        output_tokens: 40 + sequence,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 300,
      },
    },
  })}\n`;
}
