import { describe, expect, it } from 'vitest';

import { SECRET_NEGATIVES, SECRET_POSITIVES, VALUE_SHAPE_BOUNDARY } from './secret-corpus.js';
import {
  cutTruncatedSecretTail,
  findSecretLocations,
  PRIVATE_KEY_PATTERN_NAME,
  REDACTION_MARKER,
  redactSecrets,
  redactSecretsAndBound,
  redactSecretsInUnifiedDiff,
  redactSecretsInValue,
  scrubEvaluatorDiagnosticAndBound,
  scrubEvaluatorOutput,
  scrubEvaluatorOutputInValue,
  SECRET_PATTERNS,
  secretTierOf,
  STRONG_ASSIGNMENT_PATTERN_NAME,
} from './secrets.js';

/**
 * A byte cap applied before redaction is the failure these cover: the cut
 * destroys the match, so the redactor sees a fragment and passes it through.
 */
describe('cutTruncatedSecretTail', () => {
  const PEM_HEADER = '-----BEGIN RSA PRIVATE KEY-----';
  const body = (n: number): string => 'MIIEow' + 'A1b2C3d4E5'.repeat(n);

  it('drops an unterminated PEM block, header and all', () => {
    const text = `context line\n${PEM_HEADER}\n${body(500)}`;

    const out = cutTruncatedSecretTail(text);

    expect(out).not.toContain(PEM_HEADER);
    expect(out).not.toContain('MIIEow');
    expect(out).toContain('context line');
  });

  it('drops the enclosing JSON key of a severed service-account blob', () => {
    const text = `{"type":"service_account","private_key": "${PEM_HEADER}\\n${body(300)}`;
    const out = cutTruncatedSecretTail(text);
    expect(out).not.toContain('private_key');
    expect(out).not.toContain(PEM_HEADER);
    expect(out).toContain('service_account');
  });

  it('keeps a TERMINATED key block, which the redactor handles on its own', () => {
    const text = `${PEM_HEADER}\n${body(10)}\n-----END RSA PRIVATE KEY-----\ntrailing prose`;
    const out = cutTruncatedSecretTail(redactSecrets(text));
    expect(out).toContain('[REDACTED_SECRET]');
    expect(out).toContain('trailing prose');
  });

  it('drops a trailing token-shaped run that a cut left below its pattern length', () => {
    // Bare, with no `key=` prefix: the generic assignment patterns would
    // otherwise catch it and the precondition would be about the wrong thing.
    const severed = 'ghp_A1b2C3d4E5A1b2C3d4E5';
    const text = `authorization header follows\n${severed}`;
    expect(redactSecrets(text), 'precondition: too short to match').toContain(severed);
    expect(cutTruncatedSecretTail(text)).not.toContain(severed);
  });

  it('pins both bounds of a severed trailing token run', () => {
    const prefix = 'context\n';
    expect(cutTruncatedSecretTail(`${prefix}${'A'.repeat(19)}`)).toBe(`${prefix}${'A'.repeat(19)}`);
    expect(cutTruncatedSecretTail(`${prefix}${'A'.repeat(20)}`)).toBe(prefix);
    expect(cutTruncatedSecretTail(`${prefix}${'A'.repeat(128)}`)).toBe(prefix);
    expect(cutTruncatedSecretTail(`${prefix}${'A'.repeat(129)}`)).toBe(
      `${prefix}${'A'.repeat(129)}`
    );
  });

  it('does not rescan an earlier token-shaped run when the final character is ordinary text', () => {
    const text = `${'A'.repeat(100_000)}!`;
    const startedAt = performance.now();
    expect(cutTruncatedSecretTail(text)).toBe(text);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it('leaves ordinary prose alone', () => {
    const text = 'diff --git a/README.md b/README.md\n+a short line of prose.';
    expect(cutTruncatedSecretTail(text)).toBe(text);
  });

  it('is a no-op on empty input', () => {
    expect(cutTruncatedSecretTail('')).toBe('');
  });
});

describe('redactSecrets', () => {
  const PEM_HEADER = '-----BEGIN RSA PRIVATE KEY-----';

  it('redacts an unterminated private key instead of requiring a closing delimiter', () => {
    const secret = `${PEM_HEADER}\nMIIEowIBAAKCAQEA0000`;
    expect(redactSecrets(`before\n${secret}`)).toBe('before\n[REDACTED_SECRET]');
  });

  it('redacts adjacent private-key blocks independently', () => {
    const first = `${PEM_HEADER}\nfirst\n-----END RSA PRIVATE KEY-----`;
    const second = '-----BEGIN PRIVATE KEY-----\nsecond\n-----END PRIVATE KEY-----';
    expect(redactSecrets(`${first}\nbetween\n${second}`)).toBe(
      '[REDACTED_SECRET]\nbetween\n[REDACTED_SECRET]'
    );
  });

  it('ignores a mismatched terminator and redacts through the matching one', () => {
    const text = [
      PEM_HEADER,
      'first-part',
      '-----END EC PRIVATE KEY-----',
      'remaining-private-key-material',
      '-----END RSA PRIVATE KEY-----',
      'trailing prose',
    ].join('\n');

    expect(redactSecrets(text)).toBe('[REDACTED_SECRET]\ntrailing prose');
  });

  it('ignores a same-label terminator that is not a complete line', () => {
    const text = [
      PEM_HEADER,
      'first-part',
      '-----END RSA PRIVATE KEY-----not-a-valid-boundary',
      'remaining-private-key-material',
      '-----END RSA PRIVATE KEY-----',
      'trailing prose',
    ].join('\n');

    expect(redactSecrets(text)).toBe('[REDACTED_SECRET]\ntrailing prose');
  });

  it('requires odd backslash parity for JSON-escaped terminator boundaries', () => {
    const terminator = '-----END RSA PRIVATE KEY-----';
    const escapedBreak = '\\'.repeat(1) + 'n';
    const doubledEscape = '\\'.repeat(2) + 'n';
    const tripledEscape = '\\'.repeat(3) + 'n';
    const text =
      `${PEM_HEADER}${escapedBreak}first-part${doubledEscape}${terminator}\n` +
      `after-invalid-start\n${terminator}${doubledEscape}after-invalid-end\n` +
      `${terminator}${tripledEscape}remaining-private-key-material\n` +
      `${terminator}\ntrailing prose`;

    expect(redactSecrets(text)).toBe('[REDACTED_SECRET]\ntrailing prose');
  });

  it('redacts the captured value when it duplicates text in the assignment name', () => {
    expect(redactSecrets('aws_secret_access_key=aws_secret_access_key')).toBe(
      'aws_secret_access_key=[REDACTED_SECRET]'
    );
  });

  it('walks parsed JSON objects with an own constructor property', () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    const input = JSON.parse(`{"constructor":"poison","nested":{"detail":"${secret}"}}`) as unknown;

    expect(redactSecretsInValue(input)).toEqual({
      constructor: 'poison',
      nested: { detail: '[REDACTED_SECRET]' },
    });
  });

  it('scales linearly for adversarial private-key headers and ordinary control text', () => {
    const measure = (input: string): number => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const started = process.cpuUsage();
        redactSecrets(input);
        const elapsed = process.cpuUsage(started);
        samples.push((elapsed.user + elapsed.system) / 1000);
      }
      return samples.sort((a, b) => a - b)[1]!;
    };
    const smallCount = 25_000;
    const largeCount = smallCount * 2;
    const keyBlocks = (n: number): string =>
      `${PEM_HEADER}\nMIIEowIBAAKCAQEA0000\n-----END RSA PRIVATE KEY-----\n`.repeat(n);
    const cases = [
      {
        name: 'unterminated private keys',
        small: `${PEM_HEADER}\n`.repeat(smallCount),
        large: `${PEM_HEADER}\n`.repeat(largeCount),
      },
      {
        name: 'ordinary text',
        small: 'ordinary diagnostic text\n'.repeat(smallCount),
        large: 'ordinary diagnostic text\n'.repeat(largeCount),
      },
      {
        // Both cases above redact NOTHING, so they time the scan and never the
        // replacement. Terminated blocks are the redacting path, and it has to
        // scale too — an unbounded scan there would be just as quadratic.
        name: 'terminated private keys',
        small: keyBlocks(smallCount / 25),
        large: keyBlocks(largeCount / 25),
      },
    ];

    for (const input of cases) {
      const smallMs = measure(input.small);
      const largeMs = measure(input.large);
      expect(largeMs, input.name).toBeLessThan(smallMs * 3 + 25);
      expect(largeMs, input.name).toBeLessThan(1000);
    }
    // Begin markers with no key material between them are not a key, so this
    // input is left alone. Pin the redacting path alongside it, so the fast
    // path cannot become fast by simply redacting nothing.
    expect(redactSecrets(cases[0]!.large)).toBe(cases[0]!.large);
    const manyKeys = `${PEM_HEADER}\nMIIEowIBAAKCAQEA0000\n-----END RSA PRIVATE KEY-----\n`.repeat(
      1000
    );
    const redactedKeys = redactSecrets(manyKeys);
    expect(redactedKeys).not.toContain('MIIEowIBAAKCAQEA0000');
    expect(redactedKeys).toContain('[REDACTED_SECRET]');
  }, 5000);

  it('redacts before truncation so the bound cannot expose a partial token', () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    const out = redactSecretsAndBound(`prefix-${secret}-suffix`, 16);
    expect(out).not.toContain(secret.slice(0, 8));
    expect(out).toContain('[truncated]');
    expect(out).toHaveLength(16);
  });

  it('removes a diagnostic-only token split by a terminal control in full', () => {
    // The diagnostic set is stricter than the general one — an eight-character
    // bearer qualifies here and nowhere else — so it has to be collected in the
    // same coordinate space rather than layered on an already-rewritten string.
    // Layered, the marker replaced the `Bearer` the normalized pass needed and
    // the tail was emitted verbatim.
    const esc = String.fromCharCode(0x1b);
    const out = redactSecretsAndBound(`Bearer 00000000${esc}[0m0000EX`, 500);
    expect(out).toBe(`Bearer ${REDACTION_MARKER}`);
  });

  it.each([0, 1, 5, 12])('keeps tiny output bounds hard at %i characters', (maxLength) => {
    expect(redactSecretsAndBound('x'.repeat(50), maxLength)).toHaveLength(maxLength);
  });

  it('returns no content for a negative output bound', () => {
    expect(redactSecretsAndBound('x'.repeat(50), -1)).toBe('');
  });

  it('neutralizes terminal controls in persisted evaluator diagnostics', () => {
    const esc = String.fromCharCode(0x1b);
    const csi = String.fromCharCode(0x9b);
    const output = scrubEvaluatorDiagnosticAndBound(`before${esc}[2J${csi}2Jafter`, 100);

    expect(output).toBe('beforeafter');
    expect(output).not.toContain(esc);
    expect(output).not.toContain(csi);
  });

  it('redacts a secret whose shape is split by a terminal control', () => {
    const esc = String.fromCharCode(0x1b);
    const secret = 'ghp_0000000000000000000000000000000000000';
    const split = `${secret.slice(0, 20)}${esc}${secret.slice(20)}`;
    const output = scrubEvaluatorDiagnosticAndBound(split, 100);

    expect(output).toBe('[REDACTED_SECRET]');
    expect(output).not.toContain(secret);
  });

  it('maps a control-obfuscated secret back to its original span', () => {
    const esc = String.fromCharCode(0x1b);
    const secret = 'ghp_0000000000000000000000000000000000000';
    const split = `${secret.slice(0, 20)}${esc}${secret.slice(20)}`;

    expect(redactSecrets(`before ${split} after`)).toBe('before [REDACTED_SECRET] after');
    expect(scrubEvaluatorOutput(split)).toBe('[REDACTED_SECRET]');
    expect(scrubEvaluatorOutputInValue({ [split]: split })).toEqual({
      '[REDACTED_SECRET]': '[REDACTED_SECRET]',
    });
  });

  it('redacts a secret split by a complete ANSI sequence', () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    const split = `${secret.slice(0, 20)}\u001b[31m${secret.slice(20)}`;

    expect(redactSecrets(`before ${split} after`)).toBe('before [REDACTED_SECRET] after');
    expect(scrubEvaluatorOutput(split)).toBe('[REDACTED_SECRET]');
  });

  it('redacts a secret split by a CSI sequence containing embedded controls', () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    const split = `${secret.slice(0, 20)}\u001b[3\u00071\u007fm${secret.slice(20)}`;

    expect(scrubEvaluatorOutput(split)).toBe('[REDACTED_SECRET]');
  });

  it('does not reconstruct a carriage-return-split secret at a terminal boundary', () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    const split = `${secret.slice(0, 20)}\r${secret.slice(20)}`;

    expect(redactSecrets(`before ${split} after`)).toBe('before [REDACTED_SECRET] after');
  });

  it('preserves an assignment prefix while mapping an obfuscated captured value', () => {
    expect(redactSecrets('api_key=abcd\r1234 trailing')).toBe('api_key=[REDACTED_SECRET] trailing');
  });

  it('preserves carriage returns on generic redaction paths', () => {
    const text = 'diff --git a/file b/file\r\n-old\r\n+new\r\n';

    expect(redactSecrets(text)).toBe(text);
    expect(redactSecretsAndBound(text, text.length)).toBe(text);
    expect(redactSecretsInValue({ patch: text })).toEqual({ patch: text });
  });

  it('preserves terminal formatting adjacent to a generic redaction match', () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    const prefix = 'before \r\u001b[31m';

    expect(redactSecrets(`${prefix}${secret} after`)).toBe(`${prefix}[REDACTED_SECRET] after`);
  });

  it('leaves ordinary JSON keys intact while redacting their values', () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    expect(redactSecretsInValue({ [secret]: secret })).toEqual({
      [secret]: '[REDACTED_SECRET]',
    });
  });

  it('preserves evaluator values when redacted keys collide', () => {
    const first = 'ghp_0000000000000000000000000000000000000';
    const second = 'ghp_1111111111111111111111111111111111111';

    expect(scrubEvaluatorOutputInValue({ [first]: 1, [second]: 2 })).toEqual({
      '[REDACTED_SECRET]': 1,
      '[REDACTED_SECRET]#2': 2,
    });
  });

  it('skips an occupied suffix when redacted evaluator keys collide', () => {
    const first = 'ghp_0000000000000000000000000000000000000';
    const second = 'ghp_1111111111111111111111111111111111111';

    expect(
      scrubEvaluatorOutputInValue({
        '[REDACTED_SECRET]#2': 2,
        [first]: 1,
        [second]: 3,
      })
    ).toEqual({
      '[REDACTED_SECRET]#2': 2,
      '[REDACTED_SECRET]': 1,
      '[REDACTED_SECRET]#3': 3,
    });
  });

  it('bounds work when many evaluator keys redact to the same marker', () => {
    const input: Record<string, number> = {};
    for (let index = 0; index < 8_000; index += 1) {
      input[`ghp_${index.toString(36).padStart(36, '0')}`] = index;
    }

    const startedAt = performance.now();
    const output = scrubEvaluatorOutputInValue(input);

    expect(Object.keys(output)).toHaveLength(8_000);
    expect(output['[REDACTED_SECRET]']).toBe(0);
    expect(output['[REDACTED_SECRET]#8000']).toBe(7_999);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('findSecretLocations — anti-drift lock against redactSecrets', () => {
  // The two layers must agree about the same bytes. A detector that missed
  // what the redactor catches would let a secret clear a write boundary and
  // then reappear, redacted, at render time — the divergence this asserts away.
  it.each(SECRET_POSITIVES.map((s) => [s.name, s.sample] as const))(
    'detects %s exactly when redaction changes it',
    (_name, sample) => {
      expect(findSecretLocations(sample).length > 0).toBe(true);
      expect(redactSecrets(sample) !== sample).toBe(true);
    }
  );

  it.each(SECRET_NEGATIVES.map((s) => [s] as const))(
    'leaves %s undetected and unredacted',
    (sample) => {
      expect(findSecretLocations(sample)).toEqual([]);
      expect(redactSecrets(sample)).toBe(sample);
    }
  );

  // The reported span is a promise about what redaction removes. Collecting the
  // direct pass as a rewrite first broke it: the marker it wrote replaced the
  // vendor prefix the normalized pass matches on, so most of the token was
  // still printed under a finding that claimed the whole run was handled.
  it('replaces the whole span it reports when a control splits a vendor token', () => {
    const esc = String.fromCharCode(27);
    const token = `xoxb-000000000000${esc}[31m-000000000000-EXAMPLE0EXAMPLE0EXAMPLE0`;
    const found = findSecretLocations(token);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ tier: 'refuse', start: 0, end: token.length });

    const out = redactSecrets(token);
    expect(out).toBe(REDACTION_MARKER);
    // Nothing token-shaped may survive outside the marker itself.
    expect(out.replaceAll(REDACTION_MARKER, '')).not.toMatch(/[A-Za-z0-9]{4,}/);
  });

  // The same promise, for a break that is invisible rather than merely
  // non-printing. A partial match keeps the finding at `refuse`, so tier alone
  // cannot see this: the token past the break is what leaks.
  it('replaces the whole span it reports when an invisible character splits a token', () => {
    const token = 'xoxb-000000000000\uFE0F-000000000000-EXAMPLE0EXAMPLE0EXAMPLE0';
    const found = findSecretLocations(token);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ tier: 'refuse', start: 0, end: token.length });

    const out = redactSecrets(token);
    expect(out).toBe(REDACTION_MARKER);
    expect(out.replaceAll(REDACTION_MARKER, '')).not.toMatch(/[A-Za-z0-9]{4,}/);
  });

  it('folds a no-break space rather than closing the gap it renders', () => {
    // It renders as a space, so it separates here exactly as it does on screen.
    // Removing it would join the halves either side into a credential nobody
    // wrote — and would run `Authorization:` into the prose behind it.
    expect(findSecretLocations('Authorization:\u00A0add RBAC middleware')).toEqual([]);
    expect(redactSecrets('api_key=wJalrXUtnFEMI\u00A0K7MDENGbPxRfiCYEXAMPLEKEY')).toBe(
      // The character itself survives: redaction only rewrites what it matched.
      `api_key=${REDACTION_MARKER}\u00A0K7MDENGbPxRfiCYEXAMPLEKEY`
    );
  });

  it('redacts a vendor key whose boundary the token after it hides', () => {
    // Vendor patterns refuse to match with a token character hard against them,
    // so a key that ends exactly where the next one begins was reported and
    // removed as the second alone while the first was printed in full.
    const google = `AIza${'0'.repeat(35)}`;
    const anthropic = `sk-ant-${'0'.repeat(45)}`;
    const found = findSecretLocations(`${google}${anthropic}`);
    expect(found.flatMap((location) => location.patterns)).toContain('google-api-key');
    expect(redactSecrets(`${google}${anthropic}`)).toBe(`${REDACTION_MARKER}${REDACTION_MARKER}`);
  });

  it('leaves the surrounding line intact while removing the split token from it', () => {
    const esc = String.fromCharCode(27);
    const line = `sent to slack with xoxb-000000000000${esc}[31m-000000000000-EXAMPLE0EXAMPLE0EXAMPLE0 ok`;
    const out = redactSecrets(line);
    expect(out).toBe(`sent to slack with ${REDACTION_MARKER} ok`);
  });

  it('holds the equivalence property across the whole corpus', () => {
    const divergent = [...SECRET_POSITIVES.map((s) => s.sample), ...SECRET_NEGATIVES].filter(
      (s) => findSecretLocations(s).length > 0 !== (redactSecrets(s) !== s)
    );
    expect(divergent).toEqual([]);
  });

  it('reports the corpus tier for every positive', () => {
    for (const { name, sample, tier } of SECRET_POSITIVES) {
      const locations = findSecretLocations(sample);
      const strongest = locations.some((l) => l.tier === 'refuse') ? 'refuse' : 'warn';
      expect(`${name}:${strongest}`).toBe(`${name}:${tier}`);
    }
  });

  it('classifies every reportable pattern name', () => {
    // Totality: a pattern added without a tier must fail here rather than
    // silently defaulting into — or out of — blocking a write.
    const declared = [
      ...SECRET_PATTERNS.map((p) => p.name),
      PRIVATE_KEY_PATTERN_NAME,
      STRONG_ASSIGNMENT_PATTERN_NAME,
    ];
    // A `classify` hook reports a name that appears on no pattern, so the
    // declared list is not the reportable set on its own. Harvest what the
    // detector actually emits across the corpus and require those tiers too,
    // or a second classifier ships untiered and silently reads as warn.
    const emitted = SECRET_POSITIVES.flatMap((sample) =>
      findSecretLocations(sample.sample).flatMap((l) => l.patterns)
    );
    const unclassified = [...new Set([...declared, ...emitted])].filter(
      (name) => secretTierOf(name) === undefined
    );
    expect(unclassified).toEqual([]);
    expect(emitted).toContain(STRONG_ASSIGNMENT_PATTERN_NAME);
  });

  it('does not tier a location whose pattern name is an inherited property', () => {
    // The accessor is guarded, but findSecretLocations reads the tier too. A
    // check written as a truthiness or inequality test would reopen the bug
    // there, and asserting only on secretTierOf would not notice.
    const inherited = ['toString', 'constructor', 'valueOf', 'hasOwnProperty'];
    for (const name of inherited) {
      expect(secretTierOf(name)).toBeUndefined();
      expect(SECRET_PATTERNS.some((p) => p.name === name)).toBe(false);
    }
    // Every tier a real location reports resolves through the guarded accessor.
    for (const { sample } of SECRET_POSITIVES) {
      for (const location of findSecretLocations(sample)) {
        for (const reported of location.patterns) {
          expect(secretTierOf(reported)).toBeDefined();
        }
      }
    }
  });

  it('does not classify an inherited property name', () => {
    // The totality check above filters on `secretTierOf(name) === undefined`,
    // so a pattern named after a prototype member would satisfy it while
    // resolving to a function rather than to a tier.
    for (const inherited of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(secretTierOf(inherited)).toBeUndefined();
    }
  });

  it('agrees with redaction on a token split by terminal formatting', () => {
    const esc = String.fromCharCode(27);
    const obfuscated = `gh${esc}[0mp_0000000000000000000000000000000000000`;
    expect(findSecretLocations(obfuscated).length > 0).toBe(
      redactSecrets(obfuscated) !== obfuscated
    );
  });

  it('never returns the matched text', () => {
    for (const { sample } of SECRET_POSITIVES) {
      const locations = findSecretLocations(sample);
      expect(locations.length).toBeGreaterThan(0);

      const names = locations.flatMap((l) => l.patterns);
      for (const name of names) expect(secretTierOf(name)).toBeDefined();

      // Names are a closed set and belong in the result, so drop them before
      // comparing text: `authorization-header` shares a run with the prose of
      // its own sample, which would mask a real echo of the value.
      const serialized = names.reduce(
        (acc, name) => acc.split(name).join(''),
        JSON.stringify(locations)
      );
      for (const { start, end } of locations) {
        // Every window of the matched run, not a leading probe: the
        // prefix-only form passed a result that echoed the tail or the
        // middle of a value.
        const run = sample.slice(start, end);
        const width = Math.min(8, run.length);
        for (let i = 0; i + width <= run.length; i += 1) {
          expect(serialized).not.toContain(run.slice(i, i + width));
        }
      }
    }
  });

  it('scans one very long base64-dense line inside a key block in bounded time', () => {
    // Every full-width run on the line is a candidate anchor for the key
    // material, and re-measuring the whole line from each of them is quadratic:
    // this input took over thirty seconds before the search was bounded to the
    // tail, which is the only place an anchor can pass anyway.
    const run = 'ANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7';
    const opener = 'ANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmz';
    const haystack = `-----BEGIN RSA PRIVATE KEY-----\n${opener}\n${`${run} filler words here `.repeat(20_000)}\n`;
    expect(haystack.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    expect(findSecretLocations(haystack).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('scans a document whose every line is both a header and a marker in bounded time', () => {
    // `PEM_ENCAPSULATED_HEADER` anchors at the start of a line, so one line can
    // be both a header and a `-----BEGIN` marker — and every marker re-enters
    // the scan. Free of the dry budget AND of any count, each of them read to
    // the end of the input, which is quadratic over a whole output buffer.
    const line = 'example: -----BEGIN RSA PRIVATE KEY-----';
    const haystack = `${line}\n`.repeat(Math.ceil((1024 * 1024) / (line.length + 1)));
    expect(haystack.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    expect(redactSecrets(haystack)).toBe(haystack);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('re-anchors inside a bounded window when the recorded width is enormous', () => {
    // The window reaches back from the end of the line by twice the recorded
    // width, and that width belongs to the input: one long token line — a data
    // URI — drives it past the length of any line, so every run on the line
    // anchors a fresh measurement of the whole of it.
    const run = 'ANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7';
    const haystack = `-----BEGIN RSA PRIVATE KEY-----\n${run.repeat(16_000)}\n${`${run} `.repeat(
      16_000
    )}\ntail\n`;
    expect(haystack.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    expect(findSecretLocations(haystack).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('scans a 1 MB unbroken token run in bounded time', () => {
    // Prose breaks a run at every space. A single unbroken run of one token
    // alphabet is what an anchored pattern with a variable-length prefix has to
    // survive, and evaluator output can supply one.
    const haystack = `${'aB0_~.-'.repeat(150_000)}npm_000000000000000000000000000000000000`;
    expect(haystack.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    expect(findSecretLocations(haystack).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('scans a 1 MB string in bounded time', () => {
    const haystack = `${'lorem ipsum dolor sit amet '.repeat(40_000)}ghp_0000000000000000000000000000000000000`;
    expect(haystack.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    const found = findSecretLocations(haystack);
    expect(found.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('redactSecretsInUnifiedDiff — shape is preserved', () => {
  const PEM_DIFF = [
    'diff --git a/key.pem b/key.pem',
    'index e69de29..1234567 100644',
    '--- a/key.pem',
    '+++ b/key.pem',
    '@@ -0,0 +3,5 @@ context line',
    '+-----BEGIN RSA PRIVATE KEY-----',
    '+MIIEowIBAAKCAQEA0000000000000000',
    '+MIIEowIBAAKCAQEA1111111111111111',
    '+-----END RSA PRIVATE KEY-----',
    ' unchanged trailing line',
  ].join('\n');

  it('keeps line count identical across a multi-line PEM block', () => {
    const out = redactSecretsInUnifiedDiff(PEM_DIFF);
    expect(out.split('\n')).toHaveLength(PEM_DIFF.split('\n').length);
  });

  it('keeps the sign column on every hunk row', () => {
    const before = PEM_DIFF.split('\n');
    const after = redactSecretsInUnifiedDiff(PEM_DIFF).split('\n');
    after.forEach((line, i) => {
      expect(line.charAt(0)).toBe(before[i]!.charAt(0));
    });
  });

  it('leaves diff and hunk headers byte-identical', () => {
    const after = redactSecretsInUnifiedDiff(PEM_DIFF).split('\n');
    expect(after.slice(0, 5)).toEqual(PEM_DIFF.split('\n').slice(0, 5));
  });

  it('actually redacts the key material', () => {
    const out = redactSecretsInUnifiedDiff(PEM_DIFF);
    expect(out).not.toContain('MIIEowIBAAKCAQEA0000000000000000');
    expect(out).toContain(REDACTION_MARKER);
  });

  // Inside a hunk every line carries a sign column, so the file-header prefixes
  // describe the SIGNED line rather than its content. `--` is the comment token
  // in SQL, Lua, Haskell, Elm and Ada, and "delete the hardcoded credential" is
  // exactly the diff most likely to carry one.
  it('scans a deleted line whose body is a comment', () => {
    const diff = [
      'diff --git a/migrate.sql b/migrate.sql',
      '--- a/migrate.sql',
      '+++ b/migrate.sql',
      '@@ -1,2 +1,1 @@',
      '--- api_key=R7mKq2XvT4bNw9ZcJ5hLp3Ds',
      ' SELECT 1;',
    ].join('\n');
    const out = redactSecretsInUnifiedDiff(diff);
    expect(out).not.toContain('R7mKq2XvT4bNw9ZcJ5hLp3Ds');
    expect(out.split('\n')[4]).toBe(`--- api_key=${REDACTION_MARKER}`);
  });

  it('scans an added line whose body is a comment', () => {
    const diff = [
      'diff --git a/lib.lua b/lib.lua',
      '@@ -1,1 +1,2 @@',
      '+++ api_key=R7mKq2XvT4bNw9ZcJ5hLp3Ds',
      ' return 1',
    ].join('\n');
    const out = redactSecretsInUnifiedDiff(diff);
    expect(out).not.toContain('R7mKq2XvT4bNw9ZcJ5hLp3Ds');
    expect(out.split('\n')[2]).toBe(`+++ api_key=${REDACTION_MARKER}`);
  });

  it('still reads the next file header as a header', () => {
    // The hunk ends at `diff --git`, so the ---/+++ pair after it is structure
    // again rather than two more comment lines.
    const diff = [
      'diff --git a/a.sql b/a.sql',
      '@@ -1,1 +1,1 @@',
      '-- api_key=R7mKq2XvT4bNw9ZcJ5hLp3Ds',
      'diff --git a/b.sql b/b.sql',
      '--- a/b.sql',
      '+++ b/b.sql',
      '@@ -1,1 +1,1 @@',
      ' SELECT 2;',
    ].join('\n');
    const out = redactSecretsInUnifiedDiff(diff).split('\n');
    expect(out.slice(3, 8)).toEqual(diff.split('\n').slice(3, 8));
    expect(out[2]).toBe(`-- api_key=${REDACTION_MARKER}`);
  });

  it('scans a lone hunk row when told the rows are hunk bodies', () => {
    // `review comments --json` redacts anchor context one row at a time, with
    // no `@@` in front of it to say where the row came from.
    const row = '--- api_key=R7mKq2XvT4bNw9ZcJ5hLp3Ds';
    expect(redactSecretsInUnifiedDiff(row)).toBe(row);
    expect(redactSecretsInUnifiedDiff(row, { hunkBody: true })).toBe(
      `--- api_key=${REDACTION_MARKER}`
    );
  });

  // Every hunk body in a diff is scanned as one joined document, so a marker
  // that opens a range with nothing to close it used to run to end-of-input —
  // past the file it appeared in. These pin the blast radius at zero.
  const mentionDiff = (...tail: string[]): string =>
    [
      'diff --git a/docs/keys.md b/docs/keys.md',
      '@@ -1,3 +1,4 @@',
      ' The key file opens with -----BEGIN RSA PRIVATE KEY----- on line one.',
      '+Rotate it quarterly per the runbook.',
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
      '@@ -8,2 +8,3 @@',
      '   runs-on: ubuntu-latest',
      '+  timeout-minutes: 20',
      ...tail,
    ].join('\n');

  it('leaves a diff alone when a marker is only named in prose', () => {
    const diff = mentionDiff();
    expect(redactSecretsInUnifiedDiff(diff)).toBe(diff);
  });

  it('does not pair prose markers across files', () => {
    const diff = mentionDiff(' and it closes with -----END RSA PRIVATE KEY----- at the tail.');
    expect(redactSecretsInUnifiedDiff(diff)).toBe(diff);
  });

  it('does not pair prose markers inside one file', () => {
    // The shape of this repository's own secrets tests: a marker quoted in one
    // assertion and its terminator quoted in another, with unrelated code between.
    const diff = [
      'diff --git a/secrets.test.ts b/secrets.test.ts',
      '@@ -10,6 +10,8 @@',
      "     expect(find('-----BEGIN PRIVATE KEY-----')).toHaveLength(1);",
      '+    expect(tierOf(sample)).toBe("refuse");',
      "     expect(find('-----END PRIVATE KEY-----')).toHaveLength(1);",
    ].join('\n');
    expect(redactSecretsInUnifiedDiff(diff)).toBe(diff);
  });

  // A key rarely appears bare. These are the shapes it arrives in when an agent
  // quotes it from output it was reading — which is the threat model, not an
  // edge case.
  const KEY_BODY = [
    'ANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmz',
    'HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6',
    'Obo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0B',
    'Viv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7I',
    'cp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CP',
    'jw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JW',
    'q3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQd',
    'x+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXk',
    '4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer',
    '/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly',
    'GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5',
    'Nan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzA',
    'Uhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6H',
    'bo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BO',
    'iv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IV',
    'p2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPc',
    'w9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWj',
    '3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq',
    '+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx',
    'FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4',
    'MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/',
    'Tgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5G',
    'an0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzAN',
    'hu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HU',
    'MEKUyWouUVN0000',
  ];
  const wrapKey = (decorate: (line: string) => string): string =>
    ['-----BEGIN PRIVATE KEY-----', ...KEY_BODY, '-----END PRIVATE KEY-----']
      .map(decorate)
      .join('\n');

  /** Strongest tier reported over `text`, or `none` when nothing is detected. */
  const tierOf = (text: string): string => {
    const found = findSecretLocations(text);
    if (found.length === 0) return 'none';
    return found.some((location) => location.tier === 'refuse') ? 'refuse' : 'warn';
  };

  it.each([
    ['a per-line log prefix', (l: string) => `2026-08-24T10:00:00Z stdout: ${l}`],
    ['concatenated string literals', (l: string) => `  '${l}\\n' +`],
    ['four-space indentation', (l: string) => `    ${l}`],
  ])('redacts a key wrapped in %s', (_label, decorate) => {
    const out = redactSecrets(wrapKey(decorate));
    for (const body of KEY_BODY) expect(out).not.toContain(body);
  });

  it.each([
    ['a docker nanosecond timestamp', (l: string) => `2026-08-25T10:00:00.000000000Z ${l}`],
    ['a logfmt prefix', (l: string) => `level=info msg=${l}`],
    ['a container name', (l: string) => `api-server-7d9f8b6c4-x2k9m ${l}`],
  ])('redacts a key behind %s, which carries its own base64 run', (_label, decorate) => {
    // These defeat a continuation test that reads the FIRST run on the line —
    // the timestamp, the `level=info`, the pod hash — instead of the longest. A
    // decoration whose own run is too short lets the key win by accident, so the
    // fixtures here deliberately carry one wide enough to compete.
    const out = redactSecrets(wrapKey(decorate));
    for (const body of KEY_BODY) expect(out).not.toContain(body);
  });

  it('redacts an encrypted key whose RFC 1421 headers are behind decoration', () => {
    // Proc-Type and DEK-Info are unrecognisable as headers once decorated, so
    // they were spent as ordinary non-material lines — exhausting the budget
    // before the scan ever reached base64, and the key went undetected entirely.
    const encrypted = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-256-CBC,E701C94EBAAD68020947B05A58FE8AE4',
      '',
      ...KEY_BODY,
      '-----END RSA PRIVATE KEY-----',
    ]
      .map((l) => `2026-08-25T10:00:00.000000000Z ${l}`)
      .join('\n');
    const out = redactSecrets(encrypted);
    for (const body of KEY_BODY) expect(out).not.toContain(body);
  });
  // The post-material dry budget, from both sides. A key does not always arrive
  // in one unbroken run — a multiplexed log interleaves other writers' lines
  // into it — and the budget is what carries the block across them. Too small
  // and the rest of the key prints; too large and the block feeds on whatever
  // is base64-dense further down, which is how a certificate beside the key
  // gets redacted with it.
  const INTERRUPTED_KEY_LINES = [
    '-----BEGIN RSA PRIVATE KEY-----',
    ...KEY_BODY.slice(0, 3),
    'worker 2 renewed its lease on shard 7',
    'worker 3 flushed 12 records to disk',
    'worker 1 is waiting on the queue',
    ...KEY_BODY.slice(3),
    '-----END RSA PRIVATE KEY-----',
  ];

  // Base64 of its own, at the key's wrap width, so only the budget separates it
  // from the key above it.
  const CERTIFICATE_BODY = [
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE0000QUJDREVGR0hJSktMTU5PUFFS',
    'U1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLzAw',
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdA00',
  ];

  it('redacts the rest of a key after other writers interleave lines into it', () => {
    const key = INTERRUPTED_KEY_LINES.join('\n');
    expect(tierOf(key)).toBe('refuse');
    const out = redactSecrets(key);
    for (const body of KEY_BODY) expect(out).not.toContain(body);
  });

  it('stops a key at the prose after it rather than eating the certificate below', () => {
    const log = [
      '-----BEGIN RSA PRIVATE KEY-----',
      ...KEY_BODY.slice(0, 3),
      'the agent loaded the key',
      'the matching certificate follows',
      'read from the local trust store',
      '-----BEGIN PUBLIC KEY-----',
      ...CERTIFICATE_BODY,
      '-----END PUBLIC KEY-----',
    ].join('\n');
    const out = redactSecrets(log);
    for (const body of KEY_BODY.slice(0, 3)) expect(out).not.toContain(body);
    for (const line of CERTIFICATE_BODY) expect(out).toContain(line);
  });

  it('leaves a certificate standing alone untouched', () => {
    // The control for the pair above: the certificate is not a secret on its
    // own, so its survival there is the budget's doing and not the detector
    // declining to look at it.
    const certificate = [
      '-----BEGIN PUBLIC KEY-----',
      ...CERTIFICATE_BODY,
      '-----END PUBLIC KEY-----',
    ].join('\n');
    expect(tierOf(certificate)).toBe('none');
    expect(redactSecrets(certificate)).toBe(certificate);
  });

  it('redacts a token split by terminal escapes in a DIFF, not only in prose', () => {
    // redactSecrets and findSecretLocations both run the control-obfuscation
    // pass; this redactor did not, so the detector called it refuse while the
    // review payload carried it intact.
    const esc = String.fromCharCode(27);
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '@@ -1,0 +1 @@',
      `+const t = 'gh${esc}[0mp_0000000000000000000000000000000000000';`,
    ].join('\n');
    const out = redactSecretsInUnifiedDiff(diff);
    expect(out).not.toBe(diff);
    expect(out).toContain(REDACTION_MARKER);
  });

  it('redacts the whole key when one body line carries an interior space', () => {
    // Partial redaction is worse than none: the finding still reports refuse,
    // so the boundary believes it handled a key it mostly printed.
    const dirty = [
      '-----BEGIN PRIVATE KEY-----',
      `${KEY_BODY[0]!.slice(0, 20)} ${KEY_BODY[0]!.slice(20)}`,
      ...KEY_BODY.slice(1),
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(dirty);
    for (const body of KEY_BODY.slice(1)) expect(out).not.toContain(body);
  });

  it('still redacts a severed key that has real material after the marker', () => {
    const diff = [
      'diff --git a/key.pem b/key.pem',
      '@@ -0,0 +1,2 @@',
      '+-----BEGIN RSA PRIVATE KEY-----',
      '+MIIEowIBAAKCAQEA0000000000000000',
      'diff --git a/other.txt b/other.txt',
      '@@ -1,1 +1,2 @@',
      '+this unrelated line must survive',
    ].join('\n');
    const out = redactSecretsInUnifiedDiff(diff);
    expect(out).not.toContain('MIIEowIBAAKCAQEA0000000000000000');
    expect(out).toContain('this unrelated line must survive');
  });

  it('redacts a token on a single added line without touching its neighbours', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const before = 1;',
      '+const token = "ghp_0000000000000000000000000000000000000";',
      '-const after = 2;',
    ].join('\n');
    const out = redactSecretsInUnifiedDiff(diff).split('\n');
    expect(out[2]).toBe(' const before = 1;');
    expect(out[4]).toBe('-const after = 2;');
    expect(out[3]).toContain(REDACTION_MARKER);
    expect(out[3]!.startsWith('+')).toBe(true);
  });

  it('never rewrites a path that happens to look like a token', () => {
    const diff = [
      'diff --git a/ghp_0000000000000000000000000000000000000 b/x',
      '--- a/ghp_0000000000000000000000000000000000000',
      '+++ b/x',
      '@@ -1 +1 @@',
      ' unchanged',
    ].join('\n');
    expect(redactSecretsInUnifiedDiff(diff)).toBe(diff);
  });

  // RFC 1421 allows any number of encapsulated headers, so the pre-material
  // budget cannot be spent on them: five headers plus a comment is already past
  // it, and a complete, terminated, well-formed encrypted key went from fully
  // redacted to entirely undetected. The comment line is what keeps this on the
  // run scanner — the terminated path rejects a block containing one — so the
  // header handling under test is the one that actually runs.
  const ENCRYPTED_KEY_LINES = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'Proc-Type: 4,ENCRYPTED',
    'DEK-Info: AES-128-CBC,00000000000000000000000000000000',
    'Content-Domain: RFC822',
    'Originator-Name: nobody@example.invalid',
    'Recipient-Name: nobody@example.invalid',
    '# exported for the fixture, not a key anyone holds',
    '',
    ...KEY_BODY,
    '-----END RSA PRIVATE KEY-----',
  ];

  it('detects an encrypted key whose headers outnumber the pre-material budget', () => {
    const key = ENCRYPTED_KEY_LINES.join('\n');
    expect(tierOf(key)).toBe('refuse');
    const out = redactSecrets(key);
    for (const body of KEY_BODY) expect(out).not.toContain(body);
  });

  it('redacts every body line of a header-heavy encrypted key in a diff', () => {
    const diff = [
      'diff --git a/id_rsa b/id_rsa',
      `@@ -0,0 +1,${ENCRYPTED_KEY_LINES.length} @@`,
      ...ENCRYPTED_KEY_LINES.map((line) => `+${line}`),
    ].join('\n');
    const out = redactSecretsInUnifiedDiff(diff);
    for (const body of KEY_BODY) expect(out).not.toContain(body);
  });

  // Decoration wider than the key's own wrap width. Judging the line as a whole
  // makes detection depend on the width of the log prefix, so these reported
  // refuse over the first line and then printed the other twenty-four.
  it.each([
    [
      'a Spring Boot log prefix',
      (l: string) => `2026-08-25 10:00:00.123  INFO 12345 --- [   main] c.e.a.KeyLoader   : ${l}`,
    ],
    [
      'a k8s JSON log envelope',
      (l: string) =>
        `{"ts":"2026-08-25T10:00:00.123456Z","level":"info","logger":"keyloader","msg":"${l}"}`,
    ],
  ])('redacts a key under %s, which is wider than the key wraps', (_label, decorate) => {
    const wrapped = wrapKey(decorate);
    expect(tierOf(wrapped)).toBe('refuse');
    const out = redactSecrets(wrapped);
    for (const body of KEY_BODY) expect(out).not.toContain(body);
  });

  // A container sha is 64 characters — exactly this key's wrap width — so the
  // decoration is as material-looking as the material.
  const CONTAINER_SHA = 'a3f9c2e10b4d8f7620394857aeb1cd0f9e8d7c6b5a4938271605f4e3d2c1b0a9';
  const underSha = (lines: readonly string[]): string =>
    lines.map((line) => `${CONTAINER_SHA} ${line}`).join('\n');

  it.each([
    ['a bare key', ['-----BEGIN PRIVATE KEY-----', ...KEY_BODY, '-----END PRIVATE KEY-----']],
    [
      // Its blank line decorates down to the sha alone, so the block opens
      // anchored on the decoration and every body line then reads as prose.
      'an encrypted key',
      [
        '-----BEGIN RSA PRIVATE KEY-----',
        'Proc-Type: 4,ENCRYPTED',
        'DEK-Info: AES-128-CBC,00000000000000000000000000000000',
        '',
        ...KEY_BODY,
        '-----END RSA PRIVATE KEY-----',
      ],
    ],
  ])('redacts %s decorated with a run as wide as the key itself', (_label, lines) => {
    const wrapped = underSha(lines);
    expect(tierOf(wrapped)).toBe('refuse');
    const out = redactSecrets(wrapped);
    for (const body of KEY_BODY) expect(out).not.toContain(body);
  });

  it('stops an unterminated key at the file boundary, not at the end of the diff', () => {
    // Hunk bodies are scanned as one document, so an unterminated block that
    // keeps feeding on whatever is base64-dense reaches into unrelated files —
    // and the `redact.allow` allowlist matches on the detected substring, so a
    // span of key-plus-lockfile cannot be allowlisted by naming the key.
    const integrity = Array.from(
      { length: 40 },
      (_, i) =>
        `      "integrity": "sha512-${'0123456789abcdef'.repeat(5)}${String(i).padStart(8, '0')}==",`
    );
    const diff = [
      'diff --git a/key.pem b/key.pem',
      '@@ -0,0 +1,2 @@',
      '+-----BEGIN RSA PRIVATE KEY-----',
      `+${KEY_BODY[0]}`,
      'diff --git a/package-lock.json b/package-lock.json',
      `@@ -1,${integrity.length} +1,${integrity.length} @@`,
      ...integrity.map((line) => `+${line}`),
    ].join('\n');
    const out = redactSecretsInUnifiedDiff(diff);
    expect(out).not.toContain(KEY_BODY[0]);
    for (const line of integrity) expect(out).toContain(line);
  });

  it('detects a key whose comment header carries base64 under a log envelope', () => {
    // An ssh `Comment: SHA256:…` is base64 of its own, and a different width
    // from the body's. Recorded as the block's wrap width, every real body line
    // was wider than the block believed it wrapped and was discarded — so the
    // block ended on its own header, reporting refuse over a span that stops
    // before the material it was there to remove.
    const envelope = (line: string): string => `{"stream":"stdout","log":"${line}"}`;
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      `Comment: SHA256:${KEY_BODY[0]!.slice(0, 43)}`,
      ...KEY_BODY,
      '-----END RSA PRIVATE KEY-----',
    ]
      .map(envelope)
      .join('\n');
    expect(tierOf(key)).toBe('refuse');
    const out = redactSecrets(key);
    for (const body of KEY_BODY) expect(out).not.toContain(body);
  });

  it('redacts a key whose first body line is narrower than the rest', () => {
    // The wrap width is one line's guess about the whole block. Taken from a
    // line a single character short, it condemns every line that follows it.
    const narrowed = [KEY_BODY[0]!.slice(1), ...KEY_BODY.slice(1)];
    const key = ['-----BEGIN RSA PRIVATE KEY-----', ...narrowed]
      .map((line) => `2026-08-25 10:00:00.123  INFO 1 --- [main] c.e.KeyLoader : ${line}`)
      .join('\n');
    expect(tierOf(key)).toBe('refuse');
    const out = redactSecrets(key);
    for (const body of narrowed) expect(out).not.toContain(body);
  });

  it('redacts a key that wraps wider than the run decorating it', () => {
    // The decoration is 64 characters and this key wraps at 70, so the widest
    // run on a line carrying no material — the blank line between the headers
    // and the body — is the decoration's. Recorded as the block's, it is
    // narrower than every body line, and the body reads as unrelated text.
    const wideBody = KEY_BODY.slice(0, 6).map(
      (line, index) => `${line}${KEY_BODY[index + 1]!.slice(0, 6)}`
    );
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,00000000000000000000000000000000',
      '',
      ...wideBody,
      '-----END RSA PRIVATE KEY-----',
    ]
      .map((line) => `${CONTAINER_SHA} ${line}`)
      .join('\n');
    expect(tierOf(key)).toBe('refuse');
    const out = redactSecrets(key);
    for (const body of wideBody) expect(out).not.toContain(body);
  });

  // Encapsulated headers cost nothing so that a key's own header block cannot
  // exhaust the pre-material budget. Prose reaches the same shapes: a page that
  // names a marker and then lists `Rotation:` and `Owner:` walks the free pass
  // to whatever is base64-dense next, which in a joined diff is another file.
  const DEFINITION_LINES = [
    'Rotation: quarterly, tracked in the runbook.',
    'Storage: the platform secret manager, never the repo.',
    'Owner: the platform team.',
    'Audit: reviewed each release.',
  ];
  const LOCKFILE_LINES = [
    '{',
    '  "name": "example",',
    `  "integrity": "sha512-${KEY_BODY[1]}${KEY_BODY[2]}==",`,
    '  "version": "1.0.0"',
    '}',
  ];
  const documentedMarkerDiff = (
    docLines: readonly string[],
    lockLines: readonly string[]
  ): string =>
    [
      'diff --git a/docs/keys.md b/docs/keys.md',
      `@@ -0,0 +1,${docLines.length} @@`,
      ...docLines.map((line) => `+${line}`),
      'diff --git a/package-lock.json b/package-lock.json',
      `@@ -0,0 +1,${lockLines.length} @@`,
      ...lockLines.map((line) => `+${line}`),
    ].join('\n');

  it('leaves a documented marker alone when prose surrounds it', () => {
    // The rest of the sentence after the marker is already a line the block
    // cannot read, so the definitions behind it are prose too — a header block
    // starts at the marker or the key has none.
    const diff = documentedMarkerDiff(
      ['Keys open with `-----BEGIN RSA PRIVATE KEY-----` in PEM form.', ...DEFINITION_LINES],
      LOCKFILE_LINES.slice(2)
    );
    expect(redactSecretsInUnifiedDiff(diff)).toBe(diff);
  });

  it('leaves a documented marker alone when a definition list follows it', () => {
    // RFC 1421 puts the body straight after the header block, so a gap between
    // the two is a definition list in prose rather than a key.
    const diff = documentedMarkerDiff(
      [
        'Keys open with -----BEGIN RSA PRIVATE KEY-----',
        ...DEFINITION_LINES,
        '',
        'Reviewed by the platform team each release.',
      ],
      LOCKFILE_LINES
    );
    expect(redactSecretsInUnifiedDiff(diff)).toBe(diff);
  });

  it('is idempotent', () => {
    const once = redactSecretsInUnifiedDiff(PEM_DIFF);
    expect(redactSecretsInUnifiedDiff(once)).toBe(once);
  });

  it('leaves a clean diff untouched', () => {
    const clean = ['diff --git a/a.ts b/a.ts', '@@ -1 +1 @@', '+const answer = 42;'].join('\n');
    expect(redactSecretsInUnifiedDiff(clean)).toBe(clean);
  });
});

describe('generic-assignment value-shape tier', () => {
  const tierOf = (text: string): string => {
    const found = findSecretLocations(text);
    if (found.length === 0) return 'none';
    return found.some((l) => l.tier === 'refuse') ? 'refuse' : 'warn';
  };

  it('refuses the AWS secret whose paired key id already refused', () => {
    expect(tierOf('AKIA0000000000000000')).toBe('refuse');
    expect(tierOf('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe('refuse');
  });

  it('refuses other high-signal assignments by shape, not by key name', () => {
    expect(tierOf('client_secret=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')).toBe('refuse');
    // Two character classes only, so the entropy branch is what catches it.
    expect(tierOf('api_key=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe(
      'refuse'
    );
  });

  it.each([
    ['a TypeScript type annotation', 'const token: HeldToken = { live: true };'],
    ['a kebab-case OAuth fixture', "refresh_token: 'invalid-refresh-token'"],
    ['an object-literal property', "accessToken: 'opaque-token-fixture'"],
    ['a padded placeholder', `api_key=${'0'.repeat(40)}`],
    ['a 20-char human password — the acknowledged miss', 'password=Tz7qkQ2mVx9Rw4Lp8Bd1'],
  ])('leaves %s at warn', (_label, sample) => {
    expect(tierOf(sample)).toBe('warn');
  });

  it('refuses a three-class value at 24 characters and warns at 23', () => {
    const { atDiversityLength, belowDiversityLength } = VALUE_SHAPE_BOUNDARY;
    expect([atDiversityLength.length, belowDiversityLength.length]).toEqual([24, 23]);
    expect(tierOf(`api_key=${atDiversityLength}`)).toBe('refuse');
    expect(tierOf(`api_key=${belowDiversityLength}`)).toBe('warn');
  });

  it('refuses a two-class value at 32 characters and warns at 31', () => {
    const { atEntropyLength, belowEntropyLength } = VALUE_SHAPE_BOUNDARY;
    expect([atEntropyLength.length, belowEntropyLength.length]).toEqual([32, 31]);
    expect(tierOf(`api_key=${atEntropyLength}`)).toBe('refuse');
    expect(tierOf(`api_key=${belowEntropyLength}`)).toBe('warn');
  });

  it('separates two values of one length and class count on entropy alone', () => {
    // Exactly 3.00 bits against 2.99, one character apart. Without a bar the
    // second refuses too, and every long alphanumeric identifier with it.
    const { atEntropyBar, belowEntropyBar } = VALUE_SHAPE_BOUNDARY;
    expect(atEntropyBar.length).toBe(belowEntropyBar.length);
    expect(tierOf(`api_key=${atEntropyBar}`)).toBe('refuse');
    expect(tierOf(`api_key=${belowEntropyBar}`)).toBe('warn');
  });

  it('needs BOTH the length and the diversity component', () => {
    // 28 lowercase chars: long enough for the first branch, one class short of
    // it, and under 32 so the entropy branch cannot rescue it either.
    expect(tierOf('api_key=abcdefghijklmnopqrstuvwxyzab')).toBe('warn');
    // Three classes but far too short.
    expect(tierOf('api_key=aB3dEf9h')).toBe('warn');
  });

  it('treats a long run of one character as padding, never a credential', () => {
    const padded = `api_key=aB3${'x'.repeat(30)}`;
    expect(padded.length).toBeGreaterThan(32);
    expect(tierOf(padded)).toBe('warn');
  });

  it('keeps secretTierOf a total map with no value-dependent branch', () => {
    // The promoted name is registered like any other; the tier is a property
    // of the NAME, so a classifier only chooses which name is reported.
    expect(secretTierOf(STRONG_ASSIGNMENT_PATTERN_NAME)).toBe('refuse');
    expect(secretTierOf('generic-assignment')).toBe('warn');
  });

  it('reports the promoted name so the refusal explains itself', () => {
    const found = findSecretLocations(
      'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    );
    expect(found[0]?.patterns).toContain(STRONG_ASSIGNMENT_PATTERN_NAME);
  });
});
