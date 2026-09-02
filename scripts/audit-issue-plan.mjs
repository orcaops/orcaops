#!/usr/bin/env node
// Decides what the scheduled audit should do to its tracking issue, as pure
// data in and data out. The workflow shell only executes the decision, so the
// lifecycle can be tested without creating a real GitHub issue.
//
// Only Node built-ins — this runs in the audit job, which performs no install.
//
// Two rules keep this from stepping on human-authored issues: a candidate must
// match BOTH the exact title and the body marker (a person may legitimately use
// the same label), and nothing is ever modified or closed without that match.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ISSUE_TITLE = 'Production dependency audit needs attention';
export const ISSUE_MARKER = '<!-- orcaops-production-audit -->';
export const ISSUE_LABEL = 'production-audit';
export const LABEL_COLOR = 'B60205';
export const LABEL_DESCRIPTION = 'Scheduled production dependency audit needs attention';

// Descending, so an issue body leads with the worst finding. Mirrors
// SUPPORTED_SEVERITIES in run-production-audit.mjs, info included.
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];

/** The one issue this workflow owns, or null. Oldest wins if somehow duplicated. */
export function selectTrackingIssue(issues) {
  const owned = (Array.isArray(issues) ? issues : [])
    .filter(
      (i) =>
        i && i.title === ISSUE_TITLE && typeof i.body === 'string' && i.body.includes(ISSUE_MARKER)
    )
    .sort((a, b) => a.number - b.number);
  return owned[0] ?? null;
}

function severityBreakdown(counts) {
  const parts = SEVERITIES.filter((s) => (counts?.[s] ?? 0) > 0).map((s) => `${counts[s]} ${s}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

const totalOf = (counts) => SEVERITIES.reduce((n, s) => n + (counts?.[s] ?? 0), 0);

/**
 * Every condition that applies goes into ONE body, rather than one comment per
 * classifier branch.
 */
export function buildIssueBody({ result, runUrl }) {
  const sections = [
    ISSUE_MARKER,
    '',
    `Scheduled production dependency audit: [run details](${runUrl})`,
    '',
  ];

  if (result.securityState === 'advisories') {
    sections.push(
      `## Actionable advisories`,
      '',
      `The production audit found **${totalOf(result.counts)}** actionable advisory/advisories (${severityBreakdown(result.counts)}).`
    );
    if (result.expiredLiveGhsas.length > 0) {
      sections.push(
        '',
        `Of these, the following are **expired exceptions whose advisory is still present** — the approval window closed while the finding remained: ${result.expiredLiveGhsas.join(', ')}.`
      );
    }
    sections.push('');
  }

  if (result.securityState === 'unavailable') {
    sections.push(
      `## Audit unavailable`,
      '',
      `The audit could not establish the vulnerability baseline, so **no claim is made about whether vulnerabilities exist**.`,
      '',
      `- reason: \`${result.unavailableReason}\``,
      `- attempts: ${result.attempts}`,
      ''
    );
  }

  if (result.exceptionState === 'invalid') {
    sections.push(
      `## Exception policy could not be applied`,
      '',
      `\`config/dependency-policy.json\` could not be read as a trustworthy exception source, so every advisory was counted as unexcepted. The policy content is deliberately not reproduced here.`,
      ''
    );
    if (result.securityState !== 'unavailable') {
      sections.push(
        `The registry audit still completed and independently reports ${totalOf(result.counts)} advisory/advisories (${severityBreakdown(result.counts)}).`,
        ''
      );
    }
  }

  if (result.expiredStaleGhsas.length > 0) {
    sections.push(
      `## Expired exceptions with no matching advisory`,
      '',
      `No matching advisory remains for these, so each is dead configuration that must be removed or deliberately renewed: ${result.expiredStaleGhsas.join(', ')}.`,
      ''
    );
  }

  return sections.join('\n').trimEnd();
}

export function buildResolvedComment({ result, runUrl }) {
  return [
    ISSUE_MARKER,
    '',
    `The zero-unexcepted-advisory baseline is restored: [run details](${runUrl})`,
    '',
    result.activeGhsas.length > 0
      ? `${result.activeGhsas.length} active exception(s) remain in force: ${result.activeGhsas.join(', ')}.`
      : 'No advisory exceptions are in force.',
    '',
    'Closing this tracking issue.',
  ].join('\n');
}

/**
 * Unmatched exceptions deliberately do NOT count: an unexpired entry with no
 * matching advisory is a warning in the job summary, not something that opens
 * or holds open a tracking issue.
 */
export function needsAttention(result) {
  return (
    result.securityState !== 'clean' ||
    result.exceptionState === 'invalid' ||
    result.expiredStaleGhsas.length > 0
  );
}

/**
 * @returns {{ action: 'create'|'comment'|'close'|'none', issueNumber: number|null,
 *             title: string, body: string, label: string }}
 */
export function planIssueAction({ result, issues, runUrl }) {
  const issue = selectTrackingIssue(issues);
  const base = { issueNumber: issue?.number ?? null, title: ISSUE_TITLE, label: ISSUE_LABEL };

  if (needsAttention(result)) {
    const body = buildIssueBody({ result, runUrl });
    return issue ? { ...base, action: 'comment', body } : { ...base, action: 'create', body };
  }
  if (issue) return { ...base, action: 'close', body: buildResolvedComment({ result, runUrl }) };
  return { ...base, action: 'none', body: '' };
}

const SECURITY_STATES = ['clean', 'advisories', 'unavailable'];
const EXCEPTION_STATES = [
  'none',
  'active',
  'unmatched',
  'expired-live',
  'expired-stale',
  'mixed',
  'invalid',
];
const SEVERITY_KEYS = ['info', 'low', 'moderate', 'high', 'critical'];
const GHSA_ARRAYS = ['activeGhsas', 'unmatchedGhsas', 'expiredLiveGhsas', 'expiredStaleGhsas'];

const UNREADABLE_RESULT = Object.freeze({
  securityState: 'unavailable',
  exceptionState: 'invalid',
  unavailableReason: 'command-failure',
  counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  attempts: 0,
  activeGhsas: [],
  unmatchedGhsas: [],
  expiredLiveGhsas: [],
  expiredStaleGhsas: [],
  summary: 'The audit runner produced no readable or complete result file.',
});

/**
 * A missing, unreadable, or INCOMPLETE result file is an unavailable audit, not
 * a clean one. Every field the lifecycle reads is validated: defaulting an
 * absent field would let a truncated `{"securityState":"clean"}` close an open
 * security issue, which is the one direction this must never fail.
 */
export function readResult(resultFile) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch {
    return { ...UNREADABLE_RESULT };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...UNREADABLE_RESULT };
  }

  const wellFormed =
    SECURITY_STATES.includes(parsed.securityState) &&
    EXCEPTION_STATES.includes(parsed.exceptionState) &&
    Number.isInteger(parsed.attempts) &&
    typeof parsed.summary === 'string' &&
    (parsed.unavailableReason === null || typeof parsed.unavailableReason === 'string') &&
    typeof parsed.counts === 'object' &&
    parsed.counts !== null &&
    SEVERITY_KEYS.every((k) => Number.isInteger(parsed.counts[k])) &&
    GHSA_ARRAYS.every(
      (k) => Array.isArray(parsed[k]) && parsed[k].every((g) => typeof g === 'string')
    );

  return wellFormed ? parsed : { ...UNREADABLE_RESULT };
}

function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1 || !args[i + 1]) throw new Error(`${flag} requires a value`);
    return args[i + 1];
  };

  const result = readResult(valueOf('--result-file'));
  let issues = [];
  try {
    issues = JSON.parse(readFileSync(valueOf('--issues-file'), 'utf8'));
  } catch {
    // No readable candidate list means nothing can be safely adopted; the plan
    // falls back to creating a fresh issue if one is warranted.
    issues = [];
  }

  const action = planIssueAction({ result, issues, runUrl: valueOf('--run-url') });

  // The body goes to a file: it is multi-line markdown, which neither a step
  // output nor a shell variable round-trips safely.
  writeFileSync(valueOf('--body-file'), action.body);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `action=${action.action}\nissue-number=${action.issueNumber ?? ''}\n`
    );
  }
  process.stdout.write(`${JSON.stringify({ ...action, body: `<${action.body.length} chars>` })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
