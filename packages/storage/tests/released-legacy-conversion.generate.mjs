#!/usr/bin/env node
// Writes a file-backed legacy history with one published @orcaops/cli release, then converts
// it with a later published release, and leaves the project database the conversion wrote.
//
//   node packages/storage/tests/released-legacy-conversion.generate.mjs \
//     <legacy-version> <converter-version> <output-dir>
//
// Conversion creates its own database, so this image is separate from the one
// released-producer-database.generate.mjs leaves. The legacy tables and the plan idempotency
// records have no other writer in a released build.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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
const SESSION_IDS = { repo: '3f2a9c1d-5b7e-4a60-8c1f-7d2e9b4a6c03' };
const UNKNOWN_STEP_ID = '01a00000-0000-7000-8000-000000000001';

function driveLegacyProducer(layout, entry) {
  const runner = createRunner(layout, entry, SESSION_IDS);
  const { git, commit, orcaops } = runner;
  const transcripts = path.join(layout.home, '.claude', 'projects', 'synthetic-transcripts');
  mkdirSync(transcripts, { recursive: true });
  let transcriptLines = 0;
  const capture = (verb, input, flags = ['--no-llm'], options = {}) => {
    transcriptLines += 1;
    appendFileSync(
      path.join(transcripts, `${SESSION_IDS.repo}.jsonl`),
      syntheticTranscriptLine(SESSION_IDS.repo, transcriptLines)
    );
    return orcaops('repo', ['capture', ...verb, '--invoked-by-agent', AGENT, ...flags], {
      ...options,
      input,
    });
  };

  mkdirSync(layout.repo);
  git('repo', ['init', '--quiet', '-b', 'main', '.']);
  git('repo', ['config', 'user.name', 'Fixture Author']);
  git('repo', ['config', 'user.email', 'author@example.invalid']);
  git('repo', ['config', 'commit.gpgsign', 'false']);
  git('repo', ['remote', 'add', 'origin', 'https://example.invalid/sample/notes-service.git']);
  commit(
    'repo',
    'Start the notes service',
    { 'README.md': '# Notes service\n' },
    '2026-08-02T09:00:00Z'
  );

  orcaops('repo', ['init', '--yes', '--no-llm', '--json']);
  git('repo', ['checkout', '--quiet', '-b', 'notes-export']);
  commit('repo', 'Add the export plan', {
    'docs/export-plan.md': '# Notes export plan\n\n1. Export notes as text.\n2. Document it.\n',
  });

  const plan = capture(
    ['plan'],
    {
      task: 'Export notes as plain text',
      label: 'Plain text notes export',
      plan_steps: [
        {
          text: 'Write the exporter and a test for it',
          label: 'Text exporter',
          acceptance_criteria: [{ text: 'The exporter writes one line per note' }],
        },
        { text: 'Document the export command', label: 'Document the export' },
      ],
      touched_scope: ['export'],
      non_goals: [{ text: 'Do not add other formats', rationale: 'Only plain text is in scope' }],
      decisions: [
        { decision: 'Write one note per line', reason: 'Line-oriented output is easy to diff' },
      ],
    },
    ['--no-llm', '--source-plan', 'docs/export-plan.md']
  );
  const [exporter, documentation] = plan.plan_steps;

  capture(
    ['checkpoint', 'open'],
    { artifact_id: plan.artifact_id, declared_step_ids: [UNKNOWN_STEP_ID] },
    ['--no-llm'],
    { tolerated: 'INVALID_INPUT', mustRefuse: true }
  );
  capture(['checkpoint', 'open'], {
    artifact_id: plan.artifact_id,
    declared_step_ids: [exporter.step_id],
  });
  commit('repo', 'Add the plain text exporter', {
    'src/export.js': 'export function exportNotes(notes) {\n  return notes.join("\\n");\n}\n',
  });
  capture(['checkpoint', 'close'], {
    artifact_id: plan.artifact_id,
    summary: 'Wrote the plain text exporter.',
    files_changed: ['src/export.js'],
    completed_step_ids: [exporter.step_id],
    decisions: [
      { decision: 'Join notes with newlines', reason: 'One note per line was the plan decision' },
    ],
    uncertainty: ['Notes containing newlines are not escaped'],
    done_criteria: [
      {
        criterion_id: exporter.acceptance_criteria[0].criterion_id,
        evidence: 'The exporter test reads two lines for two notes.',
      },
    ],
    verification: [
      { command: 'node --test src/export.test.js', exit_code: 0, output_digest: '1 test passed' },
    ],
  });

  const revision = capture(['plan', 'revise'], {
    artifact_id: plan.artifact_id,
    label: 'Plain text notes export with usage notes',
    rationale: 'The documentation step now names the usage notes it has to cover.',
    prior_plan_event_id: plan.plan_event_id,
    plan_steps: [
      {
        step_id: exporter.step_id,
        text: exporter.text,
        label: exporter.label,
        acceptance_criteria: exporter.acceptance_criteria,
      },
      {
        step_id: documentation.step_id,
        text: 'Document the export command and its usage notes',
        label: documentation.label,
      },
    ],
    touched_scope: ['export'],
    non_goals: [{ text: 'Do not add other formats', rationale: 'Only plain text is in scope' }],
  });
  const abandoned = capture(['checkpoint', 'open'], {
    artifact_id: plan.artifact_id,
    declared_step_ids: [documentation.step_id],
    plan_revision_id: revision.plan_event_id,
  });
  capture(
    ['checkpoint', 'abandon'],
    {
      artifact_id: plan.artifact_id,
      n: abandoned.n,
      reason: 'The documentation moves to a later task.',
    },
    []
  );
  capture(
    ['summary'],
    {
      artifact_id: plan.artifact_id,
      outcome: 'Notes export as plain text; the documentation step is left open.',
      tests_run: ['node --test src/export.test.js'],
      open_items: ['Document the export command'],
    },
    []
  );
  return runner;
}

function main() {
  const [legacyVersion, converterVersion, outputDirectory, ...rest] = process.argv.slice(2);
  if (!legacyVersion || !converterVersion || !outputDirectory || rest.length > 0) {
    throw new Error(
      'usage: released-legacy-conversion.generate.mjs <legacy-version> <converter-version> <output-dir>'
    );
  }
  exactVersion(legacyVersion);
  exactVersion(converterVersion);
  requireSupportedNode();

  const reportUserLocations = watchUserLocations();
  const layout = prepareLayout(path.resolve(outputDirectory), ['repo']);
  const legacy = installProducer(legacyVersion, layout, 'prefix-legacy');
  const converter = installProducer(converterVersion, layout, 'prefix');

  const runner = driveLegacyProducer(layout, legacy.entry);
  const convert = (args) =>
    runner.orcaops('repo', ['history', 'convert', ...args, '--json'], { entry: converter.entry });
  const preview = convert([]);
  if (preview.contentComplete !== true || preview.counts.issues !== 0) {
    throw new Error(`the conversion preview reported ${JSON.stringify(preview.counts)}`);
  }
  const applied = convert(['--apply', '--offline']);

  const databasePath = path.join(layout.data, 'projects', applied.projectId, 'history.sqlite3');
  if (applied.convertedDatabase !== databasePath || !existsSync(databasePath)) {
    throw new Error(`the conversion wrote ${applied.convertedDatabase}, not ${databasePath}`);
  }
  const { database, driver } = inspectDatabase(converter.prefix, databasePath, layout.tmp);
  const userLocations = reportUserLocations();

  const summary = {
    producer: { ...converter.identity, sqlite_driver: driver },
    legacy_producer: legacy.identity,
    conversion: {
      operation_id: applied.operationId,
      source_profile: applied.receipt.sourceProfile,
      source_revision: applied.receipt.sourceRevision,
      source_manifest_sha256: applied.receipt.sourceManifestHash,
      counts: applied.receipt.counts,
      omitted_families: applied.receipt.omissions.map((omission) => omission.family),
    },
    database,
    repository: { worktrees: [layout.repo], retained_refs: retainedRefs(runner, 'repo') },
    workflow: runner.log,
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
