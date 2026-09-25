import { expect, it } from 'vitest';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { adoptedRequirement } from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

const choices = [
  {
    decision: 'Keep navigator-owned history.',
    reason: 'Native Back must restore the original list position.',
    alternatives_considered: [
      {
        option: 'Recreate the destination on return.',
        rejected_because: 'Recreation loses scroll position and tab history.',
      },
    ],
  },
  {
    decision: 'Keep independent tab stacks.',
    reason: 'Each tab must preserve its navigation history.',
    alternatives_considered: [
      {
        option: 'Share one navigation stack.',
        rejected_because: 'A shared stack confuses Back across tabs.',
      },
    ],
  },
];

async function navigation(noise = 0) {
  const f = await fixture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(
    f,
    'src/navigation.ts',
    'export const navigatorOwnsHistory = true;\n'
  );
  for (const choice of choices) {
    const id = await f.capture();
    await closeFingerprintedCheckpoint(f, id, {
      files: ['src/navigation.ts'],
      openRef,
      closeRef,
      decisions:
        choice === choices[0]
          ? [
              choice,
              ...Array.from({ length: noise }, (_, index) => ({
                decision: `Retain native history account ${index}.`,
                reason: 'Preserve the documented navigation behavior. '.repeat(20),
              })),
            ]
          : [choice],
    });
  }
  await f.capture(undefined, {
    decisions: [
      {
        decision: 'Remove the cross-area return band.',
        reason: 'Dock switching supplies the area control while preserving tab navigation history.',
        revision_n: 0,
      },
    ],
  });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  return { f, agent };
}

it('answers through the ordinary why command and expands complete explanations without changing history', async () => {
  const { f, agent } = await navigation();
  await adoptedRequirement(f.writer, {
    projectId: f.authority.projectId,
    statement: 'Local history remains readable offline.',
  });
  const before = await inventory(f.temporary);
  const response = await agent.runRaw(['why', 'src/navigation.ts:1', '--json', '--limit', '1']);
  expect(response.exitCode, response.stderr || response.stdout).toBe(0);
  const answer = JSON.parse(response.stdout);
  expect(answer).toMatchObject({ schema_version: 8, conclusion: 'ambiguous', best: null });
  expect(answer.results).toHaveLength(1);
  expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(16_384);
  for (const choice of choices) {
    const item = answer.knowledge.rationale.find(
      (row: { account: { wording: string } }) => row.account.wording === choice.decision
    );
    expect(item?.account).toMatchObject({
      reason: choice.reason,
      alternatives: choice.alternatives_considered,
    });
    const expanded = await agent.runRaw(['knowledge', 'show', item.reference, '--json']);
    expect(expanded.exitCode, expanded.stderr || expanded.stdout).toBe(0);
    expect(JSON.parse(expanded.stdout)).toMatchObject({
      status: 'available',
      content: item.account,
    });
  }
  expect(
    answer.knowledge.rationale.some(
      (item: { relevance: { basis: string }; account: { wording: string } }) =>
        item.relevance.basis === 'lexical_overlap' &&
        item.account.wording === 'Remove the cross-area return band.'
    )
  ).toBe(true);
  expect(answer.knowledge.evolution).toContainEqual(
    expect.objectContaining({
      kind: 'change_passage',
      account_id: answer.knowledge.rationale.find(
        (item: { account: { wording: string } }) =>
          item.account.wording === 'Remove the cross-area return band.'
      ).id,
      standing: 'recorded_wording_only',
      earlier: null,
      relationship: null,
    })
  );
  expect(
    answer.knowledge.evolution.some((change: { kind: string }) => change.kind === 'relationship')
  ).toBe(false);
  const human = await agent.runRaw(['why', 'src/navigation.ts:1', '--limit', '1']);
  expect(human.exitCode, human.stderr).toBe(0);
  for (const choice of choices) expect(human.stdout).toContain(choice.reason);
  expect(human.stdout).toContain('ambiguous');
  expect(await inventory(f.temporary)).toEqual(before);
});

it('retains a smaller candidate beside a large checkpoint within each output allowance', async () => {
  const { agent } = await navigation(40);
  for (const [flags, ceiling] of [
    [[], 16_384],
    [['--view', 'rationale'], 32_768],
    [['--details', '--audit'], 65_536],
  ] as const) {
    const response = await agent.runRaw(['why', 'src/navigation.ts:1', '--json', ...flags]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    const answer = JSON.parse(response.stdout);
    expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(ceiling);
    expect(answer.conclusion).toBe('ambiguous');
    expect(
      answer.knowledge.rationale.some(
        (item: { account: { wording: string } }) => item.account.wording === choices[1]!.decision
      )
    ).toBe(true);
    if (ceiling === 16_384) expect(answer.output.omitted_rationale).toBeGreaterThan(0);
    expect(
      answer.knowledge.rationale.some(
        (item: { account: { wording: string } }) =>
          item.account.wording === 'Remove the cross-area return band.'
      ),
      JSON.stringify({ retrieval: answer.diagnostics.retrieval, output: answer.output.selection })
    ).toBe(true);
  }
});

it.each(['oversized', 'numerous'] as const)(
  'withholds rationale when %s applicable obligations do not fit',
  async (kind) => {
    const { f, agent } = await navigation();
    const count = kind === 'numerous' ? 70 : 1;
    for (let index = 0; index < count; index++)
      await adoptedRequirement(f.writer, {
        projectId: f.authority.projectId,
        statement:
          kind === 'numerous'
            ? `Preserve offline durability requirement ${index}.`
            : 'Preserve offline durability. '.repeat(2800),
      });
    const response = await agent.runRaw(['why', 'src/navigation.ts:1', '--json', '--limit', '1']);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    const answer = JSON.parse(response.stdout);
    expect(answer.knowledge.rationale).toEqual([]);
    expect(answer.results).toHaveLength(1);
    expect(answer.output.omitted_provenance).toBe(0);
    expect(answer.output.rationale_withheld).toContain('Applicable obligations');
    expect(answer.output.omitted_knowledge).toBeGreaterThan(0);
    expect(answer.output.inspect.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(16_384);
    expect(answer.output.inspect[0]).toMatchObject({
      kind: 'obligation',
      reason: 'output_budget',
      qualification_recovery: 'use_context',
    });
    const expanded = await agent.runRaw([
      'knowledge',
      'show',
      answer.output.inspect[0].reference,
      '--json',
    ]);
    expect(JSON.parse(expanded.stdout).status).toBe(
      kind === 'oversized' ? 'omitted_oversized' : 'available'
    );
  },
  60_000
);

it('rejects incompatible views and invalid references before reading history', async () => {
  const { agent } = await navigation();
  for (const args of [
    ['why', 'src/navigation.ts', '--view', 'rationale', '--details', '--json'],
    ['knowledge', 'show', 'not-a-reference', '--json'],
  ]) {
    const response = await agent.runRaw(args);
    expect(response.exitCode).not.toBe(0);
    expect(JSON.parse(response.stdout).error.code).toBe('INVALID_INPUT');
  }
});

it('rejects large lexical inventories and bounds optional context without hiding later changes', async () => {
  const { f, agent } = await navigation();
  await f.capture(undefined, {
    decisions: [
      {
        decision: 'Retain a per-file ledger including src/navigation.ts.',
        reason:
          'Archive invoice and dependency hashes. '.repeat(600) +
          'Keep independent tab stacks and navigator-owned history.',
        revision_n: 0,
      },
    ],
  });
  for (let i = 0; i < 12; i++)
    await f.capture(undefined, {
      decisions: [
        {
          decision: `Document independent tab stacks and navigator-owned history variant ${i}.`,
          reason: 'Each tab must preserve its navigation history.',
          revision_n: 0,
        },
      ],
    });
  const response = await agent.runRaw([
    'why',
    'src/navigation.ts',
    '--json',
    '--view',
    'rationale',
  ]);
  expect(response.exitCode, response.stderr || response.stdout).toBe(0);
  const answer = JSON.parse(response.stdout);
  const wording = answer.knowledge.rationale.map(
    (item: { account: { wording: string } }) => item.account.wording
  );
  expect(wording.some((text: string) => text.includes('per-file ledger'))).toBe(false);
  expect(wording).toContain('Remove the cross-area return band.');
  expect(answer.knowledge.rationale[0].relevance.basis).toBe('candidate_event');
  expect(answer.output.selection.omitted_supplemental).toBeGreaterThan(0);
  expect(answer.diagnostics.retrieval.discovery).not.toHaveProperty('rejected_accounts');
  expect(Buffer.byteLength(response.stdout)).toBeLessThan(16_384);
});

it('keeps disconnected delivery changes without promoting archive cleanup through shared test vocabulary', async () => {
  const f = await fixture();
  const artifact = await f.capture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, 'src/delivery.ts', 'export const lease = true;\n');
  await closeFingerprintedCheckpoint(f, artifact, {
    files: ['src/delivery.ts'],
    openRef,
    closeRef,
    decisions: [
      {
        decision: 'Keep a durable delivery lease.',
        reason: 'Behavioral assertions and failure controls protect notification delivery.',
      },
    ],
  });
  for (let i = 0; i < 36; i++)
    await f.capture(undefined, {
      decisions: [
        {
          decision: `Retire obsolete archive paths ${i}.`,
          reason: 'Behavioral assertions and failure controls retain value.',
          revision_n: 0,
        },
      ],
    });
  const change = 'Replace the delivery lease with a transactional outbox.';
  await f.capture(undefined, {
    decisions: [
      {
        decision: change,
        reason: 'The outbox prevents duplicate notification delivery after a worker restart.',
        revision_n: 0,
      },
    ],
  });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  for (const flags of [[], ['--view', 'rationale']]) {
    const response = await agent.runRaw(['why', 'src/delivery.ts', '--json', ...flags]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    const answer = JSON.parse(response.stdout);
    const wordings = answer.knowledge.rationale.map(
      (item: { account?: { wording: string } }) => item.account?.wording
    );
    expect(wordings).toContain(change);
    expect(wordings.some((text: string | undefined) => text?.includes('obsolete archive'))).toBe(
      false
    );
    expect(
      answer.knowledge.evolution.some((item: { account_id: string }) =>
        answer.knowledge.rationale.some(
          (row: { id: string; account?: { wording: string } }) =>
            row.id === item.account_id && row.account?.wording === change
        )
      )
    ).toBe(true);
  }
});

it('omits oversized explanations whole and expands their complete reasons and rejected alternatives', async () => {
  const { f, agent } = await navigation();
  const choice = {
    decision: 'Use native history in src/navigation.ts only after the stated safety checks.',
    reason:
      'Review navigator state and completion ordering. '.repeat(260) +
      'Do not enable reuse before modal dismissal completes.',
    alternatives_considered: [
      { option: 'Reuse immediately.', rejected_because: 'The hidden modal can intercept taps.' },
    ],
  };
  const artifact = await f.capture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, 'src/navigation.ts', 'export const safeReuse = true;\n');
  await closeFingerprintedCheckpoint(f, artifact, {
    files: ['src/navigation.ts'],
    openRef,
    closeRef,
    decisions: [choice],
  });
  for (const flags of [[], ['--view', 'rationale'], ['--details', '--audit']]) {
    const response = await agent.runRaw(['why', 'src/navigation.ts', '--json', ...flags]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    const answer = JSON.parse(response.stdout);
    expect(
      answer.knowledge.rationale.some(
        (item: { account?: { wording: string } }) => item.account?.wording === choice.decision
      )
    ).toBe(false);
    expect(answer.output.selection.omitted_oversized).toBeGreaterThan(0);
    const placeholder = answer.knowledge.rationale.find(
      (item: { status?: string }) => item.status === 'omitted_oversized'
    );
    expect(placeholder).toMatchObject({
      kind: 'decision',
      relevance: { basis: 'candidate_event' },
      source: { artifact_id: artifact },
      authority: 'recorded_account',
    });
    expect(placeholder.reason).toContain('not judged irrelevant');
    expect(placeholder).not.toHaveProperty('account');
    expect(placeholder).not.toHaveProperty('context');
    expect(answer.knowledge.rationale[0]).toBe(placeholder);
    expect(
      answer.output.inspect.map((item: { reference: string }) => item.reference)
    ).not.toContain(placeholder.reference);
    const expanded = [];
    for (const reference of [placeholder.reference])
      expanded.push(
        JSON.parse((await agent.runRaw(['knowledge', 'show', reference, '--json'])).stdout)
      );
    expect(expanded).toContainEqual(
      expect.objectContaining({
        status: 'available',
        content: expect.objectContaining({
          wording: choice.decision,
          reason: choice.reason,
          alternatives: choice.alternatives_considered,
        }),
      })
    );
  }
  const human = await agent.runRaw(['why', 'src/navigation.ts']);
  expect(human.stdout).toContain('decision omitted_oversized (candidate_event');
  expect(human.stdout).toContain('Inspect account: orcaops knowledge show capture:');
});

it('bounds placeholders without treating omitted accounts as delivered explanations', async () => {
  const f = await fixture();
  const artifact = await f.capture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, 'src/cache.ts', 'export const durable = true;\n');
  await closeFingerprintedCheckpoint(f, artifact, {
    files: ['src/cache.ts'],
    openRef,
    closeRef,
    decisions: Array.from({ length: 9 }, (_, index) => ({
      decision: `Replace cache policy ${index} in src/cache.ts.`,
      reason: 'The full qualification must be inspected before applying this cache policy. '.repeat(
        150
      ),
    })),
  });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  for (const flags of [[], ['--view', 'rationale'], ['--details', '--audit']]) {
    const response = await agent.runRaw(['why', 'src/cache.ts', '--json', ...flags]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    const answer = JSON.parse(response.stdout);
    const placeholders = answer.knowledge.rationale.filter(
      (item: { status?: string }) => item.status === 'omitted_oversized'
    );
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders.length).toBeLessThanOrEqual(4);
    expect(
      placeholders.every(
        (item: { change_passage: string }) => item.change_passage === 'recorded_wording_only'
      )
    ).toBe(true);
    expect(answer.output.selection).toMatchObject({
      omitted_oversized: 9,
      omitted_placeholders: 9 - placeholders.length,
      omitted_changes: 9,
    });
    expect(answer.output.omitted_rationale).toBeGreaterThanOrEqual(9);
    expect(answer.knowledge.evolution).toEqual([]);
    expect(answer.results.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(
      flags.includes('--details') ? 65_536 : flags.includes('rationale') ? 32_768 : 16_384
    );
  }
});
