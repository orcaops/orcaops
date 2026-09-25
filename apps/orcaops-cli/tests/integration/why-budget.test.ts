import { expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { adoptedRequirement } from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

it('keeps delivery reasons and reversals within every display budget while labeling plans separately', async () => {
  const f = await fixture();
  const openRef = f.context.headOid!;
  const closeRef = await commitFile(f, 'src/delivery.ts', 'export const durable = true;\n');
  const artifact = await f.capture(undefined, {
    criteria: [
      { criterion_id: uuidv7(), text: 'Run pnpm lint and durable delivery lease tests.' },
      {
        criterion_id: uuidv7(),
        text: 'Run delivery tests only after the durable lease is committed.',
      },
    ],
  });
  const obligation = 'Run delivery tests before publishing changes.';
  await adoptedRequirement(f.writer, {
    projectId: f.authority.projectId,
    statement: obligation,
  });
  const decision = {
    decision: 'Keep durable delivery leases.',
    reason: 'Worker restarts must not lose acknowledged notification work.',
    alternatives_considered: [
      {
        option: 'Use process-local timers.',
        rejected_because: 'A worker exit loses its timers and pending acknowledgements.',
      },
    ],
  };
  await closeFingerprintedCheckpoint(f, artifact, {
    files: ['src/delivery.ts'],
    openRef,
    closeRef,
    decisions: [decision],
    summary: 'ESLint passed.',
  });
  const later = await f.capture();
  const laterRef = await commitFile(f, 'src/other.ts', 'export const outbox = true;\n');
  const reversal = 'Replace durable delivery leases with a transactional notification outbox.';
  await closeFingerprintedCheckpoint(f, later, {
    files: ['src/other.ts'],
    openRef: closeRef,
    closeRef: laterRef,
    decisions: [
      { decision: reversal, reason: 'The outbox prevents duplicate sends after a worker restart.' },
    ],
    summary:
      'Durable delivery leases preserve notification retries. Removed screenshot archives and build manifests. ' +
      'Screenshots and builds were recorded for the final ledger. '.repeat(95),
  });
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const before = await inventory(f.temporary);
  for (const [flags, ceiling] of [
    [[], 16384],
    [['--view', 'rationale'], 32768],
    [['--details', '--audit'], 65536],
  ] as const) {
    const result = await agent.runRaw(['why', 'src/delivery.ts', '--json', ...flags]);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.output.bytes).toBe(Buffer.byteLength(result.stdout));
    expect(answer.output.ceiling_bytes).toBe(ceiling);
    expect(answer.output.bytes).toBeLessThanOrEqual(ceiling);
    expect(answer.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(answer.knowledge.obligations)).toContain(obligation);
    expect(JSON.stringify(answer.knowledge.rationale)).toContain(
      'Run delivery tests only after the durable lease is committed.'
    );
    expect(answer.knowledge.rationale).toContainEqual(
      expect.objectContaining({
        account: expect.objectContaining({
          wording: decision.decision,
          reason: decision.reason,
          alternatives: decision.alternatives_considered,
        }),
      })
    );
    expect(answer.knowledge.rationale).toContainEqual(
      expect.objectContaining({ account: expect.objectContaining({ wording: reversal }) })
    );
    expect(JSON.stringify(answer.knowledge.rationale)).not.toContain(
      'Screenshots and builds were recorded'
    );
    expect(answer.knowledge.verification).toMatchObject({
      status: 'reported',
      reported_records: 1,
      planned: { status: 'planned', records: 1 },
    });
    const human = await agent.runRaw(['why', 'src/delivery.ts', ...flags]);
    expect(human.exitCode, human.stderr).toBe(0);
    expect(Buffer.byteLength(human.stdout)).toBeLessThanOrEqual(ceiling);
    expect(human.stdout).toContain(decision.reason);
    expect(human.stdout).toContain('planned');
  }
  expect(await inventory(f.temporary)).toEqual(before);
});

it('bounds errors even when the rejected target is enormous', async () => {
  const f = await fixture();
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  for (const flags of [[], ['--json']]) {
    const result = await agent.runRaw(['why', 'x'.repeat(60000), ...flags]);
    expect(result.exitCode).not.toBe(0);
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(16384);
  }
  for (const command of [
    ['why', 'src/delivery.ts'],
    ['show', 'artifact'],
    ['knowledge', 'show', 'reference'],
  ]) {
    const result = await agent.runRaw([...command, '--' + 'x'.repeat(60000)]);
    expect(result.exitCode).not.toBe(0);
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(16384);
    expect(result.stderr).toContain('oversized error details omitted');
  }
});
