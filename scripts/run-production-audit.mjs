#!/usr/bin/env node
// Production advisory audit with repository-owned exception handling.
//
// Runs ONE unfiltered `pnpm audit --prod --json`. No `--audit-level`: the
// wrapper needs the complete raw advisory set so it can apply its own severity
// handling and fail closed on a severity it does not understand. No
// `pnpm install` either — the audit reads the lockfile and registry advisory
// data, so nothing here executes dependency lifecycle scripts or imports
// dependency code.
//
// Exceptions are applied HERE, never by pnpm. In pnpm 10.18.2 a configured
// `ignoreGhsas` is stripped from the JSON `advisories` map while the process
// exit code and `metadata` keep pre-filter totals, so the report and the signal
// disagree. We therefore take the raw report and never trust the exit code
// alone. See https://github.com/pnpm/pnpm/blob/v10.18.2/lockfile/plugin-commands-audit/src/audit.ts
//
// Security state and exception state are deliberately independent: a policy
// bookkeeping problem must never suppress a live security signal, and a dead
// exception must never masquerade as a vulnerability.

import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Only Node built-ins and this dependency-free module: the CI audit job runs
// with no `pnpm install`, so any third-party import would crash the runner
// instead of producing a result.
import {
  GHSA_PATTERN,
  SUPPORTED_SCHEMA_VERSION,
  isNonEmptyString,
  isPlainObject,
  isRealIsoDate,
} from './dependency-policy-schema.mjs';

// Ascending severity — the order the summary renders in. `info` is included
// because pnpm's own `metadata.vulnerabilities` carries an info bucket, so it
// is a severity pnpm can actually report. Treating it as unsupported would make
// a real, reportable finding read as "no vulnerability baseline was
// established", which is false. A severity outside this list is still
// genuinely unknown and still fails closed as `unsupported-severity`.
export const SUPPORTED_SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
export const MAX_ATTEMPTS = 3;
const RETRYABLE_REASONS = ['command-failure', 'invalid-json'];
const POLICY_FILE = 'config/dependency-policy.json';

/** UTC calendar day, so expiry does not shift with the runner's timezone. */
export function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Raw audit report
// ---------------------------------------------------------------------------

/**
 * Turn one command result into either a validated advisory list or a fixed
 * unavailable reason. The process exit code is NOT consulted: pnpm exits
 * non-zero whenever it finds advisories, which is a successful audit.
 */
export function interpretAuditOutput({ stdout, spawnError }) {
  if (spawnError) return { reason: 'command-failure' };
  if (!isNonEmptyString(stdout)) return { reason: 'command-failure' };

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { reason: 'invalid-json' };
  }

  if (
    !isPlainObject(report) ||
    !isPlainObject(report.advisories) ||
    !isPlainObject(report.metadata)
  ) {
    return { reason: 'schema-mismatch' };
  }

  const advisories = [];
  for (const entry of Object.values(report.advisories)) {
    if (!isPlainObject(entry)) return { reason: 'schema-mismatch' };
    const ghsa = entry.github_advisory_id;
    // Without a GHSA id an advisory cannot be indexed, so it can never be
    // matched to an exception — treat the whole report as untrustworthy.
    if (!isNonEmptyString(ghsa) || !GHSA_PATTERN.test(ghsa)) return { reason: 'schema-mismatch' };
    if (!isNonEmptyString(entry.severity)) return { reason: 'schema-mismatch' };
    if (!SUPPORTED_SEVERITIES.includes(entry.severity)) return { reason: 'unsupported-severity' };
    advisories.push({ ghsa, severity: entry.severity });
  }
  return { advisories };
}

/** Runs the audit, retrying only outcomes that produced no parseable report. */
export async function collectAuditReport({ runAudit, sleep }) {
  let attempts = 0;
  let last;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    last = interpretAuditOutput(await runAudit(attempts));
    if (!last.reason) return { ...last, attempts };
    // schema-mismatch and unsupported-severity are deterministic for this pnpm
    // response — retrying only burns the budget on an answer that cannot change.
    if (!RETRYABLE_REASONS.includes(last.reason)) return { ...last, attempts };
    if (attempts < MAX_ATTEMPTS) await sleep(attempts);
  }
  return { ...last, attempts };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Reads only what the runner needs: the advisory exceptions. Structural checks
 * on the rest of the policy are the lint job's job. Returns `valid: false`
 * rather than throwing so the registry audit can still run.
 */
export function loadExceptions(rootDir) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(path.join(rootDir, POLICY_FILE), 'utf8'));
  } catch {
    return { valid: false, exceptions: [] };
  }
  if (!isPlainObject(policy) || policy.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { valid: false, exceptions: [] };
  }
  if (!Array.isArray(policy.advisoryExceptions)) return { valid: false, exceptions: [] };

  const exceptions = [];
  const seen = new Set();
  for (const entry of policy.advisoryExceptions) {
    if (!isPlainObject(entry)) return { valid: false, exceptions: [] };
    const { ghsa, expiresOn } = entry;
    if (!isNonEmptyString(ghsa) || !GHSA_PATTERN.test(ghsa))
      return { valid: false, exceptions: [] };
    if (seen.has(ghsa)) return { valid: false, exceptions: [] };
    if (!isNonEmptyString(expiresOn) || !isRealIsoDate(expiresOn))
      return { valid: false, exceptions: [] };
    if (!isNonEmptyString(entry.owner) || !isNonEmptyString(entry.rationale)) {
      return { valid: false, exceptions: [] };
    }
    // Evidence is required here as well as in the lint checker, and on exactly
    // the same terms: a nonempty array in which EVERY entry is a nonempty
    // string. `some` would accept ["valid", 42], which the checker rejects —
    // and any shape the checker rejects but this accepts is a shape that
    // suppresses an advisory without surviving review. (`[].every()` is true,
    // hence the explicit length check.)
    if (
      !Array.isArray(entry.evidence) ||
      entry.evidence.length === 0 ||
      !entry.evidence.every(isNonEmptyString)
    ) {
      return { valid: false, exceptions: [] };
    }
    seen.add(ghsa);
    exceptions.push({ ghsa, expiresOn });
  }
  return { valid: true, exceptions };
}

/**
 * An exception is expired once today is ON or after `expiresOn`, compared as
 * UTC calendar dates — both are `YYYY-MM-DD`, so string order is date order.
 */
export function classifyExceptions({ exceptions, advisoryGhsas, today }) {
  const active = [];
  const unmatched = [];
  const expiredLive = [];
  const expiredStale = [];

  for (const { ghsa, expiresOn } of exceptions) {
    const expired = today >= expiresOn;
    const present = advisoryGhsas.has(ghsa);
    if (!expired && present) active.push(ghsa);
    else if (!expired) unmatched.push(ghsa);
    else if (present) expiredLive.push(ghsa);
    else expiredStale.push(ghsa);
  }
  return { active, unmatched, expiredLive, expiredStale };
}

export function deriveExceptionState({
  policyValid,
  active,
  unmatched,
  expiredLive,
  expiredStale,
}) {
  if (!policyValid) return 'invalid';
  const present = [
    ['active', active],
    ['unmatched', unmatched],
    ['expired-live', expiredLive],
    ['expired-stale', expiredStale],
  ].filter(([, list]) => list.length > 0);

  if (present.length === 0) return 'none';
  if (present.length === 1) return present[0][0];
  return 'mixed';
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

/**
 * Built only from validated counts, GHSA ids that matched GHSA_PATTERN, and
 * fixed strings. Registry-supplied text (titles, URLs, module names) never
 * reaches here — this string ends up in GitHub issue bodies.
 */
function buildSummary({
  securityState,
  unavailableReason,
  attempts,
  counts,
  exceptionState,
  groups,
}) {
  const parts = [];
  if (securityState === 'unavailable') {
    parts.push(
      `Production audit unavailable after ${attempts} attempt(s): ${unavailableReason}. No vulnerability baseline was established.`
    );
  } else if (securityState === 'advisories') {
    const breakdown = SUPPORTED_SEVERITIES.filter((s) => counts[s] > 0)
      .map((s) => `${s} ${counts[s]}`)
      .join(', ');
    const total = SUPPORTED_SEVERITIES.reduce((n, s) => n + counts[s], 0);
    parts.push(`${total} actionable production advisory/advisories (${breakdown}).`);
  } else {
    parts.push('No actionable production advisories.');
  }

  if (exceptionState === 'invalid') {
    parts.push('Exception policy could not be read, so every advisory is counted as unexcepted.');
  } else {
    if (groups.active.length > 0)
      parts.push(`${groups.active.length} active exception(s): ${groups.active.join(', ')}.`);
    if (groups.unmatched.length > 0) {
      parts.push(
        `${groups.unmatched.length} unexpired exception(s) match no advisory and are not counted as active: ${groups.unmatched.join(', ')}.`
      );
    }
    if (groups.expiredLive.length > 0) {
      parts.push(
        `${groups.expiredLive.length} expired exception(s) still live and now actionable: ${groups.expiredLive.join(', ')}.`
      );
    }
    if (groups.expiredStale.length > 0) {
      parts.push(
        `${groups.expiredStale.length} expired exception(s) with no matching advisory, safe to remove: ${groups.expiredStale.join(', ')}.`
      );
    }
  }
  return parts.join(' ');
}

/**
 * Exit precedence: unavailable audit (2) outranks actionable advisories (1),
 * which outrank invalid policy (3), which outranks strict stale enforcement
 * (4). A confirmed vulnerability always beats policy bookkeeping, and every
 * coexisting condition still lands in the result file.
 */
export function exitCodeFor({
  securityState,
  exceptionState,
  expiredStale,
  failOnStaleExceptions,
}) {
  if (securityState === 'unavailable') return 2;
  if (securityState === 'advisories') return 1;
  if (exceptionState === 'invalid') return 3;
  if (failOnStaleExceptions && expiredStale.length > 0) return 4;
  return 0;
}

export async function runProductionAudit({
  rootDir,
  runAudit,
  now = new Date(),
  failOnStaleExceptions = false,
  sleep = defaultSleep,
}) {
  const { valid: policyValid, exceptions } = loadExceptions(rootDir);
  // The registry audit runs regardless of policy health — a bookkeeping
  // problem must not suppress the current security signal.
  const report = await collectAuditReport({ runAudit, sleep });
  const unavailable = Boolean(report.reason);

  const advisories = report.advisories ?? [];
  const advisoryGhsas = new Set(advisories.map((a) => a.ghsa));

  // With an untrusted policy there are no exceptions to apply, so every raw
  // advisory is actionable.
  const groups = policyValid
    ? classifyExceptions({ exceptions, advisoryGhsas, today: utcToday(now) })
    : { active: [], unmatched: [], expiredLive: [], expiredStale: [] };

  const activeSet = new Set(groups.active);
  const actionable = advisories.filter((a) => !activeSet.has(a.ghsa));

  // Counts come from the actionable RAW advisories, never metadata.vulnerabilities
  // or the exit code, both of which carry pre-filter totals.
  const counts = Object.fromEntries(SUPPORTED_SEVERITIES.map((s) => [s, 0]));
  for (const a of actionable) counts[a.severity] += 1;

  const securityState = unavailable
    ? 'unavailable'
    : actionable.length > 0
      ? 'advisories'
      : 'clean';
  const exceptionState = deriveExceptionState({ policyValid, ...groups });

  const result = {
    securityState,
    exceptionState,
    unavailableReason: unavailable ? report.reason : null,
    counts,
    attempts: report.attempts,
    activeGhsas: groups.active,
    unmatchedGhsas: groups.unmatched,
    expiredLiveGhsas: groups.expiredLive,
    expiredStaleGhsas: groups.expiredStale,
    summary: '',
  };
  result.summary = buildSummary({
    securityState,
    unavailableReason: result.unavailableReason,
    attempts: report.attempts,
    counts,
    exceptionState,
    groups,
  });

  const exitCode = exitCodeFor({
    securityState,
    exceptionState,
    expiredStale: groups.expiredStale,
    failOnStaleExceptions,
  });
  return { result, exitCode };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const defaultSleep = (attempt) => new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 5000)));

/** Never passes --audit-level or --ignore-registry-errors. */
function spawnPnpmAudit(rootDir) {
  return () =>
    new Promise((resolve) => {
      const child = spawn('pnpm', ['audit', '--prod', '--json'], {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', () => {});
      child.on('error', (spawnError) => resolve({ stdout: '', spawnError }));
      child.on('close', () => resolve({ stdout }));
    });
}

/**
 * Markdown for $GITHUB_STEP_SUMMARY. Every value here already survived
 * sanitization on the way into `result`, so nothing registry-supplied leaks
 * into the rendered job summary.
 */
export function githubStepSummary(result) {
  const lines = [
    '### Production dependency audit',
    '',
    `- security state: \`${result.securityState}\``,
    `- exception state: \`${result.exceptionState}\``,
  ];
  if (result.unavailableReason) lines.push(`- unavailable reason: \`${result.unavailableReason}\``);
  if (result.attempts > 1) lines.push(`- attempts: ${result.attempts}`);

  // Unmatched and expired-stale do not fail a dependency-input PR, so the
  // summary is the only place they surface there.
  for (const [label, ghsas] of [
    [
      'Unmatched exceptions (no advisory found — possible typo or already remediated)',
      result.unmatchedGhsas,
    ],
    ['Expired exceptions with no matching advisory (remove or renew)', result.expiredStaleGhsas],
    ['Expired exceptions still live (now actionable)', result.expiredLiveGhsas],
    ['Active exceptions', result.activeGhsas],
  ]) {
    if (ghsas.length === 0) continue;
    lines.push('', `> [!WARNING]`, `> **${label}:** ${ghsas.join(', ')}`);
  }
  lines.push('', result.summary, '');
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = { failOnStaleExceptions: false, resultFile: null, githubSummary: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--fail-on-stale-exceptions') {
      options.failOnStaleExceptions = true;
    } else if (argv[i] === '--github-summary') {
      options.githubSummary = true;
    } else if (argv[i] === '--result-file') {
      // A swallowed missing value would silently write no result file, and the
      // scheduled workflow's issue step would then read nothing.
      const value = argv[i + 1];
      if (!isNonEmptyString(value) || value.startsWith('--')) {
        throw new Error('--result-file requires a path');
      }
      options.resultFile = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return options;
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const options = parseArgs(process.argv.slice(2));

  const { result, exitCode } = await runProductionAudit({
    rootDir,
    runAudit: spawnPnpmAudit(rootDir),
    failOnStaleExceptions: options.failOnStaleExceptions,
  });

  if (options.resultFile) writeFileSync(options.resultFile, `${JSON.stringify(result, null, 2)}\n`);
  if (options.githubSummary && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, githubStepSummary(result));
  }

  const log = exitCode === 0 ? console.log : console.error;
  log(`security=${result.securityState} exceptions=${result.exceptionState}`);
  log(result.summary);
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // A wrapper crash is not an audit result: fail as unavailable, not clean.
    console.error(`Production audit runner failed: ${err.message}`);
    process.exit(2);
  });
}
