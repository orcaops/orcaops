#!/usr/bin/env node
// Test-only runtime stub. CLI tests seed violation runs against this
// evaluator's ref directly via plantBlockViolation; this script is the
// command-engine target the resolver verifies exists but the tests do
// not actually invoke. If a test ever does invoke it, the envelope
// below is a plausible violation that won't crash the runner.

import { readFile } from 'node:fs/promises';

const contextPath = process.env.ORCAOPS_CONTEXT_PATH;
if (contextPath) {
  await readFile(contextPath, 'utf8'); // honor the contract: read context
}
process.stdout.write(
  JSON.stringify({
    schema: 'orcaops.evaluator_result/v1',
    verdict: 'violation',
    body: 'VIOLATION\n\nTest-fixture stub: api-stub emitted a deterministic violation envelope.',
    raw: { fixture: true },
  })
);
