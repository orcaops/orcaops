import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ISSUE_MARKER,
  ISSUE_TITLE,
  buildIssueBody,
  needsAttention,
  planIssueAction,
  readResult,
  selectTrackingIssue,
} from './audit-issue-plan.mjs';

const RUN_URL = 'https://github.com/orcaops/orcaops/actions/runs/1';
const GHSA_A = 'GHSA-7fh5-64p2-3v2j';
const GHSA_B = 'GHSA-2xhp-mvcf-3vqr';

const result = (over = {}) => ({
  securityState: 'clean',
  exceptionState: 'none',
  unavailableReason: null,
  counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  attempts: 1,
  activeGhsas: [],
  unmatchedGhsas: [],
  expiredLiveGhsas: [],
  expiredStaleGhsas: [],
  summary: 'No actionable production advisories.',
  ...over,
});

const ownedIssue = (over = {}) => ({
  number: 42,
  title: ISSUE_TITLE,
  body: `${ISSUE_MARKER}\nprevious report`,
  ...over,
});

const plan = (res, issues = []) => planIssueAction({ result: res, issues, runUrl: RUN_URL });

describe('selecting the workflow-owned issue', () => {
  it('matches on exact title and body marker together', () => {
    expect(selectTrackingIssue([ownedIssue()])?.number).toBe(42);
  });

  it.each([
    ['a human issue sharing only the label', { title: 'Audit is noisy', body: 'no marker here' }],
    ['a title match with no marker', { title: ISSUE_TITLE, body: 'no marker here' }],
    ['a marker match with a different title', { title: 'Something else', body: ISSUE_MARKER }],
    ['a near-miss title', { title: `${ISSUE_TITLE} (old)`, body: ISSUE_MARKER }],
    ['a non-string body', { title: ISSUE_TITLE, body: null }],
  ])('refuses to adopt %s', (_label, over) => {
    expect(selectTrackingIssue([{ number: 7, ...over }])).toBeNull();
  });

  it('returns null for an empty or malformed list', () => {
    expect(selectTrackingIssue([])).toBeNull();
    expect(selectTrackingIssue(null)).toBeNull();
    expect(selectTrackingIssue([null, undefined])).toBeNull();
  });

  it('picks the oldest deterministically if duplicates somehow exist', () => {
    const chosen = selectTrackingIssue([ownedIssue({ number: 99 }), ownedIssue({ number: 12 })]);
    expect(chosen.number).toBe(12);
  });
});

describe('conditions that need attention', () => {
  it.each([
    ['actionable advisories', { securityState: 'advisories' }],
    ['an unavailable audit', { securityState: 'unavailable', unavailableReason: 'invalid-json' }],
    ['an invalid exception policy', { exceptionState: 'invalid' }],
    [
      'expired-stale configuration',
      { expiredStaleGhsas: [GHSA_A], exceptionState: 'expired-stale' },
    ],
  ])('treats %s as needing attention', (_label, over) => {
    expect(needsAttention(result(over))).toBe(true);
  });

  it.each([
    ['a clean baseline', {}],
    ['an active exception', { exceptionState: 'active', activeGhsas: [GHSA_A] }],
    ['an unmatched exception', { exceptionState: 'unmatched', unmatchedGhsas: [GHSA_A] }],
  ])('does not treat %s as needing attention', (_label, over) => {
    expect(needsAttention(result(over))).toBe(false);
  });
});

describe('the issue lifecycle', () => {
  it('creates the issue when a condition appears and none is open', () => {
    const action = plan(
      result({
        securityState: 'advisories',
        counts: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      })
    );
    expect(action.action).toBe('create');
    expect(action.issueNumber).toBeNull();
    expect(action.title).toBe(ISSUE_TITLE);
    expect(action.body).toContain(ISSUE_MARKER);
  });

  it('comments instead of creating a duplicate when one is already open', () => {
    const action = plan(result({ securityState: 'advisories' }), [ownedIssue()]);
    expect(action.action).toBe('comment');
    expect(action.issueNumber).toBe(42);
  });

  it('closes the issue when the baseline is restored', () => {
    const action = plan(result({ exceptionState: 'active', activeGhsas: [GHSA_A] }), [
      ownedIssue(),
    ]);
    expect(action.action).toBe('close');
    expect(action.issueNumber).toBe(42);
    expect(action.body).toMatch(/baseline is restored/);
    expect(action.body).toMatch(/1 active exception\(s\) remain in force: GHSA-7fh5-64p2-3v2j/);
  });

  it('does nothing on a clean run with no open issue', () => {
    const action = plan(result());
    expect(action.action).toBe('none');
    expect(action.issueNumber).toBeNull();
  });

  it('leaves a human-authored issue with the same label untouched', () => {
    const human = { number: 5, title: 'Audit is too noisy', body: 'please tune it' };
    expect(plan(result(), [human]).action).toBe('none');
    expect(plan(result({ securityState: 'advisories' }), [human]).action).toBe('create');
  });

  it('does not open an issue for an unmatched exception alone', () => {
    expect(plan(result({ exceptionState: 'unmatched', unmatchedGhsas: [GHSA_A] })).action).toBe(
      'none'
    );
  });

  it('closes an open issue when only an unmatched exception remains', () => {
    const action = plan(result({ exceptionState: 'unmatched', unmatchedGhsas: [GHSA_A] }), [
      ownedIssue(),
    ]);
    expect(action.action).toBe('close');
  });

  it('stays at comment across repeated failures so no duplicate is created', () => {
    const failing = result({ securityState: 'advisories' });
    const first = plan(failing);
    expect(first.action).toBe('create');
    const open = ownedIssue({ body: first.body });
    expect(plan(failing, [open]).action).toBe('comment');
    expect(plan(failing, [open]).action).toBe('comment');
  });
});

describe('the issue body', () => {
  it('reports advisory counts by severity', () => {
    const body = buildIssueBody({
      result: result({
        securityState: 'advisories',
        counts: { info: 0, low: 1, moderate: 0, high: 2, critical: 1 },
      }),
      runUrl: RUN_URL,
    });
    expect(body).toContain('**4** actionable advisory/advisories (1 critical, 2 high, 1 low)');
    expect(body).toContain(RUN_URL);
  });

  it('identifies expired-live advisories separately from other unexcepted ones', () => {
    const body = buildIssueBody({
      result: result({
        securityState: 'advisories',
        exceptionState: 'expired-live',
        counts: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 },
        expiredLiveGhsas: [GHSA_A],
      }),
      runUrl: RUN_URL,
    });
    expect(body).toMatch(
      /expired exceptions whose advisory is still present[\s\S]*GHSA-7fh5-64p2-3v2j/
    );
  });

  it('does not claim vulnerabilities when the audit was unavailable', () => {
    const body = buildIssueBody({
      result: result({
        securityState: 'unavailable',
        unavailableReason: 'schema-mismatch',
        attempts: 1,
      }),
      runUrl: RUN_URL,
    });
    expect(body).toContain('no claim is made about whether vulnerabilities exist');
    expect(body).toContain('`schema-mismatch`');
    expect(body).toContain('attempts: 1');
    expect(body).not.toMatch(/actionable advisory/);
  });

  it('reports independently established counts alongside an invalid policy', () => {
    const body = buildIssueBody({
      result: result({
        securityState: 'advisories',
        exceptionState: 'invalid',
        counts: { info: 0, low: 0, moderate: 3, high: 0, critical: 0 },
      }),
      runUrl: RUN_URL,
    });
    expect(body).toContain('independently reports 3 advisory/advisories (3 moderate)');
    expect(body).toContain('deliberately not reproduced here');
  });

  it('omits the independent-count line when the audit itself was unavailable', () => {
    const body = buildIssueBody({
      result: result({
        securityState: 'unavailable',
        exceptionState: 'invalid',
        unavailableReason: 'command-failure',
      }),
      runUrl: RUN_URL,
    });
    expect(body).not.toMatch(/independently reports/);
  });

  it('states that expired-stale entries must be removed or renewed', () => {
    const body = buildIssueBody({
      result: result({ exceptionState: 'expired-stale', expiredStaleGhsas: [GHSA_A, GHSA_B] }),
      runUrl: RUN_URL,
    });
    expect(body).toMatch(/No matching advisory remains[\s\S]*removed or deliberately renewed/);
    expect(body).toContain(GHSA_A);
    expect(body).toContain(GHSA_B);
    expect(body).not.toMatch(/actionable advisory/);
  });

  it('reports every coexisting condition in a single body', () => {
    const body = buildIssueBody({
      result: result({
        securityState: 'advisories',
        exceptionState: 'mixed',
        counts: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 },
        expiredLiveGhsas: [GHSA_A],
        expiredStaleGhsas: [GHSA_B],
      }),
      runUrl: RUN_URL,
    });
    expect(body).toContain('## Actionable advisories');
    expect(body).toContain('## Expired exceptions with no matching advisory');
    expect(body.match(/^## /gm)).toHaveLength(2);
  });

  it('never omits the marker, so a later run can find what it wrote', () => {
    for (const over of [
      { securityState: 'advisories' },
      { securityState: 'unavailable', unavailableReason: 'invalid-json' },
      { exceptionState: 'invalid' },
      { expiredStaleGhsas: [GHSA_A] },
    ]) {
      expect(buildIssueBody({ result: result(over), runUrl: RUN_URL })).toContain(ISSUE_MARKER);
    }
  });
});

describe('the CLI contract the workflow depends on', () => {
  const run = (resultBody, issuesBody) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-plan-cli-'));
    const files = {
      result: path.join(dir, 'result.json'),
      issues: path.join(dir, 'issues.json'),
      body: path.join(dir, 'body.md'),
      output: path.join(dir, 'gh-output.txt'),
    };
    writeFileSync(files.result, resultBody);
    writeFileSync(files.issues, issuesBody);
    writeFileSync(files.output, '');
    const proc = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, 'audit-issue-plan.mjs'),
        '--result-file',
        files.result,
        '--issues-file',
        files.issues,
        '--run-url',
        RUN_URL,
        '--body-file',
        files.body,
      ],
      { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: files.output } }
    );
    const outputs = Object.fromEntries(
      readFileSync(files.output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('='))
    );
    const body = existsSync(files.body) ? readFileSync(files.body, 'utf8') : null;
    rmSync(dir, { recursive: true, force: true });
    return { status: proc.status, stdout: proc.stdout, outputs, body };
  };

  it('emits action and issue-number as step outputs and writes the body to a file', () => {
    const { status, outputs, body } = run(
      JSON.stringify(
        result({
          securityState: 'advisories',
          counts: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
        })
      ),
      JSON.stringify([ownedIssue()])
    );
    expect(status).toBe(0);
    expect(outputs).toEqual({ action: 'comment', 'issue-number': '42' });
    expect(body).toContain(ISSUE_MARKER);
  });

  it('leaves issue-number empty when there is nothing to adopt', () => {
    const { outputs } = run(JSON.stringify(result({ securityState: 'advisories' })), '[]');
    expect(outputs).toEqual({ action: 'create', 'issue-number': '' });
  });

  it('never prints the issue body to stdout, only its length', () => {
    const { stdout } = run(JSON.stringify(result({ securityState: 'advisories' })), '[]');
    expect(stdout).toMatch(/"body":"<\d+ chars>"/);
    expect(stdout).not.toContain(ISSUE_MARKER);
  });

  it('plans a create when the issue list is unreadable rather than crashing', () => {
    const { status, outputs } = run(
      JSON.stringify(result({ securityState: 'advisories' })),
      'not json'
    );
    expect(status).toBe(0);
    expect(outputs.action).toBe('create');
  });

  it('plans attention when the audit produced no result file content', () => {
    const { status, outputs, body } = run('', '[]');
    expect(status).toBe(0);
    expect(outputs.action).toBe('create');
    expect(body).toContain('no claim is made about whether vulnerabilities exist');
  });

  it('emits exactly the four actions the workflow case statement handles', () => {
    const handled = ['create', 'comment', 'close', 'none'];
    const cases = [
      [result({ securityState: 'advisories' }), []],
      [result({ securityState: 'advisories' }), [ownedIssue()]],
      [result(), [ownedIssue()]],
      [result(), []],
    ];
    for (const [res, issues] of cases) {
      expect(handled).toContain(planIssueAction({ result: res, issues, runUrl: RUN_URL }).action);
    }
  });
});

describe('reading the result file', () => {
  it('treats a missing file as an unavailable audit rather than a clean one', () => {
    const res = readResult('/definitely/not/here.json');
    expect(res.securityState).toBe('unavailable');
    expect(needsAttention(res)).toBe(true);
  });

  it('treats malformed content as unavailable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-plan-'));
    const file = path.join(dir, 'r.json');
    writeFileSync(file, '{ not json');
    expect(readResult(file).securityState).toBe('unavailable');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a well-formed result', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-plan-'));
    const file = path.join(dir, 'r.json');
    writeFileSync(file, JSON.stringify(result({ securityState: 'advisories' })));
    expect(readResult(file).securityState).toBe('advisories');
    rmSync(dir, { recursive: true, force: true });
  });

  // An incomplete result must never read as clean: defaulting the absent fields
  // would let a truncated file close an open security issue.
  const readRaw = (body) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-plan-'));
    const file = path.join(dir, 'r.json');
    writeFileSync(file, body);
    const res = readResult(file);
    rmSync(dir, { recursive: true, force: true });
    return res;
  };

  it.each([
    ['only securityState', '{"securityState":"clean"}'],
    ['no exceptionState', JSON.stringify({ ...result(), exceptionState: undefined })],
    ['no counts', JSON.stringify({ ...result(), counts: undefined })],
    ['a partial counts map', JSON.stringify({ ...result(), counts: { low: 0, high: 0 } })],
    [
      'a non-integer count',
      JSON.stringify({ ...result(), counts: { ...result().counts, low: '0' } }),
    ],
    ['a missing GHSA array', JSON.stringify({ ...result(), expiredStaleGhsas: undefined })],
    ['a non-string GHSA entry', JSON.stringify({ ...result(), activeGhsas: [42] })],
    ['no attempts', JSON.stringify({ ...result(), attempts: undefined })],
    ['no summary', JSON.stringify({ ...result(), summary: undefined })],
    ['an unrecognized securityState', JSON.stringify({ ...result(), securityState: 'fine' })],
    ['an unrecognized exceptionState', JSON.stringify({ ...result(), exceptionState: 'ok' })],
    ['a JSON array', '[]'],
    ['a JSON scalar', '"clean"'],
  ])('treats %s as unavailable rather than clean', (_label, body) => {
    const res = readRaw(body);
    expect(res.securityState).toBe('unavailable');
    expect(needsAttention(res)).toBe(true);
  });

  it('does not close an open tracking issue from an incomplete result', () => {
    const res = readRaw('{"securityState":"clean"}');
    expect(planIssueAction({ result: res, issues: [ownedIssue()], runUrl: RUN_URL }).action).toBe(
      'comment'
    );
  });

  it('still accepts a complete result unchanged', () => {
    const res = readRaw(
      JSON.stringify(result({ exceptionState: 'active', activeGhsas: [GHSA_A] }))
    );
    expect(res.securityState).toBe('clean');
    expect(needsAttention(res)).toBe(false);
  });
});
