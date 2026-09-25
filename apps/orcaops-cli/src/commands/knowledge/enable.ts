import { resolveProcessingFor } from './context.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import {
  displayConfigPath,
  type KnowledgeProcessingWritePlan,
  openEffectiveConfig,
  planKnowledgeProcessingWrite,
  writeConfigDocument,
} from '../../lib/config-file.js';
import { recordProcessingGrant } from '../../lib/knowledge-processing-grants.js';
import {
  type ProcessingHistory,
  type ProcessingHistoryRequest,
  readProcessingHistory,
} from '../../lib/knowledge-processing-queue.js';
import { type ConsentTerminal, consentTerminal } from '../../lib/knowledge-processing-terminal.js';
import { draftProcessingDisclosure } from '../../lib/knowledge-processing-terms.js';
import {
  describeWakeUp,
  wakeProcessingWorkerForQueue,
} from '../../lib/knowledge-processing-wakeup.js';
import { ensureProjectId } from '../../lib/project-identity.js';
import { resolveRepositoryContext } from '../../lib/repository-context.js';

export interface KnowledgeEnableOptions {
  /** Cover captures admitted before the grant as well as new ones. */
  includeBacklog?: boolean;
  json?: boolean;
  /** The person answering. Tests replace it; no flag or variable can. */
  terminal?: ConsentTerminal;
  /** The project-database reading. Tests replace it; no flag can. */
  history?: (request: ProcessingHistoryRequest) => Promise<ProcessingHistory>;
}

const CONSENT_ANSWER = 'yes';

/**
 * `orcaops knowledge enable` — show what would be sent, record consent for
 * exactly that, then turn the setting on.
 *
 * The order is the safeguard: the grant is written first, so an interruption
 * between the two leaves consent recorded with processing still off, never
 * processing on with nothing authorizing it. The two are deliberately not
 * written as one atomic pair, because rolling the grant back would revoke
 * consent the person gave without saying so.
 */
export async function knowledgeEnableAction(opts: KnowledgeEnableOptions = {}): Promise<void> {
  try {
    const terminal = opts.terminal ?? consentTerminal;
    const repository = await resolveRepositoryContext();
    // Before anything is minted, shown or asked: terms are a disclosure, and a
    // pipe cannot read them or accept them.
    if (!terminal.isInteractive()) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Consent to background knowledge processing can only be given at an interactive ' +
          'terminal. Run `orcaops knowledge enable` yourself in a terminal; no flag, ' +
          'environment variable or non-interactive option grants it.'
      );
    }

    const document = await openEffectiveConfig(repository.repoRoot);
    const plan = planKnowledgeProcessingWrite(document, { enabled: true });
    const resolution = await resolveProcessingFor(plan.config, {
      kind: repository.source.kind,
      path: repository.source.configPath,
    });
    if (resolution.status !== 'ready') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Knowledge processing would still be paused with these settings, so enabling it would ' +
          'promise work that never runs:\n' +
          resolution.reasons.map((reason) => `  - ${reason.message}`).join('\n') +
          '\nNothing was recorded and nothing was changed.'
      );
    }

    const { projectId } = await ensureProjectId(repository.repo);
    const history = await (opts.history ?? readProcessingHistory)({});
    // A grant is bounded by what is really admitted. A database that cannot be
    // read cannot name that boundary, and a grant written anyway would cover
    // every job it could not see.
    if (history.problem !== null && history.problem.code !== 'no_history') {
      throw new OrcaopsError(
        ErrorCodes.RECOVERY_REQUIRED,
        'The project database cannot say what is already admitted, so consent cannot be bounded ' +
          `to captures from now on: ${history.problem.message}\nNothing was recorded and nothing ` +
          'was changed.'
      );
    }
    const backlog = history.backlog;
    const { terms, text } = draftProcessingDisclosure({
      project_id: projectId,
      configuration: resolution.configuration,
      backlog,
      include_backlog: opts.includeBacklog === true,
    });

    const displayPath = displayConfigPath(plan.document.location, repository.repoRoot);
    writeTerminalSafeStderr(`${text}${versionWarning(plan, displayPath)}\n`);
    const answer = await terminal.ask(
      `Type "${CONSENT_ANSWER}" to consent, anything else declines: `
    );
    if (answer.trim().toLowerCase() !== CONSENT_ANSWER) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Declined: no consent was recorded and knowledge processing was left off.'
      );
    }

    const { grant } = await recordProcessingGrant(terms, {
      repoRoot: repository.repoRoot,
      interactiveConfirmation: terminal.confirm(terms),
    });
    try {
      if (plan.changed) await writeConfigDocument(plan.document);
    } catch (error) {
      throw new OrcaopsError(
        ErrorCodes.RECOVERY_REQUIRED,
        `Consent was recorded (grant ${grant.grant_id}), but ${displayPath} could not be ` +
          `written, so knowledge processing is still off: ${(error as Error).message}. Fix the ` +
          'file and run `orcaops knowledge enable` again to finish, or run ' +
          '`orcaops knowledge revoke` to withdraw the consent just recorded.'
      );
    }

    // Consent and the setting are both in force by now, so whatever was already
    // admitted can run. The wake-up never throws, so nothing here can undo an
    // enablement that succeeded.
    const woken = history.target === null ? null : wakeProcessingWorkerForQueue(history.target);
    const result = {
      enabled: true,
      configuration_path: displayPath,
      configuration_changed: plan.changed,
      grant_id: grant.grant_id,
      provider: terms.provider,
      source_scope: terms.source_scope,
      wake_up: woken,
    };
    if (opts.json === true) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(
      `Consent recorded (grant ${grant.grant_id}) for ${terms.provider}.\n` +
        (plan.changed
          ? `knowledge_processing.enabled is now true in ${displayPath}.\n`
          : `knowledge_processing.enabled was already true in ${displayPath}.\n`) +
        'A background worker now runs after each capture; it never delays one.\n' +
        `${describeWakeUp(woken)}\n` +
        'Run `orcaops knowledge revoke` to withdraw consent, or ' +
        '`orcaops knowledge disable` to turn the setting off.\n'
    );
  } catch (err) {
    if (opts.json === true) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/**
 * The stamp moves in the same write that first adds the section, and under
 * project scope that file is committed — so every teammate on an older build
 * stops loading configuration until they upgrade. Said before the question,
 * never after the write.
 */
function versionWarning(plan: KnowledgeProcessingWritePlan, displayPath: string): string {
  if (plan.versionChange === null) return '';
  const consequence =
    plan.document.location.origin === 'worktree'
      ? `${displayPath} is committed, so every teammate on an older orcaops must upgrade ` +
        'before it loads for them. `orcaops update --scope personal` keeps the setting out ' +
        'of the repository instead.'
      : `${displayPath} is outside the repository, so no teammate is affected.`;
  return (
    `\nThis write moves the configuration schema from ${plan.versionChange.from} to ` +
    `${plan.versionChange.to}. ${consequence}\n`
  );
}
