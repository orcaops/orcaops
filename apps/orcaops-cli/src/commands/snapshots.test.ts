import { describe, expect, it } from 'vitest';

import { redactSecretsInString } from '@orcaops/storage';

import {
  parseDiffRange,
  preparePipedDiff,
  trimRedactedToCap,
  trimToUtf8Boundary,
  underivedPruneRefusal,
} from './snapshots.js';

describe('underivedPruneRefusal', () => {
  it('names the stakes, the executable remedy, the enumeration path, and the escape hatch', () => {
    const msg = underivedPruneRefusal(3);
    expect(msg).toContain('3 candidate ref(s)');
    expect(msg).toContain('permanently non-derivable');
    // The named command must be runnable as written — selectors included.
    expect(msg).toContain('orcaops fingerprint derive --artifact <id> --checkpoint <n>');
    // "for each" is resolvable: the dry-run enumerates the targets.
    expect(msg).toContain('Re-run without `--apply` to list them (marked [underived])');
    expect(msg).toContain('--allow-underived');
  });

  it('the --all remedy never points at a re-run that would itself refuse', () => {
    const msg = underivedPruneRefusal(2, 'all');
    // --all has no dry-run (it requires --apply), so the listing path is
    // doctor, and the dry-run pointer must be absent.
    expect(msg).toContain('Run `orcaops doctor` to list them');
    expect(msg).not.toContain('Re-run without');
    expect(msg).toContain('orcaops fingerprint derive --artifact <id> --checkpoint <n>');
    expect(msg).toContain('--allow-underived');
  });
});

describe('parseDiffRange', () => {
  it('parses a single checkpoint window', () => {
    expect(parseDiffRange('3')).toEqual({ form: 'single', n: 3 });
  });

  it('parses checkpoint..checkpoint and baseline endpoints', () => {
    expect(parseDiffRange('1..3')).toEqual({
      form: 'range',
      from: { kind: 'checkpoint', n: 1 },
      to: { kind: 'checkpoint', n: 3 },
    });
    expect(parseDiffRange('baseline..2')).toEqual({
      form: 'range',
      from: { kind: 'baseline' },
      to: { kind: 'checkpoint', n: 2 },
    });
  });

  it('rejects baseline..baseline, zero endpoints, and garbage', () => {
    expect(() => parseDiffRange('baseline..baseline')).toThrow(/always empty/);
    expect(() => parseDiffRange('0..2')).toThrow(/positive/);
    expect(() => parseDiffRange('0')).toThrow(/Invalid range/);
    expect(() => parseDiffRange('1...2')).toThrow(/Invalid range/);
    expect(() => parseDiffRange('HEAD..2')).toThrow(/Invalid range/);
  });
});

describe('trimToUtf8Boundary', () => {
  it('keeps a buffer that ends on a boundary', () => {
    const b = Buffer.from('héllo', 'utf8');
    expect(trimToUtf8Boundary(b).toString('utf8')).toBe('héllo');
  });

  it('drops a split 2-byte char', () => {
    const b = Buffer.from('aé', 'utf8'); // 61 C3 A9
    expect(trimToUtf8Boundary(b.subarray(0, 2)).toString('utf8')).toBe('a');
  });

  it('drops a split 4-byte char at every cut point', () => {
    const b = Buffer.from('x😀', 'utf8'); // 78 F0 9F 98 80
    for (let cut = 2; cut < b.length; cut++) {
      expect(trimToUtf8Boundary(b.subarray(0, cut)).toString('utf8')).toBe('x');
    }
    expect(trimToUtf8Boundary(b).toString('utf8')).toBe('x😀');
  });

  it('handles empty and pure-ASCII buffers', () => {
    expect(trimToUtf8Boundary(Buffer.alloc(0)).length).toBe(0);
    expect(trimToUtf8Boundary(Buffer.from('abc')).toString('utf8')).toBe('abc');
  });
});

describe('trimRedactedToCap', () => {
  // The command over-reads past `max_diff_bytes`, redacts, then trims here.
  // These assert the property that ordering buys: a secret spanning the cap
  // does not survive as an unmatched prefix.
  const secret = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

  it('redacts a secret that straddles the cap', () => {
    const lead = 'diff --git a/.env b/.env\n+TOKEN=';
    const cap = lead.length + 10; // cuts the secret 10 chars in
    const overRead = `${lead}${secret}\ntrailing\n`;

    const out = trimRedactedToCap(redactSecretsInString(overRead), cap, true);

    expect(out).not.toContain(secret.slice(0, 10));
    expect(out).not.toContain('ghp_');
  });

  it('leaves a diff under the cap untouched', () => {
    const text = 'diff --git a/a b/a\n+hello\n';
    expect(trimRedactedToCap(text, 1024, true)).toBe(text);
  });

  it('preserves CRLF bytes when redaction is enabled', () => {
    const text = 'diff --git a/a b/a\r\n-old\r\n+new\r\n';
    const redacted = redactSecretsInString(text);
    expect(trimRedactedToCap(redacted, 1024, true)).toBe(text);
  });

  it('drops a trailing token-shaped run that the cap severed', () => {
    const text = `+notes here\n+${'z'.repeat(40)}`;
    const out = trimRedactedToCap(text, text.length - 5, true);
    // The leading `+` goes with it: base64 secrets contain `+`, so the diff
    // marker falls inside the token class. Losing it costs nothing at the
    // tail of a diff that is already truncated.
    expect(out).toBe('+notes here\n');
  });

  it('keeps the severed run when redaction is disabled', () => {
    const text = `+notes here\n+${'z'.repeat(40)}`;
    const cap = text.length - 5;
    expect(Buffer.byteLength(trimRedactedToCap(text, cap, false))).toBe(cap);
  });

  it('never splits a multi-byte character at the cap', () => {
    const text = `${'a'.repeat(10)}😀${'b'.repeat(10)}`;
    expect(trimRedactedToCap(text, 12, false)).toBe('a'.repeat(10));
  });
});

describe('preparePipedDiff', () => {
  it('preserves arbitrary non-UTF-8 bytes', () => {
    const raw = Buffer.from([0x2b, 0x80, 0xff, 0x0a]);

    expect(preparePipedDiff(raw, 1024, false)).toEqual({
      bytes: raw,
      trimmed: false,
    });
    expect(preparePipedDiff(raw, 1024, true)).toEqual({
      bytes: raw,
      trimmed: false,
    });
  });

  it('redacts ASCII secret bytes before applying the byte cap', () => {
    const secret = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const raw = Buffer.from(`+\x80TOKEN=${secret}\n`, 'latin1');
    const result = preparePipedDiff(raw, raw.length, true);

    expect(result.bytes.includes(Buffer.from(secret, 'ascii'))).toBe(false);
    expect(result.bytes.includes(Buffer.from('[REDACTED_SECRET]', 'ascii'))).toBe(true);
  });
});
