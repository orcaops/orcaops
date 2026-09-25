import { run } from 'effection';
import { readFile } from 'node:fs/promises';

import {
  type EvaluatorFindingLocation,
  type EvaluatorRunFindingsOutcome,
  isBlockingEvaluatorFailure,
} from '@orcaops/evaluator-protocol';
import { createParamsValidator, dispatchOne } from '@orcaops/evaluator-runner';
import { buildLLMClient } from '@orcaops/llm';
import {
  type FixtureFile,
  FixtureFileSchema,
  prepareArtifactDraft,
  uuidv7,
} from '@orcaops/storage';
import { refuseJsonBytes } from '@orcaops/storage/history/database';

import { exampleFixture } from './example-fixture.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import { buildEvaluatorContext } from '../../lib/evaluator-bridge.js';
import { discoverEvaluatorsForCli, evaluatorNotFound } from '../../lib/evaluator-discovery.js';
import { computePackTrustDecisions } from '../../lib/evaluator-grants.js';
import { CLI_ROOT } from '../../lib/evaluators-config.js';
import { getInvocationEnv } from '../../lib/invocation-context.js';
import { resolveInstallCommandContext } from '../../lib/repository-context.js';
import { formatZodIssues, zodIssuePath } from '../../lib/zod-issues.js';

export interface EvalTestOptions {
  /** Resolved evaluator ref `<pack>/<id>`. Required unless printing an example. */
  ref?: string;
  /** Required unless printing an example. */
  fixture?: string;
  /** Print a valid example fixture and exit without running anything. */
  printExampleFixture?: boolean;
  noLlm?: boolean;
  json?: boolean;
}

/**
 * Run a single evaluator against a fixture file (synthetic plan +
 * optional checkpoints + optional summary) for prompt iteration
 * without driving a full agent session.
 *
 * Fixture events are prepared in memory using the same semantics as captures.
 * The repository database is never opened and the evaluator result is not persisted.
 */
export async function evalTestAction(opts: EvalTestOptions): Promise<void> {
  // Before repo context, discovery, trust, or LLM init: printing the shape of
  // a fixture is the first thing an author needs and must not require a
  // configured repository to get at.
  if (opts.printExampleFixture) {
    try {
      if (opts.ref !== undefined || opts.fixture !== undefined) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          '--print-example-fixture only prints an example; it does not run an evaluator, ' +
            'so it cannot be combined with --ref or --fixture.',
          'print-example-fixture'
        );
      }
      const example = exampleFixture();
      if (opts.json) {
        emitOk({ fixture: example });
        return;
      }
      writeTerminalSafeStdout(`${JSON.stringify(example, null, 2)}\n`);
      return;
    } catch (err) {
      if (opts.json) emitError(err);
      writeErrorLine(err);
      throw new CliExit(1);
    }
  }

  try {
    if (opts.ref === undefined || opts.fixture === undefined) {
      const missing = [
        ...(opts.ref === undefined ? ['--ref'] : []),
        ...(opts.fixture === undefined ? ['--fixture'] : []),
      ];
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Missing required option(s): ${missing.join(', ')}. ` +
          'Run `orcaops eval test --print-example-fixture` for a fixture to start from.',
        missing[0]!.replace(/^--/, '')
      );
    }
    const ref = opts.ref;
    const fixturePath = opts.fixture;
    const fixtureRaw = await readFile(fixturePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fixtureRaw);
    } catch (err) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Fixture file is not valid JSON: ${(err as Error).message}`,
        'fixture'
      );
    }
    const fixtureResult = FixtureFileSchema.safeParse(parsed);
    if (!fixtureResult.success) {
      const issues = fixtureResult.error.issues;
      const fieldPath = zodIssuePath(issues[0]!);
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        issues.length === 1
          ? `Fixture file is invalid at ${formatZodIssues(issues)}`
          : `Fixture file has ${issues.length} problems:\n${formatZodIssues(issues)}`,
        `fixture.${fieldPath}`
      );
    }
    const fixture = fixtureResult.data;

    const ctx = await resolveInstallCommandContext();
    refuseJsonBytes(Buffer.from(fixtureRaw), ctx.config.redact.allow);
    const { evaluators, config, errors } = await discoverEvaluatorsForCli(ctx.repoRoot);
    const evaluator = evaluators.find((e) => e.ref === ref);
    if (!evaluator) throw evaluatorNotFound(ref, errors);
    const trust = await computePackTrustDecisions({
      packs: (config?.packages ?? [])
        .filter((entry) => entry.id === evaluator.package_id)
        .map((entry) => ({
          packageId: entry.id,
          source: entry.source,
        })),
      repoRoot: ctx.repoRoot,
      cliRoot: CLI_ROOT,
      warn: (msg) => writeTerminalSafeStderr(`${msg}\n`),
    });

    const stamped = stampArtifactId(fixture);
    const prepared = await prepareArtifactDraft(
      {
        artifactId: stamped.plan.artifact_id,
        priorEvents: [],
        authoredPayload: fixture,
        secretAllow: ctx.config.redact.allow,
        idempotencyBlocks: [],
      },
      async (isolatedStore) => {
        await isolatedStore.writePlan(stamped.plan, {
          idempotencyKey: `eval-test-plan-${stamped.plan.artifact_id}`,
        });

        // Map fixture cp.n to storage-assigned n (storage auto-assigns).
        const assignedN = new Map<number, number>();
        for (const cp of stamped.checkpoints ?? []) {
          const openResult = await isolatedStore.writeCheckpointOpened(
            {
              artifact_id: cp.artifact_id,
              declared_step_ids: [...cp.declared_step_ids],
              ...(cp.agent_session_id !== undefined
                ? { agent_session_id: cp.agent_session_id }
                : {}),
              policy_exceptions: cp.policy_exceptions,
              plan_revision_id: cp.plan_revision_id,
            },
            {
              idempotencyKey: `eval-test-cp-open-${cp.artifact_id}-${cp.n}`,
              headSha: cp.head_sha,
            }
          );
          if (openResult.outcome !== 'created' && openResult.outcome !== 'replay') {
            throw new OrcaopsError(
              ErrorCodes.INVALID_INPUT,
              `eval-test fixture: writeCheckpointOpened returned outcome="${openResult.outcome}" ` +
                `for fixture cp ${cp.n}; cannot proceed.`,
              'fixture'
            );
          }
          assignedN.set(cp.n, openResult.checkpoint.n);
          // Leave it open — this is what gives a checkpoint-open evaluator a
          // current_checkpoint to reason about.
          if (cp.status === 'open') continue;
          await isolatedStore.writeCheckpointClosed(
            {
              artifact_id: cp.artifact_id,
              n: openResult.checkpoint.n,
              summary: cp.summary,
              files_changed: [...cp.files_changed],
              decisions: [...cp.decisions],
              uncertainty: [...cp.uncertainty],
              done_criteria: [...cp.done_criteria],
              ...(cp.verification !== undefined ? { verification: [...cp.verification] } : {}),
              completed_step_ids: [...cp.completed_step_ids],
              head_sha: cp.head_sha,
            },
            { idempotencyKey: `eval-test-cp-close-${cp.artifact_id}-${cp.n}` }
          );
        }
        if (stamped.summary) {
          await isolatedStore.writeSummary(stamped.summary, {
            idempotencyKey: `eval-test-summary-${stamped.summary.artifact_id}`,
          });
        }

        const firesAt = fixture.fires_at ?? evaluator.phase;
        const needsCheckpoint = firesAt === 'checkpoint-open' || firesAt === 'checkpoint-close';

        if (needsCheckpoint && fixture.checkpoint_n === undefined) {
          // The schema catches this when `fires_at` says so; here the phase came
          // from the evaluator, so only this layer can see it.
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `Evaluator ${evaluator.ref} runs at ${firesAt}, so the fixture must set a ` +
              'checkpoint_n naming which checkpoint the run is about. Without one the ' +
              'evaluator sees no current_checkpoint and its verdict says nothing.',
            'fixture.checkpoint_n'
          );
        }
        if (needsCheckpoint) {
          const expected = firesAt === 'checkpoint-open' ? 'an open' : 'a closed';
          const wanted = firesAt === 'checkpoint-open' ? 'open' : 'closed';
          const target = (stamped.checkpoints ?? []).find((cp) => cp.n === fixture.checkpoint_n);
          if (target !== undefined && target.status !== wanted) {
            throw new OrcaopsError(
              ErrorCodes.INVALID_INPUT,
              `Fixture checkpoint ${fixture.checkpoint_n} is ${target.status}, but ${firesAt} ` +
                `needs ${expected} checkpoint — the run would find no current_checkpoint.`,
              'fixture.checkpoint_n'
            );
          }
        }

        // No fallback to the raw number: the schema guarantees checkpoint_n names
        // a declared fixture checkpoint, and every declared checkpoint is written
        // above, so a miss here is a bug rather than something to paper over with
        // a storage id that may belong to a different checkpoint entirely.
        let remappedCheckpointN: number | undefined;
        if (fixture.checkpoint_n !== undefined) {
          remappedCheckpointN = assignedN.get(fixture.checkpoint_n);
          if (remappedCheckpointN === undefined) {
            throw new OrcaopsError(
              ErrorCodes.INTERNAL,
              `eval-test: fixture checkpoint ${fixture.checkpoint_n} was never written to the ` +
                'disposable store; cannot resolve it.',
              'fixture.checkpoint_n'
            );
          }
        }

        const baseContext = await buildEvaluatorContext({
          ctx: { ...ctx, store: isolatedStore },
          artifactId: stamped.plan.artifact_id,
          firesAt,
          ...(remappedCheckpointN !== undefined ? { checkpointN: remappedCheckpointN } : {}),
        });

        return baseContext;
      }
    );
    if (prepared.evaluation.kind === 'threw') throw prepared.evaluation.error;
    const baseContext = prepared.evaluation.value;

    const llm = await run(function* () {
      return yield* buildLLMClient(ctx.config.llm, {
        ...(opts.noLlm !== undefined ? { noLlm: opts.noLlm } : {}),
        env: getInvocationEnv(),
      });
    });

    const validator = createParamsValidator();
    const { run: runPayload, findings } = await dispatchOne(
      evaluator,
      baseContext,
      llm,
      {
        trust,
        validateRaw: (raw, schema) => validator(raw as Record<string, unknown>, schema),
      },
      uuidv7
    );
    const blocking = isBlockingEvaluatorFailure(runPayload);

    const out = {
      artifact_id: stamped.plan.artifact_id,
      evaluator_ref: evaluator.ref,
      fixture: fixturePath,
      run: runPayload,
      // Beside the run, never inside it: `run` is the strict shape a capture
      // retains, so a finding must not read as one of its fields here either.
      findings,
      blocking,
    };
    if (opts.json) {
      emitOk(out);
      return;
    }
    const statusLine =
      runPayload.run_status === 'completed'
        ? `${runPayload.verdict}`
        : runPayload.run_status === 'skipped'
          ? 'skipped'
          : `error: ${runPayload.error?.code ?? 'unknown'}`;
    writeTerminalSafeStdout(
      `${runPayload.evaluator_ref}: ${statusLine} (${runPayload.severity})\n\n${runPayload.body}\n` +
        formatFindings(findings) +
        (blocking ? '\n** BLOCKING **\n' : '')
    );
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/**
 * Render what the evaluator established beside its verdict.
 *
 * Three outcomes, three renderings, and the middle one is why this exists: a
 * run that offered findings and had them refused must not look like a run that
 * found nothing. It says so, with the reason, while the verdict above it stays
 * exactly what the evaluator stated.
 *
 * `none` prints nothing at all. Absence is not malformation — it is what every
 * evaluator that never mentions findings produces.
 */
function formatFindings(outcome: EvaluatorRunFindingsOutcome): string {
  if (outcome.status === 'none') return '';
  if (outcome.status === 'unreadable') {
    return `\nfindings: offered, but could not be read — ${outcome.record.detail}\n`;
  }

  const lines = [`\nfindings (${outcome.record.findings.length}):`];
  for (const finding of outcome.record.findings) {
    lines.push(`  - ${finding.title}`);
    const tags = [
      ...(finding.conclusion !== undefined ? [`conclusion: ${finding.conclusion}`] : []),
      ...(finding.key !== undefined ? [`key: ${finding.key}`] : []),
    ];
    if (tags.length > 0) lines.push(`    ${tags.join('  ')}`);
    if (finding.locations !== undefined) {
      lines.push(`    at: ${finding.locations.map(formatFindingLocation).join(', ')}`);
    }
    if (finding.detail !== undefined) {
      for (const line of finding.detail.split('\n')) lines.push(`    ${line}`);
    }
  }

  const notice = outcome.record.notice;
  if (notice !== undefined) {
    const cuts = [
      [notice.findings_dropped, 'finding(s) dropped'],
      [notice.locations_dropped, 'location(s) dropped'],
      [notice.titles_shortened, 'title(s) shortened'],
      [notice.details_shortened, 'detail(s) shortened'],
    ] as const;
    lines.push(
      `  bounds applied: ${cuts
        .filter(([count]) => count > 0)
        .map(([count, what]) => `${count} ${what}`)
        .join(', ')}`
    );
  }
  return `${lines.join('\n')}\n`;
}

function formatFindingLocation(location: EvaluatorFindingLocation): string {
  switch (location.kind) {
    case 'file': {
      const range =
        location.start_line === undefined
          ? ''
          : `:${location.start_line}${location.end_line !== undefined ? `-${location.end_line}` : ''}`;
      // The revision is printed in full: a shortened object id names something
      // other than what the producer read.
      const revision = location.revision !== undefined ? `@${location.revision}` : '';
      return `${location.path}${range}${revision}`;
    }
    case 'plan-step':
      return `plan-step ${location.step_id}`;
    case 'acceptance-criterion':
      return `acceptance-criterion ${location.criterion_id}`;
    case 'requirement':
      return `requirement ${location.revision_id}`;
    case 'decision':
      return `decision ${location.revision_id}`;
  }
}

function stampArtifactId(fixture: FixtureFile): FixtureFile {
  const id = uuidv7();
  const out: FixtureFile = {
    plan: { ...fixture.plan, artifact_id: id },
  };
  if (fixture.checkpoints !== undefined) {
    out.checkpoints = fixture.checkpoints.map((cp) => ({ ...cp, artifact_id: id }));
  }
  if (fixture.summary !== undefined) {
    out.summary = { ...fixture.summary, artifact_id: id };
  }
  if (fixture.fires_at !== undefined) {
    out.fires_at = fixture.fires_at;
  }
  if (fixture.checkpoint_n !== undefined) {
    out.checkpoint_n = fixture.checkpoint_n;
  }
  return out;
}
