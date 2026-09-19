import { describe, expect, it } from 'vitest';

import { type Config, getDefaultConfig, type SupportedAgentId } from '@orcaops/storage';

import {
  assessMachineSessionHookCoverage,
  machineCoverageNeedsAttention,
} from './session-hooks-coverage.js';
import type { UserSessionHookSurfaceHealth } from './session-hooks-user.js';

const TOML = '/home/u/.codex/config.toml';
const JSON_PATH = '/home/u/.codex/hooks.json';
const CLAUDE = '/home/u/.claude/settings.json';

function configWith(
  overrides: Partial<{ agents: SupportedAgentId[]; entries: 'project' | 'none' }>
) {
  const config: Config = getDefaultConfig();
  config.install.agents = overrides.agents ?? ['codex'];
  config.session_hooks.enabled = true;
  config.session_hooks.entries = overrides.entries ?? 'project';
  return config;
}

function row(
  overrides: Partial<UserSessionHookSurfaceHealth> & { path: string }
): UserSessionHookSurfaceHealth {
  return {
    agent: 'codex',
    state: 'absent',
    primaryAction: 'none',
    recorded: false,
    owned: false,
    coverage: 'uncovered',
    current: true,
    customized: false,
    present: false,
    ...overrides,
  };
}

const assessCodex = (
  surfaces: UserSessionHookSurfaceHealth[],
  codexGate?: { path: string; disabled: boolean | null } | null
) => assessMachineSessionHookCoverage({ config: configWith({}), surfaces, codexGate })[0];

describe('machine session-hook coverage assessment', () => {
  it('covers codex when either current representation carries the registration', () => {
    for (const covered of [TOML, JSON_PATH]) {
      const surfaces = [TOML, JSON_PATH].map((p) =>
        row({ path: p, ...(p === covered ? { state: 'installed', coverage: 'covered' } : {}) })
      );
      expect(assessCodex(surfaces), covered).toMatchObject({ state: 'covered', required: true });
    }
  });

  it('treats a superseded registration as coverage, since codex loads both files', () => {
    const surfaces = [
      row({ path: TOML, state: 'superseded', coverage: 'covered' }),
      row({ path: JSON_PATH, state: 'installed', coverage: 'covered' }),
    ];
    expect(assessCodex(surfaces).state).toBe('covered');
  });

  it('reports one missing requirement and one remedy for two absent candidates', () => {
    const result = assessCodex([row({ path: TOML }), row({ path: JSON_PATH })]);
    expect(result.state).toBe('missing');
    expect(result.remedy).toBe(
      'Run `orcaops session-hooks install --agents codex` to register the machine hook.'
    );
    expect(result.contributing).toEqual([TOML, JSON_PATH]);
  });

  describe('the shared disable gate outranks any registration', () => {
    const gate = { path: TOML, disabled: true };

    it('breaks a json-only registration with no record at all', () => {
      const result = assessCodex(
        [row({ path: TOML }), row({ path: JSON_PATH, state: 'installed', coverage: 'covered' })],
        gate
      );
      expect(result.state).toBe('broken');
      expect(result.remedy).toContain('features.hooks');
      expect(result.remedy).not.toContain('session-hooks install');
    });

    it('breaks a dual registration too', () => {
      const result = assessCodex(
        [
          row({ path: TOML, state: 'installed', coverage: 'covered' }),
          row({ path: JSON_PATH, state: 'installed', coverage: 'covered' }),
        ],
        gate
      );
      expect(result.state).toBe('broken');
      expect(result.remedy).toContain('features.hooks');
    });

    it('permits coverage when the gate is open', () => {
      const result = assessCodex(
        [row({ path: TOML }), row({ path: JSON_PATH, state: 'installed', coverage: 'covered' })],
        { path: TOML, disabled: false }
      );
      expect(result.state).toBe('covered');
    });

    it('keeps an inconclusive inspection distinct from a confirmed disable', () => {
      const result = assessCodex(
        [row({ path: TOML }), row({ path: JSON_PATH, state: 'installed', coverage: 'covered' })],
        { path: TOML, disabled: null }
      );
      // Not broken — nothing proves a disable. But not covered either: the
      // file we could not read is the one that could silence hooks.json.
      expect(result.state).toBe('unknown');
      expect(result.remedy).toContain('could not be inspected');
      expect(result.contributing).toContain(TOML);
    });
  });

  it('classifies a present registration that cannot fire as broken, not missing', () => {
    const result = assessCodex([
      row({
        path: TOML,
        state: 'registered-but-broken',
        coverage: 'uncovered',
        present: true,
        owned: true,
        remedy: 'Run `orcaops session-hooks install --agents codex` and choose managed mode.',
        primaryAction: 'install',
      }),
      row({ path: JSON_PATH }),
    ]);
    expect(result.state).toBe('broken');
    expect(result.remedy).toContain('session-hooks install');
    expect(result.primaryAction).toBe('install');
  });

  it('stays covered when a broken alternative sits beside a verified registration', () => {
    const result = assessCodex([
      row({ path: TOML, state: 'registered-but-broken', coverage: 'uncovered', owned: true }),
      row({ path: JSON_PATH, state: 'installed', coverage: 'covered' }),
    ]);
    expect(result.state).toBe('covered');
    // The broken alternative is still visible as an inventory finding.
    expect(result.contributing).toContain(TOML);
  });

  it('reports unknown, never a removal claim, when a candidate cannot be inspected', () => {
    const result = assessCodex([
      row({
        path: TOML,
        state: 'registered-unverified',
        coverage: 'unverifiable',
        remedy: 'permission denied — retry after restoring access',
        primaryAction: 'restore-access',
      }),
      row({ path: JSON_PATH, state: 'registered-but-broken', coverage: 'uncovered' }),
    ]);
    expect(result.state).toBe('unknown');
    expect(result.remedy).toContain('restoring access');
    expect(result.primaryAction).toBe('restore-access');
    expect(result.contributing).toEqual([TOML, JSON_PATH]);
  });

  it('gives customized coverage manual-review guidance rather than a generic install', () => {
    const result = assessCodex([
      row({ path: TOML, customized: true, owned: true, coverage: 'uncovered' }),
      row({ path: JSON_PATH }),
    ]);
    expect(result.state).toBe('unknown');
    expect(result.remedy).toContain('customized session-hook command');
    expect(result.remedy).toContain(TOML);
    expect(result.remedy).toContain('may duplicate guidance');
  });

  it('never lets a historical row satisfy or mask current coverage', () => {
    const historical = row({
      path: '/old/home/.codex/config.toml',
      state: 'installed',
      coverage: 'covered',
      current: false,
      recorded: true,
    });
    const result = assessCodex([historical, row({ path: TOML }), row({ path: JSON_PATH })]);
    expect(result.state).toBe('missing');
    expect(result.contributing).not.toContain('/old/home/.codex/config.toml');
  });

  it('requires nothing of an agent whose project hook is configured', () => {
    const results = assessMachineSessionHookCoverage({
      config: configWith({ agents: ['claude-code', 'codex'] }),
      surfaces: [row({ agent: 'claude-code', path: CLAUDE }), row({ path: TOML })],
    });
    const claude = results.find((r) => r.agent === 'claude-code');
    expect(claude).toMatchObject({ required: false, state: 'not-required' });
    expect(claude?.reason).toContain('project hook entry');
    expect(claude?.remedy).toBeUndefined();
    expect(results.find((r) => r.agent === 'codex')?.required).toBe(true);
  });

  it('requires machine coverage for every machine-capable agent once project entries are off', () => {
    const results = assessMachineSessionHookCoverage({
      config: configWith({ agents: ['claude-code', 'codex'], entries: 'none' }),
      surfaces: [row({ agent: 'claude-code', path: CLAUDE }), row({ path: TOML })],
    });
    expect(results.map((r) => [r.agent, r.state])).toEqual([
      ['claude-code', 'missing'],
      ['codex', 'missing'],
    ]);
  });

  it('reports only agents that have a machine surface', () => {
    const results = assessMachineSessionHookCoverage({
      config: configWith({ agents: ['claude-code', 'cursor', 'codex'], entries: 'none' }),
      surfaces: [row({ agent: 'claude-code', path: CLAUDE }), row({ path: TOML })],
    });
    // Cursor's hooks.json is a project file — it has no machine dependency to
    // report, and including it would attach a scope reason that is not why.
    expect(results.map((r) => r.agent)).toEqual(['claude-code', 'codex']);
  });

  it('carries the primary repair action separately from remedy wording', () => {
    const missing = assessCodex([row({ path: TOML }), row({ path: JSON_PATH })]);
    expect(missing.primaryAction).toBe('install');

    const gated = assessCodex([row({ path: JSON_PATH, state: 'installed', coverage: 'covered' })], {
      path: TOML,
      disabled: true,
    });
    expect(gated.primaryAction).toBe('enable-setting');

    const customized = assessCodex([
      row({ path: TOML, customized: true, owned: true }),
      row({ path: JSON_PATH }),
    ]);
    // The remedy names install to warn about it; that is not an offer.
    expect(customized.remedy).toContain('session-hooks install');
    expect(customized.primaryAction).toBe('manual-review');
  });

  it('flags attention for anything required and not covered', () => {
    const covered = assessCodex([row({ path: TOML, state: 'installed', coverage: 'covered' })]);
    expect(machineCoverageNeedsAttention([covered])).toBe(false);
    expect(machineCoverageNeedsAttention([assessCodex([row({ path: TOML })])])).toBe(true);
  });

  it('is a pure function of its inputs, so doctor and status cannot disagree', () => {
    const surfaces = [row({ path: TOML }), row({ path: JSON_PATH, coverage: 'unverifiable' })];
    const input = { config: configWith({}), surfaces, codexGate: { path: TOML, disabled: false } };
    expect(assessMachineSessionHookCoverage(input)).toEqual(
      assessMachineSessionHookCoverage(input)
    );
  });
});
