import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore, getDefaultConfig } from '@orcaops/storage';
import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

// A real-shape but semantically dead JWT. Warn tier is load-bearing, not
// incidental: capture REFUSES a refuse-tier shape outright, so a fixture like
// a `ghp_` token never reaches an artifact and every assertion below would
// fail on a missing artifact rather than on redaction. Warn tier is exactly
// the content that reaches an artifact and must still be redacted at output.
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb3JwdXMtdXNlciJ9.0000000000000000000000000000000000000000000';

describe('output redaction: digest / resume / why / search', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('neutralizes carriage returns only at human terminal boundaries', async () => {
    const task = 'trusted artifact id\rspoofed artifact id';
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task,
          plan_steps: [
            {
              text: 'unique-terminal-boundary-marker\rspoofed step',
              label: 's1',
            },
          ],
          decisions: [
            {
              decision: 'trusted decision\rspoofed decision',
              reason: 'terminal boundary',
            },
          ],
        })
      ),
    ]);
    const plan = JSON.parse(planRes.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    const stepId = plan.plan_steps[0]!.step_id;
    expect(
      (
        await agent.runRaw([
          'capture',
          'checkpoint',
          'open',
          '--no-llm',
          '--input',
          inputFile(
            JSON.stringify({
              idempotency_key: 'terminal-boundary-open',
              artifact_id: plan.artifact_id,
              declared_step_ids: [stepId],
            })
          ),
        ])
      ).exitCode
    ).toBe(0);
    expect(
      (
        await agent.runRaw([
          'capture',
          'checkpoint',
          'close',
          '--no-llm',
          '--input',
          inputFile(
            JSON.stringify({
              idempotency_key: 'terminal-boundary-close',
              artifact_id: plan.artifact_id,
              n: 1,
              summary: 'terminal boundary fixture',
              files_changed: [],
              verification: [{ command: 'test fixture', exit_code: 0 }],
              completed_step_ids: [stepId],
              uncertainty: ['trusted uncertainty\rspoofed uncertainty'],
            })
          ),
        ])
      ).exitCode
    ).toBe(0);

    for (const args of [
      ['digest', '--artifact', plan.artifact_id],
      ['resume', '--artifact', plan.artifact_id],
    ]) {
      const result = await agent.runRaw(args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('\r');
      expect(result.stdout).toContain('spoofed');
    }

    for (const args of [
      ['search', 'unique-terminal-boundary-marker'],
      ['list'],
      ['show', plan.artifact_id],
      ['decisions', '--artifact', plan.artifact_id],
      ['loose-ends', '--artifact', plan.artifact_id],
      ['step', 'brief', stepId, '--artifact', plan.artifact_id],
    ]) {
      const result = await agent.runRaw(args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('\r');
      expect(result.stdout).toContain('spoofed');
    }

    const cached = await readFile(
      path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id, 'digest.md'),
      'utf8'
    );
    expect(cached).toContain(task);
  });

  it('redacts a carriage-return-split secret before terminal output', async () => {
    const split = `${FAKE_JWT.slice(0, 20)}\r${FAKE_JWT.slice(20)}`;
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: `before ${split} after`,
          plan_steps: [{ text: 'render safely', label: 's1' }],
        })
      ),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const result = await agent.runRaw(['digest', '--artifact', plan.artifact_id]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(FAKE_JWT);
    expect(result.stdout).not.toContain(split);
    expect(result.stdout).toContain('[REDACTED_SECRET]');
  });

  it('neutralizes terminal controls in command-line parse errors', async () => {
    const esc = String.fromCharCode(0x1b);
    for (const args of [[`--bad${esc}[2Joption`], ['init', `--bad${esc}[2Joption`]]) {
      const result = await agent.runRaw(args);
      const invocation = args.join(' ');
      expect(result.exitCode, invocation).toBe(1);
      expect(result.stderr, invocation).not.toContain(esc);
      expect(result.stderr, invocation).toContain('--badoption');
    }
  });

  it('redacts a refuse-tier secret from an artifact written before the payload gate', async () => {
    const token = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';
    const artifactId = '01a03014-0000-7000-8000-000000000010';
    const stepId = '01a03014-0000-7000-8000-000000000011';
    const store = new ArtifactStore({ repoRoot: repo.path, config: getDefaultConfig() });
    try {
      await store.writePlan(
        {
          schema_version: 4,
          artifact_id: artifactId,
          branch: 'main',
          base_sha: 'a'.repeat(40),
          agent: 'other',
          agent_session_id: null,
          task: `legacy artifact containing ${token}`,
          label: 'legacy-secret-artifact',
          plan_steps: [
            {
              step_id: stepId,
              text: 'render safely',
              label: 'render-safely',
              acceptance_criteria: [],
            },
          ],
          touched_scope: [],
          non_goals: [],
          decisions: [],
          started_at: '2026-08-31T00:00:00.000Z',
          revision_n: 0,
          revised_at: null,
          rationale: null,
          step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
          criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
          prior_plan_event_id: null,
        },
        { idempotencyKey: 'legacy-secret-plan' }
      );
    } finally {
      store.close();
    }

    const result = await agent.runRaw(['digest', '--artifact', artifactId, '--json']);
    expect(result.exitCode).toBe(0);
    const digest = JSON.parse(result.stdout) as { data: unknown; markdown: string };
    expect(JSON.stringify(digest.data)).not.toContain(token);
    expect(digest.markdown).not.toContain(token);
    expect(JSON.stringify(digest.data)).toContain('[REDACTED_SECRET]');
    expect(digest.markdown).toContain('[REDACTED_SECRET]');
  });

  describe('digest', () => {
    it('redacts a secret quoted in plan.task / plan_steps', async () => {
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: `wire ${FAKE_JWT} into env`,
            plan_steps: [{ text: `pass ${FAKE_JWT} to deploy`, label: 's1' }],
          })
        ),
      ]);
      const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
      const dRes = await agent.runRaw(['digest', '--artifact', plan.artifact_id, '--json']);
      expect(dRes.exitCode).toBe(0);
      const d = JSON.parse(dRes.stdout) as { ok: boolean; data: unknown; markdown: string };
      const serialized = JSON.stringify(d.data);
      expect(serialized).not.toContain(FAKE_JWT);
      expect(serialized).toContain('[REDACTED_SECRET]');
      expect(d.markdown).not.toContain(FAKE_JWT);
    });

    it('writes the redacted markdown to the cached digest.md (cache mirrors output)', async () => {
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: `quote ${FAKE_JWT}`,
            plan_steps: [{ text: 's', label: 's1' }],
          })
        ),
      ]);
      const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
      await agent.runRaw(['digest', '--artifact', plan.artifact_id, '--json']);
      const cached = await readFile(
        path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id, 'digest.md'),
        'utf8'
      );
      expect(cached).not.toContain(FAKE_JWT);
    });

    it('writes the secret unmodified to events.ndjson (capture payload, not output)', async () => {
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: `wire ${FAKE_JWT}`,
            plan_steps: [{ text: 's', label: 's1' }],
          })
        ),
      ]);
      const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
      const events = await readFile(
        path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id, 'events.ndjson'),
        'utf8'
      );
      // Capture payloads are NEVER mutated — the canonical event log
      // keeps the agent-supplied original. Redaction is output-only.
      expect(events).toContain(FAKE_JWT);
    });

    it('config.digest.redact_secrets=false disables redaction (opt-out works)', async () => {
      const cfgPath = await effectiveConfigPath(repo.path);
      const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
        digest: { redact_secrets: boolean };
      };
      // Init writes a minimal delta — the digest subtree is absent by default.
      cfg.digest = { ...(cfg.digest ?? {}), redact_secrets: false };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: `quote ${FAKE_JWT}`,
            plan_steps: [{ text: 's', label: 's1' }],
          })
        ),
      ]);
      const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
      const dRes = await agent.runRaw(['digest', '--artifact', plan.artifact_id, '--json']);
      const d = JSON.parse(dRes.stdout) as { markdown: string };
      expect(d.markdown).toContain(FAKE_JWT);
    });
  });

  describe('status and show', () => {
    async function planWithSecret(): Promise<string> {
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: `ship the change quoting ${FAKE_JWT}`,
            label: 'ship the quoted change',
            plan_steps: [{ text: `deploy with ${FAKE_JWT}`, label: 's1' }],
          })
        ),
      ]);
      return (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;
    }

    it('redacts the artifact task in status output', async () => {
      await planWithSecret();

      const json = await agent.runRaw(['status', '--json']);
      expect(json.exitCode).toBe(0);
      expect(json.stdout).not.toContain(FAKE_JWT);
      expect(json.stdout).toContain('[REDACTED_SECRET]');

      const human = await agent.runRaw(['status']);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).not.toContain(FAKE_JWT);
      expect(human.stdout).toContain('[REDACTED_SECRET]');
    });

    it('redacts the plan body in show output', async () => {
      const artifactId = await planWithSecret();

      const json = await agent.runRaw(['show', artifactId, '--json']);
      expect(json.exitCode).toBe(0);
      expect(json.stdout).not.toContain(FAKE_JWT);
      expect(json.stdout).toContain('[REDACTED_SECRET]');

      const human = await agent.runRaw(['show', artifactId]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).not.toContain(FAKE_JWT);
      expect(human.stdout).toContain('[REDACTED_SECRET]');
    });

    it('leaves the artifact id addressable through the redactor', async () => {
      // The payload walk scans every string leaf, so a surface that redacts a
      // whole object has to leave its own identifiers alone or `show <id>`
      // stops resolving what `status` printed.
      const artifactId = await planWithSecret();
      const json = await agent.runRaw(['status', '--json']);
      expect(json.stdout).toContain(artifactId);
      expect((await agent.runRaw(['show', artifactId])).exitCode).toBe(0);
    });
  });

  describe('resume', () => {
    it('redacts a secret in the resume output', async () => {
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: `pass ${FAKE_JWT} to ci`,
            plan_steps: [{ text: `fetch with ${FAKE_JWT}`, label: 's1' }],
          })
        ),
      ]);
      const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
      const res = await agent.runRaw(['resume', '--artifact', plan.artifact_id, '--json']);
      expect(res.exitCode).toBe(0);
      const r = JSON.parse(res.stdout) as { artifact: { artifact_id: string } };
      const serialized = JSON.stringify(r.artifact);
      expect(serialized).not.toContain(FAKE_JWT);
      const cached = await readFile(
        path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id, 'resume.md'),
        'utf8'
      );
      expect(cached).not.toContain(FAKE_JWT);
      expect(cached).toContain('[REDACTED_SECRET]');
    });

    it('writes the redacted markdown to the cached resume.md', async () => {
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: `embed ${FAKE_JWT}`,
            plan_steps: [{ text: 's', label: 's1' }],
          })
        ),
      ]);
      const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
      await agent.runRaw(['resume', '--artifact', plan.artifact_id, '--json']);
      const cached = await readFile(
        path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id, 'resume.md'),
        'utf8'
      );
      expect(cached).not.toContain(FAKE_JWT);
    });
  });

  describe('search', () => {
    it('redacts secret-shaped substrings from snippet output', async () => {
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: `unique-search-marker work with ${FAKE_JWT}`,
            plan_steps: [{ text: 's', label: 's1' }],
          })
        ),
      ]);
      const sRes = await agent.runRaw(['search', 'unique-search-marker', '--json']);
      expect(sRes.exitCode).toBe(0);
      const s = JSON.parse(sRes.stdout) as {
        results: Array<{ snippet: string }>;
      };
      expect(s.results.length).toBeGreaterThan(0);
      for (const row of s.results) {
        expect(row.snippet).not.toContain(FAKE_JWT);
      }
    });
  });

  describe('why', () => {
    it('redacts secrets in the artifact task / checkpoint summary surfaced by why', async () => {
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: `task with ${FAKE_JWT}\rspoofed why heading`,
            plan_steps: [{ text: 's1', label: 's1' }],
          })
        ),
      ]);
      const plan = JSON.parse(planRes.stdout) as {
        artifact_id: string;
        plan_steps: Array<{ step_id: string }>;
      };
      await writeFile(path.join(repo.path, 'targeted.ts'), 'export const x = 1;\n', 'utf8');
      const git = gitClient(repo.path);
      await git.add('targeted.ts');
      await git.commit('add targeted file');
      const headSha = (await git.revparse(['HEAD'])).trim();
      await agent.runRaw([
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
      await agent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: plan.artifact_id,
            n: 1,
            summary: `cp quoting ${FAKE_JWT}`,
            files_changed: ['targeted.ts'],
            head_sha: headSha,
          })
        ),
      ]);

      const wRes = await agent.runRaw(['why', 'targeted.ts:1', '--json']);
      expect(wRes.exitCode).toBe(0);
      const w = JSON.parse(wRes.stdout) as {
        best: { task: string; checkpoint_summary: string } | null;
      };
      expect(w.best).not.toBeNull();
      expect(w.best?.task).not.toContain(FAKE_JWT);
      expect(w.best?.checkpoint_summary).not.toContain(FAKE_JWT);

      const human = await agent.runRaw(['why', 'targeted.ts:1']);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).not.toContain('\r');
      expect(human.stdout).toContain('task with [REDACTED_SECRET]');
      // The word abutting the CR falls inside the redacted span: with the
      // control removed the token reads as running straight into it, and the
      // redactor now replaces exactly the span the detector reports. Everything
      // past that word boundary survives, which is what stops the CR becoming a
      // heading of its own.
      expect(human.stdout).toContain('why heading');

      const wholeFileHuman = await agent.runRaw(['why', 'targeted.ts']);
      expect(wholeFileHuman.exitCode).toBe(0);
      expect(wholeFileHuman.stdout).not.toContain(FAKE_JWT);
      expect(wholeFileHuman.stdout).not.toContain('\r');
      expect(wholeFileHuman.stdout).toContain('cp quoting [REDACTED_SECRET]');
    });
  });
});
