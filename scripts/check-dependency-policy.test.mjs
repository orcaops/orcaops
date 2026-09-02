import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { checkDependencyPolicy } from './check-dependency-policy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VALID_POLICY = {
  schemaVersion: 1,
  manuallyManagedDependencies: [
    {
      dependency: 'typescript',
      source: 'syncpack-pin',
      owner: '@orcaops/maintainers',
      rationale: 'Pinned across the monorepo by syncpack.',
      evidence: ['.syncpackrc.json'],
    },
    {
      dependency: '@opentui/core',
      source: 'manual',
      owner: '@orcaops/maintainers',
      rationale: 'Upgrades need controlled render and performance validation.',
      evidence: ['docs/dependency-policy.md#manually-managed-dependencies'],
    },
  ],
  advisoryExceptions: [],
};

const VALID_SYNCPACK = {
  versionGroups: [
    { dependencies: ['typescript'], dependencyTypes: ['dev'], pinVersion: '5.9.2' },
    {
      dependencies: ['$LOCAL'],
      dependencyTypes: ['!local', 'prod', 'dev'],
      pinVersion: 'workspace:*',
    },
    { dependencies: ['prettier'], isBanned: true },
    { dependencies: ['pnpm'], dependencyTypes: ['packageManager'], snapTo: ['orcaops'] },
  ],
};

const VALID_DEPENDABOT = `
version: 2
updates:
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'monthly'
    ignore:
      - dependency-name: 'typescript'
      - dependency-name: '@opentui/core'
  - package-ecosystem: 'github-actions'
    directory: '/'
    schedule:
      interval: 'monthly'
`;

const VALID_WORKSPACE = `
packages:
  - 'apps/*'
minimumReleaseAge: 10080
`;

const VALID_MANIFEST = { name: 'orcaops', private: true };

const tempRoots = [];

/** Writes a valid four-file fixture set, then applies per-file overrides. */
function makeRepo(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dependency-policy-'));
  tempRoots.push(root);

  const files = {
    'config/dependency-policy.json': VALID_POLICY,
    '.syncpackrc.json': VALID_SYNCPACK,
    '.github/dependabot.yml': VALID_DEPENDABOT,
    'pnpm-workspace.yaml': VALID_WORKSPACE,
    'package.json': VALID_MANIFEST,
    ...overrides,
  };

  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue; // null means "this file does not exist"
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

/** Deep-ish clone of the valid policy so a test can mutate one field. */
const policyWith = (mutate) => {
  const p = structuredClone(VALID_POLICY);
  mutate(p);
  return p;
};

const errorsFrom = (overrides) => checkDependencyPolicy(makeRepo(overrides)).errors;
const matching = (errors, re) => errors.filter((e) => re.test(e));

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe('the checked-in repository configuration', () => {
  it('passes with no errors', () => {
    expect(checkDependencyPolicy(repoRoot).errors).toEqual([]);
  });
});

describe('a valid fixture set', () => {
  it('passes with no errors', () => {
    expect(errorsFrom({})).toEqual([]);
  });

  it('excludes $LOCAL with workspace:* from the external-pin invariant', () => {
    // $LOCAL/workspace:* is a layout rule, not an external version pin. It must
    // not demand a policy entry, and must never become a Dependabot ignore.
    const errors = errorsFrom({});
    expect(matching(errors, /\$LOCAL|workspace:\*/)).toEqual([]);
  });

  it('does not treat an exact manifest pin as manual management', () => {
    // turbo and @types/node are exact-pinned but absent from the policy; only
    // an explicit entry takes a dependency out of automation.
    expect(matching(errorsFrom({}), /turbo|@types\/node/)).toEqual([]);
  });
});

describe('manually managed dependency entries', () => {
  it('rejects a syncpack pin with no policy entry', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        p.manuallyManagedDependencies = p.manuallyManagedDependencies.filter(
          (d) => d.dependency !== 'typescript'
        );
      }),
    });
    expect(matching(errors, /pins "typescript" but it has no policy entry/)).toHaveLength(1);
  });

  it('rejects a syncpack-pin entry whose syncpack rule was removed', () => {
    const errors = errorsFrom({
      '.syncpackrc.json': {
        versionGroups: VALID_SYNCPACK.versionGroups.filter(
          (g) => !(g.dependencies ?? []).includes('typescript')
        ),
      },
    });
    expect(
      matching(errors, /claims source "syncpack-pin" but no concrete pinVersion rule/)
    ).toHaveLength(1);
  });

  it('rejects a syncpack-pinned dependency recorded under the wrong source', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        p.manuallyManagedDependencies[0].source = 'manual';
      }),
    });
    expect(
      matching(errors, /pinned by \.syncpackrc\.json but its policy source is "manual"/)
    ).toHaveLength(1);
  });

  it('rejects a wildcard policy entry', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        p.manuallyManagedDependencies[1].dependency = '@opentui/*';
      }),
    });
    expect(matching(errors, /is a wildcard/)).not.toHaveLength(0);
  });

  it('rejects a duplicate policy dependency', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        p.manuallyManagedDependencies.push({ ...p.manuallyManagedDependencies[1] });
      }),
    });
    expect(matching(errors, /is declared more than once/)).toHaveLength(1);
  });

  it.each([
    ['owner', /has no "owner"/],
    ['rationale', /has no "rationale"/],
    ['source', /has no "source"/],
  ])('rejects a missing %s', (field, re) => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        delete p.manuallyManagedDependencies[1][field];
      }),
    });
    expect(matching(errors, re)).toHaveLength(1);
  });

  it.each([
    ['an absent evidence key', undefined],
    ['an empty evidence list', []],
  ])('rejects %s', (_label, value) => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        if (value === undefined) delete p.manuallyManagedDependencies[1].evidence;
        else p.manuallyManagedDependencies[1].evidence = value;
      }),
    });
    expect(matching(errors, /needs at least one "evidence" reference/)).toHaveLength(1);
  });

  it('rejects an unknown source value', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        p.manuallyManagedDependencies[1].source = 'other';
      }),
    });
    expect(matching(errors, /has source "other"/)).toHaveLength(1);
    expect(errors.join('\n')).toMatch(/no generic source/);
  });

  it('rejects an unsupported entry key', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        p.manuallyManagedDependencies[1].versions = '>=0.2.0';
      }),
    });
    expect(matching(errors, /unsupported key\(s\) "versions"/)).toHaveLength(1);
  });
});

describe('the Dependabot ignore list', () => {
  it('rejects a policy entry with no matching ignore', () => {
    const errors = errorsFrom({
      '.github/dependabot.yml': VALID_DEPENDABOT.replace(
        "      - dependency-name: '@opentui/core'\n",
        ''
      ),
    });
    expect(
      matching(errors, /declares "@opentui\/core" manually managed but .* does not ignore it/)
    ).toHaveLength(1);
  });

  it('rejects an ignore with no matching policy entry', () => {
    const errors = errorsFrom({
      '.github/dependabot.yml': VALID_DEPENDABOT.replace(
        "      - dependency-name: '@opentui/core'",
        "      - dependency-name: '@opentui/core'\n      - dependency-name: 'esbuild'"
      ),
    });
    expect(matching(errors, /ignores "esbuild" but .* has no entry for it/)).toHaveLength(1);
  });

  it('rejects a wildcard ignore name', () => {
    const errors = errorsFrom({
      '.github/dependabot.yml': VALID_DEPENDABOT.replace(
        "- dependency-name: '@opentui/core'",
        "- dependency-name: '@opentui/*'"
      ),
    });
    expect(matching(errors, /is a wildcard\. Ignore dependencies by exact name/)).toHaveLength(1);
  });

  it.each([
    ['a version range', "        versions: ['>=0.2.0']"],
    ['an update-type exception', "        update-types: ['version-update:semver-major']"],
  ])('rejects an ignore carrying %s', (_label, extraLine) => {
    const errors = errorsFrom({
      '.github/dependabot.yml': VALID_DEPENDABOT.replace(
        "      - dependency-name: '@opentui/core'",
        `      - dependency-name: '@opentui/core'\n${extraLine}`
      ),
    });
    expect(matching(errors, /whole-dependency ignores only/)).toHaveLength(1);
  });

  it('rejects duplicate npm update blocks', () => {
    const errors = errorsFrom({
      '.github/dependabot.yml': `${VALID_DEPENDABOT}
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'weekly'
`,
    });
    expect(matching(errors, /2 npm update blocks/)).toHaveLength(1);
  });

  it('rejects a missing npm update block', () => {
    const errors = errorsFrom({
      '.github/dependabot.yml': `
version: 2
updates:
  - package-ecosystem: 'github-actions'
    directory: '/'
    schedule:
      interval: 'monthly'
`,
    });
    expect(matching(errors, /no npm update block/)).toHaveLength(1);
  });

  it('rejects a malformed ignore entry', () => {
    const errors = errorsFrom({
      '.github/dependabot.yml': VALID_DEPENDABOT.replace(
        "      - dependency-name: '@opentui/core'",
        '      - just-a-string'
      ),
    });
    expect(matching(errors, /is not a mapping/)).toHaveLength(1);
  });
});

describe('advisory exceptions', () => {
  const exception = (over = {}) => ({
    ghsa: 'GHSA-7fh5-64p2-3v2j',
    owner: '@orcaops/maintainers',
    rationale: 'No fixed release is published yet.',
    expiresOn: '2099-01-01',
    evidence: ['https://github.com/advisories/GHSA-7fh5-64p2-3v2j'],
    ...over,
  });
  const withExceptions = (...list) =>
    policyWith((p) => {
      p.advisoryExceptions = list;
    });

  it('accepts a well-formed exception', () => {
    expect(errorsFrom({ 'config/dependency-policy.json': withExceptions(exception()) })).toEqual(
      []
    );
  });

  it('accepts an expired but structurally valid exception', () => {
    // Temporal expiry is the audit runner's job. Failing here would block
    // unrelated feature PRs the moment a date rolls over.
    const errors = errorsFrom({
      'config/dependency-policy.json': withExceptions(exception({ expiresOn: '2020-01-01' })),
    });
    expect(errors).toEqual([]);
  });

  it('rejects a duplicate GHSA identifier', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': withExceptions(exception(), exception()),
    });
    expect(matching(errors, /is excepted more than once/)).toHaveLength(1);
  });

  it.each([
    ['a CVE identifier', 'CVE-2024-12345'],
    ['a wildcard', 'GHSA-*'],
    ['a bare package name', 'lodash'],
    ['the wrong group count', 'GHSA-7fh5-64p2'],
    ['a character outside the GHSA alphabet', 'GHSA-7fh5-64p2-3v2z'],
    ['an empty string', ''],
  ])('rejects %s', (_label, ghsa) => {
    const errors = errorsFrom({
      'config/dependency-policy.json': withExceptions(exception({ ghsa })),
    });
    expect(matching(errors, /not a valid GHSA identifier|is missing "ghsa"/)).toHaveLength(1);
  });

  it.each([
    ['owner', /has no "owner"/],
    ['rationale', /has no "rationale"/],
    ['expiresOn', /has no "expiresOn"/],
  ])('rejects a missing %s', (field, re) => {
    const errors = errorsFrom({
      'config/dependency-policy.json': withExceptions(exception({ [field]: undefined })),
    });
    expect(matching(errors, re)).toHaveLength(1);
  });

  it('rejects missing evidence', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': withExceptions(exception({ evidence: [] })),
    });
    expect(matching(errors, /needs at least one "evidence" reference/)).toHaveLength(1);
  });

  it.each([
    ['a non-calendar day', '2026-02-30'],
    ['a month out of range', '2026-13-01'],
    ['a non-ISO order', '01-01-2026'],
    ['a timestamp', '2026-01-01T00:00:00Z'],
    ['prose', 'never'],
  ])('rejects an expiry that is %s', (_label, expiresOn) => {
    const errors = errorsFrom({
      'config/dependency-policy.json': withExceptions(exception({ expiresOn })),
    });
    expect(matching(errors, /is not a real YYYY-MM-DD calendar date/)).toHaveLength(1);
  });

  it.each([
    ['a package-wide exception', { package: 'lodash' }],
    ['a severity-wide exception', { severity: 'moderate' }],
    ['a CVE-keyed exception', { cve: 'CVE-2024-12345' }],
    ['a permanent exception', { permanent: true }],
  ])('rejects %s', (_label, extraKey) => {
    const errors = errorsFrom({
      'config/dependency-policy.json': withExceptions(exception(extraKey)),
    });
    expect(matching(errors, /unsupported key\(s\)/)).toHaveLength(1);
  });
});

describe('pnpm-level audit suppression', () => {
  it.each([
    ['ignoreGhsas', "auditConfig:\n  ignoreGhsas:\n    - 'GHSA-7fh5-64p2-3v2j'"],
    ['ignoreCves', "auditConfig:\n  ignoreCves:\n    - 'CVE-2024-12345'"],
    ['an unrecognized auditConfig key', 'auditConfig:\n  somethingElse: true'],
  ])('rejects %s in pnpm-workspace.yaml', (_label, block) => {
    const errors = errorsFrom({ 'pnpm-workspace.yaml': `${VALID_WORKSPACE}\n${block}\n` });
    expect(matching(errors, /pnpm-workspace\.yaml: remove "auditConfig"/)).toHaveLength(1);
  });

  it('rejects auditConfig relocated into the package.json pnpm field', () => {
    // pnpm reads auditConfig from both places; checking only the workspace file
    // would leave the invariant defeatable by moving the keys one file over.
    const errors = errorsFrom({
      'package.json': {
        ...VALID_MANIFEST,
        pnpm: { auditConfig: { ignoreGhsas: ['GHSA-7fh5-64p2-3v2j'] } },
      },
    });
    expect(
      matching(errors, /package\.json \(pnpm\.auditConfig\): remove "auditConfig"/)
    ).toHaveLength(1);
  });

  it('does not fire on a comment naming the forbidden keys', () => {
    const errors = errorsFrom({
      'pnpm-workspace.yaml': `# Deliberately no auditConfig.ignoreGhsas/ignoreCves here.\n${VALID_WORKSPACE}`,
    });
    expect(matching(errors, /auditConfig/)).toEqual([]);
  });
});

describe('unparseable and missing inputs', () => {
  it('reports malformed YAML', () => {
    const errors = errorsFrom({ '.github/dependabot.yml': 'updates: [\n  - broken: "unclosed\n' });
    expect(matching(errors, /\.github\/dependabot\.yml: could not be parsed/)).toHaveLength(1);
  });

  it('reports malformed JSON', () => {
    const errors = errorsFrom({ 'config/dependency-policy.json': '{ "schemaVersion": 1, }' });
    expect(matching(errors, /dependency-policy\.json: could not be parsed/)).toHaveLength(1);
  });

  it('reports a missing file rather than throwing', () => {
    const errors = errorsFrom({ 'config/dependency-policy.json': null });
    expect(matching(errors, /dependency-policy\.json: file not found/)).toHaveLength(1);
  });

  it('still reports pnpm audit suppression when the policy file is unreadable', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': null,
      'pnpm-workspace.yaml': `${VALID_WORKSPACE}\nauditConfig:\n  ignoreGhsas: []\n`,
    });
    expect(matching(errors, /remove "auditConfig"/)).toHaveLength(1);
  });
});

describe('the policy schema version', () => {
  it.each([
    ['a newer version', 2],
    ['zero', 0],
    ['the supported number written as a string', '1'],
    ['an absent version', undefined],
  ])('rejects %s', (_label, schemaVersion) => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        if (schemaVersion === undefined) delete p.schemaVersion;
        else p.schemaVersion = schemaVersion;
      }),
    });
    expect(matching(errors, /is not supported/)).toHaveLength(1);
  });

  it('rejects an unsupported top-level key', () => {
    const errors = errorsFrom({
      'config/dependency-policy.json': policyWith((p) => {
        p.ignoredAdvisories = [];
      }),
    });
    expect(matching(errors, /unsupported top-level key\(s\) "ignoredAdvisories"/)).toHaveLength(1);
  });
});
