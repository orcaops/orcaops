import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

async function candidates(oversized = false, decisionCount = 1, uncertaintyCount = 0) {
  const f = await fixture();
  const file = 'src/delivery.ts';
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, file, 'export const durable = true;\n');
  for (let index = 0; index < 2; index++) {
    const id = await f.capture(undefined, {
      decisions: [
        {
          decision: 'Use the original durable design.',
          reason: 'Work survives process exit.',
          revision_n: 0,
        },
      ],
    });
    await closeFingerprintedCheckpoint(f, id, {
      files: [file],
      openRef,
      closeRef,
      decisions: Array.from({ length: decisionCount }, (_, position) => ({
        decision: position ? `Retain delivery partition ${position}.` : 'Retain delivery leases.',
        reason:
          oversized && position === 0
            ? 'Retain durable acknowledgements. '.repeat(1000) + 'Never reuse expired leases.'
            : 'Worker restarts must preserve acknowledged work.',
      })),
      uncertainty: Array.from(
        { length: uncertaintyCount },
        (_, position) => `Delivery uncertainty ${position + 1}.`
      ),
    });
    await f.mutate(id, { rationale: 'Later context' }, async (semantics) => {
      const plan = (await semantics.readPlan(id))!;
      await semantics.revisePlan(
        {
          idempotency_key: uuidv7(),
          artifact_id: id,
          label: 'Later design',
          plan_steps: plan.plan_steps,
          touched_scope: plan.touched_scope,
          non_goals: plan.non_goals,
          decisions: [{ decision: 'Use a later planner.', reason: 'A later change.' }],
          rationale: 'After the checkpoint',
          prior_plan_event_id: null,
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
        },
        { idempotencyKey: uuidv7() }
      );
    });
  }
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const discover = async (flags: string[] = []) => {
    const response = await agent.runRaw(['why', file, '--json', '--limit', '1', ...flags]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    return JSON.parse(response.stdout);
  };
  const second = await discover(['--offset', '1']);
  const flags = [
    '--details',
    '--candidate',
    second.results[0].id,
    '--anchor',
    second.inspection.anchor,
    '--json',
  ];
  return { f, file, agent, discover, second, flags };
}

it('inspects an off-page historical candidate without repeating rationale or later plans', async () => {
  const { f, file, agent, discover, second, flags } = await candidates();
  const before = await inventory(f.root);
  const first = await discover();
  expect(first.inspection.anchor).toBe(second.inspection.anchor);
  expect(first.results[0].id).not.toBe(second.results[0].id);
  const response = await agent.runRaw(['why', file, ...flags]);
  expect(response.exitCode, response.stderr || response.stdout).toBe(0);
  const result = JSON.parse(response.stdout);
  expect(result).toMatchObject({
    representation: 'candidate',
    status: 'available',
    conclusion: 'ambiguous',
    selection: { candidate_id: second.results[0].id },
    candidate: {
      artifact_id: second.results[0].artifact_id,
      source_event_id: second.results[0].source_event_id,
    },
  });
  expect(result.candidate.plan_support.plan.decisions[0].decision).toBe(
    'Use the original durable design.'
  );
  expect(result).not.toHaveProperty('knowledge');
  expect(result).not.toHaveProperty('results');
  expect(response.stdout).not.toContain('Use a later planner.');
  expect(result.output.bytes).toBe(Buffer.byteLength(response.stdout));
  expect(result.output.bytes).toBeLessThanOrEqual(16_384);
  expect(await inventory(f.root)).toEqual(before);
});

it('requires deliberate broad audit and rejects mismatched or stale exact selections', async () => {
  const { f, file, agent, flags } = await candidates();
  for (const args of [
    ['--details'],
    [...flags, '--limit', '5'],
    ['--audit'],
    ['--details', '--output', '/tmp/not-written.json'],
    ['--details', '--candidate', uuidv7()],
    ['--section', 'checkpoint'],
    [...flags, '--section', 'unknown'],
    [...flags, '--section', 'plan', '--decision', '1'],
    [...flags, '--section', 'files', '--section-limit', '21'],
    [...flags, '--section', 'files', '--section-offset', '-1'],
  ]) {
    const response = await agent.runRaw(['why', file, ...args, '--json']);
    expect(response.exitCode).toBe(1);
    expect(JSON.parse(response.stdout).error.code).toBe('INVALID_INPUT');
    expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(16_384);
  }
  const absentFlags = [...flags];
  absentFlags[absentFlags.indexOf('--candidate') + 1] = `${uuidv7()}:${uuidv7()}`;
  const absent = await agent.runRaw(['why', file, ...absentFlags]);
  expect(JSON.parse(absent.stdout).error.code).toBe('INVALID_INPUT');
  const other = await fixture();
  await commitFile(other, file, 'export const durable = true;\n');
  const foreign = makeAgent({
    cwd: other.main,
    env: { ORCAOPS_DATA_DIR: other.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const wrongStore = await foreign.runRaw(['why', file, ...flags]);
  expect(JSON.parse(wrongStore.stdout).error.code).toBe('STALE_CONTEXT');
  const audit = await agent.runRaw(['why', file, '--details', '--audit', '--limit', '1', '--json']);
  expect(audit.exitCode, audit.stderr || audit.stdout).toBe(0);
  expect(JSON.parse(audit.stdout).audit.candidates).toHaveLength(1);
  for (const args of [
    [file + ':1', ...flags],
    [file, ...flags, '--scope', 'worktree'],
    [file, ...flags, '--origin', 'captured'],
    [file + ':1', ...flags, '--section', 'plan-decisions', '--decision', '1'],
  ]) {
    const response = await agent.runRaw(['why', ...args]);
    expect(JSON.parse(response.stdout).error.code).toBe('STALE_CONTEXT');
  }
  await writeFile(path.join(f.main, file), 'export const durable = false;\n');
  const dirty = await agent.runRaw(['why', file, ...flags]);
  expect(JSON.parse(dirty.stdout).error.code).toBe('STALE_CONTEXT');
  await writeFile(path.join(f.main, file), 'export const durable = true;\n');
  await f.capture();
  const later = await agent.runRaw(['why', file, ...flags]);
  expect(JSON.parse(later.stdout).error.code).toBe('STALE_CONTEXT');
});

it('pages an oversized candidate and inspects original decisions without exporting its other bodies', async () => {
  const { f, file, agent, flags } = await candidates(true, 12);
  const before = await inventory(f.root);
  const index = JSON.parse(
    (await agent.runRaw(['why', file, ...flags, '--section', 'index'])).stdout
  );
  expect(index.sections).toContainEqual(
    expect.objectContaining({ section: 'checkpoint-decisions', entries: 12, paged: true })
  );
  expect(index.output.bytes).toBeLessThanOrEqual(4096);
  const decisions = index.sections.find(
    (section: { section: string }) => section.section === 'checkpoint-decisions'
  );
  expect(decisions.previews[0]).toMatchObject({
    position: 1,
    wording: 'Retain delivery leases.',
    preview_only: true,
  });
  expect(decisions.next_offset).toBe(3);
  const nextIndex = JSON.parse(
    (await agent.runRaw(['why', file, ...flags, '--section', 'index', '--section-offset', '10']))
      .stdout
  );
  expect(
    nextIndex.sections
      .find((section: { section: string }) => section.section === 'checkpoint-decisions')
      .previews.map((entry: { position: number }) => entry.position)
  ).toEqual([11, 12]);
  const first = JSON.parse(
    (
      await agent.runRaw([
        'why',
        file,
        ...flags,
        '--section',
        'checkpoint-decisions',
        '--section-limit',
        '2',
      ])
    ).stdout
  );
  expect(first.content[0]).toMatchObject({ position: 1, status: 'omitted_oversized' });
  expect(first.content[0]).toMatchObject({
    wording: { text: 'Retain delivery leases.' },
    preview_only: true,
  });
  expect(first.pagination.next_offset).toBeGreaterThan(0);
  const later = await agent.runRaw([
    'why',
    file,
    ...flags,
    '--section',
    'checkpoint-decisions',
    '--section-offset',
    '10',
    '--section-limit',
    '2',
  ]);
  expect(later.exitCode, later.stdout).toBe(0);
  const page = JSON.parse(later.stdout);
  expect(page.content.map((item: { position: number }) => item.position)).toEqual([11, 12]);
  expect(page.pagination.next_offset).toBeNull();
  const exact = await agent.runRaw([
    'why',
    file,
    ...flags,
    '--section',
    'checkpoint-decisions',
    '--decision',
    '12',
  ]);
  expect(JSON.parse(exact.stdout).content).toMatchObject({
    decision: 'Retain delivery partition 11.',
    reason: 'Worker restarts must preserve acknowledged work.',
  });
  expect(JSON.parse(exact.stdout).qualifications.scope).toBe('selected_candidate_fields_only');
  const original = await agent.runRaw([
    'why',
    file,
    ...flags,
    '--section',
    'plan-decisions',
    '--decision',
    '1',
  ]);
  expect(original.stdout).toContain('Use the original durable design.');
  expect(original.stdout).not.toContain('Use a later planner.');
  expect(Buffer.byteLength(exact.stdout)).toBeLessThan(4096);
  expect(JSON.parse(exact.stdout).selection).not.toHaveProperty('scope');
  expect(
    Buffer.byteLength(exact.stdout) -
      Buffer.byteLength(JSON.stringify(JSON.parse(exact.stdout).content))
  ).toBeLessThanOrEqual(1024);
  expect(exact.stdout).not.toContain('Never reuse expired leases.');
  const metadata = await agent.runRaw(['why', file, ...flags, '--section', 'checkpoint-metadata']);
  expect(JSON.parse(metadata.stdout).content).toMatchObject({
    n: 1,
    head_sha: expect.stringMatching(/^[a-f0-9]{40}$/),
  });
  expect(metadata.stdout).not.toContain('Retain delivery leases.');
  const tooLarge = await agent.runRaw([
    'why',
    file,
    ...flags,
    '--section',
    'checkpoint-decisions',
    '--decision',
    '1',
  ]);
  expect(JSON.parse(tooLarge.stdout)).toMatchObject({
    status: 'omitted_oversized',
    section: 'checkpoint-decisions',
    decision: 1,
    content: null,
  });
  expect(tooLarge.stdout).not.toContain('Never reuse expired leases.');
  expect(await inventory(f.root)).toEqual(before);
});

it('pages non-decision candidate sections independently of decision previews', async () => {
  const { file, agent, flags } = await candidates(false, 1, 12);
  const uncertainty = await agent.runRaw([
    'why',
    file,
    ...flags,
    '--section',
    'uncertainty',
    '--section-offset',
    '10',
    '--section-limit',
    '2',
  ]);
  expect(uncertainty.exitCode, uncertainty.stdout).toBe(0);
  expect(JSON.parse(uncertainty.stdout).content).toEqual([
    { position: 11, status: 'available', content: 'Delivery uncertainty 11.' },
    { position: 12, status: 'available', content: 'Delivery uncertainty 12.' },
  ]);
});

it('exports an oversized complete candidate only to an explicit new file', async () => {
  const { f, file, agent, flags } = await candidates(true);
  const response = await agent.runRaw(['why', file, ...flags]);
  expect(response.exitCode, response.stderr || response.stdout).toBe(0);
  expect(JSON.parse(response.stdout)).toMatchObject({
    representation: 'candidate',
    status: 'omitted_oversized',
    candidate: null,
  });
  expect(response.stdout).not.toContain('Never reuse expired leases.');
  expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(16_384);
  const output = path.join(f.temporary, 'candidate.json');
  const exported = await agent.runRaw(['why', file, ...flags, '--output', output]);
  expect(exported.exitCode, exported.stderr || exported.stdout).toBe(0);
  const saved = await readFile(output, 'utf8');
  expect(saved).toContain('Never reuse expired leases.');
  expect(JSON.parse(exported.stdout)).toMatchObject({
    representation: 'candidate_export',
    file: { bytes: Buffer.byteLength(saved) },
  });
  const repeated = await agent.runRaw(['why', file, ...flags, '--output', output]);
  expect(repeated.exitCode).toBe(1);
  expect(await readFile(output, 'utf8')).toBe(saved);
});
