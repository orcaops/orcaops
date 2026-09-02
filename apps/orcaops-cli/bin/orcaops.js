#!/usr/bin/env node

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(`orcaops requires Node >= 22; you are running v${process.versions.node}.\n`);
  process.exit(1);
}
await import('../dist/cli/index.js');
