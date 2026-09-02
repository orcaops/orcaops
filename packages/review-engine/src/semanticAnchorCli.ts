// `review semantic-anchor-submit` — explicit, stateful semantic association
// generation over an already finalized routine review. Orcaops never invokes a
// model: the caller reads prepared input v4, authors one v3 submission, and this
// verb validates + installs it (with at most one repair).

import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { slugifyBranch } from '@orcaops/review-core';
import { type ArtifactLock, atomicWriteFile } from '@orcaops/storage';

import {
  type AccountProjection,
  parseAccountProjectionJson,
  parseForensicInputJson,
} from './dossier.js';
import { reviewLock } from './reviewLock.js';
import { reviewDirPath, reviewEntryPath, reviewRootPath } from './reviewPaths.js';
import { reviewStateLockKey } from './reviewState.js';
import type { ReviewArgs } from './run.js';
import {
  normalizeSemanticAnchorSubmission,
  SEMANTIC_ANCHOR_ATTEMPT_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_CURRENT_FILE,
  SEMANTIC_ANCHOR_MANIFEST_FILE,
  SEMANTIC_ANCHOR_MANIFEST_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_MODEL_FILE,
  SEMANTIC_ANCHOR_MODEL_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_POINTER_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_SOURCE,
  SEMANTIC_ANCHOR_SUBMISSION_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_TARGET_SCHEMA_VERSION,
  type SemanticAnchorAttemptOutcome,
  semanticAnchorAttemptSchema,
  semanticAnchorCurrentPointerSchema,
  type SemanticAnchorManifest,
  semanticAnchorManifestSchema,
  type SemanticAnchorSourceHashes,
  type SemanticAnchorSubmissionCatalog,
  validateSemanticAnchorSubmission,
} from './semanticAnchorGenerations.js';
import {
  parseSemanticAnchorInputReceipt,
  prepareSemanticAnchorInput,
  SEMANTIC_ANCHOR_INPUT_FILE,
  SEMANTIC_ANCHOR_INPUT_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_PROFILE,
  SEMANTIC_ANCHOR_RECEIPT_FILE,
  type SemanticAnchorInputReceipt,
  type SemanticAnchorPreparation,
  semanticAnchorStoryCatalogIssue,
  UnsupportedSemanticAnchorInputVersionError,
} from './semanticAnchors.js';
import type { CoverageInput } from './storyOwnership.js';
import { parseStoryReviewModel, STORY_REVIEW_MODEL_FILE } from './storyReviewModel.js';
import { canonicalJsonSha256 } from './submissionNormalization.js';
import { readTwolaneRunFile, TWOLANE_RUN_FILE, type TwolaneRunFile } from './twolaneRunFile.js';

const RUN_FILE = TWOLANE_RUN_FILE;
const RUN_RECORD_FILE = 'run-record-v1.json';
const PROJECTION_FILE = 'account-projection-v1.json';
const COVERAGE_FILE = 'coverage-v1.json';
const FORENSIC_INPUT_FILE = 'forensic-input-v1.json';
const DIFF_FILE = 'diff.patch';
const ACCEPTED_ACCOUNT_FILE = 'accepted-account.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

interface PreparedRun {
  runDir: string;
  run: TwolaneRunFile;
  receipt: SemanticAnchorInputReceipt;
  receiptSha256: string;
  projection: AccountProjection;
  catalog: SemanticAnchorSubmissionCatalog;
  sourceHashes: SemanticAnchorSourceHashes;
}

const emit = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

function fail(args: ReviewArgs, message: string, code: number, errorCode?: string): number {
  if (args.json)
    emit({
      ok: false,
      error: {
        verb: 'review semantic-anchor-submit',
        ...(errorCode === undefined ? {} : { code: errorCode }),
        message,
      },
    });
  else process.stderr.write(`review semantic-anchor-submit: ${message}\n`);
  return code;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function locateRun(root: string, args: ReviewArgs): Promise<string> {
  if (args.runId === undefined || !UUID_RE.test(args.runId))
    throw new Error('--run must be a valid routine review UUID');
  if (args.branch !== undefined) {
    const explicit = reviewEntryPath(
      root,
      path.join(reviewDirPath(root, slugifyBranch(args.branch)), 'twolane', args.runId),
      'semantic anchor run directory'
    );
    if (!(await exists(path.join(explicit, RUN_FILE))))
      throw new Error(`run ${args.runId} is not present for branch ${args.branch}`);
    return explicit;
  }
  const reviewRoot = reviewRootPath(root);
  const candidates: string[] = [];
  for (const entry of await readdir(reviewRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const candidate = reviewEntryPath(
      root,
      path.join(reviewRoot, entry.name, 'twolane', args.runId),
      'semantic anchor run directory'
    );
    if (await exists(path.join(candidate, RUN_FILE))) candidates.push(candidate);
  }
  if (candidates.length === 0) throw new Error(`run ${args.runId} was not found`);
  if (candidates.length > 1)
    throw new Error(`run ${args.runId} is ambiguous across ${candidates.length} review branches`);
  return candidates[0]!;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type PreparedCatalogBlock = {
  alias?: unknown;
  blockKey?: unknown;
  lines?: unknown;
};

type PreparedCatalogLine = {
  ref?: unknown;
  side?: unknown;
  oldLine?: unknown;
  newLine?: unknown;
  lineHash?: unknown;
};

type PreparedCatalogHunk = {
  alias?: unknown;
  hunkKey?: unknown;
  oldFile?: unknown;
  newFile?: unknown;
  displayPath?: unknown;
  blocks?: unknown;
};

/**
 * Narrow adapter from prepared-input v4's richer rename-aware catalog to the
 * submission validator's intentionally small alias/identity/row surface.
 */
function submissionCatalog(prepared: SemanticAnchorPreparation): SemanticAnchorSubmissionCatalog {
  if (prepared.blockCatalog === null)
    throw new Error('READY prepared input has no deterministic change-block catalog');
  const catalog = prepared.blockCatalog as unknown as {
    hunks?: PreparedCatalogHunk[];
  };
  if (!Array.isArray(catalog.hunks))
    throw new Error('prepared change-block catalog has no hunk inventory');
  const blocks = catalog.hunks.flatMap((hunk, hunkIndex) => {
    if (!Array.isArray(hunk.blocks)) return [];
    return (hunk.blocks as PreparedCatalogBlock[]).map((block, blockIndex) => {
      const lines = Array.isArray(block.lines) ? (block.lines as PreparedCatalogLine[]) : [];
      const rows = (side: 'add' | 'delete') =>
        lines
          .filter((line) => line.side === side)
          .map((line) => ({
            ref: String(line.ref ?? ''),
            line: Number(side === 'add' ? line.newLine : line.oldLine),
            line_hash: String(line.lineHash ?? ''),
          }));
      return {
        alias: String(block.alias ?? ''),
        block_key: String(block.blockKey ?? ''),
        hunk_alias: String(hunk.alias ?? ''),
        hunk_key: String(hunk.hunkKey ?? ''),
        old_file: hunk.oldFile === null ? null : String(hunk.oldFile ?? ''),
        new_file: hunk.newFile === null ? null : String(hunk.newFile ?? ''),
        display_file: String(
          hunk.displayPath ??
            hunk.newFile ??
            hunk.oldFile ??
            `change block ${hunkIndex + 1}.${blockIndex + 1}`
        ),
        delete: rows('delete'),
        add: rows('add'),
      };
    });
  });
  return {
    items: prepared.items.map((item) => ({
      alias: item.alias,
      citation_id: item.id,
      citation_kind: item.kind,
    })),
    blocks,
  };
}

async function loadPreparedRun(runDir: string): Promise<PreparedRun> {
  const run = await readTwolaneRunFile(runDir);
  if (run.finalized === null) throw new Error('run is not terminally finalized');
  const record = JSON.parse(await readFile(path.join(runDir, RUN_RECORD_FILE), 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    record.run_id !== run.run_id ||
    record.outcome !== run.finalized.outcome ||
    record.finalized_at !== run.finalized.at ||
    !sameJson(record.input_shas, run.input_shas)
  )
    throw new Error(
      'run record does not match the terminal run identity, outcome, timestamp, or inputs'
    );

  const preparedRecord = record.semantic_anchor_input;
  if (preparedRecord === null || typeof preparedRecord !== 'object')
    throw new Error(
      'run has no semantic anchor preparation receipt; completed runs are not backfilled'
    );
  const { receipt_file: receiptFile, ...receiptFields } = preparedRecord as Record<string, unknown>;
  const receipt = parseSemanticAnchorInputReceipt(receiptFields);
  if (receipt.status !== 'READY' || receipt.payload_file !== SEMANTIC_ANCHOR_INPUT_FILE)
    throw new Error(
      `semantic anchor input is ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ''}`
    );
  if (receiptFile !== SEMANTIC_ANCHOR_RECEIPT_FILE)
    throw new Error('READY input has no canonical persisted receipt file');
  const receiptBytes = await readFile(path.join(runDir, receiptFile), 'utf8');
  const receiptOnDisk = parseSemanticAnchorInputReceipt(JSON.parse(receiptBytes));
  if (!sameJson(receipt, receiptOnDisk))
    throw new Error('prepared-input receipt does not match the finalized run record');

  const accountLineage = record.account_lineage as
    | {
        accepted_envelope_sha256?: unknown;
        compiled_payload_sha256?: unknown;
      }
    | null
    | undefined;
  if (
    accountLineage === null ||
    accountLineage === undefined ||
    typeof accountLineage.accepted_envelope_sha256 !== 'string' ||
    typeof accountLineage.compiled_payload_sha256 !== 'string'
  )
    throw new Error('finalized run has no accepted-account lineage');
  const acceptedAccount = JSON.parse(
    await readFile(path.join(runDir, ACCEPTED_ACCOUNT_FILE), 'utf8')
  ) as { compiled_payload?: unknown };
  if (
    canonicalJsonSha256(acceptedAccount) !== accountLineage.accepted_envelope_sha256 ||
    canonicalJsonSha256(acceptedAccount.compiled_payload) !== accountLineage.compiled_payload_sha256
  )
    throw new Error('accepted-account envelope does not match finalized lineage');

  const [
    storyBytes,
    projectionBytes,
    coverageBytes,
    pinnedDiffText,
    forensicInputBytes,
    payloadBytes,
  ] = await Promise.all([
    readFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), 'utf8'),
    readFile(path.join(runDir, PROJECTION_FILE), 'utf8'),
    readFile(path.join(runDir, COVERAGE_FILE), 'utf8'),
    readFile(path.join(runDir, DIFF_FILE), 'utf8'),
    readFile(path.join(runDir, FORENSIC_INPUT_FILE), 'utf8'),
    readFile(path.join(runDir, receipt.payload_file), 'utf8'),
  ]);
  const story = parseStoryReviewModel(JSON.parse(storyBytes));
  const projection = parseAccountProjectionJson(projectionBytes, `${runDir}/${PROJECTION_FILE}`);
  const coverage = JSON.parse(coverageBytes) as CoverageInput;
  const forensicInput = parseForensicInputJson(
    forensicInputBytes,
    `${runDir}/${FORENSIC_INPUT_FILE}`
  );
  const rerendered = prepareSemanticAnchorInput({
    runId: run.run_id,
    storyModel: story,
    storyModelBytes: storyBytes,
    accountProjection: projection,
    accountProjectionBytes: projectionBytes,
    coverage,
    coverageBytes,
    pinnedDiffText,
    forensicInput,
    forensicInputBytes,
    accountLineage: {
      acceptedEnvelopeSha256: accountLineage.accepted_envelope_sha256,
      compiledPayloadSha256: accountLineage.compiled_payload_sha256,
    },
  });
  if (
    rerendered.receipt.status !== 'READY' ||
    rerendered.receipt.payload_sha256 !== receipt.payload_sha256 ||
    !sameJson(rerendered.receipt.source_hashes, receipt.source_hashes) ||
    !sameJson(rerendered.receipt.derivation_hashes, receipt.derivation_hashes) ||
    !sameJson(rerendered.receipt.target_scope, receipt.target_scope)
  )
    throw new Error('prepared input is stale against its immutable source artifacts');
  const catalogIssue = semanticAnchorStoryCatalogIssue(story, rerendered.items);
  if (catalogIssue !== null) throw new Error(catalogIssue);
  if (
    Buffer.byteLength(payloadBytes) !== receipt.payload_bytes ||
    sha256(payloadBytes) !== receipt.payload_sha256
  )
    throw new Error('prepared payload bytes do not match the finalized receipt');
  const sourceHashes = receipt.source_hashes;
  if (
    sourceHashes.story_review_model_sha256 === null ||
    sourceHashes.account_projection_sha256 === null ||
    sourceHashes.coverage_sha256 === null ||
    sourceHashes.diff_sha256 === null ||
    sourceHashes.accepted_account_envelope_sha256 === null ||
    sourceHashes.compiled_account_payload_sha256 === null
  )
    throw new Error('READY receipt is missing one or more source hashes');
  return {
    runDir,
    run,
    receipt,
    receiptSha256: sha256(receiptBytes),
    projection,
    catalog: submissionCatalog(rerendered),
    sourceHashes: sourceHashes as SemanticAnchorSourceHashes,
  };
}

async function readSubmission(args: ReviewArgs, maximumBytes: number) {
  if (args.input === undefined) throw new Error('--input <file|-> is required');
  let rawText: string;
  if (args.input === '-') {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.length;
      if (bytes > maximumBytes)
        throw new Error(`submission exceeds the ${maximumBytes}-byte profile ceiling`);
      chunks.push(buffer);
    }
    rawText = Buffer.concat(chunks).toString('utf8');
  } else {
    rawText = await readFile(args.input, 'utf8');
    if (Buffer.byteLength(rawText) > maximumBytes)
      throw new Error(`submission exceeds the ${maximumBytes}-byte profile ceiling`);
  }
  return normalizeSemanticAnchorSubmission(rawText);
}

const anchorsDir = (runDir: string): string => path.join(runDir, 'anchors');
const generationDir = (runDir: string, generationId: string): string =>
  path.join(anchorsDir(runDir), 'generations', generationId);
const attemptFile = (dir: string, attempt: 1 | 2): string =>
  path.join(dir, `attempt-${attempt}-v3.json`);

async function readAttempt(file: string) {
  const raw = await readFile(file, 'utf8');
  return { attempt: semanticAnchorAttemptSchema.parse(JSON.parse(raw)), raw };
}

function manifestBytes(manifest: SemanticAnchorManifest): string {
  return `${JSON.stringify(semanticAnchorManifestSchema.parse(manifest), null, 2)}\n`;
}

async function withSemanticAnchorLocks<T>(
  lock: ArtifactLock,
  prepared: PreparedRun,
  fn: (current: PreparedRun, verifyLeases: () => Promise<void>) => Promise<T>
): Promise<T> {
  const branch = prepared.run.branch;
  const runId = prepared.run.run_id;
  return lock.withLock(reviewStateLockKey(slugifyBranch(branch)), async (stateLease) => {
    const current = await loadPreparedRun(prepared.runDir);
    if (
      current.run.branch !== branch ||
      current.run.run_id !== runId ||
      current.receiptSha256 !== prepared.receiptSha256
    ) {
      throw new Error('prepared run changed while waiting for review-state lock');
    }
    return lock.withLock(`semantic-anchor-${runId}`, (runLease) =>
      fn(current, async () => {
        await stateLease.verify();
        await runLease.verify();
      })
    );
  });
}

/** Execute the one-submit + one-repair semantic anchor lifecycle. */
export async function runSemanticAnchorSubmit(args: ReviewArgs, root: string): Promise<number> {
  const commandStartedMs = Date.now();
  if (args.help === true) {
    process.stdout.write(
      'usage: review semantic-anchor-submit --run <run-id> --profile semantic-anchor-profile-v1 --input <file|-> [--generation <generation-id>] [--json]\n'
    );
    return 0;
  }
  if (args.profile !== SEMANTIC_ANCHOR_PROFILE)
    return fail(args, `--profile must be ${SEMANTIC_ANCHOR_PROFILE}`, 2);
  let prepared: PreparedRun;
  let submission: Awaited<ReturnType<typeof readSubmission>>;
  try {
    const runDir = await locateRun(root, args);
    prepared = await loadPreparedRun(runDir);
    submission = await readSubmission(args, prepared.receipt.budget.maximum_submission_bytes);
  } catch (error) {
    return fail(
      args,
      error instanceof Error ? error.message : String(error),
      1,
      error instanceof UnsupportedSemanticAnchorInputVersionError ? error.code : undefined
    );
  }

  const lock = reviewLock(root);
  let response: Record<string, unknown> | null = null;
  let failure: string | null = null;
  try {
    await withSemanticAnchorLocks(lock, prepared, async (currentPrepared, verifyLeases) => {
      prepared = currentPrepared;
      const repairing = args.generationId !== undefined;
      const generationId = args.generationId ?? randomUUID();
      if (!UUID_RE.test(generationId)) {
        failure = '--generation must be a valid generation UUID';
        return;
      }
      const dir = reviewEntryPath(
        root,
        generationDir(prepared.runDir, generationId),
        'semantic anchor generation directory'
      );
      const terminalFile = path.join(dir, SEMANTIC_ANCHOR_MANIFEST_FILE);
      let attemptNumber: 1 | 2 = 1;
      let firstAttemptRaw: string | null = null;
      let lifecycleStartedAt = new Date(commandStartedMs).toISOString();
      if (repairing) {
        if (!(await exists(dir))) {
          failure = `generation ${generationId} does not exist`;
          return;
        }
        if (await exists(terminalFile)) {
          failure = `generation ${generationId} is already terminal`;
          return;
        }
        const first = await readAttempt(attemptFile(dir, 1)).catch(() => null);
        if (
          first === null ||
          first.attempt.run_id !== prepared.run.run_id ||
          first.attempt.generation_id !== generationId ||
          first.attempt.accepted ||
          first.attempt.declared_profile !== args.profile
        ) {
          failure = `generation ${generationId} has no valid rejected initial attempt`;
          return;
        }
        if (await exists(attemptFile(dir, 2))) {
          failure = `generation ${generationId} has exhausted its one repair`;
          return;
        }
        firstAttemptRaw = first.raw;
        lifecycleStartedAt = first.attempt.started_at;
        attemptNumber = 2;
      } else {
        if (await exists(dir)) {
          failure = `generation ${generationId} already exists`;
          return;
        }
        await mkdir(dir, { recursive: true });
      }

      const validation = validateSemanticAnchorSubmission({
        raw: submission.normalized,
        generationId,
        runId: prepared.run.run_id,
        floorInputHash: prepared.receipt.floor_input_hash!,
        preparedPayloadSha256: prepared.receipt.payload_sha256!,
        projection: prepared.projection,
        catalog: prepared.catalog,
      });
      const attemptCompletedMs = Date.now();
      const attemptStartedAt = new Date(commandStartedMs).toISOString();
      const submittedAt = new Date(attemptCompletedMs).toISOString();
      const attemptOutcome: SemanticAnchorAttemptOutcome = validation.accepted
        ? attemptNumber === 2
          ? 'ACCEPTED_REPAIRED'
          : submission.normalization === 'CLEAN_JSON'
            ? 'ACCEPTED_CLEAN_FIRST_PASS'
            : 'ACCEPTED_NORMALIZED_FIRST_PASS'
        : attemptNumber === 1
          ? 'REJECTED_FIRST_PASS'
          : 'TERMINAL_REJECTED';
      const attempt = semanticAnchorAttemptSchema.parse({
        schema_version: SEMANTIC_ANCHOR_ATTEMPT_SCHEMA_VERSION,
        generation_id: generationId,
        run_id: prepared.run.run_id,
        attempt: attemptNumber,
        started_at: attemptStartedAt,
        submitted_at: submittedAt,
        elapsed_ms: attemptCompletedMs - commandStartedMs,
        runtime_identity: args.runtimeIdentity ?? null,
        declared_profile: SEMANTIC_ANCHOR_PROFILE,
        profile_source: 'CALLER_DECLARED',
        normalization: submission.normalization,
        raw_submission_sha256: submission.raw_sha256,
        normalized_submission_sha256: submission.normalized_sha256,
        normalized_submission: submission.canonical,
        accepted: validation.accepted,
        outcome: attemptOutcome,
        has_focus_warnings: validation.warnings.some((warning) =>
          warning.code.startsWith('FOCUS_')
        ),
        diagnostics: validation.diagnostics,
        warnings: validation.warnings,
      });
      const attemptBytes = `${JSON.stringify(attempt, null, 2)}\n`;
      await verifyLeases();
      await atomicWriteFile(attemptFile(dir, attemptNumber), attemptBytes, root);

      if (!validation.accepted && attemptNumber === 1) {
        response = {
          ok: true,
          accepted: false,
          run_id: prepared.run.run_id,
          generation_id: generationId,
          status: 'PENDING',
          repair_remaining: 1,
          normalization: submission.normalization,
          outcome: attemptOutcome,
          attempt_elapsed_ms: attempt.elapsed_ms,
          diagnostics: validation.diagnostics,
          warnings: [],
        };
        return;
      }

      let modelSha: string | null = null;
      if (validation.accepted) {
        const modelBytes = `${JSON.stringify(validation.model, null, 2)}\n`;
        modelSha = sha256(modelBytes);
        await verifyLeases();
        await atomicWriteFile(path.join(dir, SEMANTIC_ANCHOR_MODEL_FILE), modelBytes, root);
      }
      const attemptShas = [
        ...(firstAttemptRaw === null ? [] : [sha256(firstAttemptRaw)]),
        sha256(attemptBytes),
      ];
      const manifest: SemanticAnchorManifest = {
        ...(() => {
          const createdAt = new Date().toISOString();
          return {
            created_at: createdAt,
            lifecycle_started_at: lifecycleStartedAt,
            lifecycle_elapsed_ms: Date.parse(createdAt) - Date.parse(lifecycleStartedAt),
          };
        })(),
        schema_version: SEMANTIC_ANCHOR_MANIFEST_SCHEMA_VERSION,
        generation_id: generationId,
        run_id: prepared.run.run_id,
        status: validation.accepted ? 'VALID' : 'REJECTED',
        runtime_identity: args.runtimeIdentity ?? null,
        attempt_count: attemptNumber,
        declared_profile: SEMANTIC_ANCHOR_PROFILE,
        profile_source: 'CALLER_DECLARED',
        source: SEMANTIC_ANCHOR_SOURCE,
        prepared_input_schema_version: SEMANTIC_ANCHOR_INPUT_SCHEMA_VERSION,
        submission_schema_version: SEMANTIC_ANCHOR_SUBMISSION_SCHEMA_VERSION,
        attempt_schema_version: SEMANTIC_ANCHOR_ATTEMPT_SCHEMA_VERSION,
        target_schema_version: SEMANTIC_ANCHOR_TARGET_SCHEMA_VERSION,
        model_schema_version: SEMANTIC_ANCHOR_MODEL_SCHEMA_VERSION,
        model_file: SEMANTIC_ANCHOR_MODEL_FILE,
        source_hashes: prepared.sourceHashes,
        prepared_receipt_sha256: prepared.receiptSha256,
        prepared_payload_sha256: prepared.receipt.payload_sha256!,
        attempt_sha256s: attemptShas,
        accepted_attempt_sha256: validation.accepted ? sha256(attemptBytes) : null,
        model_sha256: modelSha,
        diagnostic_codes: validation.diagnostics.map((diagnostic) => diagnostic.code),
        warning_codes: validation.warnings.map((warning) => warning.code),
        final_attempt_outcome: attemptOutcome,
      };
      const terminalBytes = manifestBytes(manifest);
      await verifyLeases();
      await atomicWriteFile(terminalFile, terminalBytes, root);

      if (validation.accepted) {
        const pointer = semanticAnchorCurrentPointerSchema.parse({
          schema_version: SEMANTIC_ANCHOR_POINTER_SCHEMA_VERSION,
          run_id: prepared.run.run_id,
          generation_id: generationId,
          manifest_file: SEMANTIC_ANCHOR_MANIFEST_FILE,
          manifest_sha256: sha256(terminalBytes),
        });
        const currentDir = reviewEntryPath(
          root,
          anchorsDir(prepared.runDir),
          'semantic anchor directory'
        );
        await mkdir(currentDir, { recursive: true });
        await verifyLeases();
        await atomicWriteFile(
          path.join(currentDir, SEMANTIC_ANCHOR_CURRENT_FILE),
          `${JSON.stringify(pointer, null, 2)}\n`,
          root
        );
      }
      response = {
        ok: true,
        accepted: validation.accepted,
        run_id: prepared.run.run_id,
        generation_id: generationId,
        status: validation.accepted ? 'CURRENT' : 'REJECTED',
        repair_remaining: 0,
        normalization: submission.normalization,
        outcome: attemptOutcome,
        attempt_elapsed_ms: attempt.elapsed_ms,
        generation_elapsed_ms: manifest.lifecycle_elapsed_ms,
        diagnostics: validation.diagnostics,
        warnings: validation.warnings,
        ...(validation.accepted
          ? {
              disposition_counts: {
                ANCHORED: validation.model.items.filter((item) => item.disposition === 'ANCHORED')
                  .length,
                ASSESSED_UNANCHORED: validation.model.items.filter(
                  (item) => item.disposition === 'ASSESSED_UNANCHORED'
                ).length,
                NO_ANCHOR_PROPOSED: validation.model.items.filter(
                  (item) => item.disposition === 'NO_ANCHOR_PROPOSED'
                ).length,
              },
            }
          : {}),
        ...(validation.accepted
          ? {
              model_path: path.relative(root, path.join(dir, SEMANTIC_ANCHOR_MODEL_FILE)),
              manifest_path: path.relative(root, terminalFile),
              current_path: path.relative(
                root,
                path.join(anchorsDir(prepared.runDir), SEMANTIC_ANCHOR_CURRENT_FILE)
              ),
            }
          : {}),
      };
    });
  } catch (error) {
    return fail(args, error instanceof Error ? error.message : String(error), 1);
  }
  if (failure !== null) return fail(args, failure, 1);
  const completedResponse = response as Record<string, unknown> | null;
  if (completedResponse === null)
    return fail(args, 'semantic anchor submission did not complete', 1);
  if (args.json) emit(completedResponse);
  else
    process.stdout.write(
      `semantic anchors ${String(completedResponse.status).toLowerCase()} for generation ${String(completedResponse.generation_id)}\n`
    );
  return 0;
}
