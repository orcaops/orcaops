import { describe, expect, it } from 'vitest';

import { MAX_FINDINGS_BLOCK_CHARS, parseFindingsBlock } from './findings-block.js';
import { FINDINGS_BLOCK_SCHEMA, MAX_EVALUATOR_FINDINGS } from './schemas/finding.js';
import { parseMarkdownVerdict } from './verdict.js';

function block(json: string, fence = '```'): string {
  return [`${fence}orcaops-findings`, json, fence].join('\n');
}

function payload(findings: unknown): string {
  return JSON.stringify({ schema: FINDINGS_BLOCK_SCHEMA, findings });
}

const ONE_FINDING = payload([
  { key: 'non-goal/cloud-sync', title: 'Checkpoint 3 adds cloud sync, a declared non-goal' },
]);

function reasonOf(body: string): string {
  const res = parseFindingsBlock(body);
  expect(res.status).toBe('unreadable');
  return res.status === 'unreadable' ? res.reason : '';
}

describe('a response with no findings block', () => {
  it('reads as absent when nothing is fenced', () => {
    expect(parseFindingsBlock('The checkpoint respects every non-goal.')).toEqual({
      status: 'absent',
    });
  });

  it('reads as absent when only a verdict sentinel is fenced', () => {
    const body = ['Nothing to flag.', '', '```orcaops-verdict', 'PASS', '```'].join('\n');
    expect(parseFindingsBlock(body)).toEqual({ status: 'absent' });
  });

  it('reads as absent when an unrelated fence swallows the rest of the response', () => {
    const body = ['```md', 'an example that was never closed', '```orcaops-findings'].join('\n');
    expect(parseFindingsBlock(body)).toEqual({ status: 'absent' });
  });
});

describe('an example a prompt documents', () => {
  it('is invisible when indented four spaces, which is how CommonMark renders it', () => {
    const body = [
      'Your prompt may show the block like this:',
      '',
      '    ```orcaops-findings',
      `    ${ONE_FINDING}`,
      '    ```',
      '',
      'I found nothing.',
    ].join('\n');
    expect(parseFindingsBlock(body)).toEqual({ status: 'absent' });
  });

  it('is invisible inside a longer enclosing fence', () => {
    const body = ['````', '```orcaops-findings', ONE_FINDING, '```', '````'].join('\n');
    expect(parseFindingsBlock(body)).toEqual({ status: 'absent' });
  });

  it('is invisible inside a tilde fence', () => {
    const body = ['~~~', '```orcaops-findings', ONE_FINDING, '```', '~~~'].join('\n');
    expect(parseFindingsBlock(body)).toEqual({ status: 'absent' });
  });

  it('leaves a real block after an indented echo readable', () => {
    const body = [
      'The prompt showed me:',
      '',
      '    ```orcaops-findings',
      `    ${payload([{ title: 'an echoed example' }])}`,
      '    ```',
      '',
      'Mine:',
      '',
      block(ONE_FINDING),
    ].join('\n');
    const res = parseFindingsBlock(body);
    expect(res.status === 'ok' && res.findings[0].key).toBe('non-goal/cloud-sync');
  });

  it('makes an unindented echo followed by a real block unreadable rather than guessing', () => {
    const body = [block(payload([{ title: 'an echoed example' }])), '', block(ONE_FINDING)].join(
      '\n'
    );
    expect(reasonOf(body)).toContain('more than one');
  });
});

describe('a well-formed findings block', () => {
  it('returns the findings it carries', () => {
    const res = parseFindingsBlock(['Some prose.', '', block(ONE_FINDING)].join('\n'));
    expect(res.status === 'ok' && res.findings[0].key).toBe('non-goal/cloud-sync');
  });

  it('accepts an explicitly empty findings array', () => {
    expect(parseFindingsBlock(block(payload([]))).status).toBe('ok');
  });

  it('accepts a longer fence and up to three columns of indentation', () => {
    expect(parseFindingsBlock(block(ONE_FINDING, '````')).status).toBe('ok');
    const indented = ['   ```orcaops-findings', `   ${ONE_FINDING}`, '   ```'].join('\n');
    expect(parseFindingsBlock(indented).status).toBe('ok');
  });

  it('accepts pretty-printed JSON', () => {
    const pretty = JSON.stringify(
      { schema: FINDINGS_BLOCK_SCHEMA, findings: [{ title: 'a finding' }] },
      null,
      2
    );
    expect(parseFindingsBlock(block(pretty)).status).toBe('ok');
  });

  it('accepts a response whose only line ending is a lone carriage return', () => {
    const body = block(ONE_FINDING).split('\n').join('\r');
    expect(parseFindingsBlock(body).status).toBe('ok');
  });

  it('accepts more findings than the bound, which the caller truncates', () => {
    const many = Array.from({ length: MAX_EVALUATOR_FINDINGS + 1 }, (_, i) => ({ title: `f${i}` }));
    const res = parseFindingsBlock(block(payload(many)));
    expect(res.status === 'ok' && res.findings).toHaveLength(MAX_EVALUATOR_FINDINGS + 1);
  });
});

describe('coexistence with the verdict', () => {
  const body = [
    'Checkpoint 3 crosses a non-goal.',
    '',
    block(
      payload([{ title: 'sync added', detail: 'The word VIOLATION appears\nin this detail.' }])
    ),
    '',
    '```orcaops-verdict',
    'VIOLATION',
    '```',
  ].join('\n');

  it('parses the findings and the verdict independently', () => {
    expect(parseFindingsBlock(body).status).toBe('ok');
    expect(parseMarkdownVerdict(body)).toBe('violation');
  });

  it('keeps a verdict token inside a finding off its own line, so the fallback tier is unaffected', () => {
    const passing = [
      'Nothing crossed.',
      '',
      block(payload([{ title: 'a note', detail: 'not a VIOLATION\nof anything' }])),
      '',
      '```orcaops-verdict',
      'PASS',
      '```',
    ].join('\n');
    expect(parseMarkdownVerdict(passing)).toBe('pass');
  });
});

describe('findings that cannot be read', () => {
  it('refuses a block that is never closed', () => {
    expect(reasonOf(['```orcaops-findings', ONE_FINDING].join('\n'))).toContain('never closed');
  });

  it('refuses a response cut off mid-block', () => {
    const cut = block(ONE_FINDING).slice(0, 60);
    expect(reasonOf(cut)).toContain('never closed');
  });

  it('refuses a tilde fence rather than reading it as absent', () => {
    const body = ['~~~orcaops-findings', ONE_FINDING, '~~~'].join('\n');
    expect(reasonOf(body)).toContain('backtick fence');
  });

  it('refuses an info string carrying anything beyond the marker', () => {
    expect(reasonOf(['```orcaops-findings json', ONE_FINDING, '```'].join('\n'))).toContain(
      'must be exactly'
    );
  });

  it('refuses an info string carrying a stray backtick rather than reading it as absent', () => {
    const body = ['```orcaops-findings`', ONE_FINDING, '```'].join('\n');
    expect(reasonOf(body)).toContain('no backtick');
  });

  it('refuses content that is not JSON, including a trailing comma', () => {
    expect(reasonOf(block('- a bullet list of findings'))).toContain('not valid JSON');
    expect(
      reasonOf(block(`{"schema":"${FINDINGS_BLOCK_SCHEMA}","findings":[{"title":"x"},]}`))
    ).toContain('not valid JSON');
  });

  it('refuses a repeated key at the top level rather than keeping the last one', () => {
    const body = block(
      `{"schema":"${FINDINGS_BLOCK_SCHEMA}","findings":[{"title":"first"}],"findings":[{"title":"second"}]}`
    );
    expect(reasonOf(body)).toContain('repeats an object key');
  });

  it('refuses a repeated schema key that would smuggle in the right literal', () => {
    const body = block(`{"schema":"nonsense","findings":[],"schema":"${FINDINGS_BLOCK_SCHEMA}"}`);
    expect(reasonOf(body)).toContain('repeats an object key');
  });

  it('refuses a repeated key inside a finding', () => {
    const body = block(
      `{"schema":"${FINDINGS_BLOCK_SCHEMA}","findings":[{"title":"a","title":"b"}]}`
    );
    expect(reasonOf(body)).toContain('repeats an object key');
  });

  it('refuses a key repeated under an escaped spelling', () => {
    const body = block(
      `{"schema":"${FINDINGS_BLOCK_SCHEMA}","findings":[{"title":"first"}],"\\u0066indings":[{"title":"second"}]}`
    );
    expect(reasonOf(body)).toContain('repeats an object key');
  });

  it('does not mistake a repeated key in one finding for one across siblings', () => {
    const body = block(
      `{"schema":"${FINDINGS_BLOCK_SCHEMA}","findings":[{"title":"a"},{"title":"b"}]}`
    );
    expect(parseFindingsBlock(body).status).toBe('ok');
  });

  it('does not mistake a brace inside a string for a container', () => {
    const body = block(payload([{ title: 'a { "title": "not a key" } b' }]));
    expect(parseFindingsBlock(body).status).toBe('ok');
  });

  it('refuses a JSON array or scalar', () => {
    expect(reasonOf(block('[{"title":"x"}]'))).toContain('must be a JSON object');
    expect(reasonOf(block('"a string"'))).toContain('must be a JSON object');
  });

  it('refuses an object that declares no schema literal', () => {
    expect(reasonOf(block('{"findings":[]}'))).toContain('must declare');
  });

  it('names the supported literal when the block declares another one', () => {
    const reason = reasonOf(
      block(JSON.stringify({ schema: 'orcaops.evaluator_findings/v2', findings: [] }))
    );
    expect(reason).toContain('unsupported findings block schema');
    expect(reason).toContain(FINDINGS_BLOCK_SCHEMA);
  });

  it('refuses an unknown key, reporting its path', () => {
    expect(reasonOf(block(payload([{ title: 'x', severity: 'block' }])))).toContain('findings.0');
  });

  it('refuses an invalid location', () => {
    expect(
      reasonOf(block(payload([{ title: 'x', locations: [{ kind: 'file', path: '/etc/passwd' }] }])))
    ).toContain('findings.0.locations.0.path');
  });

  it('refuses a conclusion with no expectation to conclude about', () => {
    expect(
      reasonOf(
        block(
          payload([
            { title: 'x', locations: [{ kind: 'file', path: 'a.ts' }], conclusion: 'supported' },
          ])
        )
      )
    ).toContain('findings.0.conclusion');
  });

  it('refuses two findings claiming the same key', () => {
    const body = block(
      payload([
        { key: 'same', title: 'a' },
        { key: 'same', title: 'b' },
      ])
    );
    expect(reasonOf(body)).toContain('duplicate finding key');
  });

  it('refuses content past the size bound', () => {
    const huge = payload([{ title: 'x', detail: 'd'.repeat(MAX_FINDINGS_BLOCK_CHARS) }]);
    expect(reasonOf(block(huge))).toContain('exceeds');
  });

  it('never reports unreadable findings as absent or as findings', () => {
    for (const body of [
      block('not json'),
      ['```orcaops-findings', ONE_FINDING].join('\n'),
      [block(ONE_FINDING), block(ONE_FINDING)].join('\n'),
      ['~~~orcaops-findings', ONE_FINDING, '~~~'].join('\n'),
    ]) {
      expect(parseFindingsBlock(body).status).toBe('unreadable');
    }
  });
});
