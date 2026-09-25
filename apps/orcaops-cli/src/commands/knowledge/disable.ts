import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import {
  displayConfigPath,
  openEffectiveConfig,
  writeKnowledgeProcessingSection,
} from '../../lib/config-file.js';
import { resolveRepositoryContext } from '../../lib/repository-context.js';

export interface KnowledgeDisableOptions {
  json?: boolean;
}

/**
 * `orcaops knowledge disable` — turn the setting off in the configuration that
 * governs this checkout. Consent is a separate act in a separate file, so this
 * never touches the grant store; the output says so, because someone turning
 * the feature off usually means to withdraw both.
 */
export async function knowledgeDisableAction(opts: KnowledgeDisableOptions = {}): Promise<void> {
  try {
    const repository = await resolveRepositoryContext();
    const document = await openEffectiveConfig(repository.repoRoot);
    const plan = await writeKnowledgeProcessingSection(document, { enabled: false });
    const displayPath = displayConfigPath(document.location, repository.repoRoot);

    const result = {
      enabled: false,
      configuration_path: displayPath,
      configuration_changed: plan.changed,
      consent_revoked: false,
    };
    if (opts.json === true) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(
      (plan.changed
        ? `knowledge_processing.enabled is now false in ${displayPath}.\n`
        : `knowledge_processing.enabled was already false in ${displayPath}.\n`) +
        'Your consent grant is untouched and stays on record. Run ' +
        '`orcaops knowledge revoke` to withdraw it.\n'
    );
  } catch (err) {
    if (opts.json === true) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
