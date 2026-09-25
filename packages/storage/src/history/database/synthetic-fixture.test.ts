import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';

import { openProjectDatabase } from './connection.js';
import { PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { snapshot } from '../../../tests/database-fixture.mjs';
import { exactRevisionTables } from '../../../tests/push-upgrade-fixture.js';
import {
  blobBytes,
  countBy,
  databaseDigest,
  readReleasedFixture,
  schemaDigests,
  tableDigest,
} from '../../../tests/released-fixture.mjs';
import {
  readSyntheticFixture,
  restoreSyntheticFixture,
} from '../../../tests/synthetic-fixture.mjs';

type Row = Record<string, unknown>;

// Pinned here as well as in the manifest: regenerating the fixture together with its manifest
// would otherwise pass every hash comparison below.
const FROZEN_COMPOSED_SHA256 = 'dc01b307ba4ca35e853c0041fe6febadd2ba884ee6839ca0f72b581111f8a877';
const RELEASED_BASE_SHA256 = '3172a771f835aee77c3eaa4a61b2362c2d3d9f7000b080309b77dbc917a0b00f';
const SOURCE_PLAN_TABLES = [
  'source_plan_approved',
  'source_plan_locator_current',
  'source_plan_locator_revisions',
  'source_plan_namespaces',
  'source_plan_records',
  'source_plan_review_current',
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const record = (row: Row) => JSON.parse(blobBytes(row.record_bytes).toString('utf8'));
const combinations = (rows: Row[], ...columns: string[]) =>
  Object.keys(
    countBy(
      rows.map((row) => ({ key: columns.map((column) => row[column]).join(':') })),
      'key'
    )
  );

it('says it is synthetic and names its released base, its writers and their commit', async () => {
  const { manifest, database, base } = await readSyntheticFixture();
  const identity = manifest.storage_code_identity;

  expect(Object.keys(manifest).slice(0, 5)).toEqual([
    'fixture',
    'synthetic',
    'statement',
    'writers',
    'storage_code_identity',
  ]);
  expect(manifest.fixture).toMatch(/^SYNTHETIC /);
  expect(manifest.synthetic).toBe(true);
  expect(manifest.statement).toMatch(/No released build can write the exact-revision rows/);
  expect(manifest.statement).toMatch(/Nothing here is released history/);

  expect(manifest.writers.exact_revision.map((writer) => writer.function)).toEqual([
    'publishProjectCriterionLineage',
    'publishProjectClaimRevision',
    'publishProjectDecisionRevision',
    'publishProjectRecordRelationship',
    'publishProjectAdoption',
    'publishProjectAssessment',
  ]);
  expect(manifest.writers.source_plan.map((writer) => writer.function)).toEqual([
    'publishProjectSourcePlanRecord',
    'publishProjectSourcePlanLocator',
  ]);
  expect(manifest.writers.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(identity.head_commit).toBe(manifest.writers.commit);
  expect(identity.working_tree_matches_head).toBe(true);
  expect(identity.directory).toBe('packages/storage/src/history/database');
  expect(identity.files).toBeGreaterThan(0);
  expect(identity.releases.map((release) => [release.tag, release.differing_files])).toEqual([
    ['shipped/0.2.0', []],
    ['shipped/0.2.1', []],
  ]);
  for (const release of identity.releases) expect(release.commit).toMatch(/^[0-9a-f]{40}$/);
  const closure = identity.writer_import_closure;
  expect(closure.files).toBeGreaterThan(identity.files / 2);
  expect(closure.packages).toEqual(['packages/evaluator-protocol', 'packages/storage']);
  for (const difference of closure.files_that_differ_from_a_release) {
    expect(difference.file.startsWith(`${identity.directory}/`), difference.file).toBe(false);
    expect(difference.effect_on_the_writers).toMatch(/^Cannot affect the rows: /);
  }
  expect(manifest.statement).toMatch(/criterion lineage records are not invented/);
  expect(manifest.covers.join(' ')).toMatch(/The two branch rows differ in scope value alone/);
  expect(manifest.covers.join(' ')).toMatch(/one target and approver adopted on two branches/);

  expect(database.base).toBe('released/cli-0.2.1');
  expect(manifest.base.released_fixture).toBe('../released/cli-0.2.1');
  expect(manifest.base.released_content_sha256).toBe(base.manifest.content.sha256);
  expect(manifest.base.released_content_sha256).toBe(RELEASED_BASE_SHA256);
});

it('matches every content hash its manifest records and leaves the released rows as they were', async () => {
  const { manifest, database, base, rows } = await readSyntheticFixture();

  expect(database.schemaVersion).toBe(29);
  expect(Object.keys(database.rows).sort()).toEqual(manifest.base.tables_the_writers_changed);
  expect(Object.keys(manifest.content.tables).sort()).toEqual(
    manifest.base.tables_the_writers_changed
  );
  for (const [table, recorded] of Object.entries(manifest.content.tables)) {
    expect({
      table,
      rows: database.rows[table]!.length,
      sha256: tableDigest(database.rows[table]!),
    }).toEqual({ table, ...recorded });
  }
  expect(databaseDigest(rows)).toBe(manifest.content.composed_sha256);
  expect(manifest.content.composed_sha256).toBe(FROZEN_COMPOSED_SHA256);
  expect(countBy(rows.operations!, 'operation_kind')).toEqual(manifest.content.operations_by_kind);
  const { user_version, file, ...recordedSchema } = manifest.schema;
  expect([user_version, file]).toEqual([29, '../released/schema.json']);
  expect(schemaDigests(base.schema.definitions)).toEqual(recordedSchema);

  expect(databaseDigest(base.database.rows)).toBe(RELEASED_BASE_SHA256);
  const releasedReceipts = base.database.rows.operations!;
  expect(manifest.base.released_receipts_kept_as_prefix).toBe(releasedReceipts.length);
  expect(rows.operations!.slice(0, releasedReceipts.length)).toEqual(releasedReceipts);
  const sameContent = (table: string) =>
    JSON.stringify(database.rows[table]) === JSON.stringify(base.database.rows[table]);
  expect(Object.keys(database.rows).filter(sameContent)).toEqual([]);
  expect(Object.keys(database.rows)).not.toContain('store_identity');
  expect(manifest.base.unchanged_tables).toBe(
    Object.keys(rows).length - manifest.base.tables_the_writers_changed.length
  );
});

it('holds rows in the tables no released fixture can populate', async () => {
  const [synthetic, older, newer] = await Promise.all([
    readSyntheticFixture(),
    readReleasedFixture('0.2.0'),
    readReleasedFixture('0.2.1'),
  ]);

  for (const table of [...exactRevisionTables, ...SOURCE_PLAN_TABLES]) {
    expect({
      table,
      released: [older.database.rows[table]!.length, newer.database.rows[table]!.length],
      synthetic: synthetic.rows[table]!.length > 0,
    }).toEqual({ table, released: [0, 0], synthetic: true });
  }
  expect(synthetic.rows.source_plan_upload_commands).toEqual([]);
});

it('holds a criterion lineage chain that restates criteria of the released plan events', async () => {
  const { rows, base } = await readSyntheticFixture();
  const lineage = rows.criterion_lineage!;
  const events = new Map(base.database.rows.artifact_events!.map((row) => [row.event_id, row]));

  expect(combinations(lineage, 'lineage', 'scope_kind')).toEqual([
    'added:artifact',
    'carried:branch',
    'rewritten:project',
  ]);
  const added = new Set(
    lineage.filter((row) => row.lineage === 'added').map((row) => row.criterion_id)
  );
  for (const row of lineage) {
    const event = events.get(row.source_event_id)!;
    expect(event.artifact_id).toBe(row.artifact_id);
    expect(
      base.database.rows.artifact_revisions!.some(
        (revision) =>
          revision.artifact_id === row.artifact_id &&
          revision.generation === row.artifact_generation
      )
    ).toBe(true);
    const [, step, position] = /^plan_steps\[(\d+)\]\.acceptance_criteria\[(\d+)\]$/.exec(
      row.field_path as string
    )!;
    const payload = JSON.parse(blobBytes(event.record_bytes).toString('utf8')).payload;
    expect(record(row)).toEqual(
      payload.plan_steps[Number(step)].acceptance_criteria[Number(position)]
    );
    if (row.lineage === 'added') expect(row.prior_criterion_id).toBeNull();
    else expect(added.has(row.prior_criterion_id)).toBe(true);
  }
  const rewritten = lineage.find((row) => row.lineage === 'rewritten')!;
  const original = lineage.find(
    (row) => row.lineage === 'added' && row.criterion_id === rewritten.prior_criterion_id
  )!;
  expect(record(rewritten).text).not.toBe(record(original).text);
});

it('holds a claim and a decision with two revisions each, the second sorting before the first by id', async () => {
  const { rows, base, manifest } = await readSyntheticFixture();
  const revisionsOf = (table: string, column: string, id: unknown) =>
    rows[table]!.filter((row) => row[column] === id);
  const [claim, otherClaim] = rows.claims!;
  const [decision, otherDecision] = rows.decisions!;
  const [firstClaim, secondClaim] = revisionsOf('claim_revisions', 'claim_id', claim!.claim_id);
  const [firstDecision, secondDecision] = revisionsOf(
    'decision_revisions',
    'decision_id',
    decision!.decision_id
  );

  expect([rows.claims!.length, rows.claim_revisions!.length]).toEqual([2, 3]);
  expect([rows.decisions!.length, rows.decision_revisions!.length]).toEqual([2, 3]);
  expect(revisionsOf('claim_revisions', 'claim_id', otherClaim!.claim_id)).toHaveLength(1);
  expect(revisionsOf('decision_revisions', 'decision_id', otherDecision!.decision_id)).toHaveLength(
    1
  );
  expect(claim!.first_revision_id).toBe(firstClaim!.revision_id);
  expect(decision!.first_revision_id).toBe(firstDecision!.revision_id);
  for (const [first, second] of [
    [firstClaim!, secondClaim!],
    [firstDecision!, secondDecision!],
  ]) {
    expect([first!.previous_revision_id, second!.previous_revision_id]).toEqual([
      null,
      first!.revision_id,
    ]);
    expect((second!.revision_id as string) < (first!.revision_id as string)).toBe(true);
  }
  expect(manifest.content.coverage.revisions_whose_id_sorts_before_their_predecessor).toEqual([
    secondClaim!.revision_id,
    secondDecision!.revision_id,
  ]);
  expect([firstClaim!.verification_provenance, secondClaim!.verification_provenance]).toEqual([
    'agent_reported',
    null,
  ]);
  expect(JSON.parse(firstClaim!.verification_json as string)).toMatchObject({ exit_code: 0 });
  expect([firstDecision!.alternative_count, secondDecision!.alternative_count]).toEqual([1, 2]);

  const released = base.database.rows.project_counters![0]!;
  const final = rows.project_counters![0]!;
  const observed = rows.assessments!.map((row) => [
    row.observed_write_sequence as number,
    row.observed_intent_counter as number,
  ]);
  expect(rows.assessments!.map((row) => row.claim_revision_id)).toEqual([
    firstClaim!.revision_id,
    secondClaim!.revision_id,
  ]);
  expect(observed[0]![0]).toBeGreaterThan(released.write_sequence as number);
  expect(observed[1]![0]).toBeGreaterThan(observed[0]![0]!);
  expect(observed[1]![1]).toBeGreaterThan(observed[0]![1]!);
  expect(observed[1]![0]).toBeLessThanOrEqual(final.write_sequence as number);
  expect(observed[1]![1]).toBe(final.intent_change_counter);

  for (const row of [...rows.claim_revisions!, ...rows.decision_revisions!, ...rows.assessments!]) {
    expect(record(row).synthetic).toBe(true);
    expect(JSON.stringify(record(row))).toMatch(/Synthetic (claim|decision|assessment):/);
  }
});

it('holds the shapes a rebuilt relationship constraint could break', async () => {
  const { rows, manifest } = await readSyntheticFixture();
  const relationships = rows.record_relationships!;
  const [decision] = rows.decisions!;
  const [firstDecision, secondDecision] = rows.decision_revisions!.filter(
    (row) => row.decision_id === decision!.decision_id
  );
  const edge = (row: Row) =>
    [
      row.relation,
      row.from_entity_kind,
      row.from_revision_id,
      row.to_entity_kind,
      row.to_revision_id,
    ].join(' ');

  expect(combinations(relationships, 'relation', 'scope_kind')).toEqual([
    'challenges:branch',
    'challenges:project',
    'supersedes:branch',
    'supersedes:project',
  ]);
  expect(combinations(relationships, 'relation', 'from_entity_kind', 'to_entity_kind')).toEqual([
    'challenges:claim:decision',
    'challenges:decision:claim',
    'supersedes:claim:claim',
    'supersedes:decision:decision',
  ]);
  expect(combinations(relationships, 'attributed_kind')).toEqual(['author', 'detector']);

  const [atProject, onBranch] = manifest.content.coverage.same_relationship_at_two_scopes.map(
    (id) => relationships.find((row) => row.relationship_id === id)!
  );
  expect(edge(atProject!)).toBe(edge(onBranch!));
  expect([atProject!.scope_kind, atProject!.scope_value]).toEqual(['project', null]);
  expect([onBranch!.scope_kind, onBranch!.scope_value]).toEqual(['branch', 'rate-limit']);

  const sameTuple = relationships.filter((row) => edge(row) === edge(atProject!));
  expect(sameTuple.map((row) => [row.scope_kind, row.scope_value])).toEqual([
    ['project', null],
    ['branch', 'rate-limit'],
    ['branch', 'limit-docs'],
  ]);
  expect(sameTuple.slice(1).map((row) => row.relationship_id)).toEqual(
    manifest.content.coverage.same_relationship_on_two_branches
  );

  const crossRecord = relationships.filter(
    (row) => row.relation === 'supersedes' && row.from_entity_id !== row.to_entity_id
  );
  expect(crossRecord.map((row) => [row.from_entity_kind, row.to_revision_id])).toEqual([
    ['decision', secondDecision!.revision_id],
  ]);

  expect(manifest.content.coverage.relationship_still_naming_a_first_revision).toEqual({
    relationship_id: atProject!.relationship_id,
    to_revision_id: firstDecision!.revision_id,
    later_revision_id: secondDecision!.revision_id,
  });
  const receipts = rows.operations!.map((row) => row.operation_id);
  expect(receipts.indexOf(atProject!.operation_id)).toBeGreaterThan(-1);
  expect(receipts.indexOf(atProject!.operation_id)).toBeLessThan(
    receipts.indexOf(secondDecision!.operation_id)
  );
});

it('holds one target adopted at both scope kinds, on two branches, and by two approvers', async () => {
  const { rows, manifest } = await readSyntheticFixture();
  const adoptions = rows.adoptions!;
  const byTarget = new Map<unknown, Row[]>();
  for (const row of adoptions) {
    byTarget.set(row.target_revision_id, [...(byTarget.get(row.target_revision_id) ?? []), row]);
  }

  expect(combinations(adoptions, 'target_kind', 'scope_kind')).toEqual([
    'claim:branch',
    'claim:project',
    'decision:branch',
    'decision:project',
    'relationship:branch',
    'relationship:project',
  ]);
  const atBothScopes = [...byTarget.values()].filter(
    (group) => new Set(group.map((row) => row.scope_kind)).size === 2
  );
  expect(atBothScopes.map((group) => group[0]!.target_kind).sort()).toEqual([
    'claim',
    'relationship',
  ]);
  const byTwoApprovers = [...byTarget.values()].filter(
    (group) =>
      new Set(group.filter((row) => row.scope_kind === 'project').map((row) => row.approver))
        .size === 2
  );
  expect(byTwoApprovers).toHaveLength(1);

  const onTwoBranches = [...byTarget.values()]
    .map((group) => group.filter((row) => row.scope_kind === 'branch'))
    .filter(
      (group) =>
        group.length === 2 &&
        group[0]!.approver === group[1]!.approver &&
        group[0]!.scope_value !== group[1]!.scope_value
    );
  expect(
    onTwoBranches.map((group) => ({
      target_kind: group[0]!.target_kind,
      target_revision_id: group[0]!.target_revision_id,
      approver: group[0]!.approver,
      branches: group.map((row) => row.scope_value),
    }))
  ).toEqual([
    {
      target_kind: 'claim',
      ...manifest.content.coverage.same_adoption_on_two_branches,
      branches: ['rate-limit', 'limit-docs'],
    },
  ]);

  const revisions = new Set(
    [...rows.claim_revisions!, ...rows.decision_revisions!].map((row) => row.revision_id)
  );
  const relationships = new Set(rows.record_relationships!.map((row) => row.relationship_id));
  for (const row of adoptions) {
    if (row.target_kind === 'relationship') {
      expect(row.target_revision_id).toBe(row.target_id);
      expect(relationships.has(row.target_id)).toBe(true);
    } else expect(revisions.has(row.target_revision_id)).toBe(true);
    expect(['rate-limit', 'limit-docs', null]).toContain(row.scope_value);
    expect(row.scope_value === null).toBe(row.scope_kind === 'project');
  }
});

it('inserts relationships and adoptions against their primary-key order', async () => {
  const { rows, manifest } = await readSyntheticFixture();

  for (const [table, column] of [
    ['record_relationships', 'relationship_id'],
    ['adoptions', 'adoption_id'],
  ] as const) {
    const inserted = rows[table]!.map((row) => row[column] as string);
    expect([...inserted].sort().reverse()).toEqual(inserted);
  }
  expect(manifest.content.coverage.tables_inserted_against_primary_key_order).toEqual([
    'record_relationships',
    'adoptions',
  ]);
});

it('gives every synthetic row the receipt of the writer that published it', async () => {
  const { rows, manifest } = await readSyntheticFixture();
  const kinds = new Map(rows.operations!.map((row) => [row.operation_id, row.operation_kind]));
  const expected: Record<string, string> = {
    criterion_lineage: 'criterion.lineage.publish',
    claim_revisions: 'claim.revision.publish',
    decision_revisions: 'decision.revision.publish',
    record_relationships: 'record.relationship.publish',
    adoptions: 'adoption.publish',
    assessments: 'assessment.publish',
  };

  for (const [table, kind] of Object.entries(expected)) {
    for (const row of rows[table]!)
      expect([table, kinds.get(row.operation_id)]).toEqual([table, kind]);
    expect(manifest.content.operations_by_kind[kind]).toBe(rows[table]!.length);
  }
  expect(manifest.content.operations_by_kind).toMatchObject({
    'source_plan.record': 2,
    'source_plan.locator': 1,
  });
});

it('restores under the released schema definition in insertion order, and this checkout refuses to open it and leaves it unchanged', async () => {
  const { rows, schema } = await readSyntheticFixture();
  const fixture = await restoreSyntheticFixture(
    new URL('../../../../../', import.meta.url).pathname
  );
  cleanups.push(fixture.cleanup);
  const before = snapshot(Database, fixture.file);
  expect(before.version).toBe(29);
  expect(before.definitions).toEqual(schema.definitions);
  expect(before.foreignKeys).toEqual([]);
  expect(before.rows).toEqual({
    ...rows,
    store_identity: [
      {
        ...rows.store_identity![0]!,
        resolved_root: fixture.authority.resolvedRoot,
        root_key: fixture.authority.rootKey,
      },
    ],
  });
  expect(databaseDigest({ ...before.rows, store_identity: rows.store_identity! })).toBe(
    FROZEN_COMPOSED_SHA256
  );

  // A passive open never upgrades. It names the released predecessor as one an explicit upgrade
  // carries across, and says which command performs it.
  expect(PROJECT_DATABASE_SCHEMA_VERSION).toBeGreaterThan(29);
  const bytes = await readFile(fixture.file);
  for (const mode of ['reader', 'writer'] as const) {
    await expect(openProjectDatabase({ authority: fixture.authority, mode })).rejects.toMatchObject(
      {
        code: 'HISTORY_UPGRADE_REQUIRED',
        message: expect.stringContaining('orcaops history upgrade'),
      }
    );
  }
  expect(snapshot(Database, fixture.file)).toEqual(before);
  expect(await readFile(fixture.file)).toEqual(bytes);
}, 30_000);
