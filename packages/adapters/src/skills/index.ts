import type { SkillBodyOptions, SkillGroup, SkillTemplate } from '../types.js';
import { CLOUD_SYNC_STEERING } from './cloud-sync-steering.js';
import { orcaopsAdversarialReviewSkill } from './orcaops-adversarial-review.js';
import { orcaopsAuthorEvaluatorSkill } from './orcaops-author-evaluator.js';
import { orcaopsBlameSkill } from './orcaops-blame.js';
import { orcaopsCaptureSkill } from './orcaops-capture.js';
import { orcaopsCheckpointSkill } from './orcaops-checkpoint.js';
import { orcaopsDecisionsSkill } from './orcaops-decisions.js';
import { orcaopsDigestSkill } from './orcaops-digest.js';
import { orcaopsDoctorSkill } from './orcaops-doctor.js';
import { orcaopsEstimateSkill } from './orcaops-estimate.js';
import { orcaopsFinishSkill } from './orcaops-finish.js';
import { orcaopsLessonsSkill } from './orcaops-lessons.js';
import { orcaopsLooseEndsSkill } from './orcaops-loose-ends.js';
import { orcaopsParallelDispatchSkill } from './orcaops-parallel-dispatch.js';
import { orcaopsPlanApprovalSkill } from './orcaops-plan-approval.js';
import { orcaopsPlanCritiqueSkill } from './orcaops-plan-critique.js';
import { orcaopsPrePrSkill } from './orcaops-pre-pr.js';
import { orcaopsRecapSkill } from './orcaops-recap.js';
import { orcaopsResumeSkill } from './orcaops-resume.js';
import { orcaopsReviewSkill } from './orcaops-review.js';
import { orcaopsSearchSkill } from './orcaops-search.js';
import { orcaopsSeedDiscoverySkill } from './orcaops-seed-discovery.js';
import { orcaopsSeedSkill } from './orcaops-seed.js';
import { orcaopsSummarySkill } from './orcaops-summary.js';
import { orcaopsTaskReviewSkill } from './orcaops-task-review.js';
import { orcaopsTimetravelSkill } from './orcaops-timetravel.js';
import { orcaopsWhySkill } from './orcaops-why.js';
import { SYNC_SIGNAL_STEERING } from './sync-signal-steering.js';

/**
 * All skill templates orcaops ships.
 *
 * Two groups:
 *   - **Write/lifecycle** (6): capture / checkpoint / plan-approval / pre-pr /
 *     finish / summary. Agent fires these as it does work — they're the core artifact
 *     thread driver (plan-approval is the optional cloud source-plan track).
 *   - **Read** (5): digest / why / resume / search / doctor. Mirrors of
 *     the like-named slash commands. Skills enable two things slashes
 *     don't: (a) implicit invocation when the agent decides the user's
 *     phrasing matches a skill description, and (b) parity for adapters
 *     like Codex that don't ship slash commands.
 *
 * Install order is preserved by index for deterministic test fixtures.
 */

/**
 * Append a steering block to a template's body.
 *
 * Preserve the body's shape: a `(prefix) => string` body MUST stay a function so
 * the renderer can call it with the active prefix. Interpolating it into a
 * template literal would coerce the function to its SOURCE TEXT (`(prefix) => …`),
 * corrupting the generated SKILL.md (leaked arrow source + unevaluated `${skillRef}`).
 */
const withSteering =
  (steering: string) =>
  (skill: SkillTemplate): SkillTemplate => ({
    ...skill,
    body:
      typeof skill.body === 'function'
        ? (prefix: string, options?: SkillBodyOptions) =>
            `${(skill.body as (p: string, o?: SkillBodyOptions) => string)(prefix, options)}\n\n${steering}`
        : `${skill.body}\n\n${steering}`,
  });

/**
 * Cloud-gated templates only — it names cloud commands, which must not reach a
 * committed file on an install that cannot reach the cloud.
 */
const withCloudSyncSteering = withSteering(CLOUD_SYNC_STEERING);

/**
 * The ungated lifecycle skills, whose commands are the ones that actually emit
 * `cloud_sync`. Product-neutral and command-free, so the committed SKILL.md
 * renders identically with and without credentials; the remediation itself
 * travels in the `cloud_sync` envelope at runtime.
 */
const withSyncSignalSteering = withSteering(SYNC_SIGNAL_STEERING);

/**
 * Tag a template with its group at the registry (spread-based, so both
 * plain and cloud-sync-steered templates carry it). The SKILL.md renderer
 * ignores the metadata — generated files are byte-identical.
 */
const withGroup = (skill: SkillTemplate, group: SkillGroup): SkillTemplate => ({
  ...skill,
  group,
});

export const SKILL_TEMPLATES: ReadonlyArray<SkillTemplate> = [
  withGroup(withSyncSignalSteering(orcaopsCaptureSkill), 'lifecycle'),
  withGroup(withSyncSignalSteering(orcaopsCheckpointSkill), 'lifecycle'),
  withGroup(withCloudSyncSteering(orcaopsPlanApprovalSkill), 'lifecycle'),
  withGroup(withSyncSignalSteering(orcaopsPrePrSkill), 'lifecycle'),
  withGroup(withSyncSignalSteering(orcaopsFinishSkill), 'lifecycle'),
  withGroup(withSyncSignalSteering(orcaopsSummarySkill), 'lifecycle'),
  withGroup(orcaopsDigestSkill, 'read'),
  withGroup(orcaopsWhySkill, 'read'),
  withGroup(orcaopsResumeSkill, 'read'),
  withGroup(orcaopsSearchSkill, 'read'),
  withGroup(orcaopsDoctorSkill, 'read'),
  // Insight/review skills: APPENDED so earlier indices are stable
  // (deterministic fixtures). Self-tagged (group/defaults live on the
  // template), NOT cloud-sync-steered — they are read-side skills that never
  // emit `cloud_sync`.
  orcaopsAdversarialReviewSkill,
  // OPT-IN skills: defaultEnabled false — present in the registry (so
  // `skills list` shows them and `skills enable` can turn them on) but
  // excluded from the default install/block.
  orcaopsLooseEndsSkill,
  orcaopsDecisionsSkill,
  orcaopsParallelDispatchSkill,
  // OPT-IN insight skills: defaultEnabled false, APPENDED (indices
  // preserved). Self-tagged, NOT cloud-sync-steered (read-side), no
  // `requires` (no diff-fingerprint dependency).
  orcaopsEstimateSkill,
  orcaopsLessonsSkill,
  // Consumption skills: APPENDED (indices preserved).
  // timetravel is defaultEnabled + requires: ['snapshot-checkout'] — on by
  // default (the capability derives from diff_fingerprint.enabled, itself
  // default-on), inert only when snapshots are killed. Self-tagged, NOT
  // cloud-sync-steered (read-side).
  orcaopsTimetravelSkill,
  // blame (agent-trace export) — OPT-IN (side-effectful: writes files/notes)
  // and matcher-gated.
  orcaopsBlameSkill,
  // recap — default-on window/ref-range summarizer. APPENDED (indices
  // preserved).
  orcaopsRecapSkill,
  // plan-critique — proactive plan review against captured history; ungated
  // (NO requires), default-on. APPENDED.
  orcaopsPlanCritiqueSkill,
  // task-review — generate the two-lane routine review + address reviewer
  // comments via `orcaops review …` (the review commands ship with the
  // distribution, so default-ON). Self-tagged, NOT cloud-sync-steered (the
  // review verbs never emit cloud_sync). APPENDED.
  orcaopsTaskReviewSkill,
  // review-feedback loop — APPENDED (indices preserved). Lifecycle/write
  // like plan-approval (checkpoint + push emit cloud_sync); default-on, no
  // `requires`.
  withGroup(withCloudSyncSteering(orcaopsReviewSkill), 'lifecycle'),
  // Git-history onboarding and progressive gap filling — appended together so
  // the storage catalog and generated install order remain append-only.
  orcaopsSeedSkill,
  orcaopsSeedDiscoverySkill,
  // author-evaluator — the only `authoring` member. APPENDED LAST (indices
  // preserved). Self-tagged, no `requires`, NOT cloud-sync-steered: it drives
  // `eval *` verbs, none of which emit `cloud_sync`. Ships
  // `disableModelInvocation`, so on Claude Code the human opens it and the
  // block trigger line only recommends it.
  orcaopsAuthorEvaluatorSkill,
];

export {
  orcaopsAdversarialReviewSkill,
  orcaopsAuthorEvaluatorSkill,
  orcaopsBlameSkill,
  orcaopsCaptureSkill,
  orcaopsCheckpointSkill,
  orcaopsDecisionsSkill,
  orcaopsDigestSkill,
  orcaopsDoctorSkill,
  orcaopsEstimateSkill,
  orcaopsLessonsSkill,
  orcaopsLooseEndsSkill,
  orcaopsPlanApprovalSkill,
  orcaopsPlanCritiqueSkill,
  orcaopsPrePrSkill,
  orcaopsRecapSkill,
  orcaopsResumeSkill,
  orcaopsParallelDispatchSkill,
  orcaopsReviewSkill,
  orcaopsSearchSkill,
  orcaopsSeedDiscoverySkill,
  orcaopsSeedSkill,
  orcaopsSummarySkill,
  orcaopsTaskReviewSkill,
  orcaopsTimetravelSkill,
  orcaopsWhySkill,
};
