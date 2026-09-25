import { Command, InvalidArgumentError, Option } from 'commander';

import { assertSafeCloudUrl, hasCloudCredentials, setDefaultCliVersion } from '@orcaops/core';
import { SEARCH_SOURCE_KINDS } from '@orcaops/core/history/search';

import { authStateAction } from '../commands/auth-state.js';
import { blockAcknowledgeAction } from '../commands/block/acknowledge.js';
import { blockDismissAction } from '../commands/block/dismiss.js';
import {
  captureCheckpointAbandonAction,
  captureCheckpointCloseAction,
  captureCheckpointOpenAction,
} from '../commands/capture/checkpoint.js';
import { capturePlanReviseAction } from '../commands/capture/plan-revise.js';
import { capturePlanAction } from '../commands/capture/plan.js';
import { capturePrePrCheckAction } from '../commands/capture/pre-pr-check.js';
import { captureRunEvaluatorsAction } from '../commands/capture/run-evaluators.js';
import { captureSummaryAction } from '../commands/capture/summary.js';
import { checkoutAction } from '../commands/checkout.js';
import { configureAction } from '../commands/configure.js';
import { decisionsAction } from '../commands/decisions.js';
import { diffAction } from '../commands/diff.js';
import { digestAction } from '../commands/digest.js';
import { doctorAction } from '../commands/doctor.js';
import { type AddPackProfile, evalAddPackAction } from '../commands/eval/add-pack.js';
import { evalDisableAction, evalEnableAction } from '../commands/eval/enable.js';
import { evalForkPackAction } from '../commands/eval/fork-pack.js';
import { evalListAction } from '../commands/eval/list.js';
import { evalRemovePackAction } from '../commands/eval/remove-pack.js';
import { evalRunAction } from '../commands/eval/run.js';
import { evalSchemaAction, SCHEMA_KIND_NAMES } from '../commands/eval/schema.js';
import { evalShowAction } from '../commands/eval/show.js';
import { evalTestAction } from '../commands/eval/test.js';
import { evalTrustAction } from '../commands/eval/trust.js';
import { evalUpdatePackAction } from '../commands/eval/update-pack.js';
import { exportAgentTraceAction } from '../commands/export.js';
import { fingerprintDeriveAction, fingerprintShowAction } from '../commands/fingerprint.js';
import { finishAction } from '../commands/finish.js';
import { gcAction } from '../commands/gc.js';
import { createHistoryConvertAction } from '../commands/history-convert.js';
import {
  createHistoryBackupsAction,
  createHistoryRestoreAction,
  createHistoryUpgradeAction,
} from '../commands/history-upgrade.js';
import { type HookAgent, hookSessionStartAction } from '../commands/hook-session-start.js';
import { initAction } from '../commands/init.js';
import { knowledgeAssessAction } from '../commands/knowledge/assess.js';
import {
  knowledgeAssignmentListAction,
  knowledgeAssignmentOpenAction,
  knowledgeAssignmentRevokeAction,
} from '../commands/knowledge/assignment.js';
import { knowledgeConsequencesAction } from '../commands/knowledge/consequences.js';
import { knowledgeDisableAction } from '../commands/knowledge/disable.js';
import { knowledgeEnableAction } from '../commands/knowledge/enable.js';
import { knowledgeEquivalenceRejectAction } from '../commands/knowledge/equivalence.js';
import { knowledgeLookupAction } from '../commands/knowledge/lookup.js';
import { knowledgeObserveAction } from '../commands/knowledge/observe.js';
import { knowledgePauseAction, knowledgeResumeAction } from '../commands/knowledge/pause.js';
import {
  knowledgeReconsiderDisposeAction,
  knowledgeReconsiderListAction,
  knowledgeReconsiderOpenAction,
} from '../commands/knowledge/reconsider.js';
import { knowledgeReopenAction } from '../commands/knowledge/reopen.js';
import { knowledgeRetryAction } from '../commands/knowledge/retry.js';
import { knowledgeRevokeAction } from '../commands/knowledge/revoke.js';
import { knowledgeShowAction } from '../commands/knowledge/show.js';
import { knowledgeStatusAction } from '../commands/knowledge/status.js';
import { lineageAction } from '../commands/lineage.js';
import { linkAction } from '../commands/link.js';
import { listAction } from '../commands/list.js';
import { loginAction } from '../commands/login.js';
import { logoutAction } from '../commands/logout.js';
import { looseEndsAction } from '../commands/loose-ends.js';
import { orgSwitchAction } from '../commands/org-switch.js';
import { planPullAction } from '../commands/plan/pull.js';
import { reviewApproveAction } from '../commands/plan/review/approve.js';
import { reviewCommentAction } from '../commands/plan/review/comment.js';
import { reviewDeclineAction } from '../commands/plan/review/decline.js';
import { reviewDiffAction } from '../commands/plan/review/diff.js';
import { reviewListAction } from '../commands/plan/review/list.js';
import { reviewProposeAction } from '../commands/plan/review/propose.js';
import { reviewPullAction } from '../commands/plan/review/pull.js';
import { reviewPushAction } from '../commands/plan/review/push.js';
import { reviewRequestAction } from '../commands/plan/review/request.js';
import { reviewersAction } from '../commands/plan/review/reviewers.js';
import { reviewStatusAction } from '../commands/plan/review/status.js';
import { reviewVerdictAction } from '../commands/plan/review/verdict.js';
import { reviewViewAction } from '../commands/plan/review/view.js';
import { planUploadAction } from '../commands/plan/upload.js';
import { pushStatusAction } from '../commands/push-status.js';
import { pushAction } from '../commands/push.js';
import { rebuildAction } from '../commands/rebuild.js';
import { resumeAction } from '../commands/resume.js';
import { resyncAction } from '../commands/resync.js';
import { reviewFeedbackPullAction } from '../commands/review/pull.js';
import { reviewFeedbackReplyAction } from '../commands/review/reply.js';
import { reviewFeedbackResolveAction } from '../commands/review/resolve.js';
import { reviewFeedbackStatusAction } from '../commands/review/status.js';
import { reviewFeedbackWatchAction } from '../commands/review/watch.js';
import { reviewAction } from '../commands/review.js';
import { searchAction } from '../commands/search.js';
import { seedEnrichAction } from '../commands/seed/enrich.js';
import { seedAction, seedStatusAction } from '../commands/seed/index.js';
import {
  sessionHooksInstallAction,
  sessionHooksStatusAction,
  sessionHooksUninstallAction,
} from '../commands/session-hooks.js';
import { showAction } from '../commands/show.js';
import { skillsListAction } from '../commands/skills/list.js';
import { skillsDisableAction, skillsEnableAction } from '../commands/skills/toggle.js';
import {
  snapshotsCheckoutAction,
  snapshotsDiffAction,
  snapshotsPruneAction,
} from '../commands/snapshots.js';
import { statsAction } from '../commands/stats.js';
import { statusAction } from '../commands/status.js';
import { stepBriefAction } from '../commands/step.js';
import { taskUsesListAction, taskUsesRecordAction } from '../commands/task-uses.js';
import { uninstallAction } from '../commands/uninstall.js';
import { updateAction } from '../commands/update.js';
import { usageAction } from '../commands/usage.js';
import { watchAction } from '../commands/watch.js';
import { whoamiAction } from '../commands/whoami.js';
import { whyAction } from '../commands/why.js';
import { CliExit } from '../io/exit.js';
import { writeTerminalSafeStderr, writeTerminalSafeStdout } from '../io/output.js';
import { knowledgeWorkerAction } from '../knowledge-worker/command.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { writeInspectionParseError } from '../lib/inspection-output.js';
import { detectInstallIncompleteness, formatIncompletenessNudge } from '../lib/install-drift.js';
import {
  getInvocationCwd,
  getInvocationEnv,
  getInvocationRootOverride,
  isCi,
  setInvocationInvokedByAgent,
  setInvocationRootOverride,
} from '../lib/invocation-context.js';
import { discoverGitRoot, resolveExplicitOverride } from '../lib/resolve-root.js';
import { resolveSkillGates } from '../lib/skill-set.js';
import { parseDigitInt } from '../lib/strict-int.js';

// Strict numeric coercion: Number()/parseInt silently accept '', '1e3', or
// trailing garbage ('12abc'), and an oversized digit-only literal becomes
// Infinity; numeric CLI inputs must parse fully to a safe integer or fail.
function parsePositiveInt(value: string): number {
  const n = parseDigitInt(value);
  if (n === null || n < 1) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return n;
}

// For options whose commands emit JSON error envelopes on invalid input:
// coerce strictly but NEVER throw here — an invalid literal becomes NaN and
// the action's own validation rejects it inside the envelope contract
// (a commander-level throw would bypass --json and print to stderr).
function strictIntOrNaN(value: string): number {
  return parseDigitInt(value) ?? NaN;
}

/**
 * Declare `--root <path>` on every command (recursively into groups).
 * Declared per-command — not as a program-level global — so it parses in
 * the appended position `orcaops <cmd> ... --root <path>`, which is how
 * agents and humans type it (a program-level global option only parses
 * BEFORE the subcommand). The value is read off the action command by the
 * `preAction` hook in `buildProgram`.
 */
function addRootOptionRecursively(cmd: Command): void {
  for (const sub of cmd.commands) {
    sub.option(
      '--root <path>',
      'Resolve .orcaops at <path> instead of discovering the git worktree root (also via ORCAOPS_ROOT)'
    );
    addRootOptionRecursively(sub);
  }
}

/**
 * Translate commander's `--no-llm` shape (`opts.llm === false` when the
 * flag was passed) into the capture action's `noLlm: boolean`. Exported
 * so the test suite can unit-test the bare boolean flip without
 * spinning up commander or the LLM stack. A hardcoded `noLlm: false`
 * here escapes every integration test whose fixtures carry no LLM-bound
 * evaluators, so the flip is pinned directly.
 */
export const makeCaptureFlagAdapter =
  <F extends (opts: { input?: string; noLlm?: boolean; sourcePlan?: string }) => Promise<void>>(
    fn: F
  ) =>
  (opts: { input?: string; llm?: boolean; sourcePlan?: string }) =>
    fn({
      // readPayloadInput owns the '-'=stdin / path=file interpretation,
      // inside the action's error boundary so a failure renders as a clean
      // envelope.
      input: opts.input,
      noLlm: opts.llm === false,
      // Only the `plan` parent declares `--source-plan`; for
      // every other capture command commander leaves it undefined and
      // the action ignores it.
      sourcePlan: opts.sourcePlan,
    });

/**
 * Add the canonical `--input` payload option to a subcommand that takes an
 * authored record — `-` for stdin or a file path, wire format auto-detected
 * (YAML is a superset of JSON). `readPayloadInput` owns stdin/file
 * resolution. Returns the command for fluent chaining.
 */
function addCaptureInputOptions(cmd: Command, what = 'Capture payload'): Command {
  return cmd
    .option('--input <value>', `${what}: '-' for stdin, or a file path (YAML or JSON)`)
    .addOption(
      invokedByAgentOption(
        'Attribute this capture to the invoking coding agent',
        ' A record that names who acted keeps its own attribution instead'
      )
    );
}

/** The preAction hook reads the value into the invocation frame; no action handles it. */
function invokedByAgentOption(
  what = 'Attribute this act to the invoking coding agent',
  more = ''
): Option {
  return new Option(
    '--invoked-by-agent <id>',
    `${what} ` +
      '(claude-code|cursor|codex|opencode|aider|github-copilot|antigravity-cli|other); ' +
      `also via ORCAOPS_INVOKED_BY_AGENT, else auto-detected from the environment.${more}`
  );
}

export interface BuildProgramOptions {
  cloudBaseUrl: string;
}

export function buildProgram(options: BuildProgramOptions): Command {
  const cloudBaseUrl = assertSafeCloudUrl(options.cloudBaseUrl);
  // Every cloud client constructed through core (push, plan verbs, auth
  // preflight) inherits this as its `x-orcaops-cli-version` header value.
  setDefaultCliVersion(CLI_VERSION);

  // Construction-time, so the gate must not throw or `--version` breaks. Hidden
  // commands stay invocable: commander's lookup ignores the flag.
  const cloud = hasCloudCredentials(getInvocationEnv());
  const hideCloud = { hidden: !cloud };
  const program = new Command();

  // Make commander's own parse errors (unknown command, missing
  // required option, --help, --version) throw a CommanderError
  // instead of calling process.exit directly. The top-level handler
  // in src/cli/index.ts catches them and maps to the right exit code,
  // which lets the in-process test harness observe exit codes without
  // killing the vitest worker.
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => writeTerminalSafeStdout(text),
    writeErr: (text) => writeTerminalSafeStderr(text),
  });

  // Required so the `watch` delegation stub can use passThroughOptions (forward
  // every unknown flag verbatim to the child). Positional-options semantics:
  // program-level globals (--root/--version) are recognised BEFORE the
  // subcommand name; a subcommand's own options (incl. the per-command --root
  // added by addRootOptionRecursively) parse after it — which is already how
  // every command here is invoked, so existing parsing is unchanged.
  program.enablePositionalOptions();

  program
    .name('orcaops')
    .description('Local-first capture/evaluate/digest layer for AI coding sessions')
    .version(CLI_VERSION)
    .addHelpText(
      'after',
      '\nDirectory: every command resolves .orcaops to the git worktree root, so it\n' +
        'runs from any subdirectory. Override the root with --root <path> (accepted\n' +
        'after the subcommand) or the ORCAOPS_ROOT environment variable.\n'
    );

  // ── init ────────────────────────────────────────────────────────────────
  program
    .command('init')
    .description('Bootstrap orcaops in the current repo')
    .option('--force', 'Reconcile and overwrite Orcaops-managed files; preserve current config')
    .option(
      '--reset-config',
      'With --force, replace config with current defaults; canonical history is preserved'
    )
    .option('--no-llm', 'Configure without an LLM; LLM evaluators are skipped')
    .option(
      '--install-agent <id>',
      'Install support for this agent (repeatable; claude-code, codex, cursor, opencode, aider-desk, github-copilot, antigravity-cli)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option('--agents <list>', 'Comma-separated install set (alias for repeated --install-agent)')
    .option('--yes', 'Non-interactive: skip the agent-selection prompt and use the defaults')
    .addOption(
      new Option(
        '--generated-files <mode>',
        'Generated trees in git: commit (default) or ignore (gitignore + first-run materialize)'
      ).choices(['commit', 'ignore'])
    )
    .addOption(
      new Option(
        '--scope <scope>',
        'Install scope (persisted): personal (default for fresh init — invisible: global skills, ' +
          'footprint hidden via .git/info/exclude), project (committed in-repo trees), or global'
      ).choices(['project', 'global', 'personal'])
    )
    .option(
      '--personal',
      'Shorthand for --scope personal (the invisible default; keeps `git status` clean)'
    )
    .addOption(
      new Option(
        '--link <mode>',
        'Global materialization (persisted): copy (default, safe) or symlink'
      ).choices(['copy', 'symlink'])
    )
    .option(
      '--prefix <name>',
      'Skill naming prefix (default orcaops); lowercase + hyphen-safe, e.g. oo → oo-capture'
    )
    // ORDER IS LOAD-BEARING: `--agents-md` must be declared BEFORE
    // `--no-agents-md`. A commander negated flag presets the pair's default to
    // true UNLESS the positive flag already exists — declared this way the
    // default is undefined (tri-state: init distinguishes an explicit choice
    // from no flag), but reversed, the default becomes true and every
    // unattended init silently writes AGENTS.md again. Verified empirically;
    // pinned by 'unattended init leaves a hand-written AGENTS.md alone and
    // stays manual' in tests/integration/cli.test.ts.
    .option(
      '--agents-md',
      'Add the recommended orcaops lifecycle block to AGENTS.md / CLAUDE.md for automatic capture on non-trivial tasks'
    )
    .option(
      '--no-agents-md',
      'Do not manage an orcaops lifecycle block in AGENTS.md / CLAUDE.md (under project or global scope, unattended init otherwise adds one unless enabled session hooks cover every selected agent or the repository already has an instruction file; personal scope never adds one)'
    )
    // ORDER IS LOAD-BEARING (same commander semantics as --agents-md above):
    // `--session-hooks` must be declared BEFORE `--no-session-hooks` so the
    // pair's default stays undefined (tri-state).
    .option(
      '--session-hooks',
      'Install agent session-start hooks that inject orcaops capture guidance at session start (claude-code/cursor settings; opencode via a beta plugin; codex is machine-level only — `orcaops session-hooks install`)'
    )
    .option(
      '--no-session-hooks',
      'Do not install or manage agent session-start hooks (the default for unattended init)'
    )
    .addOption(
      new Option(
        '--session-hook-payload <mode>',
        'What the session hook emits (persisted; takes effect while session hooks are enabled): static (default — fixed capture nudge) or state-aware (EXPERIMENTAL — reads branch capture state each session)'
      ).choices(['static', 'state-aware'])
    )
    .addOption(
      new Option(
        '--session-hook-entries <which>',
        'Which registration carries the hook here (persisted): project (default — repo settings entries) or none (rely on the machine-level `orcaops session-hooks install`)'
      ).choices(['project', 'none'])
    )
    .option(
      '--with-hooks',
      'Install post-merge / post-rewrite git hooks that re-run `orcaops lineage` (opt-in; preserves existing hooks)'
    )
    .option('--json', 'Emit JSON output instead of human-readable text')
    .option(
      '--here',
      'Initialize .orcaops in the current directory even if it is not the git worktree root (discovery will not find it without ORCAOPS_ROOT / --root)'
    )
    .option('--dry-run', 'Plan and print the changes without writing anything')
    .action(
      async (opts: {
        force?: boolean;
        resetConfig?: boolean;
        llm?: boolean;
        installAgent?: string[];
        agents?: string;
        yes?: boolean;
        generatedFiles?: string;
        scope?: string;
        personal?: boolean;
        link?: string;
        prefix?: string;
        agentsMd?: boolean;
        sessionHooks?: boolean;
        sessionHookPayload?: 'static' | 'state-aware';
        sessionHookEntries?: 'project' | 'none';
        withHooks?: boolean;
        json?: boolean;
        here?: boolean;
        root?: string;
        dryRun?: boolean;
      }) => {
        // Commander maps --agents-md / --no-agents-md to true / false. Leave
        // undefined when neither was passed so init can distinguish an explicit
        // choice from the interactive recommendation and unattended default.
        await initAction({
          force: opts.force,
          resetConfig: opts.resetConfig === true,
          noLlm: opts.llm === false,
          installAgent: opts.installAgent,
          agents: opts.agents,
          yes: opts.yes === true,
          generatedFiles: opts.generatedFiles as 'commit' | 'ignore' | undefined,
          scope: opts.scope as 'project' | 'global' | 'personal' | undefined,
          personal: opts.personal === true,
          link: opts.link as 'copy' | 'symlink' | undefined,
          prefix: opts.prefix,
          agentsMd: opts.agentsMd,
          sessionHooks: opts.sessionHooks,
          sessionHookPayload: opts.sessionHookPayload,
          sessionHookEntries: opts.sessionHookEntries,
          withHooks: opts.withHooks === true,
          json: opts.json,
          here: opts.here === true,
          root: opts.root,
          dryRun: opts.dryRun === true,
        });
      }
    );

  // ── update ──────────────────────────────────────────────────────────────
  program
    .command('update')
    .description('Refresh agent skills + slash commands for the current orcaops version')
    .option('--force', 'Overwrite all generated files even if user-edited')
    .option(
      '--prefix <name>',
      'Change the naming prefix (manifest-tracked rename: prune old, re-render new)'
    )
    .addOption(
      new Option(
        '--scope <scope>',
        'Install scope (persisted): personal (default for fresh init — invisible: global skills, ' +
          'footprint hidden via .git/info/exclude), project (committed in-repo trees), or global'
      ).choices(['project', 'global', 'personal'])
    )
    .option(
      '--personal',
      'Shorthand for --scope personal (the invisible default; keeps `git status` clean)'
    )
    .addOption(
      new Option(
        '--link <mode>',
        'Global materialization (persisted): copy (default, safe) or symlink'
      ).choices(['copy', 'symlink'])
    )
    // ORDER IS LOAD-BEARING: `--session-hooks` before `--no-session-hooks`
    // (commander tri-state; see the init declaration above).
    .option('--session-hooks', 'Enable agent session-start hooks (persisted; installs on this run)')
    .option(
      '--no-session-hooks',
      'Disable agent session-start hooks (persisted; removes orcaops entries on this run)'
    )
    .addOption(
      new Option(
        '--session-hook-payload <mode>',
        'Switch what the session hook emits (persisted; no reinstall or restart needed): static or state-aware (EXPERIMENTAL)'
      ).choices(['static', 'state-aware'])
    )
    .addOption(
      new Option(
        '--session-hook-entries <which>',
        'Which registration carries the hook here (persisted): project (repo settings entries, reconciled this run) or none (machine-level registration covers this repo; repo entries strip)'
      ).choices(['project', 'none'])
    )
    .option('--dry-run', 'Plan and print the changes without writing anything')
    .option('--json', 'Emit JSON')
    .action(updateAction);

  // ── configure ───────────────────────────────────────────────────────────
  // Interactive settings menu — a front-end over the SAME reconcile update
  // runs (apply persists config, then updateAction reconciles). TTY-only by design;
  // scripts use the update flags.
  program
    .command('configure')
    .description(
      'Interactively review and change orcaops settings (agents, session hooks, block, prefix, scope, hints, git hooks)'
    )
    .action(() => configureAction({}));

  // ── link ────────────────────────────────────────────────────────────────
  // Consolidate divergent instruction files onto one canonical + symlink. Lossy
  // by design (unlike init/update, which dual-maintain), so it is --yes-gated.
  program
    .command('link')
    .description('Consolidate AGENTS.md / CLAUDE.md onto one canonical file + symlink')
    .option('--yes', "Confirm even when it drops a divergent file's unique content")
    .option('--canonical <file>', 'Which instruction file to keep as canonical (default AGENTS.md)')
    .option('--dry-run', 'Plan and print the changes without writing anything')
    .option('--json', 'Emit JSON')
    .action(linkAction);

  // ── uninstall ─────────────────────────────────────────────────────────────
  // Reverse `init`: remove managed skills/commands, the bootstrap block, git
  // hooks, and orcaops .gitignore lines (hash-guarded). Keeps .orcaops data
  // unless --purge-data. The first place a confirm-gated entry is acted on.
  program
    .command('uninstall')
    .description(
      'Remove orcaops-managed skills/commands, bootstrap block, hooks, and .gitignore lines'
    )
    .option('--force', 'Also remove confirm-gated, unverifiable managed entries without prompting')
    .option(
      '--purge-data',
      'Also delete the worktree .orcaops/ directory; canonical history in the orcaops data directory is kept'
    )
    .option('--dry-run', 'Plan and print the changes without writing anything')
    .option('--json', 'Emit JSON')
    .action((opts: { force?: boolean; purgeData?: boolean; dryRun?: boolean; json?: boolean }) =>
      uninstallAction({
        force: opts.force,
        purgeData: opts.purgeData,
        dryRun: opts.dryRun,
        json: opts.json,
      })
    );

  // ── rebuild ─────────────────────────────────────────────────────────────
  program
    .command('rebuild')
    .description('Rebuild query and search indexes from retained database history')
    .option('--json', 'Emit JSON')
    .action(rebuildAction);

  // ── lineage ──────────────────────────────────────────────────────────────
  program
    .command('lineage')
    .description(
      'Append a rebased lineage entry to every artifact on the current branch ' +
        'whose latest_lineage_sha is no longer the branch HEAD'
    )
    .option('--branch <name>', 'Override branch (defaults to current git branch)')
    .option('--json', 'Emit JSON')
    .action(lineageAction);

  // ── push-status ──────────────────────────────────────────────────────────
  // Top-level and hyphenated rather than a `push status` subcommand: the flat
  // name predates `enablePositionalOptions()` (parent/child option sharing is
  // routable now) and stays for CLI-surface stability; the hyphen also keeps
  // `orcaops push status` from quietly parsing as `push` with a stray argument.
  program
    .command('push-status', hideCloud)
    .description('Show pending and stuck cloud-push artifacts')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => pushStatusAction({ json: opts.json }));

  // ── hook (agent session hook entry points) ──────────────────────────────
  // Executed by installed agent session hooks (`orcaops init
  // --session-hooks`), so the contract is unusual for this CLI: ALWAYS exit
  // 0 with empty stdout on any failure — a throwing entry point would put an
  // error banner in every agent session for the whole team. A subcommand
  // namespace (not a flat `hook-session-start`) leaves room for future hook
  // events without new top-level commands.
  const hook = program
    .command('hook')
    .description('Agent session hook entry points (installed by `orcaops init --session-hooks`)');
  hook
    .command('session-start')
    .description(
      'Emit state-aware orcaops capture guidance for an agent session start (always exits 0)'
    )
    .addOption(
      new Option('--agent <id>', 'Emitting agent — selects the output shape').choices([
        'claude-code',
        'codex',
        'cursor',
        'opencode',
      ])
    )
    .option(
      '--user',
      'Invocation from the machine-level registration — yields when the repo carries a project entry'
    )
    .action((opts: { agent?: HookAgent; user?: boolean }) =>
      hookSessionStartAction({ agent: opts.agent, user: opts.user })
    );

  // ── session-hooks (machine-level registration) ──────────────────────────
  const sessionHooks = program
    .command('session-hooks')
    .description(
      "Machine-level session-hook registration in your agents' USER configs (consent-gated)"
    );
  sessionHooks
    .command('install')
    .description(
      'Interactively install the orcaops session-hook entry into your user-level agent configs ' +
        '(TTY-only; lists the exact files before writing; --yes is refused by design)'
    )
    .option('--agents <list>', 'Comma-separated subset of user-hook-capable agents')
    .option(
      '--representation <surface>',
      'Codex only: force hooks-json or config-toml instead of the resolved file'
    )
    .option('--json', 'Machine-readable output')
    .option('--yes', 'Refused — the consent prompt cannot be skipped')
    .option('--dry-run', 'Preview the per-file plan without writing')
    .action(
      (opts: {
        agents?: string;
        representation?: string;
        json?: boolean;
        yes?: boolean;
        dryRun?: boolean;
      }) => sessionHooksInstallAction(opts)
    );
  sessionHooks
    .command('uninstall')
    .description(
      'Strip the orcaops entry from every user-level agent config (restores pre-consent state)'
    )
    .option('--json', 'Machine-readable output')
    .option('--yes', 'Allowed here — removal restores the pre-consent state')
    .option('--dry-run', 'Preview without writing')
    .action((opts: { json?: boolean; yes?: boolean; dryRun?: boolean }) =>
      sessionHooksUninstallAction(opts)
    );
  sessionHooks
    .command('status')
    .description('Show the machine-level registration state per agent surface')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => sessionHooksStatusAction(opts));

  // ── checkout ────────────────────────────────────────────────────────────
  program
    .command('checkout [artifactId]')
    .description('Focus an explicit task in this session, with deliberate binding changes')
    .option('--project <projectId>', 'Select the original project UUID')
    .option('--clear', 'Clear only the current session focus')
    .option('--handoff', 'Explicitly transfer execution ownership to this worktree')
    .option(
      '--recover-orphaned',
      'Recover an owner absent from the complete registered worktree inventory'
    )
    .option('--reason <reason>', 'Original reason for the explicit handoff or recovery')
    .option('--operation-id <operationId>', 'Retry the exact original checkout or focus operation')
    .option('--json', 'Emit JSON')
    .action(async (artifactId: string | undefined, opts: Parameters<typeof checkoutAction>[0]) =>
      checkoutAction({ ...opts, artifactId })
    );

  // ── doctor ──────────────────────────────────────────────────────────────
  program
    .command('doctor')
    .description('Diagnose adapter health, env, evaluator validity, cache, and watchdog signals')
    .option('--json', 'Emit JSON')
    .option('--verbose', 'Show every passing check in human output')
    .option('--fix', 'Repair install surfaces and resume a missing/partial history seed')
    .option('--dry-run', 'With --fix, preview the repairs without writing anything')
    .action(doctorAction);

  // ── gc ──────────────────────────────────────────────────────────────────
  program
    .command('gc')
    .description('Inspect retained Git publications and reclaim positively retired refs')
    .option('--project <id>', 'Qualify cleanup to the current repository project UUID')
    .option('--apply', 'Reclaim eligible refs (default is dry-run)')
    .option('--json', 'Emit JSON')
    .action((opts: { project?: string; apply?: boolean; json?: boolean }) =>
      gcAction({
        projectId: opts.project,
        apply: opts.apply,
        json: opts.json,
      })
    );

  // ── fingerprint ─────────────────────────────────────────────────────────
  // Read-only inspection of a closed checkpoint's diff-fingerprint.
  // Parent is a thin router with no own action / `--json`;
  // the leaf `show` carries the options. Same parent/child shape as
  // `capture plan` — a shared `--json` between parent and child is
  // swallowed by commander's parent parser.
  const fingerprintCmd = program
    .command('fingerprint')
    .description('Inspect captured diff-fingerprints (hashes/metadata only — never raw code)');
  fingerprintCmd
    .command('show')
    .description("Show a closed checkpoint's diff-fingerprint summary + manifest")
    .requiredOption('--artifact <id>', 'Artifact id')
    .requiredOption('--checkpoint <n>', 'Checkpoint number', parsePositiveInt)
    .option('--json', 'Emit JSON')
    .action((opts: { artifact: string; checkpoint: number; json?: boolean }) =>
      fingerprintShowAction({
        artifact: opts.artifact,
        checkpoint: opts.checkpoint,
        json: opts.json,
      })
    );
  fingerprintCmd
    .command('derive')
    .description(
      "Recompute a closed checkpoint's manifest from its pinned snapshot trees and " +
        'verify it against the capture-time manifest_hash (output-only; nothing is persisted)'
    )
    .requiredOption('--artifact <id>', 'Artifact id')
    .requiredOption('--checkpoint <n>', 'Checkpoint number', parsePositiveInt)
    .option('--json', 'Emit JSON')
    .action((opts: { artifact: string; checkpoint: number; json?: boolean }) =>
      fingerprintDeriveAction({
        artifact: opts.artifact,
        checkpoint: opts.checkpoint,
        json: opts.json,
      })
    );

  // ── diff ─────────────────────────────────────────────────────────────────
  // Attribution over a diff. v1 requires --attribution (plain passthrough
  // reserved); exact-only matching, cloud owns fuzzy.
  program
    .command('diff')
    .description(
      'Match a diff against captured checkpoint manifests (--attribution), or audit ' +
        'in-window commits against checkpoint coverage (--reconcile)'
    )
    .option('--attribution', 'Attribute hunks to the checkpoints that produced them')
    .option(
      '--reconcile',
      'Report in-window commits no checkpoint accounts for (mutually exclusive with --attribution)'
    )
    .option('--unattributed', 'Report only hunks no checkpoint accounts for')
    .option('--base <ref>', 'Diff base (default: the active artifact’s plan base_sha)')
    .option('--target <ref>', 'Diff a committed state instead of the live worktree')
    .option(
      '--artifact <id>',
      'Scope manifest sourcing to one artifact, and supply the diff base when --base is absent'
    )
    .option('--project <id>', 'Qualify the read to one registered project')
    .option('--json', 'Emit JSON')
    .action(
      (opts: {
        attribution?: boolean;
        reconcile?: boolean;
        unattributed?: boolean;
        base?: string;
        target?: string;
        artifact?: string;
        project?: string;
        json?: boolean;
      }) => diffAction(opts)
    );

  // ── export ───────────────────────────────────────────────────────────────
  // Interop exports. `agent-trace` emits Cursor agent-trace v0.1.0 records;
  // stdout default (in-repo default files would self-fingerprint), notes at
  // refs/notes/orcaops/agent-trace only, never auto-pushed.
  const exportCmd = program
    .command('export')
    .description('Interop exports over captured provenance');
  exportCmd
    .command('agent-trace')
    .description('Per-line provenance for a commit as a Cursor agent-trace v0.1.0 record')
    .option('--commit <sha>', 'Commit to attribute (default: HEAD)')
    .option('--out <path>', 'Append the record to a JSONL file instead of stdout')
    .option('--notes', 'Also attach the record as a git note (refs/notes/orcaops/agent-trace)')
    .option('--project <id>', 'Qualify the read to one registered project')
    .option('--json', 'Emit a JSON envelope')
    .action(
      (opts: {
        commit?: string;
        out?: string;
        notes?: boolean;
        project?: string;
        json?: boolean;
      }) => exportAgentTraceAction(opts)
    );

  // ── snapshots ───────────────────────────────────────────────────────────
  // Manual prune of local snapshot refs. Dry-run by default;
  // `--apply` to delete (matches `gc` UX). Separate command tree from
  // `fingerprint` above; parent is a thin router, `--json` only on the
  // leaf (commander parent-`--json` swallow gotcha).
  const snapshotsCmd = program
    .command('snapshots')
    .description('Manage local snapshot refs (refs/orcaops/snap/*)');
  // Materialize a pinned checkpoint boundary into a scratch
  // worktree (never the live one). Phase defaults to the cp's finalized
  // boundary (close|abandon; open for a still-open cp).
  snapshotsCmd
    .command('checkout')
    .description('Materialize a checkpoint boundary tree into a scratch worktree')
    .requiredOption('--artifact <id>', 'Artifact id')
    .requiredOption('--checkpoint <n>', 'Checkpoint number', parsePositiveInt)
    .option('--phase <phase>', 'Boundary phase: open|close|abandon (default: per cp status)')
    .option('--into <dir>', 'Target directory (must not exist, or be empty)')
    .option('--json', 'Emit JSON')
    .action(
      (opts: {
        artifact: string;
        checkpoint: number;
        phase?: string;
        into?: string;
        json?: boolean;
      }) =>
        snapshotsCheckoutAction({
          artifact: opts.artifact,
          checkpoint: opts.checkpoint,
          phase: opts.phase,
          into: opts.into,
          json: opts.json,
        })
    );
  // Raw diff between checkpoint boundaries (or the plan-time
  // baseline). Human stdout carries ONLY the diff (pipe-friendly);
  // metadata lands on stderr.
  snapshotsCmd
    .command('diff')
    .description('Diff between checkpoint boundaries: <n> or <from>..<to> (side = n | baseline)')
    .argument('<range>', 'Checkpoint window <n>, or <from>..<to>')
    .requiredOption('--artifact <id>', 'Artifact id')
    .option('--from-phase <phase>', 'open|close|abandon (default: per endpoint status)')
    .option('--to-phase <phase>', 'open|close|abandon (default: per endpoint status)')
    .option('--json', 'Emit JSON')
    .action(
      (
        range: string,
        opts: { artifact: string; fromPhase?: string; toPhase?: string; json?: boolean }
      ) =>
        snapshotsDiffAction({
          artifact: opts.artifact,
          range,
          fromPhase: opts.fromPhase,
          toPhase: opts.toPhase,
          json: opts.json,
        })
    );
  snapshotsCmd
    .command('prune')
    .description('Prune local snapshot refs (dry-run by default; --apply to delete)')
    .option('--artifact <id>', 'Prune eligible retired snapshot publications for one artifact')
    .option('--orphans', 'Prune eligible retired snapshot publications')
    .option('--all', 'Prune all eligible retired snapshot publications (requires --apply)')
    .option('--apply', 'Actually delete candidates (default is dry-run)')
    .option('--json', 'Emit JSON')
    .action(
      (opts: {
        artifact?: string;
        orphans?: boolean;
        all?: boolean;
        apply?: boolean;
        json?: boolean;
      }) =>
        snapshotsPruneAction({
          artifact: opts.artifact,
          orphans: opts.orphans,
          all: opts.all,
          apply: opts.apply,
          json: opts.json,
        })
    );

  // ── seed ────────────────────────────────────────────────────────────────
  const seedCmd = program
    .command('seed')
    .description('Import existing git history as synthesized Orcaops artifacts')
    .option('--since <ref|date>', 'Recency cutoff as an ISO date or commit ref')
    .option('--max-commits <n>', 'Total post-expansion commit budget (max 5000)', strictIntOrNaN)
    .option('--branch <ref>', 'Default-branch override')
    .option('--author <pattern>', 'Only clusters containing a matching author email')
    .option('--dry-run', 'Preview clusters without writing artifacts')
    .option('--yes', 'Confirm artifact writes')
    .option('--enrichment-dir <path>', 'Directory containing agent-produced enrichment JSON')
    .option('--include-bots', 'Include bot-authored commits and automated merge clusters')
    .option('--pr-context', 'Record consent to persist agent-fetched pull-request context')
    .option('--importance', 'Continue the blame-mass importance lane')
    .option('--path <dir>', 'Import clusters touching a path')
    .option('--commit <sha>', 'Import the canonical cluster containing a commit')
    .option(
      '--invoked-by-agent <id>',
      'Attribute this seed run to the invoking coding agent ' +
        '(claude-code|cursor|codex|opencode|aider|github-copilot|antigravity-cli|other); ' +
        'recorded on the job ledger — seeded artifacts keep agent "other"'
    )
    .option('--json', 'Emit JSON')
    .action(seedAction);
  seedCmd
    .command('enrich')
    .description('Preview or append an enrichment amendment to an imported artifact')
    .requiredOption('--artifact <id>', 'Imported artifact ID')
    .option('--dry-run', 'Generate and validate the enrichment bundle without writing an event')
    .option('--yes', 'Confirm the amendment event write')
    .option('--enrichment-dir <path>', 'Directory containing the authored enrichment JSON')
    .option('--preserve-decisions', 'Keep the current decision set while amending prose')
    .option('--pr-context', 'Allow consented PR context for label, task, and outcome')
    .option('--json', 'Emit JSON')
    .action(seedEnrichAction);
  seedCmd
    .command('status')
    .description('Show seed journal progress and imported line coverage')
    .option('--jobs', 'Group imported artifacts by the generation job that produced them')
    .option('--decline <area>', 'Remember a declined progressive-discovery area')
    .option('--offered <area>', 'Record that an area was offered, starting its 7-day cooldown')
    .option('--offer-again <area>', 'Forget a declined or offered area so it can be offered again')
    .option('--json', 'Emit JSON')
    .action(seedStatusAction);

  // ── history ─────────────────────────────────────────────────────────────
  const historyCmd = program
    .command('history')
    .description('Work with retained legacy project history');
  historyCmd
    .command('convert')
    .description(
      'Convert a frozen 0.2.0-rc.2 legacy repository into its project database. ' +
        'Without --apply this previews identities, counts, hashes, disclosed omissions and ' +
        'target presence without decoding omitted payloads or writing anything.'
    )
    .option(
      '--apply',
      'Perform the conversion: import every retained family, compare the result against its ' +
        'original sources and register the database once'
    )
    .option('--offline', 'Confirm the explicit offline window --apply requires')
    .option(
      '--operation-id <uuid>',
      'Retry the original conversion by its operation ID instead of starting a new one'
    )
    .option('--json', 'Emit JSON')
    .action(createHistoryConvertAction());
  historyCmd
    .command('upgrade')
    .description(
      'Upgrade this project database to the schema this build writes. Without --apply this ' +
        'previews the state, the versions, the tables that would be rebuilt with their row ' +
        'counts, where the backup would be written and which retained references could not be ' +
        'found, and changes nothing.'
    )
    .option(
      '--apply',
      'Perform the upgrade: take and verify a backup, then make the whole transition in one ' +
        'transaction'
    )
    .option('--json', 'Emit JSON')
    .action(createHistoryUpgradeAction());
  historyCmd
    .command('backups')
    .description('List the verified backups taken before an upgrade of this project database')
    .option('--json', 'Emit JSON')
    .action(createHistoryBackupsAction());
  historyCmd
    .command('restore <backup>')
    .description(
      'Replace this project database with one of its upgrade backups. Without --apply this ' +
        'previews what would be replaced, what the backup does not bring back and where the ' +
        'database now in place would be kept, and changes nothing.'
    )
    .option('--apply', 'Perform the restore: verify the backup, then put it in place')
    .option('--json', 'Emit JSON')
    .action(createHistoryRestoreAction());

  // ── status / list / show ────────────────────────────────────────────────
  program
    .command('status')
    .description('Inspect passive task context and artifact thread status')
    .option('--scope <scope>', 'History scope: worktree, project, or all-projects')
    .option('--project <id>', 'Select one project by its UUID')
    .option(
      '--branch <name>',
      'Literal branch (current branch for bare status; all for explicit project)'
    )
    .option('--json', 'Emit JSON for skill consumption')
    .action(statusAction);

  program
    .command('list')
    .description('List artifacts in canonical project history')
    .option('--scope <scope>', 'History scope: worktree, project (default), or all-projects')
    .option('--project <id>', 'Select one project by its UUID')
    .option('--branch <name>', 'Filter by literal branch membership (all branches by default)')
    .option('--origin <origin>', 'Origin: all (default), captured, or imported')
    .option('--state <state>', 'Lifecycle state: planned, active, blocked, or summarized')
    .option('--limit <n>', 'Max artifacts to display (bare listing defaults to 50)', strictIntOrNaN)
    .option('--offset <n>', 'Skip this many matching artifacts', strictIntOrNaN)
    .option('--since <ts>', 'Only artifacts started at/after this ISO date or datetime (UTC)')
    .option('--until <ts>', 'Only artifacts started at/before this ISO date or datetime (UTC)')
    .option(
      '--active-since <ts>',
      'Lower checkpoint-interval, summary or plan activity bound (UTC)'
    )
    .option(
      '--active-until <ts>',
      'Upper checkpoint-interval, summary or plan activity bound (UTC)'
    )
    .option(
      '--touching <glob>',
      'Filter recorded closed-checkpoint files by project-relative glob before paging'
    )
    .option(
      '--between <ref1>..<ref2>',
      'Select recorded HEAD anchors in this Git range and disclose unmatched lineage candidates'
    )
    .option('--json', 'Emit JSON')
    .action(listAction);

  // ── insight queries ──────────────────────────────────────────────────────
  // Cross-artifact extraction over the captured record. Both share the list
  // scope flags + a repeatable --artifact exact-scope mode; their WINDOW
  // semantics deliberately differ (records vs artifact selection — see each
  // command module's header).
  const collectArtifactIds = (v: string, prev: string[]): string[] => [...prev, v];
  program
    .command('decisions')
    .description(
      'Every recorded decision in scope (plan revisions, checkpoint closes, deferred in ' +
        'summaries); window flags filter decision RECORDS by their timestamp (UTC)'
    )
    .option('--scope <kind>', 'worktree, project (default), or all-projects')
    .option('--project <id>', 'Select a project UUID')
    .option('--branch <name>', 'Literal recorded branch filter (default: all branches)')
    .option('--origin <kind>', 'all (default), captured, or imported')
    .option('--touching <glob>', 'Filter recorded project-relative changed files')
    .option('--offset <n>', 'Artifacts to skip before inspection', strictIntOrNaN)
    .option('--limit <n>', 'Max artifacts to inspect (default: all)', strictIntOrNaN)
    .option(
      '--artifact <id>',
      'Exact-scope mode: read only this artifact (repeatable; fixes the artifact set — ' +
        'window flags then only filter records)',
      collectArtifactIds,
      []
    )
    .option('--since <ts>', 'Decision records at/after this time (UTC)')
    .option('--until <ts>', 'Decision records at/before this time (UTC)')
    .option('--active-since <ts>', 'Decision record window lower bound (UTC)')
    .option('--active-until <ts>', 'Decision record window upper bound (UTC)')
    .option('--json', 'Emit JSON')
    .action(decisionsAction);

  program
    .command('loose-ends')
    .description(
      "What each artifact still owes: open items, deferred decisions, checkpoints' " +
        'uncertainty, uncovered plan steps, open checkpoints, missing summaries. Window flags ' +
        'select ARTIFACTS only — findings are always current state (never time-filtered), so ' +
        'combining them with --artifact is rejected'
    )
    .option('--scope <kind>', 'worktree, project (default), or all-projects')
    .option('--project <id>', 'Select a project UUID')
    .option('--branch <name>', 'Literal recorded branch filter (default: all branches)')
    .option('--origin <kind>', 'all (default), captured, or imported')
    .option('--touching <glob>', 'Filter recorded project-relative changed files')
    .option('--offset <n>', 'Artifacts to skip before inspection', strictIntOrNaN)
    .option('--limit <n>', 'Max artifacts to inspect (default: all)', strictIntOrNaN)
    .option(
      '--artifact <id>',
      'Exact-scope mode: read only this artifact (repeatable; incompatible with window flags)',
      collectArtifactIds,
      []
    )
    .option('--since <ts>', 'Select artifacts started at/after this time (UTC)')
    .option('--until <ts>', 'Select artifacts started at/before this time (UTC)')
    .option('--active-since <ts>', 'Select artifacts active at/after this time (UTC)')
    .option('--active-until <ts>', 'Select artifacts active at/before this time (UTC)')
    .option('--json', 'Emit JSON')
    .action(looseEndsAction);

  // ── step ─────────────────────────────────────────────────────────────────
  // Parent is a thin router (same shape as `fingerprint`); the `brief` leaf
  // carries the options. Historical step identifiers may recur across
  // artifacts, so --artifact selects among the artifacts containing the step.
  const stepCmd = program
    .command('step')
    .description('Per-plan-step queries over the captured record');
  stepCmd
    .command('brief <step_id>')
    .description(
      'The parallel-dispatch task brief for one plan step: text + acceptance criteria + claim ' +
        'state + related checkpoint evidence + plan guardrails + sibling claim states'
    )
    .option(
      '--artifact <id>',
      'Select the artifact (UUID or unique prefix) when the step_id appears in several'
    )
    .option('--project <id>', 'Select one project by its UUID')
    .option('--json', 'Emit JSON')
    .action((stepId: string, opts: { artifact?: string; project?: string; json?: boolean }) =>
      stepBriefAction(stepId, opts)
    );

  program
    .command('stats')
    .description(
      'Scoped aggregates from canonical project history: artifact/checkpoint/summary counts, ' +
        'evaluator rates, revision churn, checkpoint durations, hygiene and session usage. ' +
        'The diff-attribution hygiene hint captures the live worktree tree through a temporary ' +
        'index (untracked files included), which writes unreferenced loose Git tree objects and ' +
        'leaves the real index and every ref untouched'
    )
    .option('--scope <scope>', 'History scope: worktree, project (default), or all-projects')
    .option('--project <id>', 'Select one project by its UUID')
    .option('--branch <name>', 'Literal recorded branch filter (default: all branches)')
    .option('--origin <kind>', 'all (default), captured, or imported')
    .option('--state <state>', 'planned, active, blocked, or summarized')
    .option(
      '--touching <glob>',
      'Filter recorded closed-checkpoint files by project-relative glob before aggregating'
    )
    .option('--json', 'Emit JSON')
    .action(statsAction);

  // ── task uses ────────────────────────────────────────────────────────────
  // What a task did with an exact requirement or decision revision. `record`
  // always runs in an operation of its own, so what it writes is always a
  // connection found after the plan, and it says who found it and when.
  const taskCmd = program
    .command('task')
    .description('Inspect and record what a task did with exact requirement or decision revisions');
  const usesCmd = taskCmd
    .command('uses')
    .description('The requirement and decision revisions a plan event used');
  usesCmd
    .command('list')
    .description(
      'A plan event’s uses in two groups: selected with the plan, and connected later with ' +
        'who found each connection and when'
    )
    .option('--plan-event <id>', 'The plan event to read')
    .option('--artifact <id>', 'Every plan event of this artifact')
    .option('--at-boundary <n>', 'Read at this write sequence instead of the committed one')
    .option('--json', 'Emit JSON')
    .action(
      (opts: { planEvent?: string; artifact?: string; atBoundary?: string; json?: boolean }) =>
        taskUsesListAction(opts)
    );
  usesCmd
    .command('record')
    .description(
      'Record a use of an exact revision. It runs outside the plan event’s own operation, so ' +
        'it needs --discovered-at and --discovered-by and is recorded as connected later'
    )
    .option('--input <path>', 'A JSON or YAML payload of uses and a discovery block; - for stdin')
    .option('--artifact <id>', 'The artifact the plan event belongs to')
    .option('--plan-event <id>', 'The plan event the use is keyed to')
    .option('--identity <ref>', 'The identity used, as <kind>:<id>')
    .option('--revision <id>', 'The exact revision used')
    .option('--role <role>', 'implement, preserve, assess, background or propose_change')
    .option('--step <id>', 'The local step the use relates to')
    .option('--criterion <id>', 'The local criterion the use relates to')
    .option('--exception <id>', 'An exception the use rests on')
    .option('--discovered-at <instant>', 'When the connection was found')
    .option('--discovered-by <name>', 'Who found the connection')
    .option('--json', 'Emit JSON')
    .action((opts: Record<string, unknown>) => taskUsesRecordAction(opts));

  // ── knowledge ────────────────────────────────────────────────────────────
  // Enablement and consent are two separate acts on two separate files, and
  // the group keeps them separate: `enable`/`disable` edit configuration,
  // `revoke` edits the user-local grant store, and neither stands in for the
  // other. There is no non-interactive way to consent.
  const knowledgeCmd = program
    .command('knowledge')
    .description(
      'Record observations and assessments, and turn background knowledge processing on or off'
    );
  addCaptureInputOptions(
    knowledgeCmd
      .command('observe')
      .description(
        'Record what somebody saw: a human observation, or a command an agent ran and its ' +
          'result. It can never claim a runner established which inputs a process consumed'
      )
      .option('--json', 'Emit JSON'),
    'The observation'
  ).action((opts: { input?: string; json?: boolean }) => knowledgeObserveAction(opts));
  addCaptureInputOptions(
    knowledgeCmd
      .command('assess')
      .description(
        'Assess a selected release or build against exact expectation revisions, with no task. ' +
          'With no software identified it concludes unresolved or not assessed, never supported'
      )
      .option('--json', 'Emit JSON'),
    'The assessment'
  ).action((opts: { input?: string; json?: boolean }) => knowledgeAssessAction(opts));
  knowledgeCmd
    .command('status')
    .description(
      'Show what configuration enables, what it resolves to, and whether consent covers it'
    )
    .option('--limit <n>', 'How many jobs that gave up to list (default 5)', strictIntOrNaN)
    .option('--json', 'Emit JSON')
    .action((opts: { limit?: number; json?: boolean }) => knowledgeStatusAction(opts));
  // A passive read: it asks nothing, writes nothing and starts no worker, so a person or an agent
  // can look knowledge up before planning without spending anything.
  knowledgeCmd
    .command('lookup')
    .description(
      'What continuing knowledge bears on some work, at a knowledge boundary the answer names'
    )
    .argument('[text]', 'Words to look the record up by')
    .option(
      '--adopted',
      'Every adopted requirement and decision this project holds, whatever this work is about'
    )
    .option('--subject <id>', 'Requirements whose revisions name this subject')
    .option(
      '--identity <ref>',
      'An exact identity as <kind>:<id>; repeatable',
      (value: string, held: string[] = []) => [...held, value]
    )
    .option('--touching <path>', 'Affected code (refused: this history indexes no such link)')
    .option('--at-boundary <n>', 'Read at this write sequence instead of the committed one')
    .option('--scope <scope>', 'project (default) or artifact:<id>')
    .option('--limit <n>', 'How many continuing identities the answer carries')
    .option(
      '--software <ref>',
      'The software the question is about, as <kind>:<identity>; repeatable. Without it the ' +
        'answer names no software and no assessment applies',
      (value: string, held: string[] = []) => [...held, value]
    )
    .option('--environment <name>', 'The conditions the question is about, with --software')
    .option('--json', 'Emit JSON')
    .action((text: string | undefined, opts: Record<string, unknown>) =>
      knowledgeLookupAction({ ...opts, ...(text === undefined ? {} : { text }) })
    );
  knowledgeCmd
    .command('show <reference>')
    .configureOutput({ writeErr: writeInspectionParseError })
    .description('Inspect a recorded account and its current qualification status')
    .option('--project <id>', 'Select this project')
    .option('--scope <scope>', 'Qualification scope: project or artifact:<id> (default project)')
    .option('--details', 'Allow up to 32 KiB of complete inspection content (default 16 KiB)')
    .option('--context', 'Include full qualifying identities instead of their status summary')
    .option('--limit <n>', 'Qualifying identities per page (1–8, default 5)')
    .option('--cursor <reference>', 'Continue the qualifying-context index at the same observation')
    .option(
      '--output <file>',
      'Export retained content to a new private file; stdout contains a receipt'
    )
    .option('--json', 'Emit JSON')
    .action(knowledgeShowAction);
  knowledgeCmd
    .command('equivalence')
    .description('Inspectable proposed matches, never automatic merges')
    .command('reject')
    .description('Reject a proposed match while retaining its wording and evidence')
    .option('--input <path>', 'Rejection record as JSON or YAML; use - for stdin')
    .option('--json', 'Emit JSON')
    .action((opts: { input?: string; json?: boolean }) => knowledgeEquivalenceRejectAction(opts));
  // Also passive: it traverses what the record links and names what it could not reach. It opens
  // no defect, assigns no remediation and never claims complete impact coverage.
  knowledgeCmd
    .command('consequences')
    .description(
      'What else this history records reaching from one change, with the reason and the full ' +
        'path for each affected item'
    )
    .option('--identity <ref>', 'The identity that changed, as <kind>:<id>')
    .option('--revision <ref>', 'The exact revision that changed, as <kind>:<id>@<revision>')
    .option('--touching <path>', 'A repository path, or a glob over one, whose code changed')
    .option('--since <n>', 'Traverse every identity whose standing moved after this write sequence')
    .option('--at-boundary <n>', 'Read at this write sequence instead of the committed one')
    .option('--depth <n>', 'How many links from the change the traversal follows')
    .option('--limit <n>', 'How many items the answer carries')
    .option('--json', 'Emit JSON')
    .action((opts: Record<string, unknown>) => knowledgeConsequencesAction(opts));
  knowledgeCmd
    .command('enable')
    .description(
      'Show what would be sent to the provider and, on a typed confirmation at a terminal, ' +
        'record consent and turn the setting on'
    )
    .option(
      '--include-backlog',
      'Also cover captures already admitted; without it the grant covers captures from now on'
    )
    .option('--json', 'Emit JSON (the terms and the question still go to the terminal)')
    .action((opts: { includeBacklog?: boolean; json?: boolean }) => knowledgeEnableAction(opts));
  knowledgeCmd
    .command('disable')
    .description('Turn the setting off; the consent grant is left on record')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => knowledgeDisableAction(opts));
  knowledgeCmd
    .command('pause')
    .description('Stop claiming for this project; every admitted job is left exactly as it is')
    .requiredOption('--reason <text>', 'Why processing is paused, recorded with the pause')
    .addOption(invokedByAgentOption())
    .option('--json', 'Emit JSON')
    .action((opts: { reason?: string; json?: boolean }) => knowledgePauseAction(opts));
  knowledgeCmd
    .command('resume')
    .description(
      'Let claiming start again for this project; with --model, allow a model for a job ' +
        'captured without one, on a typed confirmation at a terminal'
    )
    .argument('[job]', 'With --model: the processing job to allow a model for')
    .option(
      '--model',
      'Lift the no-model choice an invocation made, for <job> or for --all, instead of the ' +
        'project pause'
    )
    .option('--all', 'With --model: every job this project admitted without a model')
    .addOption(invokedByAgentOption())
    .option('--json', 'Emit JSON')
    .action((job: string | undefined, opts: { model?: boolean; all?: boolean; json?: boolean }) =>
      knowledgeResumeAction({ job, ...opts })
    );
  knowledgeCmd
    .command('retry')
    .description(
      'Make a waiting job, or every waiting job, due now. No attempt allowance is reset and ' +
        'no finished job is reopened; `knowledge reopen` reopens a job that gave up'
    )
    .argument('[job]', 'The processing job to make due; omitted, every waiting job is')
    .addOption(invokedByAgentOption())
    .option('--json', 'Emit JSON')
    .action((job: string | undefined, opts: { json?: boolean }) =>
      knowledgeRetryAction({ job, ...opts })
    );
  knowledgeCmd
    .command('reopen')
    .description(
      'Give one job that gave up a fresh attempt allowance, on a typed confirmation at a ' +
        'terminal, after showing why it gave up and the terms it would run under'
    )
    .argument('<job>', 'The processing job that gave up')
    .addOption(invokedByAgentOption())
    .option('--json', 'Emit JSON')
    .action((job: string, opts: { json?: boolean }) => knowledgeReopenAction({ job, ...opts }));
  knowledgeCmd
    .command('revoke')
    .description('Withdraw this project’s consent; configuration is left as it is')
    .addOption(
      new Option('--provider <name>', 'Withdraw only the grants naming this provider').choices([
        'claude',
        'codex',
      ])
    )
    .option('--json', 'Emit JSON')
    .action((opts: { provider?: 'claude' | 'codex'; json?: boolean }) =>
      knowledgeRevokeAction(opts)
    );
  // The worker's own process. Hidden because orcaops starts it after a capture
  // and nobody types it: it takes the project's processing lease, spends money
  // under the recorded grant, and writes to its log rather than to a terminal.
  knowledgeCmd
    .command('worker', { hidden: true })
    .description('Run the background knowledge processing worker for this project')
    .action(async () => {
      await knowledgeWorkerAction();
    });

  // ── knowledge reconsider ─────────────────────────────────────────────────
  // The one writer of reconsideration items anywhere. Nothing else opens one:
  // a correction and the worker's publication may not start a cascade, so a
  // person or a skill asks, and `open` writes items and nothing else.
  const reconsiderCmd = knowledgeCmd
    .command('reconsider')
    .description(
      'Retain what a change leaves worth another look, and what somebody decided about it'
    );
  reconsiderCmd
    .command('open')
    .description(
      'Traverse one change and retain one item per affected item and cause. It opens no ' +
        'defect, revises no requirement and assigns no remediation'
    )
    .option('--identity <ref>', 'The identity that changed, as <kind>:<id>')
    .option('--revision <ref>', 'The exact revision that changed, as <kind>:<id>@<revision>')
    .option('--touching <path>', 'A repository path, or a glob over one, whose code changed')
    .option('--since <n>', 'Traverse every identity whose standing moved after this write sequence')
    .option('--at-boundary <n>', 'Read at this write sequence instead of the committed one')
    .option('--depth <n>', 'How many links from the change the traversal follows')
    .option('--limit <n>', 'How many items the traversal carries')
    .addOption(invokedByAgentOption())
    .option('--json', 'Emit JSON')
    .action((opts: Record<string, unknown>) => knowledgeReconsiderOpenAction(opts));
  reconsiderCmd
    .command('list')
    .description('Show the items with their cause, path, owner and latest disposition')
    .option('--identity <ref>', 'Only the items about this identity, as <kind>:<id>')
    .option('--open', 'Only the items nobody has disposed of, which is the default')
    .option('--all', 'Include items somebody has already disposed of')
    .option('--at-boundary <n>', 'Read at this write sequence instead of the committed one')
    .option('--limit <n>', 'How many items the answer carries')
    .option('--json', 'Emit JSON')
    .action((opts: Record<string, unknown>) => knowledgeReconsiderListAction(opts));
  reconsiderCmd
    .command('dispose')
    .description('Append what somebody decided. The item’s own facts are left exactly as they are')
    .argument('<item>', 'The reconsideration item')
    .option('--acknowledge', 'Somebody has seen it; the item stays open')
    .option('--reconsidered <outcome>', 'unchanged, revision:<id> or assessment:<id>')
    .option('--decline <reason>', 'Why this item will not be acted on')
    .option('--superseded-by <item>', 'The item that replaces this one')
    .option('--at <instant>', 'When it was decided; by default, now')
    .addOption(invokedByAgentOption())
    .option('--json', 'Emit JSON')
    .action((item: string, opts: Record<string, unknown>) =>
      knowledgeReconsiderDisposeAction(item, opts)
    );

  // ── knowledge assignment ─────────────────────────────────────────────────
  // `knowledge revoke` already means withdrawing this project's consent, so
  // delegation is one family of its own rather than a second `assign`/`revoke`
  // pair beside it.
  const assignmentCmd = knowledgeCmd
    .command('assignment')
    .description('Record who may decide what on somebody else’s behalf, and end a delegation');
  addCaptureInputOptions(
    assignmentCmd
      .command('open')
      .description(
        'Retain one assignment: its objective, the obligations it inherits, the footprint it ' +
          'delegates, who is responsible and how long it lasts. It writes nothing else'
      ),
    'Assignment payload'
  )
    .option('--json', 'Emit JSON')
    .action((opts: Record<string, unknown>) => knowledgeAssignmentOpenAction(opts));
  assignmentCmd
    .command('list')
    .description('Show the assignments with what each delegates and how it stood at a boundary')
    .option('--identity <ref>', 'Only the assignments naming this identity, as <kind>:<id>')
    .option('--responsible <name>', 'Only the assignments made to this party')
    .option('--at-boundary <n>', 'Read at this write sequence instead of the committed one')
    .option('--limit <n>', 'How many assignments the answer carries')
    .option('--json', 'Emit JSON')
    .action((opts: Record<string, unknown>) => knowledgeAssignmentListAction(opts));
  assignmentCmd
    .command('revoke')
    .description(
      'End a delegation from now on. Every later act under it is refused; what was published ' +
        'under it before stays exactly as it was retained'
    )
    .argument('<assignment>', 'The assignment to end')
    .requiredOption('--reason <text>', 'Why the delegation is ending')
    .addOption(invokedByAgentOption())
    .option('--json', 'Emit JSON')
    .action((assignment: string, opts: Record<string, unknown>) =>
      knowledgeAssignmentRevokeAction(assignment, opts)
    );

  // ── skills ───────────────────────────────────────────────────────────────
  // Enable/disable persists a `skills.enabled[id]` override in config.json;
  // materialization happens on the next `orcaops update` (same group shape
  // as `eval`).
  const skillsCmd = program
    .command('skills')
    .description('List or toggle the orcaops skill templates this repo installs');
  skillsCmd
    .command('list')
    .description('Every skill template with its group, default, override, effective state')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => skillsListAction(opts));
  skillsCmd
    .command('enable <id>')
    .description('Enable a skill (records the override; run `orcaops update` to install it)')
    .option('--json', 'Emit JSON')
    .action((id: string, opts: { json?: boolean }) => skillsEnableAction({ id, json: opts.json }));
  skillsCmd
    .command('disable <id>')
    .description('Disable a skill (records the override; run `orcaops update` to prune it)')
    .option('--json', 'Emit JSON')
    .action((id: string, opts: { json?: boolean }) => skillsDisableAction({ id, json: opts.json }));

  program
    .command('show <artifactId>')
    .configureOutput({ writeErr: writeInspectionParseError })
    .description('Inspect a bounded artifact digest or export complete retained evidence')
    .option('--project <id>', 'Select the project containing the artifact')
    .option('--checkpoint <n>', 'Inspect one exact checkpoint', strictIntOrNaN)
    .option('--decision <n>', 'Inspect one plan decision (one-based)', strictIntOrNaN)
    .option(
      '--section <name>',
      'Inspect plan, knowledge, summary, evaluators, usage, or repository'
    )
    .option('--limit <n>', 'Checkpoint index page size (default: 5, maximum: 20)', strictIntOrNaN)
    .option('--cursor <reference>', 'Continue the checkpoint index at its original observation')
    .option('--anchor <reference>', 'Require the original artifact and knowledge observation')
    .option('--output <file>', 'Export the complete selected evidence to a new file')
    .option(
      '--at-boundary <n>',
      'Read continuing knowledge as it stood at this write sequence (default: now)',
      strictIntOrNaN
    )
    .option('--json', 'Emit JSON')
    .action(showAction);

  program
    .command('usage')
    .description('Selected session usage totals and non-additive artifact estimates')
    .option('--artifact <id>', 'Select one exact artifact or unambiguous prefix')
    .option('--scope <scope>', 'worktree | project | all-projects')
    .option('--project <id>', 'Select one project by identity')
    .option('--branch <name>', 'Restrict to one literal branch')
    .option('--origin <origin>', 'captured | imported | all')
    .option('--state <state>', 'Restrict to one artifact state')
    .option('--touching <glob>', 'Restrict to artifacts whose recorded paths match')
    .option('--json', 'Emit JSON')
    .action(usageAction);

  program
    .command('search <query>')
    .description('Search retained project history')
    .option('--scope <scope>', 'worktree | project | all-projects')
    .option('--project <id>', 'Select one project by identity')
    .option('--branch <name>', 'Restrict to one literal branch')
    .option('--origin <origin>', 'captured | imported | all')
    .option('--touching <glob>', 'Restrict to artifacts whose touched paths match')
    .option('--type <kind>', SEARCH_SOURCE_KINDS.join(' | '))
    .option('--limit <n>', 'Max results (default 25)', strictIntOrNaN)
    .option('--offset <n>', 'Skip this many matching results', strictIntOrNaN)
    .option(
      '--knowledge-bytes <n>',
      'Bytes of continuing-knowledge entries this page may carry (default 2048 per result)',
      strictIntOrNaN
    )
    .option('--json', 'Emit JSON')
    .action(searchAction);

  // ── resume ────────────────────────────────────────────────────────────────
  program
    .command('resume')
    .description('Read an explicit artifact or the eligible task in this context without writing')
    .option('--artifact <id>', 'Read an exact artifact UUID or prefix without changing focus')
    .option('--project <id>', 'Select one project by its UUID')
    .option('--branch <name>', 'Restrict implicit task candidates by literal branch membership')
    .option('--copy', 'Copy the suggested prompt block to the system clipboard')
    .option('--format <fmt>', 'Output format: md (default) or json', 'md')
    .option('--json', 'Shorthand for --format json')
    .action(resumeAction);

  // ── why ────────────────────────────────────────────────────────────────
  program
    .command('why <target>')
    .configureOutput({ writeErr: writeInspectionParseError })
    .description('Find ranked provenance for <file> or attribute <file>:<line>')
    .option('--all', 'Default to 1,000 results; processing budgets still apply')
    .option('--view <view>', 'rationale: show explanations under a 32 KiB response allowance')
    .option('--details', 'Inspect one exact candidate under a 16 KiB response allowance')
    .option(
      '--candidate <id>',
      'Select a returned historical candidate id, independently of pagination'
    )
    .option('--anchor <token>', 'Use the inspection anchor returned by the same target and scope')
    .option(
      '--section <name>',
      'Inspect an anchored candidate section; index lists available sections'
    )
    .option(
      '--decision <n>',
      'Select one complete decision in a candidate decision section',
      strictIntOrNaN
    )
    .option(
      '--section-offset <n>',
      'Skip entries in the selected candidate section',
      strictIntOrNaN
    )
    .option(
      '--section-limit <n>',
      'Candidate section page size (default 5, maximum 20)',
      strictIntOrNaN
    )
    .option(
      '--audit',
      'With --details: explicitly compare a candidate page under a 64 KiB allowance'
    )
    .option('--output <file>', 'Export the complete exact candidate to a new file')
    .option('--scope <scope>', 'worktree | project')
    .option('--project <id>', 'Select one registered project by identity')
    .option('--branch <name>', 'Restrict to one literal branch')
    .option('--origin <origin>', 'captured | imported | all')
    .option('--touching <glob>', 'Restrict to artifacts whose touched paths match')
    .option('--at <revision>', 'Resolve the code target at an exact Git revision')
    .option(
      '--at-boundary <n>',
      'Read continuing knowledge as it stood at this write sequence (default: now)',
      strictIntOrNaN
    )
    .option('--limit <n>', 'Max results (default 5)', strictIntOrNaN)
    .option('--offset <n>', 'Skip this many matching results', strictIntOrNaN)
    .option('--json', 'Emit JSON')
    .action(
      (
        target: string,
        opts: {
          all?: boolean;
          details?: boolean;
          view?: 'rationale';
          candidate?: string;
          anchor?: string;
          section?: string;
          decision?: number;
          sectionOffset?: number;
          sectionLimit?: number;
          audit?: boolean;
          output?: string;
          scope?: 'worktree' | 'project';
          project?: string;
          branch?: string;
          origin?: 'captured' | 'imported' | 'all';
          touching?: string;
          at?: string;
          atBoundary?: number;
          limit?: number;
          offset?: number;
          json?: boolean;
        }
      ) => whyAction(target, opts)
    );

  // ── digest ─────────────────────────────────────────────────────────────
  program
    .command('digest [artifact_id]')
    .description('Render a reviewer-facing PR summary for an artifact or branch')
    .option('--artifact <id>', 'Artifact id (defaults to the current task on this branch)')
    .option('--project <id>', 'Qualify the read to one registered project')
    .option('--branch <name>', 'Branch (defaults to current)')
    .option('--branch-wide', 'Combine every captured artifact in the branch PR range')
    .option('--base <ref>', 'Base ref for --branch-wide (defaults to the repository default)')
    .option('--primary-artifact <id>', 'Title source override for --branch-wide')
    .option('--out <file>', 'Write the rendered digest to this file and print a confirmation')
    .option(
      '--at-boundary <n>',
      'Read continuing knowledge as it stood at this write sequence (default: now)',
      strictIntOrNaN
    )
    .option('--format <fmt>', 'Output format: md (default) or json', 'md')
    .option('--json', 'Shorthand for --format json')
    .action(
      (
        artifactId: string | undefined,
        opts: {
          artifact?: string;
          project?: string;
          branch?: string;
          out?: string;
          format?: string;
          json?: boolean;
          branchWide?: boolean;
          base?: string;
          primaryArtifact?: string;
          atBoundary?: number;
        }
      ) =>
        digestAction({
          artifact: opts.artifact,
          artifactArg: artifactId,
          project: opts.project,
          branch: opts.branch,
          out: opts.out,
          format: opts.format === 'json' ? 'json' : 'md',
          json: opts.json,
          branchWide: opts.branchWide,
          base: opts.base,
          primaryArtifact: opts.primaryArtifact,
          ...(opts.atBoundary === undefined ? {} : { atBoundary: opts.atBoundary }),
        })
    );

  addCaptureInputOptions(
    program.command('finish').description('Run pre-PR checks and finalize a clean artifact')
  )
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .action((opts: { input?: string; llm?: boolean }) =>
      finishAction({ input: opts.input, noLlm: opts.llm === false })
    );

  // ── capture ────────────────────────────────────────────────────────────
  const captureCmd = program
    .command('capture')
    .description('Agent-facing capture API (YAML or JSON in, JSON out)');

  // commander negates `--no-llm` into `opts.llm === false`. Each lifecycle
  // command exposes the flag so CI / scripted runs can skip LLM evaluators
  // without spawning the underlying CLI.
  const captureFlagAdapter = makeCaptureFlagAdapter;

  // `orcaops capture plan` covers both the initial capture and
  // append-only revisions: initial capture is the PARENT action (the bare
  // `capture plan --input …` every skill teaches), revisions are the
  // `plan revise` subcommand. Parent and child can share option names
  // (`--input`, `--no-llm`) because `enablePositionalOptions()` is set on
  // the program: the parent's parser stops at the subcommand name, so
  // `revise`'s own options parse after it. (An earlier shape routed initial
  // capture through an explicit `plan capture` subcommand because duplicated
  // parent/child options were swallowed — that predates positional options,
  // which the Commander 14.0.3 probe verified fixes the routing.)
  const planCmd = captureCmd
    .command('plan')
    .description(
      'Plan capture: initial capture (mints stable UUIDv7 step_ids and fires post-plan evaluators); `plan revise` for append-only revisions.'
    );
  addCaptureInputOptions(planCmd)
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .option(
      '--source-plan <ref>',
      'Pin a source plan (reads + hashes the file, stored immutably on the artifact for conformance)'
    )
    // Positional options make the parent consume options written BEFORE a
    // subverb; without this guard `capture plan --no-llm revise …` would
    // silently drop --no-llm instead of applying it to revise.
    .hook('preSubcommand', (thisCmd) => {
      const o = thisCmd.opts() as { input?: string; llm?: boolean; sourcePlan?: string };
      if (o.input !== undefined || o.sourcePlan !== undefined || o.llm === false) {
        writeTerminalSafeStderr(
          "error: place options after 'revise' — options before the subcommand apply to the parent capture action and would be dropped\n"
        );
        throw new CliExit(1);
      }
    })
    .action(captureFlagAdapter(capturePlanAction));
  addCaptureInputOptions(
    planCmd
      .command('revise')
      .description(
        'Append-only plan revision: full-supersede plan_steps with step_lineage diff and post-plan-revision evaluators'
      )
  )
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .action(captureFlagAdapter(capturePlanReviseAction));

  // Two-phase checkpoint lifecycle: open → close (or abandon). No
  // single-call shape; calling `orcaops capture checkpoint` without a
  // subverb prints help.
  const checkpointCmd = captureCmd
    .command('checkpoint')
    .description(
      'Two-phase checkpoint lifecycle: open declares scope, close finalizes it, abandon cancels it'
    );
  addCaptureInputOptions(
    checkpointCmd
      .command('open')
      .description(
        'Declare which plan steps this checkpoint will cover; runs pre-append checkpoint-open evaluators'
      )
  )
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .action(captureFlagAdapter(captureCheckpointOpenAction));
  addCaptureInputOptions(
    checkpointCmd
      .command('close')
      .description('Finalize an open checkpoint; fires checkpoint-close evaluators')
  )
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .action(captureFlagAdapter(captureCheckpointCloseAction));
  addCaptureInputOptions(
    checkpointCmd
      .command('abandon')
      .description('Cancel an open checkpoint without claiming any work; releases declared steps')
  ).action(captureFlagAdapter(captureCheckpointAbandonAction));

  addCaptureInputOptions(
    captureCmd
      .command('summary')
      .description('Capture the final summary and close the artifact thread')
  )
    .option('--no-llm', 'Do not use an LLM to process this captured summary')
    .action(captureFlagAdapter(captureSummaryAction));

  addCaptureInputOptions(
    captureCmd
      .command('run-evaluators')
      .description(
        'Re-run evaluators for a given lifecycle (post-plan / checkpoint-open / checkpoint-close / pre-pr)'
      )
  )
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .action(captureFlagAdapter(captureRunEvaluatorsAction));

  addCaptureInputOptions(
    captureCmd
      .command('pre-pr-check')
      .description(
        'Run the final pre-PR evaluator pass (recommended before summary; not a hard gate)'
      )
  )
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .action(captureFlagAdapter(capturePrePrCheckAction));

  // ── block ──────────────────────────────────────────────────────────────
  // Top-level commands: resolve a block-severity evaluator violation.
  // `block acknowledge`
  // is gated on the evaluator's `on_block: { acknowledgeable: true }`
  // (i.e., the `acknowledge_breaking_change` literal). `block dismiss`
  // is the always-available override path with different audit
  // semantics — doctor surfaces per-evaluator dismiss rates so
  // persistently-dismissed evaluators get flagged for revision.
  const blockCmd = program
    .command('block')
    .description('Resolve a block-severity evaluator violation (acknowledge or dismiss)');

  blockCmd
    .command('acknowledge')
    .description(
      'Formally acknowledge a block-severity violation (gated on evaluator opt-in via resolution.acknowledge.enabled)'
    )
    .requiredOption('--artifact <id>', 'Artifact id')
    .requiredOption('--evaluator <ref>', 'Resolved evaluator ref (e.g. core/api-stability)')
    .requiredOption('--reason <text>', 'Human-readable reason for the acknowledgement')
    .option(
      '--run-id <id>',
      'Specific evaluator run_id (defaults to the latest unresolved blocking run for --evaluator)'
    )
    .option('--agent-session-id <id>', 'Subagent attribution; surfaces in doctor + digest')
    .option('--idempotency-key <key>', 'Idempotency key (auto-generated when omitted)')
    // `--json` is accepted for consistency with the rest of the CLI; output
    // is always a JSON envelope here (the action is `runCapture`-wrapped),
    // so the flag is effectively a no-op. Without it, commander rejected
    // the flag entirely — surprising for a command whose only output is
    // JSON.
    .option('--json', 'Emit JSON (always emitted; flag accepted for consistency)')
    .action(
      (opts: {
        artifact: string;
        evaluator: string;
        reason: string;
        runId?: string;
        agentSessionId?: string;
        idempotencyKey?: string;
      }) => blockAcknowledgeAction(opts)
    );

  blockCmd
    .command('dismiss')
    .description(
      'Dismiss a block-severity violation (always available; persistent dismissals flagged by doctor)'
    )
    .requiredOption('--artifact <id>', 'Artifact id')
    .requiredOption('--evaluator <ref>', 'Resolved evaluator ref (e.g. core/api-stability)')
    .requiredOption('--reason <text>', 'Human-readable reason for the dismissal')
    .option(
      '--run-id <id>',
      'Specific evaluator run_id (defaults to the latest unresolved blocking run for --evaluator)'
    )
    .option('--agent-session-id <id>', 'Subagent attribution; surfaces in doctor + digest')
    .option('--idempotency-key <key>', 'Idempotency key (auto-generated when omitted)')
    // See `block acknowledge` above for the --json rationale.
    .option('--json', 'Emit JSON (always emitted; flag accepted for consistency)')
    .action(
      (opts: {
        artifact: string;
        evaluator: string;
        reason: string;
        runId?: string;
        agentSessionId?: string;
        idempotencyKey?: string;
      }) => blockDismissAction(opts)
    );

  // ── eval ───────────────────────────────────────────────────────────────
  const evalCmd = program.command('eval').description('Inspect, run, or test evaluators');

  evalCmd
    .command('list')
    .description('List all discovered evaluators with severity / phase / engine')
    .option('--json', 'Emit JSON')
    .option('--strict', 'Exit 2 if any pack failed to load (instead of silently skipping it)')
    .action((opts: { json?: boolean; strict?: boolean }) =>
      evalListAction({
        ...(opts.json !== undefined ? { json: opts.json } : {}),
        ...(opts.strict !== undefined ? { strict: opts.strict } : {}),
      })
    );

  evalCmd
    .command('show <ref>')
    .description(
      'Render a single evaluator by ref (e.g. core/api-stability); raw YAML by default, JSON with --json'
    )
    .option('--json', 'Emit parsed evaluator as JSON')
    .action(evalShowAction);

  evalCmd
    .command('schema <kind>')
    .description(
      `Print the generated JSON Schema for an author-facing shape (${SCHEMA_KIND_NAMES.join(' | ')}) — ` +
        'the INPUT shape you write, not the parsed output the loader fills in for you. ' +
        'Structural only: cross-field rules live in refinement code the generator cannot ' +
        'recover, so orcaops parsing and `eval test` stay authoritative. Needs no repository.'
    )
    .option('--json', 'No-op alias; a JSON Schema has no human form, so output is always JSON')
    .option(
      '--example',
      'Print a commented, ready-to-paste example FILE instead of its schema (spec | manifest)'
    )
    .action((kind: string, opts: { example?: boolean }) =>
      evalSchemaAction({ kind, ...(opts.example !== undefined ? { example: opts.example } : {}) })
    );

  evalCmd
    .command('run')
    .description('Run a single evaluator against an existing artifact (persists the run)')
    .requiredOption('--ref <ref>', 'Resolved evaluator ref (e.g. core/api-stability)')
    .option('--artifact <id>', 'Artifact id (defaults to latest)')
    .option(
      '--checkpoint <n>',
      'Checkpoint number (required for checkpoint-open/close evaluators)',
      parsePositiveInt
    )
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .option('--json', 'Emit JSON')
    .action(
      (opts: {
        ref: string;
        artifact?: string;
        checkpoint?: number;
        llm?: boolean;
        json?: boolean;
      }) =>
        evalRunAction({
          ref: opts.ref,
          ...(opts.artifact !== undefined ? { artifact: opts.artifact } : {}),
          ...(opts.checkpoint !== undefined ? { checkpoint: opts.checkpoint } : {}),
          noLlm: opts.llm === false,
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        })
    );

  evalCmd
    .command('add-pack <source> [pack-id]')
    .description(
      'Install an evaluator pack from @orcaops/evaluator-pack (bundled), a local path, or a third-party @scope/package'
    )
    .addOption(
      new Option(
        '--profile <name>',
        'Which evaluators to enable on first install: deterministic (default) | all'
      )
        .choices(['deterministic', 'all'])
        .default('deterministic')
    )
    .option('--disabled', 'Register the pack but enable nothing')
    .option('--yes', 'Skip the trust-boundary confirmation prompt')
    .option(
      '--dev',
      'Bind the grant to the resolved workspace path (mutable dev source) instead of a ' +
        'fingerprint, in the same act as registration. Path sources only; does not imply --yes'
    )
    .option('--force', 'Overwrite an existing packages[] entry + re-seed evaluators[] entries')
    .option('--json', 'Emit JSON')
    .action(
      (
        source: string,
        packId: string | undefined,
        opts: {
          profile?: AddPackProfile;
          disabled?: boolean;
          yes?: boolean;
          dev?: boolean;
          force?: boolean;
          json?: boolean;
        }
      ) =>
        evalAddPackAction({
          source,
          ...(packId !== undefined ? { packId } : {}),
          ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
          ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
          ...(opts.yes !== undefined ? { yes: opts.yes } : {}),
          ...(opts.dev !== undefined ? { dev: opts.dev } : {}),
          ...(opts.force !== undefined ? { force: opts.force } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        })
    );

  evalCmd
    .command('remove-pack <pack-id>')
    .description('Remove a registered pack + every evaluators[] entry under its id')
    .option('--json', 'Emit JSON')
    .action((packId: string, opts: { json?: boolean }) =>
      evalRemovePackAction({ packId, ...(opts.json !== undefined ? { json: opts.json } : {}) })
    );

  evalCmd
    .command('update-pack <pack-id>')
    .description('Re-resolve a pack source + revalidate. Preserves user overrides.')
    .option('--json', 'Emit JSON')
    .action((packId: string, opts: { json?: boolean }) =>
      evalUpdatePackAction({ packId, ...(opts.json !== undefined ? { json: opts.json } : {}) })
    );

  evalCmd
    .command('trust <pack-id>')
    .description(
      'Inspect and grant (or revoke) the USER-LOCAL consent for a pack — repo config never authorizes'
    )
    .option('--dev', 'Bind the grant to the resolved workspace path (mutable dev source)')
    .option('--revoke', 'Remove the user-local grant')
    .option('--yes', 'Accept without the interactive prompt')
    .option('--json', 'Emit JSON')
    .action(
      (packId: string, opts: { dev?: boolean; revoke?: boolean; yes?: boolean; json?: boolean }) =>
        evalTrustAction({ packId, ...opts })
    );

  evalCmd
    .command('enable <ref>')
    .description('Toggle an evaluator on (sets evaluators.<ref>.enabled: true)')
    .option('--json', 'Emit JSON')
    .action((ref: string, opts: { json?: boolean }) =>
      evalEnableAction({ ref, ...(opts.json !== undefined ? { json: opts.json } : {}) })
    );

  evalCmd
    .command('disable <ref>')
    .description('Toggle an evaluator off (sets evaluators.<ref>.enabled: false)')
    .option('--json', 'Emit JSON')
    .action((ref: string, opts: { json?: boolean }) =>
      evalDisableAction({ ref, ...(opts.json !== undefined ? { json: opts.json } : {}) })
    );

  evalCmd
    .command('fork-pack <pack-id>')
    .description(
      'Copy the resolved pack source into --to <path> and switch its packages[] entry to kind: path'
    )
    .requiredOption('--to <path>', 'Target directory for the forked pack copy')
    .option('--json', 'Emit JSON')
    .action((packId: string, opts: { to: string; json?: boolean }) =>
      evalForkPackAction({
        packId,
        to: opts.to,
        ...(opts.json !== undefined ? { json: opts.json } : {}),
      })
    );

  evalCmd
    .command('test')
    .description(
      'Run an evaluator against a JSON fixture file (synthesizes a fixture- artifact; result is NOT persisted as a real run)'
    )
    // Not `requiredOption`s: --print-example-fixture takes neither, and
    // commander would reject the call before the action could print.
    .option('--ref <ref>', 'Resolved evaluator ref')
    .option('--fixture <path>', 'Path to a JSON fixture file with plan/checkpoints/summary')
    .option(
      '--print-example-fixture',
      'Print a valid example fixture to stdout and exit (needs no repository)'
    )
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .option('--json', 'Emit JSON')
    .action(
      (opts: {
        ref?: string;
        fixture?: string;
        printExampleFixture?: boolean;
        llm?: boolean;
        json?: boolean;
      }) =>
        evalTestAction({
          ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
          ...(opts.fixture !== undefined ? { fixture: opts.fixture } : {}),
          ...(opts.printExampleFixture !== undefined
            ? { printExampleFixture: opts.printExampleFixture }
            : {}),
          noLlm: opts.llm === false,
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        })
    );

  // ── login / logout / push ───────────────────────────────────────────────
  program
    .command('login')
    .description('Authorize this machine against an orcaops cloud workspace via OAuth 2.1')
    .option('--force-consent', 'Force the consent page even if prior consent exists')
    .option('--reauth', 'Force full re-auth — org picker shown even for single-org users')
    .option('--json', 'Emit JSON')
    .action((opts: { forceConsent?: boolean; reauth?: boolean; json?: boolean }) =>
      loginAction({
        baseUrl: cloudBaseUrl,
        forceConsent: opts.forceConsent,
        reauth: opts.reauth,
        json: opts.json,
      })
    );

  program
    .command('logout', hideCloud)
    .description('Revoke and clear the current cloud session')
    .option(
      '--all',
      'Log out of every saved cloud (FileStore only); clears the entire credential file'
    )
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean; all?: boolean }) =>
      logoutAction({ baseUrl: cloudBaseUrl, json: opts.json, all: opts.all })
    );

  program
    .command('whoami', hideCloud)
    .description('Show the current cloud session (user, org, expiry)')
    .option('--verify', 'Hit a known protected endpoint to confirm the cloud accepts the token')
    .option('--json', 'Emit JSON')
    .action((opts: { verify?: boolean; json?: boolean }) =>
      whoamiAction({ baseUrl: cloudBaseUrl, verify: opts.verify, json: opts.json })
    );

  const org = program.command('org', hideCloud).description('Manage active organization');
  org
    .command('switch')
    .description('Re-authorize with the org picker — alias for `login --reauth`')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) =>
      orgSwitchAction({ baseUrl: cloudBaseUrl, json: opts.json })
    );

  program
    .command('auth-state', hideCloud)
    .description('Print the cloud AuthState (connected | expired | not_connected)')
    .option('--no-json', 'Emit human-readable text instead of JSON (JSON is the default)')
    .action((opts: { json?: boolean }) =>
      authStateAction({ baseUrl: cloudBaseUrl, json: opts.json !== false })
    );

  program
    .command('push <artifact_id>', hideCloud)
    .description('Upload an artifact (plan + checkpoints + summary + evaluators) to the cloud')
    .option('--force', 'Push even when the artifact tree matches the last successful push')
    .option('--json', 'Emit JSON')
    .action((artifactId: string, opts: { force?: boolean; json?: boolean }) =>
      pushAction(artifactId, { force: opts.force, baseUrl: cloudBaseUrl, json: opts.json })
    );

  program
    .command('resync', hideCloud)
    .description(
      'Retry any artifacts whose last eager push may have failed (offline, network, etc.)'
    )
    .option('--force', 'Ignore per-artifact backoff and retry every pending artifact')
    .option('--json', 'Emit JSON')
    .action((opts: { force?: boolean; json?: boolean }) =>
      resyncAction({ force: opts.force, baseUrl: cloudBaseUrl, json: opts.json })
    );

  // ── watch ─────────────────────────────────────────────────────────────────
  // Delegation stub: spawn the standalone `orcaops-watch` app (OpenTUI, runs
  // under Bun) so its Bun/renderer runtime never enters this CLI's Node process.
  // allowUnknownOption + passThroughOptions forward every watch flag verbatim
  // (`--interval`, `--probe`, `--selfcheck`, …) to the child. `--root` is the
  // exception: addRootOptionRecursively declares it here, so commander consumes
  // it — the action re-forwards it via ORCAOPS_ROOT.
  program
    .command('watch')
    .description('Live cross-project agent dashboard (delegates to the orcaops-watch app)')
    .argument('[args...]', 'flags forwarded verbatim to the orcaops-watch app')
    .allowUnknownOption()
    .passThroughOptions()
    .action((args: string[]) => {
      return watchAction(args, getInvocationRootOverride());
    });

  // ── review ────────────────────────────────────────────────────────────────
  // ONE top-level `review` group carrying two surfaces:
  //  1. Named subcommands (registered below) — the cloud review-feedback loop
  //     (status/pull/reply/resolve/watch), each owning its commander options.
  //  2. Fallback action — the Task Review data layer (floor / journal /
  //     comments / anchor verbs), run IN-PROCESS from
  //     @orcaops/review-engine, passthrough shape like `watch`. Engine verbs
  //     (data/journal/comments/comment/anchor) are disjoint
  //     from the feedback verbs, so dispatch is unambiguous.
  const reviewCommandGroup = program
    .command('review')
    .description(
      cloud
        ? 'Review: feedback loop (status/pull/reply/resolve/watch) + Task Review data-layer verbs'
        : 'Task Review data-layer verbs (data / journal / comments / anchor)'
    )
    .argument('[args...]', 'engine verb + flags (e.g. `data --branch <b>`)')
    .allowUnknownOption()
    .passThroughOptions()
    // No commander help: a leading `--help`/`-h` flows through to the engine's
    // own verb usage (commander's stub knows nothing about the engine verbs).
    .helpOption(false)
    .action((args: string[]) => {
      return reviewAction(args, getInvocationRootOverride());
    });

  // ── plan (cloud source-plan review track) ────────────────────────────────
  // Distinct from `capture plan` (the artifact's own plan): this group manages
  // the cloud SourcePlan review surface — upload a plan for review, pull the
  // approved version into project history for `--source-plan cloud:…`.
  const planGroup = program
    .command('plan', hideCloud)
    .description('Cloud source-plan review track: upload a plan for review, pull the approved one');
  planGroup
    .command('upload <file>')
    .description('Upload a local plan file to the cloud as a draft for review')
    .requiredOption('--title <title>', 'Human-readable plan title (required)')
    .option(
      '--reviewer <handle>',
      'Reviewer to request (repeatable)',
      (v: string, acc: string[]) => [...acc, v],
      [] as string[]
    )
    .option('--review-note <note>', 'Note for reviewers')
    .option('--json', 'Emit JSON')
    .action(
      (
        file: string,
        opts: {
          title: string;
          reviewer?: string[];
          reviewNote?: string;
          json?: boolean;
        }
      ) =>
        planUploadAction(file, {
          title: opts.title,
          reviewer: opts.reviewer,
          reviewNote: opts.reviewNote,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );
  planGroup
    .command('pull <idOrSlug>')
    .description('Pull the approved version of a cloud plan into project history')
    .option('--out <path>', 'Also write the plan body to this file (records lineage for born-pins)')
    .option('--json', 'Emit JSON')
    .action((idOrSlug: string, opts: { out?: string; json?: boolean }) =>
      planPullAction(idOrSlug, { out: opts.out, baseUrl: cloudBaseUrl, json: opts.json })
    );

  // Nested review track under the cloud `plan` group (sibling to upload/pull):
  // pull a candidate/proposal, propose edits, push (author), or comment. Kept
  // OFF the capture-pin path — a review body is never pinnable as cloud:<id>@<n>.
  const reviewGroup = planGroup
    .command('review')
    .description(
      'Review track: view/list/status the review state; pull, propose, push or request reviewers (author), or comment'
    );
  reviewGroup
    .command('pull <ref>')
    .description('Pull the under-review candidate (or --proposal <id>) into project history')
    .option('--proposal <id>', 'Pull this proposal instead of the candidate')
    .addOption(
      new Option(
        '--version <n>',
        'Pull a sealed historical version (read-only — not retained, NOT a push base)'
      ).conflicts('proposal')
    )
    .option('--out <path>', 'Also write the body to this file (file-first; NOT a pinnable anchor)')
    .option('--json', 'Emit JSON')
    .action(
      (
        ref: string,
        opts: {
          proposal?: string;
          version?: string;
          out?: string;
          json?: boolean;
        }
      ) =>
        reviewPullAction(ref, {
          proposal: opts.proposal,
          version: opts.version,
          out: opts.out,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );
  reviewGroup
    .command('propose <ref>')
    .description('File the edited body as a reviewer proposal off the pulled candidate')
    .option('--input <file>', "Body file, or '-' for stdin (defaults to piped stdin)")
    .option(
      '--base-version-id <id>',
      'Base candidate version id (headless/CI; bypasses the retained candidate)'
    )
    .option('--supersedes <proposalId>', 'Supersede your own OPEN proposal (rebase chain)')
    .option('--summary <text>', 'Proposal summary')
    .option('--source-ref <ref>', 'Provenance ref recorded on the proposal')
    .option('--json', 'Emit JSON')
    .action(
      (
        ref: string,
        opts: {
          input?: string;
          baseVersionId?: string;
          supersedes?: string;
          summary?: string;
          sourceRef?: string;
          json?: boolean;
        }
      ) =>
        reviewProposeAction(ref, {
          input: opts.input,
          baseVersionId: opts.baseVersionId,
          supersedes: opts.supersedes,
          summary: opts.summary,
          sourceRef: opts.sourceRef,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );
  reviewGroup
    .command('push <ref>')
    .description('Seal a new candidate version from the edited body (author only)')
    .option('--input <file>', "Body file, or '-' for stdin (defaults to piped stdin)")
    .option(
      '--base-version-id <id>',
      'Expected candidate version id (headless/CI; bypasses the retained candidate)'
    )
    .addOption(
      new Option(
        '--on-conflict <mode>',
        'On a CAS conflict: fail (default) or re-file the edit as a proposal'
      )
        .choices(['fail', 'propose'])
        .default('fail')
    )
    .option('--json', 'Emit JSON')
    .action(
      (
        ref: string,
        opts: {
          input?: string;
          baseVersionId?: string;
          onConflict?: string;
          json?: boolean;
        }
      ) =>
        reviewPushAction(ref, {
          input: opts.input,
          baseVersionId: opts.baseVersionId,
          onConflict: opts.onConflict,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );
  reviewGroup
    .command('comment <ref>')
    .description('Comment on the pulled candidate (default) or a proposal (--proposal)')
    .option('--input <file>', "Comment body file, or '-' for stdin (defaults to piped stdin)")
    .option('--quote <text>', 'Anchor the comment to this span (cloud-resolved)')
    .option('--disambiguator <text>', 'Preceding text to disambiguate a repeated quote')
    .option('--proposal <id>', 'Comment on this proposal instead of the candidate')
    .addOption(
      new Option(
        '--reply-to <commentId>',
        'Reply to an existing comment (inherits its target; one level only)'
      ).conflicts(['quote', 'disambiguator', 'proposal'])
    )
    .option('--json', 'Emit JSON')
    .action(
      (
        ref: string,
        opts: {
          input?: string;
          quote?: string;
          disambiguator?: string;
          proposal?: string;
          replyTo?: string;
          json?: boolean;
        }
      ) =>
        reviewCommentAction(ref, {
          input: opts.input,
          quote: opts.quote,
          disambiguator: opts.disambiguator,
          proposal: opts.proposal,
          replyTo: opts.replyTo,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );
  reviewGroup
    .command('view <ref>')
    .description('Show the full review state: candidate, verdicts, proposals, comments (triage)')
    .option('--proposal <id>', 'Scope the view to this proposal and its comment thread')
    .option(
      '--comments',
      'Render the full root comment thread with nested replies (verdict-replies: --history)'
    )
    .option('--history', "Show each reviewer's full verdict trail across versions")
    .option('--json', 'Emit JSON')
    .action(
      (
        ref: string,
        opts: {
          proposal?: string;
          comments?: boolean;
          history?: boolean;
          json?: boolean;
        }
      ) =>
        reviewViewAction(ref, {
          proposal: opts.proposal,
          comments: opts.comments,
          history: opts.history,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );
  reviewGroup
    .command('list')
    .description('List plans under review for the org (default --state in-review)')
    .option(
      '--state <state>',
      'Filter by state: in-review | approved | pinned | all (repeatable)',
      (v: string, acc: string[]) => [...acc, v],
      [] as string[]
    )
    .option('--author <handle>', 'Plans authored by this handle (v1 handles are full emails)')
    .option('--reviewer <handle>', 'Plans where this handle is a requested reviewer')
    .option('--mine', 'Shorthand for plans you authored')
    .option('--limit <n>', 'Max rows, 1-100 (default 30; truncation is announced)')
    .option('--json', 'Emit JSON')
    .action(
      (opts: {
        state?: string[];
        author?: string;
        reviewer?: string;
        mine?: boolean;
        limit?: string;
        json?: boolean;
      }) =>
        reviewListAction({
          state: opts.state,
          author: opts.author,
          reviewer: opts.reviewer,
          mine: opts.mine,
          limit: opts.limit,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );
  reviewGroup
    .command('status')
    .description('Your review landing page: plans you authored + plans wanting your review')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) =>
      reviewStatusAction({ baseUrl: cloudBaseUrl, json: opts.json })
    );
  reviewGroup
    .command('request <ref>')
    .description('Add reviewers to an existing plan without publishing a body version')
    .option(
      '--reviewer <identifier>',
      'Reviewer email or unique name (repeatable)',
      (value: string, reviewers: string[] = []) => [...reviewers, value]
    )
    .option(
      '--resend',
      'Send the request again even when an identical one was already journalled (re-add a reviewer removed on the web, or retry an identifier that was unresolved while the member was pending)'
    )
    .option('--json', 'Emit JSON')
    .action((ref: string, opts: { reviewer: string[]; resend?: boolean; json?: boolean }) =>
      reviewRequestAction(ref, { ...opts, baseUrl: cloudBaseUrl })
    );
  reviewGroup
    .command('reviewers')
    .description('List addressable reviewers for --reviewer (org members; repo-aware scope)')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) =>
      reviewersAction({ baseUrl: cloudBaseUrl, json: opts.json })
    );
  reviewGroup
    .command('verdict <ref>')
    .description(
      'Record your advisory reviewer verdict (requested reviewers only; never transitions the plan)'
    )
    .addOption(new Option('--approve', 'Verdict: approved').conflicts('requestChanges'))
    .option('--request-changes', 'Verdict: changes requested')
    .option('--note <text>', 'Optional note recorded with the verdict')
    .option('--json', 'Emit JSON')
    .action(
      (
        ref: string,
        opts: {
          approve?: boolean;
          requestChanges?: boolean;
          note?: string;
          json?: boolean;
        }
      ) =>
        reviewVerdictAction(ref, {
          approve: opts.approve,
          requestChanges: opts.requestChanges,
          note: opts.note,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );
  reviewGroup
    .command('decline <ref>')
    .description('Decline a proposal on your plan (author only; OPEN → DECLINED)')
    .requiredOption('--proposal <id>', 'The proposal to decline')
    .option('--reason <text>', 'Recorded reason (surfaces in view and on the web)')
    .option('--json', 'Emit JSON')
    .action((ref: string, opts: { proposal: string; reason?: string; json?: boolean }) =>
      reviewDeclineAction(ref, {
        proposal: opts.proposal,
        reason: opts.reason,
        baseUrl: cloudBaseUrl,
        json: opts.json,
      })
    );
  reviewGroup
    .command('approve <ref>')
    .description(
      'Open the web approval page (approval itself is web-only); --wait polls until approved'
    )
    .option('--wait', 'Poll until the plan is approved, then print the pin ref')
    .option('--timeout <sec>', 'Poll budget in seconds with --wait (default 600; timeout exits 2)')
    .option('--no-open', 'Print the approval URL instead of opening a browser')
    .option('--json', 'Emit JSON')
    .action(
      (ref: string, opts: { wait?: boolean; timeout?: string; open?: boolean; json?: boolean }) =>
        reviewApproveAction(ref, {
          wait: opts.wait,
          timeout: opts.timeout,
          open: opts.open,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );
  reviewGroup
    .command('diff <ref>')
    .description(
      'Prose diff, rendered locally: approved → candidate (default), candidate → proposal, or sealed vN → vM/candidate'
    )
    .option('--proposal <id>', 'Diff the current candidate against this proposal')
    .addOption(
      new Option(
        '--from <n>',
        'Diff FROM this sealed version ("what changed since I reviewed vN?")'
      ).conflicts('proposal')
    )
    .option('--to <m>', 'Diff TO this sealed version (requires --from; default: the candidate)')
    .option('--json', 'Emit JSON')
    .action(
      (ref: string, opts: { proposal?: string; from?: string; to?: string; json?: boolean }) =>
        reviewDiffAction(ref, {
          proposal: opts.proposal,
          from: opts.from,
          to: opts.to,
          baseUrl: cloudBaseUrl,
          json: opts.json,
        })
    );

  // ── review (cloud review-feedback loop) ──────────────────────────────────
  // Distinct from `plan review` (source-plan review track): these named
  // subcommands ride the merged top-level `review` group declared above —
  // unmatched verbs fall through to the review-engine passthrough there.
  const reviewFeedbackGroup = reviewCommandGroup;
  reviewFeedbackGroup
    .command('status', hideCloud)
    .description("My open PRs' review state + the new-human-activity flag")
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) =>
      reviewFeedbackStatusAction({ ...opts, baseUrl: cloudBaseUrl })
    );
  reviewFeedbackGroup
    .command('pull', hideCloud)
    .description('Pull the full anchored review transcript (agent-readable markdown)')
    .option('--task <n>', 'Resolve via task number (its single open reviewed PR)')
    .option('--pr <id>', 'Pull for this pull_request_id')
    .option('--out <path>', 'Also write the markdown to this file')
    .option('--json', 'Emit JSON (the raw transcript)')
    .action((opts: { task?: string; pr?: string; out?: string; json?: boolean }) =>
      reviewFeedbackPullAction({ ...opts, baseUrl: cloudBaseUrl })
    );
  reviewFeedbackGroup
    .command('reply <commentId>', hideCloud)
    .description('Reply in-thread as AGENT (posts live; does not resolve)')
    .requiredOption('--message <text>', 'Reply body')
    .option(
      '--pass-token <cursor>',
      'Activity cursor echoed from `review pull` (coalesces notifications)'
    )
    .option(
      '--idempotency-key <key>',
      'Identify one exact operation; a new key authors a new operation after inspection'
    )
    .option('--json', 'Emit JSON')
    .action(
      (
        commentId: string,
        opts: { message: string; passToken?: string; idempotencyKey?: string; json?: boolean }
      ) => reviewFeedbackReplyAction(commentId, { ...opts, baseUrl: cloudBaseUrl })
    );
  reviewFeedbackGroup
    .command('resolve <commentId>', hideCloud)
    .description("Resolve a thread (the reviewer's verb — agents reply, humans resolve)")
    .option(
      '--idempotency-key <key>',
      'Identify one exact operation; a new key authors a new operation after inspection'
    )
    .option('--json', 'Emit JSON')
    .action((commentId: string, opts: { idempotencyKey?: string; json?: boolean }) =>
      reviewFeedbackResolveAction(commentId, { ...opts, baseUrl: cloudBaseUrl })
    );
  reviewFeedbackGroup
    .command('watch', hideCloud)
    .description('Bounded poll for new HUMAN review activity (exit 0 = new, exit 2 = timeout)')
    .option('--task <n>', 'Watch via task number')
    .option('--pr <id>', 'Watch this pull_request_id')
    .option('--timeout <sec>', 'Give up after this many seconds (default 600)')
    .option('--json', 'Emit JSON')
    .action((opts: { task?: string; pr?: string; timeout?: string; json?: boolean }) =>
      reviewFeedbackWatchAction({ ...opts, baseUrl: cloudBaseUrl })
    );

  // `--root <path>` is accepted on every command (appended position) AND on the
  // program itself (before the subcommand). The hook copies the parsed value
  // into the per-invocation ALS frame so the root resolver reads it without any
  // module-level state — isolated per in-process agent. Fires only for an actual
  // action (not --help/--version).
  //
  // It reads `optsWithGlobals()`, NOT `opts()`: for a NESTED command
  // (`orcaops eval list --root …`) Commander binds the appended value to the
  // PARENT (`eval`), so the leaf's `opts().root` is undefined. `optsWithGlobals`
  // walks the whole ancestor chain (leaf → … → program) and finds it wherever it
  // landed, regardless of nesting depth or flag position.
  addRootOptionRecursively(program);
  program.option(
    '--root <path>',
    'Resolve .orcaops at <path> instead of discovering the git worktree root (also via ORCAOPS_ROOT)'
  );
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals() as { root?: string; invokedByAgent?: string };
    setInvocationRootOverride(opts.root);
    // Root belongs to invocation routing; strict command validators must only
    // receive their own domain options after the override has been captured.
    delete (actionCommand.opts() as { root?: string }).root;
    // Same ALS pattern as --root: the invoking-agent resolver (and the
    // usage stamp running outside the action body) reads it from the
    // invocation frame instead of threading every action signature.
    setInvocationInvokedByAgent(opts.invokedByAgent);
  });

  // First-run nudge: bare `orcaops` (no subcommand). When a committed
  // install.json points at gitignored (absent) generated trees — the fresh-clone case
  // under generated_files:"ignore" — advise materializing them (auto-run `update` under
  // CI). Best-effort: never throws, and still prints help so bare `orcaops` is unchanged
  // for an already-materialized repo. NOT an npm postinstall.
  program.action(async () => {
    try {
      const cwd = getInvocationCwd();
      const repoRoot = (await resolveExplicitOverride(cwd)) ?? (await discoverGitRoot(cwd));
      if (repoRoot) {
        const inc = await detectInstallIncompleteness(
          repoRoot,
          resolveSkillGates(getInvocationEnv())
        );
        if (inc) {
          if (isCi(getInvocationEnv().CI)) {
            writeTerminalSafeStderr('orcaops: materializing skills for this checkout…\n');
            await updateAction({ cwd: repoRoot });
          } else {
            writeTerminalSafeStderr(formatIncompletenessNudge(inc) + '\n');
          }
        }
      }
    } catch {
      // a first-run nudge must never break bare `orcaops`
    }
    program.outputHelp();
  });

  return program;
}
