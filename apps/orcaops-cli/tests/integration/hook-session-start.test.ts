import Database from 'better-sqlite3';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { canonicalSessionHookCommand, settingsSpecs } from '../../src/lib/session-hooks.js';
import { renderSessionStartGuidance } from '../../src/lib/session-start-guidance.js';
import type { SessionStartState } from '../../src/lib/session-start-state.js';
import { makeAgent } from '../support/test-agent.js';

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

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
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
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    // Archive-enabled init materializes the cache itself; clear it so the
    // assertions below prove the HOOK performs zero store writes.
    await rm(path.dirname(dbPath), { recursive: true, force: true });
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

    // The no-store-writes guarantee: a read-only nudge must not materialize
    // the SQLite cache in a repo the user hasn't captured in.
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
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(planRes.exitCode).toBe(0);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };

    const r = await agent.runRaw(['hook', 'session-start']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(plan.artifact_id);
    expect(r.stdout).toContain('"hook fixture"');
    expect(r.stdout).toContain('open a checkpoint via the `orcaops-checkpoint` skill BEFORE');
    expect(r.stdout).toContain('close it: orcaops-finish');
    expect(r.stdout).not.toContain('orcaops-pre-pr');
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
          plan_steps: [{ text: 's1', label: 's1' }],
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

    const db = new Database(path.join(repo.path, '.orcaops', 'cache', 'orcaops.db'));
    db.prepare('UPDATE checkpoints SET opened_at = ? WHERE artifact_id = ? AND n = 1').run(
      'not-a-date',
      plan.artifact_id
    );
    db.close();
    const corruptTimestamp = await agent.runRaw(['hook', 'session-start']);
    expect(corruptTimestamp.stdout).toContain('Checkpoint 1 is OPEN.');
    expect(corruptTimestamp.stdout).not.toContain('NaN');
    expect(corruptTimestamp.stdout).not.toContain('opened ');
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
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-hook-root-'));
    const rooted = makeAgent({ cwd: outside, env: { ORCAOPS_ROOT: repo.path } });
    const fromOverride = await rooted.runRaw(['hook', 'session-start']);
    expect(fromOverride.stdout).toContain(plan.artifact_id);
    const fromFlag = await makeAgent({ cwd: outside }).runRaw([
      '--root',
      repo.path,
      'hook',
      'session-start',
    ]);
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

  it('corrupted cache DB: state-aware falls back to the static reminder; static still emits', async () => {
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
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
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
        env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_HOOK_SUPPRESS: value },
      });
      const result = await unsuppressed.runRaw(['hook', 'session-start', '--agent', 'codex']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout, `expected ${JSON.stringify(value)} to emit`).not.toBe('');
    }

    for (const value of ['1', 'true', 'yes', 'on']) {
      const suppressed = makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_DISABLE_DRAIN: '1', ORCAOPS_HOOK_SUPPRESS: value },
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

describe('renderSessionStartGuidance (pure)', () => {
  it('uninitialized → null (the hook emits nothing)', () => {
    expect(renderSessionStartGuidance({ kind: 'uninitialized' })).toBeNull();
  });

  it('static → fixed prefix-aware nudge pointing at status for thread state', () => {
    const text = renderSessionStartGuidance({ kind: 'static', prefix: 'oo' });
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
    const artifact = {
      id: '019f0000-0000-7000-8000-000000000001',
      label: 'fixture',
      state: 'in_progress',
      checkpointCount: 1,
      openCheckpoints: [],
    };
    const states: SessionStartState[] = [
      { kind: 'ready', branch: 'main', prefix: 'oo', cacheStatus: 'missing', inFlight: [] },
      { kind: 'ready', branch: 'main', prefix: 'oo', cacheStatus: 'available', inFlight: [] },
      {
        kind: 'ready',
        branch: 'main',
        prefix: 'oo',
        cacheStatus: 'available',
        inFlight: [artifact],
      },
      {
        kind: 'ready',
        branch: 'main',
        prefix: 'oo',
        cacheStatus: 'available',
        inFlight: [artifact, { ...artifact, id: '019f0000-0000-7000-8000-000000000002' }],
      },
    ];
    for (const state of states) {
      const text = renderSessionStartGuidance(state);
      expect(text).toContain('oo-finish');
      expect(text).not.toContain('oo-pre-pr');
      expect(text).not.toContain('oo-summary');
      expect(text).not.toContain('oo-digest');
    }
  });

  it('stale open checkpoint (>24h idle) gets the left-over wording', () => {
    const text = renderSessionStartGuidance({
      kind: 'ready',
      branch: 'main',
      prefix: 'orcaops',
      cacheStatus: 'available',
      inFlight: [
        {
          id: '019f0000-0000-7000-8000-000000000001',
          label: 'stale fixture',
          state: 'in_progress',
          checkpointCount: 2,
          openCheckpoints: [{ n: 3, openedAt: '2026-01-01T00:00:00.000Z', idleHours: 30 }],
        },
      ],
    });
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
    const text = renderSessionStartGuidance({
      kind: 'ready',
      branch: 'main',
      prefix: 'oo',
      cacheStatus: 'available',
      inFlight: [mk('a-1', 'first'), mk('b-2', 'second')],
    });
    expect(text).toContain('2 capture threads are in flight');
    expect(text).toContain('a-1');
    expect(text).toContain('b-2');
    expect(text).toContain('artifact_id');
    expect(text).toContain('`oo-checkpoint`');
  });

  it('invalid checkpoint timestamps omit age wording', () => {
    const text = renderSessionStartGuidance({
      kind: 'ready',
      branch: 'main',
      prefix: 'orcaops',
      cacheStatus: 'available',
      inFlight: [
        {
          id: '019f0000-0000-7000-8000-000000000001',
          label: 'invalid timestamp fixture',
          state: 'in_progress',
          checkpointCount: 1,
          openCheckpoints: [{ n: 1, openedAt: 'not-a-date', idleHours: null }],
        },
      ],
    });
    expect(text).toContain('Checkpoint 1 is OPEN.');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('opened ');
  });
});
