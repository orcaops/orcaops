// The `review …` sidecar subcommands. Invoked as
// `node dist/sidecar.js review data --branch <b> [--json] [--base <sha>]`.
// The floor and its diff are retained evidence in the project store; the verbs
// here parse argv and dispatch. Diagnostics go to stderr only.

import { type ExecutableIdentity } from '@orcaops/review-core';
import { uuidv7 } from '@orcaops/storage';

import { runAnchor } from './anchor.js';
import { runClaimLedger } from './claimLedgerCli.js';
import { runCommentAction, runComments } from './comments.js';
import { executeDatabaseReviewData, runDatabaseReviewData } from './database/floor-command.js';
import { runDatabaseReviewHealth } from './database/health.js';
import { runDatabaseReviewPane } from './database/pane-command.js';
import { deriveReviewOperationId } from './database/review-operation.js';
import { runDatabaseSemanticSubmit } from './database/semantic-command.js';
import { runDossier } from './dossierCli.js';
import { runGit } from './git.js';
import { runJournal } from './journal.js';
import { writeReviewError, writeReviewOutput } from './reviewFiles.js';
import {
  defaultReviewRuntimeDescriptor,
  observeReviewExecutableIdentity,
  type ReviewRuntimeDescriptor,
} from './runtimeIdentity.js';
import { reviewVerbFailure, runTwolaneRun, TWOLANE_RUN_VERBS } from './twolaneRunCli.js';

export interface ReviewArgs {
  cmd: string;
  sub: string | undefined;
  branch?: string;
  projectId?: string;
  reviewId?: string;
  base?: string;
  root?: string;
  /**
   * `review journal` only: a JSON-encoded journal event — or a JSON ARRAY of
   * events (a batch; all-or-nothing) — to validate + append before reading back.
   */
  addEvent?: string;
  /** Action for `review comment` or `review state`. */
  action?: string;
  /** `review comment reply|resolve` only: the target comment id. */
  id?: string;
  /**
   * `review comment add|reply`: a JSON-encoded `{body, author?, anchor?/checkpoint_ref?}`.
   * `review journal`: `-` to read the event/batch JSON from stdin (the
   * large-payload transport — same semantics as --add, capped + loud on oversize).
   */
  input?: string;
  /** `review comment resolve` only: who resolves (`reviewer` | `agent`). */
  author?: string;
  /** `review comment reply --resolve`: also resolve the comment with the reply. */
  resolve?: boolean;
  /** `review anchor` only: the anchored file / diff side / 1-based line range. */
  file?: string;
  side?: string;
  start?: string;
  end?: string;
  /** `review anchor` only: `<kind>:<scope>:<origin>` for a finding key. */
  finding?: string;
  /** `review anchor` only: anchor ids (hunkKeys / citation ids) — repeatable. */
  refs?: string[];
  /** `review anchor --hunk`: auto-pick the anchor line from this floor hunk. */
  hunk?: string;
  /** Two-lane run lifecycle (`start`/`lane-input`/`lane-submit`/`run-show`/`finalize`). */
  runId?: string;
  /** `review run-show` only: hydrate the validated retained semantic input. */
  semanticInput?: boolean;
  /** `review semantic-anchor-submit` only: pending generation to repair once. */
  generationId?: string;
  lane?: string;
  isolation?: string;
  usageTokens?: string;
  usageSource?: string;
  /** Optional strict JSON object with field-level host/model provenance for routine review. */
  executionProfileJson?: string;
  /** `review dossier`: budget profile (`routine` ~8k/lane | `full`). */
  profile?: string;
  /** Engine-internal observation supplied by the public CLI or sidecar adapter. */
  runtimeIdentity?: ExecutableIdentity;
  unknownArguments?: string[];
  /** `--help` on any verb prints its usage. */
  help?: boolean;
  /** Retired: named the disposable SQLite projection the floor cache rebuilt. */
  rebuildCache?: boolean;
  /** `review pane` only: emit only the cheap invalidation tokens, no floor/diff. */
  generationsOnly?: boolean;
  /**
   * The original operation identity a retry carries. A write verb given one
   * replays its committed result instead of settling a second row; omitted, the
   * verb mints one and the invocation is its own original.
   */
  operationId?: string;
  json: boolean;
}

export function parseReviewArgs(argv: readonly string[]): ReviewArgs {
  const args: ReviewArgs = { cmd: argv[0] ?? '', sub: argv[1], json: false };
  // Review verbs with an action carry it as a positional third token.
  let flagStart = 2;
  if (args.sub === 'comment' || args.sub === 'state') {
    if (argv[2] === '--help' || argv[2] === '-h') {
      args.action = 'help';
      args.help = true;
    } else {
      args.action = argv[2];
    }
    flagStart = 3;
  }
  for (let i = flagStart; i < argv.length; i += 1) {
    const a = argv[i];
    if (
      args.sub === 'state' &&
      args.action === 'health' &&
      ['--project', '--review', '--branch', '--root'].includes(a ?? '')
    ) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        (args.unknownArguments ??= []).push(`${a} requires a value`);
      else {
        i += 1;
        if (a === '--project') args.projectId = value;
        else if (a === '--review') args.reviewId = value;
        else if (a === '--branch') args.branch = value;
        else args.root = value;
      }
    } else if (a === '--json') args.json = true;
    else if (a === '--branch') args.branch = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--add') args.addEvent = argv[++i];
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--author') args.author = argv[++i];
    else if (a === '--resolve') args.resolve = true;
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--side') args.side = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--finding') args.finding = argv[++i];
    else if (a === '--hunk') args.hunk = argv[++i];
    else if (a === '--run') args.runId = argv[++i];
    else if (a === '--semantic-input') args.semanticInput = true;
    else if (a === '--generation') args.generationId = argv[++i];
    else if (a === '--lane') args.lane = argv[++i];
    else if (a === '--isolation') args.isolation = argv[++i];
    else if (a === '--usage-tokens') args.usageTokens = argv[++i];
    else if (a === '--usage-source') args.usageSource = argv[++i];
    else if (a === '--execution-profile-json') args.executionProfileJson = argv[++i];
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--operation-id') args.operationId = argv[++i];
    else if (a === '--rebuild-cache') args.rebuildCache = true;
    else if (a === '--generations-only') args.generationsOnly = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--ref') {
      const ref = argv[++i];
      if (ref !== undefined) (args.refs ??= []).push(ref);
    } else if (a !== undefined) (args.unknownArguments ??= []).push(a);
  }
  return args;
}

export type ReviewRootResult = { ok: true; root: string } | { ok: false; message: string };

/**
 * Resolve the orcaops repo root: --root, then ORCAOPS_ROOT, then git toplevel.
 * Outside a git repo this FAILS rather than falling back to the cwd — a write
 * verb run from a stray cwd would otherwise create a stray `.orcaops` tree
 * there, and a registry-style guess cannot disambiguate multi-repo users.
 */
export async function resolveReviewRoot(
  env: NodeJS.ProcessEnv,
  override?: string,
  cwd: string = process.cwd()
): Promise<ReviewRootResult> {
  if (override && override.length > 0) return { ok: true, root: override };
  const fromEnv = env.ORCAOPS_ROOT;
  if (fromEnv && fromEnv.length > 0) return { ok: true, root: fromEnv };
  try {
    const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (top.code === 0) {
      const root = top.stdout.toString('utf8').trim();
      if (root.length > 0) return { ok: true, root };
    }
  } catch {
    // a git spawn failure lands in the same loud error below
  }
  return {
    ok: false,
    message:
      'not inside a git repository — run from the repo under review, or pass --root / set ORCAOPS_ROOT',
  };
}

/** Run a `review` subcommand. Returns the process exit code. */
export async function runReview(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
  runtime: ReviewRuntimeDescriptor = defaultReviewRuntimeDescriptor()
): Promise<number> {
  const args = parseReviewArgs(argv);

  // Help resolves before the root does — it must work from any cwd.
  if (args.sub === undefined || args.sub === 'help' || args.sub === '--help' || args.sub === '-h') {
    writeReviewOutput(REVIEW_USAGE);
    return args.sub === undefined ? 2 : 0;
  }

  if (args.sub === 'semantic-anchor-submit')
    return runDatabaseSemanticSubmit(argv, env, cwd, runtime);

  if (args.sub === 'state' && args.action === 'health')
    return runDatabaseReviewHealth(args, env, cwd);

  // Repair has no canonical counterpart by contract: a read never mutates
  // application state, so the verb discloses what it would have reset instead
  // of resetting it.
  if (args.sub === 'state' && args.action === 'repair') {
    const message =
      'review state repair is retired: review state is retained history, and a read path never repairs it. Republish the floor with `review data`; comments and workflow events are retained rows and are never reset.';
    if (args.json)
      writeReviewOutput(
        `${JSON.stringify({ ok: false, error: { code: 'REVIEW_READ_ONLY', message } })}\n`
      );
    else writeReviewError(`review state repair: ${message}\n`);
    return 2;
  }

  if (args.unknownArguments !== undefined) {
    writeReviewError(`review: unknown argument(s): ${args.unknownArguments.join(', ')}\n`);
    return 2;
  }
  if (args.rebuildCache === true) {
    writeReviewError(
      'review: --rebuild-cache is retired; the retained floor publication is the cache and `review data` republishes whenever its inputs change\n'
    );
    return 2;
  }

  const rootResult = await resolveReviewRoot(env, args.root, cwd);
  if (!rootResult.ok) {
    writeReviewError(`review: ${rootResult.message}\n`);
    return 2;
  }
  const root = rootResult.root;

  if (args.sub !== undefined && (TWOLANE_RUN_VERBS as readonly string[]).includes(args.sub)) {
    args.runtimeIdentity = await observeReviewExecutableIdentity(runtime, env);
  }

  if (args.sub === 'pane') {
    return runDatabaseReviewPane(
      {
        ...(args.branch === undefined ? {} : { branch: args.branch }),
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        generationsOnly: args.generationsOnly === true,
      },
      root
    );
  }

  if (args.sub === 'data') {
    return runDatabaseReviewData(
      {
        ...(args.branch === undefined ? {} : { branch: args.branch }),
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        ...(args.base === undefined ? {} : { base: args.base }),
        ...(args.operationId === undefined ? {} : { operationId: args.operationId }),
        json: args.json,
      },
      root
    );
  }

  if (args.sub === 'ledger') {
    return runClaimLedger(args, root);
  }

  if (args.sub === 'dossier') {
    return runDossier(args, root);
  }

  if (args.sub === 'journal') {
    return runJournal(args, root, env);
  }

  if (args.sub === 'state') {
    writeReviewError('usage: review state health --branch <branch> [--json]\n');
    return 2;
  }

  if (args.sub === 'comments') {
    return runComments(args, root);
  }

  if (args.sub === 'comment') {
    return runCommentAction(args, root);
  }

  if (args.sub === 'anchor') {
    return runAnchor(args, root);
  }

  if (args.sub === 'routine-start') {
    // Composite: floor publication + run mint + forensic serve in ONE host
    // turn. Deterministic throughout. The run's pinned inputs are derived
    // inside the mint from the freshly selected floor, so the dossier is not
    // staged first. Every failure path honors --json: the composite is driven
    // by automated callers, and a bare stderr line strands them without a
    // parseable envelope.
    if (!args.branch) return reviewVerbFailure(args, 'routine-start', '--branch is required', 2);
    // The composite settles two operations, so the floor publication takes a
    // derived child of the caller's identity and the run mint takes the
    // identity itself: one `--operation-id` addresses both halves on a retry.
    const operationId = args.operationId ?? uuidv7();
    try {
      await executeDatabaseReviewData({
        branch: args.branch,
        root,
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        ...(args.base === undefined ? {} : { base: args.base }),
        operationId: deriveReviewOperationId(operationId, 'review.floor'),
        generatedAt: new Date().toISOString(),
        secretAllow: [],
      });
    } catch (error) {
      return reviewVerbFailure(args, 'routine-start', (error as Error).message, 1);
    }
    return runTwolaneRun(args, root, operationId);
  }

  if ((TWOLANE_RUN_VERBS as readonly string[]).includes(args.sub)) {
    return runTwolaneRun(args, root, args.operationId ?? uuidv7());
  }

  writeReviewError(`review: unknown subcommand '${args.sub}'\n${REVIEW_USAGE}`);
  return 2;
}

export const REVIEW_USAGE = `usage: review <verb> --branch <b> [flags]
  every write verb accepts --operation-id <uuidv7>: a retry under the original
  identity replays its committed result instead of writing a second time
  data           publish the review floor + diff as retained evidence
  pane           read the review pane (floor, diff, Story overlay) from the store
  anchor         mint code anchors + finding keys (--help for flags)
  semantic-anchor-submit  validate + install explicit non-adjudicating semantic associations
  ledger         build the deterministic claim ledger (account-vs-reality; no model)
  dossier        derive the tier-1 deterministic dossier + lane inputs from the floor
  routine-start  floor + routine dossier + run mint + forensic input, one turn (optional --execution-profile-json)
  routine-submit validate a lane submission; acceptance serves the next input or finalizes
  start          mint a two-lane run with its inputs pinned from the selected floor
  lane-input     serve one lane's immutable run input + payload contract
  lane-submit    validate one lane submission through the run state machine
  run-show       report run state (--semantic-input reads validated retained input)
  finalize       merge accepted lanes, retain review.md + brief, seal the run record
  journal        read/append reviewer disposition events
  state health   inspect canonical project review state (--review UUID or --branch)
  comments       replayed comments + re-anchored positions
  comment        add | reply | resolve | reopen a comment
`;
