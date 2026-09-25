#!/usr/bin/env node
// Drives one published @orcaops/cli release through an offline workflow in a disposable
// repository and leaves the project database that release wrote.
//
//   node packages/storage/tests/released-producer-database.generate.mjs <version> <output-dir>
//
// The JSON summary goes to stdout and progress to stderr. Identifiers and timestamps differ
// on every run, so a database frozen from one run is kept and never regenerated. No model and
// no cloud service is called: reviews, enrichment and transcripts are authored here as fixed,
// obviously synthetic text, which is what the released tool expects an agent to supply.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  createRunner,
  exactVersion,
  inspectDatabase,
  installProducer,
  prepareLayout,
  requireSupportedNode,
  retainedRefs,
  syntheticTranscriptLine,
  watchUserLocations,
} from './released-producer-support.mjs';

const AGENT = 'claude-code';
const SESSION_IDS = {
  repo: '5d0c1b1e-7a51-4c55-9d53-0f6d3c1a9e01',
  'repo-docs': '8b7e2f4a-3c19-4d6e-a2f5-6e9d0c4b7a02',
};
const UNKNOWN_STEP_ID = '01a00000-0000-7000-8000-000000000001';
const ROOT_COMMIT = {
  date: '2026-08-02T09:00:00Z',
  message: 'Start the charge service',
  files: { 'README.md': '# Charge service\n' },
};
// `--since` is explicit because the default seed window is relative to today and would drop
// this fixed history in time. `--path` keeps the root commit out: a seeded root commit records
// the empty tree as its base, and both releases then fail `lineage` on any other branch
// because they cannot decide whether that base is reachable.
const SEED_SELECTION = ['--path', 'src', '--since', '2026-08-01'];
const ROUNDING_CHOICE = 'Use Math.round instead of truncating because charges are billed whole';
const SEEDED_COMMITS = [
  {
    date: '2026-08-03T09:00:00Z',
    message: 'Add the charge route',
    files: { 'src/charge.js': 'export function charge(amount) {\n  return { amount };\n}\n' },
  },
  {
    date: '2026-08-04T09:00:00Z',
    message: 'Add request logging',
    files: { 'src/log.js': 'export function log(line) {\n  process.stdout.write(line);\n}\n' },
  },
  {
    date: '2026-08-05T09:00:00Z',
    // The body states a choice, which the seed preview nominates as a decision to enrich.
    message: ['Round the charged amount', `${ROUNDING_CHOICE}.`],
    files: {
      'src/charge.js':
        'export function charge(amount) {\n  return { amount: Math.round(amount) };\n}\n',
    },
  },
];
const SOURCE_PLAN = `# Rate limit plan

1. Add a sliding-window limiter.
2. Mount it on the charge route.
3. Cover the limit-exceeded path with tests.
4. Document the limit.
`;
const NON_GOALS = [
  {
    text: 'Do not change the auth middleware',
    rationale: 'Auth is separate work',
    source_refs: ['section 1'],
  },
];

function createWorkflow(layout, entry) {
  const runner = createRunner(layout, entry, SESSION_IDS);
  const transcripts = path.join(layout.home, '.claude', 'projects', 'synthetic-transcripts');
  mkdirSync(transcripts, { recursive: true });
  let transcriptLines = 0;

  // A capture stamps usage only when the session has a transcript. Each capture sees one more
  // synthetic line than the last, so successive snapshots differ.
  const capture = (worktree, verb, input, flags = ['--no-llm'], options = {}) => {
    transcriptLines += 1;
    appendFileSync(
      path.join(transcripts, `${SESSION_IDS[worktree]}.jsonl`),
      syntheticTranscriptLine(SESSION_IDS[worktree], transcriptLines)
    );
    return runner.orcaops(worktree, ['capture', ...verb, '--invoked-by-agent', AGENT, ...flags], {
      ...options,
      input,
    });
  };

  return { ...runner, capture };
}

function stepLabelled(plan, label) {
  const step = plan.plan_steps.find((candidate) => candidate.label === label);
  if (!step) throw new Error(`the plan has no step labelled "${label}"`);
  return step;
}

function criterion(step, text) {
  const match = step.acceptance_criteria.find((candidate) => candidate.text === text);
  if (!match) throw new Error(`step "${step.label}" has no criterion "${text}"`);
  return match;
}

function driveRateLimitTask({ git, commit, orcaops, capture }) {
  git('repo', ['checkout', '--quiet', '-b', 'rate-limit']);
  commit('repo', 'Add the rate limit plan', { 'docs/rate-limit-plan.md': SOURCE_PLAN });

  const plan = capture(
    'repo',
    ['plan'],
    {
      task: 'Add rate limiting to the charge route',
      label: 'Rate limit the charge route',
      plan_steps: [
        {
          text: 'Implement a sliding-window limiter module',
          label: 'Sliding-window limiter',
          acceptance_criteria: [
            { text: 'The limiter rejects a request once the window limit is reached' },
          ],
        },
        {
          text: 'Mount the limiter on the charge route',
          label: 'Mount on the charge route',
          acceptance_criteria: [
            { text: 'The charge route answers 429 when the limit is exceeded' },
          ],
        },
        {
          text: 'Add tests for the limit-exceeded path',
          label: 'Limit-exceeded tests',
          acceptance_criteria: [
            { text: 'A test asserts the 429 status' },
            { text: 'A test asserts the retry header' },
            { text: 'A test asserts the log line' },
          ],
        },
        { text: 'Document the limit in the README', label: 'Document the limit' },
      ],
      touched_scope: ['payments', 'docs'],
      non_goals: NON_GOALS,
      decisions: [
        {
          decision: 'Use a sliding window over a fixed window',
          reason: 'A fixed window allows a double burst at the boundary',
          alternatives_considered: [
            { option: 'In-memory token bucket', rejected_because: 'Not shared across instances' },
          ],
        },
      ],
    },
    ['--no-llm', '--source-plan', 'docs/rate-limit-plan.md']
  );
  if (plan.source_plan?.pinned !== true) throw new Error('the source plan was not pinned');
  const artifactId = plan.artifact_id;
  const limiter = stepLabelled(plan, 'Sliding-window limiter');
  const mount = stepLabelled(plan, 'Mount on the charge route');
  const tests = stepLabelled(plan, 'Limit-exceeded tests');
  const document = stepLabelled(plan, 'Document the limit');

  orcaops('repo', ['checkout', artifactId, '--json']);
  orcaops('repo', ['seed', 'status', '--offered', 'docs', '--json']);
  orcaops('repo', ['seed', 'status', '--decline', 'src', '--json']);

  // A refused capture leaves an attempt receipt, which no accepted capture writes.
  capture(
    'repo',
    ['checkpoint', 'open'],
    { artifact_id: artifactId, declared_step_ids: [UNKNOWN_STEP_ID] },
    ['--no-llm'],
    { tolerated: 'INVALID_INPUT', mustRefuse: true }
  );

  capture('repo', ['checkpoint', 'open'], {
    artifact_id: artifactId,
    declared_step_ids: [limiter.step_id],
    plan_revision_id: plan.plan_event_id,
  });
  commit('repo', 'Add the sliding-window limiter', {
    'src/limiter.js': 'export const limit = 10;\nexport const windowMs = 60000;\n',
  });
  capture('repo', ['checkpoint', 'close'], {
    artifact_id: artifactId,
    summary: 'Added the limiter module with its limit and window size.',
    files_changed: ['src/limiter.js'],
    completed_step_ids: [limiter.step_id],
    decisions: [
      {
        decision: 'Keep the window size as a module constant',
        reason: 'One route uses it today',
        alternatives_considered: [
          {
            option: 'Read it from the environment',
            rejected_because: 'No deployment needs a different value yet',
          },
        ],
      },
    ],
    uncertainty: ['Whether one window size fits every route'],
    done_criteria: [
      {
        criterion_id: limiter.acceptance_criteria[0].criterion_id,
        evidence: 'The limiter unit test rejects the eleventh request in a window.',
      },
    ],
    verification: [
      { command: 'node --test src/limiter.test.js', exit_code: 0, output_digest: '1 test passed' },
    ],
  });
  orcaops('repo', ['lineage', '--json']);

  // The status criterion omits its id and keeps its text, which the release reports as
  // carried; the retry criterion keeps its id with new text; the log criterion is left out.
  const revision = capture('repo', ['plan', 'revise'], {
    artifact_id: artifactId,
    label: 'Rate limit the charge route with headers',
    rationale:
      'The retry header needs exact wording, the log-line check moved to separate logging work, and clients need the remaining quota.',
    prior_plan_event_id: plan.plan_event_id,
    plan_steps: [
      limiter,
      mount,
      {
        step_id: tests.step_id,
        text: tests.text,
        label: tests.label,
        acceptance_criteria: [
          { text: 'A test asserts the 429 status' },
          {
            criterion_id: criterion(tests, 'A test asserts the retry header').criterion_id,
            text: 'A test asserts the Retry-After header carries the remaining window in seconds',
          },
        ],
      },
      {
        text: 'Expose the remaining quota in a response header',
        label: 'Remaining-quota header',
        acceptance_criteria: [{ text: 'Responses carry the remaining quota' }],
      },
      document,
    ].map(({ step_id, text, label, acceptance_criteria }) => ({
      ...(step_id ? { step_id } : {}),
      text,
      label,
      ...(acceptance_criteria?.length ? { acceptance_criteria } : {}),
    })),
    touched_scope: ['payments', 'docs'],
    non_goals: NON_GOALS,
    decisions: [
      {
        decision: 'Report the remaining quota in a header',
        reason: 'Clients need it to back off before they are rejected',
      },
    ],
  });
  const lineage = revision.criterion_lineage;
  if (!lineage.carried.length || !lineage.rewritten.length || !lineage.removed.length) {
    throw new Error(`criterion lineage is incomplete: ${JSON.stringify(lineage)}`);
  }
  const quota = stepLabelled(revision, 'Remaining-quota header');

  const abandoned = capture('repo', ['checkpoint', 'open'], {
    artifact_id: artifactId,
    declared_step_ids: [mount.step_id, tests.step_id, quota.step_id],
    plan_revision_id: revision.plan_event_id,
  });
  capture(
    'repo',
    ['checkpoint', 'abandon'],
    {
      artifact_id: artifactId,
      n: abandoned.n,
      reason: 'Declared most of the plan at once; reopening with one step.',
    },
    []
  );

  capture('repo', ['checkpoint', 'open'], {
    artifact_id: artifactId,
    declared_step_ids: [mount.step_id],
    plan_revision_id: revision.plan_event_id,
  });
  commit('repo', 'Mount the limiter on the charge route', {
    'src/charge.js':
      "import { limit } from './limiter.js';\n\nlet seen = 0;\n\nexport function charge(amount) {\n  seen += 1;\n  if (seen > limit) return { status: 429 };\n  return { amount: Math.round(amount) };\n}\n",
  });
  capture('repo', ['checkpoint', 'close'], {
    artifact_id: artifactId,
    summary: 'Mounted the limiter on the charge route; the retry header is not set yet.',
    files_changed: ['src/charge.js'],
    completed_step_ids: [mount.step_id],
    uncertainty: ['The request counter never resets, so the window is not enforced yet'],
    done_criteria: [
      {
        criterion_id: mount.acceptance_criteria[0].criterion_id,
        evidence: 'The route test receives status 429 on the eleventh request.',
      },
    ],
    verification: [
      {
        command: 'node --test src/charge.test.js',
        exit_code: 1,
        output_digest: '1 of 2 tests failed: retry header missing',
      },
    ],
  });

  orcaops('repo', [
    'eval',
    'run',
    '--ref',
    'core/plan-mentions-tests',
    '--artifact',
    artifactId,
    '--no-llm',
    '--json',
  ]);
  capture('repo', ['pre-pr-check'], { artifact_id: artifactId });

  const summary = capture(
    'repo',
    ['summary'],
    {
      artifact_id: artifactId,
      outcome: 'The charge route is rate limited; the header work is left open.',
      tests_written: ['src/charge.test.js'],
      tests_run: ['node --test src/charge.test.js'],
      open_items: ['Set the retry header'],
      deferred_decisions: ['Per-route window sizes (deferred: no second route yet)'],
    },
    []
  );
  capture(
    'repo',
    ['summary'],
    {
      artifact_id: artifactId,
      prior_summary_event_id: summary.summary_event_id,
      outcome:
        'The charge route is rate limited; the retry header and the remaining-quota header are left open.',
      tests_written: ['src/charge.test.js'],
      tests_run: ['node --test src/charge.test.js'],
      open_items: ['Set the retry header', 'Expose the remaining quota'],
      deferred_decisions: ['Per-route window sizes (deferred: no second route yet)'],
    },
    []
  );

  // Both releases refuse a Task Review floor for a branch whose artifact holds an abandoned
  // checkpoint. The refusal still retains the review and its membership, as it does for a user.
  orcaops('repo', ['review', 'routine-start', '--branch', 'rate-limit', '--json'], {
    tolerated: /checkpoint not closed in its exact member revision/,
    mustRefuse: true,
  });
}

function driveOperatorNotesTask({ git, commit, orcaops, capture }, layout) {
  git('repo', ['worktree', 'add', '--quiet', '-b', 'limit-docs', layout['repo-docs'], 'main']);

  // The scope is one the bundled evaluators do not exempt and no step names a test, so the
  // database holds a warning verdict and not only passes.
  const input = {
    task: 'Document the charge route limits for operators',
    label: 'Operator notes for charge limits',
    plan_steps: [
      {
        text: 'Write the operator notes for the charge limit',
        label: 'Operator notes',
        acceptance_criteria: [{ text: 'The notes state the limit and the window' }],
      },
      { text: 'Link the notes from the README', label: 'Link from the README' },
    ],
    touched_scope: ['operations'],
    non_goals: [
      { text: 'Do not change limiter behaviour', rationale: 'This task only documents it' },
    ],
  };
  const planArgs = ['capture', 'plan', '--invoked-by-agent', AGENT, '--no-llm'];
  // 0.2.0 refuses a linked worktree until init registers it; 0.2.1 registers one on first
  // use. Capturing first keeps each release on the path its own users take.
  let plan = orcaops('repo-docs', planArgs, { input, tolerated: 'IDENTITY_RECOVERY_REQUIRED' });
  if (plan.refused) {
    orcaops('repo-docs', ['init', '--yes', '--no-llm', '--force', '--json']);
    plan = orcaops('repo-docs', planArgs, { input });
  }
  const notes = stepLabelled(plan, 'Operator notes');
  const link = stepLabelled(plan, 'Link from the README');

  capture('repo-docs', ['checkpoint', 'open'], {
    artifact_id: plan.artifact_id,
    declared_step_ids: [notes.step_id],
  });
  commit('repo-docs', 'Add operator notes for the charge limit', {
    'docs/limits.md': '# Charge limits\n\nTen requests per sixty-second window.\n',
  });
  capture('repo-docs', ['checkpoint', 'close'], {
    artifact_id: plan.artifact_id,
    summary: 'Wrote the operator notes for the charge limit.',
    files_changed: ['docs/limits.md'],
    completed_step_ids: [notes.step_id],
    decisions: [
      {
        decision: 'State the limit in prose instead of generating it from the module',
        reason: 'The notes are read outside the repository',
      },
    ],
    uncertainty: ['The notes will drift if the limit changes'],
    done_criteria: [
      {
        criterion_id: notes.acceptance_criteria[0].criterion_id,
        evidence: 'docs/limits.md names ten requests and the sixty-second window.',
      },
    ],
    verification: [
      { command: 'grep -c sixty-second docs/limits.md', exit_code: 0, output_digest: '1' },
    ],
  });

  // A one-character rationale is the deterministic way to a block-severity violation: the
  // revision commits, the artifact is blocked, and the refusals and the dismissal follow.
  const blocked = capture('repo-docs', ['plan', 'revise'], {
    artifact_id: plan.artifact_id,
    label: input.label,
    rationale: 'x',
    prior_plan_event_id: plan.plan_event_id,
    plan_steps: plan.plan_steps.map(({ step_id, text, label, acceptance_criteria }) => ({
      step_id,
      text,
      label,
      ...(acceptance_criteria?.length ? { acceptance_criteria } : {}),
    })),
    touched_scope: input.touched_scope,
    non_goals: input.non_goals,
  });
  if (blocked.blocking !== true) throw new Error('the revision was expected to block');
  capture(
    'repo-docs',
    ['summary'],
    { artifact_id: plan.artifact_id, outcome: 'Summary attempted while a block is unresolved.' },
    [],
    { tolerated: 'BLOCKED', mustRefuse: true }
  );
  const block = ['--artifact', plan.artifact_id, '--evaluator', 'core/revision-rationale-required'];
  orcaops(
    'repo-docs',
    ['block', 'acknowledge', ...block, '--reason', 'Acknowledgement attempted', '--json'],
    { tolerated: 'BLOCK_NOT_ACKNOWLEDGEABLE', mustRefuse: true }
  );
  orcaops('repo-docs', [
    'block',
    'dismiss',
    ...block,
    '--reason',
    'The one-character rationale was deliberate',
    '--json',
  ]);

  // A review run started and never submitted: the pending state a reviewer leaves behind.
  orcaops('repo-docs', ['review', 'routine-start', '--branch', 'limit-docs', '--json']);

  // Left open so the database holds work in flight, as a project does when it is upgraded.
  // Captures come last on purpose: a review write truncates the write-ahead log, and the
  // frozen image should keep rows that exist only in the log, as a working project does.
  capture('repo-docs', ['checkpoint', 'open'], {
    artifact_id: plan.artifact_id,
    declared_step_ids: [link.step_id],
  });
}

// The preview writes one bundle per commit cluster with the payload it expects back. An agent
// would reword it; here the rewording is fixed text, and the one nominated decision is cited
// to its commit as the bundle's contract requires.
function authorEnrichment(bundleDirectory, select, reword) {
  let authored = 0;
  for (const name of readdirSyncSorted(bundleDirectory).filter((file) => file.endsWith('.md'))) {
    const bundle = readFileSync(path.join(bundleDirectory, name), 'utf8');
    const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(bundle)[1]);
    if (!select(payload)) continue;
    const nominations = [...bundle.matchAll(/^- \[([0-9a-f]{64})\] ([0-9a-f]{7,40}) — (.*)$/gm)];
    writeFileSync(
      path.join(bundleDirectory, name.replace(/\.md$/, '.json')),
      `${JSON.stringify(
        {
          ...payload,
          ...reword(payload),
          decisions: nominations.map(([, , sha, sentence]) => ({
            decision: 'Round charges with Math.round',
            reason: `Charges are billed whole (evidence: commit ${sha} — "${sentence.replace(/\.$/, '')}")`,
            alternatives_considered: [
              { option: 'truncating', rejected_because: 'charges are billed whole' },
            ],
          })),
          nomination_dispositions: nominations.map(([, id]) => ({
            nomination_id: id,
            disposition: 'decision',
          })),
        },
        null,
        2
      )}\n`
    );
    authored += 1;
  }
  if (authored !== 1) throw new Error(`authored ${authored} enrichment files, expected one`);
}

function readdirSyncSorted(directory) {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function seedHistory({ orcaops }) {
  const preview = orcaops('repo', ['seed', ...SEED_SELECTION, '--dry-run', '--json']);
  const bundles = preview.enrichment.bundle_directory;
  authorEnrichment(
    bundles,
    (payload) => payload.label === 'Round the charged amount',
    () => ({ outcome: 'Synthetic enrichment: charges are rounded to whole units.' })
  );
  const seeded = orcaops('repo', [
    'seed',
    ...SEED_SELECTION,
    '--yes',
    '--enrichment-dir',
    bundles,
    '--json',
    '--invoked-by-agent',
    AGENT,
  ]);
  if (seeded.totals.created !== SEEDED_COMMITS.length || seeded.enrichment.applied !== 1) {
    throw new Error(`seed imported ${JSON.stringify([seeded.totals, seeded.enrichment])}`);
  }

  // An artifact imported as a skeleton is enriched afterwards by an amendment event.
  const skeleton = preview.clusters.find((cluster) => cluster.label === 'Add request logging');
  const enrich = ['seed', 'enrich', '--artifact', skeleton.artifact_id];
  const amendment = orcaops('repo', [...enrich, '--dry-run', '--json']);
  authorEnrichment(
    amendment.bundle_directory,
    () => true,
    () => ({ outcome: 'Synthetic amendment: request logging writes one line per request.' })
  );
  const amended = orcaops('repo', [
    ...enrich,
    '--yes',
    '--enrichment-dir',
    amendment.bundle_directory,
    '--json',
  ]);
  if (amended.totals.amended !== 1) throw new Error('the enrichment amendment was not applied');
}

function firstMatch(text, pattern, what) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`the served review input names no ${what}`);
  return match[1];
}

// The released review engine calls no model: it serves each lane's input and stores what the
// reviewer submits. The submissions below are that reviewer's text, fixed and synthetic.
function driveRetryHeaderTask({ git, commit, orcaops, capture }, layout, configPath) {
  git('repo', ['checkout', '--quiet', '-b', 'retry-header', 'main']);
  const plan = capture('repo', ['plan'], {
    task: 'Send a Retry-After header when the charge route rejects a request',
    label: 'Retry-After header on rejection',
    plan_steps: [
      {
        text: 'Set the Retry-After header and add a test for it',
        label: 'Retry-After header',
        acceptance_criteria: [{ text: 'A rejected response carries Retry-After in seconds' }],
      },
    ],
    touched_scope: ['payments'],
    non_goals: [{ text: 'Do not change the limit', rationale: 'Only the header is in scope' }],
  });
  const [step] = plan.plan_steps;
  capture('repo', ['checkpoint', 'open'], {
    artifact_id: plan.artifact_id,
    declared_step_ids: [step.step_id],
  });
  commit('repo', 'Send Retry-After on rejection', {
    'src/charge.js':
      'export function charge(amount) {\n  if (amount > 1000) return { status: 429, headers: { "Retry-After": "60" } };\n  return { amount: Math.round(amount) };\n}\n',
  });
  capture('repo', ['checkpoint', 'close'], {
    artifact_id: plan.artifact_id,
    summary: 'Set the Retry-After header on rejected charges.',
    files_changed: ['src/charge.js'],
    completed_step_ids: [step.step_id],
    decisions: [
      { decision: 'Send a fixed sixty-second value', reason: 'The window is sixty seconds' },
    ],
    uncertainty: ['The header value is fixed at sixty seconds'],
    done_criteria: [
      {
        criterion_id: step.acceptance_criteria[0].criterion_id,
        evidence: 'The rejection test reads Retry-After: 60.',
      },
    ],
    verification: [
      { command: 'node --test src/charge.test.js', exit_code: 0, output_digest: '2 tests passed' },
    ],
  });
  capture(
    'repo',
    ['summary'],
    {
      artifact_id: plan.artifact_id,
      outcome: 'Rejected charges carry a Retry-After header.',
      tests_run: ['node --test src/charge.test.js'],
    },
    []
  );

  // An untracked file enters a review only through this opt-in, which is how its path
  // reaches the retained floor inputs.
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.review = { ...config.review, include_untracked: ['notes/review-notes.md'] };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(path.join(layout.repo, 'notes'));
  writeFileSync(
    path.join(layout.repo, 'notes', 'review-notes.md'),
    '# Synthetic review notes\n\nNot committed.\n'
  );

  const branch = ['--branch', 'retry-header'];
  orcaops('repo', [
    'review',
    'data',
    ...branch,
    '--base',
    git('repo', ['rev-parse', 'main']),
    '--json',
  ]);
  const started = orcaops('repo', ['review', 'routine-start', ...branch, '--json']);
  const submit = (lane, input) =>
    orcaops(
      'repo',
      [
        'review',
        'routine-submit',
        ...branch,
        '--run',
        started.run_id,
        '--lane',
        lane,
        '--isolation',
        'sequential',
        '--json',
      ],
      { input }
    );
  const finding = {
    claim:
      'The rejection compares the charged amount with a constant, so it depends on the amount and not on how many requests were made.',
    file: 'src/charge.js',
    related_files: [],
    confidence: 'HIGH',
  };
  // INFO is outside the routine contract, so the first submission spends the lane's repair.
  const rejected = submit('forensic', {
    findings: [{ ...finding, severity: 'INFO' }],
    questions: [],
  });
  if (rejected.accepted !== false) throw new Error('the INFO finding was expected to be rejected');
  const forensic = submit('forensic', {
    findings: [{ ...finding, severity: 'REVIEW' }],
    questions: [],
  });
  const account = readFileSync(path.join(layout.repo, forensic.account.payload_path), 'utf8');
  const checkpoint = firstMatch(account, /^#### (k\d+) /m, 'checkpoint alias');
  const citation = firstMatch(account, /decision \[(c\d+)\]/, 'decision citation');
  const story = submit('account', {
    schema_version: 1,
    overview: {
      text: 'The branch makes rejected charges tell the client when to retry.',
      citations: [citation],
    },
    acts: [
      {
        title: 'Tell rejected clients when to retry',
        parts: [
          {
            title: 'Send a fixed Retry-After value',
            checkpoints: [checkpoint],
            interpretation:
              'The checkpoint sets a sixty-second Retry-After header on rejection because the window is sixty seconds.',
            citations: [citation],
          },
        ],
      },
    ],
    questions: ['Should the header carry the remaining window instead of a fixed value?'],
  });
  if (story.outcome !== 'FULL') throw new Error(`the review ended ${story.outcome}`);

  const semantic = orcaops('repo', [
    'review',
    'run-show',
    ...branch,
    '--run',
    started.run_id,
    '--semantic-input',
    '--json',
  ]).semantic_anchor.payload_content;
  const [anchored, ...unanchored] = [...semantic.matchAll(/^### (i\d+)$/gm)].map(
    ([, item]) => item
  );
  orcaops(
    'repo',
    [
      'review',
      'semantic-anchor-submit',
      ...branch,
      '--run',
      started.run_id,
      '--profile',
      'semantic-anchor-profile-v1',
      '--json',
    ],
    {
      input: {
        schema_version: 3,
        dispositions: [
          {
            item: anchored,
            disposition: 'ANCHORED',
            targets: [
              {
                block: firstMatch(semantic, /change-block:(h\d+\.b\d+) /, 'change block'),
                scope: 'WHOLE_BLOCK',
              },
            ],
          },
          ...unanchored.map((item) => ({ item, disposition: 'ASSESSED_UNANCHORED', targets: [] })),
        ],
      },
    }
  );

  const anchor = orcaops('repo', [
    'review',
    'anchor',
    ...branch,
    '--file',
    'src/charge.js',
    '--side',
    'add',
    '--start',
    '2',
    '--json',
  ]);
  const comment = orcaops('repo', [
    'review',
    'comment',
    'add',
    ...branch,
    '--input',
    JSON.stringify({
      author: 'reviewer',
      body: 'Synthetic reviewer comment: should the threshold come from the limiter?',
      anchor: {
        kind: 'DIFF_LINE',
        file: anchor.file,
        side: anchor.side,
        line: anchor.startLine,
        lineHash: anchor.lineHashes[0],
        hunkKey: anchor.hunkKey,
      },
    }),
    '--json',
  ]).comments[0];
  const onComment = ['--id', comment.comment_id, ...branch];
  orcaops('repo', [
    'review',
    'comment',
    'reply',
    ...onComment,
    '--input',
    JSON.stringify({
      author: 'agent',
      body: 'Synthetic agent reply: the threshold stays local until the limiter is mounted.',
    }),
    '--json',
  ]);
  orcaops('repo', ['review', 'comment', 'resolve', ...onComment, '--author', 'reviewer', '--json']);
  orcaops('repo', ['review', 'comment', 'reopen', ...onComment, '--author', 'reviewer', '--json']);

  const floor = orcaops('repo', ['review', 'pane', ...branch, '--json']).floor.input_hash;
  const lifecycle = (action, extra) => {
    const ledger = orcaops('repo', ['review', 'journal', ...branch, '--json']).ledger_generation;
    orcaops('repo', [
      'review',
      'journal',
      ...branch,
      '--add',
      JSON.stringify({
        type: 'review_lifecycle',
        ts: new Date().toISOString(),
        action,
        review_basis: 'STORY',
        floor_input_hash: floor,
        story_generation: story.current_story.generation,
        ledger_generation: ledger,
        actor: 'REVIEWER',
        source: 'WATCH',
        ...extra,
      }),
      '--json',
    ]);
  };
  lifecycle('PARTIAL', { remaining_work: 'Synthetic note: the open comment needs an answer.' });
  lifecycle('REOPEN', {});
}

function driveWorkflow(layout, entry) {
  const workflow = createWorkflow(layout, entry);
  const { git, commit, orcaops } = workflow;

  mkdirSync(layout.repo);
  git('repo', ['init', '--quiet', '-b', 'main', '.']);
  git('repo', ['config', 'user.name', 'Fixture Author']);
  git('repo', ['config', 'user.email', 'author@example.invalid']);
  git('repo', ['config', 'commit.gpgsign', 'false']);
  // A reserved name that never resolves: the release sees a repository with a remote, as
  // most are, and nothing can be fetched from or pushed to it.
  git('repo', ['remote', 'add', 'origin', 'https://example.invalid/sample/charge-service.git']);
  for (const prior of [ROOT_COMMIT, ...SEEDED_COMMITS]) {
    commit('repo', prior.message, prior.files, prior.date);
  }

  const initialized = orcaops('repo', ['init', '--yes', '--no-llm', '--json']);
  orcaops('repo', ['eval', 'add-pack', '@orcaops/evaluator-pack', 'core', '--yes', '--json']);
  seedHistory(workflow);
  driveRateLimitTask(workflow);
  driveRetryHeaderTask(workflow, layout, initialized.config_path);
  driveOperatorNotesTask(workflow, layout);

  return {
    projectId: initialized.project_id,
    log: workflow.log,
    retainedRefs: retainedRefs(workflow, 'repo'),
  };
}

function main() {
  const [version, outputDirectory, ...rest] = process.argv.slice(2);
  if (!version || !outputDirectory || rest.length > 0) {
    throw new Error('usage: released-producer-database.generate.mjs <version> <output-dir>');
  }
  exactVersion(version);
  requireSupportedNode();

  const reportUserLocations = watchUserLocations();
  const layout = prepareLayout(path.resolve(outputDirectory), ['repo', 'repo-docs']);
  const producer = installProducer(version, layout);
  const { projectId, log, retainedRefs: refs } = driveWorkflow(layout, producer.entry);

  const databasePath = path.join(layout.data, 'projects', projectId, 'history.sqlite3');
  if (!existsSync(databasePath)) {
    throw new Error(`no database at ${databasePath}; the release wrote outside the data directory`);
  }
  const { database, driver } = inspectDatabase(producer.prefix, databasePath, layout.tmp);
  const userLocations = reportUserLocations();

  const summary = {
    producer: { ...producer.identity, sqlite_driver: driver },
    database,
    repository: { worktrees: [layout.repo, layout['repo-docs']], retained_refs: refs },
    workflow: log,
    isolation: { user_directories: userLocations },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (userLocations.some((entry) => entry.changed.length > 0)) {
    throw new Error('a real user location changed during the run; see isolation in the summary');
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[released-producer] FAILED: ${error.message}\n`);
  process.exitCode = 1;
}
