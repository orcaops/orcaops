import { afterEach, expect, it } from 'vitest';

import { publishProjectApprovalBinding } from './knowledge-approval-bindings.js';
import { createProjectRequirement } from './knowledge-requirements.js';
import { publishProjectSelection } from './knowledge-selections.js';
import {
  listProjectSelectorResolutions,
  publishProjectSelectorResolution,
} from './knowledge-selector-resolutions.js';
import {
  acceptedSelection,
  authorityStore,
  BY_OWNER,
  requirementRevision,
} from '../../../tests/knowledge-authority-store.js';
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

const PASSAGE = 'Local capture works with no Cloud connection.';

/** A store whose approval bound one passage, with a requirement that restates it verbatim. */
async function boundPassage(paraphrase = false) {
  const store = await authorityStore();
  const selector = {
    source_id: store.sourceId,
    location: 'section 3',
    passage_sha256: digest(Buffer.from(PASSAGE)),
  };
  const requirementId = uuidv7();
  const revision = requirementRevision(requirementId, store.sourceId, {
    statement: paraphrase ? 'Capture keeps working while offline.' : PASSAGE,
    passages: [selector],
  });
  await createProjectRequirement(store.handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: requirementId,
      origin: { kind: 'authored', source_id: store.sourceId },
    },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const bindingId = uuidv7();
  await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding: {
      binding_id: bindingId,
      approval: {
        source_plan_ref: 'cloud:example-plan',
        version: '2',
        plan_content_sha256: 'a'.repeat(64),
      },
      targets: [
        {
          target: { kind: 'source_selector', selector },
          scope: store.artifact,
          designation: 'background',
        },
      ],
      departures: [],
      authorization_evidence_source_id: store.instructionId,
    },
    approvedBy: OWNER,
    secretAllow: [],
  });
  const resolution = {
    binding_id: bindingId,
    selector,
    resolved: {
      kind: 'requirement' as const,
      entity_id: requirementId,
      revision_id: revision.revision_id,
    },
    scope: store.artifact,
    designation: 'background' as const,
  };
  return { store, selector, bindingId, requirementId, resolution };
}

it('resolves a bound selector to the revision that states the passage verbatim', async () => {
  const { store, resolution, bindingId } = await boundPassage();
  const before = counters(store.handle);
  const published = await publishProjectSelectorResolution(store.handle, {
    operationId: uuidv7(),
    resolution,
    secretAllow: [],
  });
  expect(published.value.published).toBe(true);
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  const [row] = read(store.handle, (view) => listProjectSelectorResolutions(view, bindingId));
  expect(row).toMatchObject({
    bindingId,
    selector: {
      sourceId: resolution.selector.source_id,
      location: 'section 3',
      passageSha256: resolution.selector.passage_sha256,
    },
    resolved: {
      kind: 'requirement',
      entityId: resolution.resolved.entity_id,
      revisionId: resolution.resolved.revision_id,
    },
    scope: { kind: 'artifact', value: store.plan.artifactId },
    designation: 'background',
  });
  const bytes = Buffer.from(row!.recordHex, 'hex');
  expect(digest(bytes)).toBe(row!.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual(resolution);
});

it('adopts the exact revision a bound selector resolved to', async () => {
  const { store, resolution, bindingId } = await boundPassage();
  const adopt = () =>
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(
        resolution.resolved,
        resolution.scope,
        { kind: 'approval_binding', binding_id: bindingId },
        { designation: resolution.designation }
      ),
      selectedBy: OWNER,
      acceptedAt: '2026-09-17T10:00:00.000Z',
      secretAllow: [],
    });

  await expect(adopt()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await publishProjectSelectorResolution(store.handle, {
    operationId: uuidv7(),
    resolution,
    secretAllow: [],
  });
  await expect(adopt()).resolves.toHaveProperty('value.kind', 'accepted');
});

it('does not widen a selector resolution while authorizing an adoption', async () => {
  const { store, resolution, bindingId } = await boundPassage();
  await publishProjectSelectorResolution(store.handle, {
    operationId: uuidv7(),
    resolution,
    secretAllow: [],
  });
  for (const [target, scope, designation, citedBinding, code] of [
    [store.target, resolution.scope, resolution.designation, bindingId, 'INVALID_INPUT'],
    [resolution.resolved, store.project, resolution.designation, bindingId, 'INVALID_INPUT'],
    [resolution.resolved, resolution.scope, 'adopted', bindingId, 'INVALID_INPUT'],
    [resolution.resolved, resolution.scope, resolution.designation, uuidv7(), 'HISTORY_MISSING'],
  ] as const)
    await expect(
      publishProjectSelection(store.handle, {
        operationId: uuidv7(),
        selection: acceptedSelection(
          target,
          scope,
          { kind: 'approval_binding', binding_id: citedBinding },
          { designation }
        ),
        selectedBy: OWNER,
        acceptedAt: '2026-09-17T10:00:00.000Z',
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code });
});

it('returns the resolution it already holds and runs no operation for a repeat', async () => {
  const { store, resolution } = await boundPassage();
  const first = await publishProjectSelectorResolution(store.handle, {
    operationId: uuidv7(),
    resolution,
    secretAllow: [],
  });
  const before = counters(store.handle);
  const operations = rowCount(store.handle, 'operations');
  const again = await publishProjectSelectorResolution(store.handle, {
    operationId: uuidv7(),
    resolution,
    secretAllow: [],
  });
  expect(again).toEqual({
    value: { ...first.value, published: false },
    replayed: true,
    counters: before,
  });
  expect(rowCount(store.handle, 'operations')).toBe(operations);
  expect(rowCount(store.handle, 'selector_resolutions')).toBe(1);
});

it('refuses a resolution that broadens its binding or upgrades its designation', async () => {
  const { store, resolution } = await boundPassage();
  // The bound resolution is retained first, so a broadened one is answered against a row that is
  // there rather than against an empty table.
  const bound = await publishProjectSelectorResolution(store.handle, {
    operationId: uuidv7(),
    resolution,
    secretAllow: [],
  });
  for (const broadened of [
    { ...resolution, scope: store.project },
    { ...resolution, designation: 'adopted' },
  ])
    await expect(
      publishProjectSelectorResolution(store.handle, {
        operationId: uuidv7(),
        resolution: broadened,
        secretAllow: [],
      }),
      JSON.stringify(broadened.scope)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const retained = read(store.handle, (view) =>
    listProjectSelectorResolutions(view, resolution.binding_id)
  );
  expect(retained.map((row) => [row.designation, row.recordSha256])).toEqual([
    ['background', bound.value.recordSha256],
  ]);
});

it('refuses a revision that does not state the approved passage verbatim', async () => {
  const { store, resolution } = await boundPassage(true);
  await expect(
    publishProjectSelectorResolution(store.handle, {
      operationId: uuidv7(),
      resolution,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'selector_resolutions')).toBe(0);
});

it('refuses a revision that does not cite the approved passage', async () => {
  const { store, resolution, selector } = await boundPassage();
  const other = uuidv7();
  const revision = requirementRevision(other, store.sourceId, {
    statement: PASSAGE,
    passages: [{ ...selector, location: 'section 7' }],
  });
  await createProjectRequirement(store.handle, {
    operationId: uuidv7(),
    identity: { requirement_id: other, origin: { kind: 'authored', source_id: store.sourceId } },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  await expect(
    publishProjectSelectorResolution(store.handle, {
      operationId: uuidv7(),
      resolution: {
        ...resolution,
        resolved: { kind: 'requirement', entity_id: other, revision_id: revision.revision_id },
      },
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'selector_resolutions')).toBe(0);
});

it('refuses a second identity for a passage another resolution already resolved', async () => {
  const { store, resolution, selector } = await boundPassage();
  await publishProjectSelectorResolution(store.handle, {
    operationId: uuidv7(),
    resolution,
    secretAllow: [],
  });
  const second = uuidv7();
  const revision = requirementRevision(second, store.sourceId, {
    statement: PASSAGE,
    passages: [selector],
  });
  await createProjectRequirement(store.handle, {
    operationId: uuidv7(),
    identity: { requirement_id: second, origin: { kind: 'authored', source_id: store.sourceId } },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  await expect(
    publishProjectSelectorResolution(store.handle, {
      operationId: uuidv7(),
      resolution: {
        ...resolution,
        resolved: { kind: 'requirement', entity_id: second, revision_id: revision.revision_id },
      },
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'selector_resolutions')).toBe(1);
});

it('refuses a binding and a resolved revision this history does not hold', async () => {
  const { store, resolution } = await boundPassage();
  for (const missing of [
    { ...resolution, binding_id: uuidv7() },
    {
      ...resolution,
      resolved: { ...resolution.resolved, revision_id: uuidv7() },
    },
  ])
    await expect(
      publishProjectSelectorResolution(store.handle, {
        operationId: uuidv7(),
        resolution: missing,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(store.handle, 'selector_resolutions')).toBe(0);
});
