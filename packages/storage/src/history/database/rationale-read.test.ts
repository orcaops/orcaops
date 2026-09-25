import { afterEach, expect, it } from 'vitest';

import { appendProjectCorrection } from './knowledge-corrections.js';
import { publishProjectContinuingDecisionRevision } from './knowledge-decisions.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { expandProjectRationale } from './rationale-expansion.js';
import { readProjectRationale } from './rationale-read.js';
import { parseRationaleSelector } from './rationale-selector.js';
import {
  acceptedSelection,
  AT,
  establishReplacement,
  findingRevision,
  instructedBy,
  instructionSource,
} from '../../../tests/knowledge-authority-store.js';
import {
  BY_OWNER,
  discardKnowledgeStores,
  knowledgeStore,
  OWNER,
} from '../../../tests/knowledge-store.js';
import {
  closeCapture,
  decision,
  interpret,
  navigationFixture,
  planCapture,
  WORDS,
} from '../../../tests/rationale-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

it('retains lexical discovery through source references and independent candidate paths', async () => {
  const { handle } = await knowledgeStore();
  const direct = await closeCapture(
    handle,
    await planCapture(handle, 'Preserve navigation history', []),
    [WORDS.history],
    ['src/navigation.ts']
  );
  const related = await planCapture(handle, 'Review navigation history', [WORDS.history]);
  const lexicalSource = await interpret(handle, related, 0);
  const target = await decision(handle, lexicalSource.source_origin.source_id, WORDS.history);
  const read = () =>
    readProjectRationale(handle, {
      candidates: [{ artifactId: direct.plan.artifactId, eventId: direct.eventId }],
      boundary: 'now',
      observation: handle.read(() => null).counters.writeSequence,
    }).value;
  const lexical = read().records.find((record) => record.key === `decision:${target.entity_id}`)!;
  expect(lexical.discovery).toEqual([
    { origin: 'lexical_overlap', event_id: related.eventId, via: 'source_reference' },
  ]);
  const directSource = await interpret(handle, direct, 0);
  await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    attributedTo: BY_OWNER,
    secretAllow: [],
    occurrence: {
      source_id: directSource.source_origin.source_id,
      location: direct.fields[0]!.path,
    },
    revision: {
      decision_id: target.entity_id,
      revision_id: uuidv7(),
      previous_revision_id: target.revision_id,
      chosen_approach: WORDS.history,
      rationale: 'Keep the navigator as the only history owner.',
      alternatives: [],
      assumptions: [],
      reconsideration_conditions: [],
      subject: null,
      derivation: null,
      applicability: { all_of: [] },
      source_ids: [directSource.source_origin.source_id],
      passages: [
        {
          source_id: directSource.source_origin.source_id,
          location: direct.fields[0]!.path,
          passage_sha256: directSource.evidence[0]!.passage_sha256,
        },
      ],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
  });
  const strengthened = read().records.find((record) => record.key === lexical.key)!;
  expect(strengthened.discovery).toEqual(
    expect.arrayContaining([
      { origin: 'candidate_event', event_id: direct.eventId, via: 'source_reference' },
      { origin: 'lexical_overlap', event_id: related.eventId, via: 'source_reference' },
    ])
  );
});

it('prioritizes target-linked identities before the shared resolution limit and discloses unexamined records', async () => {
  const { handle } = await knowledgeStore();
  const useful = 'Use WAL in src/storage.ts.';
  const capture = await closeCapture(
    handle,
    await planCapture(handle, 'Maintain application', []),
    [
      ...Array.from({ length: 65 }, (_, i) => `Partition invoice archive ${i} by fiscal year.`),
      useful,
    ],
    ['src/storage.ts']
  );
  let wanted = '';
  for (let i = 0; i < capture.fields.length; i++) {
    const interpretation = await interpret(handle, capture, i);
    const identity = await decision(
      handle,
      interpretation.source_origin.source_id,
      capture.fields[i]!.text,
      capture.fields[i]!.path
    );
    if (i === capture.fields.length - 1) wanted = identity.entity_id;
  }
  const result = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    target: { file: 'src/storage.ts' },
    boundary: 'now',
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  expect(result.context.entries.some((entry) => entry.target.entity_id === wanted)).toBe(true);
  expect(result.context.omissions.some((limit) => limit.kind === 'identity_count')).toBe(true);
});

it('keeps indistinguishable decisions as candidate context with deterministic selection', async () => {
  const { handle } = await knowledgeStore();
  const capture = await closeCapture(
    handle,
    await planCapture(handle, 'Maintain application', []),
    Array.from({ length: 24 }, (_, i) => `Partition archive ${i} by year.`),
    ['src/storage.ts']
  );
  for (let i = 0; i < capture.fields.length; i++) await interpret(handle, capture, i);
  const input = {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    target: { file: 'src/storage.ts' },
    boundary: 'now' as const,
    observation: handle.read(() => null).counters.writeSequence,
  };
  const first = readProjectRationale(handle, input).value;
  expect(first.items.every((item) => item.target_match?.kind === 'candidate_context')).toBe(true);
  expect(readProjectRationale(handle, input).value.items).toEqual(first.items);
  expect(first.diagnostics.limits.length).toBeGreaterThan(0);
});

it('selects target-linked interpretations before unrelated decisions in the same checkpoint', async () => {
  const { handle } = await knowledgeStore();
  const useful = 'Use WAL in src/storage.ts to preserve concurrent reader access.';
  const capture = await closeCapture(
    handle,
    await planCapture(handle, 'Maintain application', []),
    [
      ...Array.from({ length: 24 }, (_, i) => `Partition invoice archive ${i} by fiscal year.`),
      useful,
    ],
    ['src/storage.ts', 'src/billing.ts']
  );
  for (let i = 0; i < capture.fields.length; i++) await interpret(handle, capture, i);
  const result = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    target: { file: 'src/storage.ts' },
    boundary: 'now',
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  const selected = result.items.find(
    (item) => item.form === 'unapproved_interpretation' && item.account.wording === useful
  );
  expect(selected?.target_match).toEqual({ kind: 'explicit_path', terms: ['src/storage.ts'] });
  expect(result.items.filter((item) => item.form === 'unapproved_interpretation')).toHaveLength(16);
});

it('ties account corrections to their source field rather than every identity in the event', async () => {
  const { handle } = await knowledgeStore();
  const capture = await closeCapture(
    handle,
    await planCapture(handle, 'Maintain storage', []),
    ['Use WAL in src/storage.ts.', 'Retain invoices in the billing archive.'],
    ['src/storage.ts', 'src/billing.ts']
  );
  const identities = [];
  for (let i = 0; i < 2; i++) {
    const interpretation = await interpret(handle, capture, i);
    identities.push(
      await decision(
        handle,
        interpretation.source_origin.source_id,
        capture.fields[i]!.text,
        capture.fields[i]!.path
      )
    );
  }
  const result = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    target: { file: 'src/storage.ts' },
    boundary: 'now',
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  for (const [i, identity] of identities.entries()) {
    const item = result.items.find(
      (item) => item.form === 'recorded_capture' && item.account.wording === capture.fields[i]!.text
    );
    expect(item?.knowledge_keys).toEqual([`decision:${identity.entity_id}`]);
  }
});

it('retrieves competing checkpoint decisions before same-artifact interpretation noise', async () => {
  const fixture = await navigationFixture(500);
  const read = () =>
    readProjectRationale(fixture.handle, {
      candidates: [fixture.history, fixture.competing].map((capture) => ({
        artifactId: capture.plan.artifactId,
        eventId: capture.eventId,
      })),
      boundary: 'now',
      observation: fixture.handle.read(() => null).counters.writeSequence,
    }).value;
  const result = read();
  const wording = result.items.map((item) => item.account.wording);
  for (const expected of [WORDS.history, WORDS.tabs, WORDS.band, WORDS.raw, WORDS.removal])
    expect(wording).toContain(expected);
  expect(wording.some((text) => /auxiliary dependency/.test(text))).toBe(false);
  expect(result.items.find((item) => item.account.wording === WORDS.removal)?.relevance).toBe(
    'lexical_overlap'
  );
  expect(
    result.context.entries.some((entry) => entry.target.entity_id === fixture.global.entity_id)
  ).toBe(true);
}, 30_000);

it.each(['raw', 'unknown', 'stated'] as const)(
  'preserves separate explanation fields for %s evidence and exact expansion',
  async (variant) => {
    const { handle } = await knowledgeStore();
    const choice = {
      decision: 'Use WAL for local writes.',
      reason: 'Readers must stay responsive during capture.',
      alternatives_considered: [
        {
          option: 'Serialize every reader behind the writer.',
          rejected_because: 'Long captures would freeze history browsing.',
        },
      ],
    };
    const capture = await closeCapture(
      handle,
      await planCapture(handle, 'Local persistence', []),
      [choice],
      ['src/storage.ts']
    );
    if (variant !== 'raw')
      await interpret(handle, capture, 0, false, variant === 'stated' ? choice.reason : undefined);
    const read = readProjectRationale(handle, {
      candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
      boundary: 'now',
      observation: handle.read(() => null).counters.writeSequence,
    }).value;
    const recorded = read.items.find(
      (item) => item.form === 'recorded_capture' && item.account.kind === 'decision'
    )!;
    expect(recorded.account).toMatchObject({
      wording: choice.decision,
      reason: choice.reason,
      alternatives: choice.alternatives_considered,
    });
    expect(expandProjectRationale(handle, recorded.reference).value).toMatchObject({
      status: 'available',
      content: recorded.account,
    });
    const interpreted = read.items.find((item) => item.form === 'unapproved_interpretation');
    if (variant !== 'raw') {
      expect(interpreted?.source_account).toMatchObject(recorded.account);
      expect(interpreted?.account.reason).toBe(variant === 'stated' ? choice.reason : null);
      expect(expandProjectRationale(handle, interpreted!.reference).value.status).toBe('available');
    }
  }
);

it('keeps historical prose distinct while account inspection reads current state', async () => {
  const { handle } = await knowledgeStore();
  const first = await planCapture(handle, 'Native navigation', [WORDS.band]);
  const boundary = handle.read(() => null).counters.writeSequence;
  await planCapture(handle, 'Navigation refinement', [WORDS.removal]);
  const read = readProjectRationale(handle, {
    candidates: [{ artifactId: first.plan.artifactId, eventId: first.eventId }],
    boundary,
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  expect(read.items.find((item) => item.account.wording === WORDS.removal)?.temporal).toBe(
    'later_annotation'
  );
  const item = read.items.find((item) => item.account.wording === WORDS.band)!;
  expect(expandProjectRationale(handle, item.reference).value.status).toBe('available');
  await planCapture(handle, 'Unrelated work', ['Change a button color.']);
  expect(expandProjectRationale(handle, item.reference).value).toMatchObject({
    status: 'available',
    mode: 'current',
    content: item.account,
    observation_ceiling: handle.read(() => null).counters.writeSequence,
  });
});

it('withholds restricted event content from direct and indexed reads', async () => {
  const { handle } = await knowledgeStore();
  const capture = await planCapture(handle, 'Native navigation', [WORDS.band]);
  await interpret(handle, capture, 0, true);
  const read = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    boundary: 'now',
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  expect(JSON.stringify(read.items)).not.toContain(WORDS.band);
  expect(read.diagnostics.unavailable_events).toBe(1);
});

it('carries correction wording without a separate interpretation and expands the exact action', async () => {
  const { handle } = await knowledgeStore();
  const capture = await planCapture(handle, 'Device verification', ['The device test passed.']);
  const interpretation = await interpret(handle, capture, 0);
  const finding = await findingRevision(
    { handle, sourceId: interpretation.source_origin.source_id },
    'The device test passed.'
  );
  const source = await instructionSource(handle, WORDS.correction);
  const boundary = handle.read(() => null).counters.writeSequence;
  const actionId = uuidv7();
  await appendProjectCorrection(handle, {
    operationId: uuidv7(),
    attributedTo: BY_OWNER,
    secretAllow: [],
    action: {
      action_id: actionId,
      targets: [finding],
      scope: { kind: 'project', project_id: handle.authority.projectId },
      source_id: source,
      authorization: null,
      expected_state: { kind: 'initial' },
      kind: 'factual_correction',
      corrected_account: WORDS.correction,
    },
  });
  const read = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    boundary,
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  const record = read.records.find((entry) => entry.key === `claim:${finding.entity_id}`)!;
  expect(record.corrections).toContainEqual(
    expect.objectContaining({
      action_id: actionId,
      kind: 'factual_correction',
      wording: WORDS.correction,
      status: 'later_annotation',
      source_id: source,
    })
  );
  expect(expandProjectRationale(handle, record.corrections[0]!.reference!).value).toMatchObject({
    status: 'available',
    content: { action_id: actionId, corrected_account: WORDS.correction },
  });
  expect(expandProjectRationale(handle, record.reference).value.status).toBe('available');
  expect(record.relationships).toEqual([]);
});

it('preserves an unchanged sibling and artifact-scoped adoption when one decision is replaced', async () => {
  const fixture = await navigationFixture();
  const { handle, history, records } = fixture;
  const scope = { kind: 'artifact' as const, artifact_id: history.plan.artifactId };
  const old = await decision(
    handle,
    records[2]!.source_origin.source_id,
    WORDS.band,
    history.fields[2]!.path
  );
  const sibling = await decision(
    handle,
    records[1]!.source_origin.source_id,
    WORDS.tabs,
    history.fields[1]!.path
  );
  const source = await instructionSource(handle, 'Adopt both decisions for this artifact.');
  for (const target of [old, sibling])
    await publishProjectSelection(handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(target, scope, instructedBy(source, scope)),
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    });
  const replacementSource = await instructionSource(handle, WORDS.removal);
  const replacement = await decision(handle, replacementSource, WORDS.removal);
  await establishReplacement(handle, {
    from: replacement,
    to: old,
    sourceId: replacementSource,
    scope,
  });
  const read = readProjectRationale(handle, {
    candidates: [{ artifactId: history.plan.artifactId, eventId: history.eventId }],
    authorityArtifactId: history.plan.artifactId,
    boundary: 'now',
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  const state = (id: string) =>
    read.context.entries.find((entry) => entry.target.entity_id === id)!.resolved;
  expect(state(old.entity_id).revisions[0]?.standing).toBe('stopped');
  expect(state(sibling.entity_id).revisions[0]).toMatchObject({
    standing: 'stands',
    designation: 'adopted',
  });
  expect(read.diagnostics.authority_scope).toEqual(scope);
  for (const record of read.records)
    expect(expandProjectRationale(handle, record.reference).value.status).toBe('available');
});

it('keeps lexical topic collisions provisional and does not invent vocabulary-disjoint links', async () => {
  const { handle } = await knowledgeStore();
  const capture = await planCapture(handle, 'Database durability', [
    'Enable WAL checkpoints for crash recovery.',
  ]);
  const matching = 'Keep WAL checkpoints for crash recovery; revise the checkpoint interval.';
  const collision =
    'Rename WAL checkpoints for crash recovery test labels; leave behavior unchanged.';
  const disjoint = 'Preserve the journal flush mechanism after unexpected termination.';
  for (const text of [matching, collision, disjoint])
    await planCapture(handle, 'Follow-up', [text]);
  await planCapture(handle, 'Different topics', [
    'Enable WAL for writers.',
    'Schedule checkpoints weekly.',
    'Document crash recovery.',
  ]);
  const read = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    boundary: 'now',
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  const matches = read.items.filter((item) => item.relevance === 'lexical_overlap');
  expect(matches.map((item) => item.account.wording)).toEqual(
    expect.arrayContaining([matching, collision])
  );
  expect(matches.map((item) => item.account.wording)).not.toContain(disjoint);
  expect(
    matches.every((item) => item.account.wording === matching || item.account.wording === collision)
  ).toBe(true);
  expect(read.records).toEqual([]);
});

it('does not find an account in a different selected project', async () => {
  const { handle } = await knowledgeStore();
  const capture = await planCapture(handle, 'Durable storage', ['Keep local writes durable.']);
  const read = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    boundary: 'now',
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  const reference = read.items[0]!.reference;
  const foreign = await knowledgeStore();
  expect(expandProjectRationale(foreign.handle, reference).value.status).toBe('unavailable');
  expect(parseRationaleSelector(reference)).toMatchObject({ kind: 'capture', id: capture.eventId });
});
