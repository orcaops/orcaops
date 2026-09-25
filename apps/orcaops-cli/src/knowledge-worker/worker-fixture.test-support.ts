import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PROCESSOR_CONTRACT } from '@orcaops/core';
import { requireDatabaseExecutionContext } from '@orcaops/core/history/database-checkout';
import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { CONFIG_SCHEMA_VERSION, prepareArtifactDraft, uuidv7 } from '@orcaops/storage';
import {
  admitProcessingJob,
  appendProjectArtifactEvents,
  appendProjectExecutionCapture,
  openProjectDatabase,
  processingDispatchContext,
  type ProcessingJob,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  readProcessingJob,
  readProcessingJobAttempts,
  readProcessingLease,
  readProjectArtifact,
  runProjectOperation,
} from '@orcaops/storage/history/database';
import { recordChecksum } from '@orcaops/storage/history/primitives';
import { createTempRepo } from '@orcaops/test-harness';

import {
  InteractiveConsentConfirmation,
  type ProcessingGrantTerms,
  recordProcessingGrant,
} from '../lib/knowledge-processing-grants.js';

/**
 * A real project database in a temporary root, a real git worktree with its own
 * configuration, a user-local grant recorded through the store API, and a fake
 * provider on the binary override. Everything the worker touches is real except
 * the provider, which is never a paid one.
 */

const run = promisify(execFile);

export const FAKE_CLAUDE = fileURLToPath(
  new URL('../../../../packages/llm/src/fixtures/fake-claude-provider.mjs', import.meta.url)
);

export const KNOWLEDGE_PROPOSER = fileURLToPath(
  new URL('./fixtures/fake-knowledge-proposer.mjs', import.meta.url)
);

export interface WorkerFixtureOptions {
  /** What the worktree's `knowledge_processing` section says. */
  processing?: Record<string, unknown>;
  /** What the worktree's `llm` section says. */
  llm?: Record<string, unknown>;
  /** The passage the admitted capture carries. */
  task?: string;
  /** Terms the recorded grant discloses, merged over the defaults. */
  grant?: Partial<ProcessingGrantTerms>;
  /** Skip recording a grant at all. */
  withoutGrant?: boolean;
  /** The provider script the binary override points at. */
  provider?: string;
  /** Which provider adapter the fixture drives. */
  providerId?: 'claude' | 'codex';
  /** What `FAKE_PROVIDER_BEHAVIOR` tells the fake Claude provider to do. */
  behavior?: string;
  /** What the scripted knowledge proposer answers with. */
  proposerAnswer?: 'statement' | 'empty' | 'wrong-manifest' | 'invalid' | 'scripted';
}

export interface AdmittedJobOptions {
  task?: string;
  /**
   * What the capture is allowed to carry, as a person's own `redact.allow` lets it. Background
   * processing has no such list, so this is how a source reaches the store with content the
   * writers will refuse when the worker tries to publish it.
   */
  secretAllow?: readonly string[];
  withoutModel?: boolean;
  /** Leave out the dispatch context admission is meant to retain. */
  withoutDispatchContext?: boolean;
  worktreeRoot?: string;
  originKind?: 'captured' | 'git-import';
  path?: string;
  derivedByProcessing?: boolean;
  processorContract?: string;
  eventType?: 'plan_captured' | 'summary_captured';
  /**
   * Give the artifact a git-import origin while admitting it through a live
   * path, which is the imported source the plan expects dispatch to refuse on
   * its own rather than trusting what admission recorded.
   */
  importedOrigin?: boolean;
}

function planPayload(
  artifactId: string,
  revision: number,
  task: string,
  priorEventId: string | null,
  imported: boolean
) {
  return {
    schema_version: 4,
    ...(imported
      ? {
          origin: {
            kind: 'git-import',
            imported_at: '2026-08-01T00:00:00.000Z',
            tool_version: '0.2.1',
            source_range: 'HEAD~3..HEAD',
            authors: ['a person'],
            enriched_at: null,
          },
        }
      : {}),
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'original base',
    agent: 'claude-code',
    agent_session_id: null,
    task,
    label: 'Captured plan',
    plan_steps: [
      {
        step_id: uuidv7(),
        text: task.trim().length === 0 ? task : 'Retain the original capture',
        label: 'Original capture',
        acceptance_criteria: [],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-09-01T00:00:00Z',
    revision_n: revision,
    revised_at: revision === 0 ? null : `2026-09-01T00:0${revision}:00Z`,
    rationale: revision === 0 ? null : 'Restate the plan',
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: priorEventId,
  };
}

function planEventBytes(
  artifactId: string,
  revision: number,
  task: string,
  priorEventId: string | null,
  imported: boolean
) {
  const type = revision === 0 ? 'plan_captured' : 'plan_revised';
  const event = {
    event_id: uuidv7(),
    type,
    ts: '2026-09-01T00:00:00Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: planPayload(artifactId, revision, task, priorEventId, imported),
  };
  return {
    eventId: event.event_id,
    type: type as 'plan_captured' | 'plan_revised',
    bytes: Buffer.from(`${JSON.stringify({ ...event, checksum: recordChecksum(event) })}\n`),
  };
}

/** What `capture plan` writes, in the shape the plan schema accepts. */
function livePlan(artifactId: string, task: string) {
  return {
    schema_version: 4 as const,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'a'.repeat(40),
    agent: 'claude-code' as const,
    agent_session_id: null,
    task,
    label: 'Captured plan',
    plan_steps: [
      {
        step_id: uuidv7(),
        text: 'Retain the original capture',
        label: 'Original capture',
        acceptance_criteria: [{ criterion_id: uuidv7(), text: 'the capture is retained' }],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-09-01T00:00:00.000Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    prior_plan_event_id: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
  };
}

/**
 * Every table one interpretation publication can write. A test that says the worker published
 * nothing counts these: without them, moving the publication ahead of the checks that must come
 * first would leave every assertion about the attempt passing.
 */
const PUBLISHABLE_TABLES: readonly string[] = [
  'knowledge_sources',
  'requirements',
  'requirement_revisions',
  'decisions',
  'decision_revisions',
  'claims',
  'claim_revisions',
  'claim_revision_observations',
  'passage_restatements',
  'record_relationships',
  'correction_actions',
  'correction_targets',
  'task_uses',
];

const DEFAULT_TASK =
  'Notes are flushed to disk before the screen reports them saved, because a technician must ' +
  'not lose a note to a crash.';

function defaultGrantTerms(projectId: string, provider: 'claude' | 'codex'): ProcessingGrantTerms {
  return {
    project_id: projectId,
    provider,
    processor_contract: PROCESSOR_CONTRACT,
    source_scope: { admitted_after_sequence: 0, backlog: 'included' },
    disclosed: {
      tool_access: provider === 'codex' ? 'codex_restricted' : 'none',
      model: { selection: 'provider_default' },
      limits: {
        max_cost_usd_per_call: 'none',
        max_cost_usd_per_day: 'none',
        max_calls_per_hour: 60,
        max_input_bytes: 131_072,
        max_output_bytes: 65_536,
      },
      paused_backlog_count: 0,
    },
  };
}

export interface WorkerFixture {
  repoPath: string;
  dataRoot: string;
  configHome: string;
  authority: ProjectDatabaseAuthority;
  projectId: string;
  artifactId: string;
  handle: ProjectDatabase;
  providerPath: string;
  providerRecordPath: string;
  /** The fake provider's model-call branch writes this; availability probes leave no marker. */
  providerStartedMarker: string;
  env: NodeJS.ProcessEnv;
  scratchParentDir: string;
  admit(options?: AdmittedJobOptions): Promise<{ jobId: string; eventId: string }>;
  /** Admit through the real capture settlement, with whatever it retains. */
  captureAndAdmit(
    task?: string,
    withoutModel?: boolean
  ): Promise<{ jobId: string; artifactId: string }>;
  job(jobId: string): ProcessingJob;
  /** Rows in every knowledge table a publication can write, so "published nothing" is checkable. */
  knowledgeRows(): number;
  attempts(jobId: string): ReturnType<typeof readProcessingJobAttempts>;
  lease(): ReturnType<typeof readProcessingLease>;
  writeConfig(section: Record<string, unknown>, llm?: Record<string, unknown>): Promise<void>;
  grant(changes?: Partial<ProcessingGrantTerms>): Promise<void>;
  revoke(): Promise<void>;
  open(): Promise<ProjectDatabase>;
  /** A second checkout of the same repository, with configuration of its own. */
  addWorktree(name: string, section: Record<string, unknown>): Promise<string>;
  cleanup(): Promise<void>;
}

export async function knowledgeWorkerFixture(
  options: WorkerFixtureOptions = {}
): Promise<WorkerFixture> {
  // A fixture that fails halfway has no owner to clean it up, and a suite that
  // leaves temporary databases behind fills the machine's disk.
  try {
    return await buildFixture(options);
  } catch (cause) {
    await removeAbandonedRoots();
    throw cause;
  }
}

/** Roots this module made that no fixture took ownership of. */
const pendingRoots: string[] = [];

async function removeAbandonedRoots(): Promise<void> {
  for (const root of pendingRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function buildFixture(options: WorkerFixtureOptions): Promise<WorkerFixture> {
  const repo = await createTempRepo({ initialBranch: 'main' });
  pendingRoots.push(repo.path);
  const repoPath = await realpath(repo.path);
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-worker-')));
  pendingRoots.push(scratch);
  const dataRoot = path.join(scratch, 'history');
  const configHome = path.join(scratch, 'config');
  const codexHome = path.join(scratch, 'codex-home');
  const scratchParentDir = path.join(scratch, 'provider-scratch');
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(scratchParentDir, { recursive: true });
  // The grant store resolves its home from this process's own environment, as
  // it does for a worker that inherited it from the capture that woke one.
  const previousConfigHome = process.env.ORCAOPS_CONFIG_HOME;
  process.env.ORCAOPS_CONFIG_HOME = configHome;

  const providerRecordPath = path.join(scratch, 'provider-record.json');
  const providerStartedMarker = path.join(scratch, 'provider-started');
  const providerPath = path.join(scratch, 'cli.js');
  const providerId = options.providerId ?? 'claude';
  const target = options.provider ?? FAKE_CLAUDE;
  await writeFile(
    path.join(scratch, 'package.json'),
    JSON.stringify({
      name: providerId === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code',
      type: 'module',
      bin: { [providerId]: 'cli.js' },
    })
  );
  await writeFile(
    providerPath,
    [
      "import { writeFileSync } from 'node:fs';",
      `if (process.argv.includes('--version')) { console.log('${
        providerId === 'codex' ? 'codex-cli 0.154.0' : '1.0.0-fake'
      }'); process.exit(0); }`,
      `writeFileSync(${JSON.stringify(providerStartedMarker)}, '');`,
      `await import(${JSON.stringify(target)});`,
      '',
    ].join('\n'),
    { mode: 0o755 }
  );

  const handles: ProjectDatabase[] = [];
  const writeConfig = async (
    section: Record<string, unknown>,
    llm?: Record<string, unknown>
  ): Promise<void> => {
    await mkdir(path.join(repoPath, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(repoPath, '.orcaops', 'config.json'),
      `${JSON.stringify(
        {
          schema_version: CONFIG_SCHEMA_VERSION,
          install: { scope: 'project' },
          ...(llm === undefined ? {} : { llm }),
          knowledge_processing: section,
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  };
  // The database is set up before any `.orcaops` directory exists: an existing
  // installation presence sends setup down the conversion path instead.
  await setupProjectDatabase({
    cwd: repoPath,
    root: dataRoot,
    authoredPayloads: [],
    secretAllow: [],
  });
  await writeConfig(
    options.processing ??
      (providerId === 'codex'
        ? {
            enabled: true,
            provider: 'codex',
            tool_access: 'codex_restricted',
            max_cost_usd_per_call: 'none',
            max_attempts: 1,
            max_calls_per_hour: 60,
          }
        : { enabled: true, max_calls_per_hour: 60 }),
    options.llm
  );
  const context = await requireDatabaseExecutionContext({ cwd: repoPath, root: dataRoot });
  const authority = { ...context.authority };
  const binding = context.binding;
  if (binding === null) throw new Error('the fixture checkout registered no execution binding');
  const projectId = authority.projectId;
  await run('git', ['config', 'orcaops.projectid', projectId], { cwd: repoPath });

  const handle = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(handle);

  const artifactId = uuidv7();
  let revision = -1;
  let priorEventId: string | null = null;
  const admit = async (input: AdmittedJobOptions = {}) => {
    revision += 1;
    const operationId = uuidv7();
    const jobId = uuidv7();
    const next = planEventBytes(
      artifactId,
      revision,
      input.task ?? options.task ?? DEFAULT_TASK,
      priorEventId,
      input.importedOrigin === true
    );
    await appendProjectArtifactEvents(handle, {
      operationId: uuidv7(),
      artifactId,
      expectedRevision: revision === 0 ? null : readProjectArtifact(handle, artifactId)!.revision,
      eventBytes: next.bytes,
      sidecarPayloads: [],
      secretAllow: [...(input.secretAllow ?? [])],
    });
    priorEventId = next.eventId;
    await runProjectOperation(
      handle,
      {
        operationId,
        kind: 'fixture.capture.settle',
        target: { artifact_id: artifactId },
        payload: null,
        expectedState: null,
        intentChange: false,
      },
      (transaction) => {
        admitProcessingJob(
          transaction,
          {
            jobId,
            identity: {
              source: { kind: 'capture_event', event_id: next.eventId },
              processor_contract: input.processorContract ?? PROCESSOR_CONTRACT,
            },
            path: (input.path ?? 'live_capture_settlement') as 'live_capture_settlement',
            originKind: input.originKind ?? 'captured',
            settledEventTypes: [input.eventType ?? next.type],
            derivedByProcessing: input.derivedByProcessing ?? false,
            withoutModel: input.withoutModel ?? false,
            admittedAt: new Date().toISOString(),
            ...(input.withoutDispatchContext === true
              ? {}
              : {
                  context: processingDispatchContext({
                    artifactId,
                    worktreeRoot: input.worktreeRoot ?? repoPath,
                  }),
                }),
          },
          operationId
        );
        return { eventId: next.eventId };
      }
    );
    return { jobId, eventId: next.eventId };
  };

  /**
   * A live plan capture settled the way `orcaops capture plan` settles one, so
   * the job under test is admitted by the real path with whatever that path
   * chooses to retain — not by a hand-built admission that could agree with the
   * worker while the capture settlement does not.
   */
  const captureAndAdmit = async (task = DEFAULT_TASK, withoutModel = false) => {
    const capturedArtifactId = uuidv7();
    const prepared = await prepareArtifactDraft(
      {
        artifactId: capturedArtifactId,
        priorEvents: [],
        authoredPayload: {},
        secretAllow: [],
        idempotencyBlocks: [],
      },
      (semantics) =>
        semantics.writePlan(livePlan(capturedArtifactId, task), { idempotencyKey: uuidv7() })
    );
    if (prepared.evaluation.kind === 'threw') throw prepared.evaluation.error;
    const result = await appendProjectExecutionCapture(
      handle,
      {
        artifactId: capturedArtifactId,
        operationId: uuidv7(),
        expectedRevision: null,
        eventBytes: Buffer.concat(prepared.events.map((event) => event.eventBytes)),
        // As `orcaops capture plan` passes them: a payload over the inline budget is retained
        // beside its event, and a source long enough to be divided is over it.
        sidecarPayloads: prepared.events.flatMap((event) =>
          event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
        ),
        secretAllow: [],
        execution: { kind: 'create', context: binding, ts: '2026-09-01T00:00:00.000Z' },
      },
      {
        processing: {
          processorContract: PROCESSOR_CONTRACT,
          withoutModel,
          origin: { worktreeRoot: repoPath },
        },
      }
    );
    const job = result.admittedProcessingJobs[0];
    if (!job) throw new Error('the live capture admitted no processing job');
    return { jobId: job.jobId, artifactId: capturedArtifactId };
  };

  const grant = async (changes: Partial<ProcessingGrantTerms> = {}): Promise<void> => {
    const terms = { ...defaultGrantTerms(projectId, providerId), ...changes };
    await recordProcessingGrant(terms, {
      repoRoot: repoPath,
      configDir: configHome,
      interactiveConfirmation: InteractiveConsentConfirmation.forTermsAcceptedAtTerminal(terms),
    });
  };
  if (options.withoutGrant !== true) await grant(options.grant);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORCAOPS_CONFIG_HOME: configHome,
    // Never the real data directory: every fixture owns its own store.
    ORCAOPS_DATA_DIR: dataRoot,
    ORCAOPS_CLAUDE_PATH:
      providerId === 'claude' ? providerPath : path.join(scratch, 'absent-claude'),
    ORCAOPS_CODEX_PATH: providerId === 'codex' ? providerPath : path.join(scratch, 'absent-codex'),
    CODEX_HOME: codexHome,
    FAKE_PROVIDER_BEHAVIOR: options.behavior ?? 'answer',
    FAKE_PROPOSER_ANSWER: options.proposerAnswer ?? 'statement',
    FAKE_PROVIDER_RECORD: providerRecordPath,
  };

  return {
    repoPath,
    dataRoot,
    configHome,
    authority,
    projectId,
    artifactId,
    handle,
    providerPath,
    providerRecordPath,
    providerStartedMarker,
    env,
    scratchParentDir,
    admit,
    captureAndAdmit,
    job: (jobId) => readProcessingJob(handle, jobId)!,
    knowledgeRows: () =>
      handle.read((view) =>
        PUBLISHABLE_TABLES.reduce(
          (total, table) =>
            total + (view.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0),
          0
        )
      ).value,
    attempts: (jobId) => readProcessingJobAttempts(handle, jobId, 20),
    lease: () => readProcessingLease(handle),
    writeConfig,
    grant,
    revoke: async () => {
      const { revokeProcessingGrants } = await import('../lib/knowledge-processing-grants.js');
      await revokeProcessingGrants(
        { project_id: projectId },
        { repoRoot: repoPath, configDir: configHome }
      );
    },
    addWorktree: async (name, section) => {
      const worktree = path.join(scratch, name);
      await run('git', ['worktree', 'add', '-b', name, worktree], { cwd: repoPath });
      const resolved = await realpath(worktree);
      await mkdir(path.join(resolved, '.orcaops'), { recursive: true });
      await writeFile(
        path.join(resolved, '.orcaops', 'config.json'),
        `${JSON.stringify(
          {
            schema_version: CONFIG_SCHEMA_VERSION,
            install: { scope: 'project' },
            knowledge_processing: section,
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      return resolved;
    },
    open: async () => {
      const value = await openProjectDatabase({ authority, mode: 'writer' });
      handles.push(value);
      return value;
    },
    cleanup: async () => {
      pendingRoots.length = 0;
      if (previousConfigHome === undefined) delete process.env.ORCAOPS_CONFIG_HOME;
      else process.env.ORCAOPS_CONFIG_HOME = previousConfigHome;
      for (const value of handles.splice(0)) {
        try {
          value.close();
        } catch {
          /* A closed connection must not block temporary cleanup. */
        }
      }
      await rm(scratch, { recursive: true, force: true });
      await repo.cleanup();
    },
  };
}
