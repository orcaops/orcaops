#!/usr/bin/env node
// Test-only runtime stub. See api-stub.mjs for the design rationale.

import { readFile } from 'node:fs/promises';

const contextPath = process.env.ORCAOPS_CONTEXT_PATH;
if (contextPath) {
  await readFile(contextPath, 'utf8');
}
process.stdout.write(
  JSON.stringify({
    schema: 'orcaops.evaluator_result/v1',
    verdict: 'violation',
    body: 'VIOLATION\n\nTest-fixture stub: scope-density-stub emitted a deterministic violation envelope.',
    raw: { fixture: true },
  })
);
