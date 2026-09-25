// What a previously recorded assessment does, and does not do, to the work being done now.
//
// Two halves: `knowledge lookup` shows an assessment under the expectation it judged with its own
// basis, and the gates — checkpoint open, `finish` and `doctor` — carry on exactly as they did
// before the assessment existed.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KnowledgeContextAnswer, KnowledgeContextEntry } from '@orcaops/core';
import { uuidv7 } from '@orcaops/storage';
import {
  type ProjectDatabase,
  publishProjectKnowledgeAssessment,
  publishProjectObservation,
  readProjectKnowledgeAssessment,
  readProjectObservation,
} from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { knowledgeLookupAction } from '../../src/commands/knowledge/lookup.js';
import { CliExit } from '../../src/io/exit.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture } from '../helpers/database-history.js';
import { adoptedRequirement, replaceRequirement } from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const OFFLINE = 'Local capture works with no Cloud connection.';
const ASSESSED_RELEASE = '0.2.1';
const CURRENT_RELEASE = '0.3.0';

const OWNER = { identity: 'owner', basis: 'other_assertion' } as const;

let stdout: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  stdout = [];
});

async function project(): Promise<Fixture> {
  const value = await fixture();
  await mkdir(path.join(value.main, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(value.main, '.orcaops', 'config.json'),
    JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm: { tool: 'none' } }),
    'utf8'
  );
  return value;
}

function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 120_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'evidence-relevance-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: f.temporary + '/unused-state',
    },
  });
}

/** An observation of a run that failed, as an agent reported one. */
async function failedObservation(handle: ProjectDatabase, sourceId: string): Promise<string> {
  const observationId = uuidv7();
  await publishProjectObservation(handle, {
    operationId: uuidv7(),
    observation: {
      observation_id: observationId,
      source_id: sourceId,
      method: { name: 'vitest', configuration_sha256: null },
      execution: { kind: 'agent_reported', command: 'pnpm vitest run offline-capture' },
      input_basis: 'unknown',
      known_inputs: [],
      outcome: 'failed',
      detail: 'the offline smoke failed on the previous build',
      retained_artifacts: [],
      started_at: null,
      finished_at: null,
      limits: ['nothing checked which files the suite opened'],
    },
    observedBy: OWNER,
    secretAllow: [],
  });
  return observationId;
}

/** A contradicted assessment of one release: the mismatched old failure. */
async function contradictedAssessment(
  handle: ProjectDatabase,
  input: { requirementId: string; revisionId: string; observationId: string; release: string }
): Promise<string> {
  const assessmentId = uuidv7();
  // Stamped with what this history has committed, as an assessor that read the store would. A
  // stamp of zero would read as an assessment made before every adoption in the project.
  const counters = handle.read(() => null).counters;
  const expectation = {
    kind: 'requirement' as const,
    entity_id: input.requirementId,
    revision_id: input.revisionId,
  };
  await publishProjectKnowledgeAssessment(handle, {
    operationId: uuidv7(),
    assessment: {
      assessment_id: assessmentId,
      expectations: [expectation],
      exception_ids: [],
      implementation: {
        kind: 'selected',
        inputs: [{ kind: 'release', identity: input.release }],
        environment: 'ci-linux',
      },
      evidence: [
        {
          source: { kind: 'observation', observation_id: input.observationId },
          role: 'contradicts',
          limitations: 'only the offline smoke ran',
        },
      ],
      method: { name: 'release review', configuration_sha256: null },
      conclusions: [
        { expectation, conclusion: 'contradicted', reason: 'the offline smoke failed' },
      ],
      check_states: [{ check: 'cloud reconnect', state: 'skipped', detail: 'no network' }],
      coverage_limits: ['only the offline smoke ran'],
      observed_write_sequence: counters.writeSequence,
      observed_intent_counter: counters.intentChangeCounter,
    },
    assessedBy: OWNER,
    secretAllow: [],
  });
  return assessmentId;
}

async function lookup(
  value: Fixture,
  opts: Parameters<typeof knowledgeLookupAction>[0]
): Promise<{ answer: KnowledgeContextAnswer; failed: boolean }> {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let failed = false;
  try {
    await runInInvocationContext(
      {
        cwd: value.main,
        env: {
          ...process.env,
          ORCAOPS_ROOT: value.main,
          ORCAOPS_DATA_DIR: value.root,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      },
      () => knowledgeLookupAction({ ...opts, json: true })
    );
  } catch (err) {
    if (!(err instanceof CliExit)) throw err;
    failed = true;
  }
  return {
    answer: JSON.parse(stdout.join('')) as unknown as KnowledgeContextAnswer,
    failed,
  };
}

/** The same read, rendered for a person rather than as JSON. */
async function lookupText(
  value: Fixture,
  opts: Parameters<typeof knowledgeLookupAction>[0]
): Promise<string> {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await runInInvocationContext(
    {
      cwd: value.main,
      env: {
        ...process.env,
        ORCAOPS_ROOT: value.main,
        ORCAOPS_DATA_DIR: value.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    },
    () => knowledgeLookupAction(opts)
  );
  return stdout.join('');
}

const evidenceOf = (answer: KnowledgeContextAnswer, key: string) => {
  const entry = answer.entries.find((held: KnowledgeContextEntry) => held.key === key);
  if (entry?.evidence === undefined) throw new Error(`no evidence composed for ${key}`);
  return entry.evidence;
};

async function assessedProject() {
  const value = await project();
  const adopted = await adoptedRequirement(value.writer, {
    projectId: value.authority.projectId,
    statement: OFFLINE,
  });
  const observationId = await failedObservation(value.writer, adopted.sourceId);
  const assessmentId = await contradictedAssessment(value.writer, {
    requirementId: adopted.requirementId,
    revisionId: adopted.revisionId,
    observationId,
    release: ASSESSED_RELEASE,
  });
  return {
    value,
    adopted,
    observationId,
    assessmentId,
    key: `requirement:${adopted.requirementId}`,
  };
}

describe('showing a previously recorded assessment under the expectation it judged', () => {
  it('carries its own basis and never reads it as satisfaction of unnamed software', async () => {
    const { value, key, assessmentId, observationId } = await assessedProject();

    const { answer } = await lookup(value, { identity: [key] });

    expect(answer.basis.software).toBeNull();
    const evidence = evidenceOf(answer, key);
    const held = evidence.assessments[0];
    expect(held?.assessment_id).toBe(assessmentId);
    expect(held?.conclusion).toBe('contradicted');
    expect(held?.implementation).toEqual({
      kind: 'selected',
      inputs: [{ kind: 'release', identity: ASSESSED_RELEASE }],
      environment: 'ci-linux',
    });
    expect(held?.method).toEqual({ name: 'release review', configuration_sha256: null });
    expect(held?.evidence).toEqual([
      { kind: 'observation', id: observationId, role: 'contradicts' },
    ]);
    expect(held?.check_states).toEqual([{ check: 'cloud reconnect', state: 'skipped' }]);
    expect(held?.coverage_limits).toEqual(['only the offline smoke ran']);
    expect(held?.relevance.outcome).not.toBe('applies');
    expect(evidence.statement).toContain('This question named no software');
  });

  it('answers a certification question for another version with no applicable assessment', async () => {
    const { value, key } = await assessedProject();

    const { answer } = await lookup(value, {
      identity: [key],
      software: [`release:${CURRENT_RELEASE}`],
    });

    const evidence = evidenceOf(answer, key);
    expect(answer.basis.software).toEqual({
      kind: 'selected',
      inputs: [{ kind: 'release', identity: CURRENT_RELEASE }],
      environment: null,
    });
    expect(evidence.assessments[0]?.relevance.outcome).toBe('insufficient_for_a_new_claim');
    expect(evidence.assessments[0]?.relevance.changed).toContain('software');
    expect(evidence.statement).toContain('no applicable assessment');
    expect(evidence.needed.join(' ')).toContain(CURRENT_RELEASE);
  });

  it('answers a new capture touching the behaviour with a verification gap, not a defect', async () => {
    const { value, adopted, key } = await assessedProject();

    const captured = await agent(value).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'Keep local capture working offline',
          label: 'Offline capture',
          plan_steps: [
            {
              text: 'Rework the offline path',
              label: 'Offline path',
              acceptance_criteria: [{ text: 'capture works with no Cloud connection' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
          knowledge_uses: [
            {
              kind: 'requirement',
              entity_id: adopted.requirementId,
              revision_id: adopted.revisionId,
              role: 'implement',
            },
          ],
        })
      ),
    ]);
    expect(captured.exitCode, captured.stdout + captured.stderr).toBe(0);

    const { answer } = await lookup(value, {
      identity: [key],
      software: [`release:${CURRENT_RELEASE}`],
    });

    const entry = answer.entries.find((held) => held.key === key);
    expect(entry?.selected_with_plan).toHaveLength(1);
    const relevance = entry?.evidence?.assessments[0]?.relevance;
    expect(relevance?.outcome).toBe('insufficient_for_a_new_claim');
    expect(relevance?.statement).toContain('verification gap');
    expect(relevance?.statement).toContain('not an established defect');
    expect(relevance?.statement).toContain('neither blocks work nor starts corrective work');
  });

  it('applies when the question names the exact revision, software and conditions it judged', async () => {
    const { value, key } = await assessedProject();

    const { answer } = await lookup(value, {
      identity: [key],
      software: [`release:${ASSESSED_RELEASE}`],
      environment: 'ci-linux',
    });

    const evidence = evidenceOf(answer, key);
    expect(evidence.assessments[0]?.relevance.outcome).toBe('applies');
    expect(evidence.assessments[0]?.relevance.changed).toEqual([]);
    expect(evidence.needed).toEqual([]);
  });

  it('asks for the intent change alone once an unrelated plan capture moves the counter', async () => {
    const { value, key } = await assessedProject();
    const asking = {
      identity: [key],
      software: [`release:${ASSESSED_RELEASE}`],
      environment: 'ci-linux',
    };
    expect(
      evidenceOf((await lookup(value, asking)).answer, key).assessments[0]?.relevance.outcome
    ).toBe('applies');

    const captured = await agent(value).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'Rename the settings panel',
          label: 'Settings panel',
          plan_steps: [
            {
              text: 'Rename the panel',
              label: 'Rename',
              acceptance_criteria: [{ text: 'the panel reads Settings' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(captured.exitCode, captured.stdout + captured.stderr).toBe(0);

    const evidence = evidenceOf((await lookup(value, asking)).answer, key);
    expect(evidence.assessments[0]?.relevance.outcome).toBe('insufficient_for_a_new_claim');
    expect(evidence.assessments[0]?.relevance.changed).toEqual(['intent']);
    expect(evidence.needed.join(' ')).toContain("the project's intent changed");
    expect(evidence.needed.join(' ')).not.toContain(ASSESSED_RELEASE);
  });

  it('turns historical once a successor revision replaces the one it judged', async () => {
    const { value, adopted, key } = await assessedProject();
    await replaceRequirement(value.writer, {
      projectId: value.authority.projectId,
      adopted,
      statement: `${OFFLINE} It says so when it cannot reach one.`,
    });

    const { answer } = await lookup(value, {
      identity: [key],
      software: [`release:${ASSESSED_RELEASE}`],
      environment: 'ci-linux',
    });

    const relevance = evidenceOf(answer, key).assessments[0]?.relevance;
    expect(relevance?.outcome).toBe('historical');
    expect(relevance?.changed).toContain('expectations');
    expect(relevance?.statement).toContain('preserved with its own basis');
    expect(evidenceOf(answer, key).statement).toContain('no applicable assessment');
  });

  it('renders each assessment under the entry, apart from its standing', async () => {
    const { value, key, assessmentId, observationId } = await assessedProject();

    const text = await lookupText(value, {
      identity: [key],
      software: [`release:${CURRENT_RELEASE}`],
    });

    expect(text).toContain(`Software in question: release ${CURRENT_RELEASE}`);
    expect(text).toContain(`${assessmentId} — insufficient_for_a_new_claim`);
    expect(text).toContain(`Basis: release ${ASSESSED_RELEASE} under ci-linux`);
    expect(text).toContain(`observation:${observationId} (contradicts)`);
    expect(text).toContain('Check cloud reconnect: skipped — never a conclusion');
    expect(text).toContain('Limit: only the offline smoke ran');
    expect(text).toContain('Would need:');
    // Standing is the entry's own line, and the conclusion never reaches it.
    const standing = text
      .split('\n')
      .find((line) => line.includes('applicability') && line.includes('adopted'));
    expect(standing).toBeDefined();
    expect(standing).not.toContain('contradicted');
  });

  it('says an identity nobody assessed has none, which is not a defect', async () => {
    const { value } = await assessedProject();
    const other = await adoptedRequirement(value.writer, {
      projectId: value.authority.projectId,
      statement: 'Search results carry the standing of what they cite.',
    });

    const { answer } = await lookup(value, {
      identity: [`requirement:${other.requirementId}`],
      software: [`release:${CURRENT_RELEASE}`],
    });

    const evidence = evidenceOf(answer, `requirement:${other.requirementId}`);
    expect(evidence.assessments).toEqual([]);
    expect(evidence.statement).toContain('holds no assessment');
    expect(evidence.statement).toContain('not a defect');
  });
});

describe('old evidence is not a new defect', { timeout: 180_000 }, () => {
  it('leaves checkpoint open, finish and doctor exactly as they were', async () => {
    const value = await project();
    const planned = await agent(value).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'Keep local capture working offline',
          label: 'Offline capture',
          plan_steps: [
            {
              text: 'Rework the offline path',
              label: 'Offline path',
              acceptance_criteria: [{ text: 'capture works with no Cloud connection' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(planned.exitCode, planned.stdout + planned.stderr).toBe(0);
    const plan = JSON.parse(planned.stdout) as {
      artifact_id: string;
      plan_steps: { step_id: string }[];
    };
    const artifactId = plan.artifact_id;
    const stepIds = plan.plan_steps.map((step) => step.step_id);
    const adopted = await adoptedRequirement(value.writer, {
      projectId: value.authority.projectId,
      statement: OFFLINE,
    });
    const before = JSON.parse((await agent(value).runRaw(['doctor', '--json'])).stdout) as {
      checks: { name: string; status: string }[];
    };

    const observationId = await failedObservation(value.writer, adopted.sourceId);
    const assessmentId = await contradictedAssessment(value.writer, {
      requirementId: adopted.requirementId,
      revisionId: adopted.revisionId,
      observationId,
      release: ASSESSED_RELEASE,
    });

    const opened = await agent(value).runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: artifactId,
          declared_step_ids: stepIds,
        })
      ),
    ]);
    expect(opened.exitCode, opened.stdout + opened.stderr).toBe(0);
    const openResult = JSON.parse(opened.stdout) as Record<string, unknown>;
    expect(openResult).toMatchObject({ ok: true, artifact_id: artifactId });
    expect(openResult).not.toHaveProperty('blocked_evaluator_refs');
    expect(openResult.status).not.toBe('blocked');

    const closed = await agent(value).runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: artifactId,
          n: openResult.n,
          summary: 'nothing was changed',
          files_changed: [],
          completed_step_ids: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
        })
      ),
    ]);
    expect(closed.exitCode, closed.stdout + closed.stderr).toBe(0);

    const finished = await agent(value).runRaw([
      'finish',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `finish-${randomUUID()}`,
          outcome: 'the work is done',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
        })
      ),
    ]);
    expect(finished.exitCode, finished.stdout + finished.stderr).toBe(0);
    expect(JSON.parse(finished.stdout)).toMatchObject({
      ok: true,
      artifact_id: artifactId,
      capture_status: 'committed',
    });

    const after = JSON.parse((await agent(value).runRaw(['doctor', '--json'])).stdout) as {
      checks: { name: string; status: string; details?: string[] }[];
    };
    const named = (report: { checks: { name: string; status: string }[] }) =>
      report.checks.map((check) => `${check.name}:${check.status}`).sort();
    expect(named(after)).toEqual(named(before));
    expect(JSON.stringify(after)).not.toContain(assessmentId);
    expect(JSON.stringify(after)).not.toContain(observationId);

    // And both are still retained: nothing here withdrew, rewrote or hid them.
    const retained = value.writer.read((view) => ({
      assessment: readProjectKnowledgeAssessment(view, assessmentId),
      observation: readProjectObservation(view, observationId),
    })).value;
    expect(retained.assessment?.conclusions).toEqual([
      {
        expectation: {
          kind: 'requirement',
          entity_id: adopted.requirementId,
          revision_id: adopted.revisionId,
        },
        conclusion: 'contradicted',
      },
    ]);
    expect(retained.observation?.outcome).toBe('failed');
  });
});
