#!/usr/bin/env node
// Install the built tarball into a throwaway prefix and verify `init` produces a
// correct tree. Runs under a temp prefix + temp HOME, so the real global
// node_modules and home dir are never touched.
//
//   pnpm install:loop                  # build a fresh tarball, then verify it
//   SKIP_BUILD=1 pnpm install:loop     # reuse dist-release/
//   pnpm install:loop --against-repo . # init into THIS repo, not a scratch one
//
// KEEP=1 skips teardown.
//
// Why this drives `doctor` rather than `--version`: better-sqlite3's addon is
// dlopen'd lazily in the Database constructor, and neither `--version` nor `init`
// constructs one. A tarball whose native install silently failed passes a
// `--version` check and dies on the user's first capture. `doctor`'s `cache`
// check opens the store, so it actually loads the addon.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'dist-release');
// The EXPECTED personal footprint, deliberately independent of the CLI's own
// constant (apps/orcaops-cli/src/lib/git-info-exclude.ts): if the footprint
// changes, this black-box assertion fails loudly so the change is confirmed
// here on purpose rather than ride along silently.
const PERSONAL_EXCLUDE_LINES = ['.orcaops/', 'CLAUDE.local.md', '.orcaops/install.local.json'];
const ADOPTION_STAGE_COMMAND = `for path in .orcaops .gitignore .claude .agents .cursor .opencode .aider-desk AGENTS.md CLAUDE.md; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    git add -A -- "$path"
  fi
done`;

// ---------------------------------------------------------------------------
// Output helpers — mirror build-cli-dist.mjs so the two read alike
// ---------------------------------------------------------------------------
const label = '\x1b[36m[install-loop]\x1b[0m';
function log(msg) {
  process.stdout.write(`${label} ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`\x1b[31m[install-loop] FAIL:\x1b[0m ${msg}\n`);
  process.exitCode = 1;
  throw new HarnessError(msg);
}
class HarnessError extends Error {}

let checks = 0;
function assert(cond, what) {
  checks++;
  if (!cond) fail(what);
  process.stdout.write(`  \x1b[32m✓\x1b[0m ${what}\n`);
}

function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ORCAOPS_')) delete env[key];
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    CODEX_HOME: path.join(HOME, '.codex'),
    ...overrides,
  };
}

function run(cmd, args, opts = {}) {
  const { env, ...spawnOpts } = opts;
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    ...spawnOpts,
    env: childEnv(env),
  });
  if (res.status !== 0) fail(`\`${cmd} ${args.join(' ')}\` exited ${res.status ?? res.signal}`);
  return res;
}

/** Run and capture stdout. Does not throw on non-zero — callers inspect `status`. */
function capture(cmd, args, opts = {}) {
  const { env, ...spawnOpts } = opts;
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: ROOT,
    ...spawnOpts,
    env: childEnv(env),
  });
}

/**
 * Initialize a scratch repo with one commit — `init` refuses a repo with none.
 * The identity is per-repo and mandatory: CI runners have no global git user,
 * so committing without it exits 128.
 */
function seedRepo(dir, message) {
  run('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  run('git', ['config', 'user.email', 'harness@orcaops.test'], { cwd: dir, stdio: 'ignore' });
  run('git', ['config', 'user.name', 'install-loop'], { cwd: dir, stdio: 'ignore' });
  run('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: dir, stdio: 'ignore' });
}

/** Run the installed orcaops with an isolated HOME, returning parsed --json stdout. */
function orcaops(bin, args, { cwd, home }) {
  const res = capture(bin, args, {
    cwd,
    env: {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CODEX_HOME: path.join(home, '.codex'),
      CI: '',
      ORCAOPS_DISABLE_DRAIN: '1',
    },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* not every invocation is --json */
  }
  return { ...res, json };
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const againstIdx = argv.indexOf('--against-repo');
const againstRepo = againstIdx === -1 ? null : path.resolve(argv[againstIdx + 1] ?? '.');
if (againstIdx !== -1 && !argv[againstIdx + 1]) fail('--against-repo needs a path');

// ---------------------------------------------------------------------------
// Sandbox — created before anything can fail so `finally` always has it
// ---------------------------------------------------------------------------
const TMP = mkdtempSync(path.join(tmpdir(), 'orcaops-loop-'));
const PREFIX = path.join(TMP, 'prefix');
const HOME = path.join(TMP, 'home');
const SCRATCH = path.join(TMP, 'repo');
mkdirSync(PREFIX, { recursive: true });
// Seed agent homes so detection is deterministic and never reads the real ~.
for (const dir of ['.claude', '.codex', '.cursor'])
  mkdirSync(path.join(HOME, dir), { recursive: true });

function teardown() {
  if (process.env.KEEP === '1') {
    log(`KEEP=1 — leaving ${TMP} in place`);
    return;
  }
  rmSync(TMP, { recursive: true, force: true });
}

try {
  // ---------------------------------------------------------------------------
  // 1. Tarball
  // ---------------------------------------------------------------------------
  if (process.env.SKIP_BUILD === '1') {
    log('SKIP_BUILD=1 — reusing dist-release/');
  } else {
    log('Building the release tarball (pnpm release:cli)…');
    run('pnpm', ['release:cli']);
  }

  if (!existsSync(RELEASE))
    fail(`${path.relative(ROOT, RELEASE)} not found — run without SKIP_BUILD`);
  // Tolerates a future package rename (`orcaops-cli-*` -> `orcaops-*`).
  const tarballs = readdirSync(RELEASE).filter((f) => /^orcaops(-cli)?-\d.*\.tgz$/.test(f));
  if (tarballs.length !== 1) {
    fail(`expected exactly 1 CLI tarball in dist-release/, found ${tarballs.length}: ${tarballs}`);
  }
  const tarball = path.join(RELEASE, tarballs[0]);
  log(`Tarball: ${tarballs[0]}`);

  // ---------------------------------------------------------------------------
  // 2. Manifest assertions
  // ---------------------------------------------------------------------------
  // The dist manifest is generated, so a `file:` specifier — which fails
  // `npm i -g` on any machine but this one — can only regress silently.
  log('Inspecting the packed manifest…');
  const manifestRaw = capture('tar', ['-xzOf', tarball, 'package/package.json']);
  if (manifestRaw.status !== 0) fail('could not read package/package.json from the tarball');
  const manifest = JSON.parse(manifestRaw.stdout);

  const specifiers = Object.entries({
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  });
  const fileSpecs = specifiers.filter(([, v]) => typeof v === 'string' && v.startsWith('file:'));
  assert(
    fileSpecs.length === 0,
    `no file: specifiers in the published manifest (${specifiers.length} deps checked)`
  );
  assert(manifest.private !== true, 'manifest is not private:true');
  assert(typeof manifest.bin?.orcaops === 'string', 'manifest declares the orcaops bin');

  // -------------------------------------------------------------------------
  // 3. Isolated global install
  // -------------------------------------------------------------------------
  log(`Installing into a throwaway prefix (Node ${process.version})…`);
  run('npm', ['i', '-g', '--prefix', PREFIX, tarball], { stdio: 'ignore' });
  const bin = path.join(PREFIX, 'bin', 'orcaops');
  assert(existsSync(bin), 'orcaops bin exists in the throwaway prefix');

  const ver = capture(bin, ['--version']);
  assert(
    ver.status === 0 && ver.stdout.trim().length > 0,
    `orcaops --version runs (${ver.stdout.trim()})`
  );

  // npm's allow-scripts gating can skip prebuild-install without failing the
  // install, so check the addon is actually on disk.
  const addon = capture('find', [PREFIX, '-name', 'better_sqlite3.node']);
  assert(addon.stdout.trim().length > 0, 'better-sqlite3 native addon was installed');

  // -------------------------------------------------------------------------
  // 4. Target repo — scratch by default
  // -------------------------------------------------------------------------
  let repo;
  if (againstRepo) {
    repo = againstRepo;
    log(`--against-repo: initializing in ${repo} (its own HOME, not the sandbox one)`);
  } else {
    mkdirSync(SCRATCH, { recursive: true });
    repo = SCRATCH;
    seedRepo(repo, 'root');
    log(`Scratch repo: ${repo}`);
  }
  const home = againstRepo ? process.env.HOME : HOME;

  // -------------------------------------------------------------------------
  // 5. init
  // -------------------------------------------------------------------------
  // The main pass pins --scope project: every assertion below (repo skill
  // trees, .gitignore reconcile, uninstall round-trip) is project-mode.
  // --against-repo preserves the target's own scope. The invisible DEFAULT
  // gets its own pass at the end.
  log('Running orcaops init --yes --json…');
  const initArgs = againstRepo
    ? ['init', '--yes', '--json', '--no-llm']
    : ['init', '--scope', 'project', '--yes', '--json', '--no-llm'];
  const init = orcaops(bin, initArgs, { cwd: repo, home });
  assert(init.status === 0, 'init exits 0');
  assert(init.json?.ok === true, 'init reports ok');

  const r = init.json;
  // Only the scratch repo is guaranteed fresh. `--against-repo` is documented
  // for initializing into an EXISTING checkout, which is usually already
  // initialized, so asserting freshness there fails on the flag's normal use.
  if (!againstRepo) {
    assert(r.already_initialized === false, 'init reports a fresh initialization');
  }
  assert(r.dry_run === false, 'init actually wrote (dry_run false)');
  if (!againstRepo) {
    for (const want of ['.orcaops/artifacts/', '.orcaops/cache/', '.orcaops/config.json']) {
      assert(r.created.includes(want), `init created ${want}`);
    }
  }
  assert(
    r.install_agents.length > 0,
    `init selected an install set (${r.install_agents.join(', ')})`
  );
  assert(
    r.agent_skills_installed.length > 0,
    `init installed ${r.agent_skills_installed.length} skills`
  );
  // Instruction-file injection is opt-in: a default init must leave the user's
  // AGENTS.md / CLAUDE.md alone, and must not create them where none existed.
  // An existing repo may legitimately be `bootstrap: managed` already, in which
  // case preserving its block is the correct behavior, not a regression.
  if (!againstRepo) {
    assert(r.agents_md.length === 0, 'init wrote no instruction file by default');
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      assert(!existsSync(path.join(repo, f)), `init did not create ${f}`);
    }
    assert(
      r.gitignore_added.length > 0,
      `init reconciled .gitignore (${r.gitignore_added.length} entries)`
    );
  }
  // Every generated path init claims must actually be on disk.
  const claimed = [...r.agent_skills_installed, ...r.agent_commands_installed];
  const missing = claimed.filter((p) => !existsSync(path.join(repo, p)));
  assert(missing.length === 0, `all ${claimed.length} generated files exist on disk`);

  // -------------------------------------------------------------------------
  // 6. doctor — the step that proves the native addon actually loads
  // -------------------------------------------------------------------------
  log('Running orcaops doctor --json…');
  const doc = orcaops(bin, ['doctor', '--json'], { cwd: repo, home });
  const dd = doc.json?.data ?? doc.json ?? {};
  const dchecks = dd.checks ?? [];
  assert(dchecks.length > 0, `doctor ran ${dchecks.length} checks`);

  const failed = dchecks.filter((c) => c.status === 'fail');
  assert(
    failed.length === 0,
    `doctor reports zero failing checks${failed.length ? `: ${failed.map((c) => c.name)}` : ''}`
  );
  assert(doc.status === 0, 'doctor exits 0');

  const cache = dchecks.find((c) => c.name === 'cache');
  assert(
    cache?.status === 'pass',
    `doctor's cache check passed — SQLite opened (${cache?.summary ?? 'no summary'})`
  );

  // -------------------------------------------------------------------------
  // 7. Idempotency + uninstall round-trip
  //
  // Scratch repos only. These steps force-init and then UNINSTALL, which
  // against a real checkout would rewrite its instruction file and delete its
  // committed skill tree. `--against-repo` exists to see what init produces in
  // a real repo, not to tear that repo's install down.
  // -------------------------------------------------------------------------
  if (againstRepo) {
    log('--against-repo: skipping the force-reinit + uninstall round-trip (destructive)');
  } else {
    log('Re-running init --force (idempotency)…');
    const reinit = orcaops(bin, ['init', '--force', '--yes', '--json', '--no-llm'], {
      cwd: repo,
      home,
    });
    assert(reinit.status === 0, 're-init exits 0');
    assert(reinit.json?.already_initialized === true, 're-init reports already_initialized');
    assert(
      reinit.json?.install_agents?.join(',') === r.install_agents.join(','),
      're-init preserved the install set'
    );

    // The other half of the opt-in: --agents-md must actually inject.
    log('Re-running init --agents-md (opt-in)…');
    const optIn = orcaops(bin, ['init', '--force', '--yes', '--json', '--no-llm', '--agents-md'], {
      cwd: repo,
      home,
    });
    assert(optIn.status === 0, 'init --agents-md exits 0');
    assert(
      (optIn.json?.agents_md ?? []).some((f) => f.path === 'AGENTS.md'),
      'init --agents-md injects the block into AGENTS.md'
    );

    // Session hooks round-trip: pre-seed a USER hook into .claude/settings.json
    // so the opt-in must merge (not clobber), then verify the strip on
    // uninstall leaves the user's hook standing. This exercises the co-owned
    // settings surface end-to-end from the installed tarball — the unit suite
    // covers the merge rules; this proves the shipped binary does too.
    log('Re-running init --session-hooks (opt-in) with a pre-seeded user hook…');
    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const userHookGroup = {
      matcher: 'startup',
      hooks: [{ type: 'command', command: 'echo user-hook' }],
    };
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ hooks: { SessionStart: [userHookGroup] } }, null, 2)}\n`
    );
    const hooksIn = orcaops(
      bin,
      [
        'init',
        '--force',
        '--yes',
        '--json',
        '--no-llm',
        '--session-hooks',
        '--agents',
        'claude-code,cursor',
      ],
      { cwd: repo, home }
    );
    assert(hooksIn.status === 0, 'init --session-hooks exits 0');
    assert(hooksIn.json?.restart_required === true, 'init --session-hooks flags restart_required');
    const mergedSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert(
      JSON.stringify(mergedSettings).includes('orcaops hook session-start'),
      'init --session-hooks merged the orcaops entry into .claude/settings.json'
    );
    assert(
      JSON.stringify(mergedSettings.hooks.SessionStart[0]) === JSON.stringify(userHookGroup),
      'the pre-seeded user hook survived the merge untouched'
    );

    const hookBinDir = path.join(TMP, 'hook-path');
    mkdirSync(hookBinDir, { recursive: true });
    symlinkSync('/bin/sh', path.join(hookBinDir, 'sh'));
    for (const rel of ['.claude/settings.json', '.cursor/hooks.json']) {
      const document = JSON.parse(readFileSync(path.join(repo, rel), 'utf8'));
      const commands = JSON.stringify(document).match(
        /sh -c 'command -v orcaops[^"\\]*(?:\\.[^"\\]*)*'/g
      );
      assert(commands?.length === 1, `${rel} carries one guarded orcaops command`);
      const invocation = capture('/bin/sh', ['-c', commands[0]], {
        cwd: repo,
        env: { PATH: hookBinDir },
      });
      assert(
        invocation.status === 0 && invocation.stdout === '' && invocation.stderr === '',
        `${rel} exits silently when the installed binary is absent from PATH`
      );
    }

    log('Running orcaops uninstall…');
    const un = orcaops(bin, ['uninstall', '--json'], { cwd: repo, home });
    assert(un.status === 0, 'uninstall exits 0');
    const leftover = claimed.filter((p) => existsSync(path.join(repo, p)));
    assert(leftover.length === 0, `uninstall removed all ${claimed.length} generated files`);

    // Session-hook strip: our entry is gone from every settings surface, the
    // user's hook is intact, and no surviving file references the command.
    const strippedSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert(
      JSON.stringify(strippedSettings.hooks.SessionStart[0]) === JSON.stringify(userHookGroup) &&
        strippedSettings.hooks.SessionStart.length === 1,
      'uninstall stripped the orcaops entry and preserved the user hook'
    );
    for (const rel of ['.claude/settings.json', '.cursor/hooks.json']) {
      const p = path.join(repo, rel);
      if (!existsSync(p)) continue;
      assert(
        !readFileSync(p, 'utf8').includes('orcaops hook session-start'),
        `no orcaops session-hook entry survives in ${rel}`
      );
    }

    // `claimed` was captured from the FIRST init, which wrote no block, so the
    // check above cannot see the one the opt-in step just injected. Round-tripping
    // the instruction file is the whole point of an opt-in injection: verify the
    // managed region is gone, and that a file orcaops created is not left behind.
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      const p = path.join(repo, f);
      if (!existsSync(p)) continue;
      assert(
        !readFileSync(p, 'utf8').includes('orcaops:start'),
        `uninstall removed the managed block from ${f}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 8. Invisible default — a plain init must leave git status clean
  // -------------------------------------------------------------------------
  if (!againstRepo) {
    log('Running the invisible-default pass (plain init in a fresh scratch repo)…');
    const repo2 = path.join(TMP, 'repo-invisible');
    mkdirSync(repo2, { recursive: true });
    seedRepo(repo2, 'seed');
    const inv = orcaops(bin, ['init', '--yes', '--json', '--no-llm'], { cwd: repo2, home });
    assert(inv.status === 0, 'invisible init exits 0');
    assert(inv.json?.scope === 'personal', 'plain init defaults to personal (invisible) scope');
    assert(
      (inv.json?.global?.materialized?.length ?? 0) > 0,
      'invisible init materialized global skills'
    );
    assert(inv.json?.project_id?.length > 0, 'invisible init minted a project id');
    const porcelain = capture('git', ['-C', repo2, 'status', '--porcelain']);
    assert(
      porcelain.stdout.trim() === '',
      'git status is COMPLETELY clean after the invisible init'
    );
    assert(!existsSync(path.join(repo2, '.gitignore')), 'invisible init wrote no .gitignore');
    assert(
      existsSync(path.join(repo2, '.orcaops', 'config.json')),
      'invisible init created the excluded .orcaops store'
    );
    const exclude = readFileSync(path.join(repo2, '.git', 'info', 'exclude'), 'utf8');
    const excludeLines = exclude.split(/\r?\n/);
    const blockStart = excludeLines.indexOf('# >>> orcaops >>>');
    const blockEnd = excludeLines.indexOf('# <<< orcaops <<<', blockStart + 1);
    assert(
      blockStart !== -1 &&
        blockEnd !== -1 &&
        JSON.stringify(excludeLines.slice(blockStart + 1, blockEnd)) ===
          JSON.stringify(PERSONAL_EXCLUDE_LINES),
      'info/exclude carries exactly the personal footprint inside its owned block'
    );
    const cfg = JSON.parse(readFileSync(path.join(repo2, '.orcaops', 'config.json'), 'utf8'));
    assert(
      cfg.install?.scope === 'personal' && cfg.gc === undefined,
      'config is a minimal delta (explicit scope, no pinned defaults)'
    );

    const adoption = orcaops(bin, ['update', '--scope', 'project', '--json'], {
      cwd: repo2,
      home,
    });
    assert(adoption.status === 0, 'team-adoption update exits 0');
    // The staging snippet lives on the team-adoption page; it moved off
    // getting-started in 80e79260 and this assertion kept the old path, which
    // failed every install-smoke run and — because assert() throws — masked
    // the session-hooks consent checks below it.
    const adoptionDoc = readFileSync(
      path.join(ROOT, 'apps', 'docs', 'content', 'team-adoption.md'),
      'utf8'
    );
    assert(
      adoptionDoc.includes(ADOPTION_STAGE_COMMAND),
      'team-adoption carries the install-loop adoption command verbatim'
    );
    const staged = capture('/bin/sh', ['-c', ADOPTION_STAGE_COMMAND], { cwd: repo2 });
    assert(staged.status === 0, 'documented team-adoption staging command exits 0');
  }

  // -------------------------------------------------------------------------
  // 9. Machine-level session hooks — the consent boundary, from the tarball
  // -------------------------------------------------------------------------
  if (!againstRepo) {
    log('Verifying the session-hooks consent boundary…');
    const userSettings = path.join(HOME, '.claude', 'settings.json');
    const userHooksRecord = path.join(HOME, '.orcaops', 'hooks.local.json');
    const codexConfig = path.join(HOME, '.codex', 'config.toml');
    const refuse = orcaops(bin, ['session-hooks', 'install', '--json'], { cwd: repo, home: HOME });
    assert(refuse.status === 1, 'non-TTY `session-hooks install` refuses (exit 1)');
    assert(
      String(refuse.json?.error?.message ?? refuse.stderr).includes(
        'requires an interactive consent prompt'
      ),
      'the refusal reports the interactive-consent boundary'
    );
    assert(!existsSync(userSettings), 'the refusal wrote no Claude user settings');
    assert(!existsSync(userHooksRecord), 'the refusal wrote no machine-hook record');
    assert(!existsSync(codexConfig), 'the refusal wrote no Codex config');

    // Uninstall is permitted unattended (restores pre-consent state): seed a
    // user file carrying BOTH a user hook and an orcaops --user entry, then
    // verify the strip preserves the user's hook.
    const userGroup = {
      matcher: 'startup',
      hooks: [{ type: 'command', command: 'echo user-hook' }],
    };
    const oursGroup = {
      matcher: 'startup|resume|clear',
      hooks: [
        {
          type: 'command',
          command:
            "sh -c 'command -v orcaops >/dev/null 2>&1 && orcaops hook session-start --agent claude-code --user || true'",
          timeout: 10,
        },
      ],
    };
    mkdirSync(path.dirname(userSettings), { recursive: true });
    writeFileSync(
      userSettings,
      `${JSON.stringify({ hooks: { SessionStart: [userGroup, oursGroup] } }, null, 2)}\n`
    );
    const strip = orcaops(bin, ['session-hooks', 'uninstall', '--yes', '--json'], {
      cwd: repo,
      home: HOME,
    });
    assert(strip.status === 0, 'session-hooks uninstall exits 0');
    const stripped = JSON.parse(readFileSync(userSettings, 'utf8'));
    assert(
      JSON.stringify(stripped.hooks.SessionStart) === JSON.stringify([userGroup]),
      'uninstall stripped the orcaops user entry and preserved the user hook'
    );
  }

  log('');
  log(`\x1b[32mPASS\x1b[0m  ${checks} assertions on Node ${process.version}`);
} catch (err) {
  if (!(err instanceof HarnessError)) {
    process.stderr.write(`\x1b[31m[install-loop] unexpected error:\x1b[0m ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  }
} finally {
  teardown();
}
