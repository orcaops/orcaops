import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { canonicalSessionHookCommand } from '../../src/lib/session-hooks.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * Session-hook settings installation (`init --session-hooks` / `update
 * --no-session-hooks`). The ownership model under test: exact canonical
 * entries are managed inside co-owned settings files; customized
 * commands, user hooks, and foreign keys are preserved.
 */

interface SessionHookJson {
  session_hooks: Array<{ agent: string; path: string; action: string }>;
  restart_required: boolean;
  warnings: string[];
}

const SETTINGS_PATHS = ['.claude/settings.json', '.cursor/hooks.json'];

describe('init --session-hooks settings installation', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function readJson(rel: string): Promise<unknown> {
    return JSON.parse(await readFile(path.join(repo.path, rel), 'utf8'));
  }

  it('creates the settings-json files; codex (machine-config) is never written', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,codex,cursor',
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    // Codex has NO project surface (machine-config only) — no plan row at
    // all, not even a skipped-* one.
    expect(out.session_hooks).toEqual([
      { agent: 'claude-code', path: '.claude/settings.json', action: 'created' },
      { agent: 'cursor', path: '.cursor/hooks.json', action: 'created' },
    ]);
    expect(out.restart_required).toBe(true);

    expect(await readJson('.claude/settings.json')).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume|clear',
            hooks: [
              {
                type: 'command',
                command: canonicalSessionHookCommand('claude-code'),
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
    await expect(access(path.join(repo.path, '.codex/hooks.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readJson('.cursor/hooks.json')).toEqual({
      version: 1,
      hooks: {
        sessionStart: [
          { type: 'command', command: canonicalSessionHookCommand('cursor'), timeout: 10 },
        ],
      },
    });
  });

  it('hedges restart guidance for a Cursor-only hook change', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'cursor',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      'Changed agents may require a restart; Cursor reloads automatically.'
    );
    expect(res.stdout).not.toContain('Restart your agent session');
  });

  it('hedges mixed-agent restart guidance without expanding the JSON schema', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,cursor',
    ]);

    const human = await agent.runRaw(['update', '--no-session-hooks']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('Session hooks (2):');
    expect(human.stdout).toContain(
      'Changed agents may require a restart; Cursor reloads automatically.'
    );

    const json = JSON.parse(
      (await agent.runRaw(['update', '--json', '--session-hooks'])).stdout
    ) as Record<string, unknown>;
    expect(json.restart_required).toBe(true);
    expect(Object.keys(json).filter((key) => key.startsWith('restart'))).toEqual([
      'restart_required',
    ]);
  });

  it('codex stays session-hook CAPABLE: enabling with a codex-only set gates emission, writes no files', async () => {
    // The machine-config row keeps codex in sessionHookCapableAgents — a
    // codex-only repo must still be able to enable session hooks (the
    // machine-level registration is silenced everywhere the repo never
    // opted in), while the settings planner writes nothing.
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'codex',
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([]);
    expect(out.restart_required).toBe(false);
    await expect(access(path.join(repo.path, '.codex/hooks.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { session_hooks: { enabled: boolean } };
    expect(cfg.session_hooks.enabled).toBe(true);

    // Emission works: the codex hook command emits the envelope in this repo.
    const hook = await agent.runRaw(['hook', 'session-start', '--agent', 'codex', '--user']);
    expect(hook.exitCode).toBe(0);
    expect(hook.stdout).toContain('"hookSpecificOutput"');
    expect(hook.stdout).toContain('"additionalContext"');
  });

  it('merges into an existing settings file preserving foreign keys and user hooks in mixed groups', async () => {
    await mkdir(path.join(repo.path, '.claude'), { recursive: true });
    const preexisting = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-hook' }] },
        ],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
      },
    };
    await writeFile(
      path.join(repo.path, '.claude/settings.json'),
      `${JSON.stringify(preexisting, null, 2)}\n`,
      'utf8'
    );

    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([
      { agent: 'claude-code', path: '.claude/settings.json', action: 'updated' },
    ]);
    expect(out.restart_required).toBe(true);

    const merged = (await readJson('.claude/settings.json')) as typeof preexisting & {
      hooks: { SessionStart: unknown[] };
    };
    // Foreign keys and foreign hook groups are preserved verbatim.
    expect(merged.permissions).toEqual(preexisting.permissions);
    expect(merged.hooks.PreToolUse).toEqual(preexisting.hooks.PreToolUse);
    expect(merged.hooks.SessionStart[0]).toEqual(preexisting.hooks.SessionStart[0]);
    // The canonical orcaops group is appended after the user's.
    expect(merged.hooks.SessionStart[1]).toEqual({
      matcher: 'startup|resume|clear',
      hooks: [
        { type: 'command', command: canonicalSessionHookCommand('claude-code'), timeout: 10 },
      ],
    });
  });

  it('is idempotent: a second init reports all entries unchanged with no restart', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,codex,cursor',
    ]);
    const before = await Promise.all(
      SETTINGS_PATHS.map((p) => readFile(path.join(repo.path, p), 'utf8'))
    );
    const res = await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--force']);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks.map((h) => h.action)).toEqual(['unchanged', 'unchanged']);
    expect(out.restart_required).toBe(false);
    const after = await Promise.all(
      SETTINGS_PATHS.map((p) => readFile(path.join(repo.path, p), 'utf8'))
    );
    expect(after).toEqual(before);
  });

  it('a semantically-current file with custom formatting is left byte-identical', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'cursor',
    ]);
    // Reformat the file (4-space indent, no trailing newline) without
    // changing its structure — the planner must not churn it back.
    const rel = '.cursor/hooks.json';
    const parsed = await readJson(rel);
    const funky = JSON.stringify(parsed, null, 4);
    await writeFile(path.join(repo.path, rel), funky, 'utf8');

    const res = await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--force']);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([{ agent: 'cursor', path: rel, action: 'unchanged' }]);
    expect(await readFile(path.join(repo.path, rel), 'utf8')).toBe(funky);
  });

  it('a user group appended AFTER ours reconciles unchanged — no reorder churn', async () => {
    // Position is user data: our entry is kept in place when it already
    // matches the canonical form, so a user group after ours must not be
    // hopped over on every reconcile (that would rewrite the file once and
    // report a phantom `updated` + restart).
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,cursor',
    ]);
    const claudeRel = '.claude/settings.json';
    const claudeDoc = (await readJson(claudeRel)) as { hooks: { SessionStart: unknown[] } };
    claudeDoc.hooks.SessionStart.push({
      matcher: 'startup',
      hooks: [{ type: 'command', command: 'echo user-after' }],
    });
    const claudeRaw = `${JSON.stringify(claudeDoc, null, 2)}\n`;
    await writeFile(path.join(repo.path, claudeRel), claudeRaw, 'utf8');

    const cursorRel = '.cursor/hooks.json';
    const cursorDoc = (await readJson(cursorRel)) as { hooks: { sessionStart: unknown[] } };
    cursorDoc.hooks.sessionStart.push({ type: 'command', command: 'echo user-after-flat' });
    const cursorRaw = `${JSON.stringify(cursorDoc, null, 2)}\n`;
    await writeFile(path.join(repo.path, cursorRel), cursorRaw, 'utf8');

    const res = await agent.runRaw(['update', '--json']);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks.map((h) => [h.path, h.action])).toEqual([
      [claudeRel, 'unchanged'],
      [cursorRel, 'unchanged'],
    ]);
    expect(out.restart_required).toBe(false);
    expect(await readFile(path.join(repo.path, claudeRel), 'utf8')).toBe(claudeRaw);
    expect(await readFile(path.join(repo.path, cursorRel), 'utf8')).toBe(cursorRaw);
  });

  it('a duplicated ours group collapses to the first, kept in its original position', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    const rel = '.claude/settings.json';
    const doc = (await readJson(rel)) as { hooks: { SessionStart: unknown[] } };
    const ours = doc.hooks.SessionStart[0];
    const userGroup = {
      matcher: 'startup',
      hooks: [{ type: 'command', command: 'echo user-between' }],
    };
    doc.hooks.SessionStart = [ours, userGroup, structuredClone(ours)];
    await writeFile(path.join(repo.path, rel), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const res = await agent.runRaw(['update', '--json']);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([{ agent: 'claude-code', path: rel, action: 'updated' }]);
    const after = (await readJson(rel)) as { hooks: { SessionStart: unknown[] } };
    expect(after.hooks.SessionStart).toEqual([ours, userGroup]);
  });

  it('stripping preserves a file whose skeleton values were user-modified', async () => {
    // isSemanticallyEmpty compares seed VALUES, not just key names: cursor's
    // `version` bumped to 2 is user data, so the strip rewrites in place
    // instead of deleting the file.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'cursor',
    ]);
    const rel = '.cursor/hooks.json';
    const doc = (await readJson(rel)) as { version: number };
    doc.version = 2;
    await writeFile(path.join(repo.path, rel), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const res = await agent.runRaw(['update', '--json', '--no-session-hooks']);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([{ agent: 'cursor', path: rel, action: 'removed' }]);
    expect(await readJson(rel)).toEqual({ version: 2 });
  });

  it('invalid JSON is preserved untouched with a warning', async () => {
    await mkdir(path.join(repo.path, '.cursor'), { recursive: true });
    const garbage = '{ this is not json\n';
    await writeFile(path.join(repo.path, '.cursor/hooks.json'), garbage, 'utf8');

    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'cursor',
    ]);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([
      { agent: 'cursor', path: '.cursor/hooks.json', action: 'preserved-invalid-json' },
    ]);
    expect(out.restart_required).toBe(false);
    expect(out.warnings.some((w) => w.includes('.cursor/hooks.json'))).toBe(true);
    expect(await readFile(path.join(repo.path, '.cursor/hooks.json'), 'utf8')).toBe(garbage);
  });

  it('an unexpected hooks shape is preserved untouched with a warning', async () => {
    await mkdir(path.join(repo.path, '.claude'), { recursive: true });
    const odd = `${JSON.stringify({ hooks: 'not-an-object' }, null, 2)}\n`;
    await writeFile(path.join(repo.path, '.claude/settings.json'), odd, 'utf8');
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks[0].action).toBe('preserved-invalid-json');
    expect(await readFile(path.join(repo.path, '.claude/settings.json'), 'utf8')).toBe(odd);
  });

  it('update --no-session-hooks strips entries: pure-ours files deleted, mixed files keep user content', async () => {
    // Seed a user hook so .claude/settings.json becomes a MIXED file.
    await mkdir(path.join(repo.path, '.claude'), { recursive: true });
    await writeFile(
      path.join(repo.path, '.claude/settings.json'),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-hook' }] },
            ],
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,codex,cursor',
    ]);

    const res = await agent.runRaw(['update', '--json', '--no-session-hooks']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks.map((h) => [h.path, h.action])).toEqual([
      ['.claude/settings.json', 'removed'],
      ['.cursor/hooks.json', 'removed'],
    ]);
    expect(out.restart_required).toBe(true);

    // Pure-ours files are deleted outright (no `{}` husks).
    await expect(access(path.join(repo.path, '.cursor/hooks.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // The mixed file survives with ONLY the user's hook.
    const claude = (await readJson('.claude/settings.json')) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(claude.hooks.SessionStart).toEqual([
      { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-hook' }] },
    ]);
    expect(JSON.stringify(claude)).not.toContain('orcaops hook session-start');

    // The toggle persisted.
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { session_hooks: { enabled: boolean } };
    expect(cfg.session_hooks.enabled).toBe(false);
  });

  it('a user hook appended INSIDE the orcaops group survives a strip (mixed group)', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    // Simulate a user editing our group in place: append their own hook to it.
    const rel = '.claude/settings.json';
    const doc = (await readJson(rel)) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: unknown[] }> };
    };
    doc.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'echo user-inside' });
    await writeFile(path.join(repo.path, rel), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const res = await agent.runRaw(['update', '--json', '--no-session-hooks']);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([{ agent: 'claude-code', path: rel, action: 'removed' }]);
    // The group survives with ONLY the user's inner hook; ours is stripped.
    const after = (await readJson(rel)) as { hooks: { SessionStart: unknown[] } };
    expect(after.hooks.SessionStart).toEqual([
      {
        matcher: 'startup|resume|clear',
        hooks: [{ type: 'command', command: 'echo user-inside' }],
      },
    ]);
  });

  it('narrowing the install set strips the departed agent’s entry on update', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,cursor',
    ]);
    // Narrowing the set reconciles immediately: the re-init itself strips
    // cursor's now-undesired entry (same rule init/update/doctor --fix share).
    const narrow = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--force',
      '--agents',
      'claude-code',
    ]);
    const narrowOut = JSON.parse(narrow.stdout) as SessionHookJson;
    expect(narrowOut.session_hooks).toEqual(
      expect.arrayContaining([
        { agent: 'claude-code', path: '.claude/settings.json', action: 'unchanged' },
        { agent: 'cursor', path: '.cursor/hooks.json', action: 'removed' },
      ])
    );
    await expect(access(path.join(repo.path, '.cursor/hooks.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // A follow-up update finds a clean state: nothing to strip, claude current.
    const res = await agent.runRaw(['update', '--json']);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([
      { agent: 'claude-code', path: '.claude/settings.json', action: 'unchanged' },
    ]);
  });

  it('--dry-run previews the session-hook actions without writing anything', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--dry-run',
      '--session-hooks',
      '--agents',
      'claude-code,codex,cursor',
    ]);
    const out = JSON.parse(res.stdout) as SessionHookJson & { dry_run: boolean };
    expect(out.dry_run).toBe(true);
    expect(out.session_hooks.map((h) => h.action)).toEqual(['created', 'created']);
    expect(out.restart_required).toBe(true);
    for (const rel of SETTINGS_PATHS) {
      await expect(access(path.join(repo.path, rel))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('opencode gets a generated stamped plugin in the manifest; settings files stay out of it', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,opencode',
    ]);
    const pluginRel = '.opencode/plugins/orcaops-session-context.js';
    const plugin = await readFile(path.join(repo.path, pluginRel), 'utf8');
    expect(plugin.startsWith('/* generatedBy: "orcaops@')).toBe(true);
    expect(plugin).toMatch(/\n {2}contentHash: "[0-9a-f]{12}" \*\//);
    expect(plugin).toContain('orcaops hook session-start --agent opencode');

    // The plugin is a normal generated-file manifest entry (prune/uninstall
    // coverage for free); the co-owned settings files are deliberately NOT
    // manifest entries (git-hooks-style out-of-band ownership).
    const manifest = (await readJson('.orcaops/install.json')) as {
      entries: Array<{ kind: string; path: string }>;
    };
    expect(manifest.entries.some((e) => e.kind === 'generated-file' && e.path === pluginRel)).toBe(
      true
    );
    expect(
      manifest.entries.every(
        (e) => !e.path.endsWith('settings.json') && !e.path.endsWith('hooks.json')
      )
    ).toBe(true);
  });

  it('disabling via update prunes the plugin hash-guarded; a user-edited plugin is preserved', async () => {
    const pluginRel = '.opencode/plugins/orcaops-session-context.js';
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'opencode',
    ]);

    // Pristine plugin → pruned on disable.
    const res = await agent.runRaw(['update', '--json', '--no-session-hooks']);
    const out = JSON.parse(res.stdout) as { pruned: string[] };
    expect(out.pruned).toContain(pluginRel);
    await expect(access(path.join(repo.path, pluginRel))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // User-edited plugin → preserved by the hash guard.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--force',
      '--session-hooks',
      '--agents',
      'opencode',
    ]);
    const abs = path.join(repo.path, pluginRel);
    await writeFile(abs, `${await readFile(abs, 'utf8')}\n// my local tweak\n`, 'utf8');
    const res2 = await agent.runRaw(['update', '--json', '--no-session-hooks']);
    const out2 = JSON.parse(res2.stdout) as {
      pruned: string[];
      preserved_orphans: Array<{ path: string; reason: string }>;
    };
    expect(out2.pruned).not.toContain(pluginRel);
    expect(out2.preserved_orphans.some((p) => p.path === pluginRel)).toBe(true);
    await expect(access(abs)).resolves.toBeUndefined();
  });

  it('generated_files ignore mode gitignores the plugin glob', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'opencode',
      '--generated-files',
      'ignore',
    ]);
    const gitignore = await readFile(path.join(repo.path, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.opencode/plugins/orcaops-*.js');
  });

  it('doctor session-hooks: pass when disabled+clean and when enabled+current', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    let res = await agent.runRaw(['doctor', '--json']);
    let check = (
      JSON.parse(res.stdout) as { checks: Array<{ name: string; status: string; summary: string }> }
    ).checks.find((c) => c.name === 'session-hooks');
    expect(check?.status).toBe('pass');
    expect(check?.summary).toContain('disabled');

    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--force',
      '--session-hooks',
      '--agents',
      'claude-code,opencode',
    ]);
    res = await agent.runRaw(['doctor', '--json']);
    check = (
      JSON.parse(res.stdout) as { checks: Array<{ name: string; status: string; summary: string }> }
    ).checks.find((c) => c.name === 'session-hooks');
    expect(check?.status).toBe('pass');
    // claude settings entry + opencode plugin = 2 current surfaces.
    expect(check?.summary).toBe('2 session-hook surface(s) current');
  });

  it('preserves a customized command and adds the canonical entry beside it', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    const rel = '.claude/settings.json';
    const abs = path.join(repo.path, rel);
    const current = canonicalSessionHookCommand('claude-code');
    const wrapped = 'env TEAM_HOOK=1 orcaops hook session-start --agent claude-code';
    const customized = (await readFile(abs, 'utf8')).replace(current, wrapped);
    await writeFile(abs, customized, 'utf8');

    const machineWithCustomizedProjectEntry = await agent.runRaw([
      'hook',
      'session-start',
      '--agent',
      'claude-code',
      '--user',
    ]);
    expect(machineWithCustomizedProjectEntry.stdout).not.toBe('');

    const updated = await agent.runRaw(['update', '--json']);
    const out = JSON.parse(updated.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([{ agent: 'claude-code', path: rel, action: 'updated' }]);
    const after = await readFile(abs, 'utf8');
    const document = JSON.parse(after) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(document.hooks.SessionStart.map((group) => group.hooks[0].command)).toEqual([
      wrapped,
      current,
    ]);
    expect(after).toContain(wrapped);

    const doctor = await agent.runRaw(['doctor', '--json']);
    const doctorCheck = (
      JSON.parse(doctor.stdout) as {
        checks: Array<{ name: string; status: string; details?: string[] }>;
      }
    ).checks.find((candidate) => candidate.name === 'session-hooks');
    expect(doctorCheck?.status).toBe('pass');
    expect((doctorCheck?.details ?? []).join('\n')).toContain(
      'customized session-hook command is user-owned'
    );

    const again = await agent.runRaw(['update', '--json']);
    expect((JSON.parse(again.stdout) as SessionHookJson).session_hooks[0].action).toBe('unchanged');
    expect(await readFile(abs, 'utf8')).toBe(after);
  });

  it('doctor warns when installed entries cannot run the available CLI', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    const binDir = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-path-'));
    await symlink('/usr/bin/git', path.join(binDir, 'git'));

    const missing = makeAgent({ cwd: repo.path, env: { PATH: binDir } });
    let result = await missing.runRaw(['doctor', '--json']);
    let report = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; status: string; details?: string[] }>;
    };
    let check = report.checks.find((candidate) => candidate.name === 'session-hooks');
    expect(check?.status).toBe('warn');
    expect((check?.details ?? []).join('\n')).toContain('cannot resolve `orcaops` on PATH');

    const staleBin = path.join(binDir, 'orcaops');
    await writeFile(staleBin, '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 1\n', 'utf8');
    await chmod(staleBin, 0o755);
    result = await missing.runRaw(['doctor', '--json']);
    report = JSON.parse(result.stdout) as typeof report;
    check = report.checks.find((candidate) => candidate.name === 'session-hooks');
    expect(check?.status).toBe('warn');
    expect((check?.details ?? []).join('\n')).toContain('does not support `hook session-start`');
  });

  it('doctor reports a probe it could not finish as unverified, not as a broken CLI', async () => {
    // A busy machine must not be told its install is broken: an unfinished
    // probe is an absence of evidence, and the remedy it used to print
    // ("upgrade the CLI") would have been wrong.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    const binDir = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-hang-'));
    await symlink('/usr/bin/git', path.join(binDir, 'git'));
    const hangingBin = path.join(binDir, 'orcaops');
    // Absolute path: the stub's PATH holds only this dir, so a bare `sleep`
    // would not resolve and the stub would exit non-zero instead of hanging.
    await writeFile(hangingBin, '#!/bin/sh\n/bin/sleep 60\n', 'utf8');
    await chmod(hangingBin, 0o755);

    const slow = makeAgent({ cwd: repo.path, env: { PATH: binDir } });
    const result = await slow.runRaw(['doctor', '--json']);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; status: string; summary: string; details?: string[] }>;
    };
    const check = report.checks.find((candidate) => candidate.name === 'session-hooks');

    expect(check?.status, JSON.stringify(check)).toBe('pass');
    expect(check?.summary).toBe('1 session-hook surface(s) current');
    const details = (check?.details ?? []).join('\n');
    expect(details).toContain('could not verify');
    expect(details).not.toContain('does not support');
    expect(details).not.toContain('cannot resolve');
  }, 30_000);

  it('doctor session-hooks: warns on lingering entries when disabled (NON-lifecycle path)', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    // Flip the toggle by hand (no update run) so the entry lingers.
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
      session_hooks: { enabled: boolean };
    };
    cfg.session_hooks.enabled = false;
    await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    const check = (
      JSON.parse(res.stdout) as {
        checks: Array<{ name: string; status: string; details?: string[] }>;
      }
    ).checks.find((c) => c.name === 'session-hooks');
    expect(check?.status).toBe('warn');
    expect(check?.details?.some((d) => d.includes('lingering'))).toBe(true);
  });

  it('drift nudge surfaces stale session-hook surfaces in status --json', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,opencode',
    ]);
    // Body-change the plugin WITHOUT touching its stamp (same-version refresh
    // gap) and delete the settings entry's file.
    const pluginRel = '.opencode/plugins/orcaops-session-context.js';
    const pluginAbs = path.join(repo.path, pluginRel);
    await writeFile(
      pluginAbs,
      (await readFile(pluginAbs, 'utf8')).replace('seenSessions', 'renamedSessions'),
      'utf8'
    );
    const { rm } = await import('node:fs/promises');
    await rm(path.join(repo.path, '.claude/settings.json'));

    const res = await agent.runRaw(['status', '--json']);
    const out = JSON.parse(res.stdout) as {
      drift?: { staleSessionHooks: string[] };
    };
    expect(out.drift?.staleSessionHooks).toContain('.claude/settings.json');
    // The user-edited plugin keeps its current-generation stamp, so it stays
    // respected (classifies current) — only genuinely stale surfaces nudge.
    expect(out.drift?.staleSessionHooks).not.toContain(pluginRel);
  });

  it('keeps invalid JSON out of update drift while Doctor prescribes manual repair', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'cursor',
    ]);
    const rel = '.cursor/hooks.json';
    const settingsPath = path.join(repo.path, rel);
    const valid = await readFile(settingsPath, 'utf8');
    await writeFile(settingsPath, '{ invalid json\n', 'utf8');

    const humanStatus = await agent.runRaw(['status']);
    expect(humanStatus.stderr).not.toContain('orcaops update');
    const status = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as {
      drift?: { staleSessionHooks: string[] };
    };
    expect(status.drift).toBeUndefined();

    const doctor = JSON.parse((await agent.runRaw(['doctor', '--json'])).stdout) as {
      checks: Array<{ name: string; status: string; details?: string[] }>;
    };
    const hookCheck = doctor.checks.find((check) => check.name === 'session-hooks');
    expect(hookCheck?.status).toBe('warn');
    expect(hookCheck?.details?.join('\n')).toContain(`${rel}: unreadable (invalid JSON)`);
    expect(hookCheck?.details?.join('\n')).toContain('reconcile manually');

    await writeFile(settingsPath, valid, 'utf8');
    const repairedDoctor = JSON.parse((await agent.runRaw(['doctor', '--json'])).stdout) as {
      checks: Array<{ name: string; status: string }>;
    };
    expect(repairedDoctor.checks.find((check) => check.name === 'session-hooks')?.status).toBe(
      'pass'
    );
    const repairedStatus = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as {
      drift?: { staleSessionHooks: string[] };
    };
    expect(repairedStatus.drift).toBeUndefined();
  });

  it('uninstall strips entries manifest-lessly, preserves user hooks, and reports them', async () => {
    // Mixed file: user hook + ours.
    await mkdir(path.join(repo.path, '.claude'), { recursive: true });
    await writeFile(
      path.join(repo.path, '.claude/settings.json'),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-hook' }] },
            ],
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,codex,opencode',
    ]);
    const res = await agent.runRaw(['uninstall', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      removed: string[];
      session_hooks_removed: string[];
      session_hooks_preserved: Array<{ path: string; reason: string }>;
    };
    expect(out.session_hooks_removed).toEqual(['.claude/settings.json']);
    expect(out.session_hooks_preserved).toEqual([]);
    // The plugin is manifest-tracked → removed via step 1.
    expect(out.removed).toContain('.opencode/plugins/orcaops-session-context.js');

    // Mixed file survives with ONLY the user hook; pure-ours file is gone.
    const claude = (await readJson('.claude/settings.json')) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(claude.hooks.SessionStart).toEqual([
      { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-hook' }] },
    ]);
    await expect(access(path.join(repo.path, '.codex/hooks.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // No surviving file references the hook command.
    expect(JSON.stringify(claude)).not.toContain('orcaops hook session-start');
  });

  it('doctor finds managed entries under other event keys and uninstall strips them', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code,cursor',
    ]);

    const claudeRel = '.claude/settings.json';
    const claude = (await readJson(claudeRel)) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const claudeCurrent = structuredClone(claude.hooks.SessionStart[0]);
    const claudeBare = structuredClone(claudeCurrent);
    // A user-authored command carrying the bare invocation (no guard wrapper)
    // is NOT orcaops-owned and must survive every strip.
    claudeBare.hooks[0].command = 'orcaops hook session-start --agent claude-code';
    const claudeForeign = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo claude-foreign' }],
    };
    claude.hooks.PreToolUse = [claudeCurrent, claudeForeign, claudeBare];
    await writeFile(
      path.join(repo.path, claudeRel),
      `${JSON.stringify(claude, null, 2)}\n`,
      'utf8'
    );

    const cursorRel = '.cursor/hooks.json';
    const cursor = (await readJson(cursorRel)) as {
      hooks: Record<string, Array<{ type: string; command: string; timeout?: number }>>;
    };
    const cursorCurrent = structuredClone(cursor.hooks.sessionStart[0]);
    const cursorBare = {
      ...cursorCurrent,
      command: 'orcaops hook session-start --agent cursor',
    };
    const cursorForeign = { type: 'command', command: 'echo cursor-foreign' };
    cursor.hooks.beforeSubmitPrompt = [cursorCurrent, cursorForeign, cursorBare];
    await writeFile(
      path.join(repo.path, cursorRel),
      `${JSON.stringify(cursor, null, 2)}\n`,
      'utf8'
    );

    const doctor = await agent.runRaw(['doctor', '--json']);
    const doctorCheck = (
      JSON.parse(doctor.stdout) as {
        checks: Array<{ name: string; status: string; details?: string[] }>;
      }
    ).checks.find((candidate) => candidate.name === 'session-hooks');
    expect(doctorCheck?.status).toBe('warn');
    expect(doctorCheck?.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${claudeRel}: orcaops entry out of date`),
        expect.stringContaining(`${cursorRel}: orcaops entry out of date`),
      ])
    );

    const uninstall = await agent.runRaw(['uninstall', '--json']);
    expect(uninstall.exitCode).toBe(0);
    const out = JSON.parse(uninstall.stdout) as { session_hooks_removed: string[] };
    expect(out.session_hooks_removed).toEqual([claudeRel, cursorRel]);

    const strippedClaude = (await readJson(claudeRel)) as {
      hooks: Record<string, unknown[]>;
    };
    expect(strippedClaude.hooks).toEqual({ PreToolUse: [claudeForeign, claudeBare] });
    const strippedCursor = (await readJson(cursorRel)) as {
      version: number;
      hooks: Record<string, unknown[]>;
    };
    expect(strippedCursor).toEqual({
      version: 1,
      hooks: { beforeSubmitPrompt: [cursorForeign, cursorBare] },
    });
  });

  it('the --session-hooks tip shows on fresh init only, never on a preserving re-init', async () => {
    // A re-init means the user already answered (declined the prompt or ran
    // --no-session-hooks) — re-tipping would nag past an explicit decision.
    const first = await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('Tip: pass `--session-hooks`');
    const again = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--force']);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).not.toContain('Tip: pass `--session-hooks`');
  });

  it('non-project scope skips settings writes with skipped-scope', async () => {
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-global-'));
    const scoped = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_GLOBAL_ROOT: globalRoot },
    });
    const res = await scoped.runRaw([
      'init',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--scope',
      'global',
      '--agents',
      'claude-code',
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([
      { agent: 'claude-code', path: '.claude/settings.json', action: 'skipped-scope' },
    ]);
    expect(out.restart_required).toBe(false);
    expect(out.warnings.some((w) => w.includes('project-scope only'))).toBe(true);
    await expect(access(path.join(repo.path, '.claude/settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('session hooks under non-project scopes (strip is scope-agnostic)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-global-'));
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_GLOBAL_ROOT: globalRoot } });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('a project→global scope switch strips the installed entries; doctor reports inactive', async () => {
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--agents',
      'claude-code',
    ]);
    await expect(access(path.join(repo.path, '.claude/settings.json'))).resolves.toBeUndefined();

    // The switch itself strips the now-uninstallable entry — this was the
    // unfixable-warning gap: install is project-only, but STRIP must run
    // under every scope or doctor's lingering warning has no working remedy.
    const res = await agent.runRaw(['update', '--json', '--scope', 'global']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as SessionHookJson;
    expect(out.session_hooks).toEqual([
      { agent: 'claude-code', path: '.claude/settings.json', action: 'removed' },
    ]);
    expect(out.restart_required).toBe(true);
    await expect(access(path.join(repo.path, '.claude/settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Clean steady state: install blocked by scope, nothing to reconcile.
    const again = await agent.runRaw(['update', '--json']);
    const againOut = JSON.parse(again.stdout) as SessionHookJson;
    expect(againOut.session_hooks).toEqual([
      { agent: 'claude-code', path: '.claude/settings.json', action: 'skipped-scope' },
    ]);
    expect(againOut.warnings.some((w) => w.includes('project-scope only'))).toBe(true);

    const doc = await agent.runRaw(['doctor', '--json']);
    const check = (
      JSON.parse(doc.stdout) as { checks: Array<{ name: string; status: string; summary: string }> }
    ).checks.find((c) => c.name === 'session-hooks');
    expect(check?.status).toBe('pass');
    expect(check?.summary).toContain('inactive under scope "global"');
  });

  it('a lingering entry under global scope: drift nudges, doctor warns, doctor --fix strips', async () => {
    await agent.runRaw([
      'init',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--scope',
      'global',
      '--agents',
      'claude-code',
    ]);
    // Plant the entry by hand (e.g. carried over from a project-scope clone).
    const rel = '.claude/settings.json';
    await mkdir(path.join(repo.path, '.claude'), { recursive: true });
    await writeFile(
      path.join(repo.path, rel),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup|resume|clear',
                hooks: [
                  {
                    type: 'command',
                    command: canonicalSessionHookCommand('claude-code'),
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const status = await agent.runRaw(['status', '--json']);
    const drift = (JSON.parse(status.stdout) as { drift?: { staleSessionHooks: string[] } }).drift;
    expect(drift?.staleSessionHooks).toContain(rel);

    const doc = await agent.runRaw(['doctor', '--json']);
    const check = (
      JSON.parse(doc.stdout) as {
        checks: Array<{ name: string; status: string; details?: string[] }>;
      }
    ).checks.find((c) => c.name === 'session-hooks');
    expect(check?.status).toBe('warn');
    expect(check?.details?.some((d) => d.includes('lingering'))).toBe(true);

    // The advertised remedy actually works now: --fix (same shared planner,
    // real scope) strips the entry and the re-run check is green.
    const fix = await agent.runRaw(['doctor', '--fix', '--json']);
    const fixed = (
      JSON.parse(fix.stdout) as { checks: Array<{ name: string; status: string; summary: string }> }
    ).checks.find((c) => c.name === 'session-hooks');
    expect(fixed?.status).toBe('pass');
    expect(fixed?.summary).toContain('inactive under scope "global"');
    await expect(access(path.join(repo.path, rel))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('--session-hook-entries none: enabled persists, NO settings files, skipped-entries rows, no warning', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hooks',
      '--session-hook-entries',
      'none',
      '--agents',
      'claude-code,codex',
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      session_hooks: Array<{ action: string }>;
      restart_required: boolean;
      warnings: string[];
    };
    // Only settings-json agents report skipped-entries; codex (machine-config)
    // has no project surface to skip.
    expect(out.session_hooks.map((p) => p.action)).toEqual(['skipped-entries']);
    expect(out.restart_required).toBe(false);
    expect(out.warnings.some((w) => w.includes('project-scope only'))).toBe(false);
    await expect(access(path.join(repo.path, '.claude', 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(path.join(repo.path, '.codex', 'hooks.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as {
      session_hooks: { enabled: boolean; entries: string };
    };
    expect(cfg.session_hooks).toEqual({ enabled: true, entries: 'none' });

    const doctor = JSON.parse((await agent.runRaw(['doctor', '--json'])).stdout) as {
      checks: Array<{ name: string; status: string; summary: string }>;
    };
    const hookCheck = doctor.checks.find((check) => check.name === 'session-hooks');
    expect(hookCheck).toMatchObject({ status: 'pass' });
    expect(hookCheck?.summary).toContain('project session-hook entries intentionally disabled');

    const status = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as {
      drift?: { staleSessionHooks: string[] };
    };
    expect(status.drift).toBeUndefined();
    await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'verify entries none',
          label: 'Verify entries none',
          plan_steps: [{ text: 'keep machine-only hooks healthy', label: 'Keep hooks healthy' }],
        })
      ),
    ]);
    const resume = JSON.parse((await agent.runRaw(['resume', '--json'])).stdout) as {
      drift?: { staleSessionHooks: string[] };
    };
    expect(resume.drift).toBeUndefined();
    await expect(access(path.join(repo.path, '.claude', 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Flip back to project entries via update: files materialize.
    const upd = await agent.runRaw(['update', '--json', '--session-hook-entries', 'project']);
    expect(upd.exitCode).toBe(0);
    await expect(access(path.join(repo.path, '.claude', 'settings.json'))).resolves.toBeUndefined();
  });
});
