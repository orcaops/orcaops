import { describe, expect, it } from 'vitest';

import { orcaopsPlanApprovalSkill } from './orcaops-plan-approval.js';

/**
 * Pins the plan-approval "read/download a plan body" wording so it can't
 * silently regress. `--version` lives on `orcaops plan review pull`, never on
 * `orcaops plan pull` (where it collides with the global `--version`). These
 * assertions lock the disambiguation in place.
 */
describe('orcaops-plan-approval pull guidance', () => {
  const body = orcaopsPlanApprovalSkill.body;

  it('names the in-review body fetch as a first-class section', () => {
    expect(body).toContain('# Read or download a plan body');
    expect(body).toContain('orcaops plan review pull <ref> --out <file>');
  });

  it('keeps the historical-version fetch fully qualified', () => {
    // --version lives on `plan review pull`, never on `plan pull` (where it
    // would hit the global --version). Guard the exact fully-qualified form.
    expect(body).toContain('orcaops plan review pull <ref> --version <n>');
  });

  it('disambiguates the two distinct pull commands', () => {
    expect(body).toContain('orcaops plan pull');
    expect(body).toContain('orcaops plan review pull');
  });

  it('uses the public id field and CLI error contract', () => {
    expect(body).toContain('`external_id`');
    expect(body).not.toContain('`externalId`');
    expect(body).toContain('reports `NO_INPUT`');
    expect(body).not.toMatch(/`plan pull` `NOT_FOUND`/);
  });

  it('never opens a code-span with a bare `pull`', () => {
    // Every reference is `plan pull` or `plan review pull`, so no
    // backtick-opened code-span should start with "pull". This single invariant
    // catches `pull <ref>`, `pull --proposal`, and `pull <ref> --version <n>`
    // anywhere in the body.
    expect(body).not.toMatch(/`pull/);
  });

  it('advertises reading and downloading cloud plans', () => {
    const { description } = orcaopsPlanApprovalSkill;
    expect(description).toMatch(/read, download/);
    expect(description).toContain('cloud approval flow');
  });
});
