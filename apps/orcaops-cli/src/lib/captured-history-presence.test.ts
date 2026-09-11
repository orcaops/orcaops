import { describe, expect, it } from 'vitest';

import { repositoryHasCapturedHistory } from './captured-history-presence.js';
import { fixture } from '../../tests/helpers/database-history.js';

describe('captured history presence', () => {
  it('reports nothing captured until the project database holds an artifact', async () => {
    const f = await fixture();
    try {
      expect(await repositoryHasCapturedHistory(f.main, { dataRoot: f.root })).toBe(false);
      await f.capture();
      expect(await repositoryHasCapturedHistory(f.main, { dataRoot: f.root })).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('answers "nothing captured" for a directory with no history rather than failing', async () => {
    const f = await fixture();
    try {
      expect(await repositoryHasCapturedHistory(f.temporary, { dataRoot: f.root })).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});
