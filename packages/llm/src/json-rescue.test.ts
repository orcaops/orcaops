import { describe, expect, it } from 'vitest';

import { rescueJson } from './json-rescue.js';

describe('JSON punctuation rescue', () => {
  it.each([
    ['{"a":1,}', { a: 1 }],
    ['[1,2,]', [1, 2]],
    ['{"a":1 "b":[true false null]}', { a: 1, b: [true, false, null] }],
    ['[{"a":1}{"b":2}]', [{ a: 1 }, { b: 2 }]],
    ['{"a":1}}', { a: 1 }],
    ['{"a":1}]', { a: 1 }],
    ['```json\n{"a":1,}\n```', { a: 1 }],
    [' \n```\n[1,2]\n```\n', [1, 2]],
    [
      '[{"rationale":{"kind":"unknown"}},"alternatives":[],"links":[]}]',
      [{ rationale: { kind: 'unknown' }, alternatives: [], links: [] }],
    ],
    [
      '[{"rationale":{"kind":"unknown"}},"alternatives":[]},{"rationale":{"kind":"unknown"}},"alternatives":[]}]',
      [
        { rationale: { kind: 'unknown' }, alternatives: [] },
        { rationale: { kind: 'unknown' }, alternatives: [] },
      ],
    ],
  ])('repairs punctuation in %s without replacing values', (body, expected) => {
    const rescued = rescueJson(body);
    expect(rescued).not.toBeNull();
    expect(JSON.parse(rescued!.body)).toEqual(expected);
    expect(rescued!.repair.originalBody).toBe(body);
    let replay = body;
    for (const edit of [...rescued!.repair.edits].reverse()) {
      expect(replay.slice(edit.offset, edit.offset + edit.removed.length)).toBe(edit.removed);
      replay =
        replay.slice(0, edit.offset) +
        edit.inserted +
        replay.slice(edit.offset + edit.removed.length);
    }
    expect(replay).toBe(rescued!.body);
  });

  it('preserves escapes, quoted punctuation, unicode, and number spelling', () => {
    const body = String.raw`{"quote":"brace }, comma , and \"quotes\"; \u0061; 界","n":-1.20e+3,}`;
    expect(rescueJson(body)?.body).toBe(body.replace(/,}$/, '}'));
  });

  it.each([
    '{"a":1}',
    '{"a":',
    '{"a":1',
    '{"a":"unfinished}',
    '{"a":"raw\nnewline",}',
    '{"a":}',
    '{a:1}',
    "{'a':1}",
    '{"a":undefined}',
    '{"a":1,"a":2,}',
    '{"a":1,"\\u0061":2,}',
    '[01,]',
    '[truefalse,]',
    '[1e,]',
    '[1,,2]',
    '{"a":1} {"b":2}',
    'Here is your answer: {"a":1,}',
    '```json\n{"a":1}\n```\nHope that helps.',
    '{"a":{"b":1}},"c":2}}',
    '[0 1 2 3 4 5]',
  ])('declines unsupported, ambiguous, or unnecessary repair of %s', (body) => {
    expect(rescueJson(body)).toBeNull();
  });

  it('refuses repair when the complete candidate search exceeds its bound', () => {
    const body = `[${Array.from({ length: 100 }, () => '{"a":{"b":1}}').join(',')}]}}`;
    expect(rescueJson(body)).toBeNull();
  });

  it('bounds input size, token count, and nesting', () => {
    expect(rescueJson(`{"a":"${'x'.repeat(1024 * 1024)}",}`)).toBeNull();
    expect(rescueJson(`[${'0,'.repeat(17_000)}]`)).toBeNull();
    expect(rescueJson(`${'['.repeat(130)}0,${']'.repeat(130)}`)).toBeNull();
  });
});
