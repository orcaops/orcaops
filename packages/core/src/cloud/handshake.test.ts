import { describe, expect, it } from 'vitest';

import { ORCAOPS_CAPABILITIES } from '@orcaops/protocol';

import {
  assertCloudSupports,
  CloudCapabilityError,
  compareSemver,
  parseStrictSemver,
} from './handshake.js';

/** A current handshake from a cloud that advertises everything. */
function handshake(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server_version: '1.4.0',
    protocol_version: '0.0.21',
    min_cli_version: '0.0.1',
    min_protocol_version: '0.0.1',
    capabilities: Object.values(ORCAOPS_CAPABILITIES),
    ...over,
  };
}

/** Pin both version axes so a test never depends on the shipped constants. */
const AT_VERSION = { cliVersion: '0.0.5', protocolVersion: '0.0.21' };

function refusalFrom(fn: () => unknown): CloudCapabilityError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CloudCapabilityError) return err;
    throw err;
  }
  throw new Error('expected a CloudCapabilityError, but the call returned');
}

describe('assertCloudSupports', () => {
  it('returns the parsed handshake when the required capability is advertised', () => {
    const result = assertCloudSupports(
      { handshake: handshake() },
      [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
      'plan review push',
      AT_VERSION
    );
    expect(result.server_version).toBe('1.4.0');
  });

  it('requires nothing of the capability list when the operation needs none', () => {
    expect(() =>
      assertCloudSupports(
        { handshake: handshake({ capabilities: [] }) },
        [],
        'review status',
        AT_VERSION
      )
    ).not.toThrow();
  });
});

// A newer CLI talking to a cloud that has not caught up. The cloud is
// reachable and authenticates fine; it simply does not offer the operation.
describe('new client against an older server', () => {
  it('refuses when the advertised set omits the capability, naming the missing one', () => {
    const err = refusalFrom(() =>
      assertCloudSupports(
        { handshake: handshake({ capabilities: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW] }) },
        [ORCAOPS_CAPABILITIES.REVIEWER_DISCOVERY],
        'plan review reviewers',
        AT_VERSION
      )
    );
    expect(err.kind).toBe('server-behind');
    expect(err.message).toContain(ORCAOPS_CAPABILITIES.REVIEWER_DISCOVERY);
  });

  it('names every missing capability, not just the first', () => {
    const err = refusalFrom(() =>
      assertCloudSupports(
        { handshake: handshake({ capabilities: [] }) },
        [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW, ORCAOPS_CAPABILITIES.REVIEW_VERSION_PULL],
        'plan review pull',
        AT_VERSION
      )
    );
    expect(err.message).toContain(ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW);
    expect(err.message).toContain(ORCAOPS_CAPABILITIES.REVIEW_VERSION_PULL);
  });
});

// The opposite direction, kept deliberately separate: here the CLIENT is the
// outdated side. The cloud advertises a floor this build cannot meet, which is
// an upgrade problem, not a deployment-skew problem.
describe('client below the server floor', () => {
  it('refuses a CLI below the advertised minimum', () => {
    const err = refusalFrom(() =>
      assertCloudSupports(
        { handshake: handshake({ min_cli_version: '2.0.0' }) },
        [],
        'plan review push',
        AT_VERSION
      )
    );
    expect(err.kind).toBe('upgrade-required');
    expect(err.message).toContain('CLI >= 2.0.0');
  });

  it('refuses a protocol below the advertised minimum', () => {
    const err = refusalFrom(() =>
      assertCloudSupports(
        { handshake: handshake({ min_protocol_version: '9.0.0' }) },
        [],
        'plan review push',
        AT_VERSION
      )
    );
    expect(err.kind).toBe('upgrade-required');
    expect(err.message).toContain('protocol >= 9.0.0');
  });

  it('refuses when the client reports no CLI version', () => {
    const err = refusalFrom(() =>
      assertCloudSupports(
        { handshake: handshake({ min_cli_version: '1.0.0' }) },
        [],
        'plan review push',
        {
          cliVersion: null,
          protocolVersion: '0.0.21',
        }
      )
    );
    expect(err.kind).toBe('upgrade-required');
    expect(err.message).toContain('reports no CLI version');
  });

  it('refuses a prerelease below the advertised release floor', () => {
    const err = refusalFrom(() =>
      assertCloudSupports({ handshake: handshake() }, [], 'plan review push', {
        cliVersion: '0.0.1-rc.1',
        protocolVersion: '0.0.21',
      })
    );
    expect(err.kind).toBe('upgrade-required');
  });
});

describe('unknown capability identifiers', () => {
  it('ignores identifiers it does not understand instead of refusing', () => {
    expect(() =>
      assertCloudSupports(
        {
          handshake: handshake({
            capabilities: [
              ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW,
              'time-travel/v9',
              'not-invented-yet/v1',
            ],
          }),
        },
        [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        'plan review push',
        AT_VERSION
      )
    ).not.toThrow();
  });

  it('accepts unknown keys elsewhere in the handshake block', () => {
    expect(() =>
      assertCloudSupports(
        { handshake: handshake({ future_field: { nested: true } }) },
        [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        'plan review push',
        AT_VERSION
      )
    ).not.toThrow();
  });
});

describe('malformed handshake', () => {
  it.each([
    ['a missing floor', { min_cli_version: undefined }],
    ['a non-array capability list', { capabilities: 'source-plan-review/v1' }],
    ['a non-string capability entry', { capabilities: [7] }],
    ['a missing protocol version', { protocol_version: undefined }],
  ])('refuses %s as wire-invalid', (_label, over) => {
    const block = handshake(over);
    for (const [key, value] of Object.entries(over)) {
      if (value === undefined) delete block[key];
    }
    const err = refusalFrom(() =>
      assertCloudSupports({ handshake: block }, [], 'plan review push', AT_VERSION)
    );
    expect(err.kind).toBe('wire-invalid');
  });

  it('refuses a handshake that is not an object', () => {
    const err = refusalFrom(() =>
      assertCloudSupports({ handshake: 'ok' }, [], 'plan review push', AT_VERSION)
    );
    expect(err.kind).toBe('wire-invalid');
  });

  it('refuses an advertised floor that is not strict semver', () => {
    const err = refusalFrom(() =>
      assertCloudSupports(
        { handshake: handshake({ min_cli_version: 'v1.2' }) },
        [],
        'plan review push',
        AT_VERSION
      )
    );
    expect(err.kind).toBe('wire-invalid');
    expect(err.message).toContain('not a strict semantic version');
  });
});

// The client and the cloud must rank versions identically; a disagreement is
// the very skew this gate exists to prevent. These pin the rules that differ
// from a naive numeric compare.
describe('strict semver precedence', () => {
  const cmp = (a: string, b: string): number => {
    const pa = parseStrictSemver(a);
    const pb = parseStrictSemver(b);
    if (!pa || !pb) throw new Error(`unparseable: ${a} / ${b}`);
    return Math.sign(compareSemver(pa, pb));
  };

  it('orders a prerelease below its release', () => {
    expect(cmp('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(cmp('1.0.0-rc.1', '1.0.0-rc.2')).toBe(-1);
    expect(cmp('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
  });

  it('gives a numeric prerelease identifier lower precedence than an alphanumeric one', () => {
    expect(cmp('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('treats a longer prerelease as higher when the shared identifiers match', () => {
    expect(cmp('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });

  it('excludes build metadata from precedence', () => {
    expect(cmp('1.0.0+build.7', '1.0.0')).toBe(0);
  });

  it('compares core parts exactly beyond the safe-integer range', () => {
    // The reason the comparator holds digit strings: as numbers these two are
    // indistinguishable, and the larger would not satisfy a floor set at the
    // smaller.
    expect(cmp('9007199254740993.0.0', '9007199254740992.0.0')).toBe(1);
  });

  it('rejects leading zeros, a `v` prefix, and partial versions', () => {
    expect(parseStrictSemver('01.0.0')).toBeNull();
    expect(parseStrictSemver('v1.0.0')).toBeNull();
    expect(parseStrictSemver('1.2')).toBeNull();
  });

  it('rejects a version longer than the wire cap', () => {
    expect(parseStrictSemver(`1.0.0-${'a'.repeat(64)}`)).toBeNull();
  });
});
