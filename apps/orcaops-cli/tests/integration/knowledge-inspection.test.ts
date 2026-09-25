import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  appendProjectCorrection,
  publishProjectKnowledgeSource,
  readProjectRationale,
} from '@orcaops/storage/history/database';

import { fixture, inventory } from '../helpers/database-history.js';
import {
  adoptedRequirement,
  instructionSource,
  OWNER,
  planEventOf,
  writeSequenceOf,
} from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

it('does not recommend export when the account and available qualifications fit', async () => {
  const f = await fixture();
  const artifact = await f.capture(undefined, {
    decisions: [
      {
        decision: 'Keep delivery leases.',
        reason: 'Worker restarts retain acknowledged work.',
        revision_n: 0,
      },
    ],
  });
  const read = readProjectRationale(f.writer, {
    candidates: [{ artifactId: artifact, eventId: planEventOf(f.writer, artifact) }],
    boundary: 'now',
    observation: writeSequenceOf(f.writer),
  }).value;
  const item = read.items.find((item) => item.account.kind === 'decision')!;
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const response = await agent.runRaw(['knowledge', 'show', item.reference, '--context', '--json']);
  expect(response.exitCode, response.stderr || response.stdout).toBe(0);
  const result = JSON.parse(response.stdout);
  expect(result).toMatchObject({
    status: 'available',
    completeness: { complete: true, reasons: [] },
    pagination: { next_cursor: null },
  });
  expect(result.follow_up).not.toHaveProperty('export');
  expect(result.follow_up).not.toHaveProperty('next');
});

it('bounds exact knowledge inspection and exports whole reasons and alternatives without changing history', async () => {
  const f = await fixture();
  const choice = {
    decision: 'Reuse delivery identifiers.',
    reason: 'Keep the exception visible. '.repeat(1400) + 'Never reuse an expired identifier.',
    revision_n: 0,
    alternatives_considered: [
      {
        option: 'Always reuse.',
        rejected_because: 'Expired identifiers can target the wrong delivery.',
      },
    ],
  };
  const artifact = await f.capture(undefined, { decisions: [choice] });
  const read = readProjectRationale(f.writer, {
    candidates: [{ artifactId: artifact, eventId: planEventOf(f.writer, artifact) }],
    boundary: 'now',
    observation: writeSequenceOf(f.writer),
  }).value;
  const item = read.items.find((item) => item.account.kind === 'decision')!;
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const before = await inventory(f.root);
  for (const flags of [[], ['--json'], ['--details', '--json']]) {
    const response = await agent.runRaw(['knowledge', 'show', item.reference, ...flags]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(
      flags.includes('--details') ? 32_768 : 16_384
    );
    const result = JSON.parse(response.stdout);
    expect(result).toMatchObject({
      schema_version: 2,
      status: 'omitted_oversized',
      content: null,
      qualification_status: 'omitted',
    });
    expect(result.follow_up).not.toHaveProperty('qualifications');
    expect(result.follow_up.export).toContain('--output');
    expect(response.stdout).not.toContain('Never reuse an expired identifier.');
    if (flags.includes('--json'))
      expect(result.output.bytes).toBe(Buffer.byteLength(response.stdout));
  }
  expect(await inventory(f.root)).toEqual(before);
  const output = path.join(f.temporary, 'exact-account.json');
  const exported = await agent.runRaw([
    'knowledge',
    'show',
    item.reference,
    '--output',
    output,
    '--json',
  ]);
  expect(exported.exitCode, exported.stderr || exported.stdout).toBe(0);
  const saved = await readFile(output, 'utf8');
  expect(JSON.parse(exported.stdout)).toMatchObject({
    status: 'exported',
    file: { bytes: Buffer.byteLength(saved) },
  });
  expect(JSON.parse(saved).content).toEqual(item.account);
  expect(JSON.parse(saved).qualification_status).toBe('included_summary');
  const repeated = await agent.runRaw([
    'knowledge',
    'show',
    item.reference,
    '--output',
    output,
    '--json',
  ]);
  expect(repeated.exitCode).toBe(1);
  expect(await readFile(output, 'utf8')).toBe(saved);
});

it('recovers omitted qualifications through bounded context pages and complete scoped export', async () => {
  const f = await fixture();
  const artifact = await f.capture(undefined, {
    decisions: [
      { decision: 'Retain cached responses.', reason: 'Avoid duplicate requests.', revision_n: 0 },
    ],
  });
  const event = planEventOf(f.writer, artifact);
  const sourceId = uuidv7();
  await publishProjectKnowledgeSource(f.writer, {
    operationId: uuidv7(),
    source: {
      source_id: sourceId,
      occurrence: {
        kind: 'capture_field',
        artifact_id: artifact,
        event_id: event,
        field_path: 'decisions[0].decision',
        position: 0,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: OWNER,
    secretAllow: [],
  });
  const targets = [];
  for (let index = 0; index < 6; index++)
    targets.push(
      await adoptedRequirement(f.writer, {
        projectId: f.authority.projectId,
        statement: `Cache qualification ${index}.`,
        promotedFrom: { sourceId, location: 'decisions[0].decision' },
      })
    );
  const boundary = writeSequenceOf(f.writer);
  const corrected = 'Private responses must never enter the shared cache.';
  const correctionSource = await instructionSource(f.writer, corrected);
  await appendProjectCorrection(f.writer, {
    operationId: uuidv7(),
    attributedTo: { kind: 'actor', actor: OWNER },
    secretAllow: [],
    action: {
      action_id: uuidv7(),
      kind: 'factual_correction',
      corrected_account: corrected,
      targets: [
        {
          kind: 'requirement',
          entity_id: targets[5]!.requirementId,
          revision_id: targets[5]!.revisionId,
        },
      ],
      scope: { kind: 'artifact', artifact_id: artifact },
      source_id: correctionSource,
      authorization: null,
      expected_state: {
        kind: 'observed',
        selection_ids: [targets[5]!.selectionId],
        correction_action_ids: [],
      },
    },
  });
  const read = readProjectRationale(f.writer, {
    candidates: [{ artifactId: artifact, eventId: event }],
    boundary,
    observation: writeSequenceOf(f.writer),
    authorityArtifactId: artifact,
  }).value;
  const item = read.items.find((item) => item.account.kind === 'decision')!;
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  let cursor: string | null = null;
  const seen: string[] = [];
  let firstCursor = '';
  for (let index = 0; index < 6; index++) {
    const response = await agent.runRaw([
      'knowledge',
      'show',
      item.reference,
      '--context',
      '--limit',
      '1',
      '--scope',
      `artifact:${artifact}`,
      '--json',
      ...(cursor ? ['--cursor', cursor] : []),
    ]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(16_384);
    const result = JSON.parse(response.stdout);
    expect(result.status).toBe('available');
    expect(result.follow_up).not.toHaveProperty('export');
    expect(result.completeness.reasons).toContainEqual({
      code: 'qualifications_outside_page',
      count: 5,
    });
    expect(result.selection.scope).toEqual({ kind: 'artifact', artifact_id: artifact });
    seen.push(result.qualifications[0].target.entity_id);
    if (index < 5) expect(response.stdout).not.toContain(corrected);
    else expect(response.stdout).toContain(corrected);
    cursor = result.pagination.next_cursor;
    if (cursor) expect(result.follow_up.next).toContain(cursor);
    else expect(result.follow_up).not.toHaveProperty('next');
    if (index === 0) firstCursor = cursor!;
  }
  expect(new Set(seen).size).toBe(6);
  expect(cursor).toBeNull();
  const output = path.join(f.temporary, 'qualified-account.json');
  const exported = await agent.runRaw([
    'knowledge',
    'show',
    item.reference,
    '--context',
    '--output',
    output,
    '--scope',
    `artifact:${artifact}`,
    '--json',
  ]);
  expect(exported.exitCode, exported.stderr || exported.stdout).toBe(0);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  expect(saved.qualifications).toHaveLength(6);
  expect(JSON.stringify(saved)).toContain(corrected);
  expect(saved.pagination.next_cursor).toBeNull();
  await f.capture();
  const stale = await agent.runRaw([
    'knowledge',
    'show',
    item.reference,
    '--context',
    '--cursor',
    firstCursor,
    '--scope',
    `artifact:${artifact}`,
    '--json',
  ]);
  expect(JSON.parse(stale.stdout).error.code).toBe('STALE_CONTEXT');
  expect(JSON.parse(stale.stdout)).not.toHaveProperty('qualifications');
});

it('rejects invalid knowledge inspection options without emitting large errors', async () => {
  const f = await fixture();
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  for (const flags of [
    [],
    ['--limit', '9'],
    ['--output', '-'],
    ['--context', '--cursor', 'invalid'],
  ]) {
    const response = await agent.runRaw([
      'knowledge',
      'show',
      'invalid'.repeat(10_000),
      '--json',
      ...flags,
    ]);
    expect(response.exitCode).toBe(1);
    expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(16_384);
  }
});
