import { describe, expect, it } from 'vitest';

import { scrubError } from './scrub-error.js';

describe('scrubError', () => {
  it('redacts Authorization: Bearer header values', () => {
    const out = scrubError('GET /api failed: Authorization: Bearer abc123def456ghi at line 1');
    expect(out).not.toContain('abc123def456ghi');
    expect(out).toMatch(/[Aa]uthorization: \[REDACTED_SECRET\]/);
  });

  it('redacts Bearer-shaped substrings outside header context', () => {
    const out = scrubError('Got token "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" rejected');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('Bearer [REDACTED_SECRET]');
  });

  it('redacts JWT-shaped triples', () => {
    // Realistic HS256 JWT shape: 20-char header + 36-char payload + 43-char
    // signature, all base64url. The pattern's 16-char per-segment floor is
    // safely below all three.
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjE3MzAwMDAwMDB9' +
      '.dGhpcy1pcy1hLWZha2Utc2lnbmF0dXJlLWZvci10ZXN0aW5n';
    const out = scrubError(`cookie session=${jwt}`);
    expect(out).toContain('[REDACTED_SECRET]');
    expect(out).not.toContain(jwt);
  });

  it('redacts JWTs with `-` at segment boundaries (dash is base64url, not a word char)', () => {
    // \b is defined against [A-Za-z0-9_]; `-` is non-word, so the prior
    // \b…\b anchor would silently miss tokens ending on `-` or sitting
    // adjacent to a `-`. Verify the lookaround replacement catches them.
    // Each segment is ≥16 chars (the realistic JWT floor) with `-` placed
    // at boundaries and internally.
    const cases = [
      'token=-eyJhbGciOiJIUzI1Ni.eyJzdWIiOiJ1c2VyLTEi.dGhpcy1pcy1hLWZha2Utc2ln-',
      'leading-dash-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEi.dGhpcy1pcy1hLWZha2Utc2ln',
      'trailing-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEi.dGhpcy1pcy1hLWZha2Utc2ln-suffix',
      'segments-with-eyJhbGc-iOiJIUzI1Ni.eyJzdW-IiOiJ1c2VyLT.dGhpcy-1pcy1hLWZha2U-internal',
    ];
    for (const input of cases) {
      const out = scrubError(input);
      expect(out, `failed to redact: ${input}`).toContain('[REDACTED_SECRET]');
    }
  });

  it('does NOT over-redact dotted identifiers below the realistic JWT floor', () => {
    // The 16-char per-segment floor is calibrated to exclude common dotted
    // identifiers found in error text. None of these should match the JWT
    // pattern; if any do, the floor needs to go up further.
    const cases = [
      'failed to read file.path.txt: ENOENT', // short segments
      'event=github.actions.workflow_dispatch', // 6/7/17 — third matches but only triple matches
      'module path: package.subpath.modulename', // each <16
      'hostname api.example.com refused', // 3/7/3
      'org-name.repo-name.branch-name in workflow', // 8/9/11
      'imported from @orcaops/core/cloud/scrub-error', // single dotted — not three segments
    ];
    for (const input of cases) {
      expect(scrubError(input), `over-redacted: ${input}`).toBe(input);
    }
  });

  it('does NOT over-redact when only one or two segments hit the floor', () => {
    // The pattern requires THREE consecutive 16+ char segments. Two long
    // segments next to a short one must not match.
    const out = scrubError('long_first_segment_here.long_second_segment_here.short');
    expect(out).toBe('long_first_segment_here.long_second_segment_here.short');
  });

  it('redacts secret query params (token, access_token, api_key, key)', () => {
    const out = scrubError(
      'GET /a?token=secretvalue&access_token=other&api_key=k1&key=k2&page=1 → 403'
    );
    expect(out).not.toContain('secretvalue');
    expect(out).not.toContain('other');
    expect(out).not.toContain('k1');
    expect(out).not.toContain('k2');
    // benign param survives
    expect(out).toContain('page=1');
  });

  it('preserves status codes and error class names', () => {
    const out = scrubError('TrpcRequestError: 502 Bad Gateway from upstream');
    expect(out).toContain('502');
    expect(out).toContain('TrpcRequestError');
  });

  it('caps disclosed content at 200 chars and says it truncated', () => {
    const long = 'a'.repeat(500);
    const out = scrubError(long);
    expect(out).toHaveLength(200);
    expect(out).toBe(`${'a'.repeat(188)}…[truncated]`);
  });

  it('is idempotent (scrubbing twice yields the same output)', () => {
    const input = 'Auth header: Authorization: Bearer xxxxxxxxx errored';
    const once = scrubError(input);
    const twice = scrubError(once);
    expect(twice).toBe(once);
  });

  it('returns the input unchanged when no known shapes are present', () => {
    const input = 'plain prose error from a network timeout, no secrets here';
    expect(scrubError(input)).toBe(input);
  });

  it('discloses when terminal formatting removes the entire diagnostic', () => {
    expect(scrubError('\u001b[31m')).toBe('[diagnostic removed]');
    expect(scrubError(' \u001b[31m')).toBe('[diagnostic removed]');
  });

  it('preserves an actually empty diagnostic', () => {
    expect(scrubError('')).toBe('');
    expect(scrubError(' ')).toBe(' ');
  });
});

describe('does not eat identifiers that appear in AUTHORED messages', () => {
  // Now that authored CLI messages pass through the scrubber, a false
  // positive costs a diagnostic. These are the shapes those messages
  // actually carry.
  it('leaves artifact ids, step ids, and criterion ids intact', () => {
    const msg =
      'No artifact with id "019fbf11-9ce0-7793-bd50-8476e6fac30c"; ' +
      'step 019fc013-a305-7dab-a3ed-7a14796161c5 is uncovered';
    expect(scrubError(msg)).toBe(msg);
  });

  it('leaves git SHAs intact, including a dotted pair', () => {
    const sha = 'd167a165c0ffee1234567890abcdef0123456789';
    const msg = `base ${sha} is not an ancestor of ${sha}`;
    expect(scrubError(msg)).toBe(msg);
    // Dotted range syntax is the shape closest to a JWT triple.
    const range = `${sha}...${sha}`;
    expect(scrubError(range)).toBe(range);
  });

  it('leaves dotted file and package names intact', () => {
    const msg = 'failed to read packages/evaluator-runner/src/discovery/validate-pack.test.ts';
    expect(scrubError(msg)).toBe(msg);
  });

  it('leaves URLs with ports and paths intact', () => {
    const msg =
      'Several clouds are configured: https://development-cluster.corporate-platform.internal-services:8443/api ' +
      'and https://staging-cluster.corporate-platform.internal-services:9443/api.';
    expect(scrubError(msg)).toBe(msg);
  });

  it('leaves a plain base URL intact', () => {
    const msg = 'Not connected to https://api.orcaops.ai. Run `orcaops login` first.';
    expect(scrubError(msg)).toBe(msg);
  });

  it('still redacts a real JWT embedded in an otherwise authored message', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = scrubError(`upstream said: ${jwt}`);
    expect(out).not.toContain(jwt);
  });
});
