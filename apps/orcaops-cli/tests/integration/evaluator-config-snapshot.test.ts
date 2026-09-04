import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const configReadMutation = vi.hoisted(() => ({
  reads: 0,
  mutateAfterRead: null as number | null,
  replacement: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const originalReadFile = actual.readFile as unknown as (...args: unknown[]) => Promise<unknown>;
  const originalWriteFile = actual.writeFile as unknown as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      const contents = await originalReadFile(...args);
      const candidate = String(args[0]).replaceAll('\\', '/');
      if (candidate.endsWith('/.orcaops/evaluators.yaml')) {
        configReadMutation.reads += 1;
        if (configReadMutation.reads === configReadMutation.mutateAfterRead) {
          await originalWriteFile(args[0], configReadMutation.replacement, 'utf8');
        }
      }
      return contents;
    },
  };
});

const VALID_EMPTY_CONFIG = [
  'schema: orcaops.evaluator_config/v2',
  'runtime:',
  '  max_concurrent: 1',
  'packages: []',
  'evaluators: {}',
  '',
].join('\n');

describe('evaluator config discovery snapshot', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { CLAUDE_SESSION_ID: 'config-snapshot-test' } });
    resetMutation();
  });

  afterEach(async () => {
    resetMutation();
    await repo.cleanup();
  });

  async function initialize(): Promise<void> {
    const result = await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    expect(result.exitCode).toBe(0);
    await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(repo.path, '.orcaops', 'evaluators.yaml'),
      VALID_EMPTY_CONFIG,
      'utf8'
    );
  }

  function resetMutation(): void {
    configReadMutation.reads = 0;
    configReadMutation.mutateAfterRead = null;
    configReadMutation.replacement = '';
  }

  function mutateAfterRead(readNumber: number): void {
    configReadMutation.reads = 0;
    configReadMutation.mutateAfterRead = readNumber;
    configReadMutation.replacement = 'schema: [';
  }

  it('lifecycle dispatch keeps config and eligibility from one discovery read', async () => {
    await initialize();
    mutateAfterRead(1);

    const result = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: randomUUID(),
          task: 'test lifecycle config snapshot',
          label: 'config-snapshot',
          plan_steps: [{ text: 'one step', label: 'one-step' }],
        })
      ),
    ]);

    expect(result.exitCode).toBe(0);
    expect(configReadMutation.reads).toBe(1);
  });

  it('checkpoint-open trust and dispatch keep the discovery config snapshot', async () => {
    await initialize();
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: randomUUID(),
          task: 'test checkpoint config snapshot',
          label: 'checkpoint-config-snapshot',
          plan_steps: [{ text: 'one step', label: 'one-step' }],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);
    const captured = JSON.parse(plan.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    await writeFile(
      path.join(repo.path, '.orcaops', 'evaluators.yaml'),
      VALID_EMPTY_CONFIG,
      'utf8'
    );
    mutateAfterRead(1);

    const result = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: randomUUID(),
          artifact_id: captured.artifact_id,
          declared_step_ids: [captured.plan_steps[0]?.step_id],
        })
      ),
    ]);

    expect(result.exitCode).toBe(0);
    expect(configReadMutation.reads).toBe(1);
  });

  it('Doctor trust diagnostics use the same config discovery that supplies evaluators', async () => {
    await initialize();
    mutateAfterRead(3);

    const result = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; status: string }>;
    };

    expect(result.exitCode).toBe(0);
    expect(report.checks.find((check) => check.name === 'command-evaluator-trust')?.status).toBe(
      'pass'
    );
    expect(configReadMutation.reads).toBe(3);
  });
});
