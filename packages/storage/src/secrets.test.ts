import { describe, expect, it } from 'vitest';

import { SECRET_NEGATIVES, SECRET_POSITIVES } from '@orcaops/evaluator-protocol/secret-corpus';

import {
  REDACTION_MARKER,
  redactSecretsInObject,
  redactSecretsInString,
  scrubTerminalDiagnosticAndBound,
} from './secrets.js';

describe('redactSecretsInString — provider patterns', () => {
  it('redacts an Anthropic API key', () => {
    const s = 'curl -H "x-api-key: sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901XYZ"';
    const out = redactSecretsInString(s);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain(REDACTION_MARKER);
  });

  it('redacts an OpenAI project key', () => {
    const s = 'OPENAI=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
    const out = redactSecretsInString(s);
    expect(out).not.toContain('sk-proj-abcdef');
    expect(out).toContain(REDACTION_MARKER);
  });

  it('redacts a GitHub personal access token (ghp_*)', () => {
    const s = 'token: ghp_ABCDEF1234567890abcdef1234567890ABCDEF';
    const out = redactSecretsInString(s);
    expect(out).not.toContain('ghp_ABC');
    expect(out).toContain(REDACTION_MARKER);
  });

  it.each([
    ['gho_', 'gho_ABCDEF1234567890abcdef1234567890ABCDEF'],
    ['ghu_', 'ghu_ABCDEF1234567890abcdef1234567890ABCDEF'],
    ['ghs_', 'ghs_ABCDEF1234567890abcdef1234567890ABCDEF'],
    ['ghr_', 'ghr_ABCDEF1234567890abcdef1234567890ABCDEF'],
  ])('redacts the %s GitHub token variant', (_label, token) => {
    expect(redactSecretsInString(token)).not.toContain(token);
  });

  it('redacts an AWS access key id', () => {
    const s = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE next line';
    const out = redactSecretsInString(s);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain(REDACTION_MARKER);
  });

  it('redacts a Slack bot token', () => {
    const s = 'SLACK_BOT_TOKEN=xoxb-1234567890-1234567890-abcdef';
    const out = redactSecretsInString(s);
    expect(out).not.toContain('xoxb-1234');
  });

  it('redacts a PEM-encoded private key block', () => {
    const s =
      'leading text\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxx\n-----END RSA PRIVATE KEY-----\ntrailing';
    const out = redactSecretsInString(s);
    expect(out).not.toContain('MIIEowIBAA');
    expect(out).toContain('leading text');
    expect(out).toContain('trailing');
    expect(out).toContain(REDACTION_MARKER);
  });

  it('redacts a GCP service-account JSON private_key field (escaped PEM in JSON)', () => {
    const s =
      '{"type": "service_account", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADAN\\n-----END PRIVATE KEY-----\\n"}';
    const out = redactSecretsInString(s);
    expect(out).not.toContain('MIIEvQIBADAN');
    expect(out).toContain(REDACTION_MARKER);
  });
});

describe('redactSecretsInString — generic key=value', () => {
  it('redacts api_key= assignments', () => {
    const s = 'api_key=verysecret-abcd1234efgh5678ijkl9012';
    const out = redactSecretsInString(s);
    expect(out.startsWith('api_key=')).toBe(true);
    expect(out).toContain(REDACTION_MARKER);
    expect(out).not.toContain('verysecret-abcd1234');
  });

  it('redacts password= but preserves the prefix', () => {
    const s = 'password=hunter2hunter2hunter2hunter2';
    const out = redactSecretsInString(s);
    expect(out.startsWith('password=')).toBe(true);
    expect(out).not.toContain('hunter2hunter2');
  });

  it('redacts colon-style assignment (yaml shape)', () => {
    const s = 'auth_token: abcdefgh1234567890abcdefgh';
    const out = redactSecretsInString(s);
    expect(out).toContain(REDACTION_MARKER);
    expect(out).not.toContain('abcdefgh1234567890');
  });

  it('redacts inside JSON-like quoted values', () => {
    const s = '{ "client_secret": "abc12345defXYZabc12345" }';
    const out = redactSecretsInString(s);
    expect(out).not.toContain('abc12345defXYZ');
  });

  it('does NOT match obvious test fixture values that fail the heuristic', () => {
    // Length floor + alphabet — `password=foo` falls short.
    expect(redactSecretsInString('password=foo')).toBe('password=foo');
  });
});

describe('redactSecretsInString — idempotency / no-op', () => {
  it('idempotent on already-redacted strings (marker is not a secret)', () => {
    const once = redactSecretsInString(`api_key=${'a'.repeat(40)}1234`);
    const twice = redactSecretsInString(once);
    expect(once).toBe(twice);
  });

  it('returns the input unchanged when no secret is present', () => {
    const s = 'plain prose with no keys, only narrative';
    expect(redactSecretsInString(s)).toBe(s);
  });

  it('sanitizes controls only on the diagnostic boundary', () => {
    const esc = String.fromCharCode(0x1b);
    expect(redactSecretsInString(`line\r\n${esc}[2J`)).toBe(`line\r\n${esc}[2J`);
    expect(scrubTerminalDiagnosticAndBound(`line\r\n${esc}[2J`, 100)).toBe('line\n');
  });

  it('redacts a diagnostic secret split by a complete ANSI sequence', () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    const split = `${secret.slice(0, 20)}\u001b[31m${secret.slice(20)}`;

    expect(scrubTerminalDiagnosticAndBound(split, 100)).toBe(REDACTION_MARKER);
  });

  it('handles empty string and undefined-shaped inputs without crashing', () => {
    expect(redactSecretsInString('')).toBe('');
  });
});

describe('redactSecretsInObject', () => {
  it('redacts string-valued nodes recursively', () => {
    const input = {
      task: 'add ghp_ABCDEF1234567890abcdef1234567890ABCDEF to env',
      decisions: [{ rationale: 'use sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901' }],
      open_items: ['rotate password=hunter2hunter2hunter2'],
    };
    const out = redactSecretsInObject(input);
    expect(out.task).toContain(REDACTION_MARKER);
    expect(out.task).not.toContain('ghp_ABCDEF');
    expect(out.decisions[0].rationale).toContain(REDACTION_MARKER);
    expect(out.open_items[0]).toContain(REDACTION_MARKER);
  });

  it('preserves non-string scalar values (numbers, booleans, null)', () => {
    const input = { count: 5, enabled: true, missing: null };
    const out = redactSecretsInObject(input);
    expect(out).toEqual({ count: 5, enabled: true, missing: null });
  });

  it('returns the input unchanged when no node contains a secret', () => {
    const input = { a: 'one', b: ['two', 'three'], c: { d: 4 } };
    const out = redactSecretsInObject(input);
    expect(out).toEqual(input);
  });

  it('preserves CRLF content in exported object fields', () => {
    const input = { diff: '-old\r\n+new\r\n' };
    expect(redactSecretsInObject(input)).toEqual(input);
  });

  it('does not mutate the input object', () => {
    const input = { secret: 'api_key=abc123def456ghi789jkl012' };
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    redactSecretsInObject(input);
    expect(input).toEqual(snapshot);
  });
});

describe('shared secret corpus', () => {
  // The corpus is shared; the ASSERTION is not. This side proves the value
  // is replaced in the output. The pack's detector proves it is located and
  // reported without echoing it. Both implementations stay independent — only
  // the list of shapes they must agree on is common, so a pattern weakened on
  // one side fails here rather than drifting silently.
  it.each(SECRET_POSITIVES.map((s) => [s.name, s.sample] as const))(
    'redacts %s',
    (_name, sample) => {
      const out = redactSecretsInString(`value: ${sample}`);
      expect(out).not.toContain(sample);
      expect(out).toContain('REDACTED');
      // Every LINE, not just the blob. A multi-line sample fails
      // `not.toContain(sample)` the moment one line changes, so partial
      // redaction — most of a key emitted while the first line is masked —
      // satisfied this assertion completely.
      for (const line of sample.split('\n')) {
        const material = line.trim();
        if (material.length < 16) continue;
        expect(out, `a line of ${_name} survived redaction`).not.toContain(material);
      }
    }
  );

  it.each(SECRET_NEGATIVES.map((s) => [s] as const))('leaves %s untouched', (sample) => {
    expect(redactSecretsInString(sample)).toBe(sample);
  });
});
