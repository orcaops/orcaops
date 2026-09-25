import type { CorpusArtifactKey } from './story.js';

/**
 * One captured event of a story artifact: the plan capture, the plan revision with that
 * `revision_n`, the closed checkpoint with that `n`, or the nth summary capture (1 is the
 * first summary, 2 its amendment).
 */
export type CorpusEventRef =
  | 'plan_captured'
  | `plan_revised:${number}`
  | `checkpoint_closed:${number}`
  | `summary_captured:${number}`;

/** `path` is the dotted payload path search reports as a hit's field. */
export interface RecordLocator {
  artifact: CorpusArtifactKey;
  event: CorpusEventRef;
  path: string;
  wording: string;
}

export const fieldFamilies = {
  'decisions and alternatives':
    /^decisions\.\d+\.(decision|reason|alternatives_considered\.\d+\.(option|rejected_because))$/,
  'acceptance criteria and lineage':
    /^(plan_steps\.\d+\.acceptance_criteria\.\d+\.text|criterion_lineage\.(removed\.\d+\.text|rewritten\.\d+\.(prior_text|new_text)))$/,
  uncertainty: /^uncertainty\.\d+$/,
  'deferred decisions': /^deferred_decisions\.\d+$/,
  'non-goals': /^non_goals\.\d+\.(text|rationale)$/,
} as const;
export type FieldFamily = keyof typeof fieldFamilies;

export const phrasingClasses = {
  'exact wording': 'A run of words copied from one of the expected records.',
  'single keyword': 'One word the agent expects the records to contain.',
  'partial wording':
    "Several words, at least half of them the expected records' own in some inflection, as an agent half-remembers them: reordered, scattered, never a run copied from a record.",
  paraphrase:
    "The records' meaning in other vocabulary: fewer than half of the query's content words are the records' own in any inflection.",
  'obsolete wording': 'Wording the history once held and has since rewritten, removed, or amended.',
} as const;
export type PhrasingClass = keyof typeof phrasingClasses;

export interface RetrievalCase {
  name: string;
  /** What a planning agent wants to know. */
  question: string;
  /** What it would plausibly type; each query is scored on its own. */
  queries: string[];
  family: FieldFamily;
  phrasing: PhrasingClass;
  /** Every record, in an event that still stands, that answers the question. */
  expected: RecordLocator[];
  /**
   * Obsolete-wording cases only: where the queried wording survives in a superseded plan
   * revision or an amended summary. Finding only these hands the agent old guidance without
   * its current standing.
   */
  supersededSources?: RecordLocator[];
}

function record(
  artifact: CorpusArtifactKey,
  event: CorpusEventRef,
  path: string,
  wording: string
): RecordLocator {
  return { artifact, event, path, wording };
}

const throttlingBannerDecisions = [
  record('uploadRateLimit', 'plan_revised:1', 'decisions.2.decision', 'Drop the throttling banner'),
  record(
    'syncStatusIndicator',
    'checkpoint_closed:1',
    'decisions.0.decision',
    'Do not show a banner when uploads are throttled; the badge stays on uploading'
  ),
];

const lastWriterWinsAlternative = [
  record(
    'conflictResolution',
    'plan_captured',
    'decisions.0.alternatives_considered.0.option',
    'Last writer wins by device clock'
  ),
  record(
    'conflictResolution',
    'plan_captured',
    'decisions.0.alternatives_considered.0.rejected_because',
    'Tablet clocks drift by minutes, so the wrong edit would silently win'
  ),
];

const decisionCases: RetrievalCase[] = [
  {
    name: 'storage engine choice',
    question: 'Which storage engine did we choose for the device?',
    queries: ['Use SQLite for on-device storage'],
    family: 'decisions and alternatives',
    phrasing: 'exact wording',
    expected: [
      record(
        'storageEngine',
        'plan_captured',
        'decisions.0.decision',
        'Use SQLite for on-device storage'
      ),
    ],
  },
  {
    name: 'rejected key-value store',
    question: 'Was a key-value store considered for the device?',
    queries: ['LevelDB key-value store'],
    family: 'decisions and alternatives',
    phrasing: 'exact wording',
    expected: [
      record(
        'storageEngine',
        'plan_captured',
        'decisions.0.alternatives_considered.0.option',
        'LevelDB key-value store'
      ),
    ],
  },
  {
    name: 'why server-side deduplication lost',
    question: 'Why not let the server deduplicate uploads by their content?',
    queries: ['Two inspectors can legitimately file identical notes'],
    family: 'decisions and alternatives',
    phrasing: 'exact wording',
    expected: [
      record(
        'uploadRetry',
        'plan_captured',
        'decisions.0.alternatives_considered.0.rejected_because',
        'Two inspectors can legitimately file identical notes, and an edited retry would slip through'
      ),
    ],
  },
  {
    name: 'where the consent gate is enforced',
    question: 'Which layer refuses uploads while consent is missing?',
    queries: ['Enforce the gate in the transport layer'],
    family: 'decisions and alternatives',
    phrasing: 'exact wording',
    expected: [
      record(
        'syncConsent',
        'checkpoint_closed:1',
        'decisions.0.decision',
        'Enforce the gate in the transport layer, not in the queue'
      ),
    ],
  },
  {
    name: 'decisions that assume SQLite',
    question: 'Which earlier decisions assume SQLite is the device store?',
    queries: ['SQLite'],
    family: 'decisions and alternatives',
    phrasing: 'single keyword',
    expected: [
      record(
        'storageEngine',
        'plan_captured',
        'decisions.0.decision',
        'Use SQLite for on-device storage'
      ),
      record(
        'storageEngine',
        'plan_captured',
        'decisions.1.decision',
        'Run SQLite in write-ahead logging mode with synchronous set to full'
      ),
      record(
        'storageEngine',
        'checkpoint_closed:1',
        'decisions.0.reason',
        'SQLite allows one writer at a time; serializing writes in the app avoids busy-timeout retries'
      ),
      record(
        'uploadRateLimit',
        'checkpoint_closed:1',
        'decisions.0.decision',
        'Store bucket state in the SQLite database rather than in memory'
      ),
      record(
        'photoAttachments',
        'plan_captured',
        'decisions.0.decision',
        'Store photo files on the filesystem and keep only their paths in SQLite'
      ),
      record(
        'dataExport',
        'plan_captured',
        'decisions.0.alternatives_considered.0.option',
        'Copy the SQLite file'
      ),
    ],
  },
  {
    name: 'token bucket over a fixed window',
    question: 'Why does the rate limiter use a token bucket instead of a fixed window?',
    queries: ['token bucket fixed window'],
    family: 'decisions and alternatives',
    phrasing: 'partial wording',
    expected: [
      record(
        'uploadRateLimit',
        'plan_revised:1',
        'decisions.0.decision',
        'Limit uploads with a token bucket'
      ),
      record(
        'uploadRateLimit',
        'plan_revised:1',
        'decisions.0.alternatives_considered.0.option',
        'Fixed one-minute window counter'
      ),
    ],
  },
  {
    name: 'banner while uploads are throttled, one decision quoted',
    question: 'Did we decide anything about showing a banner while uploads are throttled?',
    queries: ['throttling banner'],
    family: 'decisions and alternatives',
    phrasing: 'exact wording',
    expected: throttlingBannerDecisions,
  },
  {
    name: 'banner while uploads are throttled',
    question: 'Did we decide anything about showing a banner while uploads are throttled?',
    queries: ['banner throttled'],
    family: 'decisions and alternatives',
    phrasing: 'partial wording',
    expected: throttlingBannerDecisions,
  },
  {
    name: 'making retries safe to repeat',
    question: 'How do we make upload retries safe to repeat?',
    queries: ['idempotency key retries'],
    family: 'decisions and alternatives',
    phrasing: 'partial wording',
    expected: [
      record(
        'uploadRetry',
        'plan_captured',
        'decisions.0.decision',
        'Make retries safe with a client-generated idempotency key per note'
      ),
    ],
  },
  {
    name: 'no down migrations',
    question: 'Can a schema migration be rolled back?',
    queries: ['migrations forward only', 'down migration'],
    family: 'decisions and alternatives',
    phrasing: 'partial wording',
    expected: [
      record(
        'storageEngine',
        'checkpoint_closed:2',
        'decisions.0.decision',
        'Migrations only move forward; there are no down migrations'
      ),
    ],
  },
  {
    name: 'preventing duplicate notes',
    question: 'How do we stop a resent upload from creating the same note twice?',
    queries: ['prevent duplicate notes when resending', 'dedupe repeated submissions'],
    family: 'decisions and alternatives',
    phrasing: 'paraphrase',
    expected: [
      record(
        'uploadRetry',
        'plan_captured',
        'decisions.0.decision',
        'Make retries safe with a client-generated idempotency key per note'
      ),
      record(
        'uploadRetry',
        'plan_captured',
        'decisions.0.alternatives_considered.0.option',
        'Deduplicate on the server by hashing note content'
      ),
    ],
  },
  {
    name: 'newest edit wins',
    question: 'Why not simply let the most recent edit win a conflict?',
    queries: ['newest edit wins'],
    family: 'decisions and alternatives',
    phrasing: 'partial wording',
    expected: lastWriterWinsAlternative,
  },
  {
    name: 'most recent change overrides',
    question: 'Why not simply let the most recent edit win a conflict?',
    queries: ['most recent change overrides'],
    family: 'decisions and alternatives',
    phrasing: 'paraphrase',
    expected: lastWriterWinsAlternative,
  },
  {
    name: 'images inside the database',
    question: 'Are attached images kept inside the database?',
    queries: ['images inside the database', 'pictures stored as binary data'],
    family: 'decisions and alternatives',
    phrasing: 'paraphrase',
    expected: [
      record(
        'photoAttachments',
        'plan_captured',
        'decisions.0.decision',
        'Store photo files on the filesystem and keep only their paths in SQLite'
      ),
      record(
        'photoAttachments',
        'plan_captured',
        'decisions.0.alternatives_considered.0.option',
        'Store photos as BLOB columns'
      ),
    ],
  },
  {
    name: 'terms of service as consent',
    question: 'Can agreeing to the terms of service count as consent to sync?',
    queries: ['agreeing to the terms counts as permission', 'implied consent at signup'],
    family: 'decisions and alternatives',
    phrasing: 'paraphrase',
    expected: [
      record(
        'syncConsent',
        'plan_revised:1',
        'decisions.0.alternatives_considered.0.option',
        'Treat acceptance of the terms of service as consent'
      ),
      record(
        'syncConsent',
        'plan_revised:1',
        'decisions.0.alternatives_considered.0.rejected_because',
        'Bundled consent does not meet the explicit-consent bar the legal review set'
      ),
    ],
  },
];

const criterionCases: RetrievalCase[] = [
  {
    name: 'saving with the network off',
    question: 'What must hold for saving a note while the network is off?',
    queries: ['succeeds with the network interface disabled'],
    family: 'acceptance criteria and lineage',
    phrasing: 'exact wording',
    expected: [
      record(
        'offlineCapture',
        'plan_captured',
        'plan_steps.0.acceptance_criteria.0.text',
        'Saving a note succeeds with the network interface disabled'
      ),
    ],
  },
  {
    name: 'current request ceiling',
    question: 'What upload request ceiling is required per device?',
    queries: ['at most 20 upload requests per minute per device'],
    family: 'acceptance criteria and lineage',
    phrasing: 'exact wording',
    expected: [
      record(
        'uploadRateLimit',
        'plan_revised:1',
        'plan_steps.0.acceptance_criteria.0.text',
        'The client sends at most 20 upload requests per minute per device, with bursts of up to 40'
      ),
    ],
  },
  {
    name: 'queue pause on a 429, carried across the revision',
    question: 'What must the client do when the server answers 429?',
    queries: ['A 429 response pauses the queue'],
    family: 'acceptance criteria and lineage',
    phrasing: 'exact wording',
    expected: [
      record(
        'uploadRateLimit',
        'plan_revised:1',
        'plan_steps.0.acceptance_criteria.1.text',
        'A 429 response pauses the queue until the Retry-After interval has elapsed'
      ),
    ],
  },
  {
    name: 'longest retry delay',
    question: 'What is the longest allowed delay between upload retries?',
    queries: ['retry delay ceiling', 'backoff five minute'],
    family: 'acceptance criteria and lineage',
    phrasing: 'partial wording',
    expected: [
      record(
        'uploadRetry',
        'plan_captured',
        'plan_steps.1.acceptance_criteria.0.text',
        'Retry delays double from one second up to a five minute ceiling, with random jitter'
      ),
    ],
  },
  {
    name: 'queued uploads after consent is revoked',
    question: 'What happens to queued uploads when consent is withdrawn?',
    queries: ['revoking consent queued uploads'],
    family: 'acceptance criteria and lineage',
    phrasing: 'partial wording',
    expected: [
      record(
        'syncConsent',
        'plan_revised:1',
        'plan_steps.0.acceptance_criteria.2.text',
        'Revoking consent stops queued uploads within one sync cycle'
      ),
    ],
  },
  {
    name: 'restoring an export',
    question: 'Does an export have to be restorable on a wiped tablet?',
    queries: ['export restored factory reset'],
    family: 'acceptance criteria and lineage',
    phrasing: 'partial wording',
    expected: [
      record(
        'dataExport',
        'plan_captured',
        'plan_steps.0.acceptance_criteria.1.text',
        'An export can be restored on a factory-reset tablet'
      ),
    ],
  },
  {
    name: 'database survives a kill mid-write',
    question: 'Must the database survive the app being killed in the middle of a write?',
    queries: ['database survives app killed during write', 'crash safety'],
    family: 'acceptance criteria and lineage',
    phrasing: 'paraphrase',
    expected: [
      record(
        'storageEngine',
        'plan_captured',
        'plan_steps.0.acceptance_criteria.1.text',
        'A write interrupted by process death leaves the database readable'
      ),
    ],
  },
  {
    name: 'uploads keep their order',
    question: 'Are notes uploaded in the order they were written?',
    queries: ['notes sent in the sequence they were created'],
    family: 'acceptance criteria and lineage',
    phrasing: 'paraphrase',
    expected: [
      record(
        'offlineCapture',
        'plan_captured',
        'plan_steps.1.acceptance_criteria.0.text',
        'Queued notes upload in the order they were saved once connectivity returns'
      ),
    ],
  },
  {
    name: 'audit entries are immutable',
    question: 'Can anyone change or remove a consent audit entry?',
    queries: ['immutable audit records', 'tamper proof consent history'],
    family: 'acceptance criteria and lineage',
    phrasing: 'paraphrase',
    expected: [
      record(
        'consentAudit',
        'plan_captured',
        'plan_steps.0.acceptance_criteria.1.text',
        'Audit entries cannot be edited or deleted from the app'
      ),
    ],
  },
  {
    name: 'first request ceiling, since rewritten',
    question:
      'We agreed on 100 upload requests per minute per device. Is that still the requirement?',
    queries: ['at most 100 upload requests per minute per device', '100 requests per minute'],
    family: 'acceptance criteria and lineage',
    phrasing: 'obsolete wording',
    expected: [
      record(
        'uploadRateLimit',
        'plan_revised:1',
        'criterion_lineage.rewritten.0.prior_text',
        'The client sends at most 100 upload requests per minute per device'
      ),
    ],
    supersededSources: [
      record(
        'uploadRateLimit',
        'plan_captured',
        'plan_steps.0.acceptance_criteria.0.text',
        'The client sends at most 100 upload requests per minute per device'
      ),
    ],
  },
  {
    name: 'throttling banner requirement, since removed',
    question: 'Is the app still required to show a banner while sync is throttled?',
    queries: ['A throttled upload shows a banner', 'banner sync is slowed'],
    family: 'acceptance criteria and lineage',
    phrasing: 'obsolete wording',
    expected: [
      record(
        'uploadRateLimit',
        'plan_revised:1',
        'criterion_lineage.removed.0.text',
        'A throttled upload shows a banner telling the inspector that sync is slowed'
      ),
    ],
    supersededSources: [
      record(
        'uploadRateLimit',
        'plan_captured',
        'plan_steps.0.acceptance_criteria.1.text',
        'A throttled upload shows a banner telling the inspector that sync is slowed'
      ),
    ],
  },
  {
    name: 'consent once per device, since rewritten',
    question: 'Do we still ask for consent once on every device?',
    queries: ['Consent is requested once per device'],
    family: 'acceptance criteria and lineage',
    phrasing: 'obsolete wording',
    expected: [
      record(
        'syncConsent',
        'plan_revised:1',
        'criterion_lineage.rewritten.0.prior_text',
        'Consent is requested once per device'
      ),
    ],
    supersededSources: [
      record(
        'syncConsent',
        'plan_captured',
        'plan_steps.0.acceptance_criteria.1.text',
        'Consent is requested once per device'
      ),
    ],
  },
  {
    name: 'declining consent signs out, since removed',
    question: 'Does declining consent still sign the inspector out?',
    queries: ['Declining consent signs the inspector out', 'decline consent sign out'],
    family: 'acceptance criteria and lineage',
    phrasing: 'obsolete wording',
    expected: [
      record(
        'syncConsent',
        'plan_revised:1',
        'criterion_lineage.removed.0.text',
        'Declining consent signs the inspector out'
      ),
    ],
    supersededSources: [
      record(
        'syncConsent',
        'plan_captured',
        'plan_steps.1.acceptance_criteria.1.text',
        'Declining consent signs the inspector out'
      ),
    ],
  },
];

const uncertaintyCases: RetrievalCase[] = [
  {
    name: 'idempotency key retention',
    question: 'Is it known how long the server keeps idempotency keys?',
    queries: ['Whether the server keeps idempotency keys for longer than 24 hours'],
    family: 'uncertainty',
    phrasing: 'exact wording',
    expected: [
      record(
        'uploadRetry',
        'checkpoint_closed:1',
        'uncertainty.0',
        'Whether the server keeps idempotency keys for longer than 24 hours'
      ),
    ],
  },
  {
    name: 'guardian consent for minors',
    question: 'Is there an open question about underage inspectors?',
    queries: ['inspectors under 18 need a guardian'],
    family: 'uncertainty',
    phrasing: 'exact wording',
    expected: [
      record(
        'syncConsent',
        'checkpoint_closed:2',
        'uncertainty.0',
        'Whether inspectors under 18 need a guardian to consent'
      ),
    ],
  },
  {
    name: 'write-ahead log growth',
    question: 'Is anyone worried about the write-ahead log growing?',
    queries: ['write-ahead log grow'],
    family: 'uncertainty',
    phrasing: 'partial wording',
    expected: [
      record(
        'storageEngine',
        'checkpoint_closed:1',
        'uncertainty.0',
        'Whether the write-ahead log can grow without bound if a long-running read never finishes'
      ),
    ],
  },
  {
    name: 'battery cost of flushing',
    question: 'Do we know what flushing on every save costs in battery?',
    queries: ['battery flush', 'flushing battery'],
    family: 'uncertainty',
    phrasing: 'partial wording',
    expected: [
      record(
        'offlineCapture',
        'checkpoint_closed:1',
        'uncertainty.0',
        'Whether flushing on every save drains the battery noticeably on older tablets'
      ),
    ],
  },
  {
    name: 'doubts about consent',
    question: 'What is still uncertain about consent?',
    queries: ['consent'],
    family: 'uncertainty',
    phrasing: 'single keyword',
    expected: [
      record(
        'syncConsent',
        'checkpoint_closed:1',
        'uncertainty.0',
        'Whether cached consent may be trusted when the device has been offline for more than 30 days'
      ),
      record(
        'syncConsent',
        'checkpoint_closed:2',
        'uncertainty.0',
        'Whether inspectors under 18 need a guardian to consent'
      ),
    ],
  },
  {
    name: 'unresolved legal questions',
    question: 'Which legal questions are still unresolved?',
    queries: ['open legal questions', 'unresolved compliance concerns'],
    family: 'uncertainty',
    phrasing: 'paraphrase',
    expected: [
      record(
        'photoAttachments',
        'checkpoint_closed:1',
        'uncertainty.0',
        'Whether downscaled photos are acceptable as legal evidence'
      ),
      record(
        'syncConsent',
        'checkpoint_closed:2',
        'uncertainty.0',
        'Whether inspectors under 18 need a guardian to consent'
      ),
      record(
        'dataExport',
        'checkpoint_closed:1',
        'uncertainty.0',
        'Whether exports need a password when they contain site owner names'
      ),
    ],
  },
  {
    name: 'stale consent on a long-offline tablet',
    question: 'Can we rely on consent cached on a tablet that has not connected for weeks?',
    queries: ['stale consent on a disconnected tablet'],
    family: 'uncertainty',
    phrasing: 'paraphrase',
    expected: [
      record(
        'syncConsent',
        'checkpoint_closed:1',
        'uncertainty.0',
        'Whether cached consent may be trusted when the device has been offline for more than 30 days'
      ),
    ],
  },
  {
    name: 'slow launch with a large backlog',
    question: 'Could a big backlog of unsent notes slow down launching the app?',
    queries: ['slow launch with a big backlog'],
    family: 'uncertainty',
    phrasing: 'paraphrase',
    expected: [
      record(
        'offlineCapture',
        'checkpoint_closed:2',
        'uncertainty.0',
        'How large the upload queue can grow before startup time suffers'
      ),
    ],
  },
];

const deferredDecisionCases: RetrievalCase[] = [
  {
    name: 'cap on unsent notes',
    question: 'Did we settle whether a device may hold unlimited unsent notes?',
    queries: ['cap how many unsent notes a device may hold'],
    family: 'deferred decisions',
    phrasing: 'exact wording',
    expected: [
      record(
        'offlineCapture',
        'summary_captured:1',
        'deferred_decisions.0',
        'Whether to cap how many unsent notes a device may hold'
      ),
    ],
  },
  {
    name: 'asking for consent again',
    question: 'Did we settle how often consent is asked again after a policy change?',
    queries: ['How often to ask again when the privacy policy text changes'],
    family: 'deferred decisions',
    phrasing: 'exact wording',
    expected: [
      record(
        'syncConsent',
        'summary_captured:1',
        'deferred_decisions.0',
        'How often to ask again when the privacy policy text changes'
      ),
    ],
  },
  {
    name: 'vacuuming the database',
    question: 'Who is responsible for vacuuming the database?',
    queries: ['vacuum database'],
    family: 'deferred decisions',
    phrasing: 'partial wording',
    expected: [
      record(
        'storageEngine',
        'summary_captured:1',
        'deferred_decisions.0',
        'Whether to vacuum the database automatically or leave it to a maintenance screen'
      ),
    ],
  },
  {
    name: 'postponed encryption choices',
    question: 'Which encryption choices were postponed?',
    queries: ['encryption', 'encrypted'],
    family: 'deferred decisions',
    phrasing: 'single keyword',
    expected: [
      record(
        'storageEngine',
        'summary_captured:1',
        'deferred_decisions.1',
        'Whether the database needs its own encryption once unmanaged personal tablets are allowed'
      ),
      record(
        'dataExport',
        'summary_captured:1',
        'deferred_decisions.0',
        'Whether exports should be encrypted by default'
      ),
    ],
  },
  {
    name: 'uploads that never succeed',
    question: 'What happens to a note that can never be uploaded?',
    queries: ['permanently failing uploads', 'give up after too many failures'],
    family: 'deferred decisions',
    phrasing: 'paraphrase',
    expected: [
      record(
        'uploadRetry',
        'summary_captured:2',
        'deferred_decisions.0',
        'Notes that exhaust their retry budget need a dead-letter view; the design is deferred until support reports how often it happens'
      ),
    ],
  },
  {
    name: 'reclaiming space from uploaded photos',
    question: 'Do photos stay on the tablet after they have been uploaded?',
    queries: ['free up space after photos are synced'],
    family: 'deferred decisions',
    phrasing: 'paraphrase',
    expected: [
      record(
        'photoAttachments',
        'summary_captured:1',
        'deferred_decisions.0',
        'Whether to delete local photo files once the server has confirmed the upload'
      ),
    ],
  },
  {
    name: 'retry exhaustion, since amended',
    question:
      'We deferred what to do with a note that still fails after the maximum number of attempts. Where does that stand?',
    queries: [
      'What to do with a note that still fails after the maximum number of attempts',
      'note still fails maximum attempts',
    ],
    family: 'deferred decisions',
    phrasing: 'obsolete wording',
    expected: [
      record(
        'uploadRetry',
        'summary_captured:2',
        'deferred_decisions.0',
        'Notes that exhaust their retry budget need a dead-letter view; the design is deferred until support reports how often it happens'
      ),
    ],
    supersededSources: [
      record(
        'uploadRetry',
        'summary_captured:1',
        'deferred_decisions.0',
        'What to do with a note that still fails after the maximum number of attempts'
      ),
    ],
  },
];

const nonGoalCases: RetrievalCase[] = [
  {
    name: 'no live collaboration',
    question: 'Is live collaboration on a note in scope?',
    queries: ['Real-time collaboration on a shared note'],
    family: 'non-goals',
    phrasing: 'exact wording',
    expected: [
      record(
        'offlineCapture',
        'plan_captured',
        'non_goals.0.text',
        'Real-time collaboration on a shared note'
      ),
    ],
  },
  {
    name: 'why video is excluded',
    question: 'Why are video attachments excluded?',
    queries: ['Video files are too large for the cellular plans inspectors use'],
    family: 'non-goals',
    phrasing: 'exact wording',
    expected: [
      record(
        'photoAttachments',
        'plan_captured',
        'non_goals.0.rationale',
        'Video files are too large for the cellular plans inspectors use'
      ),
    ],
  },
  {
    name: 'server quotas',
    question: 'Is enforcing quotas on the server part of the rate limit work?',
    queries: ['server quota'],
    family: 'non-goals',
    phrasing: 'partial wording',
    expected: [
      record(
        'uploadRateLimit',
        'plan_revised:1',
        'non_goals.0.text',
        'Server-side quota enforcement'
      ),
    ],
  },
  {
    name: 'automatic merge',
    question: 'Did we rule out merging conflicting notes automatically?',
    queries: ['automatic merge'],
    family: 'non-goals',
    phrasing: 'partial wording',
    expected: [
      record(
        'conflictResolution',
        'plan_captured',
        'non_goals.0.text',
        'Automatic merging of note text'
      ),
    ],
  },
  {
    name: 'encrypting the local database',
    question: 'Are we encrypting the local database?',
    queries: ['encrypt local database', 'database encryption on the tablet'],
    family: 'non-goals',
    phrasing: 'partial wording',
    expected: [
      record(
        'storageEngine',
        'plan_captured',
        'non_goals.0.text',
        'Encrypting the database file at rest'
      ),
    ],
  },
  {
    name: 'browser version',
    question: 'Is a browser version of the app planned?',
    queries: ['browser version of the app'],
    family: 'non-goals',
    phrasing: 'paraphrase',
    expected: [record('offlineCapture', 'plan_captured', 'non_goals.1.text', 'A web client')],
  },
  {
    name: 'admin dashboard for consent history',
    question: 'Will administrators get a dashboard of consent history?',
    queries: ['admin dashboard for consent history'],
    family: 'non-goals',
    phrasing: 'paraphrase',
    expected: [
      record(
        'consentAudit',
        'plan_captured',
        'non_goals.0.text',
        'A reporting screen for administrators'
      ),
    ],
  },
  {
    name: 'telemetry consent, since reworded',
    question: 'Is consent for crash reporting and analytics still outside the consent prompt?',
    queries: ['Consent for crash reporting and analytics'],
    family: 'non-goals',
    phrasing: 'obsolete wording',
    expected: [
      record(
        'syncConsent',
        'plan_revised:1',
        'non_goals.0.text',
        'Telemetry consent (crash reports and usage analytics)'
      ),
    ],
    supersededSources: [
      record(
        'syncConsent',
        'plan_captured',
        'non_goals.0.text',
        'Consent for crash reporting and analytics'
      ),
    ],
  },
];

export const retrievalCases: RetrievalCase[] = [
  ...decisionCases,
  ...criterionCases,
  ...uncertaintyCases,
  ...deferredDecisionCases,
  ...nonGoalCases,
];
