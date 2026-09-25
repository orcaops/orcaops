import { run } from 'effection';

import {
  type EffectiveProcessingConfiguration,
  type KnowledgeProcessingResolution,
  PROCESSING_PROCESSOR_CONTRACT,
  type ProcessingConfigSource,
  resolveKnowledgeProcessing,
} from '@orcaops/core';
import {
  measurePreparedInputRequest,
  probeProviderAvailability,
  PROVIDER_CAPABILITIES,
  type ProviderProbeSnapshot,
  resolveNoToolCall,
  selectDefaultProvider,
} from '@orcaops/llm';
import type { Config } from '@orcaops/storage';

import { getInvocationCwd, getInvocationEnv } from '../../lib/invocation-context.js';
import {
  evaluateProcessingConsent,
  type ProcessingConsentDecision,
  type ProcessingGrantStoreProblem,
} from '../../lib/knowledge-processing-consent.js';
import { readProcessingGrants } from '../../lib/knowledge-processing-grants.js';
import type { ProcessingBacklog } from '../../lib/knowledge-processing-queue.js';
import { readProjectId } from '../../lib/project-identity.js';
import { type RepositoryContext, resolveRepositoryContext } from '../../lib/repository-context.js';

/**
 * The state every `orcaops knowledge` verb reads: the configuration that
 * governs THIS checkout, what the workload would run under, and the project
 * identity a grant binds to. Nothing here starts a worker, opens the project
 * database or writes anything.
 */
export interface ProcessingSurface {
  repository: RepositoryContext;
  /** `knowledge_processing.enabled` as the governing file actually carries it. */
  enabled: boolean;
  /** The file the settings came from, and the file an enable or disable edits. */
  source: ProcessingConfigSource;
  /**
   * The resolution with enablement ASSUMED. `enabled: false` would otherwise be
   * the single pause reason and hide every other one, and both `status` and
   * `enable` have to report the reasons that would survive turning it on.
   */
  resolution: KnowledgeProcessingResolution;
  projectId: string | null;
}

async function probe(config: Config): Promise<ProviderProbeSnapshot> {
  // A configured `llm.tool: none` turns off every model call, so probing for
  // providers would spawn subprocesses whose answer cannot change anything.
  if (config.llm.tool === 'none') {
    return { claude: 'absent', codex: 'absent' } satisfies ProviderProbeSnapshot;
  }
  return run(() =>
    probeProviderAvailability({
      env: getInvocationEnv(),
      cwd: getInvocationCwd(),
      execution: 'prepared-input',
    })
  );
}

/** Resolve `config` as knowledge processing would run it, enablement assumed. */
export async function resolveProcessingFor(
  config: Config,
  source: ProcessingConfigSource
): Promise<KnowledgeProcessingResolution> {
  return resolveKnowledgeProcessing({
    config: { ...config, knowledge_processing: { ...config.knowledge_processing, enabled: true } },
    source,
    providerAvailability: await probe(config),
    llm: {
      capabilities: PROVIDER_CAPABILITIES,
      selectDefaultProvider,
      resolveNoToolCall,
      measurePreparedInputRequest,
    },
  });
}

export async function readProcessingSurface(): Promise<ProcessingSurface> {
  const repository = await resolveRepositoryContext();
  const source = { kind: repository.source.kind, path: repository.source.configPath };
  return {
    repository,
    enabled: repository.config.knowledge_processing.enabled,
    source,
    resolution: await resolveProcessingFor(repository.config, source),
    projectId: await readProjectId(repository.repo),
  };
}

export interface ProcessingConsentReport {
  decision: ProcessingConsentDecision;
  /** Non-empty exactly when the grant store could not be relied on. */
  problems: ProcessingGrantStoreProblem[];
}

/**
 * Whether consent covers a capture admitted right now — the question `status`
 * answers, asked through the same decision the worker will make. The probe
 * sequence is one past the newest admitted job, so a grant that legitimately
 * excludes the backlog reads as covering; what it leaves out is reported
 * separately as the waiting count.
 */
export function reportProcessingConsent(input: {
  repoRoot: string;
  projectId: string | null;
  configuration: EffectiveProcessingConfiguration;
  backlog: ProcessingBacklog;
}): ProcessingConsentReport {
  const { grants, problems } = readProcessingGrants({ repoRoot: input.repoRoot });
  if (input.projectId === null) {
    return {
      decision: {
        ok: false,
        code: 'CONSENT_DENIED',
        reason: 'no_grant',
        message:
          'This repository has no orcaops project identity yet, so no user-local grant can name ' +
          'it. `orcaops knowledge enable` mints one.',
      },
      problems,
    };
  }
  return {
    decision: evaluateProcessingConsent({
      grants,
      problems,
      project_id: input.projectId,
      provider: input.configuration.provider.id,
      processor_contract: PROCESSING_PROCESSOR_CONTRACT,
      effective_tool_access: input.configuration.toolAccess,
      effective_limits: input.configuration.limits,
      job: { admitted_sequence: (input.backlog.latest_admitted_sequence ?? 0) + 1 },
    }),
    problems,
  };
}
