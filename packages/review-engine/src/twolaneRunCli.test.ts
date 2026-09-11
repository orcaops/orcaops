// The two-lane run lifecycle end to end over a captured review: ordering,
// routine caps, one repair per lane, the honest terminal record, and the
// envelopes automated callers parse. The run's state is retained rows, so every
// assertion here reads what the verbs emit or what the store retained — never a
// run file.

import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { projectDatabasePath } from '@orcaops/storage/history/database';

import { deriveReviewOperationId } from './database/review-operation.js';
import { type ForensicInput } from './dossier.js';
import { REVIEW_USAGE, runReview } from './run.js';
import type { ReviewRuntimeDescriptor } from './runtimeIdentity.js';
import { canonicalJsonSha256, normalizeSubmission } from './submissionNormalization.js';
import {
  LANE_CONTRACTS,
  latencyProfileFor,
  latencyTierFor,
  ownershipSummaryFromComposed,
  renderForensicRoutineMd,
  ROUTINE_ORDER_MESSAGE,
  runTwolaneRun,
} from './twolaneRunCli.js';
import {
  capturedReviewFixture,
  type CapturedReviewFixture,
} from '../tests/capturedReviewFixture.js';

const CONSTANTS_FIX = path.join(__dirname, '..', 'fixtures', 'twolane-cli-constants.json');

let fixture: CapturedReviewFixture;
let runtime: ReviewRuntimeDescriptor;
let out: string[];
let err: string[];

const run = (argv: string[]): Promise<number> =>
  runReview(
    ['review', ...argv, '--branch', fixture.branch, '--root', fixture.gitRoot, '--json'],
    process.env,
    undefined,
    runtime
  );

/** Last parseable JSON line the verb printed (emit() writes are atomic lines). */
const lastJson = (): Record<string, unknown> => {
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const line = out[i]!.trim();
    if (line.startsWith('{')) return JSON.parse(line) as Record<string, unknown>;
  }
  throw new Error(`no JSON output captured; stderr: ${err.join('')}`);
};

/** A finding on a file the fixture's reviewed diff actually carries. */
const forensicOk = () => ({
  findings: [
    {
      claim: 'The change flips a persisted default without a behavioural guard.',
      file: 'src/limiter.ts',
      related_files: [],
      severity: 'CAUTION',
      confidence: 'HIGH',
    },
  ],
  questions: [],
});

/**
 * A full Story over the SERVED account payload: the engine issues the k#/c#
 * aliases in the markdown it serves, so the story is authored against those
 * rather than against a second projection of the same run.
 */
function accountOk(markdown: string) {
  const checkpoints = [...markdown.matchAll(/^#### (k\d+) ·/gm)].map((match) => match[1]!);
  const citation = /\[(c\d+)\]/.exec(markdown)?.[1];
  expect(checkpoints.length, 'the served payload lists at least one checkpoint').toBeGreaterThan(0);
  expect(citation, 'the served payload carries a citable alias').toBeDefined();
  return {
    schema_version: 1 as const,
    overview: {
      text: 'The branch carries one coherent change from captured intent through implementation.',
      citations: [citation!],
    },
    acts: [
      {
        title: 'The change',
        interpretation: 'One causal arc.',
        parts: checkpoints.map((alias, index) => ({
          title: `Part ${index + 1}`,
          checkpoints: [alias],
          interpretation: `Part ${index + 1} advances the change.`,
          citations: [citation!],
        })),
      },
    ],
    questions: [] as unknown[],
  };
}

beforeAll(async () => {
  fixture = await capturedReviewFixture({ autoCleanup: false });
  await fixture.publishFloor();
  runtime = await fixture.runtimeDescriptor();
}, 300_000);

afterAll(async () => {
  await fixture.cleanup();
});

beforeEach(() => {
  vi.stubEnv('ORCAOPS_DATA_DIR', fixture.dataRoot);
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  };
});

async function payloadFile(name: string, value: unknown): Promise<string> {
  const file = path.join(fixture.root, name);
  await writeFile(file, JSON.stringify(value, null, 1));
  return file;
}

async function startRun(): Promise<string> {
  expect(await run(['start'])).toBe(0);
  return lastJson().run_id as string;
}

const submit = (runId: string, lane: string, file: string) =>
  run([
    'lane-submit',
    '--run',
    runId,
    '--lane',
    lane,
    '--isolation',
    'sequential',
    '--input',
    file,
  ]);

/** Serve the account lane and return the markdown the reviewer would read. */
async function servedAccount(runId: string): Promise<string> {
  expect(await run(['lane-input', '--run', runId, '--lane', 'account'])).toBe(0);
  const envelope = lastJson();
  expect(envelope.contract).toEqual(LANE_CONTRACTS.account);
  return readFile(path.join(fixture.gitRoot, envelope.payload_path as string), 'utf8');
}

describe('routine two-lens run lifecycle', () => {
  it('enforces forensic-first ordering, routine caps, one repair, and an honest record', async () => {
    const executionProfile = {
      host: { value: 'test-host', provenance: 'HOST_REPORTED' },
      host_version: { value: '1.2.3', provenance: 'HOST_REPORTED' },
      model: { value: 'test-model', provenance: 'CALLER_DECLARED' },
      effort: null,
      launcher_mode: { value: 'test', provenance: 'EVALUATION_REGISTERED' },
      instruction_hash: null,
    };
    expect(await run(['start', '--execution-profile-json', JSON.stringify(executionProfile)])).toBe(
      0
    );
    const started = lastJson();
    const runId = started.run_id as string;
    expect(started.mode).toBe('routine');

    // Account context is engine-refused before the forensic lane is terminal.
    expect(await run(['lane-input', '--run', runId, '--lane', 'account'])).toBe(1);
    const refusal = lastJson();
    expect(refusal.ok).toBe(false);
    expect((refusal.error as { message: string }).message).toContain('TWOLANE_ROUTINE_ORDER');
    expect(await submit(runId, 'account', await payloadFile('premature.json', {}))).toBe(0);
    const refused = lastJson();
    expect(refused.accepted).toBe(false);
    expect((refused.diagnostics as { code: string }[])[0]!.code).toBe('TWOLANE_ROUTINE_ORDER');

    // The ordering refusal consumed no attempt.
    const databaseBeforeSemanticText = await readFile(projectDatabasePath(fixture.authority));
    expect(
      await runReview(
        [
          'review',
          'run-show',
          '--run',
          runId,
          '--semantic-input',
          '--branch',
          fixture.branch,
          '--root',
          fixture.gitRoot,
        ],
        process.env,
        undefined,
        runtime
      )
    ).toBe(2);
    expect(err.join('')).toContain('--semantic-input requires --json');
    expect(
      (await readFile(projectDatabasePath(fixture.authority))).equals(databaseBeforeSemanticText)
    ).toBe(true);
    expect(await run(['run-show', '--run', runId, '--semantic-input'])).toBe(0);
    expect(lastJson().semantic_anchor).toBeNull();
    expect(
      (lastJson().state as { lanes: { account: { attempts: number } } }).lanes.account.attempts
    ).toBe(0);

    // Forensic pass: readable line-oriented payload, contract with caps.
    expect(await run(['lane-input', '--run', runId, '--lane', 'forensic'])).toBe(0);
    const fInput = lastJson();
    expect(fInput.contract).toEqual(LANE_CONTRACTS.forensic);
    const fMd = await readFile(path.join(fixture.gitRoot, fInput.payload_path as string), 'utf8');
    expect(fMd.startsWith('# Forensic lane input')).toBe(true);
    expect(fMd).toContain('## Diff');
    expect(fMd).toContain('eligible file(s) rendered verbatim');

    // A payload over the routine caps is rejected deterministically.
    const overCap = {
      findings: Array.from({ length: 4 }, (_, i) => ({
        claim: `finding ${i}`,
        file: 'src/limiter.ts',
        related_files: [],
        severity: 'REVIEW',
        confidence: 'LOW',
      })),
      questions: [],
    };
    expect(await submit(runId, 'forensic', await payloadFile('o.json', overCap))).toBe(0);
    const rejected = lastJson();
    expect(rejected.accepted).toBe(false);
    expect(
      (rejected.diagnostics as { code: string }[]).some((d) => d.code === 'SLICE_ROUTINE_LIMITS')
    ).toBe(true);

    // Routine mode allows the forensic repair BEFORE the account initial
    // (parallel-mode ordering rules do not apply; order is engine-owned).
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    const repaired = lastJson();
    expect(repaired.accepted, JSON.stringify(repaired.diagnostics)).toBe(true);
    expect((repaired.state as { repair_credit: { forensic: number } }).repair_credit.forensic).toBe(
      0
    );

    // Account pass serves engine-issued aliases inline beside their records;
    // the canonical lookup stays private to compilation.
    const aMd = await servedAccount(runId);
    expect(aMd.startsWith('# Account lane input')).toBe(true);
    expect(aMd).not.toContain('## Prompt aliases');
    expect(aMd).toMatch(/#### k1 · \S+:cp\d+/);
    expect(aMd).toContain('Cite captured records with their inline [c#] aliases');
    expect(aMd).toContain('## Claim ledger');
    expect(aMd).not.toContain('## Changed-file inventory');

    expect(await submit(runId, 'account', await payloadFile('a.json', accountOk(aMd)))).toBe(0);
    expect(lastJson().accepted, JSON.stringify(lastJson().diagnostics)).toBe(true);

    expect(await run(['finalize', '--run', runId])).toBe(0);
    const finalized = lastJson();
    expect(finalized.outcome).toBe('FULL');
    const record = finalized.run_record as Record<string, unknown>;
    // The canonical run always pins its diff, so the Part-range round-trip runs.
    expect(record.range_validation).toBe('PERFORMED');
    expect(record.mode).toBe('routine');
    expect(record.repairs_used).toBe(1);
    expect(record.submission_count).toBe(3);
    expect((record.isolation as { aggregate: string }).aggregate).toBe('SEQUENTIAL');
    expect((record.usage as { status: string }).status).toBe('UNKNOWN');
    expect(record.latency_tier).toBe('LT_250KB');
    expect(record.latency_budget_ms).toBe(180_000);
    expect(record.latency_status).toBe('PASS');
    expect(record.execution_profile).toEqual(executionProfile);
    expect(record.runtime_identity).toMatchObject({
      packageName: '@orcaops/review-engine',
      compiledRuntimeManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      entrypointSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((finalized.files as string[]).includes('semantic-anchor-input-v4.json')).toBe(true);
    expect(finalized.current_story).toMatchObject({
      publication_id: finalized.story_publication_id,
      generation: expect.any(String),
    });

    // The selected Story is the one this run sealed.
    const selection = await fixture.read((database) =>
      database.read((view) =>
        view.get<{ story_publication_id: string | null; story_version: number }>(
          'SELECT story_publication_id, story_version FROM review_selections'
        )
      )
    );
    expect(selection.value).toEqual({
      story_publication_id: finalized.story_publication_id,
      story_version: 1,
    });

    // Terminal replay: the sealed run reports its retained receipt instead of
    // composing a second Story over the same run.
    expect(await run(['finalize', '--run', runId])).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      status: 'already-finalized',
      run_id: runId,
      outcome: 'FULL',
    });
  }, 300_000);

  it('rejects a mutating submission from a different executable fingerprint without consuming an attempt', async () => {
    const priorCommit = process.env.ORCAOPS_BUILD_COMMIT;
    try {
      process.env.ORCAOPS_BUILD_COMMIT = 'mint-build';
      const runId = await startRun();
      const fFile = await payloadFile('identity-drift-forensic.json', forensicOk());
      process.env.ORCAOPS_BUILD_COMMIT = 'different-build';
      expect(await submit(runId, 'forensic', fFile)).toBe(1);
      expect((lastJson().error as { message: string }).message).toContain(
        'TWOLANE_EXECUTABLE_IDENTITY_DRIFT'
      );

      process.env.ORCAOPS_BUILD_COMMIT = 'mint-build';
      expect(await run(['run-show', '--run', runId])).toBe(0);
      expect(
        (lastJson().state as { lanes: { forensic: { attempts: number } } }).lanes.forensic.attempts
      ).toBe(0);
    } finally {
      if (priorCommit === undefined) delete process.env.ORCAOPS_BUILD_COMMIT;
      else process.env.ORCAOPS_BUILD_COMMIT = priorCommit;
    }
  }, 180_000);

  it('refuses finalization when the executable changes after both lanes are accepted', async () => {
    const priorCommit = process.env.ORCAOPS_BUILD_COMMIT;
    try {
      process.env.ORCAOPS_BUILD_COMMIT = 'accepted-build';
      const runId = await startRun();
      expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
      const aMd = await servedAccount(runId);
      expect(await submit(runId, 'account', await payloadFile('a.json', accountOk(aMd)))).toBe(0);

      process.env.ORCAOPS_BUILD_COMMIT = 'changed-before-finalize';
      expect(await run(['finalize', '--run', runId])).toBe(1);
      expect((lastJson().error as { message: string }).message).toContain(
        'TWOLANE_EXECUTABLE_IDENTITY_DRIFT'
      );

      process.env.ORCAOPS_BUILD_COMMIT = 'accepted-build';
      expect(await run(['run-show', '--run', runId])).toBe(0);
      expect(lastJson().finalized).toBeNull();
    } finally {
      if (priorCommit === undefined) delete process.env.ORCAOPS_BUILD_COMMIT;
      else process.env.ORCAOPS_BUILD_COMMIT = priorCommit;
    }
  }, 300_000);

  it('rejects malformed or unproven execution-profile metadata before minting a run', async () => {
    expect(
      await run([
        'start',
        '--execution-profile-json',
        JSON.stringify({ model: { value: 'test-model', provenance: 'INFERRED' } }),
      ])
    ).toBe(2);
    expect((lastJson().error as { message: string }).message).toContain(
      '--execution-profile-json is invalid'
    );
  });

  it('routine story caps: too many judgment questions and interpretation overruns are rejected', async () => {
    const runId = await startRun();
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    expect(lastJson().accepted).toBe(true);
    const aMd = await servedAccount(runId);

    const tooManyQuestions = { ...accountOk(aMd), questions: ['q1', 'q2', 'q3', 'q4'] };
    expect(await submit(runId, 'account', await payloadFile('q4.json', tooManyQuestions))).toBe(0);
    expect(
      (lastJson().diagnostics as { code: string; message: string }[]).some(
        (d) =>
          d.code === 'SLICE_ROUTINE_LIMITS' && d.message.includes('exceeds the routine ceiling')
      )
    ).toBe(true);

    const story = accountOk(aMd);
    story.acts[0]!.parts[0]!.interpretation = Array.from({ length: 81 }, (_, i) => `w${i}`).join(
      ' '
    );
    // The repair credit is still available (one failed account attempt so far).
    expect(await submit(runId, 'account', await payloadFile('long.json', story))).toBe(0);
    const wordRejected = lastJson();
    expect(
      (wordRejected.diagnostics as { code: string; message: string }[]).some(
        (d) => d.code === 'SLICE_ROUTINE_LIMITS' && d.message.includes('81 words')
      )
    ).toBe(true);
    // Credit spent on the failed repair: the lane is now terminal.
    expect(
      (wordRejected.state as { repair_credit: { account: number } }).repair_credit.account
    ).toBe(0);
  }, 300_000);

  it('persists normalized authored, compiled, and accepted-envelope lineage without raw bodies', async () => {
    const runId = await startRun();
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    const aMd = await servedAccount(runId);
    const accountFile = await payloadFile('account-lineage.json', accountOk(aMd));
    const normalized = normalizeSubmission(await readFile(accountFile, 'utf8'));
    expect(await submit(runId, 'account', accountFile)).toBe(0);
    expect(lastJson().accepted).toBe(true);
    expect(
      (lastJson().state as { lanes: { account: { outcome: string } } }).lanes.account.outcome
    ).toBe('ACCEPTED_CLEAN_FIRST_PASS');
    expect(await run(['finalize', '--run', runId])).toBe(0);

    const record = lastJson().run_record as {
      account_lineage: {
        raw_submission_sha256: string;
        normalized_authored_sha256: string;
        compiled_payload_sha256: string;
        diagnostic_codes: string[];
        accepted_envelope_sha256: string;
        normalization_code: string;
        normalization_codes: string[];
      };
      attempts: Array<Record<string, unknown>>;
    };
    // The lineage carries hashes of the authored, normalized and compiled
    // payloads — never their bodies.
    expect(record.account_lineage).toMatchObject({
      raw_submission_sha256: normalized.raw_sha256,
      normalized_authored_sha256: normalized.normalized_sha256,
      compiled_payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      accepted_envelope_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      diagnostic_codes: [],
      normalization_code: 'CLEAN_JSON',
      normalization_codes: ['CLEAN_JSON'],
    });
    expect(record.attempts.at(-1)).toEqual(
      expect.objectContaining({
        raw_submission_sha256: normalized.raw_sha256,
        normalized_submission_sha256: normalized.normalized_sha256,
        compiled_payload_sha256: record.account_lineage.compiled_payload_sha256,
        accepted_envelope_sha256: record.account_lineage.accepted_envelope_sha256,
        normalization_codes: ['CLEAN_JSON'],
      })
    );

    // The accepted envelope is retained evidence under THIS run's attempt
    // publication — the raw body never becomes a member.
    const accepted = await fixture.read((database) =>
      database.read((view) =>
        view.all<{ name: string }>(
          `SELECT m.name FROM review_evidence_members m
             JOIN review_evidence_publications p ON p.publication_id = m.publication_id
            WHERE p.run_id = ? AND p.kind = 'run-attempt' AND m.kind = 'run-attempt'
            ORDER BY m.name`,
          runId
        )
      )
    );
    expect(accepted.value.map((member) => member.name)).toContain('accepted-account.json');
    expect(accepted.value.map((member) => member.name)).not.toContain('raw-submission.json');
    expect(record.account_lineage.accepted_envelope_sha256).not.toBe(
      canonicalJsonSha256({ raw: 'not the envelope' })
    );
  }, 300_000);

  it('accepts one JSON-string wrapper as a normalized first pass', async () => {
    const runId = await startRun();
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    const aMd = await servedAccount(runId);
    const wrappedFile = path.join(fixture.root, 'wrapped-account.json');
    await writeFile(wrappedFile, JSON.stringify(JSON.stringify(accountOk(aMd))));
    expect(await submit(runId, 'account', wrappedFile)).toBe(0);
    const submitted = lastJson();
    expect(submitted.accepted).toBe(true);
    expect(
      (submitted.state as { lanes: { account: { outcome: string } } }).lanes.account.outcome
    ).toBe('ACCEPTED_NORMALIZED_FIRST_PASS');
    expect(await run(['run-show', '--run', runId])).toBe(0);
    expect((lastJson().attempts as { normalization_code: string }[]).at(-1)).toMatchObject({
      normalization_code: 'JSON_STRING_UNWRAPPED',
      normalization_codes: ['JSON_STRING_UNWRAPPED'],
    });
  }, 300_000);

  it('applies the same one-layer outer normalization to the forensic boundary', async () => {
    const runId = await startRun();
    const wrappedFile = path.join(fixture.root, 'wrapped-forensic.json');
    await writeFile(wrappedFile, JSON.stringify(JSON.stringify(forensicOk())));
    expect(await submit(runId, 'forensic', wrappedFile)).toBe(0);
    const submitted = lastJson();
    expect(submitted.accepted).toBe(true);
    expect(
      (submitted.state as { lanes: { forensic: { outcome: string } } }).lanes.forensic.outcome
    ).toBe('ACCEPTED_NORMALIZED_FIRST_PASS');
    expect(await run(['run-show', '--run', runId])).toBe(0);
    expect((lastJson().attempts as { normalization_code: string }[])[0]).toMatchObject({
      normalization_code: 'JSON_STRING_UNWRAPPED',
      normalization_codes: ['JSON_STRING_UNWRAPPED'],
    });
  }, 180_000);

  it('rejects bracketed citations and the removed question key', async () => {
    const runId = await startRun();
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    const aMd = await servedAccount(runId);
    const story = accountOk(aMd);
    const citation = story.acts[0]!.parts[0]!.citations[0]!;
    story.acts[0]!.parts[0]!.citations = [`[${citation}]`];
    story.questions = [{ question: 'What remains?', citations: [`[${citation}]`] } as never];
    expect(
      await submit(runId, 'account', await payloadFile('historical-account.json', story))
    ).toBe(0);
    expect(lastJson().accepted).toBe(false);
    expect(lastJson().diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLICE_PAYLOAD_SHAPE' })])
    );
    expect(
      (lastJson().state as { lanes: { account: { outcome: string } } }).lanes.account.outcome
    ).toBe('REJECTED_FIRST_PASS');
    expect(await run(['run-show', '--run', runId])).toBe(0);
    expect((lastJson().attempts as { normalization_code: string }[]).at(-1)).toMatchObject({
      normalization_code: 'CLEAN_JSON',
      normalization_codes: ['CLEAN_JSON'],
    });
  }, 300_000);

  it('an account story that leaves a checkpoint unclaimed is rejected with the named diagnostic', async () => {
    const runId = await startRun();
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    const story = accountOk(await servedAccount(runId));
    const incomplete = {
      ...story,
      acts: [{ ...story.acts[0]!, parts: story.acts[0]!.parts.slice(1) }],
    };
    expect(await submit(runId, 'account', await payloadFile('inc.json', incomplete))).toBe(0);
    expect(
      (lastJson().diagnostics as { code: string }[]).some(
        (d) => d.code === 'STORY_CHECKPOINT_UNCLAIMED'
      )
    ).toBe(true);
  }, 300_000);

  it('a rejected forensic initial with a spent credit unlocks the account lane (terminal by exhaustion)', async () => {
    const runId = await startRun();
    const garbled = path.join(fixture.root, 'garbled.json');
    await writeFile(garbled, 'not json {');
    expect(await submit(runId, 'forensic', garbled)).toBe(0);
    expect(lastJson().accepted).toBe(false);
    // Repair attempt also fails: credit spent, forensic terminal.
    expect(await submit(runId, 'forensic', garbled)).toBe(0);
    expect(lastJson().accepted).toBe(false);
    expect(await run(['run-show', '--run', runId])).toBe(0);
    expect(lastJson().forensic_terminal).toBe(true);
    const aMd = await servedAccount(runId);
    expect(await submit(runId, 'account', await payloadFile('a.json', accountOk(aMd)))).toBe(0);
    expect(lastJson().accepted).toBe(true);
    expect(await run(['finalize', '--run', runId])).toBe(0);
    const finalized = lastJson();
    expect(finalized.outcome).toBe('DEGRADED');
    expect((finalized.run_record as { repairs_used: number }).repairs_used).toBe(1);
  }, 300_000);

  it('refuses required-flag omissions with parseable envelopes (no env gate)', async () => {
    const runId = await startRun();
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await run(['lane-submit', '--run', runId, '--lane', 'forensic', '--input', fFile])).toBe(
      2
    );
    expect((lastJson().error as { message: string }).message).toContain('--isolation');
    // Two-lane is the default: start succeeds with no environment
    // incantation (the retired gate returned exit 2 here).
    expect(await run(['start'])).toBe(0);
  }, 180_000);

  it('refuses to serve, submit to or seal a run identity the review never retained', async () => {
    for (const argv of [
      ['run-show', '--run', 'no-such-run'],
      ['run-show', '--run', 'no-such-run', '--semantic-input'],
      ['lane-input', '--run', 'no-such-run', '--lane', 'forensic'],
      ['finalize', '--run', 'no-such-run'],
    ]) {
      expect(await run(argv)).toBe(1);
      expect((lastJson().error as { message: string }).message).toMatch(/retained|missing/);
    }
  }, 120_000);
});

describe('routine-surface json failure envelopes', () => {
  it('routine-start returns the underlying cause in an envelope under --json', async () => {
    // The fixture's temp parent is not a git repository, so publication throws —
    // the composite must answer with a parseable envelope, not a bare stderr line.
    const code = await runReview(
      ['review', 'routine-start', '--branch', fixture.branch, '--root', fixture.root, '--json'],
      process.env
    );
    expect(code).toBe(1);
    const envelope = lastJson();
    expect(envelope.ok).toBe(false);
    const failure = envelope.error as { verb: string; message: string };
    expect(failure.verb).toBe('review routine-start');
    expect(failure.message.length).toBeGreaterThan(0);
  }, 120_000);

  it('routine-start keeps the human stderr line without --json', async () => {
    const code = await runReview(
      ['review', 'routine-start', '--branch', fixture.branch, '--root', fixture.root],
      process.env
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('review routine-start:');
    expect(out.filter((line) => line.trim().startsWith('{'))).toEqual([]);
  }, 120_000);

  it('missing --branch on routine-start is enveloped under --json', async () => {
    const code = await runReview(
      ['review', 'routine-start', '--root', fixture.gitRoot, '--json'],
      process.env
    );
    expect(code).toBe(2);
    expect((lastJson().error as { message: string }).message).toContain('--branch is required');
  });

  it('routine-submit failures are enveloped under --json', async () => {
    const fFile = await payloadFile('f.json', forensicOk());
    const code = await run([
      'routine-submit',
      '--run',
      'no-such-run',
      '--lane',
      'forensic',
      '--isolation',
      'sequential',
      '--input',
      fFile,
    ]);
    expect(code).toBe(1);
    const envelope = lastJson();
    expect(envelope.ok).toBe(false);
    expect((envelope.error as { verb: string }).verb).toBe('review routine-submit');
    expect((envelope.error as { message: string }).message).toMatch(/retained|missing/);
  }, 120_000);
});

describe('composite routine verbs', () => {
  const compositeStart = async (): Promise<Record<string, unknown>> => {
    const code = await runTwolaneRun(
      { cmd: 'review', sub: 'routine-start', branch: fixture.branch, json: true },
      fixture.gitRoot
    );
    expect(code).toBe(0);
    return lastJson();
  };
  const compositeSubmit = (runId: string, lane: string, file: string) =>
    run([
      'routine-submit',
      '--run',
      runId,
      '--lane',
      lane,
      '--isolation',
      'sequential',
      '--input',
      file,
    ]);

  it('routine-start mints the run and serves the forensic input in one envelope', async () => {
    const env = await compositeStart();
    expect(Object.keys(env).sort()).toEqual([
      'branch',
      'contract',
      'input_shas',
      'lane',
      'mode',
      'ok',
      'payload_bytes',
      'payload_path',
      'payload_sha',
      'review_id',
      'run_id',
      'served_at',
    ]);
    expect(env.mode).toBe('routine');
    expect(env.lane).toBe('forensic');
    expect(env.contract).toEqual(LANE_CONTRACTS.forensic);
    const md = await readFile(path.join(fixture.gitRoot, env.payload_path as string), 'utf8');
    expect(md.startsWith('# Forensic lane input')).toBe(true);
  }, 180_000);

  it('forensic acceptance serves the account input; account acceptance auto-finalizes', async () => {
    const runId = (await compositeStart()).run_id as string;
    expect(
      await compositeSubmit(runId, 'forensic', await payloadFile('f.json', forensicOk()))
    ).toBe(0);
    const fEnv = lastJson();
    expect(fEnv.accepted, JSON.stringify(fEnv.diagnostics)).toBe(true);
    const account = fEnv.account as Record<string, unknown>;
    expect(account.contract).toEqual(LANE_CONTRACTS.account);
    const aMd = await readFile(path.join(fixture.gitRoot, account.payload_path as string), 'utf8');
    expect(aMd.startsWith('# Account lane input')).toBe(true);

    expect(
      await compositeSubmit(runId, 'account', await payloadFile('story.json', accountOk(aMd)))
    ).toBe(0);
    const aEnv = lastJson();
    expect(aEnv.accepted, JSON.stringify(aEnv.diagnostics)).toBe(true);
    expect(aEnv.outcome).toBe('FULL');
    expect((aEnv.files as string[]).includes('review.md')).toBe(true);
    expect((aEnv.run_record as { mode: string }).mode).toBe('routine');
    expect(aEnv.ownership_summary).toEqual(
      (aEnv.run_record as { ownership_summary: unknown }).ownership_summary
    );
  }, 300_000);

  it('prepares a complete semantic-anchor input at finalization and returns its receipt', async () => {
    const runId = (await compositeStart()).run_id as string;
    expect(
      await compositeSubmit(runId, 'forensic', await payloadFile('f.json', forensicOk()))
    ).toBe(0);
    const aMd = await readFile(
      path.join(
        fixture.gitRoot,
        (lastJson().account as Record<string, unknown>).payload_path as string
      ),
      'utf8'
    );
    expect(
      await compositeSubmit(runId, 'account', await payloadFile('story.json', accountOk(aMd)))
    ).toBe(0);
    const final = lastJson();
    const prepared = final.semantic_anchor as Record<string, unknown>;
    expect(prepared.status, JSON.stringify(prepared)).toBe('READY');
    expect(prepared.payload_file).toBe('semantic-anchor-input-v4.md');
    expect(prepared.receipt_file).toBe('semantic-anchor-input-v4.json');
    expect(prepared.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.publication_id).toEqual(expect.any(String));
    expect((final.files as string[]).sort()).toContain('semantic-anchor-input-v4.md');

    // The prepared input and its receipt are retained evidence, read back
    // through the store rather than from a run directory.
    const members = await fixture.read((database) =>
      database.read((view) =>
        view.all<{ name: string }>(
          "SELECT name FROM review_evidence_members WHERE kind = 'semantic' AND publication_id = ? ORDER BY name",
          prepared.publication_id as string
        )
      )
    );
    expect(members.value.map((member) => member.name)).toEqual([
      'semantic-anchor-input-v4.json',
      'semantic-anchor-input-v4.md',
    ]);

    const evidenceFile = path.join(
      path.dirname(projectDatabasePath(fixture.authority)),
      'evidence',
      prepared.publication_id as string,
      prepared.payload_file as string
    );
    const [payload, databaseBefore] = await Promise.all([
      readFile(evidenceFile, 'utf8'),
      readFile(projectDatabasePath(fixture.authority)),
    ]);
    expect(await run(['run-show', '--run', runId])).toBe(0);
    expect(lastJson()).not.toHaveProperty('semantic_anchor');
    expect(await run(['run-show', '--run', runId, '--semantic-input'])).toBe(0);
    expect(lastJson().semantic_anchor).toMatchObject({
      status: 'READY',
      review_id: final.review_id,
      run_id: runId,
      publication_id: prepared.publication_id,
      payload_file: 'semantic-anchor-input-v4.md',
      payload_hash: prepared.payload_hash,
      payload_bytes: Buffer.byteLength(payload),
      payload_content: payload,
    });
    expect((await readFile(projectDatabasePath(fixture.authority))).equals(databaseBefore)).toBe(
      true
    );
    expect(await readFile(evidenceFile, 'utf8')).toBe(payload);
  }, 300_000);

  it('run-show refuses corrupt retained semantic input without repairing it', async () => {
    const runId = (await compositeStart()).run_id as string;
    expect(
      await compositeSubmit(runId, 'forensic', await payloadFile('f.json', forensicOk()))
    ).toBe(0);
    const account = lastJson().account as Record<string, unknown>;
    const markdown = await readFile(
      path.join(fixture.gitRoot, account.payload_path as string),
      'utf8'
    );
    expect(
      await compositeSubmit(runId, 'account', await payloadFile('story.json', accountOk(markdown)))
    ).toBe(0);
    const semantic = lastJson().semantic_anchor as Record<string, unknown>;
    const evidenceFile = path.join(
      path.dirname(projectDatabasePath(fixture.authority)),
      'evidence',
      semantic.publication_id as string,
      semantic.payload_file as string
    );
    const [original, databaseBefore] = await Promise.all([
      readFile(evidenceFile),
      readFile(projectDatabasePath(fixture.authority)),
    ]);
    const corrupt = Buffer.from(original);
    corrupt[0] = corrupt[0] === 0x23 ? 0x24 : 0x23;
    await writeFile(evidenceFile, corrupt);
    try {
      const ordinaryStatus = await run(['run-show', '--run', runId]);
      expect(ordinaryStatus, JSON.stringify(lastJson())).toBe(0);
      expect(lastJson()).not.toHaveProperty('semantic_anchor');
      expect(await run(['run-show', '--run', runId, '--semantic-input'])).toBe(1);
      expect((lastJson().error as { message: string }).message).toContain(
        'Retained evidence differs from its exact hash'
      );
      expect(await readFile(evidenceFile)).toEqual(corrupt);
      expect((await readFile(projectDatabasePath(fixture.authority))).equals(databaseBefore)).toBe(
        true
      );
    } finally {
      await writeFile(evidenceFile, original);
    }
  }, 300_000);

  it('a rejection returns diagnostics and the same command accepts the repaired payload', async () => {
    const runId = (await compositeStart()).run_id as string;
    const garbled = path.join(fixture.root, 'garbled.json');
    await writeFile(garbled, 'not json {');
    expect(await compositeSubmit(runId, 'forensic', garbled)).toBe(0);
    const rejected = lastJson();
    expect(rejected.accepted).toBe(false);
    expect(rejected.account).toBeUndefined();
    expect((rejected.diagnostics as { code: string }[])[0]!.code).toBe('SLICE_PAYLOAD_SHAPE');
    expect(
      await compositeSubmit(runId, 'forensic', await payloadFile('f.json', forensicOk()))
    ).toBe(0);
    const repaired = lastJson();
    expect(repaired.accepted).toBe(true);
    expect((repaired.state as { repair_credit: { forensic: number } }).repair_credit.forensic).toBe(
      0
    );
    expect(repaired.account).toBeDefined();
  }, 300_000);

  it('the composite refuses a premature account submission (ordering intact)', async () => {
    const runId = (await compositeStart()).run_id as string;
    expect(await compositeSubmit(runId, 'account', await payloadFile('a.json', {}))).toBe(0);
    const refused = lastJson();
    expect(refused.accepted).toBe(false);
    expect((refused.diagnostics as { code: string }[])[0]!.code).toBe('TWOLANE_ROUTINE_ORDER');
  }, 180_000);

  it('chains on terminality: an exhausted forensic lane still serves account; an exhausted account lane finalizes', async () => {
    const runId = (await compositeStart()).run_id as string;
    const garbled = path.join(fixture.root, 'garbled.json');
    await writeFile(garbled, 'not json {');
    // Forensic initial rejected: not yet terminal (repair remains), no chain.
    expect(await compositeSubmit(runId, 'forensic', garbled)).toBe(0);
    expect(lastJson().account).toBeUndefined();
    // Forensic repair also rejected: credit spent, lane terminal — the
    // response STILL serves the account input (the reviewer is not stranded).
    expect(await compositeSubmit(runId, 'forensic', garbled)).toBe(0);
    const exhausted = lastJson();
    expect(exhausted.accepted).toBe(false);
    expect((exhausted.account as Record<string, unknown>).payload_path).toBeDefined();
    // Account has its own repair. The initial rejection remains nonterminal;
    // its second rejection spends that lane's credit and finalizes honestly.
    expect(await compositeSubmit(runId, 'account', garbled)).toBe(0);
    expect(lastJson().outcome).toBeUndefined();
    expect(await compositeSubmit(runId, 'account', garbled)).toBe(0);
    const finalized = lastJson();
    expect(finalized.accepted).toBe(false);
    expect(finalized.outcome).toBe('FAILED');
    expect(finalized.ownership_summary).toBeNull();
    expect((finalized.run_record as { ownership_summary: unknown }).ownership_summary).toBeNull();
    // A failed run publishes no Story, so the review's Story selection is
    // untouched by it.
    expect(finalized.story_publication_id).toBeNull();
  }, 300_000);

  it('chains DEGRADED when only the account lane exhausts its repair', async () => {
    const runId = (await compositeStart()).run_id as string;
    expect(
      await compositeSubmit(runId, 'forensic', await payloadFile('f.json', forensicOk()))
    ).toBe(0);
    const garbled = path.join(fixture.root, 'garbled.json');
    await writeFile(garbled, 'not json {');
    expect(await compositeSubmit(runId, 'account', garbled)).toBe(0);
    expect(lastJson().outcome).toBeUndefined();
    expect(await compositeSubmit(runId, 'account', garbled)).toBe(0);
    const finalized = lastJson();
    expect(finalized.outcome).toBe('DEGRADED');
    expect((finalized.run_record as { repairs_used: number }).repairs_used).toBe(1);
  }, 300_000);

  it('unknown --profile values fail loudly', async () => {
    expect(await run(['dossier', '--profile', 'routin'])).toBe(2);
    expect(err.join('')).toContain("unknown --profile 'routin'");
  });

  it('the PRODUCTION mint serves a complete facts block — no placeholders, no omissions', async () => {
    // The point of this test is that "optional" means optional-for-tests only.
    // An optional argument silently becoming an absent one in the only path
    // that matters is exactly how the stale-claim defect would survive the fix,
    // so this asserts the bytes the real routine-start serves.
    const runId = (await compositeStart()).run_id as string;
    expect(
      await compositeSubmit(runId, 'forensic', await payloadFile('f.json', forensicOk()))
    ).toBe(0);
    const served = await readFile(
      path.join(
        fixture.gitRoot,
        (lastJson().account as Record<string, unknown>).payload_path as string
      ),
      'utf8'
    );

    expect(served).toContain('## THIS RUN (executing now — not captured history)');
    expect(served).toContain(`run: ${runId}`);
    expect(served).toContain('latency tier in force for this run:');
    expect(served).toMatch(/floor \S{8,}/);
    expect(served).toMatch(/diff under review: \d+ eligible file\(s\), \d+ bytes/);
    // The instruction that makes the block actionable, not just present.
    expect(served).toContain('check it against these facts before repeating it');

    // No placeholder leaked into any fact line.
    const lines = served.split('\n');
    const factLines = lines.slice(
      lines.findIndex((l) => l.startsWith('## THIS RUN')),
      lines.findIndex((l) => l.startsWith('## Artifact '))
    );
    for (const bad of ['undefined', 'NaN', 'null', 'TODO', '{']) {
      expect(factLines.join('\n')).not.toContain(bad);
    }
  }, 300_000);
});

describe('frozen latency tiers', () => {
  it('tiers come from the frozen amendment, boundaries included', () => {
    expect(latencyTierFor(0)).toContain('180s');
    expect(latencyTierFor(249_999)).toContain('180s');
    expect(latencyTierFor(250_000)).toContain('300s');
    expect(latencyTierFor(999_999)).toContain('300s');
    expect(latencyTierFor(1_000_000)).toContain('480s');
    expect(latencyTierFor(1_110_238)).toContain('480s');
    expect(latencyProfileFor(2_000_000)).toEqual({
      latency_input_bytes: 2_000_000,
      latency_tier: 'FROM_1MB_TO_2MB',
      latency_budget_ms: 480_000,
    });
    expect(() => latencyProfileFor(2_000_001)).toThrow('transport ceiling');
  });
});

describe('instruction-ownership boundary', () => {
  it('public usage carries no retired gate vocabulary', () => {
    expect(REVIEW_USAGE).not.toContain('flag-gated');
    expect(REVIEW_USAGE).not.toContain('ORCAOPS_TWOLANE');
  });

  it('all constant prose the lifecycle emits is pinned to the reviewed fixture', () => {
    const pinned = JSON.parse(readFileSync(CONSTANTS_FIX, 'utf8')) as Record<string, unknown>;
    expect({
      lane_contracts: LANE_CONTRACTS,
      routine_order_message: ROUTINE_ORDER_MESSAGE,
    }).toEqual(pinned);
  });

  it('lane-input envelopes expose no free-prose channel', async () => {
    const runId = await startRun();
    expect(await run(['lane-input', '--run', runId, '--lane', 'forensic'])).toBe(0);
    const envelope = lastJson();
    const nonContract = Object.entries(envelope).filter(([k]) => k !== 'contract');
    for (const [key, value] of nonContract) {
      expect([
        'ok',
        'run_id',
        'lane',
        'payload_path',
        'payload_sha',
        'payload_bytes',
        'served_at',
      ]).toContain(key);
      if (typeof value === 'string') expect(value.includes(' ')).toBe(false);
    }
  }, 180_000);

  it('the production path and the canonical skill invoke no model directly or by proxy', () => {
    const productionSources = [
      'twolaneRunCli.ts',
      'twolaneSlice.ts',
      'dossier.ts',
      'dossierCli.ts',
      'run.ts',
      'semanticAnchors.ts',
      'semanticAnchorGenerations.ts',
    ].map((f) => path.join(__dirname, f));
    const skillTemplate = path.join(
      __dirname,
      '..',
      '..',
      'adapters',
      'src',
      'skills',
      'orcaops-task-review.ts'
    );
    const banned = [
      '@orcaops/llm',
      'packages/llm',
      'LLMClient',
      'claude -p',
      'codex exec',
      '@anthropic-ai/',
      'openai',
    ];
    for (const file of [...productionSources, skillTemplate]) {
      const source = readFileSync(file, 'utf8');
      for (const token of banned)
        expect(source.includes(token), `${file} contains ${token}`).toBe(false);
    }
    // The harness module (evaluator infrastructure) stays out of the production path.
    for (const file of productionSources) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes('./evalHarness'), `${file} imports evalHarness`).toBe(false);
    }
  });
});

describe('composition ownership labels at finalize', () => {
  it('retains every ownership partition and rejects an incomplete row equation', () => {
    const composed = {
      ownership: {
        label: 'DERIVED',
        missingBoundaryCheckpoints: 2,
        metrics: {
          reviewableRows: 18,
          attributedRows: 9,
          attributedPct: 50,
          ambiguousRows: 2,
          contestedRows: 3,
          unattributedRows: 4,
          contributingThreads: 3,
          contributingCheckpoints: 4,
        },
      },
    } as Parameters<typeof ownershipSummaryFromComposed>[0];
    expect(ownershipSummaryFromComposed(composed)).toEqual({
      label: 'DERIVED',
      reviewable_rows: 18,
      attributed_rows: 9,
      attributed_pct: 50,
      ambiguous_rows: 2,
      contested_rows: 3,
      unattributed_rows: 4,
      missing_boundary_checkpoints: 2,
    });
    expect(() =>
      ownershipSummaryFromComposed({
        ...composed,
        ownership: {
          ...composed.ownership,
          metrics: { ...composed.ownership.metrics, reviewableRows: 19 },
        },
      })
    ).toThrow(/ownership summary partition mismatch/);
  });
});

describe('renderForensicRoutineMd — policy-stub accounting', () => {
  const base = (over: Partial<ForensicInput> = {}): ForensicInput => ({
    schema_version: 2,
    baseSha: 'deadbeef',
    diff: 'diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-a\n+b',
    excludedPaths: [],
    unreviewablePaths: [],
    policyStubs: [],
    metrics: {
      eligibleFiles: 1,
      excludedFiles: 0,
      unreviewableFiles: 0,
      policyStubFiles: 0,
      policyStubRows: 0,
      policyStubBytes: 0,
      eligibleDiffBytes: 40,
    },
    ...over,
  });

  it('renders the loud stub lines and the coverage stub count', () => {
    const md = renderForensicRoutineMd(
      base({
        policyStubs: [
          {
            path: 'fixtures/corpus.jsonl',
            adds: 900,
            dels: 3,
            bytes: 500000,
            reason: 'review.stub_paths',
          },
        ],
        metrics: {
          eligibleFiles: 1,
          excludedFiles: 0,
          unreviewableFiles: 0,
          policyStubFiles: 1,
          policyStubRows: 903,
          policyStubBytes: 500000,
          eligibleDiffBytes: 40,
        },
      })
    );
    expect(md).toContain('· 1 policy-stubbed');
    expect(md).toContain(
      'policy-stubbed (review.stub_paths, NOT in diff, 903 row(s) / 500000 bytes'
    );
    expect(md).toContain(
      'stub fixtures/corpus.jsonl — +900/-3 rows, 500000 bytes [review.stub_paths]'
    );
  });

  it('is defensive against a payload pinned before stub_paths existed', () => {
    const legacy = {
      schema_version: 2,
      baseSha: 'x',
      diff: 'd',
      excludedPaths: [],
      unreviewablePaths: [],
      metrics: {
        eligibleFiles: 1,
        excludedFiles: 0,
        unreviewableFiles: 0,
        eligibleDiffBytes: 1,
      },
    } as unknown as ForensicInput;
    const md = renderForensicRoutineMd(legacy);
    expect(md).toContain('0 policy-stubbed');
    expect(md).not.toContain('stub ');
  });
});

describe('composite verb replay under one operation identity', () => {
  const runOp = (argv: string[], operationId: string): Promise<number> =>
    run([...argv, '--operation-id', operationId]);

  const receiptsOfKind = (kind: string): Promise<number> =>
    fixture.read(
      (database) =>
        database.read(
          (view) =>
            view.get<{ count: number }>(
              'SELECT count(*) AS count FROM operations WHERE operation_kind = ?',
              kind
            )!.count
        ).value
    );

  it('replays routine-start whole under a repeated --operation-id', async () => {
    const operationId = uuidv7();
    const beforeStart = await receiptsOfKind('review.run.start');
    const beforeServed = await receiptsOfKind('review.run.inputs-served');
    const beforeFloor = await receiptsOfKind('review.floor');

    expect(await runOp(['routine-start'], operationId)).toBe(0);
    const runId = lastJson().run_id as string;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    // The run mint and the forensic serve each settled once. (The floor half is
    // a cache hit against the fixture's already-published floor, so it writes no
    // review.floor receipt — its replay is proved by the interrupted-half case.)
    expect(await receiptsOfKind('review.run.start')).toBe(beforeStart + 1);
    expect(await receiptsOfKind('review.run.inputs-served')).toBe(beforeServed + 1);
    const afterFirstFloor = await receiptsOfKind('review.floor');

    // The identical composite under the same identity replays every half: the
    // run mint and the forensic serve return their committed result, and no
    // receipt of any kind is added.
    expect(await runOp(['routine-start'], operationId)).toBe(0);
    expect(lastJson().run_id).toBe(runId);
    expect(await receiptsOfKind('review.run.start')).toBe(beforeStart + 1);
    expect(await receiptsOfKind('review.run.inputs-served')).toBe(beforeServed + 1);
    expect(await receiptsOfKind('review.floor')).toBe(afterFirstFloor);
    expect(afterFirstFloor).toBeGreaterThanOrEqual(beforeFloor);
  }, 300_000);

  it('finishes a routine-start interrupted after its floor half', async () => {
    const operationId = uuidv7();
    // Simulate a routine-start that published its floor and then died before the
    // run mint: publish the floor under the exact child identity routine-start
    // derives, so its receipt already exists when the composite is retried.
    const floorOp = deriveReviewOperationId(operationId, 'review.floor');
    expect(await runOp(['data'], floorOp)).toBe(0);
    const beforeFloor = await receiptsOfKind('review.floor');
    const beforeStart = await receiptsOfKind('review.run.start');

    expect(await runOp(['routine-start'], operationId)).toBe(0);
    const runId = lastJson().run_id as string;
    // The floor half replayed (no second floor receipt) and the run half minted.
    expect(await receiptsOfKind('review.floor')).toBe(beforeFloor);
    expect(await receiptsOfKind('review.run.start')).toBe(beforeStart + 1);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  }, 300_000);

  it('replays a routine-submit forensic attempt under a repeated --operation-id', async () => {
    const startId = uuidv7();
    expect(await runOp(['routine-start'], startId)).toBe(0);
    const runId = lastJson().run_id as string;

    const submitId = uuidv7();
    const forensicFile = await payloadFile('composite-forensic.json', forensicOk());
    const beforeAttempt = await receiptsOfKind('review.run.attempt');
    expect(
      await runOp(
        [
          'routine-submit',
          '--run',
          runId,
          '--lane',
          'forensic',
          '--isolation',
          'sequential',
          '--input',
          forensicFile,
        ],
        submitId
      )
    ).toBe(0);
    expect(lastJson().accepted).toBe(true);
    expect(await receiptsOfKind('review.run.attempt')).toBe(beforeAttempt + 1);

    // Retry the same submission under the same identity: the attempt replays and
    // no second attempt row is written, so the reviewer's one repair is intact.
    expect(
      await runOp(
        [
          'routine-submit',
          '--run',
          runId,
          '--lane',
          'forensic',
          '--isolation',
          'sequential',
          '--input',
          forensicFile,
        ],
        submitId
      )
    ).toBe(0);
    expect(lastJson().accepted).toBe(true);
    expect(await receiptsOfKind('review.run.attempt')).toBe(beforeAttempt + 1);
  }, 300_000);
});
