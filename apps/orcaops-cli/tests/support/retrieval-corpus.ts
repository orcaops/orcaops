import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { requireDatabaseExecutionContext } from '@orcaops/core/history/database-capture';
import {
  openProjectDatabase,
  type ProjectDatabase,
  readProjectArtifact,
} from '@orcaops/storage/history/database';
import {
  createTempRepo,
  type InProcessAgent,
  inputFile,
  type OkEnvelope,
} from '@orcaops/test-harness';

import { makeAgent } from './test-agent.js';
import { doneCriteriaFor, patchEffectiveConfig } from './test-helpers.js';
import type { CorpusEventRef, RecordLocator } from '../fixtures/retrieval-corpus/cases.js';
import {
  checkpointEvidence,
  checkpointVerification,
  type CorpusArtifactKey,
  retrievalCorpusStory,
  type StoryArtifact,
  type StoryRevisedStep,
} from '../fixtures/retrieval-corpus/story.js';

const execFileAsync = promisify(execFile);

interface CapturedStep {
  step_id: string;
  label: string;
  acceptance_criteria: Array<{ criterion_id: string; text: string }>;
}
interface CapturedPlan extends OkEnvelope {
  artifact_id: string;
  branch: string;
  plan_event_id: string;
  plan_steps: CapturedStep[];
}
interface CapturedArtifact {
  artifactId: string;
  branch: string;
}

export interface CorpusEvent {
  eventId: string;
  type: string;
  /** For an earlier plan revision or an amended summary, the event that now stands in its place. */
  supersededBy: string | null;
  payload: Record<string, unknown>;
}

export interface CorpusArtifact extends CapturedArtifact {
  /** Size of the artifact's retained event log. */
  eventBytes: number;
  events: CorpusEvent[];
}

export interface ResolvedRecord {
  artifactId: string;
  eventId: string;
  superseded: boolean;
  text: string;
}

export interface RetrievalCorpus {
  agent: InProcessAgent;
  artifacts: Record<CorpusArtifactKey, CorpusArtifact>;
  searchSourceRows: number;
  resolve(locator: RecordLocator): ResolvedRecord;
  /** A handle on the corpus history, read-only unless a writer is asked for; the caller closes it. */
  openDatabase(mode?: 'reader' | 'writer'): Promise<ProjectDatabase>;
  cleanup(): Promise<void>;
}

async function capture<T extends OkEnvelope>(
  agent: InProcessAgent,
  verb: string[],
  body: Record<string, unknown>
): Promise<T> {
  return (await agent.run<T>([
    'capture',
    ...verb,
    '--input',
    inputFile(JSON.stringify(body)),
  ])) as T;
}

function revisedSteps(prior: CapturedStep[], steps: StoryRevisedStep[]) {
  return steps.map((step) => {
    const kept = prior.find((candidate) => candidate.label === step.label);
    return {
      ...(kept ? { step_id: kept.step_id } : {}),
      text: step.text,
      label: step.label,
      acceptance_criteria: step.acceptance_criteria.map((criterion) => {
        if (typeof criterion === 'string') return { text: criterion };
        const rewritten = kept?.acceptance_criteria.find(
          (candidate) => candidate.text === criterion.rewrites
        );
        if (!rewritten)
          throw new Error(`Step "${step.label}" has no criterion "${criterion.rewrites}"`);
        return { criterion_id: rewritten.criterion_id, text: criterion.text };
      }),
    };
  });
}

async function captureArtifact(
  agent: InProcessAgent,
  artifact: StoryArtifact
): Promise<CapturedArtifact> {
  const { plan, revision } = artifact;
  const planned = await capture<CapturedPlan>(agent, ['plan', '--no-llm'], {
    task: plan.task,
    label: plan.label,
    touched_scope: plan.touched_scope,
    plan_steps: plan.steps.map((step) => ({
      text: step.text,
      label: step.label,
      acceptance_criteria: step.acceptance_criteria.map((text) => ({ text })),
    })),
    non_goals: plan.non_goals,
    decisions: plan.decisions,
  });
  const artifactId = planned.artifact_id;
  let steps = planned.plan_steps;
  if (revision) {
    const revised = await capture<CapturedPlan>(agent, ['plan', 'revise', '--no-llm'], {
      artifact_id: artifactId,
      label: revision.label,
      rationale: revision.rationale,
      prior_plan_event_id: planned.plan_event_id,
      touched_scope: revision.touched_scope,
      plan_steps: revisedSteps(steps, revision.steps),
      non_goals: revision.non_goals,
      decisions: revision.decisions,
    });
    steps = revised.plan_steps;
  }
  for (const checkpoint of artifact.checkpoints) {
    const stepIds = checkpoint.steps.map((label) => {
      const step = steps.find((candidate) => candidate.label === label);
      if (!step) throw new Error(`"${plan.label}" has no step "${label}"`);
      return step.step_id;
    });
    const opened = await capture<OkEnvelope & { n: number }>(
      agent,
      ['checkpoint', 'open', '--no-llm'],
      { artifact_id: artifactId, declared_step_ids: stepIds }
    );
    await capture(agent, ['checkpoint', 'close', '--no-llm'], {
      artifact_id: artifactId,
      n: opened.n,
      summary: checkpoint.summary,
      files_changed: checkpoint.files_changed,
      decisions: checkpoint.decisions,
      uncertainty: checkpoint.uncertainty,
      completed_step_ids: stepIds,
      done_criteria: doneCriteriaFor(steps, stepIds, checkpointEvidence),
      verification: [checkpointVerification],
    });
  }
  if (artifact.summary) {
    const summarized = await capture<OkEnvelope & { summary_event_id: string }>(
      agent,
      ['summary'],
      { artifact_id: artifactId, ...artifact.summary }
    );
    if (artifact.amendedSummary)
      await capture(agent, ['summary'], {
        artifact_id: artifactId,
        ...artifact.amendedSummary,
        prior_summary_event_id: summarized.summary_event_id,
      });
  }
  return { artifactId, branch: planned.branch };
}

function findEvent(events: CorpusEvent[], ref: CorpusEventRef): CorpusEvent | undefined {
  const [type, ordinal] = ref.split(':');
  const candidates = events.filter((event) => event.type === type);
  if (type === 'plan_revised')
    return candidates.find((event) => event.payload.revision_n === Number(ordinal));
  if (type === 'checkpoint_closed')
    return candidates.find((event) => event.payload.n === Number(ordinal));
  if (type === 'summary_captured') return candidates[Number(ordinal) - 1];
  return candidates[0];
}

function resolveRecord(artifact: CorpusArtifact, locator: RecordLocator): ResolvedRecord {
  const event = findEvent(artifact.events, locator.event);
  if (!event) throw new Error(`${locator.artifact} has no ${locator.event} event`);
  let value: unknown = event.payload;
  for (const key of locator.path.split('.'))
    value =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)[key]
        : undefined;
  if (typeof value !== 'string')
    throw new Error(`${locator.artifact} ${locator.event} holds no text at ${locator.path}`);
  return {
    artifactId: artifact.artifactId,
    eventId: event.eventId,
    superseded: event.supersededBy !== null,
    text: value,
  };
}

const replaceableEvents = [['plan_captured', 'plan_revised'], ['summary_captured']];

function readEvents(database: ProjectDatabase, captured: CapturedArtifact): CorpusArtifact {
  const retained = readProjectArtifact(database, captured.artifactId);
  if (!retained) throw new Error(`Captured artifact ${captured.artifactId} is not readable`);
  const records = retained.thread.events.map((event) => event.record);
  const standingEventId = (type: string) => {
    const types = replaceableEvents.find((group) => group.includes(type));
    return types && records.filter((record) => types.includes(record.type)).at(-1)!.event_id;
  };
  return {
    ...captured,
    eventBytes: retained.revision.byteLength,
    events: retained.thread.events.map((event) => {
      const standing = standingEventId(event.record.type);
      return {
        eventId: event.record.event_id,
        type: event.record.type,
        supersededBy:
          standing === undefined || standing === event.record.event_id ? null : standing,
        payload: event.payload as Record<string, unknown>,
      };
    }),
  };
}

/**
 * Captures the whole story through the real capture commands into a temporary repository
 * and temporary history, with no model calls.
 */
export async function buildRetrievalCorpus(): Promise<RetrievalCorpus> {
  const repo = await createTempRepo({ initialBranch: 'main' });
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-retrieval-corpus-'));
  const cleanup = async () => {
    await repo.cleanup();
    await rm(dataRoot, { recursive: true, force: true });
  };
  try {
    const agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    await agent.init({ noLlm: true });
    // Worktree snapshots add about 0.75s to every plan, open, and close, and no searchable text.
    await patchEffectiveConfig(repo.path, (raw) => {
      raw.diff_fingerprint = { enabled: false };
    });

    const story: Record<CorpusArtifactKey, StoryArtifact> = retrievalCorpusStory;
    const keys = Object.keys(story) as CorpusArtifactKey[];
    const captured = {} as Record<CorpusArtifactKey, CapturedArtifact>;
    const branches = new Set(['main']);
    let branch = 'main';
    for (const key of keys) {
      const artifact = story[key];
      // An artifact only accepts captures from the branch it was planned on.
      if (artifact.branch !== branch) {
        branch = artifact.branch;
        await execFileAsync(
          'git',
          ['checkout', '-q', ...(branches.has(branch) ? [] : ['-b']), branch],
          { cwd: repo.path }
        );
        branches.add(branch);
      }
      captured[key] = await captureArtifact(agent, artifact);
    }

    const openDatabase = async (mode: 'reader' | 'writer' = 'reader') => {
      const context = await requireDatabaseExecutionContext({ cwd: repo.path, root: dataRoot });
      return openProjectDatabase({ authority: context.authority, mode });
    };
    const artifacts = {} as Record<CorpusArtifactKey, CorpusArtifact>;
    let searchSourceRows: number;
    const database = await openDatabase();
    try {
      for (const key of keys) artifacts[key] = readEvents(database, captured[key]);
      searchSourceRows = database.read(
        (view) =>
          view.get<{ rows: number }>('SELECT count(*) AS rows FROM artifact_search_sources')!
      ).value.rows;
    } finally {
      database.close();
    }

    return {
      agent,
      artifacts,
      searchSourceRows,
      resolve: (locator) => resolveRecord(artifacts[locator.artifact], locator),
      openDatabase,
      cleanup,
    };
  } catch (cause) {
    await cleanup();
    throw cause;
  }
}
