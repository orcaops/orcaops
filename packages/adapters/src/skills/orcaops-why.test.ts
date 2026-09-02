import { describe, expect, it } from 'vitest';

import { orcaopsWhySkill } from './orcaops-why.js';

/**
 * The miss path must carry the sanctioned discovery offer write itself:
 * agents reach a `why` miss through this skill without ever loading the
 * seed-discovery lane, so the wording cannot depend on that framing.
 */
function render(prefix: string): string {
  const { body } = orcaopsWhySkill;
  return typeof body === 'function' ? body(prefix) : body;
}

describe('orcaops-why miss guidance', () => {
  const body = render('orcaops');

  it('records the offer via seed status --offered on a miss', () => {
    expect(body).toContain('# On a miss in a repo with imported history');
    expect(body).toContain('orcaops seed status --offered <area>');
  });

  it('recommends the user-invoked seed skill with commit/path context', () => {
    expect(body).toContain('`orcaops-seed`');
    expect(body).toContain('orcaops seed --commit <sha>');
    expect(body).toContain('orcaops seed --path <dir>');
  });

  it('leaves declined areas to the user', () => {
    expect(body).toContain('orcaops seed status --offer-again <area>');
    expect(body).toContain("the user's call");
  });

  it('renders the cross-references under a custom prefix', () => {
    const prefixed = render('oo');
    expect(prefixed).toContain('`oo-seed`');
    expect(prefixed).toContain('`oo-seed-discovery`');
    // The CLI surface keeps its real binary name regardless of prefix.
    expect(prefixed).toContain('orcaops seed status --offered <area>');
  });
});

describe('orcaops-why routing cues', () => {
  const body = render('orcaops');

  it('claims the ownership and history phrasings that otherwise reach git blame', () => {
    // "who owns X" and "history behind X" are what people actually type, and
    // they match git log/blame far better than they matched this skill.
    const { description } = orcaopsWhySkill;
    expect(description).toContain('who owns this code?');
    expect(description).toContain('what is the history behind this file?');
    expect(description).toContain('how did this evolve?');
  });

  it('scopes the confidence tiers to line mode', () => {
    // Every whole-file entry is `weak` by construction; a table that defines
    // the tiers in line terms taught agents to read that as a poor answer.
    expect(body).toContain('Read `mode` before `confidence`');
    expect(body).toContain('it is a lane marker, not a quality signal');
    expect(body).toContain('**Whole-file mode** (`mode: "whole-file"`) — no tier applies');
    expect(body).toContain('Check `mode` first');
  });

  it('gives a bare file path its own shape and sends it to a line', () => {
    expect(body).toContain('**Shape 3 — a whole file.**');
    // Whole-file mode answers file-history questions; steering agents off it
    // would send them to git for the one question it exists to serve.
    expect(body).toContain('Pass the bare path');
    expect(body).toContain('an aggregate, not a ranking');
    expect(body).toContain('Choose the shape by the question, not by the target');
    expect(body).not.toContain('Do NOT pass the bare path');
  });

  it('documents complete compact history and expanded whole-file detail', () => {
    expect(body).toContain('orcaops why <file>                            # complete history');
    expect(body).toContain('orcaops why <file> --all');
    expect(body).toContain('JSON always carries the\ncomplete history in `all`');
    expect(body).toContain('`--all`\nexpands the same checkpoints');
  });
});
