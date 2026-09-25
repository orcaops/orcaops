// A provider that speaks the Claude stream-json format and hands back the
// structured answer in ORCAOPS_SCRIPTED_ANSWER, so the request and response
// path can be driven end to end with no model. The llm package's own fake
// provider answers a fixed body, which cannot be a proposal for a particular
// manifest; this one can.
import { Buffer } from 'node:buffer';
import { renameSync, writeFileSync } from 'node:fs';

const answer = JSON.parse(process.env.ORCAOPS_SCRIPTED_ANSWER ?? '{}');
const recordPath = process.env.ORCAOPS_SCRIPTED_RECORD;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');

if (recordPath) {
  const record = { argv: process.argv.slice(2), cwd: process.cwd(), stdin };
  // Renamed into place so a reader polling for the file never sees half of it.
  writeFileSync(`${recordPath}.partial`, JSON.stringify(record));
  renameSync(`${recordPath}.partial`, recordPath);
}

const events = [
  { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] },
  {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'toolu_answer', name: 'StructuredOutput', input: answer }],
      stop_reason: 'tool_use',
    },
  },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_answer', content: 'ok' }] },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: answer,
    stop_reason: 'end_turn',
    usage: { input_tokens: 120, output_tokens: 45 },
    total_cost_usd: 0.0012,
  },
];
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
