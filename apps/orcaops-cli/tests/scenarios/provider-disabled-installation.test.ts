import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { processingGrantsFilePath } from '../../src/lib/knowledge-processing-grants.js';
import { scenarioWorkflow, type ScenarioWorkflow } from '../helpers/scenario-workflow.js';

/**
 * A whole working session on an installation that never had a provider: `init`, a plan, a
 * checkpoint, a summary, then every read a person or an agent has — and, at the end, the
 * configuration checked in with processing enabled and nobody having consented.
 *
 * Every stage asserts the same three things as well as its own: no grant exists anywhere under
 * the user-local home, the provider was never asked to interpret anything, and the captures are
 * still complete and readable.
 */
const TASK =
  'Notes are flushed to disk before the screen reports them saved, because a technician must ' +
  'not lose a note to a crash.';
const TOUCHED = 'packages/storage/src/notes.ts';

let workflow: ScenarioWorkflow;
let artifactId: string;
let planSteps: { step_id: string; acceptance_criteria: { criterion_id: string }[] }[];

/** No grant file under any directory of the user-local config home. */
async function grantFiles(): Promise<string[]> {
  const home = workflow.configHome;
  const found: string[] = [];
  for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.includes('knowledge-processing-grant'))
      found.push(path.relative(home, path.join(entry.parentPath, entry.name)));
  }
  return found;
}

/** What holds at every stage: nothing consented, and nothing was asked to interpret anything. */
async function assertNothingSpentOrGranted(): Promise<void> {
  expect(await grantFiles()).toEqual([]);
  expect(existsSync(processingGrantsFilePath(workflow.configHome))).toBe(false);
  expect(workflow.providerCalls()).toEqual([]);
}

beforeAll(async () => {
  workflow = await scenarioWorkflow();
}, 120_000);

afterAll(async () => {
  await workflow.cleanup();
});

describe('an installation with no provider', { timeout: 240_000 }, () => {
  it('installs with no knowledge_processing section: processing remains off and no grant is minted', async () => {
    const initialized = await workflow.json([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--agents-md',
    ]);

    expect(initialized.ok).toBe(true);
    const config = JSON.parse(
      await readFile(path.join(workflow.repoPath, '.orcaops', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(config).not.toHaveProperty('knowledge_processing');
    expect(config.llm).toMatchObject({ tool: 'none' });
    await assertNothingSpentOrGranted();
  });

  it('captures a plan, a checkpoint and a summary with no model wait on the success path', async () => {
    const plan = await workflow.json([
      'capture',
      'plan',
      '--input',
      await workflow.inputDocument({
        idempotency_key: `plan-${randomUUID()}`,
        task: TASK,
        label: 'Flushed notes',
        plan_steps: [
          {
            text: 'flush the note before the screen reports it saved',
            label: 'Flush',
            acceptance_criteria: [{ text: 'the note survives a crash' }],
          },
        ],
        touched_scope: ['storage'],
      }),
    ]);
    artifactId = plan.artifact_id as string;
    planSteps = plan.plan_steps as typeof planSteps;

    const opened = await workflow.json([
      'capture',
      'checkpoint',
      'open',
      '--input',
      await workflow.inputDocument({
        idempotency_key: `open-${randomUUID()}`,
        artifact_id: artifactId,
        declared_step_ids: planSteps.map((step) => step.step_id),
      }),
    ]);
    await workflow.json([
      'capture',
      'checkpoint',
      'close',
      '--input',
      await workflow.inputDocument({
        idempotency_key: `close-${randomUUID()}`,
        artifact_id: artifactId,
        n: opened.n,
        summary: 'The note is written and fsynced before the reply.',
        files_changed: [TOUCHED],
        verification: [{ command: 'pnpm vitest run notes', exit_code: 0 }],
        completed_step_ids: planSteps.map((step) => step.step_id),
        done_criteria: planSteps.flatMap((step) =>
          step.acceptance_criteria.map((criterion) => ({
            criterion_id: criterion.criterion_id,
            evidence: 'the crash test passes',
          }))
        ),
      }),
    ]);
    await workflow.json([
      'capture',
      'summary',
      '--input',
      await workflow.inputDocument({
        idempotency_key: `summary-${randomUUID()}`,
        artifact_id: artifactId,
        outcome: 'Notes are flushed before the reply.',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
      }),
    ]);

    const shown = await workflow.json(['show', artifactId, '--json']);
    expect(shown.artifact).toMatchObject({ state: 'summarized' });
    await assertNothingSpentOrGranted();
  });

  it('reports processing off with the coverage claim not_processed and no consent to evaluate', async () => {
    const status = await workflow.json(['knowledge', 'status', '--json']);

    // The plan, the checkpoint close and the summary each admitted a job. Admission is
    // unconditional; what processing being off means is that nothing ever claims one.
    expect(status).toMatchObject({
      enabled: false,
      consent: null,
      coverage: { enabled: false, claim: 'not_processed', completed_through: null },
      queue: { jobs: { pending: 3 }, openAttempts: 0 },
      lease: null,
    });
    expect((status.coverage as { statement: string }).statement).toContain(
      'claims no completeness'
    );
    await assertNothingSpentOrGranted();
  });

  it('answers a lookup of every adopted rule, and a text lookup, claiming no completeness', async () => {
    const adopted = await workflow.json(['knowledge', 'lookup', '--adopted', '--json']);
    expect(adopted).toMatchObject({ applicable: [], entries: [] });
    expect(adopted.coverage).toMatchObject({
      processing: { enabled: false, claim: 'not_processed' },
    });

    const text = await workflow.json(['knowledge', 'lookup', 'flushed to disk', '--json']);
    expect(text.coverage).toMatchObject({
      processing: { enabled: false, claim: 'not_processed' },
    });
    expect(
      ((text.coverage as { processing: { statement: string } }).processing as { statement: string })
        .statement
    ).toContain('claims no completeness');
    await assertNothingSpentOrGranted();
  });

  it('answers search from the raw captures, claiming no completeness for what processing covered', async () => {
    const found = await workflow.json(['search', 'flushed to disk', '--json']);

    expect((found.results as unknown[]).length).toBeGreaterThan(0);
    expect((found.knowledge as { groups: unknown[] }).groups).toEqual([]);
    expect(
      (found.knowledge as { coverage: { processing: unknown } }).coverage.processing
    ).toMatchObject({ enabled: false, claim: 'not_processed', completed_through: null });
    await assertNothingSpentOrGranted();
  });

  it('reports the artifact through status, complete and readable', async () => {
    const status = await workflow.json(['status', '--json']);

    expect(status).toMatchObject({ ok: true });
    expect(JSON.stringify(status)).toContain(artifactId);
    await assertNothingSpentOrGranted();
  });

  it('traces consequences for the captured work, claiming no complete impact coverage', async () => {
    const traced = await workflow.json([
      'knowledge',
      'consequences',
      '--touching',
      TOUCHED,
      '--json',
    ]);

    const answers = traced.answers as {
      affected: { key: string }[];
      coverage: { statement: string };
    }[];
    expect(answers[0]?.affected.map((item) => item.key)).toContain(`artifact:${artifactId}`);
    expect(answers[0]?.coverage.statement).toContain('it is not complete impact coverage');
    expect(traced.coverage).toMatchObject({ processing: { claim: 'not_processed' } });
    await assertNothingSpentOrGranted();
  });

  it('explains the limitation in doctor, handing no work back to the capturing agent', async () => {
    const doctored = await workflow.run(['doctor', '--json']);

    expect(doctored.exitCode === 0 || doctored.exitCode === 1).toBe(true);
    const check = (
      JSON.parse(doctored.stdout) as { checks: { name: string; status: string; summary: string }[] }
    ).checks.find((entry) => entry.name === 'knowledge-processing');
    expect(check).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('no captured content is sent to a model'),
    });
    await assertNothingSpentOrGranted();
  });

  it('reports CONSENT_DENIED before provider construction once configuration enables it', async () => {
    await workflow.writeConfig({
      schema_version: 8,
      install: { scope: 'project' },
      knowledge_processing: { enabled: true },
    });

    const status = await workflow.json(['knowledge', 'status', '--json']);

    expect(status.enabled).toBe(true);
    expect(status.consent).toMatchObject({
      ok: false,
      code: 'CONSENT_DENIED',
      reason: 'no_grant',
    });
    await assertNothingSpentOrGranted();
  });

  it('keeps capture and deterministic retrieval working while consent is denied', async () => {
    const plan = await workflow.json([
      'capture',
      'plan',
      '--input',
      await workflow.inputDocument({
        idempotency_key: `plan-${randomUUID()}`,
        task: 'A second task, captured while nobody has consented to processing.',
        label: 'Denied consent',
        plan_steps: [
          {
            text: 'capture while consent is denied',
            label: 'Capture',
            acceptance_criteria: [{ text: 'the capture is retained' }],
          },
        ],
        touched_scope: ['storage'],
      }),
    ]);

    expect(plan.ok).toBe(true);
    const found = await workflow.json(['search', 'flushed to disk', '--json']);
    expect((found.results as unknown[]).length).toBeGreaterThan(0);
    const shown = await workflow.json(['show', artifactId, '--json']);
    expect(shown.artifact).toMatchObject({ state: 'summarized' });
    const status = await workflow.json(['knowledge', 'status', '--json']);
    expect(status.consent).toMatchObject({ code: 'CONSENT_DENIED' });
    expect(status.queue).toMatchObject({ jobs: { pending: 4 }, openAttempts: 0 });
    expect(status.lease).toBeNull();
    await assertNothingSpentOrGranted();
  });
});
