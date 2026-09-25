/**
 * The scripted knowledge proposer, answering at a pace a test chooses: after a fixed wait, or not
 * at all. It stands in for a model that takes its time or fails, and it records when each call
 * began, which is what says whether anything on the capture path waited for it.
 *
 * `PACED_PROPOSER_DELAY_MS` — wait this long before answering at all (default none).
 * `PACED_PROPOSER_FAIL` — fail the call outright, with nothing written to standard output.
 * `PACED_PROPOSER_CALL_LOG` — a file each call appends `<epoch ms> <pid>` to as it starts, before
 *   the wait, so the log says when the provider was reached rather than when it answered.
 */
import { appendFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { URL } from 'node:url';

// An availability probe is not a call: it must neither be logged nor waited for.
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0-fake\n');
  process.exit(0);
}

const callLog = process.env.PACED_PROPOSER_CALL_LOG;
if (callLog) appendFileSync(callLog, `${Date.now()} ${process.pid}\n`);

if (process.env.PACED_PROPOSER_FAIL) {
  process.stderr.write('the provider refused this call\n');
  process.exit(70);
}

await wait(Number(process.env.PACED_PROPOSER_DELAY_MS ?? 0));

// Imported rather than spawned, so the answer is the fixture's own and the wait is the only
// difference. It reads standard input itself, which stays buffered while this script waits.
await import(
  new URL('../../src/knowledge-worker/fixtures/fake-knowledge-proposer.mjs', import.meta.url).href
);
