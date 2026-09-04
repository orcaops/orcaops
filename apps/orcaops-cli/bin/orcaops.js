#!/usr/bin/env node

// Node 22.14 is the floor because better-sqlite3's prebuilt addon segfaults while
// registering on 22.13 and below (WiseLibs/better-sqlite3#1514). Refuse here, before
// anything can load the addon, so those users get a sentence instead of a crash.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 14)) {
  process.stderr.write(
    `orcaops requires Node >= 22.14; you are running v${process.versions.node}.\n`
  );
  process.exit(1);
}
await import('../dist/cli/index.js');
