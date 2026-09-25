import { afterEach, expect, it } from 'vitest';

import {
  publishProjectApprovalBinding,
  readProjectApprovalBinding,
} from './knowledge-approval-bindings.js';
import { authorityStore } from '../../../tests/knowledge-authority-store.js';
import {
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const PLAN = {
  source_plan_ref: 'cloud:example-plan',
  version: '2',
  plan_content_sha256: 'a'.repeat(64),
};

const binding = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  change: {
    bindingId?: string;
    targets?: unknown[];
    departures?: unknown[];
    approval?: unknown;
  } = {}
) => ({
  binding_id: change.bindingId ?? uuidv7(),
  approval: change.approval ?? PLAN,
  targets: change.targets ?? [
    {
      target: { kind: 'revision', revision: store.target },
      scope: store.project,
      designation: 'adopted',
    },
    {
      target: {
        kind: 'source_selector',
        selector: {
          source_id: store.sourceId,
          location: 'section 3',
          passage_sha256: 'b'.repeat(64),
        },
      },
      scope: store.artifact,
      designation: 'background',
    },
  ],
  departures: change.departures ?? [],
  authorization_evidence_source_id: store.instructionId,
});

it('binds exact targets and the departures the approver was shown, and reads them back', async () => {
  const store = await authorityStore();
  const authored = binding(store, {
    departures: [
      {
        departure: {
          rule: store.target,
          how: 'excepts',
          exception_id: 'exception-0',
          replaced_by: null,
        },
        scope: store.project,
      },
    ],
  });
  const before = counters(store.handle);
  const published = await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding: authored,
    approvedBy: OWNER,
    secretAllow: [],
  });
  expect(published.value).toEqual({
    bindingId: authored.binding_id,
    recordSha256: expect.any(String),
    targets: 2,
    departures: 1,
    inheritsApproval: false,
  });
  expect(published.counters.intentChangeCounter).toBe(before.intentChangeCounter + 1);

  const row = read(store.handle, (view) => readProjectApprovalBinding(view, authored.binding_id))!;
  const bytes = Buffer.from(row.recordHex, 'hex');
  expect(digest(bytes)).toBe(row.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...authored, approved_by: OWNER });
  expect(row.approval).toEqual({
    sourcePlanRef: PLAN.source_plan_ref,
    version: PLAN.version,
    planContentSha256: PLAN.plan_content_sha256,
  });
  expect(row.authorizationEvidenceSourceId).toBe(store.instructionId);
  expect(row.targets).toEqual([
    {
      position: 0,
      boundKind: 'revision',
      revision: {
        kind: 'requirement',
        entityId: store.requirementId,
        revisionId: store.revisionId,
      },
      selector: null,
      scope: { kind: 'project', value: null },
      designation: 'adopted',
    },
    {
      position: 1,
      boundKind: 'source_selector',
      revision: null,
      selector: {
        sourceId: store.sourceId,
        location: 'section 3',
        passageSha256: 'b'.repeat(64),
      },
      scope: { kind: 'artifact', value: store.plan.artifactId },
      designation: 'background',
    },
  ]);
  expect(row.departures).toEqual([
    {
      position: 0,
      scope: { kind: 'project', value: null },
      rule: { kind: 'requirement', entityId: store.requirementId, revisionId: store.revisionId },
      how: 'excepts',
      exceptionId: 'exception-0',
      replacedBy: null,
    },
  ]);
});

it('keeps a plan approved with no bound targets and moves no intent counter', async () => {
  const store = await authorityStore();
  const before = counters(store.handle);
  const published = await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding: binding(store, { targets: [] }),
    approvedBy: OWNER,
    secretAllow: [],
  });
  expect(published.value.targets).toBe(0);
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
});

it('replays the original result under the same operation id and refuses a changed binding', async () => {
  const store = await authorityStore();
  const operationId = uuidv7();
  const authored = binding(store);
  const input = { operationId, binding: authored, approvedBy: OWNER, secretAllow: [] };
  const first = await publishProjectApprovalBinding(store.handle, input);
  const before = counters(store.handle);
  expect(await publishProjectApprovalBinding(store.handle, input)).toEqual({
    ...first,
    replayed: true,
  });
  expect(counters(store.handle)).toEqual(before);
  await expect(
    publishProjectApprovalBinding(store.handle, {
      ...input,
      binding: { ...authored, targets: [authored.targets[0]] },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'approval_binding_targets')).toBe(2);
});

it('refuses authorization evidence this history does not hold, and a binding id already taken', async () => {
  const store = await authorityStore();
  await expect(
    publishProjectApprovalBinding(store.handle, {
      operationId: uuidv7(),
      binding: { ...binding(store), authorization_evidence_source_id: uuidv7() },
      approvedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(store.handle, 'approval_bindings')).toBe(0);

  const taken = binding(store);
  await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding: taken,
    approvedBy: OWNER,
    secretAllow: [],
  });
  await expect(
    publishProjectApprovalBinding(store.handle, {
      operationId: uuidv7(),
      binding: binding(store, { bindingId: taken.binding_id }),
      approvedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'approval_bindings')).toBe(1);
});

it('refuses a bound scope outside this store and a branch as an authority scope', async () => {
  const store = await authorityStore();
  for (const scope of [
    { kind: 'project', project_id: uuidv7() },
    { kind: 'branch', branch: 'feature/retry' },
  ]) {
    const before = counters(store.handle);
    await expect(
      publishProjectApprovalBinding(store.handle, {
        operationId: uuidv7(),
        binding: binding(store, {
          targets: [
            { target: { kind: 'revision', revision: store.target }, scope, designation: 'adopted' },
          ],
        }),
        approvedBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(counters(store.handle)).toEqual(before);
  }
  expect(rowCount(store.handle, 'approval_bindings')).toBe(0);
});

it('refuses one target bound as both adopted and background', async () => {
  const store = await authorityStore();
  const both = binding(store).targets[0] as { designation: string };
  await expect(
    publishProjectApprovalBinding(store.handle, {
      operationId: uuidv7(),
      binding: binding(store, { targets: [both, { ...both, designation: 'background' }] }),
      approvedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'approval_bindings')).toBe(0);
});

it('inherits an approval only when a later binding of it binds exactly the same', async () => {
  const store = await authorityStore();
  const first = binding(store);
  await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding: first,
    approvedBy: OWNER,
    secretAllow: [],
  });
  const reordered = await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding: binding(store, { targets: [...first.targets].reverse() }),
    approvedBy: OWNER,
    secretAllow: [],
  });
  expect(reordered.value.inheritsApproval).toBe(true);

  const changed = await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding: binding(store, {
      targets: [
        {
          target: { kind: 'revision', revision: store.target },
          scope: store.project,
          designation: 'background',
        },
        first.targets[1],
      ],
    }),
    approvedBy: OWNER,
    secretAllow: [],
  });
  expect(changed.value.inheritsApproval).toBe(false);
});
