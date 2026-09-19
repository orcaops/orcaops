#!/usr/bin/env node

import { fileURLToPath, URL } from 'node:url';

const entrypoint = new URL('../../apps/orcaops-cli/bin/orcaops.js', import.meta.url);
process.argv[1] = fileURLToPath(entrypoint);
await import(entrypoint.href);
