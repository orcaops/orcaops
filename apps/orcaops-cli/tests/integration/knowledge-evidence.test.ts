import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  createProjectRequirement,
  type ProjectDatabase,
  publishProjectKnowledgeSource,
} from '@orcaops/storage/history/database';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * `orcaops knowledge observe` and `orcaops knowledge assess` against a real project database.
 * Neither needs a provider, a grant or a model, so nothing here configures one.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;

const AT = '2026-09-17T16:00:00.000Z';
const OWNER = { identity: 'owner@example.test', basis: 'authenticated' } as const;

function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 120_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'evidence-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      XDG_STATE_HOME: `${f.temporary}/unused-state`,
    },
  });
}

async function writeConfig(f: Fixture) {
  await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(f.main, '.orcaops', 'config.json'),
    JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm: { tool: 'none' } }),
    'utf8'
  );
}

// The record is written straight out: `inputFile` injects an idempotency key, which a capture
// payload carries and a contract record has no field for.
let written = 0;
async function run(f: Fixture, verb: string, document: unknown, extra: string[] = []) {
  const at = path.join(f.temporary, `record-${(written += 1)}.json`);
  await writeFile(at, JSON.stringify(document), 'utf8');
  const raw = await agent(f).runRaw(['knowledge', verb, '--input', at, '--json', ...extra]);
  return { raw, data: JSON.parse(raw.stdout) as Record<string, unknown> };
}

/** A retained source and a requirement revision, which only storage can author today. */
async function expectation(handle: ProjectDatabase) {
  const bytes = Buffer.from('Local capture works with no Cloud connection.', 'utf8');
  const source = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'user_instruction',
        retention: {
          kind: 'bytes',
          content_sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        location: 'session transcript, turn 2',
        source_time: AT,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: OWNER,
    retainedBytes: bytes,
    secretAllow: [],
  });
  const sourceId = source.value.sourceId;
  const requirementId = uuidv7();
  const revisionId = uuidv7();
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: { requirement_id: requirementId, origin: { kind: 'authored', source_id: sourceId } },
    revision: {
      requirement_id: requirementId,
      revision_id: revisionId,
      previous_revision_id: null,
      statement: 'Local capture works with no Cloud connection.',
      rationale: 'Captures must never depend on network availability.',
      subject: null,
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [sourceId],
      passages: [],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: { kind: 'actor', actor: OWNER },
    secretAllow: [],
  });
  return {
    sourceId,
    target: { kind: 'requirement', entity_id: requirementId, revision_id: revisionId },
  };
}

const rows = (handle: ProjectDatabase, table: string) =>
  handle.read((view) => view.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n).value;

describe('recording an observation', () => {
  it('records an agent-reported command and says so in the envelope', async () => {
    const f = await fixture();
    await writeConfig(f);
    const { sourceId } = await expectation(f.writer);
    const observationId = uuidv7();
    const { raw, data } = await run(f, 'observe', {
      observation_id: observationId,
      source_id: sourceId,
      observed_by: { identity: 'claude-code', basis: 'other_assertion' },
      method: { name: 'vitest', configuration_sha256: null },
      execution: { kind: 'agent_reported', command: 'pnpm vitest run offline-capture' },
      input_basis: 'unknown',
      known_inputs: [],
      outcome: 'passed',
      detail: null,
      retained_artifacts: [],
      started_at: AT,
      finished_at: AT,
      limits: ['nothing checked which files the suite opened'],
    });
    expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
    expect(data).toMatchObject({ ok: true, observation_id: observationId });
    expect(
      f.writer.read((view) =>
        view.get<{ executionKind: string; inputBasis: string; observedBy: string }>(
          `SELECT execution_kind AS executionKind, input_basis AS inputBasis,
                  observed_by AS observedBy FROM knowledge_observations WHERE observation_id=?`,
          observationId
        )
      ).value
    ).toEqual({
      executionKind: 'agent_reported',
      inputBasis: 'unknown',
      observedBy: 'claude-code',
    });
  });

  it('attributes a record that names nobody to the invoking agent, and leaves a named one alone', async () => {
    const f = await fixture();
    await writeConfig(f);
    const { sourceId } = await expectation(f.writer);
    const unattributed = uuidv7();
    const byAgent = uuidv7();
    const attributed = uuidv7();
    for (const [id, named, args] of [
      [unattributed, {}, []],
      [byAgent, {}, ['--invoked-by-agent', 'codex']],
      [attributed, { observed_by: { identity: 'a reviewer', basis: 'source_attributed' } }, []],
    ] as const) {
      const { raw } = await run(
        f,
        'observe',
        {
          observation_id: id,
          source_id: sourceId,
          ...named,
          method: { name: 'manual', configuration_sha256: null },
          execution: { kind: 'human_observation' },
          input_basis: 'unknown',
          known_inputs: [],
          outcome: 'observed',
          detail: null,
          retained_artifacts: [],
          started_at: null,
          finished_at: null,
          limits: [],
        },
        [...args]
      );
      expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
    }
    const attribution = (id: string) =>
      f.writer.read((view) =>
        view.get<{ observedBy: string | null; basis: string }>(
          `SELECT observed_by AS observedBy, observed_by_basis AS basis
             FROM knowledge_observations WHERE observation_id=?`,
          id
        )
      ).value!;
    // The account this process runs as, on a basis a local invocation can honestly carry. An
    // agent that named itself reported the act on somebody's instruction; one that did not is
    // another assertion. Neither is ever `authenticated`: nothing here authenticates anybody.
    expect(attribution(unattributed).observedBy).not.toBe(null);
    expect(attribution(unattributed).basis).toBe('other_assertion');
    expect(attribution(byAgent).basis).toBe('agent_reported_user_instruction');
    expect(attribution(byAgent).observedBy).toBe(attribution(unattributed).observedBy);
    // A record that says who observed it keeps its own attribution, basis and all.
    expect(attribution(attributed)).toEqual({
      observedBy: 'a reviewer',
      basis: 'source_attributed',
    });
  });

  it('refuses to record a runner-established execution from a report of one', async () => {
    const f = await fixture();
    await writeConfig(f);
    const { sourceId } = await expectation(f.writer);
    const { raw, data } = await run(f, 'observe', {
      observation_id: uuidv7(),
      source_id: sourceId,
      method: { name: 'vitest', configuration_sha256: null },
      execution: {
        kind: 'runner_established',
        runner: 'my-own-runner',
        consumed_inputs: [{ kind: 'git_commit', identity: 'a'.repeat(40) }],
      },
      input_basis: 'snapshot_bound',
      known_inputs: [{ kind: 'git_commit', identity: 'a'.repeat(40) }],
      outcome: 'passed',
      detail: null,
      retained_artifacts: [],
      started_at: AT,
      finished_at: AT,
      limits: [],
    });
    expect(raw.exitCode).toBe(1);
    expect(data).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', path: 'execution.kind' },
    });
    expect(rows(f.writer, 'knowledge_observations')).toBe(0);
  });

  it('refuses an observation of a source this history does not hold, and writes nothing', async () => {
    const f = await fixture();
    await writeConfig(f);
    const { raw, data } = await run(f, 'observe', {
      observation_id: uuidv7(),
      source_id: uuidv7(),
      method: { name: 'manual', configuration_sha256: null },
      execution: { kind: 'human_observation' },
      input_basis: 'unknown',
      known_inputs: [],
      outcome: 'observed',
      detail: null,
      retained_artifacts: [],
      started_at: null,
      finished_at: null,
      limits: [],
    });
    expect(raw.exitCode).toBe(1);
    expect(data).toMatchObject({ ok: false, error: { code: 'HISTORY_MISSING' } });
    expect(rows(f.writer, 'knowledge_observations')).toBe(0);
  });
});

describe('recording an assessment', () => {
  it('assesses a selected release with no task and stamps the counters it observed', async () => {
    const f = await fixture();
    await writeConfig(f);
    const { sourceId, target } = await expectation(f.writer);
    const observationId = uuidv7();
    await run(f, 'observe', {
      observation_id: observationId,
      source_id: sourceId,
      method: { name: 'smoke', configuration_sha256: null },
      execution: { kind: 'human_observation' },
      input_basis: 'partial',
      known_inputs: [{ kind: 'release', identity: '0.2.1' }],
      outcome: 'passed',
      detail: null,
      retained_artifacts: [],
      started_at: AT,
      finished_at: AT,
      limits: [],
    });
    const assessmentId = uuidv7();
    const { raw, data } = await run(f, 'assess', {
      assessment_id: assessmentId,
      assessed_by: OWNER,
      expectations: [target],
      exception_ids: [],
      implementation: {
        kind: 'selected',
        inputs: [{ kind: 'release', identity: '0.2.1' }],
        environment: 'macOS 15.3 arm64',
      },
      evidence: [
        {
          source: { kind: 'observation', observation_id: observationId },
          role: 'supports',
          limitations: 'one platform only',
        },
      ],
      method: { name: 'release review', configuration_sha256: null },
      conclusions: [
        {
          expectation: target,
          conclusion: 'supported',
          reason: 'Capture completed with the network down.',
        },
      ],
      check_states: [
        { check: 'the integration suite', state: 'skipped', detail: 'no provider configured' },
      ],
      coverage_limits: ['nothing was run on Windows'],
    });
    expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
    expect(data).toMatchObject({ ok: true, assessment_id: assessmentId });
    expect(
      f.writer.read((view) =>
        view.get<{ conclusion: string }>(
          'SELECT conclusion FROM knowledge_assessment_conclusions WHERE assessment_id=?',
          assessmentId
        )
      ).value
    ).toEqual({ conclusion: 'supported' });
    // Stamped from the store, and never advanced by the assessment itself.
    const stamped = f.writer.read((view) =>
      view.get<{ observed: number }>(
        'SELECT observed_write_sequence AS observed FROM knowledge_assessments WHERE assessment_id=?',
        assessmentId
      )
    );
    expect(stamped.value!.observed).toBeGreaterThan(0);
    expect((data.counters as { intentChangeCounter: number }).intentChangeCounter).toBe(
      stamped.counters.intentChangeCounter
    );
    expect(rows(f.writer, 'knowledge_assessment_check_states')).toBe(1);
  });

  it('refuses a satisfaction claim against unidentified software', async () => {
    const f = await fixture();
    await writeConfig(f);
    const { target } = await expectation(f.writer);
    const { raw, data } = await run(f, 'assess', {
      assessment_id: uuidv7(),
      assessed_by: OWNER,
      expectations: [target],
      exception_ids: [],
      implementation: { kind: 'none_selected' },
      evidence: [],
      method: { name: 'release review', configuration_sha256: null },
      conclusions: [
        { expectation: target, conclusion: 'supported', reason: 'it worked on my machine' },
      ],
      check_states: [],
      coverage_limits: [],
    });
    expect(raw.exitCode).toBe(1);
    expect(data).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(rows(f.writer, 'knowledge_assessments')).toBe(0);
  });
});
