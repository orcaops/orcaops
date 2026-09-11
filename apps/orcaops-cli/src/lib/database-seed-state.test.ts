import { describe, expect, it } from 'vitest';

import type {
  SeedCoverageReport,
  SeedJournal,
  SeedPreciousState,
} from '@orcaops/storage/history/seed-schema';

import {
  loadDatabaseSeedStateForWrite,
  publishDatabaseSeedState,
  readDatabaseSeedState,
} from './database-seed-state.js';
import { fixture } from '../../tests/helpers/database-history.js';

const NONCE = '0123456789abcdef0123456789abcdef';

function precious(overrides: Partial<SeedPreciousState> = {}): SeedPreciousState {
  return {
    schema_version: 1,
    install_nonce: NONCE,
    pr_context: false,
    pending_importance: false,
    commit_graph_hint_shown: false,
    discovery_areas: {},
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
function journal(overrides: Partial<SeedJournal> = {}): SeedJournal {
  return {
    schema_version: 2,
    install_nonce: NONCE,
    options_hash: 'opt-1',
    updated_at: '2026-01-01T00:00:00.000Z',
    clusters: {},
    jobs: {},
    ...overrides,
  };
}
function coverage(): SeedCoverageReport {
  return {
    schema_version: 1,
    branch_sha: 'a'.repeat(40),
    generated_at: '2026-01-01T00:00:00.000Z',
    complete: true,
    directories: { src: { covered_lines: 10, total_lines: 20, percent: 50 } },
  };
}

describe('database seed state', () => {
  it('derives one stable initial nonce before the first state publication', async () => {
    const f = await fixture();
    try {
      const first = loadDatabaseSeedStateForWrite(f.writer);
      const second = loadDatabaseSeedStateForWrite(f.writer);
      expect(first.precious.install_nonce).toMatch(/^[a-f0-9]{32}$/u);
      expect(second.precious.install_nonce).toBe(first.precious.install_nonce);
      expect(first.expectedRevision).toBeNull();
      expect(readDatabaseSeedState(f.writer)).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  it('preserves the retained install nonce when loading a later write', async () => {
    const f = await fixture();
    try {
      await publishDatabaseSeedState(f.writer, {
        precious: precious({ install_nonce: 'fedcba9876543210fedcba9876543210' }),
        journal: journal({ install_nonce: 'fedcba9876543210fedcba9876543210' }),
        expectedRevision: null,
      });
      const loaded = loadDatabaseSeedStateForWrite(f.writer);
      expect(loaded.precious.install_nonce).toBe('fedcba9876543210fedcba9876543210');
      expect(loaded.journal.install_nonce).toBe('fedcba9876543210fedcba9876543210');
      expect(loaded.expectedRevision?.generation).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  it('is null before anything is published', async () => {
    const f = await fixture();
    try {
      expect(readDatabaseSeedState(f.writer)).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  it('publishes precious, journal and coverage as one revision and reads them back', async () => {
    const f = await fixture();
    try {
      const published = await publishDatabaseSeedState(f.writer, {
        precious: precious({ pr_context: true }),
        journal: journal({ clusters: { c1: { artifact_id: 'a1', status: 'complete' } } }),
        coverage: coverage(),
        expectedRevision: null,
      });
      expect(published.revision.generation).toBe(1);

      const snapshot = readDatabaseSeedState(f.writer);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.precious?.pr_context).toBe(true);
      expect(snapshot!.journal?.clusters.c1?.status).toBe('complete');
      expect(snapshot!.coverage?.directories.src?.percent).toBe(50);
      expect(snapshot!.revision).toEqual(published.revision);
    } finally {
      await f.cleanup();
    }
  });

  it('replays the same state publication with its original operation identities', async () => {
    const f = await fixture();
    try {
      const input = {
        precious: precious(),
        journal: journal(),
        coverage: coverage(),
        expectedRevision: null,
      };
      const first = await publishDatabaseSeedState(f.writer, input);
      const replay = await publishDatabaseSeedState(f.writer, input);
      expect(replay.revision).toEqual(first.revision);
      expect(readDatabaseSeedState(f.writer)?.revision).toEqual(first.revision);
    } finally {
      await f.cleanup();
    }
  });

  it('supersedes the prior revision when anchored to it', async () => {
    const f = await fixture();
    try {
      const first = await publishDatabaseSeedState(f.writer, {
        precious: precious(),
        journal: journal(),
        expectedRevision: null,
      });
      const second = await publishDatabaseSeedState(f.writer, {
        precious: precious({ pending_importance: true }),
        journal: journal({ options_hash: 'opt-2' }),
        expectedRevision: first.revision,
      });
      expect(second.revision.generation).toBe(2);
      const snapshot = readDatabaseSeedState(f.writer);
      expect(snapshot!.precious?.pending_importance).toBe(true);
      expect(snapshot!.journal?.options_hash).toBe('opt-2');
    } finally {
      await f.cleanup();
    }
  });

  it('refuses a write anchored to a stale revision', async () => {
    const f = await fixture();
    try {
      const first = await publishDatabaseSeedState(f.writer, {
        precious: precious(),
        journal: journal(),
        expectedRevision: null,
      });
      // Advance past `first`.
      await publishDatabaseSeedState(f.writer, {
        precious: precious({ pr_context: true }),
        journal: journal(),
        expectedRevision: first.revision,
      });
      // A second writer still holding `first` must be refused, not silently overwrite.
      await expect(
        publishDatabaseSeedState(f.writer, {
          precious: precious({ commit_graph_hint_shown: true }),
          journal: journal(),
          expectedRevision: first.revision,
        })
      ).rejects.toThrow();
      const snapshot = readDatabaseSeedState(f.writer);
      expect(snapshot!.precious?.pr_context).toBe(true);
      expect(snapshot!.precious?.commit_graph_hint_shown).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});
