#!/usr/bin/env node
// Test-only runtime stub. Always emits a violation when invoked.
// CLI tests primarily seed this evaluator's ref directly; this
// runtime exists so resolution.validatePack does not fail on a
// missing command target.

import { readFile } from 'node:fs/promises';

const contextPath = process.env.ORCAOPS_CONTEXT_PATH;
if (contextPath) {
  await readFile(contextPath, 'utf8');
}
process.stdout.write(
  JSON.stringify({
    schema: 'orcaops.evaluator_result/v1',
    verdict: 'violation',
    body: 'VIOLATION\n\nTest-fixture stub: cp-close-with-pe-stub emitted a deterministic violation envelope.',
    raw: { fixture: true },
  })
);
