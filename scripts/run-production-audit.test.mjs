import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkDependencyPolicy } from './check-dependency-policy.mjs';
import {
  MAX_ATTEMPTS,
  SUPPORTED_SEVERITIES,
  classifyExceptions,
  exitCodeFor,
  githubStepSummary,
  interpretAuditOutput,
  loadExceptions,
  parseArgs,
  runProductionAudit,
  utcToday,
} from './run-production-audit.mjs';

const GHSA_A = 'GHSA-7fh5-64p2-3v2j';
const GHSA_B = 'GHSA-2xhp-mvcf-3vqr';
const GHSA_C = 'GHSA-4wf5-vphf-c2xc';
const GHSA_D = 'GHSA-3xgq-45jj-v275';

const NOW = new Date('2026-08-05T12:00:00Z');
const PAST = '2026-01-01';
const FUTURE = '2099-01-01';

const tempRoots = [];

/** A raw pnpm audit report with the shape `pnpm audit --prod --json` emits. */
function auditReport(advisories = []) {
  return JSON.stringify({
    actions: [],
    advisories: Object.fromEntries(
      advisories.map((a, i) => [
        String(i + 1),
        {
          id: i + 1,
          github_advisory_id: a.ghsa,
          severity: a.severity,
          module_name: a.module ?? 'some-package',
          title: a.title ?? 'Some vulnerability',
          url: `https://github.com/advisories/${a.ghsa}`,
          findings: [{ version: '1.0.0', paths: ['some-package'] }],
        },
      ])
    ),
    muted: [],
    metadata: {
      // Deliberately inconsistent with `advisories` so a test can prove counts
      // are derived from the advisory list, not from here.
      vulnerabilities: { info: 0, low: 99, moderate: 99, high: 99, critical: 99 },
      dependencies: 286,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 286,
    },
  });
}

function makeRoot(exceptions, { raw } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'production-audit-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, 'config'), { recursive: true });
  const body =
    raw ??
    JSON.stringify({
      schemaVersion: 1,
      manuallyManagedDependencies: [],
      advisoryExceptions: exceptions ?? [],
    });
  writeFileSync(path.join(root, 'config/dependency-policy.json'), body);
  return root;
}

const exception = (ghsa, expiresOn) => ({
  ghsa,
  owner: '@orcaops/maintainers',
  rationale: 'No fixed release is available yet.',
  expiresOn,
  evidence: [`https://github.com/advisories/${ghsa}`],
});

/** Returns a runAudit that yields a different outcome per attempt. */
const sequence = (...outcomes) => {
  const calls = [];
  const fn = async (attempt) => {
    calls.push(attempt);
    return outcomes[Math.min(attempt - 1, outcomes.length - 1)];
  };
  fn.calls = calls;
  return fn;
};

const audit = (opts) => runProductionAudit({ now: NOW, sleep: async () => {}, ...opts });

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe('a failed registry call', () => {
  it('is retryable rather than a schema mismatch', () => {
    const stdout = JSON.stringify({
      error: { code: 'ERR_SOCKET_TIMEOUT', message: 'request to registry failed' },
    });
    expect(interpretAuditOutput({ stdout })).toEqual({ reason: 'registry-unreachable' });
  });

  it('still reports a genuinely unexpected shape as a schema mismatch', () => {
    const stdout = JSON.stringify({ advisories: 'not-an-object', metadata: {} });
    expect(interpretAuditOutput({ stdout })).toEqual({ reason: 'schema-mismatch' });
  });
});

describe('a clean audit', () => {
  it('reports clean security state, no exceptions, and exit 0', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: auditReport([]) }),
    });
    expect(result.securityState).toBe('clean');
    expect(result.exceptionState).toBe('none');
    expect(result.unavailableReason).toBeNull();
    expect(result.counts).toEqual({ info: 0, low: 0, moderate: 0, high: 0, critical: 0 });
    expect(result.attempts).toBe(1);
    expect(exitCode).toBe(0);
  });
});

describe('advisory severities', () => {
  it.each(SUPPORTED_SEVERITIES)('treats a lone %s advisory as actionable', async (severity) => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity }]) }),
    });
    expect(result.securityState).toBe('advisories');
    expect(result.counts[severity]).toBe(1);
    expect(exitCode).toBe(1);
  });

  it('counts mixed severities independently', async () => {
    const { result } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({
        stdout: auditReport([
          { ghsa: GHSA_A, severity: 'low' },
          { ghsa: GHSA_B, severity: 'critical' },
          { ghsa: GHSA_C, severity: 'critical' },
        ]),
      }),
    });
    expect(result.counts).toEqual({ info: 0, low: 1, moderate: 0, high: 0, critical: 2 });
  });

  it('derives counts from actionable advisories, not from metadata', async () => {
    // The fixture's metadata claims 99 of every severity.
    const { result } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity: 'high' }]) }),
    });
    expect(result.counts).toEqual({ info: 0, low: 0, moderate: 0, high: 1, critical: 0 });
  });

  it('excludes an actively excepted advisory from the counts', async () => {
    const { result } = await audit({
      rootDir: makeRoot([exception(GHSA_A, FUTURE)]),
      runAudit: sequence({
        stdout: auditReport([
          { ghsa: GHSA_A, severity: 'critical' },
          { ghsa: GHSA_B, severity: 'low' },
        ]),
      }),
    });
    expect(result.counts).toEqual({ info: 0, low: 1, moderate: 0, high: 0, critical: 0 });
  });
});

describe('the runtime and lint evidence validators', () => {
  // Any shape the checker rejects but the runner accepts is a shape that
  // suppresses an advisory without surviving review, so the two must agree
  // exactly rather than approximately.
  const EVIDENCE_SHAPES = [
    ['a single valid entry', ['https://example/advisory'], true],
    ['several valid entries', ['a', 'b'], true],
    ['an empty array', [], false],
    ['a blank-only entry', ['   '], false],
    ['a valid entry mixed with a number', ['valid', 42], false],
    ['a valid entry mixed with a blank', ['valid', ''], false],
    ['a valid entry mixed with null', ['valid', null], false],
    ['a bare string', 'valid', false],
    ['an absent key', undefined, false],
  ];

  it.each(EVIDENCE_SHAPES)('agrees on %s', (_label, evidence, expectedValid) => {
    const entry = { ...exception(GHSA_A, FUTURE) };
    if (evidence === undefined) delete entry.evidence;
    else entry.evidence = evidence;

    const root = makeRoot(null, {
      raw: JSON.stringify({
        schemaVersion: 1,
        manuallyManagedDependencies: [],
        advisoryExceptions: [entry],
      }),
    });

    // The runner's own view.
    expect(loadExceptions(root).valid).toBe(expectedValid);

    // The lint checker's view of the identical policy file, via a fixture repo
    // whose other inputs are valid so only the evidence shape can fail it.
    writeFileSync(path.join(root, '.syncpackrc.json'), JSON.stringify({ versionGroups: [] }));
    mkdirSync(path.join(root, '.github'), { recursive: true });
    writeFileSync(
      path.join(root, '.github/dependabot.yml'),
      "version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    directory: '/'\n"
    );
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    const checkerErrors = checkDependencyPolicy(root).errors.filter((e) => /evidence/.test(e));
    expect(checkerErrors.length === 0).toBe(expectedValid);
  });
});

describe('exception classification', () => {
  it('treats an unexpired exception with a matching advisory as active and clean', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([exception(GHSA_A, FUTURE)]),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity: 'high' }]) }),
    });
    expect(result.securityState).toBe('clean');
    expect(result.exceptionState).toBe('active');
    expect(result.activeGhsas).toEqual([GHSA_A]);
    expect(exitCode).toBe(0);
  });

  it('warns on an unexpired exception with no matching advisory without counting it active', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([exception(GHSA_A, FUTURE)]),
      runAudit: sequence({ stdout: auditReport([]) }),
    });
    expect(result.securityState).toBe('clean');
    expect(result.exceptionState).toBe('unmatched');
    expect(result.unmatchedGhsas).toEqual([GHSA_A]);
    expect(result.activeGhsas).toEqual([]);
    expect(result.summary).toMatch(/not counted as active/);
    expect(exitCode).toBe(0);
  });

  it('treats an expired exception whose advisory is still present as actionable', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([exception(GHSA_A, PAST)]),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity: 'moderate' }]) }),
    });
    expect(result.securityState).toBe('advisories');
    expect(result.exceptionState).toBe('expired-live');
    expect(result.expiredLiveGhsas).toEqual([GHSA_A]);
    expect(result.counts.moderate).toBe(1);
    expect(exitCode).toBe(1);
  });

  it('treats an expired exception with no matching advisory as stale configuration', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([exception(GHSA_A, PAST)]),
      runAudit: sequence({ stdout: auditReport([]) }),
    });
    expect(result.securityState).toBe('clean');
    expect(result.exceptionState).toBe('expired-stale');
    expect(result.expiredStaleGhsas).toEqual([GHSA_A]);
    expect(exitCode).toBe(0);
  });

  it('expires an exception on the expiry date itself', async () => {
    const today = utcToday(NOW);
    const { result } = await audit({
      rootDir: makeRoot([exception(GHSA_A, today)]),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity: 'high' }]) }),
    });
    expect(result.exceptionState).toBe('expired-live');
  });

  it('reports mixed state with correct actionable counts when every class coexists', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([
        exception(GHSA_A, FUTURE), // active — advisory present
        exception(GHSA_B, FUTURE), // unmatched — advisory absent
        exception(GHSA_C, PAST), // expired-live — advisory present
        exception(GHSA_D, PAST), // expired-stale — advisory absent
      ]),
      runAudit: sequence({
        stdout: auditReport([
          { ghsa: GHSA_A, severity: 'critical' },
          { ghsa: GHSA_C, severity: 'high' },
          { ghsa: 'GHSA-9wv6-86v2-598j', severity: 'low' }, // unexcepted
        ]),
      }),
    });
    expect(result.exceptionState).toBe('mixed');
    expect(result.activeGhsas).toEqual([GHSA_A]);
    expect(result.unmatchedGhsas).toEqual([GHSA_B]);
    expect(result.expiredLiveGhsas).toEqual([GHSA_C]);
    expect(result.expiredStaleGhsas).toEqual([GHSA_D]);
    // Actionable = the expired-live high + the unexcepted low. The active
    // critical is excluded.
    expect(result.counts).toEqual({ info: 0, low: 1, moderate: 0, high: 1, critical: 0 });
    expect(result.securityState).toBe('advisories');
    expect(exitCode).toBe(1);
  });

  it('classifies exception groups from the raw advisory set', () => {
    const groups = classifyExceptions({
      exceptions: [
        { ghsa: GHSA_A, expiresOn: FUTURE },
        { ghsa: GHSA_B, expiresOn: PAST },
      ],
      advisoryGhsas: new Set([GHSA_A]),
      today: '2026-08-05',
    });
    expect(groups).toEqual({
      active: [GHSA_A],
      unmatched: [],
      expiredLive: [],
      expiredStale: [GHSA_B],
    });
  });
});

describe('expired-stale enforcement', () => {
  it('exits 0 in dependency-PR mode', async () => {
    const { exitCode } = await audit({
      rootDir: makeRoot([exception(GHSA_A, PAST)]),
      runAudit: sequence({ stdout: auditReport([]) }),
    });
    expect(exitCode).toBe(0);
  });

  it('exits 4 with --fail-on-stale-exceptions', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([exception(GHSA_A, PAST)]),
      runAudit: sequence({ stdout: auditReport([]) }),
      failOnStaleExceptions: true,
    });
    expect(result.securityState).toBe('clean');
    expect(exitCode).toBe(4);
  });
});

describe('an untrusted policy', () => {
  it.each([
    ['malformed JSON', '{ "schemaVersion": 1, }'],
    ['an unsupported schema version', JSON.stringify({ schemaVersion: 2, advisoryExceptions: [] })],
    [
      'a malformed GHSA in an exception',
      JSON.stringify({
        schemaVersion: 1,
        advisoryExceptions: [{ ...exception(GHSA_A, FUTURE), ghsa: 'CVE-2024-1' }],
      }),
    ],
    [
      'a malformed expiry',
      JSON.stringify({ schemaVersion: 1, advisoryExceptions: [exception(GHSA_A, '2026-02-30')] }),
    ],
    // Evidence is required at runtime too, so the runner and the lint checker
    // agree on what a trustworthy exception is.
    [
      'an exception with no evidence key',
      JSON.stringify({
        schemaVersion: 1,
        advisoryExceptions: [{ ...exception(GHSA_A, FUTURE), evidence: undefined }],
      }),
    ],
    [
      'an exception with an empty evidence list',
      JSON.stringify({
        schemaVersion: 1,
        advisoryExceptions: [{ ...exception(GHSA_A, FUTURE), evidence: [] }],
      }),
    ],
    [
      'an exception whose only evidence entry is blank',
      JSON.stringify({
        schemaVersion: 1,
        advisoryExceptions: [{ ...exception(GHSA_A, FUTURE), evidence: ['   '] }],
      }),
    ],
    // `some` would have accepted this; the lint checker requires EVERY entry.
    [
      'an exception mixing a valid evidence entry with a non-string',
      JSON.stringify({
        schemaVersion: 1,
        advisoryExceptions: [{ ...exception(GHSA_A, FUTURE), evidence: ['valid', 42] }],
      }),
    ],
    [
      'an exception mixing a valid evidence entry with a blank one',
      JSON.stringify({
        schemaVersion: 1,
        advisoryExceptions: [{ ...exception(GHSA_A, FUTURE), evidence: ['valid', ''] }],
      }),
    ],
    [
      'an exception whose evidence is a bare string rather than an array',
      JSON.stringify({
        schemaVersion: 1,
        advisoryExceptions: [{ ...exception(GHSA_A, FUTURE), evidence: 'valid' }],
      }),
    ],
  ])('is reported as invalid for %s', async (_label, raw) => {
    const { result } = await audit({
      rootDir: makeRoot(null, { raw }),
      runAudit: sequence({ stdout: auditReport([]) }),
    });
    expect(result.exceptionState).toBe('invalid');
  });

  it('still runs the registry audit and exits 3 when the audit is clean', async () => {
    const runAudit = sequence({ stdout: auditReport([]) });
    const { result, exitCode } = await audit({
      rootDir: makeRoot(null, { raw: 'not json at all' }),
      runAudit,
    });
    expect(runAudit.calls).toHaveLength(1); // the audit ran anyway
    expect(result.securityState).toBe('clean');
    expect(result.exceptionState).toBe('invalid');
    expect(exitCode).toBe(3);
  });

  it('treats every raw advisory as unexcepted even if the policy would have excepted it', async () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      advisoryExceptions: [exception(GHSA_A, 'never')],
    });
    const { result, exitCode } = await audit({
      rootDir: makeRoot(null, { raw }),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity: 'critical' }]) }),
    });
    expect(result.exceptionState).toBe('invalid');
    expect(result.activeGhsas).toEqual([]);
    expect(result.counts.critical).toBe(1);
    // Advisory (1) outranks invalid policy (3).
    expect(exitCode).toBe(1);
  });

  it('does not suppress an advisory using an exception the lint checker would reject', async () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      advisoryExceptions: [{ ...exception(GHSA_A, FUTURE), evidence: [] }],
    });
    const { result, exitCode } = await audit({
      rootDir: makeRoot(null, { raw }),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity: 'critical' }]) }),
    });
    expect(result.activeGhsas).toEqual([]);
    expect(result.counts.critical).toBe(1);
    expect(exitCode).toBe(1);
  });

  it('is reported as invalid when the policy file is absent', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'production-audit-'));
    tempRoots.push(root);
    const { result, exitCode } = await audit({
      rootDir: root,
      runAudit: sequence({ stdout: auditReport([]) }),
    });
    expect(result.exceptionState).toBe('invalid');
    expect(exitCode).toBe(3);
  });
});

describe('unavailable audit data', () => {
  it('retries malformed JSON and reports invalid-json when exhausted', async () => {
    const runAudit = sequence({ stdout: 'not json' });
    const { result, exitCode } = await audit({ rootDir: makeRoot([]), runAudit });
    expect(result.securityState).toBe('unavailable');
    expect(result.unavailableReason).toBe('invalid-json');
    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(runAudit.calls).toHaveLength(MAX_ATTEMPTS);
    expect(exitCode).toBe(2);
  });

  it('retries a command failure that produced no report', async () => {
    const runAudit = sequence({ stdout: '', spawnError: new Error('ENOENT') });
    const { result } = await audit({ rootDir: makeRoot([]), runAudit });
    expect(result.unavailableReason).toBe('command-failure');
    expect(result.attempts).toBe(MAX_ATTEMPTS);
  });

  it('treats empty output as a command failure rather than clean', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: '   ' }),
    });
    expect(result.unavailableReason).toBe('command-failure');
    expect(exitCode).toBe(2);
  });

  it('fails after one attempt on a schema mismatch', async () => {
    const runAudit = sequence({ stdout: JSON.stringify({ totally: 'wrong' }) });
    const { result, exitCode } = await audit({ rootDir: makeRoot([]), runAudit });
    expect(result.unavailableReason).toBe('schema-mismatch');
    expect(result.attempts).toBe(1);
    expect(runAudit.calls).toHaveLength(1);
    expect(exitCode).toBe(2);
  });

  it.each(['apocalyptic', 'INFO', 'none', ''])(
    'fails after one attempt on the unsupported severity %s',
    async (severity) => {
      const runAudit = sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity }]) });
      const { result, exitCode } = await audit({ rootDir: makeRoot([]), runAudit });
      expect(result.securityState).toBe('unavailable');
      expect(['unsupported-severity', 'schema-mismatch']).toContain(result.unavailableReason);
      expect(result.attempts).toBe(1);
      expect(runAudit.calls).toHaveLength(1);
      expect(exitCode).toBe(2);
    }
  );

  it('does NOT treat info as unsupported now that pnpm can report it', async () => {
    // Previously this made the audit unavailable at exit 2, whose message
    // claims no baseline was established — false when a finding was reported.
    const { result, exitCode } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity: 'info' }]) }),
    });
    expect(result.securityState).toBe('advisories');
    expect(result.unavailableReason).toBeNull();
    expect(result.counts.info).toBe(1);
    expect(exitCode).toBe(1);
    expect(result.summary).toBe('1 actionable production advisory/advisories (info 1).');
  });

  it('lets an info advisory be excepted like any other', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([exception(GHSA_A, FUTURE)]),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity: 'info' }]) }),
    });
    expect(result.securityState).toBe('clean');
    expect(result.counts.info).toBe(0);
    expect(exitCode).toBe(0);
  });

  it('does not retry a policy condition', async () => {
    const runAudit = sequence({ stdout: auditReport([]) });
    await audit({ rootDir: makeRoot(null, { raw: 'broken' }), runAudit });
    expect(runAudit.calls).toHaveLength(1);
  });

  it('accepts a clean report on retry', async () => {
    const runAudit = sequence({ stdout: 'not json' }, { stdout: auditReport([]) });
    const { result, exitCode } = await audit({ rootDir: makeRoot([]), runAudit });
    expect(result.securityState).toBe('clean');
    expect(result.attempts).toBe(2);
    expect(result.unavailableReason).toBeNull();
    expect(exitCode).toBe(0);
  });

  it('accepts an advisory report on retry', async () => {
    const runAudit = sequence(
      { stdout: '', spawnError: new Error('boom') },
      { stdout: auditReport([{ ghsa: GHSA_A, severity: 'high' }]) }
    );
    const { result, exitCode } = await audit({ rootDir: makeRoot([]), runAudit });
    expect(result.securityState).toBe('advisories');
    expect(result.attempts).toBe(2);
    expect(result.counts.high).toBe(1);
    expect(exitCode).toBe(1);
  });

  it('does not trust a non-zero exit code when the report parses', async () => {
    // pnpm exits non-zero whenever it finds advisories; that is a SUCCESSFUL
    // audit, and the wrapper must read the report rather than the code.
    const { result } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_A, severity: 'low' }]), code: 1 }),
    });
    expect(result.securityState).toBe('advisories');
    expect(result.unavailableReason).toBeNull();
  });

  it.each([
    ['a non-object advisory entry', JSON.stringify({ advisories: { 1: 'nope' }, metadata: {} })],
    [
      'an advisory with no GHSA id',
      JSON.stringify({ advisories: { 1: { severity: 'high' } }, metadata: {} }),
    ],
    [
      'an advisory with an unparseable GHSA id',
      JSON.stringify({
        advisories: { 1: { github_advisory_id: 'nope', severity: 'high' } },
        metadata: {},
      }),
    ],
    ['a missing advisories map', JSON.stringify({ metadata: {} })],
    ['a JSON array', JSON.stringify([])],
  ])('classifies %s as a schema mismatch', (_label, stdout) => {
    expect(interpretAuditOutput({ stdout }).reason).toBe('schema-mismatch');
  });
});

describe('exit precedence', () => {
  it('puts unavailable ahead of every other condition', () => {
    expect(
      exitCodeFor({
        securityState: 'unavailable',
        exceptionState: 'invalid',
        expiredStale: [GHSA_A],
        failOnStaleExceptions: true,
      })
    ).toBe(2);
  });

  it('puts actionable advisories ahead of invalid policy and stale exceptions', () => {
    expect(
      exitCodeFor({
        securityState: 'advisories',
        exceptionState: 'invalid',
        expiredStale: [GHSA_A],
        failOnStaleExceptions: true,
      })
    ).toBe(1);
  });

  it('puts invalid policy ahead of stale exceptions', () => {
    expect(
      exitCodeFor({
        securityState: 'clean',
        exceptionState: 'invalid',
        expiredStale: [GHSA_A],
        failOnStaleExceptions: true,
      })
    ).toBe(3);
  });

  it('reaches stale enforcement only when nothing else applies', () => {
    expect(
      exitCodeFor({
        securityState: 'clean',
        exceptionState: 'expired-stale',
        expiredStale: [GHSA_A],
        failOnStaleExceptions: true,
      })
    ).toBe(4);
  });

  it('exits 0 when clean and valid', () => {
    expect(
      exitCodeFor({
        securityState: 'clean',
        exceptionState: 'none',
        expiredStale: [],
        failOnStaleExceptions: true,
      })
    ).toBe(0);
  });

  it('preserves every coexisting condition in the result even though one code wins', async () => {
    const { result, exitCode } = await audit({
      rootDir: makeRoot([exception(GHSA_A, PAST), exception(GHSA_B, FUTURE)]),
      runAudit: sequence({ stdout: auditReport([{ ghsa: GHSA_C, severity: 'high' }]) }),
      failOnStaleExceptions: true,
    });
    expect(exitCode).toBe(1);
    expect(result.expiredStaleGhsas).toEqual([GHSA_A]);
    expect(result.unmatchedGhsas).toEqual([GHSA_B]);
    expect(result.exceptionState).toBe('mixed');
  });
});

describe('the sanitized result', () => {
  it('carries no registry-supplied text', async () => {
    const { result } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({
        stdout: auditReport([
          {
            ghsa: GHSA_A,
            severity: 'high',
            module_name: 'evil-package',
            title: 'CONTROL <script>alert(1)</script> TEXT',
          },
        ]),
      }),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/CONTROL|script|evil-package|github\.com/);
    expect(result.summary).toBe('1 actionable production advisory/advisories (high 1).');
  });

  it('exposes only the documented keys', async () => {
    const { result } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: auditReport([]) }),
    });
    expect(Object.keys(result).sort()).toEqual([
      'activeGhsas',
      'attempts',
      'counts',
      'exceptionState',
      'expiredLiveGhsas',
      'expiredStaleGhsas',
      'securityState',
      'summary',
      'unavailableReason',
      'unmatchedGhsas',
    ]);
  });

  it('places each validated identifier in exactly one bucket', async () => {
    const { result } = await audit({
      rootDir: makeRoot([
        exception(GHSA_A, FUTURE),
        exception(GHSA_B, FUTURE),
        exception(GHSA_C, PAST),
        exception(GHSA_D, PAST),
      ]),
      runAudit: sequence({
        stdout: auditReport([
          { ghsa: GHSA_A, severity: 'low' },
          { ghsa: GHSA_C, severity: 'low' },
        ]),
      }),
    });
    const all = [
      ...result.activeGhsas,
      ...result.unmatchedGhsas,
      ...result.expiredLiveGhsas,
      ...result.expiredStaleGhsas,
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([GHSA_A, GHSA_B, GHSA_C, GHSA_D].sort());
  });

  it('names the fixed unavailable reason and attempt count in the summary', async () => {
    const { result } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: 'nope' }),
    });
    expect(result.summary).toBe(
      'Production audit unavailable after 3 attempt(s): invalid-json. No vulnerability baseline was established.'
    );
    expect(result.summary).not.toMatch(/nope/);
  });

  it('does not claim a vulnerability when the audit was unavailable', async () => {
    const { result } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: 'nope' }),
    });
    expect(result.counts).toEqual({ info: 0, low: 0, moderate: 0, high: 0, critical: 0 });
    expect(result.summary).not.toMatch(/actionable production advisory/);
  });

  it('serializes to the documented result-file shape', async () => {
    const { result } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: auditReport([]) }),
    });
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'audit-result-')), 'result.json');
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
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
    });
    rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('the no-install constraint', () => {
  // The CI audit job runs with no `pnpm install`, so a third-party import
  // anywhere in this module's graph makes the audit die on ERR_MODULE_NOT_FOUND
  // instead of reporting a result. Node built-ins and relative paths only.
  it.each(['run-production-audit.mjs', 'dependency-policy-schema.mjs'])(
    '%s imports nothing outside Node built-ins',
    (file) => {
      const source = readFileSync(path.join(import.meta.dirname, file), 'utf8');
      const specifiers = [
        ...source.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm),
      ].map((m) => m[1]);
      const thirdParty = specifiers.filter((s) => !s.startsWith('node:') && !s.startsWith('.'));
      expect(thirdParty).toEqual([]);
    }
  );

  it('does not reach the yaml-dependent checker', () => {
    const source = readFileSync(path.join(import.meta.dirname, 'run-production-audit.mjs'), 'utf8');
    expect(source).not.toMatch(/from '\.\/check-dependency-policy\.mjs'/);
  });
});

describe('command-line arguments', () => {
  it('defaults to lenient stale handling, no result file, and no job summary', () => {
    expect(parseArgs([])).toEqual({
      failOnStaleExceptions: false,
      resultFile: null,
      githubSummary: false,
    });
  });

  it('accepts the strict stale flag, a result path, and the summary flag', () => {
    expect(
      parseArgs(['--fail-on-stale-exceptions', '--result-file', '/tmp/r.json', '--github-summary'])
    ).toEqual({
      failOnStaleExceptions: true,
      resultFile: '/tmp/r.json',
      githubSummary: true,
    });
  });

  it.each([
    ['an unknown flag', ['--audit-level', 'low']],
    ['a result flag with no path', ['--result-file']],
    ['a result flag followed by another flag', ['--result-file', '--github-summary']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe('the job summary', () => {
  const summaryFor = async (over) => {
    const { result } = await audit({
      rootDir: makeRoot(over.exceptions ?? []),
      runAudit: sequence({ stdout: auditReport(over.advisories ?? []) }),
    });
    return { markdown: githubStepSummary(result), result };
  };

  it('surfaces unmatched exceptions, which nothing else reports on a passing PR', async () => {
    const { markdown } = await summaryFor({ exceptions: [exception(GHSA_A, FUTURE)] });
    expect(markdown).toMatch(/Unmatched exceptions/);
    expect(markdown).toContain(GHSA_A);
    expect(markdown).toContain('WARNING');
  });

  it('surfaces expired-stale configuration', async () => {
    const { markdown } = await summaryFor({ exceptions: [exception(GHSA_A, PAST)] });
    expect(markdown).toMatch(/Expired exceptions with no matching advisory/);
  });

  it('reports both states and stays quiet when there is nothing to warn about', async () => {
    const { markdown } = await summaryFor({});
    expect(markdown).toContain('- security state: `clean`');
    expect(markdown).toContain('- exception state: `none`');
    expect(markdown).not.toContain('WARNING');
  });

  it('carries no registry-supplied text', async () => {
    const { markdown } = await summaryFor({
      advisories: [{ ghsa: GHSA_A, severity: 'high', module: 'evil-package', title: 'LEAKED' }],
    });
    expect(markdown).not.toMatch(/LEAKED|evil-package/);
  });

  it('names the unavailable reason and attempt count', async () => {
    const { result } = await audit({
      rootDir: makeRoot([]),
      runAudit: sequence({ stdout: 'nope' }),
    });
    const markdown = githubStepSummary(result);
    expect(markdown).toContain('- unavailable reason: `invalid-json`');
    expect(markdown).toContain('- attempts: 3');
  });
});
