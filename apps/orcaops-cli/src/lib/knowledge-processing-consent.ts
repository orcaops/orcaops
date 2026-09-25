import { z } from 'zod';

import type { LlmProvider, ToolAccess } from '@orcaops/llm';

/**
 * Consent to send prepared captured content to a model provider for background
 * knowledge processing. This module is the grant contract and the decision
 * over it: no filesystem, no configuration, no prompts. The capability is
 * deliberately absent from the evaluator `TrustCapability` vocabulary, and no
 * evaluator grant of any capability covers it.
 */

export const PROCESSING_CONSENT_CAPABILITY = 'capture_content_llm_processing';

/**
 * Closed on purpose: a provider the llm package adds later is not consentable
 * until it is added here, and one it drops stops compiling here.
 */
const ProcessingProviderSchema = z.enum(['claude', 'codex'] satisfies LlmProvider[]);
export type ProcessingProvider = z.infer<typeof ProcessingProviderSchema>;

const SpendCapSchema = z.union([z.number().nonnegative(), z.literal('none')]);

/**
 * A provider may hold a per-call amount as a ceiling, or only stop a call once
 * the amount has been exceeded. The person is shown which, so a best-effort
 * amount is never recorded as if it were a cap.
 */
const PerCallSpendCapSchema = z.union([
  z.literal('none'),
  z.object({ usd: z.number().nonnegative(), holds: z.enum(['ceiling', 'best_effort']) }).strict(),
]);
export type PerCallSpendCap = z.infer<typeof PerCallSpendCapSchema>;

const SourceScopeSchema = z
  .object({
    /** Project admission sequence at the moment of granting. */
    admitted_after_sequence: z.number().int().nonnegative(),
    backlog: z.enum(['excluded', 'included']),
  })
  .strict();
export type ProcessingSourceScope = z.infer<typeof SourceScopeSchema>;

const DisclosedModelSchema = z.discriminatedUnion('selection', [
  z.object({ selection: z.literal('explicit'), id: z.string().min(1) }).strict(),
  z.object({ selection: z.literal('provider_default') }).strict(),
]);

const LimitsSchema = z
  .object({
    max_cost_usd_per_call: PerCallSpendCapSchema,
    max_cost_usd_per_day: SpendCapSchema,
    max_calls_per_hour: z.number().int().positive(),
    max_input_bytes: z.number().int().positive(),
    max_output_bytes: z.number().int().positive(),
  })
  .strict();
export type ProcessingLimits = z.infer<typeof LimitsSchema>;

const DisclosedTermsSchema = z
  .object({
    tool_access: z.enum(['none', 'codex_restricted'] satisfies ToolAccess[]).default('none'),
    model: DisclosedModelSchema,
    limits: LimitsSchema,
    paused_backlog_count: z.number().int().nonnegative(),
  })
  .strict();

/**
 * What the person was shown when granting. The limits bound what may be in
 * force when a job is sent; the model and the backlog count are a record only.
 */
const DisclosureSchema = z
  .object({ provider: ProcessingProviderSchema, ...DisclosedTermsSchema.shape })
  .strict();
export type ProcessingDisclosure = z.infer<typeof DisclosureSchema>;

/** Everything a person is shown and accepts; a grant is these terms plus an id and times. */
export const ProcessingGrantTermsSchema = z
  .object({
    project_id: z.string().min(1),
    provider: ProcessingProviderSchema,
    processor_contract: z.string().min(1),
    source_scope: SourceScopeSchema,
    disclosed: DisclosedTermsSchema,
  })
  .strict();

export const ProcessingGrantSchema = z
  .object({
    grant_id: z.uuid(),
    capability: z.literal(PROCESSING_CONSENT_CAPABILITY),
    project_id: z.string().min(1),
    provider: ProcessingProviderSchema,
    processor_contract: z.string().min(1),
    source_scope: SourceScopeSchema,
    disclosed: DisclosureSchema,
    granted_at: z.iso.datetime(),
    revoked_at: z.iso.datetime().optional(),
  })
  .strict()
  .refine((grant) => grant.disclosed.provider === grant.provider, {
    path: ['disclosed', 'provider'],
    message: 'must name the provider the grant is bound to',
  });
export type ProcessingGrant = z.infer<typeof ProcessingGrantSchema>;

export const ProcessingGrantsFileSchema = z
  .object({
    v: z.literal(1),
    grants: z
      .array(ProcessingGrantSchema)
      .refine((grants) => new Set(grants.map((grant) => grant.grant_id)).size === grants.length, {
        message: 'grant_id must be unique',
      }),
  })
  .strict();
export type ProcessingGrantsFile = z.infer<typeof ProcessingGrantsFileSchema>;

export type ProcessingGrantStoreProblemCode =
  | 'repository_root_invalid'
  | 'store_not_outside_repository'
  | 'store_unsafe'
  | 'store_permissions_widened'
  | 'store_writable_by_others'
  | 'grant_file_unparseable'
  | 'grant_file_invalid';

export interface ProcessingGrantStoreProblem {
  code: ProcessingGrantStoreProblemCode;
  message: string;
}

export type ProcessingConsentDenialReason =
  | 'store_unreadable_or_unsafe'
  | 'no_grant'
  | 'revoked'
  | 'other_project'
  | 'other_provider'
  | 'other_processor_contract'
  | 'other_tool_access'
  | 'limits_wider_than_disclosed'
  | 'backlog_not_included';

export type ProcessingConsentDecision =
  | { ok: true; grant_id: string }
  | {
      ok: false;
      code: 'CONSENT_DENIED';
      reason: ProcessingConsentDenialReason;
      message: string;
    };

export interface ProcessingConsentRequest {
  /** Entries that are not valid processing grants never cover anything. */
  grants: readonly unknown[];
  /** The problems of the read that produced `grants`; any problem denies. */
  problems: readonly ProcessingGrantStoreProblem[];
  project_id: string;
  provider: ProcessingProvider;
  processor_contract: string;
  /** The provider execution policy the job would use right now. */
  effective_tool_access: ToolAccess;
  /** The limits the job would run under, as resolved from configuration right now. */
  effective_limits: ProcessingLimits;
  job: { admitted_sequence: number };
}

export interface ExactProcessingConsentRequest extends ProcessingConsentRequest {
  grant_id: string;
}

interface ProcessingGrantBinding {
  project_id: string;
  provider: string;
  processor_contract: string;
  tool_access: ToolAccess;
}

function sameBinding(grant: ProcessingGrant, binding: ProcessingGrantBinding): boolean {
  return (
    grant.project_id === binding.project_id &&
    grant.provider === binding.provider &&
    grant.processor_contract === binding.processor_contract &&
    grant.disclosed.tool_access === binding.tool_access
  );
}

function validGrants(entries: readonly unknown[]): ProcessingGrant[] {
  return entries.flatMap((entry) => {
    const parsed = ProcessingGrantSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function repeatedGrantIds(grants: readonly ProcessingGrant[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { grant_id } of grants) (seen.has(grant_id) ? repeated : seen).add(grant_id);
  return [...repeated];
}

function isLooser(effective: number | 'none', disclosed: number | 'none'): boolean {
  if (disclosed === 'none') return false;
  return effective === 'none' || effective > disclosed;
}

function isLooserPerCallCap(effective: PerCallSpendCap, disclosed: PerCallSpendCap): boolean {
  if (disclosed === 'none') return false;
  if (effective === 'none' || effective.usd > disclosed.usd) return true;
  return disclosed.holds === 'ceiling' && effective.holds === 'best_effort';
}

/** One entry per limit, so a limit added to the schema cannot go uncompared. */
const IS_LOOSER: {
  [Name in keyof ProcessingLimits]: (
    effective: ProcessingLimits[Name],
    disclosed: ProcessingLimits[Name]
  ) => boolean;
} = {
  max_cost_usd_per_call: isLooserPerCallCap,
  max_cost_usd_per_day: isLooser,
  max_calls_per_hour: isLooser,
  max_input_bytes: isLooser,
  max_output_bytes: isLooser,
};
const LIMIT_NAMES = Object.keys(IS_LOOSER) as (keyof ProcessingLimits)[];

function describeLimit(value: ProcessingLimits[keyof ProcessingLimits]): string {
  if (typeof value !== 'object') return String(value);
  return `${value.usd} (${value.holds === 'ceiling' ? 'a ceiling' : 'best effort'})`;
}

/**
 * Null when the limits in force are no looser than the person was shown.
 * Tighter limits need no new consent; looser ones were never agreed to.
 */
function limitsWiderThanDisclosed(effective: unknown, disclosed: ProcessingLimits): string | null {
  const parsed = LimitsSchema.safeParse(effective);
  if (!parsed.success) {
    return (
      `The limits in force are not valid, so they cannot be shown to stay within what the ` +
      `person was shown when granting.`
    );
  }
  const limits = parsed.data;
  const looser = <Name extends keyof ProcessingLimits>(name: Name) =>
    IS_LOOSER[name](limits[name], disclosed[name]);
  const loosened = LIMIT_NAMES.filter(looser);
  if (loosened.length === 0) return null;
  return (
    `The limits in force are looser than the person was shown when granting: ` +
    loosened
      .map(
        (name) =>
          `${name} is ${describeLimit(limits[name])} but ${describeLimit(disclosed[name])} ` +
          `was disclosed`
      )
      .join('; ') +
    `. Looser limits need a new grant.`
  );
}

/**
 * The store appends, so the last entry for a binding is the newest grant, and
 * it alone speaks for that binding. An earlier entry left unrevoked, which
 * only a hand edit can produce, must not keep a wider scope alive.
 */
function governingGrant(
  grants: readonly ProcessingGrant[],
  binding: ProcessingGrantBinding
): ProcessingGrant | undefined {
  return grants.filter((grant) => sameBinding(grant, binding)).at(-1);
}

function evaluateGrantCoverage(
  grant: ProcessingGrant,
  request: ProcessingConsentRequest
): ProcessingConsentDecision {
  if (grant.revoked_at !== undefined) {
    return denied(
      'revoked',
      `Consent for ${request.provider} to process captured content from this project was revoked ` +
        `at ${grant.revoked_at}.`
    );
  }
  if (
    !sameBinding(grant, {
      project_id: request.project_id,
      provider: request.provider,
      processor_contract: request.processor_contract,
      tool_access: request.effective_tool_access,
    })
  )
    return denied(
      'no_grant',
      'The named grant does not authorize this project, provider, processor contract and tool policy.'
    );
  const widerLimits = limitsWiderThanDisclosed(request.effective_limits, grant.disclosed.limits);
  if (widerLimits !== null) return denied('limits_wider_than_disclosed', widerLimits);
  const isNewCapture =
    Number.isSafeInteger(request.job.admitted_sequence) &&
    request.job.admitted_sequence > grant.source_scope.admitted_after_sequence;
  if (isNewCapture || grant.source_scope.backlog === 'included') {
    return { ok: true, grant_id: grant.grant_id };
  }
  return denied(
    'backlog_not_included',
    `This job was admitted at or before the grant began ` +
      `(sequence ${grant.source_scope.admitted_after_sequence}), and the grant covers new ` +
      `captures only; earlier jobs need a grant that explicitly includes the backlog.`
  );
}

function validatedGrants(
  request: ProcessingConsentRequest
): { ok: true; grants: ProcessingGrant[] } | Extract<ProcessingConsentDecision, { ok: false }> {
  if (request.problems.length > 0)
    return denied(
      'store_unreadable_or_unsafe',
      `The user-local processing grant store cannot be relied on: ` +
        request.problems.map((problem) => problem.message).join(' ')
    );
  const grants = validGrants(request.grants);
  const repeated = repeatedGrantIds(grants);
  if (repeated.length > 0)
    return denied(
      'store_unreadable_or_unsafe',
      `The grants repeat the id ${repeated.join(', ')}, so which entry stands cannot be told.`
    );
  return { ok: true, grants };
}

export function evaluateProcessingConsentByGrantId(
  request: ExactProcessingConsentRequest
): ProcessingConsentDecision {
  const valid = validatedGrants(request);
  if (!valid.ok) return valid;
  const grant = valid.grants.find((entry) => entry.grant_id === request.grant_id);
  if (grant === undefined)
    return denied(
      'no_grant',
      `The exact grant ${request.grant_id} retained for this attempt is not present.`
    );
  if (
    governingGrant(valid.grants, {
      project_id: grant.project_id,
      provider: grant.provider,
      processor_contract: grant.processor_contract,
      tool_access: grant.disclosed.tool_access,
    }) !== grant
  )
    return denied(
      'revoked',
      `The exact grant ${request.grant_id} retained for this attempt was superseded by a later grant.`
    );
  return evaluateGrantCoverage(grant, request);
}

/**
 * Decides whether one admitted job may be sent to the provider. Pure and
 * cheap, so the worker can call it again at dispatch and at settlement. A
 * denial is a returned value, never a throw and never a prompt.
 */
export function evaluateProcessingConsent(
  request: ProcessingConsentRequest
): ProcessingConsentDecision {
  const { project_id, provider, processor_contract, effective_tool_access } = request;
  const valid = validatedGrants(request);
  if (!valid.ok) return valid;
  const grants = valid.grants;
  const governing = governingGrant(grants, {
    project_id,
    provider,
    processor_contract,
    tool_access: effective_tool_access,
  });
  if (governing !== undefined) {
    return evaluateGrantCoverage(governing, request);
  }

  const inForce = grants.filter((grant) => grant.revoked_at === undefined);
  const forProject = inForce.filter((grant) => grant.project_id === project_id);
  const forProvider = forProject.filter((grant) => grant.provider === provider);
  const forContract = forProvider.filter(
    (grant) => grant.processor_contract === processor_contract
  );
  if (forContract.length > 0) {
    return denied(
      'other_tool_access',
      `Consent for ${provider} on this project covers ${[
        ...new Set(forContract.map((grant) => grant.disclosed.tool_access)),
      ].join(
        ' and '
      )}, not ${effective_tool_access}; a changed tool-access policy needs a new grant.`
    );
  }
  if (forProvider.length > 0) {
    return denied(
      'other_processor_contract',
      `Consent for ${provider} on this project covers a different processor contract, not ` +
        `${JSON.stringify(processor_contract)}; a changed contract needs a new grant.`
    );
  }
  if (forProject.length > 0) {
    return denied(
      'other_provider',
      `Consent on this project names ` +
        `${[...new Set(forProject.map((grant) => grant.provider))].join(' and ')}, not ${provider}; ` +
        `a different provider needs its own grant.`
    );
  }
  if (inForce.length > 0) {
    return denied(
      'other_project',
      `The user-local grants cover other projects, not this one; consent does not carry between ` +
        `projects.`
    );
  }
  return denied(
    'no_grant',
    `No user-local grant authorizes sending captured content from this project to ${provider} ` +
      `for background processing.`
  );
}

function denied(
  reason: ProcessingConsentDenialReason,
  message: string
): Extract<ProcessingConsentDecision, { ok: false }> {
  return { ok: false, code: 'CONSENT_DENIED', reason, message };
}

export interface ProcessingGrantStatus {
  grant: ProcessingGrant;
  /** True only for the unrevoked grant that governs its binding in the decision. */
  in_force: boolean;
}

export function describeProcessingGrants(
  entries: readonly unknown[],
  filter: { project_id?: string } = {}
): ProcessingGrantStatus[] {
  const grants = validGrants(entries);
  const unambiguous = repeatedGrantIds(grants).length === 0;
  return grants
    .filter((grant) => filter.project_id === undefined || grant.project_id === filter.project_id)
    .map((grant) => ({
      grant,
      in_force:
        unambiguous &&
        grant.revoked_at === undefined &&
        governingGrant(grants, {
          project_id: grant.project_id,
          provider: grant.provider,
          processor_contract: grant.processor_contract,
          tool_access: grant.disclosed.tool_access,
        }) === grant,
    }));
}
