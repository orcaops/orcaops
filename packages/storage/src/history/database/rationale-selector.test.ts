import { expect, it } from 'vitest';

import {
  parseRationaleSelector,
  rationaleSelector,
  type RationaleSelector,
} from './rationale-selector.js';

const id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const selections: RationaleSelector[] = [
  { kind: 'capture', id, path: 'decisions.0.decision' },
  { kind: 'capture', id, path: 'décisions.0' },
  { kind: 'interpretation', id },
  { kind: 'correction', id },
  { kind: 'identity', id: 'named:identity', identity_kind: 'decision' },
];

it.each(selections)('identifies a $kind account without lookup state', (selection) => {
  const reference = rationaleSelector(selection);
  expect(parseRationaleSelector(reference)).toEqual(selection);
  expect(reference.length).toBeLessThan(90);
  expect(reference).not.toMatch(/rationale\d\./);
});

it.each([
  '',
  'unknown:x',
  'capture:x:decisions.0',
  `capture:${id}:`,
  'decision:',
  `interpretation:${id}:extra`,
  'rationale2.W10',
  'rationale1.W10',
  'decision:a\nb',
  `claim:${'x'.repeat(1024)}`,
])('rejects malformed selectors: %s', (value) => {
  expect(() => parseRationaleSelector(value)).toThrow('account selector');
});
