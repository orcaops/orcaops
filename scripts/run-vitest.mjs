import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const options = JSON.parse(process.env.ORCAOPS_TEST_ARGS ?? '[]');
if (!Array.isArray(options) || options.some((option) => typeof option !== 'string')) {
  throw new TypeError('ORCAOPS_TEST_ARGS must be a JSON array of strings');
}
delete process.env.ORCAOPS_TEST_ARGS;

const require = createRequire(path.join(process.cwd(), 'package.json'));
const manifestPath = require.resolve('vitest/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entry = path.resolve(path.dirname(manifestPath), manifest.bin.vitest);
process.argv = [process.execPath, entry, 'run', ...options, ...process.argv.slice(2)];
await import(pathToFileURL(entry).href);
