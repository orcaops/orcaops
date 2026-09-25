export interface StoryDecision {
  decision: string;
  reason: string;
  alternatives_considered?: Array<{ option: string; rejected_because: string }>;
}

export interface StoryNonGoal {
  text: string;
  rationale: string;
}

export interface StoryStep {
  label: string;
  text: string;
  acceptance_criteria: string[];
}

/** Keeps the identity of the prior criterion whose text is `rewrites` and gives it new text. */
export interface StoryRewrittenCriterion {
  rewrites: string;
  text: string;
}

/**
 * A step whose label matches a prior step keeps that step's identity. A criterion restated
 * verbatim is carried, one left out is removed, and any other plain string is added.
 */
export interface StoryRevisedStep {
  label: string;
  text: string;
  acceptance_criteria: Array<string | StoryRewrittenCriterion>;
}

export interface StoryPlan {
  task: string;
  label: string;
  touched_scope: string[];
  steps: StoryStep[];
  non_goals: StoryNonGoal[];
  decisions: StoryDecision[];
}

export interface StoryRevision {
  label: string;
  rationale: string;
  touched_scope: string[];
  steps: StoryRevisedStep[];
  non_goals: StoryNonGoal[];
  /** Only the decisions this revision adds; earlier ones are carried by the capture path. */
  decisions: StoryDecision[];
}

export interface StoryCheckpoint {
  /** Labels of the steps the checkpoint declares and completes. */
  steps: string[];
  summary: string;
  files_changed: string[];
  decisions: StoryDecision[];
  uncertainty: string[];
}

export interface StorySummary {
  outcome: string;
  deferred_decisions: string[];
  open_items: string[];
}

/** Captured in this order: plan, revision, checkpoints, summary, amended summary. */
export interface StoryArtifact {
  branch: string;
  plan: StoryPlan;
  revision?: StoryRevision;
  checkpoints: StoryCheckpoint[];
  summary?: StorySummary;
  amendedSummary?: StorySummary;
}

export const checkpointEvidence = 'Covered by the automated tests added in this checkpoint';
export const checkpointVerification = { command: 'pnpm test', exit_code: 0 };

/**
 * A tablet app for building inspectors: notes are captured on the device first and synced
 * later. Artifacts are captured in key order, switching branch whenever `branch` changes.
 */
export const retrievalCorpusStory = {
  offlineCapture: {
    branch: 'main',
    plan: {
      task: 'Let inspectors record notes with no connectivity: every note is written to the device first and uploaded later.',
      label: 'Offline-first note capture',
      touched_scope: ['src/notes/**', 'src/upload/queue.ts'],
      steps: [
        {
          label: 'Local write path',
          text: 'Write each note to the local store before acknowledging the save',
          acceptance_criteria: [
            'Saving a note succeeds with the network interface disabled',
            'A saved note is readable after the app is force-quit and relaunched',
          ],
        },
        {
          label: 'Upload queue',
          text: 'Queue saved notes for background upload',
          acceptance_criteria: [
            'Queued notes upload in the order they were saved once connectivity returns',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Real-time collaboration on a shared note',
          rationale:
            'Inspectors work alone on site; live co-editing would force a connection the product promises not to need',
        },
        {
          text: 'A web client',
          rationale:
            'The first release targets the tablet app only; a browser client has no offline store to reuse',
        },
      ],
      decisions: [
        {
          decision:
            'Treat the device as the source of truth until a note is acknowledged by the server',
          reason: 'A note must never be lost because a request failed mid-flight',
          alternatives_considered: [
            {
              option: 'Hold unsent notes in memory and write them after upload succeeds',
              rejected_because:
                "A crash or battery loss before upload would discard the inspector's work",
            },
            {
              option: 'Block saving while offline and ask the inspector to reconnect',
              rejected_because: 'Basements and rural sites have no signal for hours',
            },
          ],
        },
      ],
    },
    checkpoints: [
      {
        steps: ['Local write path'],
        summary: 'Notes are persisted before the save call returns',
        files_changed: ['src/notes/save.ts'],
        decisions: [
          {
            decision: 'Acknowledge a save only after the write is flushed to disk',
            reason: 'An acknowledged note that vanishes on power loss is worse than a slower save',
          },
        ],
        uncertainty: [
          'Whether flushing on every save drains the battery noticeably on older tablets',
        ],
      },
      {
        steps: ['Upload queue'],
        summary: 'Saved notes enter a durable upload queue',
        files_changed: ['src/upload/queue.ts'],
        decisions: [],
        uncertainty: ['How large the upload queue can grow before startup time suffers'],
      },
    ],
    summary: {
      outcome: 'Inspectors can save notes offline and they upload when the connection returns',
      deferred_decisions: ['Whether to cap how many unsent notes a device may hold'],
      open_items: [
        'Measure the battery impact of per-save flushing on the oldest supported tablet',
      ],
    },
  },

  storageEngine: {
    branch: 'main',
    plan: {
      task: 'Choose the storage engine for notes on the device and set it up for crash safety.',
      label: 'On-device storage engine',
      touched_scope: ['src/storage/**'],
      steps: [
        {
          label: 'Adopt SQLite',
          text: 'Adopt SQLite as the on-device store for notes and the upload queue',
          acceptance_criteria: [
            'The database opens in write-ahead logging mode',
            'A write interrupted by process death leaves the database readable',
          ],
        },
        {
          label: 'Schema and migrations',
          text: 'Create the schema and a versioned migration runner',
          acceptance_criteria: [
            'Opening a database from the previous app version upgrades it without data loss',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Encrypting the database file at rest',
          rationale:
            'Device-level encryption is mandatory on managed tablets, so a second layer adds key-management risk for no gain yet',
        },
        {
          text: 'Syncing the raw database file to the server',
          rationale: 'The server owns its own schema; only notes travel, never the file',
        },
      ],
      decisions: [
        {
          decision: 'Use SQLite for on-device storage',
          reason: 'It is transactional, ships with the platform, and one file is easy to back up',
          alternatives_considered: [
            {
              option: 'LevelDB key-value store',
              rejected_because:
                'No multi-row transactions, so a note and its queue entry could be written separately',
            },
            {
              option: 'One JSON file per note',
              rejected_because:
                'Partial writes corrupt a note and listing thousands of files is slow',
            },
            {
              option: 'Realm',
              rejected_because:
                'A proprietary file format would tie exports and debugging to one vendor',
            },
          ],
        },
        {
          decision: 'Run SQLite in write-ahead logging mode with synchronous set to full',
          reason:
            'Readers must not block the save path, and a save acknowledged to the inspector has to survive power loss',
        },
      ],
    },
    checkpoints: [
      {
        steps: ['Adopt SQLite'],
        summary: 'The app opens one SQLite database with crash-safe settings',
        files_changed: ['src/storage/database.ts'],
        decisions: [
          {
            decision: 'Keep a single writer connection and a small pool of read connections',
            reason:
              'SQLite allows one writer at a time; serializing writes in the app avoids busy-timeout retries',
            alternatives_considered: [
              {
                option: 'Open a connection per operation',
                rejected_because: 'Connection setup dominated save latency in the prototype',
              },
            ],
          },
        ],
        uncertainty: [
          'Whether the write-ahead log can grow without bound if a long-running read never finishes',
        ],
      },
      {
        steps: ['Schema and migrations'],
        summary: 'The schema is created and upgraded by a versioned runner',
        files_changed: ['src/storage/migrations.ts'],
        decisions: [
          {
            decision: 'Migrations only move forward; there are no down migrations',
            reason:
              'A downgrade path doubles the test matrix and no release has ever been rolled back on devices',
          },
        ],
        uncertainty: [],
      },
    ],
    summary: {
      outcome:
        'Notes and the upload queue live in one SQLite database with forward-only migrations',
      deferred_decisions: [
        'Whether to vacuum the database automatically or leave it to a maintenance screen',
        'Whether the database needs its own encryption once unmanaged personal tablets are allowed',
      ],
      open_items: [
        'Add a checkpoint policy so the write-ahead log is truncated when the app goes to the background',
      ],
    },
  },

  uploadRetry: {
    branch: 'sync-uploads',
    plan: {
      task: 'Retry failed note uploads automatically without ever creating a duplicate note on the server.',
      label: 'Idempotent upload retry',
      touched_scope: ['src/upload/**'],
      steps: [
        {
          label: 'Idempotency key',
          text: 'Attach a client-generated idempotency key to every upload request',
          acceptance_criteria: [
            'Replaying the same upload request twice stores exactly one note on the server',
            'The idempotency key is generated once per note and persisted with the queue entry',
          ],
        },
        {
          label: 'Backoff schedule',
          text: 'Retry failed uploads with exponential backoff',
          acceptance_criteria: [
            'Retry delays double from one second up to a five minute ceiling, with random jitter',
            'An upload that fails with a 4xx response other than 429 is not retried',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Retrying uploads that the server rejected as invalid',
          rationale:
            "A malformed note will fail forever; it needs the inspector's attention, not another attempt",
        },
      ],
      decisions: [
        {
          decision: 'Make retries safe with a client-generated idempotency key per note',
          reason:
            'The client cannot tell a lost response from a lost request, so every retry must be harmless',
          alternatives_considered: [
            {
              option: 'Deduplicate on the server by hashing note content',
              rejected_because:
                'Two inspectors can legitimately file identical notes, and an edited retry would slip through',
            },
            {
              option: 'Send each note at most once and surface failures to the inspector',
              rejected_because: 'Inspectors would have to babysit uploads on flaky connections',
            },
          ],
        },
      ],
    },
    checkpoints: [
      {
        steps: ['Idempotency key', 'Backoff schedule'],
        summary: 'Uploads carry an idempotency key and retry on a persisted backoff schedule',
        files_changed: ['src/upload/retry.ts', 'src/upload/request.ts'],
        decisions: [
          {
            decision: 'Persist the retry attempt count so backoff resumes after an app restart',
            reason:
              'Restarting from one second after every relaunch would hammer the server during an outage',
          },
        ],
        uncertainty: [
          'Whether the server keeps idempotency keys for longer than 24 hours',
          'Whether jitter should be full or equal; the prototype used full jitter',
        ],
      },
    ],
    summary: {
      outcome: 'Failed uploads retry with backoff and never duplicate a note',
      deferred_decisions: [
        'What to do with a note that still fails after the maximum number of attempts',
      ],
      open_items: ['Ask the platform team how long idempotency keys are retained'],
    },
    amendedSummary: {
      outcome: 'Failed uploads retry with backoff and never duplicate a note',
      deferred_decisions: [
        'Notes that exhaust their retry budget need a dead-letter view; the design is deferred until support reports how often it happens',
      ],
      open_items: ['Ask the platform team how long idempotency keys are retained'],
    },
  },

  uploadRateLimit: {
    branch: 'sync-uploads',
    plan: {
      task: 'Throttle upload traffic from each device so a reconnecting fleet cannot overwhelm the sync service.',
      label: 'Client-side upload rate limit',
      touched_scope: ['src/upload/**', 'src/diagnostics/**'],
      steps: [
        {
          label: 'Rate limiter',
          text: 'Put a rate limiter in front of the upload queue',
          acceptance_criteria: [
            'The client sends at most 100 upload requests per minute per device',
            'A throttled upload shows a banner telling the inspector that sync is slowed',
            'A 429 response pauses the queue until the Retry-After interval has elapsed',
          ],
        },
        {
          label: 'Throttle diagnostics',
          text: 'Expose throttle counters to diagnostics',
          acceptance_criteria: [
            'The diagnostics screen shows how many uploads were delayed in the last hour',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Server-side quota enforcement',
          rationale:
            'The sync service team owns quotas; the client limit is a courtesy, not a security boundary',
        },
      ],
      decisions: [
        {
          decision: 'Limit uploads with a token bucket',
          reason:
            'Reconnecting devices legitimately burst, and a bucket allows a burst while holding the average',
          alternatives_considered: [
            {
              option: 'Fixed one-minute window counter',
              rejected_because:
                'Every device resets at the top of the minute, which synchronizes the fleet into a spike',
            },
            {
              option: 'No client limit; rely on 429 responses',
              rejected_because:
                'The service would already be overloaded by the time it answers 429',
            },
          ],
        },
      ],
    },
    revision: {
      label: 'Client-side upload rate limit',
      rationale:
        'A load test showed the sync service sheds requests well below the original ceiling, and the banner alarmed inspectors during normal operation',
      touched_scope: ['src/upload/**', 'src/diagnostics/**'],
      steps: [
        {
          label: 'Rate limiter',
          text: 'Put a rate limiter in front of the upload queue',
          acceptance_criteria: [
            {
              rewrites: 'The client sends at most 100 upload requests per minute per device',
              text: 'The client sends at most 20 upload requests per minute per device, with bursts of up to 40',
            },
            'A 429 response pauses the queue until the Retry-After interval has elapsed',
            'Limiter state survives an app restart',
          ],
        },
        {
          label: 'Throttle diagnostics',
          text: 'Expose throttle counters to diagnostics',
          acceptance_criteria: [
            'The diagnostics screen shows how many uploads were delayed in the last hour',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Server-side quota enforcement',
          rationale:
            'The sync service team owns quotas; the client limit is a courtesy, not a security boundary',
        },
      ],
      decisions: [
        {
          decision: 'Lower the sustained ceiling to 20 requests per minute and allow bursts of 40',
          reason: 'The load test put the safe fleet-wide rate at a fifth of the first estimate',
          alternatives_considered: [
            {
              option: 'Keep 100 per minute and ask the service team to scale up',
              rejected_because: 'Capacity work is not funded this quarter',
            },
          ],
        },
        {
          decision: 'Drop the throttling banner',
          reason:
            'Inspectors read the banner as an error; throttling is normal and is better left invisible',
        },
      ],
    },
    checkpoints: [
      {
        steps: ['Rate limiter'],
        summary: 'A token bucket limits uploads and honors Retry-After',
        files_changed: ['src/upload/limiter.ts'],
        decisions: [
          {
            decision: 'Store bucket state in the SQLite database rather than in memory',
            reason: 'A restart must not refill the bucket',
          },
        ],
        uncertainty: ['Whether retried requests should count against the rate limit'],
      },
    ],
  },

  conflictResolution: {
    branch: 'sync-uploads',
    plan: {
      task: 'Decide what happens when the same note is edited on two devices before either has synced.',
      label: 'Two-device edit conflicts',
      touched_scope: ['src/sync/conflicts/**'],
      steps: [
        {
          label: 'Conflict detection',
          text: 'Detect conflicting edits on upload',
          acceptance_criteria: [
            'The server rejects an upload whose base revision is older than the stored revision',
          ],
        },
        {
          label: 'Conflict resolution',
          text: 'Resolve conflicts without losing either edit',
          acceptance_criteria: [
            'Both versions of a conflicting note remain readable after resolution',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Automatic merging of note text',
          rationale:
            'Inspection notes are legal records; a machine-merged sentence that nobody wrote is unacceptable',
        },
      ],
      decisions: [
        {
          decision: 'Keep both versions and let the inspector choose',
          reason: 'Silent data loss is worse than an extra tap',
          alternatives_considered: [
            {
              option: 'Last writer wins by device clock',
              rejected_because:
                'Tablet clocks drift by minutes, so the wrong edit would silently win',
            },
            {
              option: 'Merge edits with a CRDT',
              rejected_because:
                'The library doubles the app size and nobody on the team can debug it',
            },
          ],
        },
      ],
    },
    checkpoints: [
      {
        steps: ['Conflict detection'],
        summary: 'Uploads carry a base revision and stale ones are rejected',
        files_changed: ['src/sync/conflicts/detect.ts'],
        decisions: [
          {
            decision: 'Use a per-note revision counter instead of timestamps to detect conflicts',
            reason: 'Counters are immune to clock drift',
          },
        ],
        uncertainty: [
          'Whether the server can compare revisions atomically under concurrent uploads',
        ],
      },
    ],
  },

  syncConsent: {
    branch: 'consent-gate',
    plan: {
      task: "Make sure no note leaves the device until the inspector's organization has consented to cloud sync.",
      label: 'Consent before upload',
      touched_scope: ['src/consent/**', 'src/upload/transport.ts'],
      steps: [
        {
          label: 'Consent gate',
          text: 'Record consent locally and gate the upload queue on it',
          acceptance_criteria: [
            'No network request carries note content before consent is recorded',
            'Consent is requested once per device',
            'Revoking consent stops queued uploads within one sync cycle',
          ],
        },
        {
          label: 'Consent prompt',
          text: 'Show the consent prompt during onboarding',
          acceptance_criteria: [
            'The prompt names the data that will be uploaded and where it is stored',
            'Declining consent signs the inspector out',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Consent for crash reporting and analytics',
          rationale: 'Those are covered by the device management agreement, not by this prompt',
        },
        {
          text: 'Per-note consent prompts',
          rationale: 'Asking on every note trains inspectors to tap through without reading',
        },
      ],
      decisions: [
        {
          decision: 'Gate uploads on an explicit, recorded consent decision',
          reason: 'Regulators treat inspection notes as personal data when they name a site owner',
          alternatives_considered: [
            {
              option: 'Treat acceptance of the terms of service as consent',
              rejected_because:
                'Bundled consent does not meet the explicit-consent bar the legal review set',
            },
            {
              option: 'Ask for consent on every note',
              rejected_because: 'Prompt fatigue makes the consent meaningless',
            },
          ],
        },
      ],
    },
    revision: {
      label: 'Consent before upload',
      rationale:
        'Legal review concluded that consent belongs to the account, and declining must not lock inspectors out of offline work',
      touched_scope: ['src/consent/**', 'src/upload/transport.ts'],
      steps: [
        {
          label: 'Consent gate',
          text: 'Record consent locally and gate the upload queue on it',
          acceptance_criteria: [
            'No network request carries note content before consent is recorded',
            {
              rewrites: 'Consent is requested once per device',
              text: 'Consent is requested once per account and applies to every device signed in to it',
            },
            'Revoking consent stops queued uploads within one sync cycle',
          ],
        },
        {
          label: 'Consent prompt',
          text: 'Show the consent prompt during onboarding',
          acceptance_criteria: [
            'The prompt names the data that will be uploaded and where it is stored',
            'Declining consent leaves the app fully usable offline',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Telemetry consent (crash reports and usage analytics)',
          rationale:
            'Telemetry is governed by the device management agreement and gets its own prompt if that ever changes',
        },
        {
          text: 'Per-note consent prompts',
          rationale: 'Asking on every note trains inspectors to tap through without reading',
        },
      ],
      decisions: [
        {
          decision: 'Store consent per account on the server and cache it on each device',
          reason:
            'An organization consents once; asking again on every new tablet contradicts the legal basis',
          alternatives_considered: [
            {
              option: 'Keep consent per device',
              rejected_because:
                'A replaced tablet would silently stop syncing until someone noticed the prompt',
            },
          ],
        },
      ],
    },
    checkpoints: [
      {
        steps: ['Consent gate'],
        summary: 'Uploads are refused until consent is recorded for the account',
        files_changed: ['src/consent/store.ts', 'src/upload/transport.ts'],
        decisions: [
          {
            decision: 'Enforce the gate in the transport layer, not in the queue',
            reason: 'Any future code path that talks to the server inherits the gate',
          },
        ],
        uncertainty: [
          'Whether cached consent may be trusted when the device has been offline for more than 30 days',
        ],
      },
      {
        steps: ['Consent prompt'],
        summary: 'Onboarding asks for consent and declining keeps the app usable',
        files_changed: ['src/consent/prompt.tsx'],
        decisions: [],
        uncertainty: ['Whether inspectors under 18 need a guardian to consent'],
      },
    ],
    summary: {
      outcome:
        'Uploads are blocked until account-level consent is recorded, and declining keeps the app usable offline',
      deferred_decisions: ['How often to ask again when the privacy policy text changes'],
      open_items: ['Translate the consent prompt into Spanish and French'],
    },
  },

  consentAudit: {
    branch: 'consent-gate',
    plan: {
      task: 'Keep a tamper-evident record of every consent decision so the organization can answer a regulator.',
      label: 'Consent audit trail',
      touched_scope: ['src/consent/audit/**'],
      steps: [
        {
          label: 'Audit log',
          text: 'Append consent changes to an audit log',
          acceptance_criteria: [
            'Every grant and revocation is recorded with the account, the time, and the policy version',
            'Audit entries cannot be edited or deleted from the app',
          ],
        },
      ],
      non_goals: [
        {
          text: 'A reporting screen for administrators',
          rationale: 'Exports are enough for the first audit; a screen waits for real demand',
        },
      ],
      decisions: [
        {
          decision: 'Record consent changes as append-only rows with a hash chain',
          reason: 'A regulator must be able to see that no entry was altered after the fact',
          alternatives_considered: [
            {
              option: 'Overwrite a single current-consent row',
              rejected_because: 'History is the whole point of an audit trail',
            },
            {
              option: 'Write audit entries to a log file',
              rejected_because: 'Log files rotate and are excluded from device backups',
            },
          ],
        },
      ],
    },
    checkpoints: [],
  },

  photoAttachments: {
    branch: 'main',
    plan: {
      task: 'Let inspectors attach photos to a note while offline.',
      label: 'Offline photo attachments',
      touched_scope: ['src/photos/**'],
      steps: [
        {
          label: 'Photo storage',
          text: 'Store attached photos on the device and link them to notes',
          acceptance_criteria: [
            'A photo attached offline is still linked to its note after a restart',
            'Deleting a note deletes its photo files',
          ],
        },
        {
          label: 'Photo upload',
          text: 'Upload photos after their note',
          acceptance_criteria: [
            'A photo uploads only after its note has been acknowledged by the server',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Video attachments',
          rationale: 'Video files are too large for the cellular plans inspectors use',
        },
        {
          text: 'Editing or annotating photos',
          rationale: "Inspectors already use the tablet's built-in markup tool",
        },
      ],
      decisions: [
        {
          decision: 'Store photo files on the filesystem and keep only their paths in SQLite',
          reason: 'Large blobs bloat the write-ahead log and slow every backup',
          alternatives_considered: [
            {
              option: 'Store photos as BLOB columns',
              rejected_because: 'A 12 MB photo inside a transaction stalls note saves behind it',
            },
          ],
        },
      ],
    },
    checkpoints: [
      {
        steps: ['Photo storage'],
        summary: 'Photos are saved beside the database and linked by path',
        files_changed: ['src/photos/store.ts'],
        decisions: [
          {
            decision: 'Downscale photos to 2048 pixels on the long edge before storing',
            reason: 'Full-resolution images fill a 32 GB tablet within a month of inspections',
          },
        ],
        uncertainty: ['Whether downscaled photos are acceptable as legal evidence'],
      },
      {
        steps: ['Photo upload'],
        summary: 'Photos upload after the note they belong to',
        files_changed: ['src/photos/upload.ts'],
        decisions: [],
        uncertainty: [],
      },
    ],
    summary: {
      outcome: 'Inspectors can attach photos offline and they upload after their note',
      deferred_decisions: [
        'Whether to delete local photo files once the server has confirmed the upload',
      ],
      open_items: ['Check with legal whether downscaled photos are admissible'],
    },
  },

  dataExport: {
    branch: 'main',
    plan: {
      task: 'Give inspectors a way to get their notes off the device without the sync service.',
      label: 'Export notes for backup',
      touched_scope: ['src/export/**'],
      steps: [
        {
          label: 'Archive export',
          text: 'Export all notes to a single archive file',
          acceptance_criteria: [
            'The archive contains every note and photo on the device',
            'An export can be restored on a factory-reset tablet',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Importing archives produced by other apps',
          rationale: 'There is no common format for inspection notes',
        },
      ],
      decisions: [
        {
          decision: 'Export as a zip of JSON files plus photos rather than a copy of the database',
          reason: "A readable archive outlives the app's schema",
          alternatives_considered: [
            {
              option: 'Copy the SQLite file',
              rejected_because:
                'Restoring an old database file would bypass migrations and other tools could not read it',
            },
          ],
        },
      ],
    },
    checkpoints: [
      {
        steps: ['Archive export'],
        summary: 'Notes and photos export to one archive that a clean tablet can restore',
        files_changed: ['src/export/archive.ts'],
        decisions: [],
        uncertainty: ['Whether exports need a password when they contain site owner names'],
      },
    ],
    summary: {
      outcome: 'Inspectors can export and restore every note without the sync service',
      deferred_decisions: ['Whether exports should be encrypted by default'],
      open_items: [],
    },
  },

  syncStatusIndicator: {
    branch: 'main',
    plan: {
      task: 'Show inspectors whether their notes have reached the server.',
      label: 'Sync status indicator',
      touched_scope: ['src/ui/sync-status/**'],
      steps: [
        {
          label: 'Sync badge',
          text: 'Add a per-note sync badge and a global status line',
          acceptance_criteria: [
            'Each note shows one of three states: saved on device, uploading, or synced',
            'The status line shows the time of the last successful sync',
          ],
        },
      ],
      non_goals: [
        {
          text: 'Push notifications about sync failures',
          rationale: 'Notifications on a shared work tablet are usually disabled by policy',
        },
      ],
      decisions: [
        {
          decision: 'Derive sync state from the upload queue instead of storing it on the note',
          reason: 'A second copy of the state would drift from the queue after a crash',
          alternatives_considered: [
            {
              option: 'Add a synced flag column to the notes table',
              rejected_because: 'Two writers would have to keep the flag and the queue consistent',
            },
          ],
        },
      ],
    },
    checkpoints: [
      {
        steps: ['Sync badge'],
        summary: 'Notes show a sync badge and the header shows the last sync time',
        files_changed: ['src/ui/sync-status/badge.tsx'],
        decisions: [
          {
            decision:
              'Do not show a banner when uploads are throttled; the badge stays on uploading',
            reason: 'The rate limit work found that throttling banners read as errors',
          },
        ],
        uncertainty: [
          'Whether color alone is enough to distinguish the three states for color-blind inspectors',
        ],
      },
    ],
    summary: {
      outcome: 'Every note shows whether it has reached the server',
      deferred_decisions: [],
      open_items: ['Accessibility review of the badge colors'],
    },
  },
} satisfies Record<string, StoryArtifact>;

export type CorpusArtifactKey = keyof typeof retrievalCorpusStory;
