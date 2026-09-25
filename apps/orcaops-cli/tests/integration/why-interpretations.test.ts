import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  interpretationSegmentId,
  type KnowledgeInterpretation,
  knowledgeInterpretationId,
  prepareInterpretationText,
  uuidv7,
} from '@orcaops/storage';
import {
  publishInterpretedKnowledge,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture } from '../helpers/database-history.js';
import { AT, OWNER } from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

it('groups a retained interpretation with its exact capture and expands both accounts through why', async () => {
  const f = await fixture();
  const artifact = await f.capture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, 'src/delivery.ts', 'export const durable = true;\n');
  const decision = 'Replace the delivery lease with a transactional outbox.';
  const reason = 'A crash after acknowledgement must not discard notification delivery.';
  await closeFingerprintedCheckpoint(f, artifact, {
    files: ['src/delivery.ts'],
    openRef,
    closeRef,
    decisions: [
      {
        decision,
        reason,
        alternatives_considered: [
          { option: 'A memory-only queue.', rejected_because: 'Restart loses acknowledged work.' },
        ],
      },
    ],
  });
  const events = readProjectArtifact(f.writer, artifact)!.thread.events;
  const eventId = events.find((entry) => entry.record.type === 'checkpoint_closed')!.record
    .event_id;
  const planId = events.find((entry) => entry.record.type === 'plan_captured')!.record.event_id;
  const sourceId = uuidv7();
  const occurrence = {
    kind: 'capture_field' as const,
    artifact_id: artifact,
    event_id: eventId,
    field_path: 'decisions[0].decision',
    position: 0,
  };
  const prepared = prepareInterpretationText(decision);
  const segmentIdentity = {
    source_id: sourceId,
    occurrence,
    role: 'decision' as const,
    purpose: 'primary' as const,
    original_sha256: prepared.originalSha256,
    prepared_sha256: prepared.preparedSha256,
    mapping_version: prepared.mappingVersion,
    mapping_sha256: prepared.mappingSha256,
    prepared_range: { start: 0, end: Buffer.byteLength(prepared.prepared) },
    mapping: [...prepared.mapping],
  };
  const segment = { segment_id: interpretationSegmentId(segmentIdentity), ...segmentIdentity };
  const detector = { kind: 'detector', detector: 'knowledge-processor' } as const;
  const identity: Omit<KnowledgeInterpretation, 'interpretation_id' | 'recorded_at'> = {
    source_origin: { source_id: sourceId, task: { artifact_id: artifact, plan_event_id: planId } },
    wording: 'Use a transactional outbox instead of the delivery lease.',
    source_form: 'stated_decision',
    proposed_record: 'decision',
    intended_scope: { kind: 'project' },
    rationale: { kind: 'unknown' },
    uncertainties: [],
    canonical_outcome: { kind: 'none', target: null },
    attributed_to: detector,
    evidence: [
      {
        source_id: sourceId,
        segment_id: segment.segment_id,
        mapping_version: prepared.mappingVersion,
        mapping_sha256: prepared.mappingSha256,
        prepared_sha256: prepared.preparedSha256,
        prepared_start_utf8: 0,
        prepared_end_utf8: Buffer.byteLength(decision),
        original_ranges: [{ start: 0, end: Buffer.byteLength(decision) }],
        quote: decision,
        passage_sha256: createHash('sha256').update(decision).digest('hex'),
      },
    ],
  };
  const { attributed_to: _attribution, ...authored } = identity;
  const interpretationId = knowledgeInterpretationId('knowledge-interpretation@2', identity);
  await publishInterpretedKnowledge(f.writer, {
    operationId: uuidv7(),
    recordedBy: OWNER,
    attributedTo: detector,
    scope: { kind: 'artifact', artifact_id: artifact },
    secretAllow: [],
    sources: [
      {
        source_id: sourceId,
        occurrence,
        source_author: OWNER,
        interpreted_by: detector,
        access_restriction: null,
      },
    ],
    segments: [segment],
    processorContract: 'knowledge-interpretation@2',
    records: [
      {
        kind: 'interpretation',
        interpretation: { ...authored, interpretation_id: interpretationId, recorded_at: AT },
        restsOn: [],
      },
    ],
  });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  for (const flags of [[], ['--view', 'rationale'], ['--details', '--audit']]) {
    const response = await agent.runRaw(['why', 'src/delivery.ts', '--json', ...flags]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    const answer = JSON.parse(response.stdout);
    const group = answer.knowledge.rationale.find(
      (item: { account?: { wording: string } }) => item.account?.wording === decision
    );
    expect(group.account).toMatchObject({
      reason,
      alternatives: [
        { option: 'A memory-only queue.', rejected_because: 'Restart loses acknowledged work.' },
      ],
    });
    expect(group.interpretations).toEqual([
      expect.objectContaining({
        id: interpretationId,
        authority: 'unapproved_interpretation',
        account: { wording: identity.wording, reason: null, alternatives: [] },
      }),
    ]);
    expect(
      answer.knowledge.rationale.some((item: { id: string }) => item.id === interpretationId)
    ).toBe(false);
    if (flags.includes('--audit')) expect(answer.output.selection.grouped_interpretations).toBe(1);
    else expect(answer.output.selection).not.toHaveProperty('grouped_interpretations');
    const source = JSON.parse(
      (await agent.runRaw(['knowledge', 'show', group.reference, '--json'])).stdout
    );
    expect(source.content).toMatchObject({ wording: decision, reason });
    const variant = JSON.parse(
      (await agent.runRaw(['knowledge', 'show', group.interpretations[0].reference, '--json']))
        .stdout
    );
    expect(variant.content).toMatchObject({
      interpretation_id: interpretationId,
      wording: identity.wording,
      rationale: { kind: 'unknown' },
    });
    expect(
      answer.knowledge.evolution.filter(
        (item: { source?: { event_id: string } }) => item.source?.event_id === eventId
      )
    ).toHaveLength(1);
  }
  const human = await agent.runRaw(['why', 'src/delivery.ts']);
  expect(human.stdout).toContain('Interpretation (unapproved_interpretation)');
  expect(human.stdout).toContain(identity.wording);
  expect(human.stdout).toContain(reason);
});
