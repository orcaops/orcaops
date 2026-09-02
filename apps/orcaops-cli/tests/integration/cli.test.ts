import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactStore, Store } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('orcaops CLI (in-process)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns UNINITIALIZED envelope when run before init', async () => {
    const result = await agent.runRaw([
      'capture',
      'plan',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('UNINITIALIZED');
  });

  it('Zod validation surfaces a structured error with a field path', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const result = await agent.runRaw([
      'capture',
      'plan',
      '--input',
      inputFile(JSON.stringify({ task: '', plan_steps: [] })),
    ]);
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string; message: string; path?: string };
    };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBeDefined();
  });

  it('api-signature-drift fires on a removed export; acknowledge resolves the block', async () => {
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);

    // Seed the repo with a TS file containing two exported functions, commit.
    const srcDir = nodePath.join(repo.path, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      nodePath.join(srcDir, 'api.ts'),
      'export function alpha(x: number) { return x; }\n' +
        'export function beta(y: string) { return y.length; }\n',
      'utf8'
    );
    await git.add('src/api.ts');
    await git.commit('initial api', { '--allow-empty': null });

    // init + install the bundled `js` pack so api-signature-drift
    // resolves at checkpoint-close (init does not auto-install
    // packs) + capture plan (base_sha = current HEAD).
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const addPackJs = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'js',
      '--yes',
      '--json',
    ]);
    expect(addPackJs.exitCode).toBe(0);
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'remove unused beta() export',
          plan_steps: [
            { text: 'remove beta from src/api.ts', label: 's1' },
            { text: 'add tests', label: 's2' },
          ],
          touched_scope: ['api'],
        })
      ),
    ]);
    expect(planRes.exitCode).toBe(0);
    const plan = JSON.parse(planRes.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    const artifactId = plan.artifact_id;

    // Remove `beta` and commit so the diff against base_sha is real.
    await fs.writeFile(
      nodePath.join(srcDir, 'api.ts'),
      'export function alpha(x: number) { return x; }\n',
      'utf8'
    );
    await git.add('src/api.ts');
    await git.commit('remove beta', { '--allow-empty': null });

    // capture checkpoint — runs checkpoint-close evaluators including
    // api-signature-drift (deterministic, severity: block). Open + close
    // are two phases; the post-close evaluator is what fires the drift check.
    const cpOpen = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    expect(cpOpen.exitCode).toBe(0);
    const cpRes = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          n: 1,
          summary: 'removed beta()',
          files_changed: ['src/api.ts'],
        })
      ),
    ]);
    expect(cpRes.exitCode).toBe(0);
    const cp = JSON.parse(cpRes.stdout) as {
      ok: boolean;
      blocking: boolean;
      evaluator_results: Array<{
        evaluator_ref: string;
        severity: string;
        run_status: string;
        verdict: string | null;
      }>;
    };
    expect(cp.ok).toBe(true);
    expect(cp.blocking).toBe(true);
    const drift = cp.evaluator_results.find((r) => r.evaluator_ref === 'js/api-signature-drift');
    expect(drift).toBeDefined();
    expect(drift?.severity).toBe('block');
    expect(drift?.run_status).toBe('completed');
    expect(drift?.verdict).toBe('violation');

    // Acknowledge the block — js/api-signature-drift opts into ack
    // via resolution.acknowledge.enabled (label
    // acknowledge_breaking_change).
    const ackRes = await agent.runRaw([
      'block',
      'acknowledge',
      '--artifact',
      artifactId,
      '--evaluator',
      'js/api-signature-drift',
      '--reason',
      'beta() was unused per grep; intentional removal',
    ]);
    expect(ackRes.exitCode).toBe(0);
    const ack = JSON.parse(ackRes.stdout) as {
      ok: boolean;
      action: string;
      acknowledged_at: string;
    };
    expect(ack.ok).toBe(true);
    expect(ack.action).toBe('acknowledged');
    expect(ack.acknowledged_at).toBeDefined();

    // The materialized projection shows the violation run with a
    // disposition of 'acknowledged' (synthesized from the paired
    // disposition event).
    const showRes = await agent.runRaw(['show', artifactId, '--json']);
    expect(showRes.exitCode).toBe(0);
    const show = JSON.parse(showRes.stdout) as {
      artifact: {
        evaluator_log: {
          runs: Array<{
            evaluator_ref: string;
            verdict: string | null;
            disposition: string | null;
          }>;
          dispositions: Array<{ evaluator_ref: string; disposition: string }>;
        };
      };
    };
    const driftRun = show.artifact.evaluator_log.runs.find(
      (r) => r.evaluator_ref === 'js/api-signature-drift'
    );
    expect(driftRun?.verdict).toBe('violation');
    expect(driftRun?.disposition).toBe('acknowledged');
    expect(
      show.artifact.evaluator_log.dispositions.some(
        (d) => d.evaluator_ref === 'js/api-signature-drift' && d.disposition === 'acknowledged'
      )
    ).toBe(true);
  }, 60_000);

  it('acknowledge rejects a block-severity evaluator whose resolution.acknowledge.enabled is false', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    // Install bundled `core` so the resolver can find
    // `core/checkpoint-scope-density` when the acknowledge command
    // looks it up. Without this, discoverEvaluators returns no entries
    // and the lookup returns EVALUATOR_NOT_FOUND instead of
    // BLOCK_NOT_ACKNOWLEDGEABLE.
    const addPackCore = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--yes',
      '--json',
    ]);
    expect(addPackCore.exitCode).toBe(0);

    // core/checkpoint-scope-density is severity:block but ships with
    // resolution.acknowledge.enabled:false (only policy_exception is
    // opt-in). Trying to acknowledge it should reject with
    // BLOCK_NOT_ACKNOWLEDGEABLE — same contract as the legacy strict
    // evaluator without on_block ack opt-in.
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'do work',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;

    const ackRes = await agent.runRaw([
      'block',
      'acknowledge',
      '--artifact',
      artifactId,
      '--evaluator',
      'core/checkpoint-scope-density',
      '--reason',
      'I want this to be allowed',
    ]);
    expect(ackRes.exitCode).toBe(1);
    const err = JSON.parse(ackRes.stdout) as { ok: boolean; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('BLOCK_NOT_ACKNOWLEDGEABLE');
  });

  it('rebuild repopulates SQLite from disk artifacts when the cache is wiped', async () => {
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');

    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({ task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] })
      ),
    ]);
    const planEnv = JSON.parse(planRes.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    const artifactId = planEnv.artifact_id;
    const stepOneId = planEnv.plan_steps[0].step_id;

    // Wipe the cache directory.
    await fs.rm(nodePath.join(repo.path, '.orcaops', 'cache'), { recursive: true, force: true });

    // Without rebuild: capture checkpoint would fail with UNKNOWN_ARTIFACT
    // because the SQLite row is gone but the JSON files on disk remain.
    const rebuildRes = await agent.runRaw(['rebuild', '--json']);
    expect(rebuildRes.exitCode).toBe(0);
    const r = JSON.parse(rebuildRes.stdout) as {
      ok: boolean;
      artifacts: number;
      checkpoints: number;
      summaries: number;
    };
    expect(r.ok).toBe(true);
    expect(r.artifacts).toBe(1);
    expect(r.checkpoints).toBe(0);

    // Now the artifact is back; capture checkpoint should succeed
    // (open + close lifecycle).
    const cpOpen = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          declared_step_ids: [stepOneId],
        })
      ),
    ]);
    expect(cpOpen.exitCode).toBe(0);
    const cpRes = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          n: 1,
          summary: 'cp post-rebuild',
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepOneId],
        })
      ),
    ]);
    expect(cpRes.exitCode).toBe(0);
  });

  it('init reports skills and commands in the right groups', async () => {
    // The split is a substring test on '/skills/', so a platform separator
    // matched nothing and every skill was reported as a command. Only an adapter
    // shipping both surfaces can catch it.
    const agent = makeAgent({ cwd: repo.path });
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents',
      'claude-code',
    ]);
    const init = JSON.parse(res.stdout) as {
      agent_skills_installed: string[];
      agent_commands_installed: string[];
    };
    expect(init.agent_skills_installed.length).toBeGreaterThan(0);
    expect(init.agent_commands_installed.length).toBeGreaterThan(0);
    for (const p of init.agent_skills_installed) expect(p).toContain('/skills/');
    for (const p of init.agent_commands_installed) expect(p).not.toContain('/skills/');
  });

  it('init --agents codex installs only .agents/skills/ files (no .claude/), no config.agent', async () => {
    const { access, readFile } = await import('node:fs/promises');
    const initRes = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents',
      'codex',
      // The managed block is opt-in on a fresh init, and this case asserts on
      // the AGENTS.md placement it produces.
      '--agents-md',
    ]);
    expect(initRes.exitCode).toBe(0);
    const init = JSON.parse(initRes.stdout) as {
      ok: boolean;
      agent_tool: string;
      agent_skills_installed: string[];
      agent_commands_installed: string[];
      agents_md: Array<{ path: string; action: string }>;
    };
    expect(init.ok).toBe(true);
    expect(init.agent_tool).toBe('codex');
    // 19 skills: 5 lifecycle (capture/checkpoint/plan-approval/pre-pr/summary) +
    // 5 read (digest/why/resume/search/doctor) + 5 default-on workflow skills
    // (adversarial-review, timetravel, recap, plan-critique, task-review) +
    // 2 git-history workflows (seed and seed-discovery) + author-evaluator.
    // The cloud gate is off in this suite, so the two gated skills are absent.
    // Codex has no slash-command surface (custom prompts are deprecated and only
    // live at user-global scope), so read-command equivalents are surfaced as
    // skills only — invocable via `/skills` picker or `$<id>` mention.
    expect(init.agent_skills_installed).toHaveLength(18);
    expect(init.agent_commands_installed).toHaveLength(0);
    for (const p of init.agent_skills_installed) {
      expect(p.startsWith('.agents/skills/')).toBe(true);
    }

    // Spot-check both groups land at the canonical Codex path.
    await access(path.join(repo.path, '.agents/skills/orcaops-capture/SKILL.md'));
    await access(path.join(repo.path, '.agents/skills/orcaops-summary/SKILL.md'));
    await access(path.join(repo.path, '.agents/skills/orcaops-digest/SKILL.md'));
    await access(path.join(repo.path, '.agents/skills/orcaops-doctor/SKILL.md'));

    // Codex bootstrap goes to AGENTS.md only (Codex doesn't read CLAUDE.md).
    expect(init.agents_md).toEqual([{ path: 'AGENTS.md', action: 'created' }]);
    await access(path.join(repo.path, 'AGENTS.md'));
    let claudeMdExists = true;
    try {
      await access(path.join(repo.path, 'CLAUDE.md'));
    } catch {
      claudeMdExists = false;
    }
    expect(claudeMdExists).toBe(false);

    // Cross-check: NO .claude/ directory exists since codex doesn't ship those.
    let claudeExists = true;
    try {
      await access(path.join(repo.path, '.claude'));
    } catch {
      claudeExists = false;
    }
    expect(claudeExists).toBe(false);

    // No static agent identity is persisted (config v3): attribution is
    // runtime-resolved per invocation; the install flags only seed the install set.
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops/config.json'), 'utf8')
    ) as Record<string, unknown>;
    expect('agent' in cfg).toBe(false);
  });

  it("init --agents '' writes no skills (manual mode), no config.agent", async () => {
    const { access, readFile } = await import('node:fs/promises');
    const initRes = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents',
      '',
    ]);
    expect(initRes.exitCode).toBe(0);
    const init = JSON.parse(initRes.stdout) as {
      ok: boolean;
      agent_tool: string | null;
      agent_skills_installed: string[];
      agent_commands_installed: string[];
    };
    expect(init.agent_tool).toBeNull(); // 'other' has no adapter
    expect(init.agent_skills_installed).toHaveLength(0);
    expect(init.agent_commands_installed).toHaveLength(0);

    let agentsDirExists = true;
    try {
      await access(path.join(repo.path, '.agents'));
    } catch {
      agentsDirExists = false;
    }
    expect(agentsDirExists).toBe(false);

    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops/config.json'), 'utf8')
    ) as Record<string, unknown>;
    expect('agent' in cfg).toBe(false);
  });

  it('init rejects the retired --agent flag as an unknown option', async () => {
    const initRes = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--no-llm',
      '--agent',
      'codex',
    ]);
    expect(initRes.exitCode).toBe(1);
    expect(initRes.stderr).toMatch(/unknown option/);
  });

  it('init --agents invalid-value rejects with exit 1', async () => {
    const initRes = await agent.runRaw(['init', '--no-llm', '--json', '--agents', 'not-an-agent']);
    expect(initRes.exitCode).toBe(1);
    expect(initRes.stdout).toMatch(/not a supported install target/);
  });

  it('init defaults to no AGENTS.md / CLAUDE.md mutation', async () => {
    const { access, readFile } = await import('node:fs/promises');
    const initRes = await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const init = JSON.parse(initRes.stdout) as {
      agents_md: Array<{ path: string; action: string }>;
    };
    expect(init.agents_md).toEqual([]);
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      await expect(access(path.join(repo.path, f))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const config = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { bootstrap: string };
    expect(config.bootstrap).toBe('manual');
  });

  it('init --agents-md writes a canonical AGENTS.md + symlinked CLAUDE.md', async () => {
    const { lstat, readFile, readlink } = await import('node:fs/promises');
    const initRes = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents-md',
    ]);
    const init = JSON.parse(initRes.stdout) as {
      agents_md: Array<{ path: string; action: string }>;
    };
    // One canonical instruction file (AGENTS.md), the rest symlinked.
    expect(init.agents_md).toEqual([
      { path: 'AGENTS.md', action: 'created' },
      { path: 'CLAUDE.md', action: 'symlinked' },
    ]);
    const agentsMd = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toMatch(/<!-- orcaops:start v=/);
    expect(agentsMd).toMatch(/<!-- orcaops:end -->/);
    expect(agentsMd).toMatch(/orcaops status --json/);
    expect(agentsMd).toMatch(/orcaops-capture/);
    expect(agentsMd).toMatch(/orcaops-checkpoint/);
    // CLAUDE.md is a symlink to the canonical file (no double-write), so reading it
    // resolves to byte-identical content.
    expect((await lstat(path.join(repo.path, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(repo.path, 'CLAUDE.md'))).toBe('AGENTS.md');
    const claudeMd = await readFile(path.join(repo.path, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toBe(agentsMd);
  });

  it('init --no-agents-md skips AGENTS.md / CLAUDE.md entirely', async () => {
    const { access } = await import('node:fs/promises');
    const initRes = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--no-agents-md',
    ]);
    const init = JSON.parse(initRes.stdout) as {
      agents_md: Array<{ path: string; action: string }>;
    };
    expect(init.agents_md).toEqual([]);
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      let exists = true;
      try {
        await access(path.join(repo.path, f));
      } catch {
        exists = false;
      }
      expect(exists, `${f} should not exist when --no-agents-md is passed`).toBe(false);
    }
  });

  it('init --prefix installs oo-* skills and a managed block that references them', async () => {
    const { readFile } = await import('node:fs/promises');
    const initRes = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--prefix',
      'oo',
      '--agents-md',
    ]);
    const init = JSON.parse(initRes.stdout) as { agent_skills_installed: string[] };
    // Skills install under the oo- prefix, with no orcaops- residue.
    expect(init.agent_skills_installed.some((p) => p.includes('/oo-capture/'))).toBe(true);
    expect(init.agent_skills_installed.every((p) => !p.includes('/orcaops-'))).toBe(true);
    // The managed block references the SAME oo-* skill names; the binary stays literal.
    const agentsMd = await readFile(path.join(repo.path, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('oo-capture');
    expect(agentsMd).not.toContain('orcaops-capture');
    expect(agentsMd).toContain('orcaops status --json');
    // The prefix persists into config.
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { naming: { prefix: string } };
    expect(cfg.naming.prefix).toBe('oo');
  });

  it('init --prefix rejects a non lowercase / hyphen-safe value', async () => {
    const res = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--prefix',
      'Oo',
    ]);
    expect(res.exitCode).toBe(1);
    const err = JSON.parse(res.stdout) as { ok: boolean; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('INVALID_INPUT');
  });

  it('init --no-agents-md persists bootstrap=manual in config', async () => {
    const { readFile } = await import('node:fs/promises');
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--no-agents-md']);
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { bootstrap: string };
    expect(cfg.bootstrap).toBe('manual');
  });

  it('init defaults to session hooks disabled and touches no agent settings file', async () => {
    // Pins the --session-hooks / --no-session-hooks declaration order in
    // program.ts (positive flag first ⇒ tri-state default undefined). If the
    // pair is ever reversed, commander presets the default to true and every
    // unattended init starts writing agent settings files — this test is the
    // guard, same as the AGENTS.md pin above.
    const { access, readFile } = await import('node:fs/promises');
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { session_hooks?: { enabled?: boolean; payload?: string } };
    // Minimal-delta config: all-default session_hooks is simply absent.
    expect(cfg.session_hooks?.enabled ?? false).toBe(false);
    expect(cfg.session_hooks?.payload ?? 'static').toBe('static');
    for (const f of ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json']) {
      await expect(access(path.join(repo.path, f))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('init --session-hooks / --no-session-hooks persist the tri-state choice', async () => {
    const { readFile } = await import('node:fs/promises');
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--session-hooks']);
    let cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { session_hooks?: { enabled?: boolean; payload?: string } };
    expect(cfg.session_hooks?.enabled).toBe(true);

    // Explicit disable wins over the preserved value on re-init.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--force',
      '--no-session-hooks',
    ]);
    cfg = JSON.parse(await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')) as {
      session_hooks?: { enabled?: boolean; payload?: string };
    };
    expect(cfg.session_hooks?.enabled ?? false).toBe(false);
  });

  it('--session-hook-payload persists the mode WITHOUT implicitly enabling; update switches it', async () => {
    const { readFile } = await import('node:fs/promises');
    // Setting the payload alone never enables — orthogonal flags, no
    // surprise settings writes.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--session-hook-payload',
      'state-aware',
    ]);
    let cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { session_hooks?: { enabled?: boolean; payload?: string } };
    // enabled:false is the default → dropped; the non-default payload persists.
    expect(cfg.session_hooks).toEqual({ payload: 'state-aware' });

    // update flips the mode in place (the settings entries never change —
    // that is the A/B arm-switch property).
    const res = await agent.runRaw(['update', '--json', '--session-hook-payload', 'static']);
    expect(res.exitCode).toBe(0);
    cfg = JSON.parse(await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')) as {
      session_hooks?: { enabled?: boolean; payload?: string };
    };
    expect(cfg.session_hooks?.payload).toBe('static');
  });

  it('force re-init preserves an enabled session_hooks without another flag', async () => {
    const { readFile } = await import('node:fs/promises');
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--session-hooks']);
    const res = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--force', '--json']);
    expect(res.exitCode).toBe(0);
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { session_hooks?: { enabled?: boolean; payload?: string } };
    expect(cfg.session_hooks?.enabled).toBe(true);
  });

  it('force re-init preserves an existing managed bootstrap without another flag', async () => {
    const { access, readFile } = await import('node:fs/promises');
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const res = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--force', '--json']);
    expect(res.exitCode).toBe(0);
    const cfg = JSON.parse(
      await readFile(path.join(repo.path, '.orcaops', 'config.json'), 'utf8')
    ) as { bootstrap: string };
    expect(cfg.bootstrap).toBe('managed');
    await expect(access(path.join(repo.path, 'AGENTS.md'))).resolves.toBeUndefined();
  });

  it('a managed→manual flip + update prunes the managed block (hash-guarded)', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']); // managed: AGENTS.md carries the block
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    expect(await readFile(agentsPath, 'utf8')).toMatch(/<!-- orcaops:start/);

    // Flip to manual, then update.
    const cfgPath = path.join(repo.path, '.orcaops', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as { bootstrap: string };
    cfg.bootstrap = 'manual';
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    await agent.runRaw(['update']);

    // The unmodified managed block is pruned (hash-guarded).
    expect(await readFile(agentsPath, 'utf8')).not.toMatch(/<!-- orcaops:start/);
  });

  it('init preserves user content above and below the orcaops section in AGENTS.md', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const userBefore = '# My Project\n\nUser-owned header content.\n';
    const userAfter = '\n## My Other Section\n\nUser-owned footer content.\n';
    const agentsMdPath = path.join(repo.path, 'AGENTS.md');
    await writeFile(agentsMdPath, userBefore + userAfter, 'utf8');

    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm', '--agents-md']);
    const next = await readFile(agentsMdPath, 'utf8');

    // User content preserved at both ends; orcaops section appended/inserted.
    expect(next.startsWith(userBefore)).toBe(true);
    expect(next).toMatch(/<!-- orcaops:start v=/);

    // Re-running init --force regenerates the section but doesn't disturb
    // user content (since the file already had no managed section, it was
    // appended on first run and stays in place on second run).
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents-md',
      '--force',
    ]);
    const after = await readFile(agentsMdPath, 'utf8');
    expect(after.startsWith(userBefore)).toBe(true);
    // Exactly one orcaops section.
    const startMatches = after.match(/<!-- orcaops:start/g);
    expect(startMatches).toHaveLength(1);
  });

  it('eval list --json returns all 20 first-party pack evaluators after installing core + js + demo', async () => {
    // `init` does not auto-install packs. The user-facing flow is `init`
    // followed by explicit `eval add-pack` calls for each desired pack.
    // Install all three first-party packs and assert the union covers
    // the expected 28 evaluators.
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    for (const packId of ['core', 'js', 'demo']) {
      const r = await agent.runRaw([
        'eval',
        'add-pack',
        '@orcaops/evaluator-pack',
        packId,
        '--yes',
        '--json',
      ]);
      expect(r.exitCode).toBe(0);
    }
    const listRes = await agent.runRaw(['eval', 'list', '--json']);
    expect(listRes.exitCode).toBe(0);
    const list = JSON.parse(listRes.stdout) as {
      ok: boolean;
      evaluators: Array<{
        ref: string;
        severity: string;
        phase: string;
        engine: string;
        llm?: {
          provider: { value: string; source: string; available: boolean | null };
          model: { value: string | null; source: string };
          timeout_ms: { value: number; source: string };
        };
      }>;
    };
    expect(list.ok).toBe(true);
    expect(list.evaluators).toHaveLength(20);
    expect(list.evaluators.find((e) => e.ref === 'core/plan-conformance-pre-pr')?.llm).toEqual({
      provider: { value: 'none', source: 'global', available: null },
      model: { value: null, source: 'provider-default' },
      timeout_ms: { value: 120_000, source: 'pack-spec' },
    });
    const humanList = await agent.runRaw(['eval', 'list']);
    expect(humanList.exitCode).toBe(0);
    expect(humanList.stdout).toContain(
      'LLM provider=none (global), available=n/a, model=provider default (provider-default), timeout=120000ms (pack-spec)'
    );

    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { llm: { tool: string } };
    config.llm.tool = 'claude';
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    const hangingClaude = path.join(repo.path, 'hanging-claude');
    await writeFile(hangingClaude, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n", {
      mode: 0o755,
    });
    const inconclusiveAgent = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_CLAUDE_PATH: hangingClaude,
        ORCAOPS_CODEX_PATH: path.join(repo.path, 'missing-codex'),
      },
    });
    const inconclusiveList = await inconclusiveAgent.runRaw(['eval', 'list']);
    expect(inconclusiveList.exitCode).toBe(0);
    expect(inconclusiveList.stdout).toContain('LLM provider=claude (global), available=unknown');

    const refs = list.evaluators.map((e) => e.ref).sort();
    expect(refs).toEqual([
      'core/checkpoint-scope-density',
      'core/completed-steps-claimed',
      'core/non-goals-info',
      'core/non-goals-violated',
      'core/plan-conformance-post-plan',
      'core/plan-conformance-pre-pr',
      'core/plan-conformance-revision',
      'core/plan-label-quality',
      'core/plan-mentions-tests',
      'core/revision-diff-bounded',
      'core/revision-non-goals-stable',
      'core/revision-rationale-required',
      'core/revision-touched-scope-stable',
      'core/scope-creep-detect',
      'core/sensitive-scope-flag',
      'core/step-coverage',
      'demo/always-block',
      'demo/hello',
      'demo/hello-llm',
      'js/api-signature-drift',
    ]);
  });

  // ── idempotency_key wiring ─────────────────────────────────────────────
  //
  // The companion "capture plan rejects a missing idempotency_key with
  // INVALID_INPUT" test lives in `tests/smoke/cli.test.ts`: the InProcessAgent's
  // `withIdempotencyKey` transformer auto-fills empty strings before they
  // reach the CLI, so the Zod min(1) violation can only be observed
  // via the real-spawn smoke path.

  it('capture plan with a repeated idempotency_key returns IDEMPOTENT_REPLAY with the prior artifact_id', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const payload = {
      idempotency_key: 'plan-replay-test',
      task: 'add rate limit',
      plan_steps: [
        { text: 'middleware', label: 's1' },
        { text: 'tests', label: 's2' },
      ],
    };
    const first = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(first.exitCode).toBe(0);
    const firstParsed = JSON.parse(first.stdout) as {
      ok: boolean;
      artifact_id: string;
      idempotency_status: string;
    };
    expect(firstParsed.idempotency_status).toBe('created');
    const firstArtifactId = firstParsed.artifact_id;

    const second = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(second.exitCode).toBe(0);
    const secondParsed = JSON.parse(second.stdout) as {
      ok: boolean;
      artifact_id: string;
      idempotency_status: string;
      code?: string;
    };
    expect(secondParsed.ok).toBe(true);
    expect(secondParsed.idempotency_status).toBe('replay');
    expect(secondParsed.code).toBe('IDEMPOTENT_REPLAY');
    expect(secondParsed.artifact_id).toBe(firstArtifactId);
  });

  it('same-key plan replay resumes when its completion row is missing', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const payload = {
      idempotency_key: 'plan-resume-deleted-completion',
      task: 'resume deleted evaluator completion',
      label: 'resume-deleted-completion',
      plan_steps: [{ text: 'one', label: 's1' }],
      touched_scope: [],
    };
    const first = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    const artifactId = (JSON.parse(first.stdout) as { artifact_id: string }).artifact_id;
    const cache = new Store(path.join(repo.path, '.orcaops', 'cache', 'orcaops.db'));
    try {
      cache.db
        .prepare(
          `DELETE FROM evaluator_lifecycles
           WHERE artifact_id = ? AND fires_at = 'post-plan'`
        )
        .run(artifactId);
    } finally {
      cache.close();
    }

    const replay = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(replay.exitCode).toBe(0);
    expect((JSON.parse(replay.stdout) as { message: string }).message).toContain(
      'missing post-event evaluator work was resumed'
    );
  });

  it('ignores checkpoint_n for a non-checkpoint evaluator phase', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const created = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: 'manual-post-plan-sequence',
          task: 'manual post-plan sequence',
          label: 'manual-post-plan-sequence',
          plan_steps: [{ text: 'one', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(created.stdout) as { artifact_id: string }).artifact_id;
    const rerun = await agent.runRaw([
      'capture',
      'run-evaluators',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          fires_at: 'post-plan',
          checkpoint_n: 9,
        })
      ),
    ]);
    expect(rerun.exitCode).toBe(0);

    const cache = new Store(path.join(repo.path, '.orcaops', 'cache', 'orcaops.db'));
    try {
      const rows = cache.listLifecycles(artifactId).filter((row) => row.fires_at === 'post-plan');
      expect(rows).toHaveLength(1);
      expect(rows[0].cp_n).toBe(0);
    } finally {
      cache.close();
    }
  });

  it('recovers a post-append plan failure by rebuild and same-key replay', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const payload = {
      idempotency_key: 'plan-post-append-failure',
      task: 'recover the original plan identity',
      label: 'recover-original-plan',
      plan_steps: [{ text: 'one', label: 's1' }],
      touched_scope: [],
    };
    const upsert = vi.spyOn(Store.prototype, 'upsertArtifact').mockImplementationOnce(() => {
      throw new Error('injected projection failure');
    });
    const failed = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    upsert.mockRestore();
    expect(failed.exitCode).toBe(1);
    const failure = JSON.parse(failed.stdout) as {
      error: { code: string; message: string };
    };
    expect(failure.error.code).toBe('IDEMPOTENCY_PENDING');
    expect(failure.error.message).toContain(
      'Run `orcaops rebuild`, then retry `orcaops capture plan` with the same idempotency key.'
    );

    const cache = new Store(path.join(repo.path, '.orcaops', 'cache', 'orcaops.db'));
    const artifactId = cache.lookupPlanIdempotency(payload.idempotency_key)?.artifact_id;
    cache.close();
    expect(artifactId).toBeDefined();

    const rebuilt = await agent.runRaw(['rebuild', '--json']);
    expect(rebuilt.exitCode).toBe(0);
    const replay = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(replay.exitCode).toBe(0);
    const replayEnv = JSON.parse(replay.stdout) as {
      artifact_id: string;
      idempotency_status: string;
    };
    expect(replayEnv.artifact_id).toBe(artifactId);
    expect(replayEnv.idempotency_status).toBe('replay');

    const rawEvents = await readFile(
      path.join(repo.path, '.orcaops', 'artifacts', artifactId!, 'events.ndjson'),
      'utf8'
    );
    expect(
      rawEvents
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string })
        .filter((event) => event.type === 'plan_captured')
    ).toHaveLength(1);
  });

  it('rolls back a plan reservation when the durable append is proven absent', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const payload = {
      idempotency_key: 'plan-pre-append-failure',
      task: 'retry a failed append',
      label: 'retry-failed-append',
      plan_steps: [{ text: 'one', label: 's1' }],
      touched_scope: [],
    };
    const writePlan = vi
      .spyOn(ArtifactStore.prototype, 'writePlan')
      .mockRejectedValueOnce(new Error('injected pre-append failure'));
    const failed = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    writePlan.mockRestore();
    expect(failed.exitCode).toBe(1);
    expect((JSON.parse(failed.stdout) as { error: { message: string } }).error.message).toContain(
      'injected pre-append failure'
    );

    const cache = new Store(path.join(repo.path, '.orcaops', 'cache', 'orcaops.db'));
    try {
      expect(cache.lookupPlanIdempotency(payload.idempotency_key)).toBeNull();
    } finally {
      cache.close();
    }

    const retry = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify(payload)),
    ]);
    expect(retry.exitCode).toBe(0);
    expect((JSON.parse(retry.stdout) as { idempotency_status: string }).idempotency_status).toBe(
      'created'
    );
  });
});
