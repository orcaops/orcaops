import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor, cacheDbPath } from './paths.js';
import { ArtifactStore } from './store.js';
import { canonicalJson } from '../events/canonical-json.js';
import { type Config, getDefaultConfig } from '../schema/config.js';
import type { Plan } from '../schema/plan.js';

/**
 * Auto-carry acceptance-criterion identity on plan revise. When a revision
 * re-states an UNCHANGED criterion but OMITS its criterion_id, the store
 * reconciles the prior id (carries it) instead of minting a fresh one. This
 * stops the phantom "all-removed + all-added" churn and prevents orphaning the
 * done_criteria evidence keyed to that id. Identity for changed text is still
 * minted (no unsafe reconciliation key). A same-key retry that re-omits the
 * same text replays rather than false-conflicting (the `added ∪ carried`
 * extract).
 */
describe('acceptance-criterion identity auto-carry on plan revise', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'fix/criterion-id-auto-carry';
  const artifactId = '01999999-9999-7000-8000-0000000000ca';
  const STEP_A = '01HX0K8N6ZQF8M5R2V8DZ7T3KA';
  const STEP_B = '01HX0K8N6ZQF8M5R2V8DZ7T3KB';
  const CRIT_A1 = '01HX0K8N6ZQF8M5R2V8DZ7TCA1';
  const CRIT_A2 = '01HX0K8N6ZQF8M5R2V8DZ7TCA2';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  type CritInput = { criterion_id?: string; text: string };
  type ReviseResult = Awaited<ReturnType<ArtifactStore['revisePlan']>>;

  /** Initial plan: STEP_A carries the supplied criteria, STEP_B has none. */
  async function writeInitialPlan(
    stepACriteria: Array<{ criterion_id: string; text: string }>
  ): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'base000',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'deliver the slice',
        label: 'initial-label',
        plan_steps: [
          {
            step_id: STEP_A,
            text: 'step a text',
            label: 'step-a',
            acceptance_criteria: stepACriteria,
          },
          { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-05-31T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'init' }
    );
  }

  /** Revise STEP_A with the given criteria. Returns the raw three-outcome result. */
  async function reviseRaw(
    stepACriteria: CritInput[],
    opts: { ack?: string[]; key?: string } = {}
  ): Promise<ReviseResult> {
    const key = opts.key ?? 'rev-1';
    return store.revisePlan(
      {
        idempotency_key: key,
        artifact_id: artifactId,
        label: 'revised-label',
        plan_steps: [
          {
            step_id: STEP_A,
            text: 'step a text',
            label: 'step-a',
            acceptance_criteria: stepACriteria,
          },
          { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        rationale: 're-state criteria while preserving the step obligation',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: opts.ack ?? [],
      },
      { idempotencyKey: key }
    );
  }

  function planOf(res: ReviseResult): Plan {
    if (res.outcome === 'conflict') throw new Error('unexpected idempotency conflict in test');
    return res.plan;
  }

  async function revise(
    stepACriteria: CritInput[],
    opts: { ack?: string[]; key?: string } = {}
  ): Promise<Plan> {
    return planOf(await reviseRaw(stepACriteria, opts));
  }

  const critIds = (plan: Plan, stepIdx = 0): string[] =>
    plan.plan_steps[stepIdx].acceptance_criteria.map((c) => c.criterion_id);

  // ── carry / mint behavior ──────────────────────────────────────────

  it('omit-identical → carries the prior criterion_id (zero lineage churn)', async () => {
    await writeInitialPlan([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }]);
    const plan = await revise([{ text: 'suite has >= 42 tests' }]); // omit id, identical text
    expect(plan.plan_steps[0].acceptance_criteria).toEqual([
      { criterion_id: CRIT_A1, text: 'suite has >= 42 tests' },
    ]);
    expect(plan.criterion_lineage.carried).toEqual([CRIT_A1]);
    expect(plan.criterion_lineage.added).toEqual([]);
    expect(plan.criterion_lineage.removed).toEqual([]);
    expect(plan.criterion_lineage.rewritten).toEqual([]);
  });

  it('omit-reworded → mints a fresh id and records the prior in removed', async () => {
    await writeInitialPlan([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }]);
    const plan = await revise([{ text: 'suite has a couple smoke tests' }]); // omit id, CHANGED text
    const got = plan.plan_steps[0].acceptance_criteria;
    expect(got).toHaveLength(1);
    expect(got[0].criterion_id).not.toBe(CRIT_A1); // minted, not carried
    expect(got[0].text).toBe('suite has a couple smoke tests');
    expect(plan.criterion_lineage.added).toEqual([got[0].criterion_id]);
    expect(plan.criterion_lineage.carried).toEqual([]);
    expect(plan.criterion_lineage.removed).toEqual([
      { criterion_id: CRIT_A1, prior_step_id: STEP_A, text: 'suite has >= 42 tests' },
    ]);
  });

  it('duplicate-text criteria carry FIFO; an extra omit mints (no duplicate-id throw)', async () => {
    await writeInitialPlan([
      { criterion_id: CRIT_A1, text: 'dup' },
      { criterion_id: CRIT_A2, text: 'dup' },
    ]);
    // omit three 'dup' entries: first two carry A1, A2 in declaration order; third mints.
    const plan = await revise([{ text: 'dup' }, { text: 'dup' }, { text: 'dup' }]);
    const got = plan.plan_steps[0].acceptance_criteria;
    expect(got).toHaveLength(3);
    expect(got[0].criterion_id).toBe(CRIT_A1);
    expect(got[1].criterion_id).toBe(CRIT_A2);
    expect(got[2].criterion_id).not.toBe(CRIT_A1);
    expect(got[2].criterion_id).not.toBe(CRIT_A2);
    expect(got.every((c) => c.text === 'dup')).toBe(true);
    expect(plan.criterion_lineage.carried).toEqual([CRIT_A1, CRIT_A2]);
    expect(plan.criterion_lineage.added).toEqual([got[2].criterion_id]);
  });

  it('mixed supplied+omitted (explicit first): omitted grabs the OTHER prior id', async () => {
    await writeInitialPlan([
      { criterion_id: CRIT_A1, text: 'dup' },
      { criterion_id: CRIT_A2, text: 'dup' },
    ]);
    const plan = await revise([{ criterion_id: CRIT_A1, text: 'dup' }, { text: 'dup' }]);
    expect(critIds(plan)).toEqual([CRIT_A1, CRIT_A2]); // omitted carried A2, never the supplied A1
    expect(plan.criterion_lineage.carried).toEqual([CRIT_A2]);
    expect(plan.criterion_lineage.added).toEqual([]);
  });

  it('mixed supplied+omitted (omitted first): Pass-A reservation prevents stealing the supplied id', async () => {
    await writeInitialPlan([
      { criterion_id: CRIT_A1, text: 'dup' },
      { criterion_id: CRIT_A2, text: 'dup' },
    ]);
    // Omitted entry comes first. Without reserving the explicit A1 BEFORE the
    // omit-scan, the omit would grab A1 and the later explicit A1 would mint a
    // duplicate id → PlanSchema.superRefine throw. Two-pass prevents that.
    const plan = await revise([{ text: 'dup' }, { criterion_id: CRIT_A1, text: 'dup' }]);
    expect(critIds(plan)).toEqual([CRIT_A2, CRIT_A1]); // omitted carried A2
    expect(new Set(critIds(plan)).size).toBe(2); // distinct, no duplicate
    expect(plan.criterion_lineage.carried).toEqual([CRIT_A2]);
    expect(plan.criterion_lineage.added).toEqual([]);
  });

  // ── replay determinism ─────────────────────────────────────────────

  it('replay determinism: same-key re-omit of an auto-carry REPLAYS; changed text CONFLICTS', async () => {
    await writeInitialPlan([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }]);
    const KEY = 'carry-replay';
    const first = await reviseRaw([{ text: 'suite has >= 42 tests' }], { key: KEY });
    expect(first.outcome).toBe('created');
    expect(planOf(first).criterion_lineage.carried).toEqual([CRIT_A1]);

    // Same key + same omitted payload → replay. The carried id is concrete in
    // the committed plan but absent from `added`, so without the
    // `added ∪ carried` extract the retry would null it and false-conflict.
    const replay = await reviseRaw([{ text: 'suite has >= 42 tests' }], { key: KEY });
    expect(replay.outcome).toBe('replay');
    expect(critIds(planOf(replay))).toEqual([CRIT_A1]);

    // Same key, CHANGED criterion text → genuine conflict.
    const conflict = await reviseRaw([{ text: 'suite has >= 9000 tests' }], { key: KEY });
    expect(conflict.outcome).toBe('conflict');
  });

  it('a plan_revised event missing criterion_lineage.carried fails the strict rebuild with the field path', async () => {
    // Reproduce the on-disk shape of an event written before the `carried`
    // key existed. Launch-written artifacts can never produce it (every
    // writer materializes all four members), so the strict cut demands it
    // fail loudly at rebuild instead of silently healing to [].
    await writeInitialPlan([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }]);
    const KEY = 'old-event';
    const reviseInput = [
      { criterion_id: CRIT_A1, text: 'suite has >= 42 tests' },
      { text: 'a freshly minted criterion' },
    ];
    const first = await reviseRaw(reviseInput, { key: KEY });
    expect(first.outcome).toBe('created');
    const mintedId = planOf(first).plan_steps[0].acceptance_criteria[1].criterion_id;
    expect(planOf(first).criterion_lineage.added).toEqual([mintedId]);
    expect(planOf(first).criterion_lineage.carried).toEqual([]);

    // Strip the key from the plan_revised event's criterion_lineage on disk.
    const paths = artifactPathsFor(repo.path, config, artifactId);
    const lines = (await readFile(paths.eventsNdjson, 'utf8'))
      .split('\n')
      .filter((l) => l.trim().length > 0);
    let stripped = false;
    const rewritten = lines.map((line) => {
      const ev = JSON.parse(line) as {
        type?: string;
        checksum?: string;
        payload?: { criterion_lineage?: Record<string, unknown> };
      };
      if (ev.type === 'plan_revised' && ev.payload?.criterion_lineage?.carried !== undefined) {
        delete ev.payload.criterion_lineage.carried;
        // Re-sign the line exactly as any writer does: the
        // per-line checksum is SHA-256 over the canonical JSON of the record
        // minus `checksum`. Without re-signing, the loader treats the line as
        // corrupt and silently drops it, so the extract would never see the
        // carried-less event this test exists to exercise.
        const recordForChecksum: Record<string, unknown> = { ...ev };
        delete recordForChecksum.checksum;
        ev.checksum = createHash('sha256')
          .update(canonicalJson(recordForChecksum), 'utf8')
          .digest('hex');
        stripped = true;
      }
      return JSON.stringify(ev);
    });
    expect(stripped).toBe(true); // sanity: a carried key was actually present and removed
    await writeFile(paths.eventsNdjson, rewritten.join('\n') + '\n', 'utf8');

    // Retrying forces a plan rebuild over the doctored event: the strict
    // CriterionLineageSchema rejects the omission by field path rather
    // than default-filling an empty carried list.
    await expect(reviseRaw(reviseInput, { key: KEY })).rejects.toThrow(
      /criterion_lineage[\s\S]*carried/
    );
  });

  it('carried round-trips through readPlanRevision for a non-latest revision', async () => {
    await writeInitialPlan([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }]);
    await revise([{ text: 'suite has >= 42 tests' }], { key: 'rev1' }); // rev 1: carry
    // A second revise makes revision 1 non-current, exercising historical
    // reconstruction rather than the latest-revision fast path.
    await revise([{ text: 'suite has >= 42 tests' }], { key: 'rev2' }); // rev 2
    const rev1 = await store.readPlanRevision(artifactId, 1);
    expect(rev1?.criterion_lineage.carried).toEqual([CRIT_A1]);
    expect(rev1?.revision_n).toBe(1);
  });

  it('readPlanRevision fails loudly on a carried-less stored plans row and directs a rebuild', async () => {
    await writeInitialPlan([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }]);
    await revise([{ text: 'suite has >= 42 tests' }], { key: 'rev1' }); // rev 1: carry [CRIT_A1]
    await revise([{ text: 'suite has >= 42 tests' }], { key: 'rev2' }); // rev 2: rev 1 now non-latest

    // Simulate a pre-change row: strip the `carried` key from rev 1's stored
    // criterion_lineage JSON directly in the cache DB. Migration 016 defaulted old
    // rows to {added,removed,rewritten} with NO `carried` key, so this is the real
    // on-disk shape an upgraded install reads back. SQLite rows carry no per-line
    // checksum, so (unlike the events.ndjson test above) no re-sign is needed.
    const db = new Database(cacheDbPath(repo.path, config));
    try {
      const row = db
        .prepare('SELECT criterion_lineage FROM plans WHERE artifact_id = ? AND revision_n = 1')
        .get(artifactId) as { criterion_lineage: string };
      const lineage = JSON.parse(row.criterion_lineage) as Record<string, unknown>;
      expect(lineage.carried).toEqual([CRIT_A1]); // sanity: a carried key was present to strip
      delete lineage.carried;
      db.prepare(
        'UPDATE plans SET criterion_lineage = ? WHERE artifact_id = ? AND revision_n = 1'
      ).run(JSON.stringify(lineage), artifactId);
    } finally {
      db.close();
    }

    // The cache row is regenerable, so silently healing it into an empty
    // carried list would let a damaged or pre-cut row resolve as an exact
    // open revision. The strict read refuses and points at the fix.
    await expect(store.readPlanRevision(artifactId, 1)).rejects.toThrow(
      /criterion_lineage[\s\S]*orcaops rebuild/
    );
  });

  // ── open-cp acknowledgement: no false demand on an unchanged criterion ──

  it('omit-identical on an OPEN-cp step resolves WITHOUT acknowledge_criteria_changes', async () => {
    await writeInitialPlan([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }]);
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_A] },
      { idempotencyKey: 'cp-open', headSha: 'base000' }
    );
    // Without auto-carry this mints+drops → lands in `removed` → the open-cp
    // gate demands an ack for a rubric that never changed. Auto-carry keeps the
    // id, so no ack is demanded.
    const plan = await revise([{ text: 'suite has >= 42 tests' }]); // no ack
    expect(plan.criterion_lineage.carried).toEqual([CRIT_A1]);
    expect(plan.criterion_lineage.removed).toEqual([]);
    expect(plan.criterion_lineage.rewritten).toEqual([]);
  });

  // ── Core motivation: recorded evidence survives the carry (integration) ──

  it('evidence-survival: recorded done_criteria still resolve to a live criterion after omit-identical revise', async () => {
    await writeInitialPlan([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }]);
    // Close a cp on STEP_A, recording evidence keyed to CRIT_A1.
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_A] },
      { idempotencyKey: 'cp-open', headSha: 'base000' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'delivered step a with 42 tests',
        files_changed: ['a.test.ts'],
        decisions: [],
        uncertainty: ['n/a'],
        done_criteria: [{ criterion_id: CRIT_A1, evidence: '42 tests added in a.test.ts' }],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_A],
        head_sha: 'base000',
      },
      { idempotencyKey: 'cp-close' }
    );

    // A later revise re-states the criterion with an omitted id.
    const plan = await revise([{ text: 'suite has >= 42 tests' }]);

    // The join key survives: CRIT_A1 is still a live criterion in the latest
    // plan, so the recorded evidence (keyed to CRIT_A1) still resolves; a
    // re-mint would orphan it. (Documentation/integration, not a new
    // gate: the id-churn boundary itself is held by the carry + replay tests.)
    const liveIds = new Set(
      plan.plan_steps.flatMap((s) => s.acceptance_criteria.map((c) => c.criterion_id))
    );
    expect(liveIds.has(CRIT_A1)).toBe(true);

    const cp = await store.readCheckpoint(artifactId, 1);
    const evidenceIds = cp?.status === 'closed' ? cp.done_criteria.map((d) => d.criterion_id) : [];
    expect(evidenceIds).toContain(CRIT_A1);
    for (const id of evidenceIds) {
      expect(liveIds.has(id)).toBe(true); // every recorded evidence id still resolves to a live criterion
    }
  });
});
