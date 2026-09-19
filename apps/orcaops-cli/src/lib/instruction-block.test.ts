import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ORCAOPS_AGENTS_MD_MARKER_END, ORCAOPS_BLOCK_ROUTING_SENTINEL } from '@orcaops/adapters';

import { instructionFileCarriesRouting, readInstructionBlock } from './instruction-block.js';

const MARKER_START = '<!-- orcaops:start v=1.2.3 -->';

const block = (body: string): string =>
  `# Project\n\n${MARKER_START}\n${body}\n${ORCAOPS_AGENTS_MD_MARKER_END}\n`;

const routingBlock = (): string =>
  block(`${ORCAOPS_BLOCK_ROUTING_SENTINEL} Match user phrasing: "where was I" → resume.`);

describe('instruction block', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-instruction-block-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the managed block through an in-repo instruction symlink', async () => {
    await writeFile(path.join(root, 'CLAUDE.md'), routingBlock(), 'utf8');
    await symlink('CLAUDE.md', path.join(root, 'AGENTS.md'));

    expect(await readInstructionBlock(root, 'AGENTS.md')).toContain(MARKER_START);
    expect(await instructionFileCarriesRouting(root, 'AGENTS.md')).toBe(true);
  });

  it('returns the marker region alone, not the surrounding prose', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), routingBlock(), 'utf8');

    const region = await readInstructionBlock(root, 'AGENTS.md');
    expect(region?.startsWith(MARKER_START)).toBe(true);
    expect(region?.endsWith(ORCAOPS_AGENTS_MD_MARKER_END)).toBe(true);
    expect(region).not.toContain('# Project');
  });

  it('answers null for an instruction file that carries no markers', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), '# Hand written\n', 'utf8');

    expect(await readInstructionBlock(root, 'AGENTS.md')).toBeNull();
  });

  it('answers null for a managed region with no end marker', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), `${MARKER_START}\nbody\n`, 'utf8');

    expect(await readInstructionBlock(root, 'AGENTS.md')).toBeNull();
  });

  it('answers null for an absent instruction file', async () => {
    expect(await readInstructionBlock(root, 'AGENTS.md')).toBeNull();
  });

  it('answers null for an instruction file that is a directory', async () => {
    await mkdir(path.join(root, 'AGENTS.md'));

    expect(await readInstructionBlock(root, 'AGENTS.md')).toBeNull();
  });

  it('answers null for a dangling instruction link', async () => {
    await symlink('CLAUDE.md', path.join(root, 'AGENTS.md'));

    expect(await readInstructionBlock(root, 'AGENTS.md')).toBeNull();
  });

  it('answers null for a link that leaves the repository', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oo-instruction-outside-'));
    await writeFile(path.join(outside, 'AGENTS.md'), routingBlock(), 'utf8');
    await symlink(path.join(outside, 'AGENTS.md'), path.join(root, 'AGENTS.md'));

    try {
      expect(await readInstructionBlock(root, 'AGENTS.md')).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('separates a block carrying routing from one whose read-intent section was trimmed', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), block('Lifecycle only.'), 'utf8');

    expect(await readInstructionBlock(root, 'AGENTS.md')).not.toBeNull();
    expect(await instructionFileCarriesRouting(root, 'AGENTS.md')).toBe(false);
  });

  it('does not treat prose merely naming the routing heading as a block', async () => {
    await writeFile(
      path.join(root, 'AGENTS.md'),
      `# Notes\n\nOur hook emits ${ORCAOPS_BLOCK_ROUTING_SENTINEL} when nothing else does.\n`,
      'utf8'
    );

    expect(await instructionFileCarriesRouting(root, 'AGENTS.md')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'does not open an instruction file that is a FIFO',
    async () => {
      execFileSync('mkfifo', [path.join(root, 'AGENTS.md')]);

      expect(await readInstructionBlock(root, 'AGENTS.md')).toBeNull();
    }
  );
});
