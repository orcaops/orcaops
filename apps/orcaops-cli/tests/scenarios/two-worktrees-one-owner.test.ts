import { randomUUID } from 'node:crypto';
import { isatty } from 'node:tty';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ProjectDatabase } from '@orcaops/storage/history/database';

import { knowledgeEnableAction } from '../../src/commands/knowledge/enable.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { InteractiveConsentConfirmation } from '../../src/lib/knowledge-processing-grants.js';
import { scenarioWorkflow, type ScenarioWorkflow } from '../helpers/scenario-workflow.js';

/**
 * Two checkouts of one repository, one project database, and both of them starting a worker at
 * the same moment.
 *
 * The consent the workflow rests on can only be given at a terminal, so the enable command is
 * driven through the terminal seam it declares for tests; `tests/smoke/knowledge-enable.test.ts`
 * is what proves a pipe cannot give it.
 */
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(() => true),
}));

const PROCESSING = {
  enabled: true,
  // The smallest idle interval the configuration allows, so a drained worker exits at once.
  idle_exit_ms: 1_000,
  max_calls_per_hour: 60,
};

const configDocument = () => ({
  schema_version: 8,
  install: { scope: 'project' },
  llm: { tool: 'claude' },
  knowledge_processing: PROCESSING,
});

const CONSENT_TERMINAL = {
  isInteractive: () => true,
  ask: () => Promise.resolve('yes'),
  confirm: InteractiveConsentConfirmation.forTermsAcceptedAtTerminal.bind(
    InteractiveConsentConfirmation
  ),
};

let workflow: ScenarioWorkflow;
let second: string;
let writer: ProjectDatabase;
const captured: Record<string, string> = {};

interface Job {
  jobId: string;
  state: string;
  attempts: number;
}

const jobs = (): Job[] =>
  writer.read((view) =>
    view.all<Job>(
      `SELECT job_id AS jobId, state,
         (SELECT count(*) FROM processing_attempts a WHERE a.job_id = j.job_id) AS attempts
       FROM processing_jobs j ORDER BY admitted_at, job_id`
    )
  ).value;

async function capturePlan(cwd: string, label: string): Promise<string> {
  const plan = await workflow.json(
    [
      'capture',
      'plan',
      '--input',
      await workflow.inputDocument({
        idempotency_key: `plan-${randomUUID()}`,
        task: `${label}: notes are flushed to disk before the screen reports them saved.`,
        label,
        plan_steps: [
          {
            text: 'flush the note before the screen reports it saved',
            label: 'Flush',
            acceptance_criteria: [{ text: 'the note survives a crash' }],
          },
        ],
        touched_scope: ['storage'],
      }),
    ],
    { cwd, env: { ORCAOPS_ROOT: cwd } }
  );
  return plan.artifact_id as string;
}

const worker = (cwd: string) =>
  workflow.run(['knowledge', 'worker'], { cwd, env: { ORCAOPS_ROOT: cwd } });

beforeAll(async () => {
  workflow = await scenarioWorkflow({ database: true });
  await workflow.writeConfig(configDocument());
  second = await workflow.addWorktree('second-worktree', configDocument());
  writer = await workflow.open();
}, 180_000);

afterAll(async () => {
  await workflow.cleanup();
});

describe('two worktrees sharing one project database', { timeout: 240_000 }, () => {
  it('records one consent for the project, covering captures from now on', async () => {
    vi.mocked(isatty).mockReturnValue(true);
    const enabled = await runInInvocationContext(
      { cwd: workflow.repoPath, env: { ...process.env, ...workflow.env() } },
      () => knowledgeEnableAction({ terminal: CONSENT_TERMINAL, json: true })
    ).then(() => workflow.json(['knowledge', 'status', '--json']));

    expect(enabled.consent).toMatchObject({ ok: true });
    expect(enabled.enabled).toBe(true);
    expect(workflow.providerCalls()).toEqual([]);
  });

  it('admits one job for each capture, in the one database both worktrees share', async () => {
    captured.first = await capturePlan(workflow.repoPath, 'First worktree');
    captured.second = await capturePlan(second, 'Second worktree');

    expect(jobs()).toHaveLength(2);
    expect(jobs().every((job) => job.state === 'pending')).toBe(true);
    expect(workflow.providerCalls()).toEqual([]);
  });

  it('leaves one active owner when both invocations start a worker together', async () => {
    const [fromFirst, fromSecond] = await Promise.all([worker(workflow.repoPath), worker(second)]);

    const outputs = [fromFirst.stdout, fromSecond.stdout];
    expect(outputs.join('').match(/Took the processing lease/gu)).toHaveLength(1);
    expect(outputs.filter((output) => output.includes('lease_held_by_other'))).toHaveLength(1);
    expect(writer.read(() => null).counters.writeSequence).toBeGreaterThan(0);
  });

  it('settles every job once, with no duplicate paid call', async () => {
    // The starter that lost the lease exited without claiming, so whatever the owner had not
    // drained when it exited is what this second invocation settles.
    if (jobs().some((job) => job.state !== 'completed')) await worker(workflow.repoPath);

    expect(jobs().map((job) => ({ state: job.state, attempts: job.attempts }))).toEqual([
      { state: 'completed', attempts: 1 },
      { state: 'completed', attempts: 1 },
    ]);
    expect(workflow.providerCalls()).toHaveLength(2);
  });

  it('preserves each capture’s own result, whichever worktree interpreted it', async () => {
    for (const [worktree, artifactId] of Object.entries(captured)) {
      const shown = await workflow.json(['show', artifactId, '--section', 'plan', '--json']);
      expect(shown.content).toMatchObject({
        task: expect.stringContaining('notes are flushed to disk'),
      });
      expect(JSON.stringify(shown.content)).toContain(
        `${worktree === 'first' ? 'First' : 'Second'} worktree: notes are flushed`
      );
    }
    const lease = writer.read((view) =>
      view.get<{ ownerId: string | null }>('SELECT owner_id AS ownerId FROM processing_lease')
    ).value;
    expect(lease?.ownerId ?? null).toBeNull();
  });
});
