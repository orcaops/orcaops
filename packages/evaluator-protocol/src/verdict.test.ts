import { describe, expect, it } from 'vitest';

import { parseMarkdownVerdict, parseVerdictSentinel } from './verdict.js';

const FENCE = '```';

function sentinel(token: string): string {
  return `${FENCE}orcaops-verdict\n${token}\n${FENCE}`;
}

describe('parseVerdictSentinel', () => {
  it('reads the verdict out of a fenced sentinel block', () => {
    expect(parseVerdictSentinel(`prose\n\n${sentinel('PASS')}\n`)).toBe('pass');
    expect(parseVerdictSentinel(sentinel('VIOLATION'))).toBe('violation');
    expect(parseVerdictSentinel(sentinel('INFO'))).toBe('info');
  });

  it('returns null when the response has no sentinel', () => {
    expect(parseVerdictSentinel('PASS\n\nno sentinel here')).toBeNull();
  });

  it('takes the LAST sentinel when several appear', () => {
    const body = `${sentinel('INFO')}\n\nreconsidering\n\n${sentinel('VIOLATION')}`;
    expect(parseVerdictSentinel(body)).toBe('violation');
  });

  it('resolves an echoed example followed by the model’s own verdict', () => {
    // The case last-wins exists for: every prompt that documents the sentinel
    // contains one, so a model may echo the example before committing. The
    // parser sees only the body and cannot tell an echo from an intent.
    const body = [
      'The format I was asked for is:',
      '',
      sentinel('PASS'),
      '',
      'Having checked the delivery, two criteria are under-delivered.',
      '',
      sentinel('VIOLATION'),
      '',
    ].join('\n');
    expect(parseVerdictSentinel(body)).toBe('violation');
  });

  it('ignores a block whose content is not exactly one verdict token', () => {
    expect(parseVerdictSentinel(`${FENCE}orcaops-verdict\nPASS with caveats\n${FENCE}`)).toBeNull();
    expect(parseVerdictSentinel(`${FENCE}orcaops-verdict\nPASS\nVIOLATION\n${FENCE}`)).toBeNull();
    expect(parseVerdictSentinel(`${FENCE}orcaops-verdict\n${FENCE}`)).toBeNull();
  });

  it('ignores an unterminated fence rather than throwing', () => {
    expect(() =>
      parseVerdictSentinel(`${FENCE}orcaops-verdict\nPASS\n\nand then the response ends`)
    ).not.toThrow();
    expect(
      parseVerdictSentinel(`${FENCE}orcaops-verdict\nPASS\n\nand then the response ends`)
    ).toBeNull();
  });

  it('ignores fenced blocks with a different info string', () => {
    expect(parseVerdictSentinel(`${FENCE}text\nPASS\n${FENCE}`)).toBeNull();
    expect(parseVerdictSentinel(`${FENCE}\nPASS\n${FENCE}`)).toBeNull();
  });

  it('tolerates CRLF, indentation, and longer fences', () => {
    expect(parseVerdictSentinel(`${FENCE}orcaops-verdict\r\nPASS\r\n${FENCE}\r\n`)).toBe('pass');
    expect(parseVerdictSentinel(`  ${FENCE}orcaops-verdict  \n  PASS  \n  ${FENCE}  `)).toBe(
      'pass'
    );
    expect(parseVerdictSentinel('````orcaops-verdict\nINFO\n````')).toBe('info');
  });

  it('does not match a lowercase or decorated token', () => {
    expect(parseVerdictSentinel(sentinel('pass'))).toBeNull();
    expect(parseVerdictSentinel(sentinel('**PASS**'))).toBeNull();
  });
});

describe('parseMarkdownVerdict', () => {
  it('prefers the sentinel over a later bare verdict line', () => {
    // Bare-line parsing is fence-blind, so without the sentinel tier the
    // trailing PASS below would silently become the recorded verdict.
    const body = `findings\n\n${sentinel('VIOLATION')}\n\nfootnote mentioning\nPASS\n`;
    expect(parseMarkdownVerdict(body)).toBe('violation');
  });

  it('falls back to the LAST standalone verdict line when no sentinel is present', () => {
    const body = 'INFO\n\nthinking...\n\nVIOLATION\n\nfindings here\n\nPASS\n';
    expect(parseMarkdownVerdict(body)).toBe('pass');
  });

  it('falls back when the sentinel block is malformed', () => {
    const body = `${FENCE}orcaops-verdict\nPASS and also VIOLATION\n${FENCE}\n\nINFO\n`;
    expect(parseMarkdownVerdict(body)).toBe('info');
  });

  it('handles trailing whitespace on bare verdict lines', () => {
    expect(parseMarkdownVerdict('PASS  \n\nbody')).toBe('pass');
  });

  it('returns null when neither tier finds a verdict', () => {
    expect(parseMarkdownVerdict('just some prose with the word PASS inline')).toBeNull();
    expect(parseMarkdownVerdict('')).toBeNull();
  });

  it('maps VIOLATION / PASS / INFO to lowercase verdicts', () => {
    expect(parseMarkdownVerdict('VIOLATION\n\n...')).toBe('violation');
    expect(parseMarkdownVerdict('INFO\n\nobservation')).toBe('info');
    expect(parseMarkdownVerdict('PASS')).toBe('pass');
    expect(parseMarkdownVerdict(sentinel('VIOLATION'))).toBe('violation');
  });
});
