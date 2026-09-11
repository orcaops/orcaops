import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, vi } from 'vitest';

import { type PlanInput, PlanInputSchema, type SourcePlanPin, uuidv7 } from '@orcaops/storage';
import {
  appendProjectArtifactEvents,
  openProjectDatabase,
  type ProjectDatabase,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';

import { requireDatabaseExecutionContext } from '../../../../packages/core/dist/history/context/execution.js';
import { setupProjectDatabase } from '../../../../packages/core/dist/history/setup/setup.js';
import {
  type ArtifactDraftSemantics,
  prepareArtifactDraft,
} from '../../../../packages/storage/dist/artifacts/draft-preparation.js';
import { appendProjectExecutionCapture } from '../../../../packages/storage/dist/history/database/execution-capture.js';
import { writeGrant } from '../../src/lib/evaluator-grants.js';

const execute = promisify(execFile);
const cleanupTasks = new Set<() => Promise<void>>();
const writers = new Map<string, ProjectDatabase>();
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const writer of writers.values()) writer.close();
  for (const cleanup of [...cleanupTasks]) await cleanup();
});

/**
 * Grants a path-source evaluator pack to a registered database project. Consent is the
 * user-local grants file, never `orcaops init` and never the repository config, and the
 * trust lookup reads ORCAOPS_CONFIG_HOME from the real process env — hence the stub.
 */
export async function grantEvaluatorPack(
  fixtureValue: { main: string; temporary: string },
  input: { packageId: string; packRoot: string; enable: Record<string, boolean> }
) {
  const packRoot = await realpath(input.packRoot);
  const configDir = path.join(fixtureValue.temporary, 'evaluator-config');
  await mkdir(path.join(fixtureValue.main, '.orcaops'), { recursive: true });
  const enabled = Object.entries(input.enable)
    .map(([ref, on]) => `  ${ref}:\n    enabled: ${on}\n`)
    .join('');
  await writeFile(
    path.join(fixtureValue.main, '.orcaops', 'evaluators.yaml'),
    'schema: orcaops.evaluator_config/v2\n' +
      'runtime:\n  max_concurrent: 2\n' +
      `packages:\n  - id: ${input.packageId}\n    source:\n      kind: path\n      path: ${packRoot}\n` +
      `evaluators:\n${enabled}`,
    'utf8'
  );
  vi.stubEnv('ORCAOPS_CONFIG_HOME', configDir);
  await writeGrant(
    {
      kind: 'workspace-dev',
      package_id: input.packageId,
      resolved_path: packRoot,
      capabilities: ['command_evaluators_present'],
      granted_at: new Date().toISOString(),
    },
    { repoRoot: fixtureValue.main, configDir }
  );
  return { configDir, packRoot };
}
export async function git(cwd: string, args: string[]) {
  return execute('git', ['-C', cwd, ...args], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
    timeout: 10_000,
  });
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function databaseInventory(writer: ProjectDatabase) {
  return writer.read((view) => {
    const schema = view.all<{ type: string; name: string; sql: string | null }>(
      'SELECT type, name, sql FROM sqlite_schema ORDER BY type, name'
    );
    const tables = schema
      .filter((entry) => entry.type === 'table')
      .map(({ name }) => {
        const columns = view.all<{ name: string }>(
          'SELECT name FROM pragma_table_info(?) ORDER BY cid',
          name
        );
        const expressions = columns.map(({ name: column }) => {
          const value = quote(column);
          return `typeof(${value}) || ':' || CASE WHEN typeof(${value})='real' THEN printf('%!.26g',${value}) ELSE quote(${value}) END AS ${value}`;
        });
        return {
          name,
          rows: view
            .all(`SELECT ${expressions.join(',')} FROM ${quote(name)}`)
            .map((row) => JSON.stringify(row))
            .sort(),
        };
      });
    return { schema, tables };
  });
}
export async function inventory(root: string) {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (
      ['-wal', '-shm'].some(
        (suffix) => file.endsWith(suffix) && writers.has(file.slice(0, -suffix.length))
      )
    )
      continue;
    const writer = writers.get(file);
    const content = writer
      ? JSON.stringify(databaseInventory(writer))
      : entry.isFile()
        ? await readFile(file)
        : null;
    result[path.relative(root, file)] =
      content === null
        ? entry.isDirectory()
          ? 'directory'
          : 'other'
        : createHash('sha256').update(content).digest('hex');
  }
  return result;
}
export async function fixture(historyRoot?: string) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'database-history-')));
  const main = path.join(temporary, 'main');
  const linked = path.join(temporary, 'linked');
  let writer: ProjectDatabase | undefined = undefined;
  const cleanup = async () => {
    writer?.close();
    if (writer) writers.delete(writer.databasePath);
    for (const [file, other] of writers) {
      const relative = path.relative(temporary, file);
      if (
        relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative)
      ) {
        other.close();
        writers.delete(file);
      }
    }
    cleanupTasks.delete(cleanup);
    await rm(temporary, { recursive: true, force: true });
  };
  cleanupTasks.add(cleanup);
  await mkdir(main);
  await git(main, ['init', '-qb', 'main']);
  await git(main, ['config', '--local', 'user.name', 'Test']);
  await git(main, ['config', '--local', 'user.email', 'test@example.test']);
  await git(main, ['commit', '--allow-empty', '-qm', 'Initial']);
  await git(main, ['worktree', 'add', '-qb', 'linked', linked]);
  const requestedRoot = historyRoot ?? path.join(temporary, 'data');
  const setup = await setupProjectDatabase({
    cwd: main,
    root: requestedRoot,
    authoredPayloads: [],
    secretAllow: [],
  });
  if (setup.status !== 'complete') throw new Error('Fixture setup did not complete');
  const authority = setup.initialization.authority;
  const root = authority.resolvedRoot;
  const context = await requireDatabaseExecutionContext({ cwd: main, root });
  writer = await openProjectDatabase({ authority, mode: 'writer' });
  const handle = writer;
  writers.set(handle.databasePath, handle);
  async function mutate<T>(
    artifactId: string,
    authoredPayload: unknown,
    callback: (semantics: ArtifactDraftSemantics) => Promise<T>
  ) {
    const retained = readProjectArtifact(handle, artifactId);
    if (!retained) throw new Error('Fixture artifact is missing');
    const draft = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: retained.thread.events,
        authoredPayload,
        secretAllow: [],
        idempotencyBlocks: [],
      },
      callback
    );
    if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
    if (draft.idempotencyChanges.length)
      throw new Error('Fixture mutation produced unhandled attempt changes');
    if (!draft.events.length) return draft.evaluation.value;
    const request = {
      artifactId,
      operationId: uuidv7(),
      expectedRevision: retained.revision,
      eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
      sidecarPayloads: draft.events.flatMap((event) =>
        event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
      ),
      secretAllow: [],
    };
    const execution = readProjectExecution(handle, artifactId);
    if (execution?.state.current_binding) {
      await appendProjectExecutionCapture(handle, {
        ...request,
        execution: {
          kind: 'task',
          context: execution.state.current_binding,
          expectedVersion: execution.version,
          expectedGeneration: execution.state.binding_generation,
          explicitTarget: true,
        },
      });
    } else await appendProjectArtifactEvents(handle, request);
    return draft.evaluation.value;
  }
  async function capture(
    artifactId = uuidv7(),
    options: {
      ts?: string;
      cwd?: string;
      touchedScope?: string[];
      reason?: 'legacy_unknown' | 'imported' | 'completed';
      agentSessionId?: string | null;
      decisions?: PlanInput['decisions'];
      criteria?: PlanInput['plan_steps'][number]['acceptance_criteria'];
      steps?: PlanInput['plan_steps'];
      nonGoals?: PlanInput['non_goals'];
      sourcePlan?: SourcePlanPin;
      baselineSeedTreeSha?: string;
      task?: string;
    } = {}
  ) {
    const cwd = options.cwd ?? main;
    const currentSetup = await setupProjectDatabase({
      cwd,
      root,
      projectId: authority.projectId,
      authoredPayloads: [options],
      secretAllow: [],
    });
    if (currentSetup.status !== 'complete')
      throw new Error('Fixture worktree registration did not complete');
    const current = await requireDatabaseExecutionContext({ cwd, root });
    const ts = options.ts ?? '2026-09-05T00:00:00.000Z';
    const operationId = uuidv7();
    const plan = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: artifactId,
      branch: current.binding.git_context.branch ?? 'HEAD',
      base_sha: current.binding.git_context.head_sha,
      agent: 'codex',
      agent_session_id: options.agentSessionId ?? null,
      task: options.task ?? 'Retain project narrative',
      label: `History ${artifactId}`,
      plan_steps: options.steps ?? [
        {
          step_id: uuidv7(),
          text: 'Read retained evidence',
          label: 'Retained evidence',
          acceptance_criteria: options.criteria ?? [],
        },
      ],
      touched_scope: options.touchedScope ?? [],
      non_goals: options.nonGoals ?? [],
      decisions: options.decisions ?? [],
      started_at: ts,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
      ...(options.reason === 'imported'
        ? {
            origin: {
              kind: 'git-import',
              imported_at: ts,
              tool_version: 'test',
              source_range: 'HEAD',
              authors: ['Test'],
              enriched_at: null,
            },
          }
        : {}),
    });
    const draft = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: [],
        authoredPayload: { plan, sourcePlan: options.sourcePlan ?? null },
        secretAllow: [],
        idempotencyBlocks: [],
      },
      (semantics) =>
        semantics.writePlan(plan, {
          idempotencyKey: operationId,
          sourcePlan: options.sourcePlan,
          baselineSeedTreeSha: options.baselineSeedTreeSha,
        })
    );
    if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
    const event = draft.events[0];
    if (!event || draft.events.length !== 1 || draft.idempotencyChanges.length)
      throw new Error('Fixture plan did not prepare exactly one event');
    const request = {
      artifactId,
      operationId,
      expectedRevision: null,
      eventBytes: event.eventBytes,
      sidecarPayloads: event.sidecar
        ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }]
        : [],
      secretAllow: [],
    };
    if (options.reason === 'legacy_unknown' || options.reason === 'imported')
      await appendProjectArtifactEvents(handle, request);
    else
      await appendProjectExecutionCapture(handle, {
        ...request,
        execution: { kind: 'create', context: current.binding, ts },
      });
    if (options.reason === 'completed')
      await mutate(artifactId, { outcome: 'Completed fixture' }, (semantics) =>
        semantics.writeSummary({
          schema_version: 1,
          artifact_id: artifactId,
          outcome: 'Completed fixture',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          head_sha: current.binding.git_context.head_sha!,
          ts,
        })
      );
    return artifactId;
  }
  async function recordFiles(
    artifactId: string,
    files: string[],
    headSha = context.binding.git_context.head_sha!
  ) {
    return mutate(artifactId, { files }, async (semantics) => {
      const plan = await semantics.readPlan(artifactId);
      const opened = await semantics.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [plan!.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha }
      );
      if (!('checkpoint' in opened)) throw new Error('Fixture checkpoint did not open');
      return semantics.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: opened.checkpoint.n,
          head_sha: headSha,
          summary: 'Recorded file evidence',
          files_changed: files,
          completed_step_ids: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
        },
        { idempotencyKey: uuidv7() }
      );
    });
  }
  return {
    temporary,
    main,
    linked,
    root,
    authority,
    context: context.git,
    registeredContext: context,
    writer: handle,
    capture,
    mutate,
    recordFiles,
    cleanup,
  };
}
