import { Command, InvalidArgumentError, Option } from 'commander';

import { assertSafeCloudUrl, hasCloudCredentials, setDefaultCliVersion } from '@orcaops/core';
import { SEARCH_TYPES } from '@orcaops/evaluator-protocol/search-types';

import {
  archiveDisableAction,
  archiveEnableAction,
  archivePruneAction,
  archiveRepairAction,
  archiveResolveAction,
  archiveStatusAction,
} from '../commands/archive.js';
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
import { type HookAgent, hookSessionStartAction } from '../commands/hook-session-start.js';
import { initAction } from '../commands/init.js';
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
import { uninstallAction } from '../commands/uninstall.js';
import { updateAction } from '../commands/update.js';
import { usageAction } from '../commands/usage.js';
import { watchAction } from '../commands/watch.js';
import { whoamiAction } from '../commands/whoami.js';
import { whyAction } from '../commands/why.js';
import { CliExit } from '../io/exit.js';
import { writeTerminalSafeStderr, writeTerminalSafeStdout } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { detectInstallIncompleteness, formatIncompletenessNudge } from '../lib/install-drift.js';
import {
  getInvocationCwd,
  getInvocationEnv,
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

function parseNonNegativeInt(value: string): number {
  const n = parseDigitInt(value);
  if (n === null) {
    throw new InvalidArgumentError('expected a non-negative integer');
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
 * Add the canonical `--input` capture-payload option to a capture
 * subcommand — `-` for stdin or a file path, wire format auto-detected
 * (YAML is a superset of JSON). `readPayloadInput` owns stdin/file
 * resolution. Returns the command for fluent chaining.
 */
function addCaptureInputOptions(cmd: Command): Command {
  return cmd
    .option('--input <value>', "Capture payload: '-' for stdin, or a file path (YAML or JSON)")
    .option(
      '--invoked-by-agent <id>',
      'Attribute this capture to the invoking coding agent ' +
        '(claude-code|cursor|codex|opencode|aider|github-copilot|antigravity-cli|other); ' +
        'also via ORCAOPS_INVOKED_BY_AGENT, else auto-detected from the environment'
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
    .description(
      'Bootstrap orcaops in the current repo (archive content conflicts warn; applied init remains successful)'
    )
    .option('--force', 'Reconcile and overwrite Orcaops-managed files; preserve current config')
    .option(
      '--reset-config',
      'With --force, replace config with current defaults; artifacts and cache data are preserved'
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
    // pinned by 'init defaults to no AGENTS.md / CLAUDE.md mutation' in
    // tests/integration/cli.test.ts.
    .option(
      '--agents-md',
      'Add the recommended orcaops lifecycle block to AGENTS.md / CLAUDE.md for automatic capture on non-trivial tasks'
    )
    .option(
      '--no-agents-md',
      'Do not manage an orcaops lifecycle block in AGENTS.md / CLAUDE.md (the default for unattended init)'
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
  // runs (apply persists config, then updateAction reconciles), with archive
  // and git hooks routed through their own machinery. TTY-only by design;
  // scripts use the update flags.
  program
    .command('configure')
    .description(
      'Interactively review and change orcaops settings (agents, session hooks, block, prefix, scope, hints, archive, git hooks)'
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
      'Also delete the entire .orcaops/ directory (config + captured artifacts) for a full pre-init round-trip'
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
    .description('Rebuild the SQLite cache from authoritative artifact event logs')
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
  // Pin focus to a specific artifact for the current shell, or clear
  // the pin. Pin lives outside
  // the repo at $XDG_STATE_HOME/orcaops/pins/<repo-id>/<shell-key-id>.json.
  program
    .command('checkout [artifactId]')
    .description('Pin focus to <artifact-id> for this shell (persists), or --clear to remove')
    .option('--clear', 'Clear the pin for the current shell instead of writing one')
    .option('--json', 'Emit JSON')
    .action(async (artifactId: string | undefined, opts: { clear?: boolean; json?: boolean }) =>
      checkoutAction({
        artifactId,
        clear: opts.clear,
        json: opts.json,
      })
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
  // Garbage collection for stale pins, abandoned summarized artifacts,
  // and stale review dirs. Unreachable nonterminal artifacts are reported.
  // Dry-run by default.
  program
    .command('gc')
    .description(
      'Garbage-collect stale pins / abandoned summarized / stale review dirs; report nonterminal orphans'
    )
    .option(
      '--retention-days <n>',
      'Retention window for abandoned summarized artifacts and stale review dirs (overrides config.gc.retention_days)',
      parseNonNegativeInt
    )
    .option('--apply', 'Actually delete candidates (default is dry-run)')
    .option('--json', 'Emit JSON')
    .action((opts: { retentionDays?: number; apply?: boolean; json?: boolean }) =>
      gcAction({
        retentionDays: opts.retentionDays,
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
    .option('--json', 'Emit JSON')
    .action(
      (opts: {
        attribution?: boolean;
        reconcile?: boolean;
        unattributed?: boolean;
        base?: string;
        target?: string;
        artifact?: string;
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
    .option('--json', 'Emit a JSON envelope')
    .action((opts: { commit?: string; out?: string; notes?: boolean; json?: boolean }) =>
      exportAgentTraceAction(opts)
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
    .option('--artifact <id>', 'Total-wipe every ref of one artifact')
    .option('--orphans', 'Prune refs whose artifact is absent + malformed refs')
    .option('--all', 'Prune every refs/orcaops/snap/* ref (requires --apply)')
    .option('--apply', 'Actually delete candidates (default is dry-run)')
    .option(
      '--allow-underived',
      'Apply even when candidates lack stored/cached manifests (archive-enabled repos only)'
    )
    .option('--json', 'Emit JSON')
    .action(
      (opts: {
        artifact?: string;
        orphans?: boolean;
        all?: boolean;
        apply?: boolean;
        allowUnderived?: boolean;
        json?: boolean;
      }) =>
        snapshotsPruneAction({
          artifact: opts.artifact,
          orphans: opts.orphans,
          all: opts.all,
          apply: opts.apply,
          allowUnderived: opts.allowUnderived,
          json: opts.json,
        })
    );

  // ── archive ─────────────────────────────────────────────────────────────
  // Home-dir archive. Parent is a thin router; `--json` lives on
  // the leaves only (commander parent-`--json` swallow gotcha, above).
  const archiveCmd = program
    .command('archive')
    .description('Manage the home-dir archive (mirror of captured history)');
  archiveCmd
    .command('enable')
    .description(
      'Strictly enable the home-dir archive and backfill (content conflicts keep it enabled but exit nonzero)'
    )
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => archiveEnableAction({ json: opts.json }));
  archiveCmd
    .command('disable')
    .description('Turn off archive mirroring (archived data is retained; prune deletes)')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => archiveDisableAction({ json: opts.json }));
  archiveCmd
    .command('status')
    .description('Show archive identity, mirror lag, and perms posture')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => archiveStatusAction({ json: opts.json }));
  archiveCmd
    .command('repair')
    .description(
      'Backfill safe gaps and report content-blocked artifacts without failing the whole repair'
    )
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => archiveRepairAction({ json: opts.json }));
  archiveCmd
    .command('resolve')
    .description(
      'Explicitly choose hot or archive authority (dry-run by default; backups retained)'
    )
    .requiredOption('--artifact <id>', 'Artifact whose divergent copy should be replaced')
    .addOption(
      new Option('--source <source>', 'Authoritative source')
        .choices(['archive', 'hot'])
        .makeOptionMandatory()
    )
    .option('--apply', 'Perform the replacement (default is dry-run)')
    .option('--json', 'Emit JSON')
    .action(
      (opts: { artifact: string; source: 'archive' | 'hot'; apply?: boolean; json?: boolean }) =>
        archiveResolveAction(opts)
    );
  archiveCmd
    .command('prune')
    .description(
      'Delete archived history (dry-run by default; --apply to delete — the ONLY deletion path)'
    )
    .option('--project <id>', "Delete one project's entire archive dir")
    .option('--artifact <id>', "Delete one artifact's archive dir")
    .option('--apply', 'Actually delete candidates (default is dry-run)')
    .option('--json', 'Emit JSON')
    .action((opts: { project?: string; artifact?: string; apply?: boolean; json?: boolean }) =>
      archivePruneAction(opts)
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
    .command('status')
    .description('Show seed journal progress and imported line coverage')
    .option('--jobs', 'Group imported artifacts by the generation job that produced them')
    .option('--decline <area>', 'Remember a declined progressive-discovery area')
    .option('--offered <area>', 'Record that an area was offered, starting its 7-day cooldown')
    .option('--offer-again <area>', 'Forget a declined or offered area so it can be offered again')
    .option('--json', 'Emit JSON')
    .action(seedStatusAction);

  // ── status / list / show ────────────────────────────────────────────────
  program
    .command('status')
    .description('Show artifact thread status for a branch')
    .option('--branch <name>', 'Branch name (defaults to current)')
    .option('--json', 'Emit JSON for skill consumption')
    .action(statusAction);

  program
    .command('list')
    .description('List captured artifacts')
    .option(
      '--branch <name>',
      'Override the branch-membership filter (defaults to current git branch)'
    )
    .option('--all-branches', 'List artifacts across every branch (ignores --branch)')
    .option('--state <state>', 'Filter by lifecycle state (planned, active, blocked, summarized)')
    .option('--limit <n>', 'Max artifacts to display (bare listing defaults to 50)', strictIntOrNaN)
    .option('--imported', 'List only artifacts synthesized from git history')
    .option(
      '--since <ts>',
      'Only artifacts STARTED at/after this ISO date or datetime (UTC; date-only = start of the UTC day)'
    )
    .option(
      '--until <ts>',
      'Only artifacts STARTED at/before this ISO date or datetime (UTC; date-only = end of the UTC day)'
    )
    .option(
      '--active-since <ts>',
      'Only artifacts ACTIVE at/after this time (UTC): a checkpoint whose open/close interval ' +
        'overlaps the window (a still-open checkpoint counts), a summary, or plan capture inside it'
    )
    .option(
      '--active-until <ts>',
      'Upper bound of the activity window (UTC; date-only = end of the UTC day)'
    )
    // ── file-provenance selector ──
    .option(
      '--touching <path>',
      'Select artifacts whose CLOSED checkpoints list <path> in files_changed ' +
        '(open checkpoints have no files_changed until close; window flags are rejected)'
    )
    // ── ref-range selector (the changelog feed) ──
    .option(
      '--between <ref1>..<ref2>',
      'Select artifacts whose recorded head shas (checkpoint close / summary / pre-pr) fall in ' +
        '`git rev-list ref1..ref2`; artifacts on the ref2 branch lineage with no sha in range are ' +
        'disclosed as unmatched_candidates. Rejects --branch/--all-branches, window flags, --touching'
    )
    // ── cross-project mode ──
    .option(
      '--all-projects',
      'List across every archived project. Current-project hot and retained archive rows are ' +
        'deduplicated freshest-first (ties use hot). Implies all branches; rejects ' +
        '--branch/--touching/--between'
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
    .option('--branch <name>', 'Branch-membership filter (defaults to current git branch)')
    .option('--all-branches', 'Search every branch (ignores --branch)')
    .option('--limit <n>', 'Max artifacts to inspect (default: all)', strictIntOrNaN)
    .option(
      '--artifact <id>',
      'Exact-scope mode: read only this artifact (repeatable; fixes the artifact set — ' +
        'window flags then only filter records)',
      collectArtifactIds,
      []
    )
    .option('--since <ts>', 'Artifacts started + records at/after this time (UTC)')
    .option('--until <ts>', 'Artifacts started + records at/before this time (UTC)')
    .option('--active-since <ts>', 'Activity window lower bound; also filters records (UTC)')
    .option('--active-until <ts>', 'Activity window upper bound; also filters records (UTC)')
    // ── cross-project mode ──
    .option(
      '--all-projects',
      'Collect decisions across every archived project; current-project hot and retained archive ' +
        'rows are deduplicated freshest-first (ties use hot; implies all branches; rejects --branch/--artifact)'
    )
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
    .option('--branch <name>', 'Branch-membership filter (defaults to current git branch)')
    .option('--all-branches', 'Search every branch (ignores --branch)')
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
    // ── cross-project mode ──
    .option(
      '--all-projects',
      'Collect loose ends across every archived project; current-project hot and retained archive ' +
        'rows are deduplicated freshest-first (ties use hot; implies all branches; rejects --branch/--artifact)'
    )
    .option('--json', 'Emit JSON')
    .action(looseEndsAction);

  // ── step ─────────────────────────────────────────────────────────────────
  // Parent is a thin router (same shape as `fingerprint`); the `brief` leaf
  // carries the options. Step ids are globally-unique UUIDv7s, so --artifact
  // is only a disambiguator for pathological multi-hit stores.
  const stepCmd = program
    .command('step')
    .description('Per-plan-step queries over the captured record');
  stepCmd
    .command('brief <step_id>')
    .description(
      'The parallel-dispatch task brief for one plan step: text + acceptance criteria + claim ' +
        'state + related checkpoint evidence + plan guardrails + sibling claim states'
    )
    .option('--artifact <id>', 'Disambiguate when the step_id appears in multiple artifacts')
    .option('--json', 'Emit JSON')
    .action((stepId: string, opts: { artifact?: string; json?: boolean }) =>
      stepBriefAction(stepId, opts)
    );

  program
    .command('stats')
    .description('Repo-wide store aggregates: artifact/checkpoint/summary counts + session tokens')
    // ── cross-project mode ──
    .option(
      '--all-projects',
      'Per-project rollups + totals across every archived project; current-project hot and ' +
        'retained archive rows are deduplicated freshest-first (ties use hot)'
    )
    .option('--json', 'Emit JSON')
    .action(statsAction);

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
    .description('Render a single artifact thread')
    .option('--json', 'Emit JSON')
    .action(showAction);

  // ── usage-ledger read surface ──
  program
    .command('usage')
    .description(
      'Coding-agent usage: exact session/model totals repo-wide, or per-artifact attribution ' +
        '(labelled estimate) + per-checkpoint spans with --artifact'
    )
    .option(
      '--artifact <id>',
      'Artifact scope (single-valued — per-artifact estimates must never be summed)'
    )
    .option('--json', 'Emit JSON')
    .action((opts: { artifact?: string; json?: boolean }) => usageAction(opts));

  // ── search ─────────────────────────────────────────────────────────────
  program
    .command('search <query>')
    .description('FTS5 search over captured content')
    .option('--branch <name>', 'Restrict to one branch')
    // Derived, not restated: this help text listed four of the seven types
    // for as long as the command accepted seven.
    .option('--type <kind>', SEARCH_TYPES.join(' | '))
    .option('--limit <n>', 'Max results (default 25)', strictIntOrNaN)
    .option('--no-imported', 'Exclude artifacts synthesized from git history')
    // ── touched-surface glob filter ──
    .option(
      '--scope <glob>',
      'Only results whose artifact touched a matching path (closed-cp files_changed + declared ' +
        'touched_scope as literal paths); --limit applies after the filter'
    )
    // ── cross-project mode ──
    .option(
      '--all-projects',
      'Search across every archived project. Current-project hot and retained archive hits are ' +
        'deduplicated freshest-first (ties use hot). Implies all branches; rejects --branch'
    )
    .option('--json', 'Emit JSON')
    .action(
      (
        query: string,
        opts: {
          branch?: string;
          type?: string;
          limit?: number;
          scope?: string;
          allProjects?: boolean;
          imported?: boolean;
          json?: boolean;
        }
      ) => searchAction(query, opts)
    );

  // ── resume ─────────────────────────────────────────────────────────────
  program
    .command('resume')
    .description('Show progress + a paste-ready prompt for the latest artifact on a branch')
    .option('--artifact <id>', 'Resume <id> without setting a pin (resume-once)')
    .option('--branch <name>', 'Branch (defaults to current)')
    .option('--copy', 'Copy the suggested prompt block to the system clipboard')
    .option(
      '--accept-default',
      'When the picker is ambiguous, pin + resume the default candidate (most-recently-active)'
    )
    .option(
      '--no-pin',
      'Skip the auto-pin write that --accept-default otherwise performs (CI / headless)'
    )
    .option('--format <fmt>', 'Output format: md (default) or json', 'md')
    .option('--json', 'Shorthand for --format json')
    .action(
      (opts: {
        artifact?: string;
        branch?: string;
        copy?: boolean;
        acceptDefault?: boolean;
        pin?: boolean;
        format?: string;
        json?: boolean;
      }) =>
        resumeAction({
          artifact: opts.artifact,
          branch: opts.branch,
          copy: opts.copy,
          acceptDefault: opts.acceptDefault,
          // commander negates --no-pin into opts.pin === false
          noPin: opts.pin === false,
          format: opts.format === 'json' ? 'json' : 'md',
          json: opts.json,
        })
    );

  // ── why ────────────────────────────────────────────────────────────────
  program
    .command('why <target>')
    .description('Show complete newest-first history for <file>, or attribute <file>:<line>')
    .option('--all', 'Expand whole-file details or list every line candidate')
    .option('--branch <name>', 'Restrict search to checkpoints on this branch')
    .option('--json', 'Emit JSON')
    .action((target: string, opts: { all?: boolean; branch?: string; json?: boolean }) =>
      whyAction(target, opts)
    );

  // ── digest ─────────────────────────────────────────────────────────────
  program
    .command('digest [artifact_id]')
    .description('Render a reviewer-facing PR summary for an artifact or branch')
    .option('--artifact <id>', 'Artifact id (defaults to latest on branch)')
    .option('--branch <name>', 'Branch (defaults to current)')
    .option('--branch-wide', 'Combine every captured artifact in the branch PR range')
    .option('--base <ref>', 'Base ref for --branch-wide (defaults to the repository default)')
    .option('--primary-artifact <id>', 'Title source override for --branch-wide')
    .option('--out <file>', 'Write the rendered digest to this file and print a confirmation')
    .option('--format <fmt>', 'Output format: md (default) or json', 'md')
    .option('--json', 'Shorthand for --format json')
    .action(
      (
        artifactId: string | undefined,
        opts: {
          artifact?: string;
          branch?: string;
          out?: string;
          format?: string;
          json?: boolean;
          branchWide?: boolean;
          base?: string;
          primaryArtifact?: string;
        }
      ) =>
        digestAction({
          artifact: opts.artifact,
          artifactArg: artifactId,
          branch: opts.branch,
          out: opts.out,
          format: opts.format === 'json' ? 'json' : 'md',
          json: opts.json,
          branchWide: opts.branchWide,
          base: opts.base,
          primaryArtifact: opts.primaryArtifact,
        })
    );

  addCaptureInputOptions(
    program.command('finish').description('Run pre-PR checks and finalize a clean artifact')
  )
    .option('--no-llm', 'Skip LLM evaluators without executing a provider')
    .action((opts: { input?: string; noLlm?: boolean }) =>
      finishAction({ input: opts.input, noLlm: opts.noLlm })
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
  ).action((opts: { input?: string }) => captureSummaryAction({ input: opts.input }));

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
    .action((args: string[], _opts: unknown, command: Command) => {
      const root = (command.optsWithGlobals() as { root?: string }).root;
      return watchAction(args, root);
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
    .action((args: string[], _opts: unknown, command: Command) => {
      const root = (command.optsWithGlobals() as { root?: string }).root;
      return reviewAction(args, root);
    });

  // ── plan (cloud source-plan review track) ────────────────────────────────
  // Distinct from `capture plan` (the artifact's own plan): this group manages
  // the cloud SourcePlan review surface — upload a plan for review, pull the
  // approved version into the local pull-cache for `--source-plan cloud:…`.
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
    .description('Pull the approved version of a cloud plan into the local pull-cache')
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
      'Review track: view/list/status the review state; pull, propose, push (author), or comment'
    );
  reviewGroup
    .command('pull <ref>')
    .description('Pull the under-review candidate (or --proposal <id>) into the local review cache')
    .option('--proposal <id>', 'Pull this proposal instead of the candidate')
    .addOption(
      new Option(
        '--version <n>',
        'Pull a sealed historical version (read-only — never cached, NOT a push base)'
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
      'Base candidate version id (headless/CI; skips the local cache)'
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
      'Expected candidate version id (headless/CI; skips the local cache)'
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
    .option('--json', 'Emit JSON')
    .action((commentId: string, opts: { message: string; passToken?: string; json?: boolean }) =>
      reviewFeedbackReplyAction(commentId, { ...opts, baseUrl: cloudBaseUrl })
    );
  reviewFeedbackGroup
    .command('resolve <commentId>', hideCloud)
    .description("Resolve a thread (the reviewer's verb — agents reply, humans resolve)")
    .option('--json', 'Emit JSON')
    .action((commentId: string, opts: { json?: boolean }) =>
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
