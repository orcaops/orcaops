import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  appendProjectCorrection,
  publishProjectContinuingClaimRevision,
  publishProjectContinuingDecisionRevision,
  publishProjectKnowledgeSource,
  publishProjectRelationship,
  publishProjectRequirementRevision,
  publishProjectSelection,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture } from '../helpers/database-history.js';
import { adoptedRequirement, AT, instructionSource, OWNER } from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

async function denseHistory() {
  const f = await fixture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, 'src/navigation.ts', 'export const nativeHistory = true;\n');
  const relevant = {
    decision: 'Use native history in src/navigation.ts.',
    reason: 'Back must restore the previous list and scroll position.',
    alternatives_considered: [
      {
        option: 'Recreate the list on return.',
        rejected_because: 'Recreation loses scroll state.',
      },
    ],
  };
  const decisions = [
    ...Array.from({ length: 42 }, (_, i) => ({
      decision: `Partition billing archive ${i} by fiscal year.`,
      reason:
        'Retain independent invoice audit records and regional accounting boundaries. '.repeat(14),
      alternatives_considered: [],
    })),
    relevant,
  ];
  const artifactId = await f.capture();
  await closeFingerprintedCheckpoint(f, artifactId, {
    files: ['src/navigation.ts'],
    openRef,
    closeRef,
    decisions,
  });
  const event = readProjectArtifact(f.writer, artifactId)!.thread.events.find(
    (item) => item.record.type === 'checkpoint_closed'
  )!;
  for (const [index, choice] of decisions.entries()) {
    const sourceId = uuidv7();
    const location = `decisions[${index}].decision`;
    await publishProjectKnowledgeSource(f.writer, {
      operationId: uuidv7(),
      source: {
        source_id: sourceId,
        occurrence: {
          kind: 'capture_field',
          artifact_id: artifactId,
          event_id: event.record.event_id,
          field_path: location,
          position: 0,
        },
        source_author: OWNER,
        interpreted_by: null,
        access_restriction: null,
      },
      recordedBy: OWNER,
      secretAllow: [],
    });
    await publishProjectContinuingDecisionRevision(f.writer, {
      operationId: uuidv7(),
      attributedTo: { kind: 'actor', actor: OWNER },
      occurrence: { source_id: sourceId, location },
      secretAllow: [],
      revision: {
        decision_id: uuidv7(),
        revision_id: uuidv7(),
        previous_revision_id: null,
        chosen_approach: choice.decision,
        rationale: choice.reason,
        alternatives: [],
        assumptions: [],
        reconsideration_conditions: [],
        subject: null,
        derivation: null,
        applicability: { all_of: [] },
        source_ids: [sourceId],
        passages: [
          {
            source_id: sourceId,
            location,
            passage_sha256: createHash('sha256').update(choice.decision).digest('hex'),
          },
        ],
        source_standing: 'extracted_candidate',
        recorded_at: AT,
      },
    });
  }
  const other = await f.capture();
  await closeFingerprintedCheckpoint(f, other, {
    files: ['src/navigation.ts'],
    openRef,
    closeRef,
    decisions: [
      {
        decision: 'Keep independent navigation tab stacks.',
        reason: 'Each tab retains its own return history.',
      },
    ],
  });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  return { agent, relevant };
}

it('preserves candidates and target-specific explanations under background knowledge pressure', async () => {
  const { agent, relevant } = await denseHistory();
  for (const flags of [[], ['--view', 'rationale'], ['--details', '--audit']]) {
    const response = await agent.runRaw(['why', 'src/navigation.ts', '--json', ...flags]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    const answer = JSON.parse(response.stdout);
    expect(answer.schema_version).toBe(8);
    expect(answer.conclusion).toBe('ambiguous');
    expect(answer.results.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(answer.knowledge.rationale)).toContain(relevant.decision);
    expect(JSON.stringify(answer.knowledge.rationale)).toContain(relevant.reason);
    expect(JSON.stringify(answer.knowledge.rationale)).toContain('Recreation loses scroll state.');
    expect(answer.output.rationale_withheld).toBeNull();
    for (const field of ['entries', 'interpretations', 'background', 'applicable'])
      expect(answer.knowledge).not.toHaveProperty(field);
    expect(answer.results[0]).not.toHaveProperty('plan_support');
    expect(answer.results[0]).not.toHaveProperty('source_plan');
    expect(answer.results[0]).not.toHaveProperty('version_token');
    expect(answer).not.toHaveProperty('source_versions');
    expect(answer).not.toHaveProperty('scope');
    expect(answer.target).not.toHaveProperty('content_hash');
    expect(answer.diagnostics.project_coverage).not.toHaveProperty('inventory_token');
    expect(answer.diagnostics.retrieval).not.toHaveProperty('source_bytes');
    if (!flags.includes('--details')) expect(answer).not.toHaveProperty('audit');
    const selected = answer.knowledge.rationale.find(
      (item: { account?: { wording?: string } }) => item.account?.wording === relevant.decision
    );
    expect(selected.relevance.target.kind).toBe('explicit_path');
    expect(answer.knowledge.rationale[0].account.wording).toBe(relevant.decision);
    expect(selected.context).toHaveLength(1);
    expect(selected.context[0]).not.toHaveProperty('revisions');
    expect(selected.context[0]).not.toHaveProperty('connected_later');
    if (flags.includes('--details')) {
      expect(selected.context[0]).toHaveProperty('sources');
      expect(selected.context[0]).toHaveProperty('explanation');
    } else {
      expect(selected.context[0]).not.toHaveProperty('sources');
      expect(selected.context[0]).not.toHaveProperty('explanation');
      expect(selected.context[0].qualification).toHaveProperty('standing');
      expect(selected.context[0].qualification).toHaveProperty('scopes');
      expect(selected.context[0].unresolved).toContainEqual({
        about: 'evidence',
        reason: 'evidence_not_attached',
        record_ids: [],
      });
    }
    expect(selected.account).not.toHaveProperty('path');
    expect(selected).not.toHaveProperty('verification');
    expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(
      flags.includes('--details') ? 65_536 : flags.includes('rationale') ? 32_768 : 16_384
    );
    if (flags.includes('--details')) expect(answer.audit.candidates.length).toBeGreaterThan(0);
    const expanded = await agent.runRaw(['knowledge', 'show', selected.reference, '--json']);
    expect(JSON.parse(expanded.stdout)).toMatchObject({
      status: 'available',
      content: { wording: relevant.decision, reason: relevant.reason },
    });
  }
});

it('keeps competing governing revisions and a replacement outside the queried scope distinct', async () => {
  const f = await fixture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, 'src/cache.ts', 'export const durable = true;\n');
  const artifactId = await f.capture();
  await closeFingerprintedCheckpoint(f, artifactId, { files: ['src/cache.ts'], openRef, closeRef });
  const original = await adoptedRequirement(f.writer, {
    projectId: f.authority.projectId,
    statement: 'Retain the local cache for thirty days.',
  });
  const wording = 'Retain the local cache for seven days.';
  const sourceId = await instructionSource(f.writer, wording);
  const revisionId = uuidv7();
  await publishProjectRequirementRevision(f.writer, {
    operationId: uuidv7(),
    attributedTo: { kind: 'actor', actor: OWNER },
    secretAllow: [],
    revision: {
      requirement_id: original.requirementId,
      revision_id: revisionId,
      previous_revision_id: original.revisionId,
      statement: wording,
      rationale: 'Limit local retention.',
      subject: null,
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [sourceId],
      passages: [],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
  });
  const target = {
    kind: 'requirement' as const,
    entity_id: original.requirementId,
    revision_id: revisionId,
  };
  const prior = { ...target, revision_id: original.revisionId };
  const scope = { kind: 'project' as const, project_id: f.authority.projectId };
  await publishProjectSelection(f.writer, {
    operationId: uuidv7(),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
    selection: {
      selection_id: uuidv7(),
      kind: 'accepted',
      target,
      scope,
      designation: 'adopted',
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: sourceId,
        acknowledged: [prior],
        scope,
      },
      expected_state: {
        kind: 'observed',
        selection_ids: [original.selectionId],
        correction_action_ids: [],
      },
    },
  });
  const otherArtifact = await f.capture();
  const otherScope = { kind: 'artifact' as const, artifact_id: otherArtifact };
  const relationshipId = uuidv7();
  await publishProjectRelationship(f.writer, {
    operationId: uuidv7(),
    attributedTo: { kind: 'actor', actor: OWNER },
    recordedAt: AT,
    secretAllow: [],
    relationship: {
      relationship_id: relationshipId,
      relation: 'supersedes',
      from: target,
      to: prior,
      scope: otherScope,
      standing: 'established',
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: sourceId,
        acknowledged: [prior],
        scope: otherScope,
      },
      source_ids: [sourceId],
      explanation: 'Shorter retention applies only to the other task.',
    },
  });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const response = await agent.runRaw(['why', 'src/cache.ts:1', '--json']);
  expect(response.exitCode, response.stderr || response.stdout).toBe(0);
  const answer = JSON.parse(response.stdout);
  const obligation = answer.knowledge.obligations.find(
    (entry: { id: string }) => entry.id === `requirement:${original.requirementId}`
  );
  expect(obligation.accounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ statement: original.statement, standing: 'adopted' }),
      expect.objectContaining({ statement: wording, standing: 'adopted' }),
    ])
  );
  expect(obligation.conflicts).toHaveLength(1);
  const current = await agent.runRaw(['knowledge', 'show', obligation.reference, '--json']);
  expect(current.exitCode, current.stderr || current.stdout).toBe(0);
  expect(JSON.parse(current.stdout)).toMatchObject({
    mode: 'current',
    qualification_status: 'included_summary',
    current_status: [expect.objectContaining({ conflicts: expect.any(Array) })],
  });
  expect(JSON.parse(current.stdout).current_status[0].conflicts).toHaveLength(1);
  expect(answer.knowledge.evolution).toContainEqual(
    expect.objectContaining({
      id: relationshipId,
      kind: 'outside_scope',
      applied: false,
      not_applied: 'another_scope',
    })
  );
  const human = await agent.runRaw(['why', 'src/cache.ts:1']);
  expect(human.stdout).toContain(original.statement);
  expect(human.stdout).toContain(wording);
  expect(human.stdout).toContain('Conflicting governing revisions');
  expect(human.stdout).toContain('no effect in this scope');

  const sibling = await adoptedRequirement(f.writer, {
    projectId: f.authority.projectId,
    statement: 'Keep cache encryption enabled.',
  });
  const appliedId = uuidv7();
  await publishProjectRelationship(f.writer, {
    operationId: uuidv7(),
    attributedTo: { kind: 'actor', actor: OWNER },
    recordedAt: AT,
    secretAllow: [],
    relationship: {
      relationship_id: appliedId,
      relation: 'supersedes',
      from: target,
      to: prior,
      scope,
      standing: 'established',
      authorization: {
        kind: 'informed_instruction',
        instruction_source_id: sourceId,
        acknowledged: [prior],
        scope,
      },
      source_ids: [sourceId],
      explanation: 'Shorter retention now applies to the project; encryption is unchanged.',
    },
  });
  const replaced = JSON.parse((await agent.runRaw(['why', 'src/cache.ts:1', '--json'])).stdout);
  expect(replaced.knowledge.evolution).toContainEqual(
    expect.objectContaining({
      id: appliedId,
      standing: 'established',
      applied: true,
      earlier: expect.objectContaining({
        statement: original.statement,
        availability: 'available',
      }),
      later: expect.objectContaining({ statement: wording, availability: 'available' }),
    })
  );
  expect(replaced.knowledge.obligations).toContainEqual(
    expect.objectContaining({ id: `requirement:${sibling.requirementId}` })
  );
});

it('summarizes successful checks but retains causal failures and corrected verification accounts', async () => {
  const f = await fixture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, 'src/cache.ts', 'export const durable = true;\n');
  const artifactId = await f.capture();
  const statement = 'TypeScript passed.';
  const reason = 'The restart test failed because volatile storage discarded the pending write.';
  await closeFingerprintedCheckpoint(f, artifactId, {
    files: ['src/cache.ts'],
    openRef,
    closeRef,
    summary: statement,
    decisions: [{ decision: 'Persist cache writes before acknowledging them.', reason }],
  });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const initial = JSON.parse((await agent.runRaw(['why', 'src/cache.ts', '--json'])).stdout);
  expect(initial.knowledge.verification.reported_records).toBe(1);
  expect(
    initial.knowledge.rationale.some(
      (item: { account: { wording: string } }) => item.account?.wording === statement
    )
  ).toBe(false);
  expect(JSON.stringify(initial.knowledge.rationale)).toContain(reason);
  const expanded = JSON.parse(
    (
      await agent.runRaw([
        'knowledge',
        'show',
        initial.knowledge.verification.references[0],
        '--json',
      ])
    ).stdout
  );
  expect(expanded.content.wording).toBe(statement);

  const eventId = readProjectArtifact(f.writer, artifactId)!.thread.events.find(
    (event) => event.record.type === 'checkpoint_closed'
  )!.record.event_id;
  const sourceId = uuidv7();
  await publishProjectKnowledgeSource(f.writer, {
    operationId: uuidv7(),
    recordedBy: OWNER,
    secretAllow: [],
    source: {
      source_id: sourceId,
      occurrence: {
        kind: 'capture_field',
        artifact_id: artifactId,
        event_id: eventId,
        field_path: 'summary',
        position: 0,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
  });
  const claimId = uuidv7();
  const revisionId = uuidv7();
  await publishProjectContinuingClaimRevision(f.writer, {
    operationId: uuidv7(),
    attributedTo: { kind: 'actor', actor: OWNER },
    secretAllow: [],
    occurrence: { source_id: sourceId, location: 'summary' },
    revision: {
      claim_id: claimId,
      revision_id: revisionId,
      previous_revision_id: null,
      statement,
      subject: null,
      applicability: { all_of: [] },
      source_ids: [sourceId],
      passages: [
        {
          source_id: sourceId,
          location: 'summary',
          passage_sha256: createHash('sha256').update(statement).digest('hex'),
        },
      ],
      source_standing: 'agent_proposal',
      observation_ids: [],
      verification: null,
      recorded_at: AT,
    },
  });
  const reported = JSON.parse((await agent.runRaw(['why', 'src/cache.ts', '--json'])).stdout);
  expect(reported.knowledge.verification).toMatchObject({
    status: 'reported',
    reported_records: 1,
    omitted_status_records: 0,
    groups: [expect.objectContaining({ evidence: 'not_attached', authority: 'recorded_account' })],
  });
  const correction = 'Only the storage package was checked; the application typecheck was not run.';
  const correctionSource = await instructionSource(f.writer, correction);
  const actionId = uuidv7();
  await appendProjectCorrection(f.writer, {
    operationId: uuidv7(),
    attributedTo: { kind: 'actor', actor: OWNER },
    secretAllow: [],
    action: {
      action_id: actionId,
      kind: 'factual_correction',
      targets: [{ kind: 'claim', entity_id: claimId, revision_id: revisionId }],
      scope: { kind: 'project', project_id: f.authority.projectId },
      source_id: correctionSource,
      authorization: null,
      expected_state: { kind: 'initial' },
      corrected_account: correction,
    },
  });
  const answer = JSON.parse((await agent.runRaw(['why', 'src/cache.ts', '--json'])).stdout);
  const retained = answer.knowledge.rationale.find(
    (item: { account: { wording: string } }) => item.account?.wording === statement
  );
  expect(retained.context[0].corrections[0]).toMatchObject({
    action_id: actionId,
    wording: correction,
    source_id: correctionSource,
    unavailable: false,
  });
  expect(retained.context[0]).toHaveProperty('sources');
  expect(retained.context[0]).toHaveProperty('explanation');
  expect(answer.knowledge.verification).toBeNull();
  const corrected = JSON.parse(
    (
      await agent.runRaw([
        'knowledge',
        'show',
        retained.context[0].corrections[0].reference,
        '--json',
      ])
    ).stdout
  );
  expect(corrected.content).toMatchObject({ action_id: actionId, corrected_account: correction });
  expect(
    answer.knowledge.evolution.some((entry: { kind: string }) => entry.kind === 'relationship')
  ).toBe(false);

  const extensive = 'Do not treat the application as verified. '.repeat(400);
  await appendProjectCorrection(f.writer, {
    operationId: uuidv7(),
    attributedTo: { kind: 'actor', actor: OWNER },
    secretAllow: [],
    action: {
      action_id: uuidv7(),
      kind: 'factual_correction',
      targets: [{ kind: 'claim', entity_id: claimId, revision_id: revisionId }],
      scope: { kind: 'project', project_id: f.authority.projectId },
      source_id: correctionSource,
      authorization: null,
      expected_state: { kind: 'initial' },
      corrected_account: extensive,
    },
  });
  const bounded = JSON.parse((await agent.runRaw(['why', 'src/cache.ts', '--json'])).stdout);
  expect(
    bounded.knowledge.rationale.some(
      (item: { account: { wording: string } }) => item.account?.wording === statement
    )
  ).toBe(false);
  expect(bounded.knowledge.verification).toBeNull();
  expect(bounded.output.selection.omitted_oversized).toBeGreaterThan(0);
  const placeholder = bounded.knowledge.rationale.find(
    (item: { status?: string }) => item.status === 'omitted_oversized'
  );
  expect(placeholder.corrections).toHaveLength(2);
  expect(placeholder.corrections[0]).toMatchObject({
    content: 'not_displayed',
    status: expect.any(String),
  });
  expect(placeholder.context_references.length).toBeGreaterThan(0);
  const inspections = [];
  for (const { reference } of placeholder.corrections)
    inspections.push(
      JSON.parse((await agent.runRaw(['knowledge', 'show', reference, '--json'])).stdout)
    );
  const oversized = inspections.find((item) => item.status === 'omitted_oversized');
  expect(oversized.content).toBeNull();
  expect(oversized.follow_up.export).toContain('--output');
  for (const selected of inspections.filter((item) => item.status === 'omitted_oversized')) {
    const detailed = await agent.runRaw([
      'knowledge',
      'show',
      selected.reference,
      '--json',
      '--details',
    ]);
    expect(Buffer.byteLength(detailed.stdout)).toBeLessThanOrEqual(32768);
    inspections.push(JSON.parse(detailed.stdout));
  }
  expect(inspections).toContainEqual(
    expect.objectContaining({
      status: 'available',
      content: expect.objectContaining({ corrected_account: extensive }),
    })
  );
  for (let index = 0; index < 5; index++)
    await appendProjectCorrection(f.writer, {
      operationId: uuidv7(),
      attributedTo: { kind: 'actor', actor: OWNER },
      secretAllow: [],
      action: {
        action_id: uuidv7(),
        kind: 'factual_correction',
        targets: [{ kind: 'claim', entity_id: claimId, revision_id: revisionId }],
        scope: { kind: 'project', project_id: f.authority.projectId },
        source_id: correctionSource,
        authorization: null,
        expected_state: { kind: 'initial' },
        corrected_account: `Additional verification caveat ${index}.`,
      },
    });
  const crowded = JSON.parse((await agent.runRaw(['why', 'src/cache.ts', '--json'])).stdout);
  const incomplete = crowded.knowledge.rationale.find(
    (item: { status?: string }) => item.status === 'omitted_oversized'
  );
  expect(incomplete.corrections).toHaveLength(4);
  expect(incomplete.omitted_corrections).toBe(3);
  expect(crowded.knowledge.verification).toBeNull();
});

it('reserves a reported verification summary before explanations fill the byte allowance', async () => {
  const f = await fixture();
  const artifact = await f.capture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, 'src/cache.ts', 'export const durable = true;\n');
  await closeFingerprintedCheckpoint(f, artifact, {
    files: ['src/cache.ts'],
    openRef,
    closeRef,
    summary: 'TypeScript passed.',
    decisions: Array.from({ length: 40 }, (_, index) => ({
      decision: `Retain cache policy ${index}.`,
      reason: 'The full cache consistency requirements apply to every acknowledged write. '.repeat(
        30
      ),
    })),
  });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const response = await agent.runRaw(['why', 'src/cache.ts', '--json']);
  expect(response.exitCode, response.stderr || response.stdout).toBe(0);
  const answer = JSON.parse(response.stdout);
  expect(answer.output.omitted_rationale).toBeGreaterThan(0);
  expect(answer.output.omitted_verification).toBe(0);
  expect(answer.knowledge.verification).toMatchObject({ status: 'reported', reported_records: 1 });
  expect(answer.knowledge.verification.references).toHaveLength(1);
  expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(32768);
});
