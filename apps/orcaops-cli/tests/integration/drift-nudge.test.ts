import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

interface DriftField {
  staleSkills: string[];
  staleCommands: string[];
  staleBlock: string[];
  staleInfoExclude: string[];
  aheadSkills: string[];
  aheadCommands: string[];
  aheadBlock: string[];
}
interface StatusJson {
  ok: true;
  drift?: DriftField;
}

async function staleStamp(p: string, marker: RegExp, replacement: string): Promise<void> {
  const original = await readFile(p, 'utf8');
  await writeFile(p, original.replace(marker, replacement), 'utf8');
}

async function setConfig(
  repoPath: string,
  mutate: (cfg: Record<string, unknown>) => void
): Promise<void> {
  const cfgPath = path.join(repoPath, '.orcaops', 'config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
  mutate(cfg);
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/**
 * Curated drift nudge. `status` and `resume` surface a stale install
 * (skills/commands/block vs the running CLI): a stderr line in human mode + a
 * `drift` field in --json. Skill/command staleness always nudges; the block nudge
 * is suppressed under bootstrap=manual. --json stdout stays a clean envelope.
 */
describe('orcaops drift nudge', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { CLAUDE_SESSION_ID: 'test-drift' } });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('a fresh install is silent: no stderr nudge, no drift field', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const human = await agent.runRaw(['status']);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).not.toMatch(/out of date/);
    const json = await agent.runRaw(['status', '--json']);
    expect((JSON.parse(json.stdout) as StatusJson).drift).toBeUndefined();
  });

  it('a stale skill nudges to stderr (human) and carries drift in --json on a clean stdout', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await staleStamp(
      path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md'),
      /orcaops@[^"]+/,
      'orcaops@0.0.0-stale'
    );

    const human = await agent.runRaw(['status']);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toMatch(/orcaops update/);
    expect(human.stdout).toMatch(/Branch:/); // the report still renders to stdout

    const json = await agent.runRaw(['status', '--json']);
    const parsed = JSON.parse(json.stdout) as StatusJson; // stdout is clean JSON
    expect(parsed.drift?.staleSkills.length).toBeGreaterThan(0);
    expect(json.stderr).not.toMatch(/out of date/); // --json puts drift in stdout, not stderr
  });

  it('agent="other" never nudges (no managed install)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await setConfig(repo.path, (cfg) => {
      cfg.agent = 'other';
    });
    const json = await agent.runRaw(['status', '--json']);
    expect((JSON.parse(json.stdout) as StatusJson).drift).toBeUndefined();
  });

  it('is prefix-aware: a fresh --prefix oo install is silent', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--prefix', 'oo', '--agents-md']);
    const json = await agent.runRaw(['status', '--json']);
    // If the detector ignored the prefix it would look for orcaops-* paths,
    // find none, and report every skill stale. Silence proves prefix-awareness.
    expect((JSON.parse(json.stdout) as StatusJson).drift).toBeUndefined();
  });

  it('block staleness nudges when managed, then is suppressed under bootstrap=manual', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    // Stale only the instruction block (skills stay current).
    await staleStamp(
      path.join(repo.path, 'AGENTS.md'),
      /orcaops:start v=[^\s]+/,
      'orcaops:start v=0.0.0-stale-block'
    );

    const managed = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(managed.drift?.staleBlock.length).toBeGreaterThan(0);
    expect(managed.drift?.staleSkills.length).toBe(0);

    // Flip to manual WITHOUT touching files → the block nudge is suppressed, and
    // since skills are current there is no drift at all.
    await setConfig(repo.path, (cfg) => {
      cfg.bootstrap = 'manual';
    });
    const manual = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(manual.drift).toBeUndefined();
  });

  it('a block whose BODY drifted at an unchanged version is stale (same-version refresh gap)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsMd = path.join(repo.path, 'AGENTS.md');
    const before = await readFile(agentsMd, 'utf8');

    // Rewrite a line INSIDE the markers and leave `v=` alone. This is what
    // shipping a changed template looks like to an already-installed repo, and
    // it is invisible to a stamp comparison — the defect this pins. `update`
    // would rewrite this block, so the nudge has to say so.
    const after = before.replace('**Attribution.**', '**Attribution (superseded wording).**');
    expect(after).not.toBe(before);
    await writeFile(agentsMd, after, 'utf8');
    expect(after).toMatch(/orcaops:start v=/); // stamp deliberately still current

    const json = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(json.drift?.staleBlock).toContain('AGENTS.md');
    expect(json.drift?.staleSkills.length).toBe(0); // block only, not a blanket nudge
  });

  it('under bootstrap=manual a stale skill still nudges (block suppressed)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--no-agents-md']); // manual
    await staleStamp(
      path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md'),
      /orcaops@[^"]+/,
      'orcaops@0.0.0-stale'
    );
    const json = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(json.drift?.staleSkills.length).toBeGreaterThan(0);
    expect(json.drift?.staleBlock.length).toBe(0);
  });

  it('an AHEAD skill nudges "upgrade orcaops", not "run orcaops update"', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    await staleStamp(
      path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md'),
      /orcaops@[^"]+/,
      'orcaops@99.0.0'
    );

    const human = await agent.runRaw(['status']);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toMatch(/NEWER orcaops.*upgrade orcaops/);
    expect(human.stderr).not.toMatch(/out of date/);

    const json = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(json.drift?.aheadSkills.length).toBeGreaterThan(0);
    expect(json.drift?.staleSkills.length).toBe(0);
  });

  it('an AHEAD block populates drift.aheadBlock, not staleBlock', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    await staleStamp(
      path.join(repo.path, 'AGENTS.md'),
      /orcaops:start v=[^\s]+/,
      'orcaops:start v=99.0.0'
    );

    const json = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    // CLAUDE.md symlinks to AGENTS.md, so both instruction files read ahead.
    expect(json.drift?.aheadBlock).toContain('AGENTS.md');
    expect(json.drift?.staleBlock.length).toBe(0);
  });

  it('a MALFORMED ahead block still classifies ahead, not stale (no false update nudge)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    // Restamp ahead AND destroy the end marker — the identity reader returns
    // null for this layout, but the stamp is still readable.
    const malformed = (await readFile(agentsPath, 'utf8'))
      .replace(/orcaops:start v=[^\s]+/, 'orcaops:start v=99.0.0')
      .replace(/<!-- orcaops:end -->/, '');
    await writeFile(agentsPath, malformed, 'utf8');

    const json = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(json.drift?.aheadBlock).toContain('AGENTS.md');
    expect(json.drift?.staleBlock.length).toBe(0);
  });

  it('global scope reports NO project skill/command drift (the planner writes none)', async () => {
    // The planner and both doctor checks skip project trees under global
    // scope; drift classifying them would nudge an update that provably
    // changes nothing.
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'oo-drift-global-'));
    try {
      const globalAgent = makeAgent({
        cwd: repo.path,
        env: { CLAUDE_SESSION_ID: 'test-drift-global', ORCAOPS_GLOBAL_ROOT: globalRoot },
      });
      await globalAgent.runRaw([
        'init',
        '--scope',
        'global',
        '--install-agent',
        'claude-code',
        '--no-llm',
      ]);

      const before = JSON.parse(
        (await globalAgent.runRaw(['status', '--json'])).stdout
      ) as StatusJson;
      expect(before.drift ?? null).toBeNull();

      // The remedy invariant, end to end: update must not create or leave one.
      await globalAgent.runRaw(['update']);
      const after = JSON.parse(
        (await globalAgent.runRaw(['status', '--json'])).stdout
      ) as StatusJson;
      expect(after.drift ?? null).toBeNull();
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it('mixed stale + ahead surfaces BOTH nudge lines', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    await staleStamp(
      path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md'),
      /orcaops@[^"]+/,
      'orcaops@0.0.0-stale'
    );
    await staleStamp(
      path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md'),
      /orcaops@[^"]+/,
      'orcaops@99.0.0'
    );

    const human = await agent.runRaw(['status']);
    expect(human.stderr).toMatch(/out of date/);
    expect(human.stderr).toMatch(/upgrade orcaops/);
  });

  it('a personal repo with stripped info/exclude lines nudges staleInfoExclude (both directions)', async () => {
    // The invisible footprint's hiding mechanism is drift like any other
    // surface. Personal + missing lines → pending ADD is drift; scope exited
    // with lines still present → pending STRIP is drift.
    await agent.runRaw(['init', '--yes', '--no-llm']); // invisible default: personal
    const excludeRel = path.join('.git', 'info', 'exclude');
    const excludeAbs = path.join(repo.path, excludeRel);
    expect(await readFile(excludeAbs, 'utf8')).toContain('.orcaops/');

    // Fresh personal install: no drift.
    let parsed = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(parsed.drift).toBeUndefined();

    // Someone emptied the exclude file → the pending re-add is drift.
    await writeFile(excludeAbs, '', 'utf8');
    parsed = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(parsed.drift?.staleInfoExclude).toContain(excludeRel);

    // Restore, then flip the CONFIG to project scope without reconciling —
    // the lingering hide lines are now a pending strip, drift again.
    await agent.runRaw(['update', '--json']);
    parsed = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(parsed.drift).toBeUndefined();
    await setConfig(repo.path, (cfg) => {
      (cfg.install as Record<string, unknown>).scope = 'project';
    });
    parsed = JSON.parse((await agent.runRaw(['status', '--json'])).stdout) as StatusJson;
    expect(parsed.drift?.staleInfoExclude).toContain(excludeRel);
  });

  it('resume surfaces the same nudge', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({ task: 't', label: 'lbl', plan_steps: [{ text: 's', label: 's1' }] })
      ),
    ]);
    await rm(path.join(repo.path, '.claude', 'skills', 'orcaops-digest', 'SKILL.md'));

    const human = await agent.runRaw(['resume']);
    expect(human.stderr).toMatch(/orcaops update/);
    const json = JSON.parse((await agent.runRaw(['resume', '--json'])).stdout) as StatusJson;
    expect(json.drift?.staleSkills.length).toBeGreaterThan(0);
  });

  it('status reports a generated-file symlink as stale without inspecting its target', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const managed = path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-drift-outside-'));
    const external = path.join(outside, 'SKILL.md');
    const externalBody = await readFile(managed, 'utf8');
    await writeFile(external, externalBody, 'utf8');
    await rm(managed);
    await symlink(external, managed);

    try {
      const res = await agent.runRaw(['status', '--json']);
      expect(res.exitCode).toBe(0);
      expect((JSON.parse(res.stdout) as StatusJson).drift?.staleSkills).toContain(
        '.claude/skills/orcaops-checkpoint/SKILL.md'
      );
      expect(await readFile(external, 'utf8')).toBe(externalBody);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('status treats a dangling instruction symlink as a missing managed file', async () => {
    // codex joins the set so AGENTS.md is the managed canonical; removing it
    // leaves the CLAUDE.md symlink dangling.
    await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'claude-code,codex',
      '--no-llm',
      '--agents-md',
    ]);
    await rm(path.join(repo.path, 'AGENTS.md'));

    const res = await agent.runRaw(['status', '--json']);
    expect(res.exitCode).toBe(0);
    const drift = (JSON.parse(res.stdout) as StatusJson).drift;
    expect(drift?.staleBlock).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']));
  });
});
