import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readSupplementalNotice,
  renderNotice,
  supplementalDirName,
} from './third-party-notices.mjs';

const NOTICE = 'MIT License\n\nCopyright (c) 2013 Example Author\n\nPermission is hereby granted.';
const SOURCE = 'url: https://example.invalid/LICENSE\ncommit: 0123456789abcdef\ndate: 2026-01-01';

let dir;

const writePackage = (name, version, { license, files = {} } = {}) => {
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version, license }));
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(path.join(pkgDir, file), contents);
  }
  return pkgDir;
};

const writeSupplemental = (name, version, files) => {
  const noticeDir = path.join(dir, 'third-party-notices', supplementalDirName(name, version));
  mkdirSync(noticeDir, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(path.join(noticeDir, file), contents);
  }
  return noticeDir;
};

const render = (pkgDir) => renderNotice(pkgDir, { rootDir: dir });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'orcaops-notices-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('supplementalDirName', () => {
  it('keeps an unscoped name as it is', () => {
    expect(supplementalDirName('omggif', '1.0.10')).toBe('omggif@1.0.10');
  });

  it('replaces the path separator in a scoped name', () => {
    expect(supplementalDirName('@tokenizer/token', '0.3.0')).toBe('@tokenizer+token@0.3.0');
  });
});

describe('readSupplementalNotice', () => {
  const supplementalRoot = () => path.join(dir, 'third-party-notices');

  it('returns null when nothing is vendored for the package', () => {
    expect(readSupplementalNotice(supplementalRoot(), 'omggif', '1.0.10')).toBeNull();
  });

  it('returns null for a different version than the one vendored', () => {
    writeSupplemental('omggif', '1.0.10', { LICENSE: NOTICE, 'SOURCE.txt': SOURCE });
    expect(readSupplementalNotice(supplementalRoot(), 'omggif', '1.0.11')).toBeNull();
  });

  it('returns the trimmed notice and its recorded source', () => {
    writeSupplemental('omggif', '1.0.10', {
      LICENSE: `${NOTICE}\n\n`,
      'SOURCE.txt': `${SOURCE}\n`,
    });
    const found = readSupplementalNotice(supplementalRoot(), 'omggif', '1.0.10');
    expect(found.text).toBe(NOTICE);
    expect(found.source).toBe(SOURCE);
  });

  it('rejects a notice with no SOURCE.txt beside it', () => {
    writeSupplemental('omggif', '1.0.10', { LICENSE: NOTICE });
    expect(() => readSupplementalNotice(supplementalRoot(), 'omggif', '1.0.10')).toThrow(
      /no SOURCE\.txt/
    );
  });

  it('rejects a notice whose SOURCE.txt is blank', () => {
    writeSupplemental('omggif', '1.0.10', { LICENSE: NOTICE, 'SOURCE.txt': '   \n\n' });
    expect(() => readSupplementalNotice(supplementalRoot(), 'omggif', '1.0.10')).toThrow(
      /SOURCE\.txt .* is empty/
    );
  });

  it('rejects an empty notice even when its source is recorded', () => {
    writeSupplemental('omggif', '1.0.10', { LICENSE: '\n\n', 'SOURCE.txt': SOURCE });
    expect(() => readSupplementalNotice(supplementalRoot(), 'omggif', '1.0.10')).toThrow(
      /is empty, so it attributes nothing/
    );
  });
});

describe('renderNotice with a vendored notice', () => {
  it('still throws for a package with neither its own notice nor a vendored one', () => {
    const pkgDir = writePackage('omggif', '1.0.10', { license: 'MIT' });
    expect(() => render(pkgDir)).toThrow(/ships no license file/);
  });

  it('names the directory to vendor into when it throws', () => {
    const pkgDir = writePackage('@tokenizer/token', '0.3.0', { license: 'MIT' });
    expect(() => render(pkgDir)).toThrow(/third-party-notices\/@tokenizer\+token@0\.3\.0\//);
  });

  it('reproduces the vendored notice for a package that ships none', () => {
    const pkgDir = writePackage('omggif', '1.0.10', { license: 'MIT' });
    writeSupplemental('omggif', '1.0.10', { LICENSE: NOTICE, 'SOURCE.txt': SOURCE });

    const block = render(pkgDir).join('\n');
    expect(block).toContain('### omggif@1.0.10 — MIT');
    expect(block).toContain(NOTICE);
  });

  it('points at the recorded source without altering the notice text', () => {
    const pkgDir = writePackage('omggif', '1.0.10', { license: 'MIT' });
    writeSupplemental('omggif', '1.0.10', { LICENSE: NOTICE, 'SOURCE.txt': SOURCE });

    const block = render(pkgDir).join('\n');
    expect(block).toContain('third-party-notices/omggif@1.0.10/SOURCE.txt');
    expect(block.endsWith(`${NOTICE}\n`)).toBe(true);
  });

  it('resolves a package that declares no license at all', () => {
    const pkgDir = writePackage('mystery', '1.0.0');
    writeSupplemental('mystery', '1.0.0', { LICENSE: NOTICE, 'SOURCE.txt': SOURCE });

    const block = render(pkgDir).join('\n');
    expect(block).toContain('### mystery@1.0.0 — SEE LICENSE FILE');
    expect(block).toContain(NOTICE);
  });

  it('fails the render when the vendored notice has no recorded source', () => {
    const pkgDir = writePackage('omggif', '1.0.10', { license: 'MIT' });
    writeSupplemental('omggif', '1.0.10', { LICENSE: NOTICE });
    expect(() => render(pkgDir)).toThrow(/no SOURCE\.txt/);
  });

  it('prefers the package’s own notice over a vendored one', () => {
    const pkgDir = writePackage('omggif', '1.0.10', {
      license: 'MIT',
      files: { LICENSE: 'THE PACKAGE OWN NOTICE' },
    });
    writeSupplemental('omggif', '1.0.10', { LICENSE: NOTICE, 'SOURCE.txt': SOURCE });

    const block = render(pkgDir).join('\n');
    expect(block).toContain('THE PACKAGE OWN NOTICE');
    expect(block).not.toContain(NOTICE);
    expect(block).not.toContain('SOURCE.txt');
  });

  it('ignores an unsourced vendored notice when the package ships its own', () => {
    const pkgDir = writePackage('omggif', '1.0.10', {
      license: 'MIT',
      files: { LICENSE: 'THE PACKAGE OWN NOTICE' },
    });
    writeSupplemental('omggif', '1.0.10', { LICENSE: NOTICE });
    expect(() => render(pkgDir)).not.toThrow();
  });
});
