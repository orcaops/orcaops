// Writes the synthetic schema-29 fixture: exact-revision and source-plan rows published through
// this checkout's storage writers on top of the restored released 0.2.1 fixture.
//
// No released build can write the exact-revision rows, and a later schema change rebuilds two
// of their tables, so this image has to be frozen before that change by writers that are
// byte-identical to the release. The run refuses when they are not, and never overwrites a
// frozen fixture:
//
//   pnpm --filter @orcaops/storage exec vitest run \
//     --config tests/synthetic-schema-29-fixture.config.ts
//
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { type RestoredFixture, snapshot } from './database-fixture.mjs';
import {
  blobBytes,
  countBy,
  databaseDigest,
  readReleasedFixture,
  restoreReleasedFixture,
  schemaDigests,
  tableDigest,
} from './released-fixture.mjs';
import { SYNTHETIC_BASE_RELEASE, SYNTHETIC_FIXTURE_DIRECTORY } from './synthetic-fixture.mjs';
import { openProjectDatabase, type ProjectDatabase } from '../src/history/database/connection.js';
import {
  publishProjectAdoption,
  publishProjectAssessment,
  publishProjectClaimRevision,
  publishProjectCriterionLineage,
  publishProjectDecisionRevision,
  publishProjectRecordRelationship,
} from '../src/history/database/exact-revision-records.js';
import {
  publishProjectSourcePlanLocator,
  publishProjectSourcePlanRecord,
} from '../src/history/database/source-plan-publication.js';
import { digest } from '../src/history/event-integrity.js';
import { uuidv7 } from '../src/ids/uuidv7.js';

type Rows = Record<string, Array<Record<string, unknown>>>;

const candidate = fileURLToPath(new URL('../../../', import.meta.url));
const DATABASE_DIRECTORY = 'packages/storage/src/history/database';
const RELEASE_TAGS = ['shipped/0.2.0', 'shipped/0.2.1'];
const EXACT_REVISION_WRITERS = [
  ['publishProjectCriterionLineage', ['criterion_lineage']],
  ['publishProjectClaimRevision', ['claims', 'claim_revisions']],
  ['publishProjectDecisionRevision', ['decisions', 'decision_revisions']],
  ['publishProjectRecordRelationship', ['record_relationships']],
  ['publishProjectAdoption', ['adoptions']],
  ['publishProjectAssessment', ['assessments']],
] as const;
const SOURCE_PLAN_WRITERS = [
  [
    'publishProjectSourcePlanRecord',
    [
      'source_plan_namespaces',
      'source_plan_records',
      'source_plan_approved',
      'source_plan_review_current',
    ],
  ],
  [
    'publishProjectSourcePlanLocator',
    ['source_plan_locator_revisions', 'source_plan_locator_current'],
  ],
] as const;

const cleanups: Array<() => Promise<void>> = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: candidate, encoding: 'utf8' }).trim();
const isWriterSource = (file: string) =>
  file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.includes('/fixtures/');

const WRITER_ENTRY_POINTS = [
  `${DATABASE_DIRECTORY}/exact-revision-records.ts`,
  `${DATABASE_DIRECTORY}/source-plan-publication.ts`,
  `${DATABASE_DIRECTORY}/connection.ts`,
];
// A file the writers can reach that differs from a release needs a person to say whether the
// difference can change what the writers produce. A differing file with no entry here stops
// the run.
const CLOSURE_DIFFERENCES: Record<string, string> = {
  'packages/storage/src/artifacts/errors.ts':
    'Cannot affect the rows: HEAD adds one error class for plan capture. The closure reaches this file only through the event rebuilders, for RecoveryRefusedError, which is unchanged.',
  'packages/evaluator-protocol/src/context-block.ts':
    'Cannot affect the rows: HEAD rewords headings that buildContextBlock renders into evaluator prompts. The closure reaches it only through the package index; no storage writer calls it or stores what it renders.',
};

// Every source file the writers can load, followed through relative imports and through
// workspace packages by their export maps. Packages outside the workspace are listed by name.
function writerImportClosure() {
  const workspace = new Map<string, string>();
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(path.join(candidate, group))) {
      const manifest = path.join(candidate, group, name, 'package.json');
      if (existsSync(manifest)) {
        workspace.set(JSON.parse(readFileSync(manifest, 'utf8')).name, path.join(group, name));
      }
    }
  }
  const source = (file: string) =>
    [
      file.replace(/\.js$/, '.ts'),
      file.replace(/\.js$/, '.tsx'),
      path.join(file.replace(/\.js$/, ''), 'index.ts'),
    ].find((option) => existsSync(path.join(candidate, option)));
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [...WRITER_ENTRY_POINTS];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(path.join(candidate, file), 'utf8');
    // A statement cannot hold a semicolon before its `from`, which keeps the match from
    // running out of one declaration and into a quoted phrase further down the file.
    const specifiers = [
      ...text.matchAll(/^(?:import|export)\s[^;'"]*?\bfrom\s+['"]([^'"]+)['"]/gm),
      ...text.matchAll(/^import\s+['"]([^'"]+)['"]/gm),
    ];
    for (const [, specifier] of specifiers) {
      if (specifier!.startsWith('.')) {
        const target = source(path.join(path.dirname(file), specifier!));
        expect(target, `${specifier} from ${file}`).toBeDefined();
        queue.push(target!);
        continue;
      }
      const name = specifier!.startsWith('@')
        ? specifier!.split('/').slice(0, 2).join('/')
        : specifier!.split('/')[0]!;
      const directory = workspace.get(name);
      if (!directory) {
        if (!name.startsWith('node:')) external.add(name);
        continue;
      }
      const manifest = JSON.parse(
        readFileSync(path.join(candidate, directory, 'package.json'), 'utf8')
      );
      const entry = manifest.exports[`.${specifier!.slice(name.length)}`];
      const built = typeof entry === 'string' ? entry : entry.default;
      const target = source(path.join(directory, built.replace(/^\.\/dist\//, 'src/')));
      expect(target, specifier).toBeDefined();
      queue.push(target!);
    }
  }
  const closure = [...files].sort();
  const differing = [
    ...new Set(
      RELEASE_TAGS.flatMap((tag) =>
        git('diff', '--name-only', tag, 'HEAD', '--', ...closure)
          .split('\n')
          .filter((file) => file.length > 0)
      )
    ),
  ].sort();
  const uncommitted = git('diff', '--name-only', 'HEAD', '--', ...closure)
    .split('\n')
    .filter((file) => file.length > 0);
  expect(uncommitted, 'a file the writers load differs from HEAD').toEqual([]);
  expect(differing.filter((file) => CLOSURE_DIFFERENCES[file] === undefined)).toEqual([]);
  expect(differing.filter((file) => file.startsWith(`${DATABASE_DIRECTORY}/`))).toEqual([]);
  return {
    entry_points: WRITER_ENTRY_POINTS,
    files: closure.length,
    packages: [...new Set(closure.map((file) => file.split('/').slice(0, 2).join('/')))],
    packages_outside_the_workspace: [...external].sort(),
    files_that_differ_from_a_release: differing.map((file) => ({
      file,
      differs_from: RELEASE_TAGS.filter(
        (tag) => git('diff', '--name-only', tag, 'HEAD', '--', file).length > 0
      ),
      effect_on_the_writers: CLOSURE_DIFFERENCES[file],
    })),
  };
}

function storageCodeIdentity() {
  const listing = (ref: string) =>
    git('ls-tree', '-r', ref, '--', DATABASE_DIRECTORY)
      .split('\n')
      .map((line) => line.split(/\s+/))
      .filter(([, , , file]) => isWriterSource(file!))
      .map(([, , blob, file]) => `${blob} ${file}`);
  const head = listing('HEAD');
  const uncommitted = [
    ...git('diff', '--name-only', 'HEAD', '--', DATABASE_DIRECTORY).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard', '--', DATABASE_DIRECTORY).split('\n'),
  ].filter((file) => file.length > 0 && isWriterSource(file));
  expect(uncommitted, 'the writers differ from HEAD').toEqual([]);

  const releases = RELEASE_TAGS.map((tag) => {
    const differing = git('diff', '--name-only', tag, 'HEAD', '--', DATABASE_DIRECTORY)
      .split('\n')
      .filter((file) => file.length > 0 && isWriterSource(file));
    expect(differing, `${tag} differs from HEAD`).toEqual([]);
    expect(listing(tag)).toEqual(head);
    return { tag, commit: git('rev-parse', `${tag}^{commit}`), differing_files: differing };
  });
  return {
    directory: DATABASE_DIRECTORY,
    compared: 'every .ts file except *.test.ts and fixtures/',
    files: head.length,
    blob_listing_sha256: sha256(head.join('\n')),
    head_commit: git('rev-parse', 'HEAD'),
    working_tree_matches_head: true,
    releases,
    writer_import_closure: writerImportClosure(),
  };
}

interface RetainedEvent<Payload> {
  artifactId: string;
  eventId: string;
  generation: number;
  payload: Payload;
}
interface PlanPayload {
  plan_steps: Array<{
    step_id: string;
    label: string;
    acceptance_criteria: Array<{ criterion_id: string; text: string }>;
  }>;
}
interface ClosePayload {
  verification: unknown[];
}

function retainedEvents<Payload>(
  rows: Rows,
  artifactId: string,
  type: string
): Array<RetainedEvent<Payload>> {
  const generations = rows
    .artifact_revisions!.filter((row) => row.artifact_id === artifactId)
    .sort((a, b) => (a.generation as number) - (b.generation as number));
  return rows
    .artifact_events!.filter((row) => row.artifact_id === artifactId && row.event_type === type)
    .map((row) => ({
      artifactId,
      eventId: row.event_id as string,
      generation: generations.find(
        (revision) => (revision.event_count as number) >= (row.ordinal as number)
      )!.generation as number,
      payload: JSON.parse(blobBytes(row.record_bytes).toString('utf8')).payload,
    }));
}

const counters = (handle: ProjectDatabase) => handle.read(() => null).counters;

// Identifiers minted together and handed out largest first, so rows inserted later carry
// smaller ids. A rebuild that reorders rows by primary key then shows up against rowid order.
function descendingIds(count: number): string[] {
  return Array.from({ length: count }, () => uuidv7())
    .sort()
    .reverse();
}

function sqliteVersion(): string {
  const database = new Database(':memory:');
  try {
    const row = database.prepare('SELECT sqlite_version() AS version').get();
    return (row as { version: string }).version;
  } finally {
    database.close();
  }
}

async function publishCriterionLineage(handle: ProjectDatabase, rows: Rows, artifactId: string) {
  const [captured] = retainedEvents<PlanPayload>(rows, artifactId, 'plan_captured');
  const [revised] = retainedEvents<PlanPayload>(rows, artifactId, 'plan_revised');
  const stepIndex = (event: RetainedEvent<PlanPayload>) =>
    event.payload.plan_steps.findIndex((step) => step.label === 'Limit-exceeded tests');
  const publish = (
    event: RetainedEvent<PlanPayload>,
    step: number,
    position: number,
    lineage: 'added' | 'carried' | 'rewritten',
    scope: Parameters<typeof publishProjectCriterionLineage>[1]['scope']
  ) => {
    const planStep = event.payload.plan_steps[step]!;
    const criterion = planStep.acceptance_criteria[position]!;
    return publishProjectCriterionLineage(handle, {
      operationId: uuidv7(),
      occurrence: {
        sourceEventId: event.eventId,
        fieldPath: `plan_steps[${step}].acceptance_criteria[${position}]`,
        position,
      },
      criterionId: criterion.criterion_id,
      stepId: planStep.step_id,
      artifactId,
      artifactGeneration: event.generation,
      lineage,
      priorCriterionId: lineage === 'added' ? null : criterion.criterion_id,
      scope,
      record: criterion,
    });
  };
  const artifactScope = { kind: 'artifact', artifactId } as const;
  await publish(captured!, stepIndex(captured!), 0, 'added', artifactScope);
  await publish(captured!, stepIndex(captured!), 1, 'added', artifactScope);
  await publish(revised!, stepIndex(revised!), 0, 'carried', {
    kind: 'branch',
    branch: 'rate-limit',
  });
  await publish(revised!, stepIndex(revised!), 1, 'rewritten', { kind: 'project' });
  const addedStep = revised!.payload.plan_steps.findIndex(
    (step) => step.label === 'Remaining-quota header'
  );
  await publish(revised!, addedStep, 0, 'added', artifactScope);
}

async function publishRecords(handle: ProjectDatabase, rows: Rows, artifactId: string) {
  const [captured] = retainedEvents<PlanPayload>(rows, artifactId, 'plan_captured');
  const [firstClose, laterClose] = retainedEvents<ClosePayload>(
    rows,
    artifactId,
    'checkpoint_closed'
  );
  const author = 'claude-code';
  // Each second revision takes the smaller id of its pair, so it sorts before its predecessor.
  const [firstClaim, secondClaim] = descendingIds(2) as [string, string];
  const [firstDecision, secondDecision] = descendingIds(2) as [string, string];
  const relationshipIds = descendingIds(8);
  const adoptionIds = descendingIds(10);
  const claimId = uuidv7();
  const decisionId = uuidv7();
  const otherClaimId = uuidv7();
  const otherClaim = uuidv7();
  const otherDecisionId = uuidv7();
  const otherDecision = uuidv7();

  const claim = (
    id: string,
    revisionId: string,
    previousRevisionId: string | null,
    event: RetainedEvent<ClosePayload>,
    position: number,
    verification: unknown,
    text: string
  ) =>
    publishProjectClaimRevision(handle, {
      operationId: uuidv7(),
      claimId: id,
      revisionId,
      previousRevisionId,
      occurrence: { sourceEventId: event.eventId, fieldPath: 'summary', position },
      assertedBy: author,
      assertionSource: { event_id: event.eventId, field: 'summary' },
      agentReportedVerification: verification,
      record: { synthetic: true, claim: `Synthetic claim: ${text}` },
    });
  const decision = (
    id: string,
    revisionId: string,
    previousRevisionId: string | null,
    occurrence: { sourceEventId: string; fieldPath: string; position: number },
    text: string,
    reason: string,
    alternatives: string[]
  ) =>
    publishProjectDecisionRevision(handle, {
      operationId: uuidv7(),
      decisionId: id,
      revisionId,
      previousRevisionId,
      occurrence,
      authoredBy: author,
      alternativeCount: alternatives.length,
      record: {
        synthetic: true,
        decision: `Synthetic decision: ${text}`,
        reason,
        alternatives: alternatives.map((option) => ({
          option: `Synthetic alternative: ${option}`,
          rejected_because: 'invented for the fixture',
        })),
      },
    });
  const relationship = async (
    relation: 'supersedes' | 'challenges',
    from: Parameters<typeof publishProjectRecordRelationship>[1]['from'],
    to: Parameters<typeof publishProjectRecordRelationship>[1]['to'],
    scope: Parameters<typeof publishProjectRecordRelationship>[1]['scope'],
    attributed: 'author' | 'detector'
  ) => {
    const relationshipId = relationshipIds.shift()!;
    await publishProjectRecordRelationship(handle, {
      operationId: uuidv7(),
      relationshipId,
      relation,
      from,
      to,
      scope,
      attribution: {
        kind: attributed,
        id: attributed === 'author' ? author : 'synthetic-detector',
      },
      sourceRefs: [`synthetic source: ${relation} recorded for the fixture`],
    });
    return relationshipId;
  };
  const adopt = (
    target: Parameters<typeof publishProjectAdoption>[1]['target'],
    scope: Parameters<typeof publishProjectAdoption>[1]['scope'],
    approver = 'synthetic-owner'
  ) =>
    publishProjectAdoption(handle, {
      operationId: uuidv7(),
      adoptionId: adoptionIds.shift()!,
      target,
      approver,
      approvedAt: '2026-09-17T12:00:00.000Z',
      scope,
      sourceRefs: ['synthetic approval recorded for the fixture'],
    });
  const project = { kind: 'project' } as const;
  const branch = { kind: 'branch', branch: 'rate-limit' } as const;
  const otherBranch = { kind: 'branch', branch: 'limit-docs' } as const;
  const claimAt = (revisionId: string) =>
    ({ kind: 'claim', entityId: claimId, revisionId }) as const;
  const decisionAt = (revisionId: string) =>
    ({ kind: 'decision', entityId: decisionId, revisionId }) as const;

  await claim(
    claimId,
    firstClaim,
    null,
    firstClose!,
    0,
    firstClose!.payload.verification[0],
    'the limiter rejects the eleventh request in one window'
  );
  const earlyAssessment = counters(handle);
  await decision(
    decisionId,
    firstDecision,
    null,
    { sourceEventId: captured!.eventId, fieldPath: 'decisions', position: 0 },
    'count requests in a sliding window',
    'The synthetic claim says the eleventh request in one window is rejected',
    ['a fixed window']
  );

  // Published while each record has one revision, so these edges keep naming the first
  // decision revision after the second one exists. The three differ only in scope: by kind,
  // and between the two branches by value alone. A rebuilt unique rule that dropped either
  // the scope kind or the scope value would refuse one of them.
  const olderEdge = await relationship(
    'challenges',
    claimAt(firstClaim),
    decisionAt(firstDecision),
    project,
    'author'
  );
  const olderEdgeOnBranch = await relationship(
    'challenges',
    claimAt(firstClaim),
    decisionAt(firstDecision),
    branch,
    'author'
  );
  const olderEdgeOnOtherBranch = await relationship(
    'challenges',
    claimAt(firstClaim),
    decisionAt(firstDecision),
    otherBranch,
    'author'
  );
  await publishProjectAssessment(handle, {
    operationId: uuidv7(),
    assessmentId: uuidv7(),
    claimId,
    claimRevisionId: firstClaim,
    assessedBy: author,
    observed: earlyAssessment,
    verification: firstClose!.payload.verification[0],
    record: { synthetic: true, assessment: 'Synthetic assessment: the first claim revision held' },
  });

  await claim(
    claimId,
    secondClaim,
    firstClaim,
    laterClose!,
    0,
    null,
    'the limiter rejects the eleventh request until the window resets'
  );
  await decision(
    decisionId,
    secondDecision,
    firstDecision,
    { sourceEventId: firstClose!.eventId, fieldPath: 'decisions', position: 0 },
    'count requests in a sliding window kept per route',
    'The revised synthetic claim ties rejection to the window reset',
    ['a fixed window', 'one shared window']
  );
  await claim(
    otherClaimId,
    otherClaim,
    null,
    laterClose!,
    1,
    null,
    'a shared window would let one route starve another'
  );
  await decision(
    otherDecisionId,
    otherDecision,
    null,
    { sourceEventId: laterClose!.eventId, fieldPath: 'decisions', position: 0 },
    'keep one window per route and drop the shared counter',
    'The second synthetic claim says a shared window starves routes',
    []
  );

  const branchEdge = await relationship(
    'supersedes',
    decisionAt(secondDecision),
    decisionAt(firstDecision),
    branch,
    'author'
  );
  await relationship('supersedes', claimAt(secondClaim), claimAt(firstClaim), project, 'detector');
  await relationship(
    'challenges',
    claimAt(secondClaim),
    decisionAt(secondDecision),
    otherBranch,
    'detector'
  );
  const other = { kind: 'decision', entityId: otherDecisionId, revisionId: otherDecision } as const;
  await relationship('supersedes', other, decisionAt(secondDecision), project, 'author');
  await relationship(
    'challenges',
    other,
    { kind: 'claim', entityId: otherClaimId, revisionId: otherClaim },
    branch,
    'detector'
  );

  await adopt(claimAt(secondClaim), project);
  await adopt(claimAt(secondClaim), branch);
  await adopt(claimAt(secondClaim), otherBranch);
  await adopt(claimAt(secondClaim), project, 'synthetic-reviewer');
  await adopt(claimAt(firstClaim), branch);
  await adopt(decisionAt(secondDecision), project);
  await adopt(decisionAt(firstDecision), branch);
  await adopt({ kind: 'relationship', relationshipId: olderEdge }, project);
  await adopt({ kind: 'relationship', relationshipId: olderEdge }, branch);
  await adopt({ kind: 'relationship', relationshipId: branchEdge }, branch);

  await publishProjectAssessment(handle, {
    operationId: uuidv7(),
    assessmentId: uuidv7(),
    claimId,
    claimRevisionId: secondClaim,
    assessedBy: author,
    observed: counters(handle),
    verification: laterClose!.payload.verification[0],
    record: {
      synthetic: true,
      assessment: 'Synthetic assessment: the second claim revision is not yet shown',
    },
  });
  return {
    olderEdge,
    olderEdgeOnBranch,
    olderEdgeOnOtherBranch,
    adoptedOnTwoBranches: secondClaim,
    firstDecision,
    secondDecision,
  };
}

async function publishSourcePlan(handle: ProjectDatabase) {
  const namespace = {
    namespaceId: uuidv7(),
    scopeKind: 'account',
    serverUrl: 'https://cloud.example.invalid',
    orgId: 'synthetic-organization',
    accountId: 'synthetic-account',
    originalNamespaceHash: null,
    originalLocatorHash: null,
  } as const;
  const body = '# Synthetic approved plan\n\nRate limit the charge route.\n';
  const common = {
    schema_version: 1,
    external_id: 'synthetic-rate-limit-plan',
    body,
    content_hash: digest(body),
    base_url: namespace.serverUrl,
    org_id: namespace.orgId,
    pulled_at: '2026-09-17T12:00:00.000Z',
  };
  const approvedRecordId = uuidv7();
  await publishProjectSourcePlanRecord(
    handle,
    {
      operationId: uuidv7(),
      recordId: approvedRecordId,
      namespace,
      kind: 'approved',
      expectedSelection: null,
      recordBytes: Buffer.from(
        JSON.stringify(
          {
            ...common,
            slug: 'synthetic-rate-limit-plan',
            version_number: 1,
            title: 'Synthetic rate limit plan',
            source_ref: null,
          },
          null,
          2
        )
      ),
    },
    { secretAllow: [] }
  );
  await publishProjectSourcePlanRecord(
    handle,
    {
      operationId: uuidv7(),
      recordId: uuidv7(),
      namespace,
      kind: 'candidate',
      expectedSelection: null,
      recordBytes: Buffer.from(
        JSON.stringify(
          {
            ...common,
            target: 'candidate',
            version_id: 'synthetic-version-2',
            version_number: 2,
            proposal_id: null,
            base_version_number: null,
          },
          null,
          2
        )
      ),
    },
    { secretAllow: [] }
  );
  const realPath = '/synthetic/plans/rate-limit-plan.md';
  await publishProjectSourcePlanLocator(
    handle,
    {
      operationId: uuidv7(),
      revisionId: uuidv7(),
      namespace,
      kind: 'path',
      realPath,
      approvedRecordId,
      expectedSelection: null,
      recordBytes: Buffer.from(
        JSON.stringify(
          { real_path: realPath, external_id: common.external_id, version_number: 1 },
          null,
          2
        )
      ),
    },
    { secretAllow: [] }
  );
}

it('freezes synthetic exact-revision and source-plan rows on the released 0.2.1 database', async () => {
  expect(existsSync(SYNTHETIC_FIXTURE_DIRECTORY), 'a frozen fixture is never regenerated').toBe(
    false
  );
  const storageCode = storageCodeIdentity();
  const base = await readReleasedFixture(SYNTHETIC_BASE_RELEASE);
  const fixture: RestoredFixture = await restoreReleasedFixture(candidate, SYNTHETIC_BASE_RELEASE);
  cleanups.push(fixture.cleanup);
  const handle = await openProjectDatabase({ authority: fixture.authority, mode: 'writer' });
  handles.push(handle);

  const artifactId = base.database.rows.artifact_metadata!.find(
    (row) => row.branch === 'rate-limit' && row.origin_kind === 'captured'
  )!.artifact_id as string;
  await publishCriterionLineage(handle, base.database.rows, artifactId);
  const {
    olderEdge,
    olderEdgeOnBranch,
    olderEdgeOnOtherBranch,
    adoptedOnTwoBranches,
    firstDecision,
    secondDecision,
  } = await publishRecords(handle, base.database.rows, artifactId);
  await publishSourcePlan(handle);
  handles.splice(0).forEach((open) => open.close());

  const written = snapshot(Database, fixture.file);
  expect(written.foreignKeys).toEqual([]);
  expect(written.definitions).toEqual(base.schema.definitions);
  // Restoring gives the store a new temporary root. These two cells go back to what the
  // release wrote, so every table the writers left alone equals the released fixture.
  const identity = written.rows.store_identity![0]!;
  identity.resolved_root = base.database.rows.store_identity![0]!.resolved_root;
  identity.root_key = base.database.rows.store_identity![0]!.root_key;

  const changed = Object.keys(written.rows).filter(
    (table) => JSON.stringify(written.rows[table]) !== JSON.stringify(base.database.rows[table])
  );
  const expectedChanges = [
    'operations',
    'project_counters',
    ...EXACT_REVISION_WRITERS.flatMap(([, tables]) => tables),
    ...SOURCE_PLAN_WRITERS.flatMap(([, tables]) => tables),
  ];
  expect([...changed].sort()).toEqual([...expectedChanges].sort());
  const releasedReceipts = base.database.rows.operations!;
  expect(written.rows.operations!.slice(0, releasedReceipts.length)).toEqual(releasedReceipts);

  const rows: Rows = Object.fromEntries(changed.map((table) => [table, written.rows[table]!]));
  const composed = { ...base.database.rows, ...rows };
  const key = (row: Record<string, unknown>, ...columns: string[]) => ({
    key: columns.map((column) => row[column] ?? 'none').join(':'),
  });
  const manifest = {
    fixture:
      'SYNTHETIC exact-revision and source-plan rows on top of the database the published @orcaops/cli 0.2.1 wrote',
    synthetic: true,
    statement:
      'No released build can write the exact-revision rows here. A released build writes source-plan rows only after it pulls from the cloud service; the same storage writers wrote these without it. Claim, decision, assessment and source-plan texts are invented and marked synthetic. The criterion lineage records are not invented: each restates a criterion the released plan events hold, byte for byte, under a lineage kind and a scope chosen for this fixture. Nothing here is released history.',
    writers: {
      commit: storageCode.head_commit,
      exact_revision: EXACT_REVISION_WRITERS.map(([name, tables]) => ({
        function: name,
        module: `${DATABASE_DIRECTORY}/exact-revision-records.ts`,
        tables,
      })),
      source_plan: SOURCE_PLAN_WRITERS.map(([name, tables]) => ({
        function: name,
        module: `${DATABASE_DIRECTORY}/source-plan-publication.ts`,
        tables,
      })),
    },
    storage_code_identity: storageCode,
    base: {
      released_fixture: `../released/cli-${SYNTHETIC_BASE_RELEASE}`,
      released_content_sha256: base.manifest.content.sha256,
      tables_the_writers_changed: changed,
      unchanged_tables: Object.keys(written.rows).length - changed.length,
      released_receipts_kept_as_prefix: releasedReceipts.length,
      identity_cells_restored: ['store_identity.resolved_root', 'store_identity.root_key'],
    },
    generation: {
      command:
        'pnpm --filter @orcaops/storage exec vitest run --config tests/synthetic-schema-29-fixture.config.ts',
      procedure_sha256: sha256(await readFile(fileURLToPath(import.meta.url))),
      node: process.version,
      sqlite_driver: {
        package: 'better-sqlite3',
        version: JSON.parse(
          await readFile(
            path.join(candidate, 'packages/storage/node_modules/better-sqlite3/package.json'),
            'utf8'
          )
        ).version,
        sqlite_version: sqliteVersion(),
      },
    },
    schema: {
      user_version: written.version,
      file: '../released/schema.json',
      ...schemaDigests(written.definitions),
    },
    content: {
      composed_sha256: databaseDigest(composed),
      tables: Object.fromEntries(
        Object.entries(rows).map(([table, records]) => [
          table,
          { rows: records.length, sha256: tableDigest(records) },
        ])
      ),
      operations_by_kind: countBy(rows.operations!, 'operation_kind'),
      coverage: {
        criterion_lineage_by_kind_and_scope: countBy(
          rows.criterion_lineage!.map((row) => key(row, 'lineage', 'scope_kind')),
          'key'
        ),
        claim_revisions_with_and_without_verification: countBy(
          rows.claim_revisions!.map((row) => ({
            key: row.verification_json === null ? 'without' : 'with',
          })),
          'key'
        ),
        decision_revisions: rows.decision_revisions!.length,
        relationships_by_relation_and_scope: countBy(
          rows.record_relationships!.map((row) => key(row, 'relation', 'scope_kind')),
          'key'
        ),
        relationship_still_naming_a_first_revision: {
          relationship_id: olderEdge,
          to_revision_id: firstDecision,
          later_revision_id: secondDecision,
        },
        same_relationship_at_two_scopes: [olderEdge, olderEdgeOnBranch],
        same_relationship_on_two_branches: [olderEdgeOnBranch, olderEdgeOnOtherBranch],
        same_adoption_on_two_branches: {
          target_revision_id: adoptedOnTwoBranches,
          approver: 'synthetic-owner',
          branches: rows
            .adoptions!.filter(
              (row) =>
                row.target_revision_id === adoptedOnTwoBranches &&
                row.approver === 'synthetic-owner' &&
                row.scope_kind === 'branch'
            )
            .map((row) => row.scope_value),
        },
        relationships_by_endpoint_kinds: countBy(
          rows.record_relationships!.map((row) =>
            key(row, 'relation', 'from_entity_kind', 'to_entity_kind')
          ),
          'key'
        ),
        relationships_joining_two_records: rows.record_relationships!.filter(
          (row) => row.from_entity_id !== row.to_entity_id
        ).length,
        adoptions_by_approver: countBy(rows.adoptions!, 'approver'),
        revisions_whose_id_sorts_before_their_predecessor: [
          ...rows.claim_revisions!,
          ...rows.decision_revisions!,
        ]
          .filter(
            (row) =>
              row.previous_revision_id !== null &&
              (row.revision_id as string) < (row.previous_revision_id as string)
          )
          .map((row) => row.revision_id),
        tables_inserted_against_primary_key_order: ['record_relationships', 'adoptions'].filter(
          (table) => {
            const column = table === 'adoptions' ? 'adoption_id' : 'relationship_id';
            const inserted = rows[table]!.map((row) => row[column] as string);
            return JSON.stringify(inserted) !== JSON.stringify([...inserted].sort());
          }
        ),
        adoptions_by_target_and_scope: countBy(
          rows.adoptions!.map((row) => key(row, 'target_kind', 'scope_kind')),
          'key'
        ),
        assessment_observed_counters: rows.assessments!.map((row) => ({
          write_sequence: row.observed_write_sequence,
          intent_change_counter: row.observed_intent_counter,
        })),
      },
    },
    covers: [
      'A criterion lineage chain: added, carried and rewritten, at artifact, branch and project scope.',
      'Two claims and two decisions; one of each has two revisions, and each second revision id sorts before its predecessor.',
      'Both relations, at project scope and on two branches, across claim-to-decision, decision-to-claim, claim-to-claim and decision-to-decision endpoints, attributed to an author and to a detector.',
      'One relationship tuple three times, differing only in scope: at project scope and on two branches. The two branch rows differ in scope value alone.',
      'An older edge that still names a first revision after a second exists, and a supersedes edge that joins two different decisions.',
      'Adoptions of a claim, a decision and a relationship at project and at branch scope; one target adopted at both scope kinds, one target and approver adopted on two branches, and one target adopted by two approvers.',
      'Relationships and adoptions inserted against their primary-key order.',
      'Two assessments stamped with the counters observed when their input was read.',
      'One approved source plan, one candidate and one path locator in one namespace.',
    ],
    not_covered: [
      'No source_plan_upload_commands rows: an upload is a remote operation with transport rows of its own.',
      'No proposal record and no upload locator: one approved record, one candidate and one path locator only.',
      'No artifact-scoped relationship or adoption: schema 29 admits only project and branch scope there.',
      'No rows for review_comment_claim_links, source_time_*, execution_checkpoint_recoveries or seed_bundle_authoring. No released build can write them either, but no planned schema change rebuilds them, so there is no transformation to prove on populated rows. A change that rebuilds one of them has to add its own rows here first.',
      'Everything else the released 0.2.1 fixture does not cover stays uncovered here.',
    ],
  };

  await mkdir(SYNTHETIC_FIXTURE_DIRECTORY, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFile(path.join(SYNTHETIC_FIXTURE_DIRECTORY, name), `${JSON.stringify(value, null, 2)}\n`);
  await write('database.json', {
    schemaVersion: written.version,
    base: `released/cli-${SYNTHETIC_BASE_RELEASE}`,
    rows,
  });
  await write('manifest.json', manifest);
}, 120_000);
