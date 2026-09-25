import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import type { ProcessingProvider } from '../../lib/knowledge-processing-consent.js';
import { revokeProcessingGrants } from '../../lib/knowledge-processing-grants.js';
import { readProjectId } from '../../lib/project-identity.js';
import { resolveRepositoryContext } from '../../lib/repository-context.js';

export interface KnowledgeRevokeOptions {
  /** Withdraw only the grants naming this provider. */
  provider?: ProcessingProvider;
  json?: boolean;
}

/**
 * `orcaops knowledge revoke` — withdraw this project's consent.
 *
 * No terminal and no confirmation: withdrawing consent must never be harder
 * than giving it. Configuration is left exactly as it is, because a revoked
 * grant already stops every call on its own.
 */
export async function knowledgeRevokeAction(opts: KnowledgeRevokeOptions = {}): Promise<void> {
  try {
    const repository = await resolveRepositoryContext();
    const projectId = await readProjectId(repository.repo);
    const revoked =
      projectId === null
        ? { revoked_grant_ids: [] }
        : await revokeProcessingGrants(
            {
              project_id: projectId,
              ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
            },
            { repoRoot: repository.repoRoot }
          );

    const result = {
      revoked_grant_ids: revoked.revoked_grant_ids,
      project_id: projectId,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      configuration_changed: false,
    };
    if (opts.json === true) {
      emitOk(result);
      return;
    }
    const target = opts.provider === undefined ? 'this project' : `${opts.provider}`;
    writeTerminalSafeStdout(
      (revoked.revoked_grant_ids.length === 0
        ? `No consent grant was in force for ${target}.\n`
        : `Revoked ${revoked.revoked_grant_ids.length} consent grant(s) for ${target}; the ` +
          'withdrawn grants stay on record.\n') +
        'Configuration was not changed. Run `orcaops knowledge disable` to turn the setting ' +
        'off as well.\n'
    );
  } catch (err) {
    if (opts.json === true) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
