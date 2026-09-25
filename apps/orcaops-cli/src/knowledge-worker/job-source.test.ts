import { expect, it } from 'vitest';

import type { ArtifactThread, EventType, EventWithPayload } from '@orcaops/storage';

import { authoredFieldInventory, prepareSourceField, sourcePlanAnchor } from './job-source.js';

const event = (eventId: string, type: EventType, payload: Record<string, unknown> = {}) =>
  ({ record: { event_id: eventId, type }, payload }) as unknown as EventWithPayload;

type SourceThread = Pick<ArtifactThread, 'events' | 'checkpoints'>;

const thread = (
  events: EventWithPayload[],
  checkpoints: ArtifactThread['checkpoints'] = []
): SourceThread => ({ events, checkpoints });

const terminalCheckpoint = (
  status: 'closed' | 'abandoned',
  change: {
    planEventId?: string | null;
    openedEventId?: string;
    terminalEventId?: string;
  } = {}
) =>
  ({
    status,
    open_plan_revision_event_id:
      change.planEventId === undefined ? 'plan-original' : change.planEventId,
    source_event_ids:
      status === 'closed'
        ? {
            opened: change.openedEventId ?? 'checkpoint-open',
            closed: change.terminalEventId ?? 'checkpoint-terminal',
          }
        : {
            opened: change.openedEventId ?? 'checkpoint-open',
            abandoned: change.terminalEventId ?? 'checkpoint-terminal',
          },
  }) as unknown as ArtifactThread['checkpoints'][number];

it('anchors plan sources to themselves after later revisions', () => {
  const original = event('plan-original', 'plan_captured');
  const revised = event('plan-later', 'plan_revised');

  expect(sourcePlanAnchor(thread([original, revised]), original)).toEqual({
    planEventId: 'plan-original',
    planAnchorLimit: null,
  });
});

it.each(['closed', 'abandoned'] as const)(
  'uses a %s checkpoint terminal event retained open-plan pin after an intervening revision',
  (status) => {
    const plan = event('plan-original', 'plan_captured');
    const opened = event('checkpoint-open', 'checkpoint_opened');
    const revised = event('plan-later', 'plan_revised');
    const terminal = event(
      'checkpoint-terminal',
      status === 'closed' ? 'checkpoint_closed' : 'checkpoint_abandoned'
    );

    expect(
      sourcePlanAnchor(
        thread([plan, opened, revised, terminal], [terminalCheckpoint(status)]),
        terminal
      )
    ).toEqual({
      planEventId: 'plan-original',
      planAnchorLimit: null,
    });
  }
);

it('anchors a summary to the latest plan preceding its publication', () => {
  const original = event('plan-original', 'plan_captured');
  const summary = event('summary', 'summary_captured');
  const revised = event('plan-later', 'plan_revised');

  expect(sourcePlanAnchor(thread([original, summary, revised]), summary)).toEqual({
    planEventId: 'plan-original',
    planAnchorLimit: null,
  });
});

it.each([
  ['missing projection', [], {}],
  [
    'wrong terminal identity',
    [terminalCheckpoint('closed', { terminalEventId: 'another-terminal' })],
    {},
  ],
  ['missing open event', [terminalCheckpoint('closed', { openedEventId: 'missing-open' })], {}],
  ['wrong open event type', [terminalCheckpoint('closed')], { openedType: 'checkpoint_closed' }],
  [
    'plan pinned after open',
    [terminalCheckpoint('closed', { planEventId: 'plan-later' })],
    { laterPlan: true },
  ],
  [
    'wrong pinned event type',
    [terminalCheckpoint('closed', { planEventId: 'not-a-plan' })],
    { wrongPlan: true },
  ],
] as const)(
  'states the checkpoint task context is unknown for a %s',
  (_name, checkpoints, change) => {
    const flags = change as {
      openedType?: 'checkpoint_closed';
      laterPlan?: true;
      wrongPlan?: true;
    };
    const original = event('plan-original', 'plan_captured');
    const opened = event(
      'checkpoint-open',
      flags.openedType === 'checkpoint_closed' ? 'checkpoint_closed' : 'checkpoint_opened'
    );
    const later = event('plan-later', 'plan_revised');
    const wrongPlan = event('not-a-plan', 'summary_captured');
    const terminal = event('checkpoint-terminal', 'checkpoint_closed');
    const events = [original, opened];
    if (flags.laterPlan) events.push(later);
    if (flags.wrongPlan) events.unshift(wrongPlan);
    events.push(terminal);

    expect(sourcePlanAnchor(thread(events, [...checkpoints]), terminal)).toMatchObject({
      planEventId: null,
      planAnchorLimit: expect.stringContaining('retains no prior open plan revision'),
    });
  }
);

it('states when an older checkpoint projection retained no plan pin', () => {
  const opened = event('checkpoint-open', 'checkpoint_opened');
  const terminal = event('checkpoint-terminal', 'checkpoint_abandoned');

  expect(
    sourcePlanAnchor(
      thread([opened, terminal], [terminalCheckpoint('abandoned', { planEventId: null })]),
      terminal
    )
  ).toMatchObject({
    planEventId: null,
    planAnchorLimit: expect.stringContaining('retains no prior open plan revision'),
  });
});

it('does not anchor a source absent from the retained event sequence', () => {
  const missing = event('missing-summary', 'summary_captured');

  expect(sourcePlanAnchor(thread([]), missing)).toEqual({
    planEventId: null,
    planAnchorLimit: 'The retained source event is absent from its artifact event sequence.',
  });
});

it('inventories every eligible plan field with its authored role', () => {
  const inventory = authoredFieldInventory(
    event('plan-original', 'plan_captured', {
      task: 'Ship the durable queue.',
      label: 'Durable queue',
      plan_steps: [
        {
          label: 'Persist writes',
          text: 'Flush every accepted write before acknowledging it.',
          acceptance_criteria: [{ text: 'A restart observes the accepted write.' }],
        },
      ],
      decisions: [
        {
          decision: 'Use SQLite.',
          reason: 'The queue must work offline.',
          alternatives_considered: [
            { option: 'Use memory only.', rejected_because: 'A restart would lose work.' },
          ],
          evidence: { quote: 'Generated evaluator text is not source material.' },
        },
      ],
      non_goals: [{ text: 'Do not add replication.', rationale: 'One machine is in scope.' }],
      rationale: 'The revision makes durability explicit.',
    })
  );

  expect(
    inventory.fields.map(({ fieldPath, role, purpose }) => ({ fieldPath, role, purpose }))
  ).toEqual([
    { fieldPath: 'task', role: 'task', purpose: 'primary' },
    { fieldPath: 'label', role: 'task', purpose: 'context' },
    { fieldPath: 'plan_steps.0.label', role: 'step', purpose: 'context' },
    { fieldPath: 'plan_steps.0.text', role: 'step', purpose: 'primary' },
    {
      fieldPath: 'plan_steps.0.acceptance_criteria.0.text',
      role: 'criterion',
      purpose: 'primary',
    },
    { fieldPath: 'non_goals.0.text', role: 'non_goal', purpose: 'primary' },
    { fieldPath: 'non_goals.0.rationale', role: 'non_goal_reason', purpose: 'primary' },
    { fieldPath: 'decisions.0.decision', role: 'decision', purpose: 'primary' },
    { fieldPath: 'decisions.0.reason', role: 'reason', purpose: 'primary' },
    {
      fieldPath: 'decisions.0.alternatives_considered.0.option',
      role: 'rejected_alternative',
      purpose: 'primary',
    },
    {
      fieldPath: 'decisions.0.alternatives_considered.0.rejected_because',
      role: 'rejection_reason',
      purpose: 'primary',
    },
    { fieldPath: 'rationale', role: 'reason', purpose: 'context' },
  ]);
  expect(inventory.fields.map((field) => field.fieldPath)).not.toContain(
    'decisions.0.evidence.quote'
  );
});

it('keeps exact UTF-8 preparation mappings for removed controls and redactions', () => {
  const secret = `sk-proj-${'a'.repeat(24)}`;
  const original = `café\u0000 ${secret} done`;
  const prepared = prepareSourceField(original);

  expect(prepared.preparedText).toBe('café [REDACTED_SECRET] done');
  expect(prepared.mapping.map((run) => run.kind)).toEqual([
    'copied',
    'removed_control',
    'copied',
    'redacted',
    'copied',
  ]);
  expect(prepared.mapping[0]).toMatchObject({
    original: { start: 0, end: 5 },
    prepared: { start: 0, end: 5 },
  });
  expect(prepared.mapping[1]).toMatchObject({
    original: { start: 5, end: 6 },
    prepared: { start: 5, end: 5 },
  });
});

it('records an explicit omission for an empty eligible field', () => {
  const inventory = authoredFieldInventory(
    event('summary', 'summary_captured', {
      outcome: 'Shipped.',
      tests_written: [''],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
    })
  );

  expect(inventory.fields.map((field) => field.fieldPath)).toEqual(['outcome']);
  expect(inventory.omissions).toEqual([
    { fieldPath: 'tests_written.0', reason: 'The authored field is empty.' },
  ]);
});
