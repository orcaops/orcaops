import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PullCacheRecord } from '@orcaops/storage';
import { openProjectDatabase, readProjectArtifact } from '@orcaops/storage/history/database';
import { gitClient, inputFile } from '@orcaops/test-harness';

import { createDatabasePlanPullPersistence } from '../../src/lib/database-source-plan-pull.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { cloudRecord } from '../support/source-plan-test-helpers.js';
import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

// Real-shape, semantically dead. A refuse-tier vendor prefix.
const FAKE_GH_TOKEN = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';
// Warn-tier: this is the shape that fires on ordinary quoted code, and it
// must NOT block a capture. Same shape as `const token: HeldToken` in src.
const QUOTED_CODE = 'const token: HeldToken = { lockPath, live: true };';
const WARN_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

/**
 * The load-bearing claim of the refusal design is not "the command exits
 * non-zero" — it is that a refused capture leaves NOTHING behind. These
 * assertions enumerate the durable surfaces a capture touches, because an
 * exit code alone would still pass if the event had already been appended.
 */
describe('capture refuses refuse-tier secrets and leaves no state', { timeout: 60_000 }, () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let agent: ReturnType<typeof makeAgent>;

  const snapshotDurableState = () => inventory(f.temporary);

  async function retainApprovedPlan(record: PullCacheRecord) {
    // A previously permitted record must be scanned again under the current allowlist.
    await createDatabasePlanPullPersistence({
      reader: f.writer,
      target: { server_url: record.base_url, org_id: record.org_id, account_id: 'account_1' },
      secretAllow: [FAKE_GH_TOKEN],
      openWriter: () => openProjectDatabase({ authority: f.authority, mode: 'writer' }),
    }).writeRecord(record);
  }

  beforeEach(async () => {
    f = await fixture();
    await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(f.main, '.orcaops', 'config.json'),
      JSON.stringify({ schema_version: 6 })
    );
    agent = makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
  });

  it('refuses a plan whose step text carries a vendor token, writing nothing', async () => {
    const before = await snapshotDurableState();

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'wire the deploy credentials',
          label: 'deploy creds',
          plan_steps: [{ text: `use ${FAKE_GH_TOKEN} for the push`, label: 'push step' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).not.toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string; path?: string; secret_findings?: Array<{ path: string }> };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SECRET_IN_PAYLOAD');
    expect(envelope.error.path).toContain('plan_steps');
    expect(envelope.error.secret_findings?.[0]?.path).toContain('plan_steps');

    expect(res.stdout).not.toContain(FAKE_GH_TOKEN);
    expect(res.stderr).not.toContain(FAKE_GH_TOKEN);

    // Nothing durable moved: no snapshot ref, no worktree change, no artifact.
    expect(await snapshotDurableState()).toEqual(before);
  });

  it('does not burn the idempotency key, so a clean retry succeeds', async () => {
    const key = '01a03014-0000-7000-8000-000000000001';
    const payload = (stepText: string): string =>
      inputFile(
        JSON.stringify({
          idempotency_key: key,
          task: 'rotate the deploy credentials',
          label: 'rotate creds',
          plan_steps: [{ text: stepText, label: 'rotate step' }],
          touched_scope: [],
          non_goals: [],
        })
      );

    const refused = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      payload(`use ${FAKE_GH_TOKEN} for the push`),
    ]);
    expect(refused.exitCode).not.toBe(0);

    // Same key, cleaned payload. If the refusal had reserved the key this
    // would come back IDEMPOTENCY_CONFLICT with no remedy available.
    const accepted = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      payload('use the deploy credential from the environment'),
    ]);
    expect(accepted.exitCode).toBe(0);
    expect((JSON.parse(accepted.stdout) as { ok: boolean }).ok).toBe(true);
  });

  it('releases the idempotency key when a local source baseline is refused', async () => {
    const key = '01a03014-0000-7000-8000-000000000003';
    const planFile = path.join(f.main, 'baseline-plan.md');
    await writeFile(planFile, '# Baseline plan\n\nClean content.\n', 'utf8');
    const git = gitClient(f.main);
    await git.raw(['remote', 'add', 'origin', `file:///tmp/${FAKE_GH_TOKEN}/repo.git`]);
    const payload = inputFile(
      JSON.stringify({
        idempotency_key: key,
        task: 'capture a local source baseline',
        label: 'capture source baseline',
        plan_steps: [{ text: 'persist the clean pin', label: 'persist pin' }],
        touched_scope: [],
        non_goals: [],
      })
    );
    const before = await snapshotDurableState();

    const refused = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      payload,
    ]);
    expect(refused.exitCode).not.toBe(0);
    const error = JSON.parse(refused.stdout) as {
      error: { code: string; secret_findings?: Array<{ path: string }> };
    };
    expect(error.error).toMatchObject({
      code: 'SECRET_IN_PAYLOAD',
      secret_findings: [expect.objectContaining({ path: 'source_plan.baseline.repo_url' })],
    });
    expect(await snapshotDurableState()).toEqual(before);

    await git.raw(['remote', 'set-url', 'origin', 'file:///tmp/clean/repo.git']);
    const accepted = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      payload,
    ]);
    expect(accepted.exitCode).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ ok: true, idempotency_status: 'created' });
  });

  it('accepts warn-tier quoted code and reports it without blocking', async () => {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'harden the lock helper',
          label: 'harden lock helper',
          plan_steps: [{ text: `refactor ${QUOTED_CODE}`, label: 'refactor step' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      ok: boolean;
      secret_warnings?: Array<{ path: string; patterns: string[] }>;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.secret_warnings).toHaveLength(1);
    expect(envelope.secret_warnings?.[0]?.patterns).toContain('generic-assignment');
  });

  it('scans a warn-tier local source plan and surfaces one deduplicated warning', async () => {
    const planFile = path.join(f.main, 'warn-plan.md');
    await writeFile(planFile, `# Plan\n\n${QUOTED_CODE}\n`, 'utf8');

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      inputFile(
        JSON.stringify({
          task: 'harden the source-plan path',
          label: 'harden source plan',
          plan_steps: [{ text: 'scan the resolved pin', label: 'scan pin' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      secret_warnings?: Array<{ path: string; patterns: string[] }>;
    };
    expect(envelope.secret_warnings).toEqual([
      expect.objectContaining({
        path: 'source_plan.content',
        patterns: expect.arrayContaining(['generic-assignment']),
      }),
    ]);
    expect(res.stdout).not.toContain(QUOTED_CODE);
  });

  it('scans the derived repository branch before persisting a plan', async () => {
    await gitClient(f.main).checkoutLocalBranch(`feature/${WARN_JWT}`);
    const planFile = path.join(f.main, 'clean-plan.md');
    await writeFile(planFile, '# Clean plan\n', 'utf8');

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      inputFile(
        JSON.stringify({
          task: 'capture derived metadata safely',
          label: 'scan branch metadata',
          plan_steps: [{ text: 'capture the plan', label: 'capture plan' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      secret_warnings?: Array<{ path: string; patterns: string[] }>;
    };
    expect(envelope.secret_warnings).toEqual([
      expect.objectContaining({ path: 'branch', patterns: expect.arrayContaining(['jwt']) }),
      expect.objectContaining({
        path: 'source_plan.baseline.branch',
        patterns: expect.arrayContaining(['jwt']),
      }),
    ]);
  });

  it('refuses a local --source-plan file before the pin hash is minted', async () => {
    const planFile = path.join(f.main, 'slice-plan.md');
    await writeFile(planFile, `# Slice\n\nDeploy with ${FAKE_GH_TOKEN}.\n`, 'utf8');
    // Snapshot AFTER the fixture exists, so this measures orcaops' writes
    // rather than the untracked file the test just created.
    const before = await snapshotDurableState();

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      inputFile(
        JSON.stringify({
          task: 'ship the deploy slice',
          label: 'ship deploy slice',
          plan_steps: [{ text: 'wire the deploy', label: 'wire deploy' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).not.toBe(0);
    expect(JSON.parse(res.stdout).error.code).toBe('SECRET_IN_PAYLOAD');
    expect(res.stdout).not.toContain(FAKE_GH_TOKEN);
    expect(await snapshotDurableState()).toEqual(before);
  });

  it('refuses a cloud source pin with both team remedies and no artifact write', async () => {
    await retainApprovedPlan(
      cloudRecord({ body: `# Approved plan\n\nDeploy with ${FAKE_GH_TOKEN}.` })
    );
    const before = await snapshotDurableState();

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'follow the approved plan',
          label: 'follow approved plan',
          plan_steps: [{ text: 'deliver the approved work', label: 'deliver work' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).not.toBe(0);
    const envelope = JSON.parse(res.stdout) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('SECRET_IN_PAYLOAD');
    expect(envelope.error.message).toContain('redact.allow');
    expect(envelope.error.message).toContain('re-approve');
    expect(res.stdout).not.toContain(FAKE_GH_TOKEN);
    expect(await snapshotDurableState()).toEqual(before);
  });

  it('refuses a secret-shaped cloud locator without cloud-content remediation', async () => {
    await retainApprovedPlan(cloudRecord({ external_id: FAKE_GH_TOKEN }));

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      `cloud:${FAKE_GH_TOKEN}@3`,
      '--input',
      inputFile(
        JSON.stringify({
          task: 'follow the approved plan',
          label: 'follow approved plan',
          plan_steps: [{ text: 'deliver the approved work', label: 'deliver work' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).not.toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      error: { code: string; message: string; secret_findings?: Array<{ path: string }> };
    };
    expect(envelope.error).toMatchObject({
      code: 'SECRET_IN_PAYLOAD',
      secret_findings: [expect.objectContaining({ path: 'source_ref.locator' })],
    });
    expect(envelope.error.message).not.toContain('re-approve');
  });

  it('does not attribute an ordinary plan secret to a clean cloud pin', async () => {
    await retainApprovedPlan(cloudRecord());
    await gitClient(f.main).checkoutLocalBranch(`feature/${FAKE_GH_TOKEN}`);
    const before = await snapshotDurableState();

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'follow the approved plan',
          label: 'follow approved plan',
          plan_steps: [{ text: 'deliver the approved work', label: 'deliver work' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).not.toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      error: { code: string; message: string; secret_findings?: Array<{ path: string }> };
    };
    expect(envelope.error.code).toBe('SECRET_IN_PAYLOAD');
    expect(envelope.error.secret_findings?.[0]?.path).toBe('branch');
    expect(envelope.error.message).not.toContain('re-approve');
    expect(res.stdout).not.toContain(FAKE_GH_TOKEN);
    expect(await snapshotDurableState()).toEqual(before);
  });

  it('surfaces a warn-tier cloud source pin without persisting warning details', async () => {
    await retainApprovedPlan(cloudRecord({ body: `# Approved plan\n\n${QUOTED_CODE}` }));

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'follow the approved plan',
          label: 'follow approved plan',
          plan_steps: [{ text: 'deliver the approved work', label: 'deliver work' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      secret_warnings?: Array<{ path: string; patterns: string[] }>;
    };
    expect(envelope.secret_warnings).toEqual([
      expect.objectContaining({
        path: 'source_plan.content',
        patterns: expect.arrayContaining(['generic-assignment']),
      }),
    ]);
    expect(res.stdout).not.toContain(QUOTED_CODE);

    const artifactId = (JSON.parse(res.stdout) as { artifact_id: string }).artifact_id;
    const artifact = readProjectArtifact(f.writer, artifactId)!.thread.artifactJson!;
    expect(artifact).not.toHaveProperty('secret_warnings');
  });

  it('surfaces a warn-tier cloud metadata path', async () => {
    await retainApprovedPlan(cloudRecord({ base_url: `https://cloud.example/${WARN_JWT}` }));

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'follow the approved plan',
          label: 'follow approved plan',
          plan_steps: [{ text: 'deliver the approved work', label: 'deliver work' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      secret_warnings?: Array<{ path: string; patterns: string[] }>;
    };
    expect(envelope.secret_warnings).toEqual([
      expect.objectContaining({
        path: 'source_plan.source_ref.base_url',
        patterns: expect.arrayContaining(['jwt']),
      }),
    ]);
  });

  it('accepts an exactly allowlisted secret in an approved cloud pin', async () => {
    const configPath = await effectiveConfigPath(f.main);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({ ...config, redact: { allow: [FAKE_GH_TOKEN] } }),
      'utf8'
    );
    await retainApprovedPlan(
      cloudRecord({ body: `# Approved plan\n\nDeploy with ${FAKE_GH_TOKEN}.` })
    );

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'follow the approved plan',
          label: 'follow approved plan',
          plan_steps: [{ text: 'deliver the approved work', label: 'deliver work' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('SECRET_IN_PAYLOAD');
    expect(res.stdout).not.toContain('secret_warnings');
  });

  it('exempts an allowlisted string on an outbound verb', async () => {
    // The secret sits in the source-plan file, so this exercises
    // `assertNoSecretsOutbound` (through source-plan-resolver) rather than the
    // capture-payload gate the other cases here cover.
    const configPath = await effectiveConfigPath(f.main);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({ ...config, redact: { allow: [FAKE_GH_TOKEN] } }),
      'utf8'
    );

    const planFile = path.join(f.main, 'slice-plan.md');
    await writeFile(planFile, `# Slice\n\nDeploy with ${FAKE_GH_TOKEN}.\n`, 'utf8');

    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      inputFile(
        JSON.stringify({
          task: 'ship the deploy slice',
          label: 'ship deploy slice',
          plan_steps: [{ text: 'wire the deploy', label: 'wire deploy' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('SECRET_IN_PAYLOAD');
  });

  it('refuses a block-disposition reason supplied as a CLI flag', async () => {
    const res = await agent.runRaw([
      'block',
      'dismiss',
      '--artifact',
      '01a03014-0000-7000-8000-000000000002',
      '--evaluator',
      'core/api-stability',
      '--reason',
      `superseded by ${FAKE_GH_TOKEN}`,
    ]);

    expect(res.exitCode).not.toBe(0);
    // The artifact id is bogus, so UNKNOWN_ARTIFACT is the competing failure.
    // Getting SECRET_IN_PAYLOAD proves the gate runs BEFORE buildContext and
    // before any artifact lookup — which is the whole point of its placement.
    const envelope = JSON.parse(res.stdout) as { error: { code: string } };
    expect(envelope.error.code).toBe('SECRET_IN_PAYLOAD');
    expect(res.stdout).not.toContain(FAKE_GH_TOKEN);
  });

  it.each(['dismiss', 'acknowledge'])(
    'refuses a block-disposition agent session id on %s',
    async (verb) => {
      // agent_session_id is persisted onto the disposition row beside reason,
      // so it needs the same gate.
      const res = await agent.runRaw([
        'block',
        verb,
        '--artifact',
        '01a03014-0000-7000-8000-000000000002',
        '--evaluator',
        'core/api-stability',
        '--reason',
        'superseded',
        '--agent-session-id',
        FAKE_GH_TOKEN,
      ]);

      expect(res.exitCode).not.toBe(0);
      const envelope = JSON.parse(res.stdout) as { error: { code: string } };
      expect(envelope.error.code).toBe('SECRET_IN_PAYLOAD');
      expect(res.stdout).not.toContain(FAKE_GH_TOKEN);
    }
  );

  it.each([
    {
      name: 'plan revision rationale',
      args: [
        'capture',
        'plan',
        'revise',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: '01a03014-0000-7000-8000-000000000003',
            label: 'revised plan',
            plan_steps: [{ text: 'keep the plan current', label: 'keep current' }],
            rationale: `superseded by ${FAKE_GH_TOKEN}`,
            prior_plan_event_id: null,
          })
        ),
      ],
    },
    {
      name: 'checkpoint close summary',
      args: [
        'capture',
        'checkpoint',
        'close',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: '01a03014-0000-7000-8000-000000000003',
            n: 1,
            summary: `delivered with ${FAKE_GH_TOKEN}`,
          })
        ),
      ],
    },
    {
      name: 'checkpoint abandon reason',
      args: [
        'capture',
        'checkpoint',
        'abandon',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: '01a03014-0000-7000-8000-000000000003',
            n: 1,
            reason: `blocked by ${FAKE_GH_TOKEN}`,
          })
        ),
      ],
    },
    {
      name: 'summary outcome',
      args: [
        'capture',
        'summary',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: '01a03014-0000-7000-8000-000000000003',
            outcome: `shipped with ${FAKE_GH_TOKEN}`,
          })
        ),
      ],
    },
  ])('refuses a secret in $name before artifact lookup', async ({ args }) => {
    const res = await agent.runRaw(args);

    expect(res.exitCode).not.toBe(0);
    expect(JSON.parse(res.stdout).error.code).toBe('SECRET_IN_PAYLOAD');
    expect(res.stdout).not.toContain(FAKE_GH_TOKEN);
    expect(res.stderr).not.toContain(FAKE_GH_TOKEN);
  });
});

describe(
  'invalid allowlists are refused without exposing their contents',
  { timeout: 60_000 },
  () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    let agent: ReturnType<typeof makeAgent>;

    const planArgs = (stepText: string): string[] => [
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'ship the deploy slice',
          label: 'ship deploy slice',
          plan_steps: [{ text: stepText, label: 'wire deploy' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ];

    const writeConfig = async (body: string): Promise<void> => {
      await writeFile(await effectiveConfigPath(f.main), body, 'utf8');
    };

    beforeEach(async () => {
      f = await fixture();
      await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
      await writeFile(
        path.join(f.main, '.orcaops', 'config.json'),
        JSON.stringify({ schema_version: 6 })
      );
      agent = makeAgent({
        cwd: f.main,
        env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
      });
    });

    it('refuses a malformed allowlist without echoing its secret', async () => {
      const config = JSON.parse(
        await readFile(await effectiveConfigPath(f.main), 'utf8')
      ) as Record<string, unknown>;
      await writeConfig(JSON.stringify({ ...config, redact: { allow: FAKE_GH_TOKEN } }));

      const before = await inventory(f.temporary);
      const res = await agent.runRaw(planArgs(`deploy with ${FAKE_GH_TOKEN}`));
      expect(await inventory(f.temporary)).toEqual(before);

      expect(JSON.parse(res.stdout).error.code).toBe('INVALID_CONFIG');
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).not.toContain(FAKE_GH_TOKEN);
      expect(res.stdout).not.toContain(FAKE_GH_TOKEN);
    });

    it('refuses unparseable configuration before accepting a capture', async () => {
      await writeConfig('{ not json');

      const before = await inventory(f.temporary);
      const res = await agent.runRaw(planArgs(`deploy with ${FAKE_GH_TOKEN}`));
      expect(await inventory(f.temporary)).toEqual(before);

      expect(JSON.parse(res.stdout).error.code).toBe('INVALID_CONFIG');
      expect(res.exitCode).not.toBe(0);
    });

    it('never echoes the config bytes a JSON parse error quotes back', async () => {
      // `JSON.parse` reports `Unexpected token 'g', "ghp_ABCDEF"... is not valid
      // JSON` — the file it fails on is where dead credentials are written down,
      // so echoing that message would make the diagnostic the leak.
      await writeConfig(`${FAKE_GH_TOKEN} is not json`);

      const res = await agent.runRaw(planArgs('wire the deploy'));

      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).not.toContain(FAKE_GH_TOKEN.slice(0, 12));
      expect(res.stdout).not.toContain(FAKE_GH_TOKEN.slice(0, 12));
    });

    it('stays silent when no config file exists', async () => {
      await rm(await effectiveConfigPath(f.main));

      const res = await agent.runRaw(planArgs('wire the deploy'));

      expect(res.stderr).not.toContain('redact.allow');
    });

    it('stays silent when the config is valid', async () => {
      const res = await agent.runRaw(planArgs('wire the deploy'));

      expect(res.exitCode).toBe(0);
      expect(res.stderr).not.toContain('redact.allow');
      expect(res.stdout).not.toContain('redact-allow-unreadable');
    });
  }
);
