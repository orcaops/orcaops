import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  injectOrcaopsSection,
  planInjectOrcaopsSection,
  planRemoveOrcaopsSection,
  readOrcaopsSectionIdentity,
  readOrcaopsSectionStamp,
} from './inject.js';
import {
  ORCAOPS_AGENTS_MD_MARKER_END,
  ORCAOPS_AGENTS_MD_MARKER_START_RE,
  renderOrcaopsAgentsMdSection,
} from './template.js';

describe('injectOrcaopsSection', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-agentsmd-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('desiredBlock is required at compile time', () => {
    const missing = () =>
      // @ts-expect-error — desiredBlock omitted: the caller must render it
      injectOrcaopsSection({ filePath: 'x', containmentRoot: 'y' });
    void missing;
    expect(true).toBe(true);
  });

  it('creates the file from scratch when missing', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const result = await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    expect(result.action).toBe('created');
    const content = await readFile(filePath, 'utf8');
    expect(content).toMatch(/<!-- orcaops:start v=0\.1\.0 -->/);
    expect(content).toMatch(/<!-- orcaops:end -->/);
    expect(content).toMatch(/^<!-- orcaops:start/);
  });

  it('appends to an existing file with no markers, preserving prior content', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await writeFile(filePath, '# My Project\n\nSome user content.\n', 'utf8');
    const result = await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    expect(result.action).toBe('inserted');
    const content = await readFile(filePath, 'utf8');
    expect(content.startsWith('# My Project\n\nSome user content.\n')).toBe(true);
    expect(content).toMatch(/<!-- orcaops:start v=0\.1\.0 -->/);
  });

  it('replaces an existing managed section in place; preserves content above and below', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    // Initial install at v=0.1.0
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    // Wrap in user content
    const original = await readFile(filePath, 'utf8');
    const wrapped = `# My Project\n\nHeader\n\n${original}\nFooter content\n`;
    await writeFile(filePath, wrapped, 'utf8');

    // Re-inject at v=0.2.0
    const result = await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.2.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    expect(result.action).toBe('replaced');
    const next = await readFile(filePath, 'utf8');
    expect(next.startsWith('# My Project\n\nHeader\n\n')).toBe(true);
    expect(next.endsWith('Footer content\n')).toBe(true);
    expect(next).toMatch(/<!-- orcaops:start v=0\.2\.0 -->/);
    expect(next).not.toMatch(/<!-- orcaops:start v=0\.1\.0 -->/);
    // Exactly one section
    const matches = next.match(/<!-- orcaops:start/g);
    expect(matches).toHaveLength(1);
  });

  it('returns unchanged when stamp + body match (preserves mtime)', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    const result = await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    expect(result.action).toBe('unchanged');
  });

  it('--force re-writes even when content is identical', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    const result = await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
      force: true,
    });
    expect(result.action).toBe('replaced');
  });

  it('--force is byte-stable across consecutive runs (no drift)', async () => {
    // Regression test: running `orcaops update --force` against an
    // already-generated file at the same orcaops version must produce
    // byte-identical output. Otherwise every CI run shows whitespace
    // drift on AGENTS.md / CLAUDE.md and the agent stamps the same
    // version stamp with different bodies.
    //
    // Templates are already deterministic; this test catches future
    // nondeterminism (e.g., timestamp / counter / hash leaking into the
    // rendered body).
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    const first = await readFile(filePath, 'utf8');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
      force: true,
    });
    const second = await readFile(filePath, 'utf8');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
      force: true,
    });
    const third = await readFile(filePath, 'utf8');
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('--force preserves bytes outside the marker block across consecutive runs', async () => {
    // Same byte-stability guarantee, but with user content surrounding
    // the managed section. The slice math (`+ 1` for the trailing
    // newline) and the `before + desired + after` rejoin must be
    // exact — off-by-one would gradually erode user content or insert
    // blank lines.
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    const initial = await readFile(filePath, 'utf8');
    const wrapped = `# Header\n\nuser line\n\n${initial}\nfooter\n`;
    await writeFile(filePath, wrapped, 'utf8');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
      force: true,
    });
    const first = await readFile(filePath, 'utf8');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
      force: true,
    });
    const second = await readFile(filePath, 'utf8');
    expect(second).toBe(first);
    expect(first.startsWith('# Header\n\nuser line\n\n')).toBe(true);
    expect(first.endsWith('footer\n')).toBe(true);
  });

  it.each(['', '\n', '\r\n', 'adjacent user text'])(
    'preserves the exact %j suffix after the end marker',
    async (suffix) => {
      const filePath = path.join(tmpRoot, 'AGENTS.md');
      const oldBlock = renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }).replace(/\n$/, '');
      const newBlock = renderOrcaopsAgentsMdSection({ generatedBy: '0.2.0' }).replace(/\n$/, '');
      await writeFile(filePath, oldBlock + suffix, 'utf8');

      const result = await injectOrcaopsSection({
        desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.2.0' }),
        filePath,
        containmentRoot: tmpRoot,
      });

      expect(result.action).toBe('replaced');
      expect(await readFile(filePath, 'utf8')).toBe(newBlock + suffix);
    }
  );

  it('preserves an unterminated managed section by default', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const malformed = `# Header\n\n<!-- orcaops:start v=0.0.5 -->\noh no, no end marker\n`;
    await writeFile(filePath, malformed, 'utf8');

    const result = await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });

    expect(result.action).toBe('unchanged');
    expect(await readFile(filePath, 'utf8')).toBe(malformed);
  });

  it('repairs an unterminated managed section only when explicitly requested', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await writeFile(
      filePath,
      `# Header\n\n<!-- orcaops:start v=0.0.5 -->\noh no, no end marker\n`,
      'utf8'
    );
    const result = await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
      repairMalformed: true,
    });
    expect(result.action).toBe('replaced');
    const next = await readFile(filePath, 'utf8');
    expect(next.startsWith('# Header\n\n')).toBe(true);
    expect(next).toMatch(/<!-- orcaops:start v=0\.1\.0 -->/);
    expect(next).toMatch(/<!-- orcaops:end -->/);
  });

  it.each([
    '<!-- orcaops:start v=0.0.1 -->\n<!-- orcaops:start v=0.0.2 -->\nbody\n<!-- orcaops:end -->\n',
    '<!-- orcaops:start v=0.0.1 -->\nbody\n<!-- orcaops:start v=0.0.2 -->\n<!-- orcaops:end -->\n',
    '<!-- orcaops:start v=0.0.1 -->\nbody\n<!-- orcaops:end -->\n<!-- orcaops:start v=0.0.2 -->\n',
    '<!-- orcaops:start v=0.0.1 -->\nbody\n<!-- orcaops:end -->\n<!-- orcaops:end -->\n',
  ])('preserves ambiguous marker layouts by default', async (malformed) => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await writeFile(filePath, malformed, 'utf8');

    const plan = await planInjectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.2.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });

    expect(plan.action).toBe('unchanged');
    expect(plan.malformed).toBe(true);
    expect(plan.desiredContent).toBe(malformed);
  });

  it('allows explicit repair of an ambiguous marker layout', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const malformed =
      '# user prefix\n<!-- orcaops:start v=0.0.1 -->\nbody\n<!-- orcaops:end -->\n<!-- orcaops:start v=0.0.2 -->\nuser tail\n';
    await writeFile(filePath, malformed, 'utf8');

    const plan = await planInjectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.2.0' }),
      filePath,
      containmentRoot: tmpRoot,
      repairMalformed: true,
    });

    expect(plan.action).toBe('replaced');
    expect(plan.malformed).toBe(true);
    expect(plan.desiredContent.startsWith('# user prefix\n')).toBe(true);
    expect(plan.desiredContent).not.toContain('user tail');
    expect(plan.desiredContent.match(/<!-- orcaops:start/g)).toHaveLength(1);
  });

  it('a malformed layout containing an AHEAD stamp is preserved even under explicit repair', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const malformed =
      '# user prefix\n<!-- orcaops:start v=0.0.1 -->\nbody\n<!-- orcaops:end -->\n<!-- orcaops:start v=99.0.0 -->\nnewer tail\n';
    await writeFile(filePath, malformed, 'utf8');

    const plan = await planInjectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.2.0' }),
      filePath,
      containmentRoot: tmpRoot,
      repairMalformed: true,
    });

    expect(plan.action).toBe('unchanged');
    expect(plan.malformed).toBe(true);
    expect(plan.reason).toBe('preserved-ahead');
    expect(plan.onDiskVersion).toBe('99.0.0');
    expect(plan.desiredContent).toBe(malformed);
  });

  it('overrideAhead restores explicit repair of an ahead malformed layout', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const malformed = '# user prefix\n<!-- orcaops:start v=99.0.0 -->\nnewer body, no end marker\n';
    await writeFile(filePath, malformed, 'utf8');

    const plan = await planInjectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.2.0' }),
      filePath,
      containmentRoot: tmpRoot,
      repairMalformed: true,
      overrideAhead: true,
    });

    expect(plan.action).toBe('replaced');
    expect(plan.malformed).toBe(true);
    expect(plan.reason).toBe('forced-downgrade');
    expect(plan.onDiskVersion).toBe('99.0.0');
    expect(plan.desiredContent.startsWith('# user prefix\n')).toBe(true);
    expect(plan.desiredContent).not.toContain('newer body');
  });

  it('handles a file with no trailing newline before append (no doubled blank lines)', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await writeFile(filePath, '# No trailing newline', 'utf8');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    const next = await readFile(filePath, 'utf8');
    // Should have exactly one blank line between user content and our section
    expect(next).toMatch(/^# No trailing newline\n\n<!-- orcaops:start/);
  });

  it('creates parent directories when target lives in a nested path', async () => {
    const filePath = path.join(tmpRoot, 'nested', 'subdir', 'AGENTS.md');
    const result = await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    expect(result.action).toBe('created');
    const content = await readFile(filePath, 'utf8');
    expect(content).toMatch(/<!-- orcaops:start/);
  });

  it('preserves a non-regular instruction entry', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await mkdir(filePath);

    const result = await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });

    expect(result.action).toBe('unchanged');
    expect((await lstat(filePath)).isDirectory()).toBe(true);
  });

  it('marker regex captures the version stamp', () => {
    const sample = '<!-- orcaops:start v=1.2.3-rc.1 -->';
    const m = sample.match(ORCAOPS_AGENTS_MD_MARKER_START_RE);
    expect(m?.[1]).toBe('1.2.3-rc.1');
  });

  it('preserves a managed block stamped by a NEWER orcaops (ahead guard)', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '9.9.9' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    const initial = await readFile(filePath, 'utf8');
    const wrapped = `# Header\n\n${initial}\nfooter\n`;
    await writeFile(filePath, wrapped, 'utf8');

    const older = {
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    };
    const plan = await planInjectOrcaopsSection(older);
    expect(plan.action).toBe('unchanged');
    expect(plan.reason).toBe('preserved-ahead');
    expect(plan.onDiskVersion).toBe('9.9.9');
    expect(plan.desiredContent).toBe(wrapped);

    const result = await injectOrcaopsSection(older);
    expect(result.action).toBe('unchanged');
    expect(await readFile(filePath, 'utf8')).toBe(wrapped);
  });

  it('blanket force alone does NOT downgrade an ahead block', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '9.9.9' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    const before = await readFile(filePath, 'utf8');

    const plan = await planInjectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
      force: true,
    });
    expect(plan.action).toBe('unchanged');
    expect(plan.reason).toBe('preserved-ahead');
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });

  it('DOWNGRADES with overrideAhead — proving the guard, not luck, preserves the block', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '9.9.9' }),
      filePath,
      containmentRoot: tmpRoot,
    });

    const forced = {
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
      force: true,
      overrideAhead: true,
    };
    const plan = await planInjectOrcaopsSection(forced);
    expect(plan.action).toBe('replaced');
    expect(plan.reason).toBe('forced-downgrade');
    expect(plan.onDiskVersion).toBe('9.9.9');

    const result = await injectOrcaopsSection(forced);
    expect(result.action).toBe('replaced');
    expect(await readFile(filePath, 'utf8')).toMatch(/<!-- orcaops:start v=0\.1\.0 -->/);
  });

  it('ahead guard applies to a malformed block (end marker missing) — no destructive recovery', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const malformed = `# Header\n\n<!-- orcaops:start v=9.9.9 -->\nno end marker\n`;
    await writeFile(filePath, malformed, 'utf8');

    const plan = await planInjectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.1.0' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    expect(plan.action).toBe('unchanged');
    expect(plan.reason).toBe('preserved-ahead');
    expect(plan.desiredContent).toBe(malformed);
  });

  it('end marker constant matches the literal we emit', () => {
    expect(ORCAOPS_AGENTS_MD_MARKER_END).toBe('<!-- orcaops:end -->');
  });
});

describe('readOrcaopsSectionStamp', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-agentsmd-stamp-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', async () => {
    const stamp = await readOrcaopsSectionStamp(path.join(tmpRoot, 'missing.md'), tmpRoot);
    expect(stamp).toBeNull();
  });

  it('returns null for a dangling final symlink', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await symlink('missing.md', filePath);
    expect(await readOrcaopsSectionStamp(filePath, tmpRoot)).toBeNull();
  });

  it('returns null for a non-regular instruction entry', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await mkdir(filePath);
    expect(await readOrcaopsSectionStamp(filePath, tmpRoot)).toBeNull();
  });

  it('returns null when the file has no managed section', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await writeFile(filePath, '# Just user content\n', 'utf8');
    const stamp = await readOrcaopsSectionStamp(filePath, tmpRoot);
    expect(stamp).toBeNull();
  });

  it('returns the stamp from a managed section', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await injectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.4.2' }),
      filePath,
      containmentRoot: tmpRoot,
    });
    const stamp = await readOrcaopsSectionStamp(filePath, tmpRoot);
    expect(stamp).toBe('0.4.2');
  });

  it('gives same-version managed body edits a different content identity', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const block = renderOrcaopsAgentsMdSection({ generatedBy: '0.4.2' });
    await writeFile(filePath, block, 'utf8');
    const original = await readOrcaopsSectionIdentity(filePath, tmpRoot);

    await writeFile(filePath, block.replace('This repo uses', 'This project uses'), 'utf8');
    const edited = await readOrcaopsSectionIdentity(filePath, tmpRoot);

    expect(original?.version).toBe('0.4.2');
    expect(edited?.version).toBe('0.4.2');
    expect(edited?.contentHash).not.toBe(original?.contentHash);
  });

  it('returns null for ambiguous marker layouts', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await writeFile(
      filePath,
      '<!-- orcaops:start v=0.4.2 -->\n<!-- orcaops:end -->\n<!-- orcaops:start v=0.4.3 -->\n',
      'utf8'
    );
    expect(await readOrcaopsSectionStamp(filePath, tmpRoot)).toBeNull();
  });
});

describe('planRemoveOrcaopsSection (managed→manual flip)', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-remove-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('strips a clean current block, preserving surrounding content', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const block = renderOrcaopsAgentsMdSection({ generatedBy: '1.2.3' });
    await writeFile(filePath, `# My notes\n\n${block}\nmore prose\n`, 'utf8');

    const plan = await planRemoveOrcaopsSection({
      filePath,
      expectedBlock: block,
      containmentRoot: tmpRoot,
    });
    expect(plan.action).toBe('removed');
    expect(plan.desiredContent).not.toMatch(ORCAOPS_AGENTS_MD_MARKER_START_RE);
    expect(plan.desiredContent).toContain('# My notes');
    expect(plan.desiredContent).toContain('more prose');
  });

  it.each([
    ['', ''],
    ['\n', ''],
    ['\r\n', ''],
    ['adjacent user text', 'adjacent user text'],
  ])('removes the owned line ending without consuming %j', async (suffix, expected) => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const block = renderOrcaopsAgentsMdSection({ generatedBy: '1.2.3' });
    await writeFile(filePath, block.replace(/\n$/, '') + suffix, 'utf8');

    const plan = await planRemoveOrcaopsSection({
      filePath,
      expectedBlock: block,
      containmentRoot: tmpRoot,
    });

    expect(plan.action).toBe('removed');
    expect(plan.desiredContent).toBe(expected);
  });

  it('preserves malformed marker layouts instead of guessing ownership', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const malformed =
      '<!-- orcaops:start v=1.2.3 -->\nbody\n<!-- orcaops:end -->\n<!-- orcaops:start v=1.2.4 -->\n';
    await writeFile(filePath, malformed, 'utf8');

    const plan = await planRemoveOrcaopsSection({
      filePath,
      expectedBlock: renderOrcaopsAgentsMdSection({ generatedBy: '1.2.3' }),
      containmentRoot: tmpRoot,
    });

    expect(plan.action).toBe('preserved-modified');
    expect(plan.desiredContent).toBe(malformed);
  });

  it('preserves a non-regular instruction entry', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const block = renderOrcaopsAgentsMdSection({ generatedBy: '1.2.3' });
    await mkdir(filePath);

    const plan = await planRemoveOrcaopsSection({
      filePath,
      expectedBlock: block,
      containmentRoot: tmpRoot,
    });

    expect(plan.action).toBe('preserved-modified');
    expect((await lstat(filePath)).isDirectory()).toBe(true);
  });

  it('preserves + reports a user-modified block instead of stripping it', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    const block = renderOrcaopsAgentsMdSection({ generatedBy: '1.2.3' });
    const edited = block.replace('## Orcaops', '## Orcaops (my edits)');
    await writeFile(filePath, edited, 'utf8');

    const plan = await planRemoveOrcaopsSection({
      filePath,
      expectedBlock: block,
      containmentRoot: tmpRoot,
    });
    expect(plan.action).toBe('preserved-modified');
    expect(plan.desiredContent).toContain('my edits'); // the user's bytes are untouched
  });

  it('is a no-op (absent) when there is no managed block', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    await writeFile(filePath, '# Just user content\n', 'utf8');
    const plan = await planRemoveOrcaopsSection({
      filePath,
      expectedBlock: renderOrcaopsAgentsMdSection({ generatedBy: '1.2.3' }),
      containmentRoot: tmpRoot,
    });
    expect(plan.action).toBe('absent');
    expect(plan.desiredContent).toBe('# Just user content\n');
  });
});
