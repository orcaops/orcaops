import { expect, it } from 'vitest';

import {
  rationaleLexicalSupport,
  rationaleSourcePath,
  rationaleTargetMatch,
} from './rationale-relevance.js';

it('requires localized explanatory overlap rather than an inventory or reason-only match', () => {
  const seeds = [
    'Keep native navigation history in src/navigation.ts so Back restores tab scroll position.',
  ];
  expect(
    rationaleLexicalSupport(
      'Remove the parallel navigation history store.',
      'The native stack already preserves tab scroll position.',
      seeds
    )
  ).toBeGreaterThan(0);
  expect(
    rationaleLexicalSupport('Move the mobile editor route.', 'Maintain native navigation.', seeds)
  ).toBe(0);
  expect(
    rationaleLexicalSupport(
      'Retain the per-file inventory including src/navigation.ts.',
      'Archive hash records. '.repeat(300) + seeds[0],
      seeds
    )
  ).toBe(0);
});

it.each([
  ['mobile', 'signing'],
  ['native', 'symbols'],
  ['navigation', 'mesh'],
  ['move', 'ownership'],
])('retains %s as subject vocabulary without admitting single-term overlap', (subject, topic) => {
  const seeds = [`${subject} ${topic}`];
  expect(rationaleLexicalSupport(`Preserve ${subject} ${topic}.`, null, seeds)).toBe(2);
  expect(rationaleLexicalSupport(`Preserve ${subject} metadata.`, null, seeds)).toBe(0);
  expect(rationaleLexicalSupport(`Preserve ${topic} metadata.`, null, seeds)).toBe(0);
});

it('does not let change verbs substitute for overlap with the subject of a decision', () => {
  const seeds = [
    'Keep a durable delivery lease. Behavioral assertions and failure controls protect notification delivery.',
  ];
  expect(
    rationaleLexicalSupport(
      'Retire obsolete archive paths.',
      'Behavioral assertions and failure controls retain value.',
      seeds
    )
  ).toBe(0);
  expect(
    rationaleLexicalSupport(
      'Replace the delivery lease with a transactional outbox.',
      'The outbox prevents duplicate notification delivery after a worker restart.',
      seeds
    )
  ).toBeGreaterThan(0);
});

it('distinguishes literal target references from vocabulary overlap and generic context', () => {
  expect(
    rationaleTargetMatch('Use native history in src/navigation.ts.', 'src/navigation.ts').kind
  ).toBe('explicit_path');
  expect(
    rationaleTargetMatch('Keep `src/navigation.ts` platform-owned.', 'src/navigation.ts').kind
  ).toBe('explicit_path');
  expect(rationaleTargetMatch('Keep navigation platform-owned.', 'src/navigation.ts')).toEqual({
    kind: 'target_terms',
    terms: ['navigation'],
  });
  expect(
    rationaleTargetMatch('Keep src/navigation.tsx unchanged.', 'src/navigation.ts').kind
  ).not.toBe('explicit_path');
  expect(rationaleTargetMatch('The app index keeps generic context.', 'src/app/index.ts')).toEqual({
    kind: 'candidate_context',
    terms: [],
  });
});

it('groups reasons and alternatives with their exact decision field', () => {
  expect(rationaleSourcePath('decisions[12].reason')).toBe('decisions.12.decision');
  expect(rationaleSourcePath('decisions.12.alternatives_considered.0.rejected_because')).toBe(
    'decisions.12.decision'
  );
  expect(rationaleSourcePath('decisions.1.decision')).not.toBe(
    rationaleSourcePath('decisions.12.decision')
  );
});
