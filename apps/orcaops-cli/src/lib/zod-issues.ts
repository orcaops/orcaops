import type { $ZodIssue } from 'zod/v4/core';

/** Cap on rendered issues, so a badly-shaped file cannot produce a wall of text. */
const MAX_RENDERED_ISSUES = 10;

/**
 * Dotted field path for an issue, or `(root)` for a top-level failure.
 */
export function zodIssuePath(issue: $ZodIssue): string {
  return issue.path.length > 0 ? issue.path.join('.') : '(root)';
}

/**
 * Extra guidance for the one class of Zod failure whose cause is invisible
 * from the message alone.
 *
 * YAML coerces unquoted scalars (`0123` becomes a number, `true` a boolean),
 * so a string field can receive the wrong type and fail here rather than at
 * the YAML parse. A structured value reaching a plain-string field is a
 * different mistake with a different fix, so the two are distinguished:
 * quoting will not turn an object into a string.
 */
export function zodIssueHint(issue: $ZodIssue): string {
  if (issue.code !== 'invalid_type') return '';
  if ((issue as { expected?: unknown }).expected !== 'string') return '';
  // zod v4 carries the received type only in the message text.
  if (/received (?:object|array)/.test(issue.message)) {
    return (
      ' — a string field received a structured value; provide a plain string. ' +
      '(Structured `{decision, reason}` entries are only accepted by plan/checkpoint ' +
      '`decisions`, not string lists like deferred_decisions / open_items.)'
    );
  }
  return (
    ' — if this came from a YAML payload, quote the value or use a |- block scalar; ' +
    'an unquoted numeric- or boolean-looking value is parsed as that type, not a string.'
  );
}

/**
 * Render EVERY validation issue, not just the first.
 *
 * One parse routinely produces several independent problems — the evaluator
 * config's cross-field checks alone can report a duplicate pack id and an
 * undeclared pack ref together — and reporting only `issues[0]` turns one
 * round of fixes into as many rounds as there are mistakes.
 *
 * Returns a single line for one issue and a bulleted list for several, so the
 * common case stays terse.
 */
export function formatZodIssues(issues: readonly $ZodIssue[]): string {
  if (issues.length === 0) return 'Invalid input';

  const rendered = issues
    .slice(0, MAX_RENDERED_ISSUES)
    .map((issue) => `${zodIssuePath(issue)}: ${issue.message}${zodIssueHint(issue)}`);
  const omitted = issues.length - rendered.length;
  if (rendered.length === 1) return rendered[0]!;
  return (
    rendered.map((line) => `  - ${line}`).join('\n') +
    (omitted > 0 ? `\n  - …and ${omitted} more issue(s)` : '')
  );
}
