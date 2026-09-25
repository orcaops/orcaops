import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CONFIG_SCHEMA_VERSION, uuidv7 } from '@orcaops/storage';
import { appendProjectCorrection, type ProjectDatabase } from '@orcaops/storage/history/database';

import { PROJECT_DATABASE_SCHEMA_VERSION } from '../../../../packages/storage/src/history/database/schema.js';
import { knowledgeEnableAction } from '../../src/commands/knowledge/enable.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { InteractiveConsentConfirmation } from '../../src/lib/knowledge-processing-grants.js';
import { instructionSource, OWNER } from '../helpers/knowledge-records.js';
import { placeReleasedProjectDatabase } from '../helpers/released-project-database.js';
import { scenarioWorkflow, type ScenarioWorkflow } from '../helpers/scenario-workflow.js';

/**
 * A project that was last written by the released 0.2.1 build, taken all the way to background
 * processing: the passive read that asks for an upgrade, the upgrade behind its backup, the
 * history read back, a new capture, consent, the worker, what it published, and a correction.
 *
 * Consent can only be given at a terminal, so enable is driven through the seam it declares for
 * tests; `tests/smoke/knowledge-enable.test.ts` is what proves a pipe cannot give it.
 */
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(() => true),
}));

const RELEASED_SCHEMA_VERSION = 29;

/** The four the plan's row names: captured history, adoptions, evidence, and receipts. */
const CARRIED_TABLES = ['artifact_events', 'adoptions', 'assessments', 'operations'];

const CONSENT_TERMINAL = {
  isInteractive: () => true,
  ask: () => Promise.resolve('yes'),
  confirm: InteractiveConsentConfirmation.forTermsAcceptedAtTerminal.bind(
    InteractiveConsentConfirmation
  ),
};

let workflow: ScenarioWorkflow;
let databaseFile: string;
let projectDirectory: string;
let writer: ProjectDatabase;
/** What the released database held, read before the upgrade and compared after it. */
let carried: Record<string, string[]>;
let capturedArtifactId: string;
let candidate: { requirementId: string; revisionId: string; statement: string };
let beforeTheCorrection: number;
let answerBeforeTheCorrection: Record<string, unknown>;
let withdrawalId: string;

const configDocument = (knowledgeProcessing?: Record<string, unknown>) => ({
  schema_version: knowledgeProcessing === undefined ? 6 : CONFIG_SCHEMA_VERSION,
  install: { scope: 'project' },
  llm: { tool: 'claude' },
  ...(knowledgeProcessing === undefined ? {} : { knowledge_processing: knowledgeProcessing }),
});

const PROCESSING = { enabled: true, idle_exit_ms: 1_000, max_calls_per_hour: 60 };

/** Every file of the project directory, so "changed nothing" is about bytes. */
async function projectFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(projectDirectory, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (file.endsWith('-shm') || entry.isDirectory()) continue;
    const bytes = await readFile(file);
    if (file.endsWith('-wal') && bytes.length === 0) continue;
    files[path.relative(projectDirectory, file)] = createHash('sha256').update(bytes).digest('hex');
  }
  return files;
}

/**
 * The rows of the tables the upgrade must carry, read from a copy: this build refuses to open a
 * released store, and no shipped verb reads one, so the comparison is taken beside it rather than
 * by opening the database the workflow is about.
 */
async function carriedRows(file: string): Promise<Record<string, string[]>> {
  const at = await mkdtemp(path.join(tmpdir(), 'orcaops-carried-'));
  try {
    const copy = path.join(at, 'history.sqlite3');
    await copyFile(file, copy);
    if (existsSync(`${file}-wal`)) await copyFile(`${file}-wal`, `${copy}-wal`);
    const database = new Database(copy, { fileMustExist: true });
    try {
      return Object.fromEntries(
        CARRIED_TABLES.map((table) => [
          table,
          (database.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[])
            .map((row) => JSON.stringify(row, Object.keys(row).sort()))
            .sort(),
        ])
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(at, { recursive: true, force: true });
  }
}

/**
 * What has to come back the same at the boundary: everything but the two fields that say the
 * answer is a reproduction — the annotations a later correction adds, and the read mode, which
 * says the same boundary was read as history rather than as now.
 */
function reproducedEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const {
    later_annotations: _annotations,
    basis,
    ...resolved
  } = entry.resolved as Record<string, unknown>;
  const { mode: _mode, ...read } = basis as Record<string, unknown>;
  return { ...entry, resolved: { ...resolved, basis: read } };
}

function schemaVersionOf(file: string): number {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return database.pragma('user_version', { simple: true }) as number;
  } finally {
    database.close();
  }
}

const capturePlan = async (task: string, label: string) =>
  workflow.json([
    'capture',
    'plan',
    '--input',
    await workflow.inputDocument({
      idempotency_key: `plan-${randomUUID()}`,
      task,
      label,
      plan_steps: [
        {
          text: 'keep what the released build wrote',
          label: 'Keep',
          acceptance_criteria: [{ text: 'every row is still there' }],
        },
      ],
      touched_scope: ['storage'],
    }),
  ]);

const jobs = () =>
  writer.read((view) =>
    view.all<{ jobId: string; sourceId: string; state: string; attempts: number }>(
      `SELECT job_id AS jobId, source_id AS sourceId, state,
         (SELECT count(*) FROM processing_attempts a WHERE a.job_id = j.job_id) AS attempts
       FROM processing_jobs j ORDER BY admitted_at, job_id`
    )
  ).value;

beforeAll(async () => {
  workflow = await scenarioWorkflow({ database: true });
  await workflow.writeConfig(configDocument());
  writer = await workflow.open();
  databaseFile = writer.databasePath;
  projectDirectory = path.dirname(databaseFile);
  await placeReleasedProjectDatabase(writer);
}, 240_000);

afterAll(async () => {
  await workflow.cleanup();
});

describe('a released project taken to background processing', { timeout: 300_000 }, () => {
  it('reports that an explicit upgrade is required, and migrates nothing during the read', async () => {
    expect(schemaVersionOf(databaseFile)).toBe(RELEASED_SCHEMA_VERSION);
    const before = await projectFiles();

    const listed = await workflow.json(['list', '--json']);
    expect(listed).toMatchObject({
      completeness: {
        complete: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'HISTORY_UPGRADE_REQUIRED',
            message: expect.stringContaining('orcaops history upgrade'),
          }),
        ]),
      },
    });
    const status = await workflow.json(['knowledge', 'status', '--json']);
    expect(status.history_problem).toMatchObject({ code: 'upgrade_required' });
    expect(status.queue).toBeNull();

    expect(await projectFiles()).toEqual(before);
    expect(schemaVersionOf(databaseFile)).toBe(RELEASED_SCHEMA_VERSION);
    carried = await carriedRows(databaseFile);
    expect(carried.artifact_events.length).toBeGreaterThan(0);
  });

  it('upgrades behind a backup whose manifest verifies', async () => {
    const applied = await workflow.json(['history', 'upgrade', '--apply', '--json']);

    expect(applied).toMatchObject({
      mode: 'apply',
      changed: true,
      state: 'upgraded',
      from_version: RELEASED_SCHEMA_VERSION,
      to_version: PROJECT_DATABASE_SCHEMA_VERSION,
    });
    const backup = applied.backup as { name: string; database_file: string };
    const listed = await workflow.json(['history', 'backups', '--json']);
    expect(listed.backups).toEqual([
      expect.objectContaining({
        name: backup.name,
        source_schema_version: RELEASED_SCHEMA_VERSION,
      }),
    ]);
    // A backup whose manifest cannot be verified is listed with the reason it cannot be used.
    expect((listed.backups as Record<string, unknown>[])[0]).toMatchObject({ unreadable: null });
    expect(schemaVersionOf(databaseFile)).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
  });

  it('preserves the captured history, adoptions, evidence and receipts exactly', async () => {
    expect(await carriedRows(databaseFile)).toEqual(carried);

    const listed = await workflow.json(['list', '--json']);
    expect((listed.results as unknown[]).length).toBeGreaterThan(0);
    expect(listed.completeness).toMatchObject({ complete: true });
  });

  it('admits nothing from the released history, and one job for a new capture', async () => {
    writer = await workflow.open();
    expect(jobs()).toEqual([]);

    const plan = await capturePlan(
      'Rows the released build wrote are still readable after the upgrade.',
      'After the upgrade'
    );
    capturedArtifactId = plan.artifact_id as string;

    // The upgraded store holds the released build's artifacts, and not one of them is queued.
    const released = writer.read((view) =>
      view.get<{ n: number }>('SELECT count(*) AS n FROM artifacts WHERE artifact_id <> ?', [
        capturedArtifactId,
      ])
    ).value;
    expect(released?.n).toBeGreaterThan(0);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ sourceId: plan.plan_event_id, state: 'pending' });
    expect(workflow.providerCalls()).toEqual([]);
  });

  it('discloses the waiting backlog, and covers it only because consent said so', async () => {
    await workflow.writeConfig(configDocument(PROCESSING));
    const shown: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      shown.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runInInvocationContext(
        { cwd: workflow.repoPath, env: { ...process.env, ...workflow.env() } },
        () =>
          knowledgeEnableAction({
            terminal: CONSENT_TERMINAL,
            json: true,
            includeBacklog: true,
          })
      );
    } finally {
      process.stderr.write = write;
    }

    expect(shown.join('')).toContain('Already waiting: 1 job is admitted and waiting.');
    expect(shown.join('')).toContain('Existing captures: sent.');
    const { grants } = JSON.parse(
      await readFile(path.join(workflow.configHome, 'knowledge-processing-grants.json'), 'utf8')
    ) as { grants: { source_scope: { backlog: string } }[] };
    expect(grants.map((grant) => grant.source_scope.backlog)).toEqual(['included']);
    expect(workflow.providerCalls()).toEqual([]);
  });

  it('interprets the new capture only, spending one call on it', async () => {
    const worked = await workflow.run(['knowledge', 'worker']);

    expect(worked.stdout).toContain('Took the processing lease');
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ state: 'completed', attempts: 1 });
    expect(workflow.providerCalls()).toHaveLength(1);
  });

  it('publishes what the model proposed as an unadopted candidate', async () => {
    const published = writer.read((view) =>
      view.all<{
        requirementId: string;
        revisionId: string;
        sourceStanding: string;
        attributedKind: string;
      }>(
        `SELECT requirement_id AS requirementId, revision_id AS revisionId,
           source_standing AS sourceStanding, attributed_kind AS attributedKind
           FROM requirement_revisions`
      )
    ).value;
    expect(published).toHaveLength(1);
    // What the model read out of the source is a candidate a detector proposed, whatever it says.
    expect(published[0]).toMatchObject({
      sourceStanding: 'extracted_candidate',
      attributedKind: 'detector',
    });

    const identity = `requirement:${published[0]!.requirementId}`;
    const answer = await workflow.json(['knowledge', 'lookup', '--identity', identity, '--json']);

    // Nothing adopted it, so it is background for any work that asks.
    expect(answer.applicable).toEqual([]);
    expect(answer.background).toEqual([identity]);
    const entry = (answer.entries as { revisions: { standing: string; statement: string }[] }[])[0];
    // Nothing selected it in any scope, so no revision of it governs anything.
    expect(entry?.revisions[0]?.standing).toBe('not_standing');
    expect(entry?.revisions[0]?.statement).toEqual(expect.any(String));
    candidate = {
      requirementId: published[0]!.requirementId,
      revisionId: published[0]!.revisionId,
      statement: entry!.revisions[0]!.statement,
    };
    beforeTheCorrection = writer.read(() => null).counters.writeSequence;
    answerBeforeTheCorrection = entry as unknown as Record<string, unknown>;
  });

  it('withdraws the candidate through the storage correction writer, which no verb exposes', async () => {
    const target = {
      kind: 'requirement' as const,
      entity_id: candidate.requirementId,
      revision_id: candidate.revisionId,
    };
    const instruction = await instructionSource(
      writer,
      'Withdraw the candidate: it is not a product promise.'
    );
    const published = await appendProjectCorrection(writer, {
      operationId: uuidv7(),
      action: {
        action_id: uuidv7(),
        kind: 'withdrawal',
        targets: [target],
        scope: { kind: 'project', project_id: (await workflow.authority()).projectId },
        source_id: instruction,
        authorization: {
          kind: 'informed_instruction',
          instruction_source_id: instruction,
          acknowledged: [target],
          scope: { kind: 'project', project_id: (await workflow.authority()).projectId },
        },
        expected_state: { kind: 'observed', selection_ids: [], correction_action_ids: [] },
        reason: 'The candidate is not a product promise.',
      },
      attributedTo: { kind: 'actor', actor: OWNER },
      recordedAt: '2026-09-18T12:00:00.000Z',
      secretAllow: [],
    });

    expect(published.value.actionId).toMatch(/^[0-9a-f-]{36}$/u);
    const now = await workflow.json([
      'knowledge',
      'lookup',
      '--identity',
      `requirement:${candidate.requirementId}`,
      '--json',
    ]);
    const entry = (
      now.entries as { resolved: { governing_state: { correction_action_ids: string[] } } }[]
    )[0];
    expect(entry?.resolved.governing_state.correction_action_ids).toContain(
      published.value.actionId
    );
    withdrawalId = published.value.actionId;
  });

  it('reproduces the earlier answer at the boundary before the correction', async () => {
    const then = await workflow.json([
      'knowledge',
      'lookup',
      '--identity',
      `requirement:${candidate.requirementId}`,
      '--at-boundary',
      String(beforeTheCorrection),
      '--json',
    ]);

    expect(then.basis).toMatchObject({
      knowledge_boundary: beforeTheCorrection,
      mode: 'historical',
    });
    const entry = (then.entries as Record<string, unknown>[])[0]!;
    expect(reproducedEntry(entry)).toEqual(reproducedEntry(answerBeforeTheCorrection));
    expect(
      (
        (entry.resolved as { later_annotations: { record_id: string }[] }).later_annotations ?? []
      ).map((later) => later.record_id)
    ).toContain(withdrawalId);
    expect(
      (entry.resolved as { governing_state: { correction_action_ids: string[] } }).governing_state
        .correction_action_ids
    ).toEqual([]);
    // The correction is separately dated: it annotates the historical answer, never its basis.
    expect(
      (then.later_annotations as { record_id: string }[]).map((later) => later.record_id)
    ).toContain(withdrawalId);
  });

  it('stops future calls once processing is disabled', async () => {
    const disabled = await workflow.json(['knowledge', 'disable', '--json']);
    expect(disabled).toMatchObject({ enabled: false });

    await capturePlan('A capture made after processing was disabled.', 'After disable');
    const worked = await workflow.run(['knowledge', 'worker']);

    expect(workflow.providerCalls()).toHaveLength(1);
    expect(jobs().filter((job) => job.state === 'pending')).toHaveLength(1);
    expect(worked.stdout).not.toContain('settled as succeeded');
  });
});
