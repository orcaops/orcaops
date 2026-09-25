#!/usr/bin/env node
// Test-only runtime stub. Always emits a pass envelope when
// invoked. Test-pack stubs intentionally do not import the SDK so
// they remain executable by plain node without needing the SDK's
// dist build at CLI-test time.

import { readFile } from 'node:fs/promises';

const contextPath = process.env.ORCAOPS_CONTEXT_PATH;
if (contextPath) {
  await readFile(contextPath, 'utf8');
}
process.stdout.write(
  JSON.stringify({
    schema: 'orcaops.evaluator_result/v2',
    verdict: 'pass',
    body: 'PASS\n\nTest-fixture stub: pass-fixture emitted a deterministic pass envelope.',
    raw: { fixture: true },
    // Findings never decide the gate; they are retained beside the run.
    findings: [
      {
        key: 'fixture/plan-covered',
        title: 'The captured plan states every step the fixture expects',
      },
      { title: 'The fixture found nothing it can name the same way twice' },
    ],
  })
);
