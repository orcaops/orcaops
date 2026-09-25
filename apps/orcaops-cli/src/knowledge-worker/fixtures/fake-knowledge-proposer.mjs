import { Buffer } from 'node:buffer';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setInterval } from 'node:timers';

if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0-fake\n');
  process.exit(0);
}

const answerKind = process.env.FAKE_PROPOSER_ANSWER ?? 'statement';
const stdin = await readStdin();
const recordPath = process.env.FAKE_PROVIDER_RECORD;
if (recordPath) {
  const record = { argv: process.argv.slice(2), cwd: process.cwd(), stdin, pid: process.pid };
  writeFileSync(`${recordPath}.partial`, JSON.stringify(record));
  renameSync(`${recordPath}.partial`, recordPath);
}

const manifest = /^manifest: ([0-9a-f]{64})$/m.exec(stdin)?.[1] ?? 'unknown';
const proposalSchemaVersion = JSON.parse(
  /^proposal_schema_version is ("[^"]+")\./m.exec(stdin)?.[1] ?? '"unknown"'
);
const unitId = /^unit: ([0-9a-f]{64})$/m.exec(stdin)?.[1] ?? 'unknown';
const segments = [
  ...stdin.matchAll(
    /source_ref: (s\d+)\nsegment_ref: (g\d+)\nartifact_id: ("(?:[^"\\]|\\.)*")\nfield: ("(?:[^"\\]|\\.)*")\nfield context: [^\n]*\nrole: (\S+)\npurpose: (primary|context)\n<<<ORCAOPS-SEGMENT [0-9a-f]{16} \S+ g\d+>>>\n([\s\S]*?)\n<<<ORCAOPS-SEGMENT-END [0-9a-f]{16} \S+ g\d+>>>/g
  ),
].map((match) => ({
  source_ref: match[1],
  segment_ref: match[2],
  artifact_id: JSON.parse(match[3]),
  field: JSON.parse(match[4]),
  role: match[5],
  purpose: match[6],
  text: match[7],
}));
const lines = segments.flatMap((segment) =>
  segment.text
    .split(/\r?\n/u)
    .filter((quote) => quote.length > 0)
    .map((quote) => ({ ...segment, quote }))
);
const first = lines.find((line) => line.purpose === 'primary') ?? lines[0];

const cite = (line, quote = line.quote) => ({
  source_ref: line.source_ref,
  segment_ref: line.segment_ref,
  quote,
});

const statement = (line = first) => ({
  source_ref: line?.source_ref ?? 's1',
  wording: line?.quote ?? '',
  source_form: 'stated_obligation',
  proposed_record: 'requirement',
  intended_scope: { kind: 'project' },
  evidence: line === undefined ? [] : [cite(line)],
  rationale: { kind: 'unknown' },
  alternatives: [],
  links: [],
});

const knowledge =
  /<<<ORCAOPS-KNOWLEDGE [0-9a-f]{16}>>>\n([\s\S]*?)\n<<<ORCAOPS-KNOWLEDGE-END /.exec(stdin);
const knowledgeLines = (knowledge?.[1] ?? '').split('\n');
const retrieved = knowledgeLines.flatMap((line, index) => {
  const ref = /^(k\d+r\d+)[ \t]+/.exec(line)?.[1];
  const next = knowledgeLines.findIndex(
    (candidate, candidateIndex) => candidateIndex > index && /^k\d+r\d+[ \t]+/.test(candidate)
  );
  const statement = knowledgeLines
    .slice(index + 1, next < 0 ? undefined : next)
    .find((candidate) => candidate.startsWith('  "'))
    ?.trim();
  return ref === undefined || statement === undefined || !statement.startsWith('"')
    ? []
    : [{ ref, statement: JSON.parse(statement) }];
});
const refFor = (link) =>
  link.ref ?? retrieved.find((entry) => entry.statement === link.statement)?.ref ?? null;

function citeText(text, nth = 1) {
  let seen = 0;
  for (const segment of segments) {
    let index = segment.text.indexOf(text);
    while (index >= 0) {
      seen += 1;
      if (seen === nth) return cite(segment, text);
      index = segment.text.indexOf(text, index + 1);
    }
  }
  return null;
}

function absentQuote(segment) {
  let quote = 'This citation is outside the supplied unit.';
  while (segment.text.includes(quote)) quote += '!';
  return quote;
}

function scriptedProposal() {
  const scriptsPath = process.env.FAKE_PROPOSER_SCRIPTS;
  if (!scriptsPath) return undefined;
  const scripts = JSON.parse(readFileSync(scriptsPath, 'utf8'));
  const script = scripts[unitId] ?? scripts.default ?? Object.values(scripts)[0];
  if (script === undefined) return undefined;
  const empty = {
    proposal_schema_version: proposalSchemaVersion,
    manifest_sha256: manifest,
    statements: [],
    corrections: [],
    uncertainties: [],
  };
  if (script.only_unit !== undefined && script.only_unit !== unitId) return empty;
  return {
    ...empty,
    ...(script.proposal_schema_version === undefined
      ? {}
      : { proposal_schema_version: script.proposal_schema_version }),
    ...(script.manifest_sha256 === undefined ? {} : { manifest_sha256: script.manifest_sha256 }),
    statements: (script.statements ?? []).flatMap((proposed) => {
      const found = citeText(proposed.quote, proposed.nth);
      if (found === null && proposed.citation_fault === undefined) return [];
      const evidence =
        proposed.citation_fault === 'outside_unit'
          ? first === undefined
            ? null
            : cite(first, absentQuote(first))
          : (found ?? (first === undefined ? null : cite(first, first.quote)));
      if (evidence === null) return [];
      const sent =
        proposed.invented_quote === undefined
          ? proposed.citation_fault === 'unknown_segment'
            ? { ...evidence, segment_ref: 'g999999' }
            : evidence
          : { ...evidence, quote: proposed.invented_quote };
      const rationale =
        proposed.rationale === undefined
          ? null
          : citeText(proposed.rationale, proposed.rationale_nth);
      if (proposed.rationale !== undefined && rationale === null) return [];
      return [
        {
          source_ref: proposed.source_ref ?? sent.source_ref,
          wording: proposed.wording ?? sent.quote,
          source_form: proposed.source_form,
          proposed_record: proposed.proposed_record,
          intended_scope: proposed.intended_scope ?? { kind: 'unknown' },
          evidence: [sent],
          rationale:
            rationale === null
              ? { kind: 'unknown' }
              : { kind: 'stated', wording: proposed.rationale, citations: [rationale] },
          alternatives: (proposed.alternatives ?? []).map((alternative) => {
            const option = citeText(alternative.option_quote ?? alternative.option);
            const rejection = citeText(alternative.rejection_quote ?? alternative.rejected_because);
            return {
              option: alternative.option,
              option_citations: option === null ? [] : [option],
              rejected_because: alternative.rejected_because,
              rejection_citations: rejection === null ? [] : [rejection],
            };
          }),
          links: (proposed.links ?? []).flatMap((link) => {
            const ref = refFor(link);
            return [
              {
                revision_ref: ref ?? 'k999999r999999',
                relation: link.relation,
              },
            ];
          }),
        },
      ];
    }),
    corrections: (script.corrections ?? []).flatMap((correction) => {
      const ref = refFor(correction);
      const account = citeText(correction.account, correction.nth);
      return account === null
        ? []
        : [
            {
              kind: correction.kind,
              revision_ref: ref ?? 'k999999r999999',
              account,
            },
          ];
    }),
    uncertainties: script.uncertainties ?? [],
    ...(script.extra ?? {}),
  };
}

const emptyProposal = {
  proposal_schema_version: proposalSchemaVersion,
  manifest_sha256: manifest,
  statements: [],
  corrections: [],
  uncertainties: [],
};
const baseStatement = statement();
const restatedRef = retrieved.find((entry) => entry.statement === baseStatement.wording)?.ref;
const otherRef = retrieved.find((entry) => entry.ref !== restatedRef)?.ref;
const decision =
  lines.length < 3
    ? null
    : {
        ...statement(lines[1]),
        source_form: 'stated_decision',
        proposed_record: 'decision',
        rationale: { kind: 'stated', wording: lines[2].quote, citations: [cite(lines[2])] },
      };

const proposals = {
  statement: { ...emptyProposal, statements: [baseStatement] },
  observation: {
    ...emptyProposal,
    statements: [{ ...baseStatement, source_form: 'observation', proposed_record: 'claim' }],
  },
  empty: emptyProposal,
  'wrong-manifest': { ...emptyProposal, manifest_sha256: 'f'.repeat(64) },
  invalid: {
    ...emptyProposal,
    statements: [{ wording: baseStatement.wording, source_form: 'bad' }],
  },
  multi: {
    ...emptyProposal,
    statements: decision === null ? [baseStatement] : [baseStatement, decision],
  },
  restate: {
    ...emptyProposal,
    statements: [
      {
        ...baseStatement,
        links: [
          ...(restatedRef ? [{ revision_ref: restatedRef, relation: 'exact_restatement' }] : []),
          ...(otherRef ? [{ revision_ref: otherRef, relation: 'contradicts' }] : []),
        ],
      },
    ],
  },
  'every-line': {
    ...emptyProposal,
    statements: lines
      .filter((line) => line.purpose === 'primary')
      .map((line) => statement(line))
      .slice(0, 64),
  },
};

const revokeGrants = process.env.FAKE_PROPOSER_REVOKE_GRANTS;
if (revokeGrants) {
  const store = JSON.parse(readFileSync(revokeGrants, 'utf8'));
  const revoked_at = new Date().toISOString();
  store.grants = store.grants.map((grant) => ({ ...grant, revoked_at }));
  writeFileSync(revokeGrants, `${JSON.stringify(store, null, 2)}\n`);
}

const adopt = process.env.FAKE_PROPOSER_ADOPT;
if (adopt) {
  const { authority, selection, selectedBy, acceptedAt, work } = JSON.parse(
    readFileSync(adopt, 'utf8')
  );
  const { openProjectDatabase, publishProjectSelection } =
    await import('@orcaops/storage/history/database');
  const { uuidv7 } = await import('@orcaops/storage');
  const handle = await openProjectDatabase({ authority, mode: 'writer' });
  try {
    await publishProjectSelection(handle, {
      operationId: uuidv7(),
      selection,
      selectedBy,
      acceptedAt,
      work,
      secretAllow: [],
    });
  } finally {
    handle.close();
  }
}

const proposal = answerKind === 'scripted' ? scriptedProposal() : proposals[answerKind];
if (proposal === undefined) {
  process.stderr.write(`unknown FAKE_PROPOSER_ANSWER: ${answerKind}\n`);
  process.exitCode = 64;
} else {
  let answer = JSON.stringify(proposal);
  if (process.env.FAKE_PROPOSER_JSON_DAMAGE === 'trailing-comma')
    answer = `${answer.slice(0, -1)},}`;
  if (process.env.FAKE_PROPOSER_JSON_DAMAGE === 'extra-brace')
    answer = answer.replace('"rationale":{"kind":"unknown"}', '"rationale":{"kind":"unknown"}}');
  const events = process.argv.includes('exec')
    ? [
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: { id: 'message-1', type: 'agent_message', text: answer },
        },
        {
          type: 'turn.completed',
          usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 300 },
        },
      ]
    : process.env.FAKE_PROPOSER_JSON_DAMAGE
      ? [
          { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: answer,
            stop_reason: 'end_turn',
            usage: { input_tokens: 1200, output_tokens: 300 },
            total_cost_usd: 0.0042,
          },
        ]
      : [
          { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'toolu_answer', name: 'StructuredOutput', input: proposal },
              ],
              stop_reason: 'tool_use',
            },
          },
          {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'toolu_answer', content: 'ok' }],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            structured_output: proposal,
            stop_reason: 'tool_use',
            usage: { input_tokens: 1200, output_tokens: 300 },
            total_cost_usd: 0.0042,
          },
        ];
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
  if (process.env.FAKE_PROPOSER_HANG) setInterval(() => {}, 1000);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
