import { describe, expect, it } from 'vitest';

import { getToolAdapter } from '../registry.js';
import { orcaopsSeedDiscoverySkill } from './orcaops-seed-discovery.js';
import { orcaopsSeedSkill } from './orcaops-seed.js';

describe('seed skills', () => {
  it('renders parallel enrichment only for the Claude overlay', () => {
    const claude = getToolAdapter('claude-code')!.skills!.format(orcaopsSeedSkill, {
      generatedBy: 'test',
    });
    const codex = getToolAdapter('codex')!.skills!.format(orcaopsSeedSkill, {
      generatedBy: 'test',
    });
    const aider = getToolAdapter('aider-desk')!.skills!.format(orcaopsSeedSkill, {
      generatedBy: 'test',
    });
    const claudeDiscovery = getToolAdapter('claude-code')!.skills!.format(
      orcaopsSeedDiscoverySkill,
      { generatedBy: 'test' }
    );
    const codexDiscovery = getToolAdapter('codex')!.skills!.format(orcaopsSeedDiscoverySkill, {
      generatedBy: 'test',
    });
    const aiderDiscovery = getToolAdapter('aider-desk')!.skills!.format(orcaopsSeedDiscoverySkill, {
      generatedBy: 'test',
    });

    expect(claude).toContain('enrich the dry-run bundles in parallel');
    expect(claudeDiscovery).toContain('subagents to assess disjoint directories');
    expect(codex).toContain('process the dry-run bundles serially');
    expect(aider).toContain('process the dry-run bundles serially');
    expect(codexDiscovery).not.toContain('subagents to assess');
    expect(aiderDiscovery).not.toContain('subagents to assess');
  });

  it('keeps explicit consent, disclosure, and single-apply rules in the import workflow', () => {
    const rendered = getToolAdapter('codex')!.skills!.format(orcaopsSeedSkill, {
      generatedBy: 'test',
    });
    expect(rendered.indexOf('Only proceed on explicit user request.')).toBeLessThan(
      rendered.indexOf('# Workflow')
    );
    expect(rendered).toContain('confirmation');
    expect(rendered).toContain('synthesized');
    expect(rendered).toContain('commit authors');
    expect(rendered).toContain('ONE');
    expect(rendered).toContain('--enrichment-dir');
    expect(rendered).not.toContain('seed --push');
  });

  it('requires per-nomination accounting scaled by the cluster task count', () => {
    const rendered = getToolAdapter('codex')!.skills!.format(orcaopsSeedSkill, {
      generatedBy: 'test',
    });
    expect(rendered).toContain('Account for every candidate decision nomination');
    expect(rendered).toContain('zero unaccounted nominations');
    expect(rendered).toContain('"Distinct tasks" count');
    expect(rendered).toContain('never stop at a fixed per-cluster quota');
    // The dispositions array accounts for the NOMINATIONS, so an un-nominated
    // in-cluster citation legally has no row — an earlier wording implied it
    // was a decision count and made that legal case read as a defect.
    expect(rendered).toContain('accounts for the NOMINATIONS, not for your decisions');
    // Fewer nominations than the ceiling is the common case, not a failure to
    // try hard enough — the old wording read as pressure to invent.
    expect(rendered).toContain('never pad');
  });

  it('bounds bundle authoring with a triage rule and a per-bundle ceiling', () => {
    const rendered = getToolAdapter('codex')!.skills!.format(orcaopsSeedSkill, {
      generatedBy: 'test',
    });
    // "Scale with the task count" alone reads as an unbounded ask on a
    // 196-task cluster, and the honest response to that is to skip the bundle.
    expect(rendered).toContain('per-bundle effort ceiling');
    expect(rendered).toContain('bulk-disposition');
    expect(rendered).toContain('never a reason to skip it wholesale');
    expect(rendered).toContain('Triage before authoring');
    expect(rendered).toContain('20 bundles per');
  });

  it('names the enrichment output directory rather than leaving it to a guess', () => {
    const rendered = getToolAdapter('codex')!.skills!.format(orcaopsSeedSkill, {
      generatedBy: 'test',
    });
    expect(rendered).toContain('enrichment.bundle_directory');
    expect(rendered).toContain('Writing beside the bundles is the sanctioned layout');
    expect(rendered).toMatch(/SAME directory the bundles were written\s+to/u);
  });

  it('keeps autonomous discovery read-only apart from recording its own offer', () => {
    const rendered = getToolAdapter('codex')!.skills!.format(orcaopsSeedDiscoverySkill, {
      generatedBy: 'test',
    });
    expect(rendered).toContain('strictly');
    expect(rendered).toContain('orcaops seed status --json');
    expect(rendered).toContain('explicitly invoke');
    expect(rendered).toContain('orcaops seed status --offered <area>');
    expect(rendered).toContain('ONE sanctioned state write');
    expect(rendered).toContain('read-only or no-write posture');
    expect(rendered).not.toContain('--dry-run');
    expect(rendered).not.toContain('--yes');
    expect(rendered).not.toContain('--enrichment-dir');
    expect(rendered).not.toContain('status --decline');
  });

  it('reads suppression from the durable discovery state with its cooldown', () => {
    const rendered = getToolAdapter('codex')!.skills!.format(orcaopsSeedDiscoverySkill, {
      generatedBy: 'test',
    });
    expect(rendered).toContain('discovery.declined');
    expect(rendered).toContain('cooldown_active');
    expect(rendered).toContain('last 7 days');
    expect(rendered).toContain('--offer-again <area>');
    expect(rendered).toContain('survives a cache wipe');
    expect(rendered).toContain('shared by every linked worktree');
  });

  it('keeps provider-backed PR evidence explicitly opt-in', () => {
    const rendered = getToolAdapter('codex')!.skills!.format(orcaopsSeedSkill, {
      generatedBy: 'test',
    });
    expect(rendered).toContain('PR context is opt-in');
    expect(rendered).toContain('--pr-context');
    expect(rendered).toContain('PR titles, bodies, and threads only for');
    expect(rendered).toContain('Decisions remain commit-cited only');
    expect(rendered).not.toContain('PR URL/number as the citation');
    expect(rendered).toMatch(/network or provider\s+call during the default local-only flow/u);
  });
});
