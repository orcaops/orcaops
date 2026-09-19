import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BootstrapContent,
  type BootstrapContentInput,
  CLOUD_PIN_SCHEME,
  CLOUD_SURFACE_COMMANDS,
  resolveBootstrapContent,
  SKILL_TEMPLATES,
} from '@orcaops/adapters';
import {
  createLinkedWorktree,
  createTempRepo,
  gitClient,
  inputFile,
  type TempRepo,
} from '@orcaops/test-harness';

import { canonicalSessionHookCommand, settingsSpecs } from '../../src/lib/session-hooks.js';
import { renderSessionStartGuidance } from '../../src/lib/session-start-guidance.js';
import {
  readSessionStartState,
  type SessionStartState,
} from '../../src/lib/session-start-state.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * `resolveSkillGates` reads a credentials file OUTSIDE the repo, and the state
 * loader must never call it — the cloud gate is hardcoded off there. The gate is
 * routing-equivalent (no cloud-gated template declares a trigger line), so the
 * payload looks the same either way and only the call itself is observable.
 * The wrapper delegates, so every other command in this file behaves normally.
 */
const skillGateCalls = { n: 0 };
/** Flipped on to drive the state loader's degraded path; see its own test. */
const skillSetFault = { fail: false };
vi.mock('../../src/lib/skill-set.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/skill-set.js')>();
  return {
    ...actual,
    resolveSkillGates: (env: NodeJS.ProcessEnv) => {
      skillGateCalls.n += 1;
      return actual.resolveSkillGates(env);
    },
    enabledSkillTemplates: (...args: Parameters<typeof actual.enabledSkillTemplates>) => {
      if (skillSetFault.fail) throw new Error('skill set unavailable');
      return actual.enabledSkillTemplates(...args);
    },
  };
});

type StaticState = Extract<SessionStartState, { kind: 'static' }>;
type ReadyState = Extract<SessionStartState, { kind: 'ready' }>;

function bootstrapContent(over: Partial<BootstrapContentInput> = {}): BootstrapContent {
  return resolveBootstrapContent({
    prefix: 'oo',
    enabledSkills: undefined,
    hints: undefined,
    commitInsideWindow: true,
    suppressedRouting: [],
    ...over,
  });
}

function mkStatic(over: Partial<StaticState> = {}): StaticState {
  return { kind: 'static', prefix: 'oo', hooksOnly: true, content: bootstrapContent(), ...over };
}

function mkReady(over: Partial<ReadyState> = {}): ReadyState {
  return {
    kind: 'ready',
    branch: 'main',
    prefix: 'oo',
    cacheStatus: 'available',
    inFlight: [],
    hooksOnly: true,
    content: bootstrapContent(),
    ...over,
  };
}

/** One state per state-aware payload branch: no cache, no thread, one, many. */
function everyPayloadBranch(over: Partial<ReadyState> = {}): ReadyState[] {
  const artifact = {
    id: '019f0000-0000-7000-8000-000000000001',
    label: 'fixture',
    state: 'in_progress',
    checkpointCount: 1,
    openCheckpoints: [],
  };
  return [
    mkReady({ cacheStatus: 'missing', ...over }),
    mkReady(over),
    mkReady({ inFlight: [artifact], ...over }),
    mkReady({
      inFlight: [artifact, { ...artifact, id: '019f0000-0000-7000-8000-000000000002' }],
      ...over,
    }),
  ];
}

async function projectDatabaseFile(repoRoot: string): Promise<string> {
  const registration = JSON.parse(
    await readFile(path.join(repoRoot, '.git', 'orcaops', 'registration.json'), 'utf8')
  ) as { authority: { resolved_root: string; project_id: string } };
  return path.join(
    registration.authority.resolved_root,
    'projects',
    registration.authority.project_id,
    'history.sqlite3'
  );
}

/**
 * `orcaops hook session-start` — the entry point installed agent session
 * hooks execute. The hard contract under test: ALWAYS exit 0 (a failure would
 * put an error banner in every teammate's session start), empty stdout on
 * any failure, zero writes on the fresh-repo path, and per-agent output
 * shapes (plain text vs cursor's `additional_context` JSON).
 */

describe('orcaops hook session-start', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let dataRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-data-'));
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DATA_DIR: dataRoot } });
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('non-git directory → exit 0, empty stdout', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-nogit-'));
    const stray = makeAgent({ cwd: dir });
    const r = await stray.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('git repo without orcaops init → exit 0, empty stdout', async () => {
    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('default payload is static: fixed prefix-aware nudge, zero state reads, no cache DB', async () => {
    // --session-hooks: emission is gated on session_hooks.enabled — a repo
    // that never opted in stays silent (its own test below).
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--prefix',
      'oo',
      '--session-hooks',
    ]);
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    // Archive-enabled init materializes the cache itself; the hook's zero-write
    // contract is about the HOOK, so clear it and prove the hook stays out.
    await rm(path.dirname(dbPath), { recursive: true, force: true });

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[orcaops] This repo captures AI coding sessions');
    // Cadence pin (live dogfood feedback + working-with-your-agent.md): capture
    // anchors to PLAN APPROVAL — never conversation start — so brainstorming
    // and design sessions read an explicit "nothing to capture yet".
    expect(r.stdout).toContain('Capture starts at PLAN APPROVAL, not at conversation start');
    // Static knows nothing about the branch — it points at status instead of
    // asserting thread state. (Match the state-aware marker phrases exactly:
    // a bare 'in flight' would only pass because static's wording happens to
    // hyphenate "in-flight".)
    expect(r.stdout).toContain('orcaops status --json');
    expect(r.stdout).not.toContain('no capture thread is in flight');
    expect(r.stdout).not.toContain('Capture thread ');
    // Prefix-aware skill references — never hardcoded orcaops-*.
    expect(r.stdout).toContain('`oo-capture`');
    expect(r.stdout).toContain('`oo-checkpoint`');
    expect(r.stdout).not.toContain('orcaops-capture');
    await expect(access(dbPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stays exit-0 silent with a parked artifact-deletion staging dir (fail-closed readers never reach the hook)', async () => {
    // The fail-closed store readers throw RECOVERY_REQUIRED on protected
    // deletion staging — but the session-start hook must never route through
    // them: its isolation is by convention, so pin it here.
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks']);
    const staging = path.join(
      repo.path,
      '.orcaops',
      'tmp',
      'artifact-deletions',
      '01999999-9999-7000-8000-000000000001',
      'prepared-deadbeef'
    );
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, 'events.ndjson'), '{"seq":1}\n', 'utf8');

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('[orcaops]');
    // The staged bytes are untouched: the hook reads nothing that reconciles.
    expect(await readFile(path.join(staging, 'events.ndjson'), 'utf8')).toBe('{"seq":1}\n');
  });

  it('state-aware payload: prefix-aware thread nudge, and NO cache DB is created', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--prefix',
      'oo',
      '--session-hook-payload',
      'state-aware',
      '--session-hooks',
    ]);
    const dbPath = await projectDatabaseFile(repo.path);
    await rm(dbPath, { force: true });
    await expect(access(dbPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[orcaops] Capture is set up');
    expect(r.stdout).toContain('no cached thread state is available');
    expect(r.stdout).not.toContain('no capture thread is in flight');
    // Same cadence pin as the static test: no-thread guidance must not push
    // capture before the plan is settled and approved.
    expect(r.stdout).toContain('Capture starts at PLAN APPROVAL, not at conversation start');
    expect(r.stdout).toContain('`oo-capture`');
    expect(r.stdout).toContain('`oo-checkpoint`');
    expect(r.stdout).not.toContain('orcaops-capture');

    // The passive reader must not recreate missing project history.
    await expect(access(dbPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('active artifact without an open checkpoint → continue/resume guidance naming it', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hook-payload',
      'state-aware',
      '--session-hooks',
    ]);
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'hook fixture task',
          label: 'hook fixture',
          plan_steps: [
            { text: 's1', label: 's1', acceptance_criteria: [{ text: 'the step is delivered' }] },
          ],
          touched_scope: [],
        })
      ),
    ]);
    expect(planRes.exitCode, planRes.stdout + planRes.stderr).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };

    const databasePath = await projectDatabaseFile(repo.path);
    const before = await readFile(databasePath);
    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(plan.artifact_id);
    expect(r.stdout).toContain('"hook fixture"');
    expect(r.stdout).toContain('open a checkpoint via the `orcaops-checkpoint` skill BEFORE');
    expect(r.stdout).toContain('close it: orcaops-finish');
    expect(r.stdout).not.toContain('orcaops-pre-pr');
    expect((await readFile(databasePath)).equals(before)).toBe(true);
  });

  it('open checkpoint → named as OPEN with close-or-abandon guidance', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hook-payload',
      'state-aware',
      '--session-hooks',
    ]);
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'hook open-cp fixture',
          label: 'hook open-cp',
          plan_steps: [
            { text: 's1', label: 's1', acceptance_criteria: [{ text: 'the step is delivered' }] },
          ],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(planRes.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    const open = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    expect(open.exitCode).toBe(0);

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Checkpoint 1 is OPEN');
    expect(r.stdout).toContain('or abandon it');
    // Freshly opened: no stale wording.
    expect(r.stdout).not.toContain('left over from a previous session');
  });

  it('state-aware payload honors ORCAOPS_ROOT and labels detached HEAD readably', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hook-payload',
      'state-aware',
      '--session-hooks',
    ]);
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'root override hook fixture',
          label: 'root override hook',
          plan_steps: [
            { text: 's1', label: 's1', acceptance_criteria: [{ text: 'the step is delivered' }] },
          ],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-root-'));
    const rooted = makeAgent({
      cwd: outside,
      env: { ORCAOPS_ROOT: repo.path, ORCAOPS_DATA_DIR: dataRoot },
    });
    const fromOverride = await rooted.runRaw(['hook', 'session-start']);
    expect(fromOverride.stdout).toContain(plan.artifact_id);
    const fromFlag = await makeAgent({
      cwd: outside,
      env: { ORCAOPS_DATA_DIR: dataRoot },
    }).runRaw(['--root', repo.path, 'hook', 'session-start']);
    expect(fromFlag.stdout).toContain(plan.artifact_id);

    await gitClient(repo.path).raw(['checkout', '--detach']);
    const detached = await agent.runRaw(['hook', 'session-start']);
    expect(detached.stdout).toContain('branch `detached HEAD`');
    expect(detached.stdout).not.toContain('branch `HEAD`');
  });

  it('a payload flip changes the emission but leaves the installed settings entry byte-identical', async () => {
    // The A/B arm-switch property: the settings entry never encodes the
    // mode, so `update --session-hook-payload …` changes what the NEXT
    // session receives without touching the installed surface (no restart,
    // no settings churn).
    const specs = settingsSpecs();
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      specs.map((spec) => spec.agent).join(','),
    ]);
    const settingsPaths = specs.map((spec) => spec.path);
    const before = await Promise.all(
      settingsPaths.map((settingsPath) => readFile(path.join(repo.path, settingsPath), 'utf8'))
    );

    const staticOut = await agent.runRaw(['hook', 'session-start']);
    expect(staticOut.stdout).toContain('[orcaops] This repo captures AI coding sessions');

    const res = await agent.runRaw(['update', '--json', '--session-hook-payload', 'state-aware']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      session_hooks: Array<{ action: string }>;
      restart_required: boolean;
    };
    expect(out.session_hooks.map((h) => h.action)).toEqual(['unchanged', 'unchanged']);
    expect(out.restart_required).toBe(false);
    const after = await Promise.all(
      settingsPaths.map((settingsPath) => readFile(path.join(repo.path, settingsPath), 'utf8'))
    );
    expect(after).toEqual(before);

    const awareOut = await agent.runRaw(['hook', 'session-start']);
    expect(awareOut.exitCode).toBe(0);
    expect(awareOut.stdout).toContain('no capture thread is in flight');
    expect(awareOut.stdout).not.toContain('This repo captures AI coding sessions');
  });

  it('--agent cursor emits {"additional_context": ...} JSON; plain agents emit text', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks']);
    const cursor = await agent.runRaw(['hook', 'session-start', '--agent', 'cursor']);
    expect(cursor.exitCode).toBe(0);
    const parsed = JSON.parse(cursor.stdout) as { additional_context: string };
    expect(parsed.additional_context).toContain('[orcaops]');
    expect(parsed.additional_context).toContain('orcaops-capture');

    const claude = await agent.runRaw(['hook', 'session-start', '--agent', 'claude-code']);
    expect(claude.exitCode).toBe(0);
    expect(claude.stdout.startsWith('[orcaops]')).toBe(true);
    expect(() => JSON.parse(claude.stdout)).toThrow();
  });

  it('corrupted project DB: state-aware falls back to the static reminder; static still emits', async () => {
    // Formerly pinned as silence. A store that cannot open (corrupt cache, or
    // a hook environment whose node ABI mismatches the better-sqlite3 addon)
    // silenced the whole feature with zero signal — indistinguishable from
    // not-installed. The contract is now the visible static nudge, matching
    // the branch-failure fallback; fail-open (exit 0) is unchanged.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hook-payload',
      'state-aware',
      '--session-hooks',
    ]);
    const dbPath = await projectDatabaseFile(repo.path);
    await writeFile(dbPath, 'this is not a sqlite database\n', 'utf8');
    const aware = await agent.runRaw(['hook', 'session-start']);
    expect(aware.exitCode).toBe(0);
    expect(aware.stdout).toContain('[orcaops] This repo captures AI coding sessions');

    // Flip the arm with a raw config edit (`update` itself needs the store,
    // which is corrupt here — the mode being plain config is exactly what
    // makes the flip possible in a repo this broken). Static never opens the
    // store, so the corrupt cache is irrelevant and the nudge still lands.
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
      session_hooks: { payload: string };
    };
    cfg.session_hooks.payload = 'static';
    await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    const stat = await agent.runRaw(['hook', 'session-start']);
    expect(stat.exitCode).toBe(0);
    expect(stat.stdout).toContain('[orcaops] This repo captures AI coding sessions');
  });

  it('--agent codex emits the hookSpecificOutput envelope (0.146 rejects plain text)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks']);
    const r = await agent.runRaw(['hook', 'session-start', '--agent', 'codex']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('[orcaops]');
  });

  it('ORCAOPS_HOOK_SUPPRESS follows the shared boolean environment convention', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks']);
    const unset = await agent.runRaw(['hook', 'session-start', '--agent', 'codex']);
    expect(unset.stdout).not.toBe('');

    for (const value of ['', '0', 'false', 'no', 'off']) {
      const unsuppressed = makeAgent({
        cwd: repo.path,
        env: {
          ORCAOPS_DATA_DIR: dataRoot,
          ORCAOPS_DISABLE_DRAIN: '1',
          ORCAOPS_HOOK_SUPPRESS: value,
        },
      });
      const result = await unsuppressed.runRaw(['hook', 'session-start', '--agent', 'codex']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout, `expected ${JSON.stringify(value)} to emit`).not.toBe('');
    }

    for (const value of ['1', 'true', 'yes', 'on']) {
      const suppressed = makeAgent({
        cwd: repo.path,
        env: {
          ORCAOPS_DATA_DIR: dataRoot,
          ORCAOPS_DISABLE_DRAIN: '1',
          ORCAOPS_HOOK_SUPPRESS: value,
        },
      });
      const result = await suppressed.runRaw(['hook', 'session-start', '--agent', 'codex']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout, `expected ${JSON.stringify(value)} to suppress`).toBe('');
    }
  });

  it('enabled=false gates EMISSION: an initialized repo that never opted in stays silent', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  // Scope decides WHERE integrations are installed, never whether the hook
  // fires: emission is gated on `session_hooks.enabled` alone. Doctor's
  // wording has long claimed the opposite ("inactive under scope global"), so
  // pin the runtime before anything is refactored against that claim.
  it('global scope with hooks enabled emits, carried by the machine registration alone', async () => {
    await agent.runRaw(['init', '--scope', 'global', '--json', '--no-llm', '--session-hooks']);

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[orcaops] This repo captures AI coding sessions');

    // No project entry exists to arbitrate against, so the machine-level
    // invocation carries the session instead of yielding.
    const user = await agent.runRaw(['hook', 'session-start', '--agent', 'claude-code', '--user']);
    expect(user.exitCode).toBe(0);
    expect(user.stdout).toContain('[orcaops] This repo captures AI coding sessions');

    await expect(access(path.join(repo.path, '.claude', 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('global scope without hooks enabled stays silent', async () => {
    await agent.runRaw(['init', '--scope', 'global', '--json', '--no-llm']);
    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('an unconfigured repository beside a global install stays silent', async () => {
    await agent.runRaw(['init', '--scope', 'global', '--json', '--no-llm', '--session-hooks']);
    const stray = await createTempRepo({ initialBranch: 'main' });
    try {
      const outsider = makeAgent({ cwd: stray.path, env: { ORCAOPS_DATA_DIR: dataRoot } });
      const r = await outsider.runRaw(['hook', 'session-start']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      await stray.cleanup();
    }
  });

  it('--user yields when the repo carries a PROJECT entry (no double injection)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks']);
    // The project entry exists in .claude/settings.json — the machine-level
    // invocation must emit NOTHING; the project entry emits in the same
    // session.
    const user = await agent.runRaw(['hook', 'session-start', '--agent', 'claude-code', '--user']);
    expect(user.exitCode).toBe(0);
    expect(user.stdout).toBe('');
    const project = await agent.runRaw(['hook', 'session-start', '--agent', 'claude-code']);
    expect(project.stdout).not.toBe('');
  });

  it('--user emits when the repo is enabled with entries:none (machine registration carries it)', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--session-hook-entries',
      'none',
    ]);
    await expect(access(path.join(repo.path, '.claude', 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const r = await agent.runRaw(['hook', 'session-start', '--agent', 'claude-code', '--user']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toBe('');
  });

  it('--user stays silent when the project settings file is unreadable', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--session-hook-entries',
      'none',
    ]);
    const settingsPath = path.join(repo.path, '.claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{ invalid json\n', 'utf8');

    const result = await agent.runRaw([
      'hook',
      'session-start',
      '--agent',
      'claude-code',
      '--user',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('--user ignores customized and out-of-region project commands', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--session-hook-entries',
      'none',
    ]);
    const settingsPath = path.join(repo.path, '.claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          note: canonicalSessionHookCommand('claude-code'),
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'env TEAM_HOOK=1 orcaops hook session-start --agent claude-code',
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                hooks: [{ type: 'command', command: canonicalSessionHookCommand('claude-code') }],
              },
            ],
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const customized = await agent.runRaw([
      'hook',
      'session-start',
      '--agent',
      'claude-code',
      '--user',
    ]);
    expect(customized.stdout).not.toBe('');
  });
});

/**
 * The routing gate: the hook renders routing unless a managed block is ACTUALLY
 * carrying it. A marker alone does not prove that — the read-intent section was
 * once trimmed while the marker stayed, so marker-bearing blocks with no routing
 * exist in the wild, and treating them as covered is the failure being fixed.
 */
describe('orcaops hook session-start — routing gate', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let dataRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-data-'));
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DATA_DIR: dataRoot } });
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(dataRoot, { recursive: true, force: true });
  });

  const initManaged = async (): Promise<void> => {
    const r = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--prefix',
      'oo',
      '--session-hooks',
      '--agents-md',
    ]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  };

  const routingBullets = (stdout: string): string[] =>
    stdout.split('\n').filter((line) => line.startsWith('- "'));

  it('a managed block carrying routing keeps the hook short', async () => {
    await initManaged();
    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[orcaops] This repo captures AI coding sessions');
    expect(routingBullets(r.stdout)).toEqual([]);
    expect(r.stdout).not.toContain('oo-plan-critique');
  });

  it('a manual-bootstrap repo renders routing', async () => {
    const r0 = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--prefix',
      'oo',
      '--session-hooks',
    ]);
    expect(r0.exitCode, r0.stdout + r0.stderr).toBe(0);
    const r = await agent.runRaw(['hook', 'session-start']);
    expect(routingBullets(r.stdout).length).toBeGreaterThan(0);
    expect(r.stdout).toContain('→ oo-plan-critique');
  });

  it('a managed repo whose block file was deleted renders routing', async () => {
    await initManaged();
    await rm(path.join(repo.path, 'AGENTS.md'), { force: true });
    await rm(path.join(repo.path, 'CLAUDE.md'), { force: true });

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(routingBullets(r.stdout).length).toBeGreaterThan(0);
    expect(r.stdout).toContain('"review my plan draft"');
  });

  it('a managed repo whose instruction file has no marker renders routing', async () => {
    await initManaged();
    await rm(path.join(repo.path, 'CLAUDE.md'), { force: true });
    await writeFile(
      path.join(repo.path, 'AGENTS.md'),
      '# Project\n\nHand-written house rules. No orcaops block here.\n',
      'utf8'
    );

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(routingBullets(r.stdout).length).toBeGreaterThan(0);
  });

  it('resolves the enabled skill set without reading the credentials file', async () => {
    await initManaged();
    // Positive control: init DOES resolve the gates, so a zero below means the
    // state loader skipped them, not that the spy is inert.
    expect(skillGateCalls.n).toBeGreaterThan(0);

    skillGateCalls.n = 0;
    const state = await readSessionStartState(repo.path);
    expect(state.kind).toBe('static');
    expect(skillGateCalls.n).toBe(0);
    // The gate being off is what keeps the cloud skills out of the resolved set.
    expect(renderSessionStartGuidance(state)).not.toContain('oo-plan-approval');
  });

  it('a resolver failure degrades to the lifecycle-only payload and still exits zero', async () => {
    const r0 = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--prefix',
      'oo',
      '--session-hooks',
    ]);
    expect(r0.exitCode, r0.stdout + r0.stderr).toBe(0);
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.workflow = { hints: { keys: ['checkpoint-cadence'], custom: [] } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const healthy = await agent.runRaw(['hook', 'session-start']);
    expect(routingBullets(healthy.stdout).length).toBeGreaterThan(0);
    expect(healthy.stdout).toContain('- Use one checkpoint per coherent unit of work.');

    skillSetFault.fail = true;
    try {
      const r = await agent.runRaw(['hook', 'session-start']);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('[orcaops] This repo captures AI coding sessions');
      expect(r.stdout).toContain('`oo-capture`');
      expect(r.stdout).toContain('run tests and commit inside the window');
      expect(r.stdout).toContain('Skip capture for trivial changes');
      expect(routingBullets(r.stdout)).toEqual([]);
      expect(r.stdout).not.toContain('Use one checkpoint per coherent unit of work.');
    } finally {
      skillSetFault.fail = false;
    }
  });

  it('a marker-bearing block with no routing section renders routing', async () => {
    await initManaged();
    await rm(path.join(repo.path, 'CLAUDE.md'), { force: true });
    // A LITERAL fixture, not a render: this is the shape blocks took while the
    // read-intent section was trimmed away, and a future template change must
    // not be able to make the case unreachable by no longer producing it.
    await writeFile(
      path.join(repo.path, 'AGENTS.md'),
      [
        '# Project',
        '',
        '<!-- orcaops:start v=0.1.0 -->',
        '## Orcaops',
        '',
        'This repo uses **orcaops** to capture and evaluate AI coding sessions.',
        '',
        '**Capture lifecycle: plan → checkpoint(s) → finish.**',
        '',
        '1. Run `orcaops status --json`.',
        '',
        '**Attribution.** Pass `--invoked-by-agent <your-agent-id>`.',
        '',
        '**Skip orcaops for:** typo fixes, cosmetic single-line edits.',
        '<!-- orcaops:end -->',
        '',
      ].join('\n'),
      'utf8'
    );

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(routingBullets(r.stdout).length).toBeGreaterThan(0);
    expect(r.stdout).toContain('→ oo-plan-critique');
  });

  it('prose naming the routing heading outside the block does not suppress routing', async () => {
    await initManaged();
    await rm(path.join(repo.path, 'CLAUDE.md'), { force: true });
    await writeFile(
      path.join(repo.path, 'AGENTS.md'),
      [
        '# Project',
        '',
        '<!-- orcaops:start v=0.1.0 -->',
        '## Orcaops',
        '',
        'This repo uses **orcaops** to capture and evaluate AI coding sessions.',
        '<!-- orcaops:end -->',
        '',
        '## House notes',
        '',
        'A managed block normally carries a **Read intents → skills.** list, but',
        'ours is trimmed, so the session hook has to supply the routing itself.',
        '',
      ].join('\n'),
      'utf8'
    );

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(routingBullets(r.stdout).length).toBeGreaterThan(0);
    expect(r.stdout).toContain('→ oo-plan-critique');
  });

  it('renders routing for an agent whose own instruction file carries no block', async () => {
    const r0 = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--prefix',
      'oo',
      '--session-hooks',
      '--agents-md',
      '--agents',
      'claude-code,codex',
    ]);
    expect(r0.exitCode, r0.stdout + r0.stderr).toBe(0);
    // AGENTS.md is the only instruction file codex loads; CLAUDE.md keeps its
    // block, so a repository-wide predicate would call codex covered.
    const block = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    expect(block).toContain('**Read intents → skills.**');
    await rm(path.join(repo.path, 'CLAUDE.md'), { force: true });
    await writeFile(path.join(repo.path, 'CLAUDE.md'), block, 'utf8');
    await writeFile(
      path.join(repo.path, 'AGENTS.md'),
      '# Project\n\nHand-written house rules. No orcaops block here.\n',
      'utf8'
    );

    const codex = await agent.runRaw(['hook', 'session-start', '--agent', 'codex']);
    expect(codex.exitCode).toBe(0);
    const envelope = JSON.parse(codex.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(routingBullets(envelope.hookSpecificOutput.additionalContext).length).toBeGreaterThan(0);

    const claude = await agent.runRaw(['hook', 'session-start', '--agent', 'claude-code']);
    expect(claude.exitCode).toBe(0);
    expect(routingBullets(claude.stdout)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'a symlinked instruction file pointing at the block keeps the hook short',
    async () => {
      // The pre-existing CLAUDE.md is required: a fresh init produces the
      // mirror image and masks this entirely.
      await writeFile(path.join(repo.path, 'CLAUDE.md'), '# Project\n', 'utf8');
      const r0 = await agent.runRaw([
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--prefix',
        'oo',
        '--session-hooks',
        '--agents-md',
        '--agents',
        'claude-code,codex',
      ]);
      expect(r0.exitCode, r0.stdout + r0.stderr).toBe(0);
      expect((await lstat(path.join(repo.path, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
      expect(await readFile(path.join(repo.path, 'CLAUDE.md'), 'utf8')).toContain(
        '**Read intents → skills.**'
      );

      const codex = await agent.runRaw(['hook', 'session-start', '--agent', 'codex']);
      expect(codex.exitCode).toBe(0);
      const envelope = JSON.parse(codex.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(routingBullets(envelope.hookSpecificOutput.additionalContext)).toEqual([]);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'a symlinked instruction file whose target carries no block renders routing',
    async () => {
      await writeFile(path.join(repo.path, 'CLAUDE.md'), '# Project\n', 'utf8');
      const r0 = await agent.runRaw([
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--prefix',
        'oo',
        '--session-hooks',
        '--agents-md',
        '--agents',
        'claude-code,codex',
      ]);
      expect(r0.exitCode, r0.stdout + r0.stderr).toBe(0);
      expect((await lstat(path.join(repo.path, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
      await writeFile(
        path.join(repo.path, 'CLAUDE.md'),
        '# Project\n\nHand-written house rules. No orcaops block here.\n',
        'utf8'
      );

      const codex = await agent.runRaw(['hook', 'session-start', '--agent', 'codex']);
      expect(codex.exitCode).toBe(0);
      const envelope = JSON.parse(codex.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(routingBullets(envelope.hookSpecificOutput.additionalContext).length).toBeGreaterThan(
        0
      );
    }
  );

  it.skipIf(process.platform === 'win32')(
    'a dangling instruction symlink renders routing',
    async () => {
      await writeFile(path.join(repo.path, 'CLAUDE.md'), '# Project\n', 'utf8');
      const r0 = await agent.runRaw([
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
        '--prefix',
        'oo',
        '--session-hooks',
        '--agents-md',
        '--agents',
        'claude-code,codex',
      ]);
      expect(r0.exitCode, r0.stdout + r0.stderr).toBe(0);
      await rm(path.join(repo.path, 'CLAUDE.md'), { force: true });

      const codex = await agent.runRaw(['hook', 'session-start', '--agent', 'codex']);
      expect(codex.exitCode).toBe(0);
      const envelope = JSON.parse(codex.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(routingBullets(envelope.hookSpecificOutput.additionalContext).length).toBeGreaterThan(
        0
      );
    }
  );

  it('renders routing for an agent outside the install set that loads no block', async () => {
    const r0 = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--prefix',
      'oo',
      '--session-hooks',
      '--agents-md',
      '--agents',
      'claude-code,codex',
    ]);
    expect(r0.exitCode, r0.stdout + r0.stderr).toBe(0);
    // Cursor loads AGENTS.md and never CLAUDE.md, install set or not.
    const block = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    await rm(path.join(repo.path, 'CLAUDE.md'), { force: true });
    await writeFile(path.join(repo.path, 'CLAUDE.md'), block, 'utf8');
    await rm(path.join(repo.path, 'AGENTS.md'), { force: true });

    const cursor = await agent.runRaw(['hook', 'session-start', '--agent', 'cursor']);
    expect(cursor.exitCode).toBe(0);
    const payload = (JSON.parse(cursor.stdout) as { additional_context: string })
      .additional_context;
    expect(routingBullets(payload).length).toBeGreaterThan(0);
    expect(payload).toContain('→ oo-plan-critique');
  });
});

describe('renderSessionStartGuidance (pure)', () => {
  it('uninitialized → null (the hook emits nothing)', () => {
    expect(renderSessionStartGuidance({ kind: 'uninitialized' })).toBeNull();
  });

  it('static → fixed prefix-aware nudge pointing at status for thread state', () => {
    const text = renderSessionStartGuidance(mkStatic());
    expect(text).toContain('[orcaops] This repo captures AI coding sessions');
    expect(text).toContain('orcaops status --json');
    expect(text).toContain('`oo-capture`');
    expect(text).toContain('close the thread: oo-finish');
    expect(text).not.toContain('oo-pre-pr');
    // State-aware marker phrases, exactly (see the CLI-level twin above).
    expect(text).not.toContain('no capture thread is in flight');
    expect(text).not.toContain('Capture thread ');
  });

  it('every state-aware closing branch points directly at finish', () => {
    for (const state of everyPayloadBranch()) {
      const text = renderSessionStartGuidance(state);
      expect(text).toContain('oo-finish');
      expect(text).not.toContain('oo-pre-pr');
      expect(text).not.toContain('oo-summary');
    }
  });

  it('renders routing on every branch when no managed block carries it', () => {
    for (const state of everyPayloadBranch()) {
      const text = renderSessionStartGuidance(state) as string;
      // digest is one of the built-in read intents, so a hooks-only payload
      // always carries it — the phrasing is the whole point of the surface.
      expect(text).toContain('oo-digest');
      expect(text).toContain('"review my plan draft"');
      expect(text).toContain('→ oo-plan-critique');
    }
  });

  it('renders no routing on any branch when a managed block carries it', () => {
    for (const state of everyPayloadBranch({ hooksOnly: false })) {
      const text = renderSessionStartGuidance(state) as string;
      expect(text).not.toContain('oo-digest');
      expect(text).not.toContain('oo-plan-critique');
      expect(text).toContain('oo-finish');
    }
  });

  it('routing bullets carry the resolver lead verbatim, unquoted by the formatter', () => {
    const text = renderSessionStartGuidance(mkStatic()) as string;
    expect(text).toContain(
      '- "where was I?", "pick up where we left off", "continue artifact <id> here" → oo-resume'
    );
    expect(text).not.toContain('"\'');
    expect(text).not.toMatch(/- ""/);
  });

  it('routing bullets keep the clause that follows the arrow', () => {
    const text = renderSessionStartGuidance(mkStatic()) as string;
    // Truncating at the ref would tell the agent to invoke this skill, the
    // exact opposite of what the entry says.
    expect(text).toContain(
      'recommend the human run /oo-author-evaluator rather than invoking it yourself'
    );
    expect(text).toContain('→ oo-plan-critique, before work starts');
    expect(text).toContain('oo-seed-discovery, and whenever normal work exposes a history gap');
  });

  it('the commit clause follows workflow.commit_inside_window', () => {
    const on = renderSessionStartGuidance(mkStatic()) as string;
    expect(on).toContain('run tests and commit inside the window');

    const off = renderSessionStartGuidance(
      mkStatic({ content: bootstrapContent({ commitInsideWindow: false }) })
    ) as string;
    expect(off).toContain('open before edits; close with what finished');
    expect(off).not.toContain('commit inside the window');
  });

  it('carries the attribution rule on every branch, on one line', () => {
    for (const state of [mkStatic(), ...everyPayloadBranch()]) {
      const text = renderSessionStartGuidance(state) as string;
      const carrying = text.split('\n').filter((l) => l.includes('--invoked-by-agent'));
      expect(carrying).toHaveLength(1);
      expect(carrying[0]).toContain('`--invoked-by-agent <your-agent-id>` on every');
      expect(carrying[0]).toContain('falls back to `ORCAOPS_INVOKED_BY_AGENT`');
      expect(text.indexOf('--invoked-by-agent')).toBeLessThan(
        text.indexOf('Skip capture for trivial changes')
      );
    }
  });

  it('resolved hints render as bullets after the skip rule', () => {
    const text = renderSessionStartGuidance(
      mkStatic({
        content: bootstrapContent({
          hints: { keys: ['checkpoint-cadence'], custom: ['Ask first.'] },
        }),
      })
    ) as string;
    expect(text).toContain('- Use one checkpoint per coherent unit of work.');
    expect(text).toContain('- Ask first.');
    expect(text.indexOf('Skip capture for trivial changes')).toBeLessThan(
      text.indexOf('- Ask first.')
    );
  });

  it('suppressed routing drops exactly the named skill', () => {
    const text = renderSessionStartGuidance(
      mkStatic({ content: bootstrapContent({ suppressedRouting: ['plan-critique'] }) })
    ) as string;
    expect(text).not.toContain('oo-plan-critique');
    expect(text).toContain('oo-digest');
  });

  it('stale open checkpoint (>24h idle) gets the left-over wording', () => {
    const text = renderSessionStartGuidance(
      mkReady({
        prefix: 'orcaops',
        content: bootstrapContent({ prefix: 'orcaops' }),
        inFlight: [
          {
            id: '019f0000-0000-7000-8000-000000000001',
            label: 'stale fixture',
            state: 'in_progress',
            checkpointCount: 2,
            openCheckpoints: [{ n: 3, openedAt: '2026-01-01T00:00:00.000Z', idleHours: 30 }],
          },
        ],
      })
    );
    expect(text).toContain('Checkpoint 3 is OPEN (opened 30h ago)');
    expect(text).toContain('likely left over from a previous session');
  });

  it('multiple in-flight threads → explicit artifact_id instruction', () => {
    const mk = (id: string, label: string) => ({
      id,
      label,
      state: 'in_progress',
      checkpointCount: 0,
      openCheckpoints: [],
    });
    const text = renderSessionStartGuidance(
      mkReady({ inFlight: [mk('a-1', 'first'), mk('b-2', 'second')] })
    );
    expect(text).toContain('2 capture threads are in flight');
    expect(text).toContain('a-1');
    expect(text).toContain('b-2');
    expect(text).toContain('artifact_id');
    expect(text).toContain('`oo-checkpoint`');
  });

  it('invalid checkpoint timestamps omit age wording', () => {
    const text = renderSessionStartGuidance(
      mkReady({
        prefix: 'orcaops',
        content: bootstrapContent({ prefix: 'orcaops' }),
        inFlight: [
          {
            id: '019f0000-0000-7000-8000-000000000001',
            label: 'invalid timestamp fixture',
            state: 'in_progress',
            checkpointCount: 1,
            openCheckpoints: [{ n: 1, openedAt: 'not-a-date', idleHours: null }],
          },
        ],
      })
    );
    expect(text).toContain('Checkpoint 1 is OPEN.');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('opened ');
  });
});

/**
 * Cloud content must stay out of the hook payload for the same reason it stays
 * out of the committed block: it steers an agent on a credential-less machine
 * toward a product it cannot reach. The hook only grew a reason to be scanned
 * when it started carrying routing.
 */
describe('the hook payload carries no cloud steering', () => {
  const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const CLOUD_REFERENCE = new RegExp(
    [
      `orcaops (?:${CLOUD_SURFACE_COMMANDS.map(esc).join('|')})\\b`,
      ...SKILL_TEMPLATES.filter((t) => (t.requires ?? []).includes('cloud')).map(
        (t) => `\\borcaops-${esc(t.id)}\\b`
      ),
      esc(CLOUD_PIN_SCHEME),
    ].join('|'),
    'i'
  );

  it('flags a cloud reference, so the scan below is not vacuous', () => {
    expect('run `orcaops login`').toMatch(CLOUD_REFERENCE);
    expect('the orcaops-plan-approval skill').toMatch(CLOUD_REFERENCE);
  });

  it('every payload branch is clean under the default prefix', () => {
    const content = bootstrapContent({ prefix: 'orcaops', enabledSkills: SKILL_TEMPLATES });
    for (const state of [
      mkStatic({ prefix: 'orcaops', content }),
      ...everyPayloadBranch({ prefix: 'orcaops', content }),
    ]) {
      expect(renderSessionStartGuidance(state)).not.toMatch(CLOUD_REFERENCE);
    }
  });

  it('is clean even with the cloud-gated skills forced into the enabled set', () => {
    // The hook resolves its set with the cloud gate hardcoded off; forcing the
    // gated templates in proves the containment does not depend on that.
    const content = bootstrapContent({ prefix: 'orcaops', enabledSkills: SKILL_TEMPLATES });
    expect(renderSessionStartGuidance(mkStatic({ prefix: 'orcaops', content }))).not.toMatch(
      CLOUD_REFERENCE
    );
  });
});

describe('orcaops hook session-start — shared personal config across worktrees', () => {
  let main: TempRepo;
  let linked: TempRepo;
  let mainAgent: ReturnType<typeof makeAgent>;
  let globalRoot: string;
  let dataRoot: string;

  beforeEach(async () => {
    main = await createTempRepo({ initialBranch: 'main' });
    linked = await createLinkedWorktree(main.path, { branch: 'feature-hooks' });
    globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-global-'));
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-data-'));
    mainAgent = makeAgent({
      cwd: main.path,
      env: { ORCAOPS_GLOBAL_ROOT: globalRoot, ORCAOPS_DATA_DIR: dataRoot },
    });
  });
  afterEach(async () => {
    await linked.cleanup();
    await main.cleanup();
    await rm(globalRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  });

  const hookIn = (cwd: string, ...extra: string[]) =>
    makeAgent({
      cwd,
      env: { ORCAOPS_GLOBAL_ROOT: globalRoot, ORCAOPS_DATA_DIR: dataRoot },
    }).runRaw(['hook', 'session-start', '--agent', 'claude-code', '--user', ...extra]);

  it('emits exactly once from the main root, a main subdirectory, and a linked worktree', async () => {
    await mainAgent.runRaw(['init', '--personal', '--session-hooks', '--no-llm', '--json']);
    const sub = path.join(main.path, 'pkg', 'src');
    await mkdir(sub, { recursive: true });

    for (const cwd of [main.path, sub, linked.path]) {
      const r = await hookIn(cwd);
      expect(r.exitCode, cwd).toBe(0);
      const nudges = r.stdout.split('[orcaops] This repo captures AI coding sessions').length - 1;
      expect(nudges, cwd).toBe(1);
    }
    // Static hooks read config only: no data directory appeared anywhere.
    await expect(access(path.join(linked.path, '.orcaops'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(path.join(main.path, '.orcaops'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stays silent with hooks disabled, in an unrelated repo, and with an unusable config', async () => {
    await mainAgent.runRaw(['init', '--personal', '--no-llm', '--json']);
    expect((await hookIn(linked.path)).stdout).toBe('');

    await mainAgent.runRaw(['update', '--session-hooks', '--json']);
    expect((await hookIn(linked.path)).stdout).not.toBe('');

    const unrelated = await createTempRepo({ initialBranch: 'main' });
    try {
      expect((await hookIn(unrelated.path)).stdout).toBe('');
    } finally {
      await unrelated.cleanup();
    }

    // A worktree config claiming personal is refused by the resolver; the
    // hook degrades to silence rather than a banner.
    await mkdir(path.join(linked.path, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(linked.path, '.orcaops', 'config.json'),
      JSON.stringify({
        schema_version: 6,
        install: { agents: ['claude-code'], scope: 'personal' },
      }),
      'utf8'
    );
    const r = await hookIn(linked.path);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('state-aware payload reads an empty sibling without creating worktree state', async () => {
    await mainAgent.runRaw([
      'init',
      '--personal',
      '--session-hooks',
      '--session-hook-payload',
      'state-aware',
      '--no-llm',
      '--json',
    ]);
    const r = await hookIn(linked.path);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no capture thread is in flight on branch `feature-hooks`');
    await expect(access(path.join(linked.path, '.orcaops'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
