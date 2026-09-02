import { describe, expect, it } from 'vitest';

import { SECRET_NEGATIVES, SECRET_POSITIVES } from '@orcaops/evaluator-protocol/secret-corpus';
import { findSecretLocations } from '@orcaops/evaluator-protocol/secrets';

import {
  assertNoSecretsInPayload,
  collectSecretPaths,
  SecretInPayloadError,
} from './secret-guard.js';

const GITHUB_TOKEN = 'ghp_0000000000000000000000000000000000000';
const FIXTURE_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('collectSecretPaths — JSON paths an agent can act on', () => {
  it('reports a nested array-of-objects path exactly', () => {
    const payload = {
      plan_steps: [
        { text: 'clean' },
        { text: 'oops', acceptance_criteria: [{ text: 'a' }, { text: GITHUB_TOKEN }] },
      ],
    };
    expect(collectSecretPaths(payload, '', []).map((f) => f.path)).toEqual([
      'plan_steps[1].acceptance_criteria[1].text',
    ]);
  });

  it('reports a bare string at the root', () => {
    expect(collectSecretPaths(GITHUB_TOKEN, '', [])[0]?.path).toBe('(root)');
  });

  it('walks object keys, not just values', () => {
    const finding = collectSecretPaths({ [GITHUB_TOKEN]: 'value' }, '', [])[0];
    expect(finding?.patterns).toContain('github-token');
  });

  it('redacts a secret-shaped key out of the path it reports', () => {
    // The key becomes the path, so an un-redacted one would make the report
    // restate the credential it refused.
    const finding = collectSecretPaths({ [GITHUB_TOKEN]: 'value' }, '', [])[0];
    expect(finding?.path).not.toContain(GITHUB_TOKEN);
    expect(finding?.path).toBe('{key [REDACTED_SECRET]}');
  });

  it('keeps a token hidden from the gate but healed by the store out of writes', () => {
    // `findSecretLocations` normalizes with `stripTerminalFormatting`, the
    // store with `stripControlChars`. A byte only the store removes would
    // otherwise clear the gate and be persisted as a live credential.
    const split = `gh${String.fromCharCode(0x9b)}p_0000000000000000000000000000000000000`;
    expect(collectSecretPaths({ field: split }, '', [])[0]?.tier).toBe('refuse');
  });

  it('returns one merged finding per string, not one per match', () => {
    const findings = collectSecretPaths({ summary: `${GITHUB_TOKEN} and ${FIXTURE_JWT}` }, '', []);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.patterns).toEqual(expect.arrayContaining(['github-token', 'jwt']));
    expect(findings[0]?.tier).toBe('refuse');
  });

  it('finds nothing in a clean payload', () => {
    expect(
      collectSecretPaths({ summary: 'wired the middleware', steps: ['a', 'b'] }, '', [])
    ).toEqual([]);
  });
});

describe('collectSecretPaths — tiers', () => {
  it('classifies a vendor-prefixed token as refuse', () => {
    expect(collectSecretPaths({ s: GITHUB_TOKEN }, '', [])[0]?.tier).toBe('refuse');
  });

  it('classifies a JWT fixture as warn, so quoted test evidence is not blocked', () => {
    expect(collectSecretPaths({ evidence: FIXTURE_JWT }, '', [])[0]?.tier).toBe('warn');
  });

  it('classifies a TypeScript type annotation as warn', () => {
    const finding = collectSecretPaths(
      { s: 'const token: HeldToken = { live: true };' },
      '',
      []
    )[0];
    expect(finding?.tier).toBe('warn');
  });
});

describe('assertNoSecretsInPayload', () => {
  it('throws on a refuse-tier finding and carries every refusal', () => {
    const payload = { a: GITHUB_TOKEN, b: 'AKIA0000000000000000' };
    let error: unknown;
    try {
      assertNoSecretsInPayload(payload, []);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SecretInPayloadError);
    expect((error as SecretInPayloadError).findings.map((f) => f.path)).toEqual(['a', 'b']);
  });

  it('returns warn-tier findings instead of throwing', () => {
    const findings = assertNoSecretsInPayload({ evidence: FIXTURE_JWT }, []);
    expect(findings.map((f) => f.tier)).toEqual(['warn']);
  });

  it('returns nothing for a clean payload', () => {
    expect(assertNoSecretsInPayload({ summary: 'no secrets here' }, [])).toEqual([]);
  });
});

describe('the report never carries the secret', () => {
  /**
   * The VALUE half of a sample, which is the part that must never be echoed.
   * An author-written label before a `:` or `=` is deliberately reported as
   * `keyPrefix` so an agent can locate the field, so probing a sample's
   * leading characters would flag that locator rather than a disclosure.
   */
  const secretHalf = (sample: string): string => {
    const assignment = /^[A-Za-z0-9_.$-]{1,30}\s*[:=]\s*["']?/u.exec(sample);
    const value = assignment === null ? sample : sample.slice(assignment[0].length);
    return value.slice(0, Math.min(20, value.length));
  };

  it.each(SECRET_POSITIVES.map((s) => [s.name, s.sample] as const))(
    'omits the %s value from findings and any thrown message',
    (_name, sample) => {
      const probe = secretHalf(sample);
      expect(probe.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(collectSecretPaths({ field: sample }, '', []));
      expect(serialized).not.toContain(probe);

      let thrown = '';
      try {
        assertNoSecretsInPayload({ field: sample }, []);
      } catch (err) {
        thrown = (err as Error).message;
        expect(thrown).not.toContain(probe);
      }

      const locations = findSecretLocations(sample);
      expect(locations.length).toBeGreaterThan(0);
      for (const { start, end } of locations) {
        // Every window of the matched run, not a leading probe: the
        // prefix-only form above passed a report that echoed the tail or the
        // middle of a value. The span is the value alone — it begins after
        // any assignment key — so a path that names the key is not mistaken
        // for a disclosure.
        const run = sample.slice(start, end);
        const width = Math.min(8, run.length);
        for (let i = 0; i + width <= run.length; i += 1) {
          const window = run.slice(i, i + width);
          expect(serialized).not.toContain(window);
          expect(thrown).not.toContain(window);
        }
      }
    }
  );

  it('names the assignment key in the path without quoting the value', () => {
    const value = 'aws_secret_access_key=0000000000000000000000000000000000000000';
    const serialized = JSON.stringify(collectSecretPaths({ aws_secret_access_key: value }, '', []));
    expect(serialized).toContain('aws_secret_access_key');

    const locations = findSecretLocations(value);
    expect(locations.length).toBeGreaterThan(0);
    for (const { start, end } of locations) {
      expect(value.slice(start, end)).toBe('0'.repeat(40));
    }
  });
});

describe('shared corpus', () => {
  it.each(SECRET_POSITIVES.map((s) => [s.name, s.sample, s.tier] as const))(
    'detects %s at the corpus tier',
    (_name, sample, tier) => {
      const findings = collectSecretPaths({ field: sample }, '', []);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.tier).toBe(tier);
    }
  );

  it.each(SECRET_NEGATIVES.map((s) => [s] as const))('leaves %s alone', (sample) => {
    expect(collectSecretPaths({ field: sample }, '', [])).toEqual([]);
  });
});

describe('keyPrefix — locate without disclosing', () => {
  it('reports the assignment label an author wrote', () => {
    const finding = collectSecretPaths(
      {
        s: 'api_key=0000000000000000000000000000000000000000',
      },
      '',
      []
    )[0];
    expect(finding?.keyPrefix).toBe('api_key=');
  });

  it('reports a colon-style label', () => {
    const finding = collectSecretPaths(
      { s: 'const token: HeldToken = { live: true };' },
      '',
      []
    )[0];
    expect(finding?.keyPrefix).toBe('token:');
  });

  it('omits it for a shape that is its own prefix', () => {
    expect(collectSecretPaths({ s: GITHUB_TOKEN }, '', [])[0]?.keyPrefix).toBeUndefined();
  });

  it('never returns a fragment of the secret itself', () => {
    for (const { sample } of SECRET_POSITIVES) {
      const prefix = collectSecretPaths({ field: sample }, '', [])[0]?.keyPrefix;
      if (prefix === undefined) continue;
      // Structural guarantee: an identifier run then a single `:` or `=`.
      // Nothing else can appear, so a URL path or a value fragment cannot.
      expect(prefix).toMatch(/^[A-Za-z0-9_.$-]{1,30}[:=]$/);
    }
  });
});

describe('redact.allow — the human-set escape hatch', () => {
  const AWS_EXAMPLE = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const OTHER = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';

  it('exempts the exact detected run and reports nothing at all', () => {
    const payload = { evidence: `aws_secret_access_key=${AWS_EXAMPLE}` };
    expect(collectSecretPaths(payload, '', [])).not.toEqual([]);
    expect(collectSecretPaths(payload, '', [AWS_EXAMPLE])).toEqual([]);
    expect(assertNoSecretsInPayload(payload, [AWS_EXAMPLE])).toEqual([]);
  });

  it('still refuses a different secret in the same payload', () => {
    const payload = { a: `aws_secret_access_key=${AWS_EXAMPLE}`, b: OTHER };
    let error: unknown;
    try {
      assertNoSecretsInPayload(payload, [AWS_EXAMPLE]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SecretInPayloadError);
    expect((error as SecretInPayloadError).findings.map((f) => f.path)).toEqual(['b']);
  });

  it('cannot exempt a value it does not exactly equal', () => {
    // A near-miss must not widen: no prefix, substring or case-insensitive
    // matching, or an entry would start covering strings nobody vetted.
    const payload = { s: `aws_secret_access_key=${AWS_EXAMPLE}` };
    for (const nearMiss of [
      AWS_EXAMPLE.slice(0, -1),
      AWS_EXAMPLE.toLowerCase(),
      `${AWS_EXAMPLE}X`,
      'aws_secret_access_key',
    ]) {
      expect(collectSecretPaths(payload, '', [nearMiss])).not.toEqual([]);
    }
  });

  it('exempts nothing when the allowlist is empty', () => {
    expect(collectSecretPaths({ s: OTHER }, '', [])).not.toEqual([]);
  });
});
