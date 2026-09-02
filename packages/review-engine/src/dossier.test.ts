import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildReviewFloorFixture,
  CITATION_KIND,
  type Floor,
  formatCitationId,
} from '@orcaops/review-core';
import { ArtifactLock } from '@orcaops/storage';

import { buildClaimLedger, CLAIM_LEDGER_ENTRY_KIND } from './claimLedger.js';
import {
  ACCOUNT_CORPUS_CEILING_BYTES,
  AccountCorpusCeilingError,
  accountProjectionSchema,
  buildDossier,
  type BuildDossierInput,
  DOSSIER_BUDGET_V1,
  dossierV1Schema,
  estimatorV1,
  ExcludePolicyError,
  FORENSIC_SCHEMA_VERSION,
  forensicInputSchema,
  ForensicTransportCeilingError,
  invalidStubPatterns,
  parseAccountProjectionJson,
  parseDossierV1Json,
  parseFileSections,
  parseForensicInputJson,
  PROTECTED_ACCOUNT_FIELDS,
  StubPolicyError,
} from './dossier.js';
import { buildAndWriteDossier, runDossier } from './dossierCli.js';
import { FLOOR_PRODUCER_VERSION } from './floor.js';
import { REVIEW_STATE_VERSION, reviewStateLockKey } from './reviewState.js';
import type { ReviewArgs } from './run.js';
import { renderAccountRoutineMd } from './twolaneRunCli.js';
import { accountCitableIds } from './twolaneSlice.js';
import { accountPromptAliasMaps, promptCitationAlias } from '../tests/support/accountAlias.js';

const AT = '2026-07-17T00:00:00.000Z';

/**
 * Synthetic diff exercising: structural fan-out (`sharedIdent` across 3
 * files), lexical hints (guard/default/persistence), a generated lockfile,
 * a MODIFIED capture artifact, a DELETED capture artifact, a
 * binary file, and a rename-only section.
 */
const DIFF = [
  'diff --git a/src/alpha.ts b/src/alpha.ts',
  '--- a/src/alpha.ts',
  '+++ b/src/alpha.ts',
  '@@ -10,4 +10,5 @@',
  ' context line one',
  '-const sharedIdent = compute(1);',
  '+const sharedIdent = compute(2);',
  '+if (sharedIdent > threshold) { flag(); }',
  ' context line two',
  'diff --git a/src/beta.ts b/src/beta.ts',
  '--- a/src/beta.ts',
  '+++ b/src/beta.ts',
  '@@ -5,3 +5,3 @@',
  ' beta context',
  '-export const limit = 2000;',
  '+export const limit = sharedIdent;',
  ' beta tail',
  'diff --git a/src/gamma.ts b/src/gamma.ts',
  '--- a/src/gamma.ts',
  '+++ b/src/gamma.ts',
  '@@ -1,2 +1,3 @@',
  ' gamma context',
  '+log(sharedIdent);',
  ' gamma tail',
  'diff --git a/db/migrations/001-init.sql b/db/migrations/001-init.sql',
  '--- a/db/migrations/001-init.sql',
  '+++ b/db/migrations/001-init.sql',
  '@@ -1,1 +1,2 @@',
  ' create table t (id int);',
  '+alter table t add column v int;',
  'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
  '--- a/pnpm-lock.yaml',
  '+++ b/pnpm-lock.yaml',
  '@@ -1,1 +1,2 @@',
  ' lockfileVersion: 9',
  '+something: else',
  'diff --git a/.orcaops/config.json b/.orcaops/config.json',
  '--- a/.orcaops/config.json',
  '+++ b/.orcaops/config.json',
  '@@ -1,1 +1,2 @@',
  ' {}',
  '+{"captured": "decision text lives here"}',
  'diff --git a/.orcaops/secret-notes.json b/.orcaops/secret-notes.json',
  'deleted file mode 100644',
  '--- a/.orcaops/secret-notes.json',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-{"secretDecision": "we chose the risky path"}',
  '-{"more": "captured uncertainty text"}',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 1111111..2222222 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git a/src/old-name.ts b/src/new-name.ts',
  'similarity index 100%',
  'rename from src/old-name.ts',
  'rename to src/new-name.ts',
  '',
].join('\n');

function fixtureFloor(): Floor {
  return buildReviewFloorFixture('clean').floor;
}

function makeInput(overrides: Partial<BuildDossierInput> = {}): BuildDossierInput {
  const floor = overrides.floor ?? fixtureFloor();
  const ledgerEntries =
    overrides.ledgerEntries ??
    buildClaimLedger({ floor, checkpoints: [], generatedAt: AT }).entries;
  return {
    floor,
    retainedDiff: DIFF,
    ledgerEntries,
    branch: 'feature/two-lane-test-branch',
    baseSha: 'basesha1234',
    generatedAt: AT,
    ...overrides,
  };
}

describe('dossier — current persisted payload schemas', () => {
  it('round-trips every current producer payload through its strict schema', () => {
    const built = buildDossier(makeInput());
    expect(dossierV1Schema.parse(built.dossier)).toEqual(built.dossier);
    expect(accountProjectionSchema.parse(built.accountProjection)).toEqual(built.accountProjection);
    expect(forensicInputSchema.parse(built.forensicInput)).toEqual(built.forensicInput);
    expect(parseDossierV1Json(JSON.stringify(built.dossier))).toEqual(built.dossier);
    expect(parseAccountProjectionJson(JSON.stringify(built.accountProjection))).toEqual(
      built.accountProjection
    );
    expect(parseForensicInputJson(JSON.stringify(built.forensicInput))).toEqual(
      built.forensicInput
    );
  });

  it('rejects unknown nested keys, missing current fields, and wrong versions', () => {
    const built = buildDossier(makeInput());
    expect(
      accountProjectionSchema.safeParse({
        ...built.accountProjection,
        accountCore: { ...built.accountProjection.accountCore, futureField: true },
      }).success
    ).toBe(false);
    const { metrics: _metrics, ...missingMetrics } = built.forensicInput;
    expect(forensicInputSchema.safeParse(missingMetrics).success).toBe(false);
    expect(dossierV1Schema.safeParse({ ...built.dossier, schema_version: 999 }).success).toBe(
      false
    );
  });

  it('identifies the failing payload source at a disk-read boundary', () => {
    expect(() =>
      parseForensicInputJson(
        JSON.stringify({ schema_version: FORENSIC_SCHEMA_VERSION }),
        '/tmp/run/forensic-input-v1.json'
      )
    ).toThrow('/tmp/run/forensic-input-v1.json is not a valid current payload');
  });
});

describe('dossier — file sections', () => {
  it('classifies deleted capture artifacts, binary, and rename-only sections', () => {
    const sections = parseFileSections(DIFF);
    const byPath = (p: string) => sections.find((s) => s.path === p)!;
    expect(byPath('.orcaops/secret-notes.json').capture).toBe(true);
    expect(byPath('.orcaops/secret-notes.json').changeType).toBe('deleted');
    expect(byPath('assets/logo.png').changeType).toBe('binary');
    expect(byPath('src/new-name.ts').changeType).toBe('renamed');
    expect(byPath('src/new-name.ts').oldPath).toBe('src/old-name.ts');
  });

  it('surfaces non-text changes in file_index with manifest records', () => {
    const { dossier } = buildDossier(makeInput());
    const binary = dossier.file_index.find((f) => f.path === 'assets/logo.png')!;
    expect(binary.changeType).toBe('binary');
    expect(dossier.truncation_manifest.some((r) => r.reason === 'binary')).toBe(true);
    expect(
      dossier.truncation_manifest.some(
        (r) => r.id === 'file:src/new-name.ts' && r.reason === 'meta-only'
      )
    ).toBe(true);
  });
});

describe('dossier — parser and eviction regressions', () => {
  it('parses multi-file headerless fragments into separate sections', () => {
    const fragment = [
      '--- a/one.py',
      '+++ b/one.py',
      '@@ -1,1 +1,2 @@',
      ' x = 1',
      '+y = 2',
      '--- a/two.py',
      '+++ b/two.py',
      '@@ -1,1 +1,2 @@',
      ' a = 1',
      '+b = 2',
      '',
    ].join('\n');
    const sections = parseFileSections(fragment);
    expect(sections.map((x) => x.path)).toEqual(['one.py', 'two.py']);
  });

  it('does not fold ledger entries whose citation sets collide under naive join', () => {
    const mk = (id: string, citations: string[]) => ({
      id,
      kind: CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE,
      status: 'CANDIDATE' as const,
      message: 'same message',
      citations,
      anchors: ['src/alpha.ts'],
      evidence: {},
    });
    const entries = [
      mk('ldg:a', ['cite:x:a', 'cite:x:bc']),
      mk('ldg:b', ['cite:x:ab', 'cite:x:c']),
    ];
    const { accountProjection } = buildDossier(makeInput({ ledgerEntries: entries }));
    expect(accountProjection.accountCore.ledger.length).toBe(2);
  });

  it('keeps the coverage invariant after total-cap eviction (inventory recomputed)', () => {
    const tight = { ...DOSSIER_BUDGET_V1, accountProjectionTotal: 2200 };
    const { accountProjection, dossier } = buildDossier(makeInput({ budget: tight }));
    const carried = new Set([
      ...accountProjection.implicatedHunks.map((h) => h.file),
      ...accountProjection.riskRemainder.map((h) => h.file),
    ]);
    const stubbed = new Set(accountProjection.fileInventory.map((line) => line.split(' — ')[0]!));
    for (const f of dossier.file_index) {
      if (f.capture) continue;
      expect(carried.has(f.path) || stubbed.has(f.path)).toBe(true);
    }
  });
});

describe('dossier — determinism', () => {
  it('is byte-identical under permutation of citation and ledger ordering', () => {
    const a = buildDossier(makeInput());

    const floor = fixtureFloor();
    floor.citations = [...floor.citations].reverse();
    floor.landmarks = [...floor.landmarks].reverse();
    const entries = buildClaimLedger({ floor, checkpoints: [], generatedAt: AT }).entries;
    const b = buildDossier(makeInput({ floor, ledgerEntries: [...entries].reverse() }));

    expect(JSON.stringify(b.dossier)).toBe(JSON.stringify(a.dossier));
    expect(JSON.stringify(b.accountProjection)).toBe(JSON.stringify(a.accountProjection));
    expect(JSON.stringify(b.forensicInput)).toBe(JSON.stringify(a.forensicInput));
    expect(b.markdown).toBe(a.markdown);
  });

  it('orders the code index by structural score desc with digest tiebreaks', () => {
    const { dossier } = buildDossier(makeInput());
    const scores = dossier.code_index.map((h) => h.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });
});

describe('dossier — structural score and lexical hints (two-tier)', () => {
  it('scores structurally (changed lines + fan-out) and annotates hints without weight', () => {
    const { dossier } = buildDossier(makeInput());
    const byFile = (file: string) => dossier.code_index.filter((h) => h.file === file);

    const alpha = byFile('src/alpha.ts')[0]!;
    expect(alpha.fanout).toBe(true);
    expect(alpha.score).toBe(alpha.adds + alpha.dels);
    expect(alpha.hints.map((h) => h.hint)).toContain('guard-change');
    expect(alpha.hints.map((h) => h.hint)).toContain('symbol-fanout');

    const beta = byFile('src/beta.ts')[0]!;
    expect(beta.hints.map((h) => h.hint)).toContain('default-change');
    expect(beta.hints.map((h) => h.hint)).toContain('new-surface');

    const migration = byFile('db/migrations/001-init.sql')[0]!;
    expect(migration.hints.map((h) => h.hint)).toContain('persistence-path');
    // No fan-out on the migration: pure changed-line score.
    expect(migration.score).toBe(migration.adds + migration.dels);

    const lock = byFile('pnpm-lock.yaml')[0]!;
    expect(lock.generated).toBe(true);
    expect(lock.selection).not.toBe('capture-artifact');
    expect(byFile('.orcaops/config.json')[0]!.selection).toBe('capture-artifact');
  });
});

describe('dossier — forensic lane: complete eligible diff, verbatim', () => {
  it('excludes MODIFIED and DELETED capture artifacts and carries no branch name', () => {
    const { forensicInput } = buildDossier(makeInput());
    const serialized = JSON.stringify(forensicInput);
    expect(forensicInput.schema_version).toBe(FORENSIC_SCHEMA_VERSION);
    expect(serialized).not.toContain('feature/two-lane-test-branch');
    expect(serialized).not.toContain('secretDecision');
    expect(serialized).not.toContain('captured');
    expect(forensicInput.baseSha).toBe('basesha1234');
    expect(forensicInput.excludedPaths).toEqual([
      '.orcaops/config.json',
      '.orcaops/secret-notes.json',
    ]);
    // True binaries are unreviewable, enumerated, and NOT in the diff body.
    expect(forensicInput.unreviewablePaths).toEqual(['assets/logo.png']);
    expect(forensicInput.diff).not.toContain('Binary files');
  });

  it('is capture-invariant: changing capture data leaves the forensic request byte-identical', () => {
    const a = buildDossier(makeInput());
    const floor = fixtureFloor();
    floor.citations.push({
      id: 'cite:artifact-fixture:cp1:decision:extra',
      kind: CITATION_KIND.CHECKPOINT_DECISION,
      artifact: floor.outline.threads[0]!.checkpoints[0]!.checkpoint.artifact,
      cp: floor.outline.threads[0]!.checkpoints[0]!.checkpoint.cp,
      text: 'A different decision recorded after the fact.',
    });
    const entries = buildClaimLedger({ floor, checkpoints: [], generatedAt: AT }).entries;
    const b = buildDossier(makeInput({ floor, ledgerEntries: entries }));
    expect(JSON.stringify(b.forensicInput)).toBe(JSON.stringify(a.forensicInput));
  });

  it('renders every eligible file verbatim — never budget-drops a hunk (no packer)', () => {
    const { forensicInput } = buildDossier(makeInput());
    // Every non-capture, non-binary changed file is present verbatim in the diff.
    const carried = new Set(
      forensicInput.diff
        .split('\n')
        .filter((l) => l.startsWith('diff --git '))
        .map((l) => /b\/(\S+)$/.exec(l)?.[1])
    );
    for (const f of [
      'src/alpha.ts',
      'src/beta.ts',
      'src/gamma.ts',
      'db/migrations/001-init.sql',
      'pnpm-lock.yaml',
      'src/new-name.ts',
    ])
      expect(carried.has(f)).toBe(true);
    // Rename metadata survives verbatim; content changes survive verbatim.
    expect(forensicInput.diff).toContain('rename from src/old-name.ts');
    expect(forensicInput.diff).toContain('+if (sharedIdent > threshold) { flag(); }');
  });

  it('metrics: forensic bytes == eligible diff bytes with excluded + unreviewable rows enumerated and counted', () => {
    const { forensicInput } = buildDossier(makeInput());
    const m = forensicInput.metrics;
    // (a) the byte count is exactly the eligible diff.patch bytes.
    expect(m.eligibleDiffBytes).toBe(Buffer.byteLength(forensicInput.diff, 'utf8'));
    // Buckets are mutually exclusive and cover every changed file.
    expect(m.excludedFiles).toBe(forensicInput.excludedPaths.length);
    expect(m.unreviewableFiles).toBe(forensicInput.unreviewablePaths.length);
    expect(m.eligibleFiles).toBe(6); // alpha, beta, gamma, migrations, lockfile, rename
    expect(m.excludedFiles).toBe(2);
    expect(m.unreviewableFiles).toBe(1);
    // No policy configured ⇒ empty policy-stub bucket.
    expect(m.policyStubFiles).toBe(0);
    expect(m.policyStubRows).toBe(0);
    expect(m.policyStubBytes).toBe(0);
    expect(forensicInput.policyStubs).toEqual([]);
    const totalChanged = new Set(parseFileSections(DIFF).map((s) => s.path)).size;
    expect(m.eligibleFiles + m.excludedFiles + m.unreviewableFiles + m.policyStubFiles).toBe(
      totalChanged
    );
  });

  it('generated-file rows are NEVER silently dropped', () => {
    const { forensicInput } = buildDossier(makeInput());
    // The lockfile is a generated file: it stays mechanically represented,
    // verbatim, in the eligible diff — no importance scorer may omit it.
    expect(forensicInput.diff).toContain('diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml');
    expect(forensicInput.diff).toContain('+something: else');
    expect(forensicInput.excludedPaths).not.toContain('pnpm-lock.yaml');
    expect(forensicInput.unreviewablePaths).not.toContain('pnpm-lock.yaml');
  });

  it('oversized eligible diff → refusal envelope naming the ceiling + actual size, no payload minted', () => {
    // A large fixture-like new file: verbatim it must NOT be omitted; instead
    // the run refuses at start when it exceeds the absolute transport ceiling.
    const bigBody = Array.from({ length: 400 }, (_, i) => `+FIXTURE_LINE_${i} padding text here`);
    const diff = [
      'diff --git a/fixtures/giant.txt b/fixtures/giant.txt',
      '--- a/fixtures/giant.txt',
      '+++ b/fixtures/giant.txt',
      `@@ -1,1 +1,${bigBody.length + 1} @@`,
      ' context',
      ...bigBody,
      '',
    ].join('\n');
    const eligibleBytes = Buffer.byteLength(
      parseFileSections(diff)
        .map((s) => [s.headerBlock, ...s.hunks.map((h) => h.raw)].join('\n'))
        .join('\n'),
      'utf8'
    );
    let thrown: unknown;
    try {
      buildDossier(makeInput({ retainedDiff: diff, forensicTransportCeilingBytes: 500 }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForensicTransportCeilingError);
    const err = thrown as ForensicTransportCeilingError;
    expect(err.code).toBe('FORENSIC_TRANSPORT_CEILING');
    expect(err.ceilingBytes).toBe(500);
    expect(err.actualBytes).toBe(eligibleBytes);
    expect(err.message).toContain('500');
    expect(err.message).toContain(String(eligibleBytes));
  });
});

describe('dossier — rejected alternatives attach to their own decision', () => {
  const ARTIFACT = 'artifact-fixture';
  const cite = (kind: string, index: number): string =>
    formatCitationId({ artifact: ARTIFACT, checkpointN: 1, kind: kind as never, index });

  /** The golden floor's single checkpoint, re-stocked with linked alternatives. */
  function alternativesFloor(): Floor {
    const floor = fixtureFloor();
    const decisions = ['Attach by the captured parent.', 'Bump the producer version.'];
    // Each entry is [text, index of the decision it was rejected against].
    const alternatives: [string, number][] = [
      ['Filter by artifact and checkpoint.', 0],
      ['Key alternatives by their position in the checkpoint.', 0],
      ['Let the cache expire on its own.', 1],
    ];
    floor.citations = [
      ...decisions.map((text, i) => ({
        id: cite(CITATION_KIND.CHECKPOINT_DECISION, i),
        kind: CITATION_KIND.CHECKPOINT_DECISION,
        artifact: ARTIFACT,
        cp: 1,
        text,
      })),
      ...alternatives.map(([text, parentIndex], i) => ({
        id: cite(CITATION_KIND.CHECKPOINT_ALTERNATIVE, i),
        kind: CITATION_KIND.CHECKPOINT_ALTERNATIVE,
        artifact: ARTIFACT,
        cp: 1,
        text,
        parent: cite(CITATION_KIND.CHECKPOINT_DECISION, parentIndex),
      })),
    ];
    return floor;
  }

  const checkpointOf = (floor: Floor) =>
    buildDossier(makeInput({ floor })).accountProjection.accountCore.checkpoints[0]!;

  /**
   * THE regression: the filter this replaced matched on artifact+cp, so every
   * decision in a checkpoint received every alternative in it — 3 alternatives
   * served as 6 rows here. A reviewer reading a duplicated row is told the
   * agent ruled out something it never weighed against that decision.
   */
  it('serves each decision only the alternatives rejected against it', () => {
    const cp = checkpointOf(alternativesFloor());
    expect(cp.decisions.map((d) => d.alternatives.length)).toEqual([2, 1]);
    const rows = cp.decisions.flatMap((d) => d.alternatives.map((a) => a.citationId));
    // Rows can never outnumber the alternatives that exist.
    expect(rows.length).toBe(new Set(rows).size);
    expect(rows.length).toBe(3);
  });

  it('places every alternative under exactly one decision', () => {
    const cp = checkpointOf(alternativesFloor());
    const seen = new Map<string, number>();
    for (const d of cp.decisions)
      for (const a of d.alternatives) seen.set(a.citationId, (seen.get(a.citationId) ?? 0) + 1);
    expect([...seen.values()]).toEqual([1, 1, 1]);
    expect([...seen.keys()].sort()).toEqual([
      cite(CITATION_KIND.CHECKPOINT_ALTERNATIVE, 0),
      cite(CITATION_KIND.CHECKPOINT_ALTERNATIVE, 1),
      cite(CITATION_KIND.CHECKPOINT_ALTERNATIVE, 2),
    ]);
  });
  /** The model must be able to cite everything the payload shows it. */
  it('keeps every current alternative citable', () => {
    const projection = buildDossier(makeInput({ floor: alternativesFloor() })).accountProjection;
    const cp = projection.accountCore.checkpoints[0]!;
    const citable = accountCitableIds(projection);
    const shown = cp.decisions.flatMap((d) => d.alternatives.map((a) => a.citationId));
    expect(shown.length).toBe(3);
    for (const id of shown) expect(citable.has(id), `alternative ${id} not citable`).toBe(true);
  });
});

/**
 * The three categories of captured provenance that reached the floor but never
 * the projection, because nothing read them out of storage. Each is checked at
 * the same three points: it lands in the account core, it is legal to cite, and
 * the payload actually shows it.
 */
describe('dossier — newly-plumbed captured provenance (chains 1-3)', () => {
  const ARTIFACT = 'artifact-fixture';
  const artifactCite = (kind: string, index: number): string =>
    formatCitationId({ artifact: ARTIFACT, checkpointN: null, kind: kind as never, index });
  const cpCite = (kind: string, index: number): string =>
    formatCitationId({ artifact: ARTIFACT, checkpointN: 1, kind: kind as never, index });

  /**
   * A floor stocked exactly as `buildCitations` would stock it: two plan
   * decisions (the first with two ruled-out options), two acceptance criteria,
   * three evidence records — one per criterion plus ONE ORPHAN whose
   * criterion_id resolves to nothing — and two verification records alongside
   * an evaluator run, so the rename is observable.
   */
  function plumbedFloor(): Floor {
    const floor = fixtureFloor();
    floor.citations = [
      {
        id: artifactCite(CITATION_KIND.PLAN_DECISION, 0),
        kind: CITATION_KIND.PLAN_DECISION,
        artifact: ARTIFACT,
        text: 'Project the captured corpus.\n↳ nothing read it',
      },
      {
        id: artifactCite(CITATION_KIND.PLAN_DECISION, 1),
        kind: CITATION_KIND.PLAN_DECISION,
        artifact: ARTIFACT,
        text: 'Protect it from the budget.\n↳ clipping is the failure mode',
      },
      {
        id: artifactCite(CITATION_KIND.PLAN_ALTERNATIVE, 0),
        kind: CITATION_KIND.PLAN_ALTERNATIVE,
        artifact: ARTIFACT,
        parent: artifactCite(CITATION_KIND.PLAN_DECISION, 0),
        text: 'Render it ad hoc.\n↳ uncitable',
      },
      {
        id: artifactCite(CITATION_KIND.PLAN_ALTERNATIVE, 1),
        kind: CITATION_KIND.PLAN_ALTERNATIVE,
        artifact: ARTIFACT,
        parent: artifactCite(CITATION_KIND.PLAN_DECISION, 0),
        text: 'Fold it into the summary.\n↳ lossy',
      },
      {
        id: artifactCite(CITATION_KIND.PLAN_ALTERNATIVE, 2),
        kind: CITATION_KIND.PLAN_ALTERNATIVE,
        artifact: ARTIFACT,
        parent: artifactCite(CITATION_KIND.PLAN_DECISION, 1),
        text: 'Let the budget clip it.\n↳ silent partial coverage',
      },
      // `parent` is required, but this minimal floor stocks no plan steps, so
      // both parents dangle — the criteria exercise the unresolved-link bucket
      // without adding step rows to the citable-id sets.
      {
        id: artifactCite(CITATION_KIND.ACCEPTANCE_CRITERION, 0),
        kind: CITATION_KIND.ACCEPTANCE_CRITERION,
        artifact: ARTIFACT,
        parent: artifactCite(CITATION_KIND.PLAN_STEP, 0),
        text: 'Every record is citable.',
      },
      {
        id: artifactCite(CITATION_KIND.ACCEPTANCE_CRITERION, 1),
        kind: CITATION_KIND.ACCEPTANCE_CRITERION,
        artifact: ARTIFACT,
        parent: artifactCite(CITATION_KIND.PLAN_STEP, 1),
        text: 'The floor shape does not move.',
      },
      {
        id: cpCite(CITATION_KIND.CRITERION_EVIDENCE, 0),
        kind: CITATION_KIND.CRITERION_EVIDENCE,
        artifact: ARTIFACT,
        cp: 1,
        parent: artifactCite(CITATION_KIND.ACCEPTANCE_CRITERION, 0),
        text: 'c1 — accountCitableIds enumerates all four new kinds',
      },
      {
        id: cpCite(CITATION_KIND.CRITERION_EVIDENCE, 1),
        kind: CITATION_KIND.CRITERION_EVIDENCE,
        artifact: ARTIFACT,
        cp: 1,
        parent: artifactCite(CITATION_KIND.ACCEPTANCE_CRITERION, 1),
        text: 'c2 — FLOOR_SCHEMA_VERSION is pinned at 3',
      },
      {
        id: cpCite(CITATION_KIND.CRITERION_EVIDENCE, 2),
        kind: CITATION_KIND.CRITERION_EVIDENCE,
        artifact: ARTIFACT,
        cp: 1,
        // NO parent: the criterion_id named a criterion no longer in scope.
        text: 'c-dropped — evidence for a criterion a later revision removed',
      },
      {
        id: cpCite(CITATION_KIND.CHECKPOINT_VERIFICATION, 0),
        kind: CITATION_KIND.CHECKPOINT_VERIFICATION,
        artifact: ARTIFACT,
        cp: 1,
        text: 'pnpm test → exit 0 · 638 passed',
      },
      {
        id: cpCite(CITATION_KIND.CHECKPOINT_VERIFICATION, 1),
        kind: CITATION_KIND.CHECKPOINT_VERIFICATION,
        artifact: ARTIFACT,
        cp: 1,
        text: 'pnpm typecheck → exit 1\n↳ known, tracked',
      },
      {
        id: artifactCite(CITATION_KIND.EVALUATOR_RUN, 0),
        kind: CITATION_KIND.EVALUATOR_RUN,
        artifact: ARTIFACT,
        text: 'plan-mentions-tests — pass: PASS',
        evaluator: {
          evaluator_ref: 'policy/completion-evidence',
          severity: 'block',
          run_status: 'completed',
          verdict: 'violation',
          disposition: 'dismissed',
          summary: 'Completion evidence was incomplete at capture time.',
        },
      },
    ];
    return floor;
  }

  const coreOf = () => buildDossier(makeInput({ floor: plumbedFloor() })).accountProjection;

  it('CHAIN 1: plan decisions land with their alternatives nested under the right one', () => {
    const core = coreOf().accountCore;
    expect(core.planDecisions.map((d) => d.citationId)).toEqual([
      artifactCite(CITATION_KIND.PLAN_DECISION, 0),
      artifactCite(CITATION_KIND.PLAN_DECISION, 1),
    ]);
    expect(core.planDecisions.map((d) => d.alternatives.length)).toEqual([2, 1]);
    // Artifact-scoped: a plan decision has no checkpoint locus.
    expect(core.planDecisions.every((d) => d.cp === null)).toBe(true);
    // Every alternative is placed exactly once — no re-service under siblings.
    const rows = core.planDecisions.flatMap((d) => d.alternatives.map((a) => a.citationId));
    expect(rows.length).toBe(new Set(rows).size);
    expect(rows.length).toBe(3);
  });

  it('CHAIN 2: evidence lands parented on the criterion its criterion_id names', () => {
    const core = coreOf().accountCore;
    expect(core.criterionEvidence.map((e) => e.parent)).toEqual([
      artifactCite(CITATION_KIND.ACCEPTANCE_CRITERION, 0),
      artifactCite(CITATION_KIND.ACCEPTANCE_CRITERION, 1),
      undefined,
    ]);
    // Each resolved parent names a criterion actually served in this core.
    const criteria = new Set(core.acceptanceCriteria.map((c) => c.citationId));
    for (const e of core.criterionEvidence)
      if (e.parent !== undefined) expect(criteria.has(e.parent)).toBe(true);
  });

  /**
   * THE ORPHAN PATH. Evidence whose criterion_id resolves to nothing is the
   * case that tempts a drop — there is no tidy place to hang it. It is carried
   * anyway, parentless and labelled, because losing captured evidence to
   * preserve a clean join is exactly the failure this surface exists to stop.
   */
  it('CHAIN 2 ORPHAN: unparented evidence is carried, citable, and labelled — never dropped', () => {
    const projection = coreOf();
    const orphan = projection.accountCore.criterionEvidence.find((e) => e.parent === undefined);
    expect(orphan).toBeDefined();
    expect(orphan!.text).toContain('c-dropped');
    expect(accountCitableIds(projection).has(orphan!.citationId)).toBe(true);
    const md = renderAccountRoutineMd(projection);
    const alias = promptCitationAlias(projection, orphan!.citationId);
    expect(alias).toBeDefined();
    expect(md).toContain(`[${alias}]`);
    expect(md).toContain('no acceptance criterion in scope');
  });

  /**
   * Separate fields so the two cannot be conflated: if `verification` were fed
   * by EVALUATOR_RUN citations, a reader counting "verification" would count
   * evaluator verdicts and report proof-of-execution that had never been
   * captured.
   */
  it('CHAIN 3: verification holds verified-close records and evaluatorRuns holds the log', () => {
    const built = buildDossier(makeInput({ floor: plumbedFloor() }));
    const core = built.accountProjection.accountCore;
    expect(core.verification.map((v) => v.citationId)).toEqual([
      cpCite(CITATION_KIND.CHECKPOINT_VERIFICATION, 0),
      cpCite(CITATION_KIND.CHECKPOINT_VERIFICATION, 1),
    ]);
    expect(core.verification[0]!.text).toContain('pnpm test → exit 0');
    expect(core.evaluatorRuns.map((r) => r.citationId)).toEqual([
      artifactCite(CITATION_KIND.EVALUATOR_RUN, 0),
    ]);
    expect(core.evaluatorRuns[0]!.evaluator).toEqual({
      evaluator_ref: 'policy/completion-evidence',
      severity: 'block',
      run_status: 'completed',
      verdict: 'violation',
      disposition: 'dismissed',
      summary: 'Completion evidence was incomplete at capture time.',
    });
    expect(built.dossier.account_core.evaluatorRuns).toEqual(core.evaluatorRuns);
    // The two lists are disjoint — the conflation cannot recur silently.
    const v = new Set(core.verification.map((x) => x.citationId));
    for (const r of core.evaluatorRuns) expect(v.has(r.citationId)).toBe(false);
  });

  it('every new record is citable AND displayed — bracketed-iff-citable holds', () => {
    const projection = coreOf();
    const core = projection.accountCore;
    const citable = accountCitableIds(projection);
    const md = renderAccountRoutineMd(projection);
    const aliases = accountPromptAliasMaps(projection);
    const shown = [
      ...core.planDecisions.flatMap((d) => [
        d.citationId,
        ...d.alternatives.map((a) => a.citationId),
      ]),
      ...core.criterionEvidence.map((e) => e.citationId),
      ...core.verification.map((x) => x.citationId),
      ...core.evaluatorRuns.map((x) => x.citationId),
    ];
    expect(shown).toHaveLength(11);
    for (const id of shown) {
      expect(citable.has(id), `${id} is displayed but not citable`).toBe(true);
      const alias = [...aliases.citations].find(([, canonical]) => canonical === id)?.[0];
      expect(alias, `${id} has no prompt alias`).toBeDefined();
      expect(md.includes(`[${alias}]`), `${id} is citable but not displayed`).toBe(true);
    }
    // Every bracketed prompt alias must resolve to a legal canonical citation.
    for (const [, alias] of md.matchAll(/\[(c\d+)\]/g)) {
      const id = aliases.citations.get(alias!);
      expect(id, `payload brackets unknown alias ${alias}`).toBeDefined();
      expect(citable.has(id!), `payload brackets non-citable ${id}`).toBe(true);
    }
  });

  it('counts routine evaluator outcomes while expanding structured exceptions', () => {
    const projection = coreOf();
    projection.accountCore.evaluatorRuns.push({
      citationId: artifactCite(CITATION_KIND.EVALUATOR_RUN, 1),
      text: 'plan-label-quality — pass: PASS',
      evaluator: {
        evaluator_ref: 'plan-label-quality',
        severity: 'warn',
        run_status: 'completed',
        verdict: 'pass',
        disposition: null,
        summary: 'Plan labels are concise.',
      },
    });
    projection.accountCore.evaluatorRuns.push(
      {
        citationId: artifactCite(CITATION_KIND.EVALUATOR_RUN, 2),
        text: 'provider-check — error',
        evaluator: {
          evaluator_ref: 'provider-check',
          severity: 'warn',
          run_status: 'error',
          verdict: null,
          disposition: null,
          summary: 'Provider timed out.',
        },
      },
      {
        citationId: artifactCite(CITATION_KIND.EVALUATOR_RUN, 3),
        text: 'required-gate — skipped',
        evaluator: {
          evaluator_ref: 'required-gate',
          severity: 'block',
          run_status: 'skipped',
          verdict: null,
          disposition: 'policy-excepted',
          summary: 'Gate was explicitly excepted.',
        },
      },
      {
        citationId: artifactCite(CITATION_KIND.EVALUATOR_RUN, 4),
        text: 'policy/completion-evidence — violation',
        evaluator: {
          evaluator_ref: 'policy/completion-evidence',
          severity: 'block',
          run_status: 'completed',
          verdict: 'violation',
          disposition: 'unresolved',
          summary: 'A later violation remains unresolved.',
        },
      }
    );
    const md = renderAccountRoutineMd(projection);
    expect(md).toContain('Evaluator summary: 1 PASS · 1 SKIPPED · 2 VIOLATION · 1 ERROR');
    expect(md).toContain(
      'policy/completion-evidence — run COMPLETED · verdict VIOLATION · severity BLOCK · disposition dismissed'
    );
    expect(md).toContain(
      'policy/completion-evidence — run COMPLETED · verdict VIOLATION · severity BLOCK · disposition unresolved'
    );
    expect(md).toContain(
      'provider-check — run ERROR · verdict NONE · severity WARN · disposition unrecorded'
    );
    expect(md).toContain(
      'required-gate — run SKIPPED · verdict NONE · severity BLOCK · disposition policy-excepted'
    );
    expect(md).not.toContain('plan-label-quality — pass: PASS');
    expect(
      promptCitationAlias(projection, artifactCite(CITATION_KIND.EVALUATOR_RUN, 1))
    ).toBeUndefined();
    // Summarization is prompt-only: the stored projection still carries the
    // complete row and metadata for deterministic replay and diagnostics.
    expect(projection.accountCore.evaluatorRuns).toHaveLength(5);
  });

  it('renders source indices numerically instead of lexical 0, 1, 10, 2 order', () => {
    const projection = coreOf();
    projection.accountCore.planSteps = Array.from({ length: 12 }, (_, index) => ({
      citationId: artifactCite(CITATION_KIND.PLAN_STEP, index),
      text: `step ${index}`,
    }));
    const md = renderAccountRoutineMd(projection);
    const rendered = [...md.matchAll(/^- step \[c\d+\] step (\d+)$/gm)].map((match) =>
      Number(match[1])
    );
    expect(rendered).toEqual(Array.from({ length: 12 }, (_, index) => index));
  });

  /** New captured provenance is PROTECTED corpus: no budget rung may touch it. */
  it('survives the tightest reducible budget byte-for-byte', () => {
    const full = coreOf().accountCore;
    const tight = buildDossier(
      makeInput({
        floor: plumbedFloor(),
        budget: { ...DOSSIER_BUDGET_V1, ledgerReduction: 1, accountProjectionTotal: 1 },
      })
    ).accountProjection.accountCore;
    for (const field of ['planDecisions', 'criterionEvidence', 'verification', 'evaluatorRuns'])
      expect(PROTECTED_ACCOUNT_FIELDS).toContain(field);
    expect(tight.planDecisions).toEqual(full.planDecisions);
    expect(tight.criterionEvidence).toEqual(full.criterionEvidence);
    expect(tight.verification).toEqual(full.verification);
    expect(tight.evaluatorRuns).toEqual(full.evaluatorRuns);
  });

  /**
   * Citation-id aliasing rewrites the artifact uuid inside every id the
   * projection serves. `parent` is an id too: leaving it un-aliased would point
   * the evidence at a full-uuid string that appears nowhere else in the payload
   * — displayed, id-shaped, and uncitable.
   */
  it('aliases the evidence parent alongside every other citation id', () => {
    const uuid = '019f791c-1111-7000-8000-000000000001';
    const floor = plumbedFloor();
    floor.citations = floor.citations.map((c) => ({
      ...c,
      id: c.id.replace(ARTIFACT, uuid),
      artifact: uuid,
      ...(c.parent !== undefined ? { parent: c.parent.replace(ARTIFACT, uuid) } : {}),
    }));
    const projection = buildDossier(makeInput({ floor })).accountProjection;
    const citable = accountCitableIds(projection);
    for (const e of projection.accountCore.criterionEvidence) {
      expect(e.citationId).not.toContain(uuid);
      if (e.parent !== undefined) {
        expect(e.parent).not.toContain(uuid);
        expect(citable.has(e.parent)).toBe(true);
      }
    }
    for (const d of projection.accountCore.planDecisions) {
      expect(d.citationId).not.toContain(uuid);
      for (const a of d.alternatives) expect(a.citationId).not.toContain(uuid);
    }
  });
});

describe('dossier — coverage floor (both lanes)', () => {
  it('represents every changed file in the account projection via hunks or inventory stubs', () => {
    const tiny = { ...DOSSIER_BUDGET_V1, riskRemainder: 30, implicatedHunks: 30 };
    const { accountProjection } = buildDossier(makeInput({ budget: tiny }));
    const carried = new Set([
      ...accountProjection.implicatedHunks.map((h) => h.file),
      ...accountProjection.riskRemainder.map((h) => h.file),
    ]);
    for (const f of [
      'src/alpha.ts',
      'src/beta.ts',
      'src/gamma.ts',
      'db/migrations/001-init.sql',
      'assets/logo.png',
      'src/new-name.ts',
    ]) {
      const stubbed = accountProjection.fileInventory.some((line) => line.split(' — ')[0] === f);
      expect(carried.has(f) || stubbed).toBe(true);
    }
    // Binary file appears as a stub with its change type.
    const binaryStub = accountProjection.fileInventory.find((line) =>
      line.startsWith('assets/logo.png — binary')
    );
    expect(binaryStub).toBeDefined();
  });
});

describe('dossier — truncation manifest completeness (no silent caps)', () => {
  it('records every non-selected eligible hunk and every clip', () => {
    const floor = fixtureFloor();
    floor.citations.push({
      id: 'cite:artifact-fixture:cp1:decision:long',
      kind: CITATION_KIND.CHECKPOINT_DECISION,
      artifact: floor.outline.threads[0]!.checkpoints[0]!.checkpoint.artifact,
      cp: floor.outline.threads[0]!.checkpoints[0]!.checkpoint.cp,
      text: 'A very long decision body. '.repeat(40),
    });
    // Captured provenance is no longer clippable and ledger rows no longer
    // fold, so the surviving ledger clip is the ANCHOR cap: a row carrying more
    // anchors than the late-stage limit is trimmed, and the trim is recorded.
    const manyAnchors = {
      id: 'ldg:UNTRACKED_EVIDENCE:anchorheavy01',
      kind: 'UNTRACKED_EVIDENCE' as const,
      status: 'CANDIDATE' as const,
      message: 'untracked litter across many paths',
      citations: [],
      anchors: [
        'src/alpha.ts',
        'src/beta.ts',
        'src/gamma.ts',
        'src/delta.ts',
        'src/epsilon.ts',
        'src/zeta.ts',
        'src/eta.ts',
      ],
      evidence: {},
    };
    const ledgerEntries = [
      ...buildClaimLedger({ floor, checkpoints: [], generatedAt: AT }).entries,
      manyAnchors,
    ];
    const tiny = {
      ...DOSSIER_BUDGET_V1,
      ledgerReduction: 1,
      riskRemainder: 30,
      implicatedHunks: 30,
      ledgerCitedTextClip: 10,
    };
    const result = buildDossier(makeInput({ floor, ledgerEntries, budget: tiny }));

    const recordedIds = new Set(result.dossier.truncation_manifest.map((r) => r.id));
    for (const hunk of result.dossier.code_index) {
      if (hunk.selection !== 'implicated' && hunk.selection !== 'risk') {
        expect(recordedIds.has(hunk.id)).toBe(true);
      }
    }
    expect(result.dossier.truncation_manifest.some((r) => r.reason === 'clip')).toBe(true);
  });

  it('refuses an oversized protected corpus instead of degrading it', () => {
    // The prior ruling degraded oversized mandatory content to an AGGREGATE
    // mode and then a COUNTS_ONLY mode so tier 1 always built — it always built
    // by serving a summary of the captured account in place of the account.
    // Captured provenance is no longer reducible, so the same input refuses.
    const healthy = buildDossier(makeInput());
    expect('degradation' in healthy.accountProjection).toBe(false);
    const corpusOf = (p: typeof healthy.accountProjection): string =>
      JSON.stringify(
        Object.fromEntries(PROTECTED_ACCOUNT_FIELDS.map((f) => [f, p.accountCore[f]]))
      );
    const corpusBytes = Buffer.byteLength(corpusOf(healthy.accountProjection), 'utf8');
    expect(corpusBytes).toBeGreaterThan(0);

    let thrown: unknown;
    try {
      buildDossier(makeInput({ accountCorpusCeilingBytes: corpusBytes - 1 }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AccountCorpusCeilingError);
    const refusal = thrown as AccountCorpusCeilingError;
    expect(refusal.code).toBe('ACCOUNT_CORPUS_CEILING');
    expect(refusal.ceilingBytes).toBe(corpusBytes - 1);
    // The error reports EXACTLY what was measured.
    expect(refusal.actualBytes).toBe(corpusBytes);
    expect(refusal.message).toContain('no payload minted');

    // No reducible budget, however tight, can degrade the corpus: there is no
    // rung left to set the marker, and the captured record stays byte-identical.
    const squeezed = buildDossier(
      makeInput({ budget: { ...DOSSIER_BUDGET_V1, ledgerReduction: 1, accountProjectionTotal: 1 } })
    );
    expect('degradation' in squeezed.accountProjection).toBe(false);
    expect(
      squeezed.dossier.truncation_manifest.some((r) => r.id.startsWith('account-core-degraded:'))
    ).toBe(false);
    expect(corpusOf(squeezed.accountProjection)).toBe(corpusOf(healthy.accountProjection));
    // The disk dossier and the forensic input are unaffected either way.
    expect(squeezed.dossier.account_core.checkpoints.length).toBe(
      healthy.dossier.account_core.checkpoints.length
    );
    expect(JSON.stringify(squeezed.forensicInput)).toBe(JSON.stringify(healthy.forensicInput));
  });

  it('names a simultaneous forensic overage in the account refusal — one round trip, one code', () => {
    const healthy = buildDossier(makeInput());
    const corpusBytes = Buffer.byteLength(
      JSON.stringify(
        Object.fromEntries(
          PROTECTED_ACCOUNT_FIELDS.map((f) => [f, healthy.accountProjection.accountCore[f]])
        )
      ),
      'utf8'
    );
    let thrown: unknown;
    try {
      buildDossier(
        makeInput({ accountCorpusCeilingBytes: corpusBytes - 1, forensicTransportCeilingBytes: 10 })
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AccountCorpusCeilingError);
    const refusal = thrown as AccountCorpusCeilingError;
    // One code per refusal; the SECOND overage lives in the message so the
    // operator does not narrow scope, re-run, and hit it on the next pass.
    expect(refusal.code).toBe('ACCOUNT_CORPUS_CEILING');
    expect(refusal.message).toContain('ALSO over its ceiling');
    // Forensic-only overage still reports the forensic code.
    expect(() => buildDossier(makeInput({ forensicTransportCeilingBytes: 10 }))).toThrow(
      ForensicTransportCeilingError
    );
  });
});

describe('dossier — remainder eviction semantics', () => {
  it('small hunks survive while the oversized bulk hunk evicts (S1 stratum)', () => {
    // One huge low..high hunk plus small ones: evict-lowest keeps the big
    // high-rank one and drops small low-rank ones — verify eviction is by
    // ascending rank, not greedy first-fit.
    const bigBody = Array.from({ length: 60 }, (_, i) => `+big line ${i} with sharedIdent`).join(
      '\n'
    );
    const diff = [
      'diff --git a/src/a1.ts b/src/a1.ts',
      '--- a/src/a1.ts',
      '+++ b/src/a1.ts',
      '@@ -1,0 +1,60 @@',
      bigBody,
      'diff --git a/src/a2.ts b/src/a2.ts',
      '--- a/src/a2.ts',
      '+++ b/src/a2.ts',
      '@@ -1,1 +1,2 @@',
      ' ctx',
      '+small change sharedIdent',
      'diff --git a/src/a3.ts b/src/a3.ts',
      '--- a/src/a3.ts',
      '+++ b/src/a3.ts',
      '@@ -1,1 +1,2 @@',
      ' ctx',
      '+small change sharedIdent too',
      '',
    ].join('\n');
    const budget = { ...DOSSIER_BUDGET_V1, riskRemainder: 500 };
    const { accountProjection, dossier } = buildDossier(makeInput({ retainedDiff: diff, budget }));
    const kept = accountProjection.riskRemainder.map((h) => h.file);
    // S1 stratum: the small hunks survive; the oversized bulk hunk is the
    // one evicted (bulk refactors starve before one-line changes).
    expect(kept).toContain('src/a2.ts');
    expect(kept).toContain('src/a3.ts');
    expect(kept).not.toContain('src/a1.ts');
    const evicted = dossier.truncation_manifest.filter(
      (r) => r.section === 'risk-remainder' && r.reason === 'budget'
    );
    expect(evicted.length).toBeGreaterThan(0);
  });
});

describe('dossier — scale and git-path decoding regressions', () => {
  it('builds a current-schema 1,200-file corpus within 10 seconds without losing file accounting', () => {
    const parts: string[] = [];
    for (let i = 0; i < 1200; i += 1) {
      const f = `pkg${i % 12}/dir${i % 40}/file-${i}.ts`;
      parts.push(
        `diff --git a/${f} b/${f}`,
        `--- a/${f}`,
        `+++ b/${f}`,
        '@@ -1,1 +1,2 @@',
        ' ctx',
        `+changed line ${i}`
      );
    }
    const bigDiff = `${parts.join('\n')}\n`;
    const startedAt = performance.now();
    const result = buildDossier(makeInput({ retainedDiff: bigDiff }));
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(10_000);
    expect(result.dossier.file_index.length).toBe(1200);
    expect(
      result.forensicInput.metrics.eligibleFiles +
        result.forensicInput.metrics.excludedFiles +
        result.forensicInput.metrics.unreviewableFiles +
        result.forensicInput.metrics.policyStubFiles
    ).toBe(1200);
    expect(parseFileSections(result.forensicInput.diff)).toHaveLength(1200);
    expect(result.dossier.code_index.length).toBeGreaterThan(100);
    expect(result.accountProjection.inventoryMode).not.toBe('full');
    const ids = result.dossier.truncation_manifest.map((r) => r.id);
    expect(
      ids.includes('account-inventory-paths') ||
        ids.includes('account-inventory-rollup') ||
        ids.includes('account-total-cap-exceeded')
    ).toBe(true);
    expect(estimatorV1(result.forensicInput.diff)).toBeGreaterThan(0);
  });

  it('forensic diff carries every eligible file verbatim at scale (no inventory ladder)', () => {
    const parts: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const f = `p${i % 8}/f${i}.ts`;
      parts.push(
        `diff --git a/${f} b/${f}`,
        `--- a/${f}`,
        `+++ b/${f}`,
        '@@ -1,1 +1,2 @@',
        ' ctx',
        `+c${i} with a moderately long changed line`
      );
    }
    const diff = `${parts.join('\n')}\n`;
    const { forensicInput } = buildDossier(makeInput({ retainedDiff: diff }));
    // Every file is verbatim in the diff; nothing is stubbed or omitted.
    const carried = new Set(
      forensicInput.diff
        .split('\n')
        .filter((l) => l.startsWith('diff --git '))
        .map((l) => /b\/(\S+)$/.exec(l)?.[1])
    );
    expect(carried.size).toBe(200);
    expect(forensicInput.metrics.eligibleFiles).toBe(200);
    expect(forensicInput.metrics.eligibleDiffBytes).toBe(
      Buffer.byteLength(forensicInput.diff, 'utf8')
    );
  });

  it('git-path decoder matrix: named escapes, octal, header-only, literal UTF-8, rename', () => {
    const cases: { name: string; diff: string; expect: string[] }[] = [
      {
        name: 'octal in header-only (mode-only) section',
        diff: [
          'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
          'old mode 100644',
          'new mode 100755',
          '',
        ].join('\n'),
        expect: ['caf\u00e9.ts'],
      },
      {
        name: 'literal UTF-8 preserved inside quotes',
        diff: [
          'diff --git "a/caf\u00e9 file.ts" "b/caf\u00e9 file.ts"',
          '--- "a/caf\u00e9 file.ts"',
          '+++ "b/caf\u00e9 file.ts"',
          '@@ -1,1 +1,2 @@',
          ' a',
          '+b',
          '',
        ].join('\n'),
        expect: ['caf\u00e9 file.ts'],
      },
      {
        name: 'named escape tab',
        diff: [
          'diff --git "a/we\\tird.ts" "b/we\\tird.ts"',
          'old mode 100644',
          'new mode 100755',
          '',
        ].join('\n'),
        expect: ['we\tird.ts'],
      },
      {
        name: 'quoted rename metadata with octal',
        diff: [
          'diff --git "a/caf\\303\\251-old.ts" "b/caf\\303\\251-new.ts"',
          'similarity index 100%',
          'rename from "caf\\303\\251-old.ts"',
          'rename to "caf\\303\\251-new.ts"',
          '',
        ].join('\n'),
        expect: ['caf\u00e9-new.ts'],
      },
    ];
    for (const c of cases) {
      const sections = parseFileSections(c.diff);
      expect(
        sections.map((x) => x.path),
        c.name
      ).toEqual(c.expect);
    }
  });

  it('decodes git octal-quoted non-ASCII paths to UTF-8 identities', () => {
    const diff = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -1,1 +1,2 @@',
      ' a',
      '+b',
      '',
    ].join('\n');
    const sections = parseFileSections(diff);
    expect(sections.map((x) => x.path)).toEqual(['caf\u00e9.ts']);
  });

  it('parses git quoted paths with spaces to correct identities', () => {
    const diff = [
      'diff --git "a/dir name/file one.ts" "b/dir name/file one.ts"',
      'old mode 100644',
      'new mode 100755',
      'diff --git "a/x y.py" "b/x y.py"',
      '--- "a/x y.py"',
      '+++ "b/x y.py"',
      '@@ -1,1 +1,2 @@',
      ' a = 1',
      '+b = 2',
      '',
    ].join('\n');
    const sections = parseFileSections(diff);
    expect(sections.map((x) => x.path)).toEqual(['dir name/file one.ts', 'x y.py']);
    expect(sections[0]!.changeType).toBe('meta-only');
    expect(sections[1]!.hunks.length).toBe(1);
  });
});

describe('dossier — review.stub_paths policy stubs', () => {
  it('stubs a matched file: enumerated with row+byte counts, held out of the verbatim diff', () => {
    const { forensicInput } = buildDossier(
      makeInput({ stubPaths: ['db/migrations/**', 'pnpm-lock.yaml'] })
    );
    const m = forensicInput.metrics;
    // The stubbed files are NOT carried verbatim.
    expect(forensicInput.diff).not.toContain('db/migrations/001-init.sql');
    expect(forensicInput.diff).not.toContain('pnpm-lock.yaml');
    // They are enumerated as loud stub lines with counts + reason.
    const byPath = new Map(forensicInput.policyStubs.map((s) => [s.path, s]));
    expect(byPath.has('db/migrations/001-init.sql')).toBe(true);
    expect(byPath.has('pnpm-lock.yaml')).toBe(true);
    const mig = byPath.get('db/migrations/001-init.sql')!;
    expect(mig.adds).toBe(1);
    expect(mig.dels).toBe(0);
    expect(mig.bytes).toBeGreaterThan(0);
    expect(mig.reason).toBe('review.stub_paths');
    // Bucket metrics agree with the enumerated stubs.
    expect(m.policyStubFiles).toBe(2);
    expect(m.policyStubRows).toBe(
      forensicInput.policyStubs.reduce((n, s) => n + s.adds + s.dels, 0)
    );
    expect(m.policyStubBytes).toBe(forensicInput.policyStubs.reduce((n, s) => n + s.bytes, 0));
    // eligibleFiles dropped by exactly the two stubbed files (was 6).
    expect(m.eligibleFiles).toBe(4);
    // eligibleDiffBytes is exactly the remaining verbatim diff.
    expect(m.eligibleDiffBytes).toBe(Buffer.byteLength(forensicInput.diff, 'utf8'));
  });

  it('four buckets remain mutually exclusive and sum to the changed-file total', () => {
    const { dossier, forensicInput } = buildDossier(makeInput({ stubPaths: ['src/beta.ts'] }));
    const m = forensicInput.metrics;
    // beta is verbatim no longer; alpha/gamma still are.
    expect(forensicInput.diff).not.toContain('b/src/beta.ts');
    expect(forensicInput.diff).toContain('b/src/alpha.ts');
    expect(m.policyStubFiles).toBe(1);
    const changed = new Set(parseFileSections(DIFF).map((s) => s.path)).size;
    expect(m.eligibleFiles + m.excludedFiles + m.unreviewableFiles + m.policyStubFiles).toBe(
      changed
    );
    // A stubbed file appears in NO other bucket.
    expect(forensicInput.excludedPaths).not.toContain('src/beta.ts');
    expect(forensicInput.unreviewablePaths).not.toContain('src/beta.ts');
    // The dossier file_index still enumerates the stubbed file (attribution
    // and floor membership are unchanged).
    expect(dossier.file_index.some((f) => f.path === 'src/beta.ts')).toBe(true);
  });

  it('stubbed bytes do NOT count against the transport ceiling: an over-ceiling diff whose bulk is stubbed mints a payload', () => {
    const bigBody = Array.from(
      { length: 400 },
      (_, i) => `+CORPUS_LINE_${i} committed fixture row`
    );
    const diff = [
      'diff --git a/src/small.ts b/src/small.ts',
      '--- a/src/small.ts',
      '+++ b/src/small.ts',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+const x = 1;',
      'diff --git a/fixtures/corpus.jsonl b/fixtures/corpus.jsonl',
      '--- a/fixtures/corpus.jsonl',
      '+++ b/fixtures/corpus.jsonl',
      `@@ -1,1 +1,${bigBody.length + 1} @@`,
      ' seed',
      ...bigBody,
      '',
    ].join('\n');
    // Without a policy the diff is over a tiny ceiling → refusal.
    expect(() =>
      buildDossier(makeInput({ retainedDiff: diff, forensicTransportCeilingBytes: 500 }))
    ).toThrow(ForensicTransportCeilingError);
    // Stub the corpus → the post-stub eligible diff fits → a payload is minted.
    const { forensicInput } = buildDossier(
      makeInput({
        retainedDiff: diff,
        forensicTransportCeilingBytes: 500,
        stubPaths: ['fixtures/**'],
      })
    );
    expect(forensicInput.metrics.eligibleDiffBytes).toBeLessThanOrEqual(500);
    expect(forensicInput.diff).toContain('b/src/small.ts');
    expect(forensicInput.diff).not.toContain('fixtures/corpus.jsonl');
    expect(forensicInput.policyStubs.map((s) => s.path)).toEqual(['fixtures/corpus.jsonl']);
    expect(forensicInput.metrics.policyStubBytes).toBeGreaterThan(500);
  });

  it('zero-config invariance: no policy ⇒ byte-identical forensic diff payload', () => {
    const none = buildDossier(makeInput()).forensicInput;
    const emptyArr = buildDossier(makeInput({ stubPaths: [] })).forensicInput;
    // The transport payload (the verbatim diff) is byte-identical.
    expect(emptyArr.diff).toBe(none.diff);
    expect(emptyArr.metrics.eligibleDiffBytes).toBe(none.metrics.eligibleDiffBytes);
    expect(emptyArr.policyStubs).toEqual([]);
    expect(none.policyStubs).toEqual([]);
    // A non-matching policy also leaves the payload untouched.
    const nomatch = buildDossier(makeInput({ stubPaths: ['does/not/**/exist'] })).forensicInput;
    expect(nomatch.diff).toBe(none.diff);
    expect(nomatch.metrics.eligibleDiffBytes).toBe(none.metrics.eligibleDiffBytes);
  });

  it('malformed policy fails LOUDLY at routine-start (StubPolicyError), no payload minted', () => {
    // Empty entry — picomatch (the repo's path matcher) rejects it, so the
    // routine refuses rather than treat "" as match-everything.
    let thrown: unknown;
    try {
      buildDossier(makeInput({ stubPaths: ['src/**', ''] }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(StubPolicyError);
    const err = thrown as StubPolicyError;
    expect(err.code).toBe('STUB_POLICY_INVALID');
    expect(err.invalidPatterns).toEqual(['']);
    // The valid sibling is not blamed.
    expect(err.invalidPatterns).not.toContain('src/**');
    // A non-string that slipped past config typing is also caught defensively.
    expect(() => buildDossier(makeInput({ stubPaths: [42 as unknown as string] }))).toThrow(
      StubPolicyError
    );
  });

  it('invalidStubPatterns flags empty + non-string, accepts valid globs', () => {
    expect(invalidStubPatterns(['a/**', 'b/*.ts', 'exact/path.json'])).toEqual([]);
    expect(invalidStubPatterns(['', 'ok/**'])).toEqual(['']);
    expect(invalidStubPatterns([null as unknown as string])).toEqual([null as unknown as string]);
  });

  it('the refusal envelope names review.stub_paths as a remedy', () => {
    let thrown: unknown;
    try {
      buildDossier(
        makeInput({ retainedDiff: makeInput().retainedDiff, forensicTransportCeilingBytes: 1 })
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForensicTransportCeilingError);
    expect((thrown as Error).message).toContain('review.stub_paths');
  });
});

describe('dossier — account corpus ceiling refuses before anything is written', () => {
  /** A floor whose protected corpus alone blows past the 1 MB account ceiling. */
  const hugeCorpusFloor = (): Floor => {
    const floor = structuredClone(buildReviewFloorFixture('clean').floor);
    floor.scope.branch = 'demo';
    floor.scope.branch_slug = 'demo';
    // A checkpoint summary is protected corpus and carries no citation-id
    // grammar, so the floor still round-trips through `floorSchema`.
    const cp = floor.outline.threads[0]!.checkpoints[0]!;
    (cp as { summary: string | null }).summary = `oversized summary ${'x'.repeat(1_100_000)}`;
    return floor;
  };

  it('buildDossier refuses with a bytes envelope before it returns anything', () => {
    let thrown: unknown;
    try {
      buildDossier(makeInput({ floor: hugeCorpusFloor() }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AccountCorpusCeilingError);
    const refusal = thrown as AccountCorpusCeilingError;
    expect(refusal.code).toBe('ACCOUNT_CORPUS_CEILING');
    expect(refusal.ceilingBytes).toBe(ACCOUNT_CORPUS_CEILING_BYTES);
    expect(refusal.actualBytes).toBeGreaterThan(ACCOUNT_CORPUS_CEILING_BYTES);
  });

  it('mints no artifact at all: the review dir is untouched and the verb returns a parseable envelope', async () => {
    // The refusal lands BEFORE the first write. `buildDossier` throws, so
    // `buildAndWriteDossier`'s five `atomicWriteFile` calls never run, the
    // composite verb never reaches `runTwolaneRun`, no run is minted, and no
    // model call is spent. Driven through the real CLI verb rather than the
    // pure builder, because "nothing is written" is a property of that path.
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-account-ceiling-'));
    const out: string[] = [];
    try {
      const dir = path.join(root, '.orcaops', 'reviews', 'demo');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'floor.json'), JSON.stringify(hugeCorpusFloor()));
      await writeFile(path.join(dir, 'diff.patch'), DIFF);
      await writeFile(
        path.join(dir, 'floor-cache.json'),
        JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: 'fp' })
      );
      const before = (await readdir(dir)).sort();

      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const code = await runDossier(
        { cmd: 'review', sub: 'dossier', branch: 'demo', json: true } as ReviewArgs,
        root
      );
      vi.restoreAllMocks();
      expect(code).toBe(1);
      const envelope = JSON.parse(out.join('')) as {
        ok: boolean;
        error: { code: string; ceiling_bytes: number; actual_bytes: number; message: string };
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('ACCOUNT_CORPUS_CEILING');
      expect(envelope.error.ceiling_bytes).toBe(ACCOUNT_CORPUS_CEILING_BYTES);
      expect(envelope.error.actual_bytes).toBeGreaterThan(ACCOUNT_CORPUS_CEILING_BYTES);
      expect(envelope.error.message).toContain('no payload minted');

      // Nothing was minted: no dossier, no projection, no forensic input, no
      // coverage snapshot, no run record.
      expect((await readdir(dir)).sort()).toEqual(before);
      for (const f of [
        'dossier-v1.json',
        'dossier.md',
        'account-projection-v1.json',
        'forensic-input-v1.json',
        'coverage-v1.json',
        'run-v1.json',
      ]) {
        expect(existsSync(path.join(dir, f))).toBe(false);
      }
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('dossier — the configured exclude set reaches the CLI entry point', () => {
  const setupReviewDir = async (): Promise<{ root: string; branch: string }> => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-dossier-exclude-'));
    const fixture = buildReviewFloorFixture('clean').floor;
    const branch = fixture.scope.branch;
    const dir = path.join(root, '.orcaops', 'reviews', fixture.scope.branch_slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'review-state.json'),
      `${JSON.stringify({ review_state_version: REVIEW_STATE_VERSION })}\n`
    );
    await writeFile(path.join(dir, 'floor.json'), JSON.stringify(fixture));
    await writeFile(
      path.join(dir, 'diff.patch'),
      [
        'diff --git a/src/fixture.ts b/src/fixture.ts',
        '--- a/src/fixture.ts',
        '+++ b/src/fixture.ts',
        '@@ -1,0 +1 @@',
        '+stable fixture row',
        'diff --git a/.env b/.env',
        '--- a/.env',
        '+++ b/.env',
        '@@ -1,0 +1 @@',
        '+DEPLOY_SECRET=must-not-reach-the-reviewer',
        '',
      ].join('\n')
    );
    await writeFile(
      path.join(dir, 'floor-cache.json'),
      JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: 'original' })
    );
    return { root, branch };
  };

  it('withholds a built-in excluded path from the dossier the CLI produces', async () => {
    // Asserted through buildAndWriteDossier on purpose: buildDossier accepts
    // excludePaths, so an entry point that never passes it leaves the exclusion
    // dead in production while a buildDossier-level test still passes.
    const { root, branch } = await setupReviewDir();
    try {
      const result = await buildAndWriteDossier(root, branch, 'routine');
      expect(result.forensicInput.diff).toContain('stable fixture row');
      // EVERY payload, not just the forensic diff. Applied at the
      // eligible-diff sink alone, the exclusion leaves dossier-v1.json and the
      // account projection carrying the file in full, which an assertion over
      // one clean payload cannot see.
      const payloads: Record<string, unknown> = {
        'forensicInput.diff': result.forensicInput.diff,
        'dossier-v1.json': result.dossier,
        'account projection': result.accountProjection,
        markdown: result.markdown,
      };
      for (const [name, payload] of Object.entries(payloads)) {
        const serialized = JSON.stringify(payload) ?? '';
        expect(serialized, `${name} carries the excluded path`).not.toContain('DEPLOY_SECRET');
        expect(serialized, `${name} carries the excluded path`).not.toContain(
          'must-not-reach-the-reviewer'
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts a credential in a NON-excluded file from every payload', async () => {
    // The scrub shares the exclusion's single-sink hazard: a recognized secret
    // in an ordinary file can leave the forensic diff and still sit in
    // code_index and the account projection.
    const TOKEN = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-dossier-scrub-'));
    const fixture = buildReviewFloorFixture('clean').floor;
    const dir = path.join(root, '.orcaops', 'reviews', fixture.scope.branch_slug);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'review-state.json'),
        `${JSON.stringify({ review_state_version: REVIEW_STATE_VERSION })}\n`
      );
      await writeFile(path.join(dir, 'floor.json'), JSON.stringify(fixture));
      await writeFile(
        path.join(dir, 'diff.patch'),
        [
          'diff --git a/src/deploy.ts b/src/deploy.ts',
          '--- a/src/deploy.ts',
          '+++ b/src/deploy.ts',
          '@@ -1,0 +1 @@',
          `+const apiKey = '${TOKEN}';`,
          '',
        ].join('\n')
      );
      await writeFile(
        path.join(dir, 'floor-cache.json'),
        JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: 'original' })
      );
      const result = await buildAndWriteDossier(root, fixture.scope.branch, 'routine');
      for (const [name, payload] of Object.entries({
        'forensicInput.diff': result.forensicInput.diff,
        'dossier-v1.json': result.dossier,
        'account projection': result.accountProjection,
      })) {
        expect(JSON.stringify(payload) ?? '', `${name} carries the token`).not.toContain(TOKEN);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to mint a payload when the exclude policy is malformed', () => {
    // Reachable only defensively: the config schema types capture.exclude as
    // non-empty strings and picomatch accepts nearly any shape, so a pattern
    // that survives loadConfig and still fails validation should not exist.
    // The guard is here because a hole in a security control must be loud if
    // one ever does, and because resolveCaptureExcludes drops such a pattern
    // by contract rather than throwing.
    const err = new ExcludePolicyError(['']);
    expect(err.code).toBe('CAPTURE_EXCLUDE_INVALID');
    expect(err.invalidPatterns).toEqual(['']);
    expect(err.message).toContain('capture.exclude');
    expect(err.message).toContain('no payload minted');
  });
});

describe('dossier publication', () => {
  it('refuses to publish when the floor changes while waiting for review state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-dossier-lock-'));
    const fixture = buildReviewFloorFixture('clean').floor;
    const branch = fixture.scope.branch;
    const slug = fixture.scope.branch_slug;
    const dir = path.join(root, '.orcaops', 'reviews', slug);
    const locksDir = path.join(root, '.orcaops', 'tmp', 'locks');
    const lock = new ArtifactLock({ locksDir, containmentRoot: root });
    let markAcquired!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'review-state.json'),
        `${JSON.stringify({ review_state_version: REVIEW_STATE_VERSION })}\n`
      );
      await writeFile(path.join(dir, 'floor.json'), JSON.stringify(fixture));
      await writeFile(
        path.join(dir, 'diff.patch'),
        [
          'diff --git a/src/fixture.ts b/src/fixture.ts',
          '--- a/src/fixture.ts',
          '+++ b/src/fixture.ts',
          '@@ -1,0 +1 @@',
          '+stable fixture row',
          '',
        ].join('\n')
      );
      await writeFile(
        path.join(dir, 'floor-cache.json'),
        JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: 'original' })
      );

      const held = lock.withLock(reviewStateLockKey(slug), async () => {
        markAcquired();
        await blocked;
      });
      await acquired;
      const pending = buildAndWriteDossier(root, branch, 'routine');
      const state = await Promise.race([
        pending.then(
          () => 'completed' as const,
          () => 'completed' as const
        ),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100)),
      ]);
      expect(state).toBe('waiting');
      await writeFile(
        path.join(dir, 'floor-cache.json'),
        JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: 'changed' })
      );
      release();
      await held;

      await expect(pending).rejects.toThrow(
        'review floor changed while the dossier was being built'
      );
      expect(existsSync(path.join(dir, 'dossier-v1.json'))).toBe(false);
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('dossier — the agent-facing payload is scrubbed and stubbed', () => {
  const TOKEN = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';

  const diffWithToken = (): string =>
    DIFF.replace('+const sharedIdent = compute(2);', `+const apiKey = "${TOKEN}";`);

  it('redacts a credential out of the forensic payload', () => {
    const built = buildDossier(makeInput({ retainedDiff: diffWithToken() }));
    expect(built.forensicInput.diff).not.toContain(TOKEN);
    expect(built.forensicInput.diff).toContain('[REDACTED_SECRET]');
  });

  it('anchors retained_diff_hash to the diff it was handed, not the scrubbed payload', () => {
    // `diff.patch` on disk is the integrity anchor for manifest verification
    // and reviewer identity keys. Only the payload is scrubbed, so the recorded
    // hash must be over the bytes as handed in.
    const raw = diffWithToken();
    const built = buildDossier(makeInput({ retainedDiff: raw }));
    const sha16 = (text: string): string =>
      createHash('sha256').update(text).digest('hex').slice(0, 16);
    expect(built.forensicInput.diff).not.toBe(raw);
    expect(built.dossier.retained_diff_hash).toBe(sha16(raw));
    expect(built.dossier.retained_diff_hash).not.toBe(sha16(built.forensicInput.diff));
  });

  it('preserves line count and the sign column, so ranges still resolve', () => {
    const built = buildDossier(makeInput({ retainedDiff: diffWithToken() }));
    const clean = buildDossier(makeInput());
    expect(built.forensicInput.diff.split('\n')).toHaveLength(
      clean.forensicInput.diff.split('\n').length
    );
    for (const line of built.forensicInput.diff.split('\n')) {
      if (line.includes('[REDACTED_SECRET]')) expect(line.startsWith('+')).toBe(true);
    }
  });

  it('holds a capture.exclude match out of the payload and discloses it as a stub', () => {
    const built = buildDossier(makeInput({ excludePaths: ['src/beta.ts'] }));
    expect(built.forensicInput.diff).not.toContain('beta context');
    const stub = built.forensicInput.policyStubs.find((s) => s.path === 'src/beta.ts');
    expect(stub?.reason).toBe('capture.exclude');
  });

  it('reports capture.exclude rather than review.stub_paths when a file matches both', () => {
    // One is a security control with built-in defaults, the other a
    // corpus-size tool. The reason shown should explain why it may not be read.
    const built = buildDossier(
      makeInput({ excludePaths: ['src/beta.ts'], stubPaths: ['src/beta.ts'] })
    );
    const stub = built.forensicInput.policyStubs.find((s) => s.path === 'src/beta.ts');
    expect(stub?.reason).toBe('capture.exclude');
  });

  it('leaves a clean diff untouched', () => {
    const built = buildDossier(makeInput());
    expect(built.forensicInput.diff).not.toContain('[REDACTED_SECRET]');
  });
});
