/**
 * What holds a job back, and what can ever free it. Every refusal a dispatch
 * decision returns falls in exactly one of the three classes below, and the
 * class decides whether the worker ever looks at that job again on its own.
 *
 * **Origin-bound** — `configuration_paused` and every consent denial. They say
 * nothing about the job: they say the checkout it came from was disabled, gone
 * or unconsented when it was last looked at. Re-enabling that worktree or
 * recording a grant makes the job processable with nothing about the job having
 * changed, so the worker frees them all once at the start of a run and lets the
 * ordinary dispatch decision judge them again. A still-disabled origin costs
 * one dispatch decision per run and no provider.
 *
 * **Permanent** — facts about the job itself: it names a contract this build
 * does not run, a source kind it does not interpret, a source that is not
 * there, a source a person restricted, or it retains nothing dispatch can use.
 * No amount of waiting changes any of them, so only
 * `orcaops knowledge retry` frees one, deliberately, by a person who has done
 * something about it. A reason in neither list is treated as permanent: a wait
 * this build does not recognize is never cleared on a guess.
 *
 * `size_limit` is permanent in the same sense and is here for a further reason:
 * its remedy is raising `knowledge_processing.max_input_bytes` or
 * `max_attempts`, and a job SETTLED on it could take that remedy only through a
 * person's reopening. Parked, it costs no attempt and the same retry frees it
 * once the cap is raised.
 *
 * **Already held** — the project pause and an unlifted no-model choice. Both
 * are held by a mechanism of their own that claiming already honours, and the
 * pause or the resume is what lifts it. Recording a wait reason as well would
 * outlive that lift and hold the job after the thing that held it was gone, so
 * these park the job with no wait reason at all.
 */

/** Freed once per worker run, because something outside the job can resolve them. */
export const ORIGIN_BOUND_WAIT_REASONS: readonly string[] = [
  'configuration_paused',
  // Every reason `evaluateProcessingConsent` denies with. Consent is recorded
  // outside the repository and can appear between one run and the next.
  'store_unreadable_or_unsafe',
  'no_grant',
  'revoked',
  'other_project',
  'other_provider',
  'other_processor_contract',
  'other_tool_access',
  'limits_wider_than_disclosed',
  'backlog_not_included',
  // A store condition met while reading related knowledge for the manifest —
  // an unreadable record, a projection that could not be read — not a fact
  // about the job, which is intact and unchanged.
  'retrieval_failed',
];

/** Never freed by the worker; only an operator's retry moves one. */
export const PERMANENT_WAIT_REASONS: readonly string[] = [
  'unsupported_processor_contract',
  'source_kind_unsupported',
  'dispatch_context_missing',
  'admission_unreadable',
  'source_unavailable',
  'source_not_eligible',
  'source_access_changed',
  'size_limit',
  'source_schedule_limit',
  'retained_schedule_incompatible',
  'schedule_integrity_failure',
];

/** Parked with no wait reason: something else already holds the job. */
export const ALREADY_HELD_WAIT_REASONS: readonly string[] = [
  'project_paused',
  'awaiting_model_resume',
];

/** What a refusal is recorded as on the job, or null when something else holds it. */
export function parkedWaitReason(refusal: string): string | null {
  return ALREADY_HELD_WAIT_REASONS.includes(refusal) ? null : refusal;
}

/**
 * The name the worker's own pause is recorded under. `doctor` and `status` read
 * it to say the worker paused processing rather than sending someone looking
 * for a person who did.
 */
export const WORKER_PAUSE_ACTOR = 'orcaops knowledge worker';
