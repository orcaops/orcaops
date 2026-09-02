#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const contextPath = process.env.ORCAOPS_CONTEXT_PATH;
if (contextPath) {
  await readFile(contextPath, 'utf8');
}
process.stdout.write(
  JSON.stringify({
    schema: 'orcaops.evaluator_result/v1',
    verdict: 'violation',
    body: 'VIOLATION\n\nTest-fixture stub: pre-pr-warn-stub requested review.',
    raw: { fixture: true },
  })
);
