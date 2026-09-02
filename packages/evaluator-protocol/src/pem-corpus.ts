/**
 * Generated private-key block samples: shape families crossed with the
 * dimensions that vary between them — the embedding around the key, its wrap
 * width, where the material sits on the line.
 *
 * Deterministic by construction. No random source, so a failing sample is
 * addressable by name rather than by seed. It is a `./pem-corpus` subpath
 * rather than a barrel export, so no pack runtime pulls it in.
 *
 * NEVER put a real key here. Every body below is position-derived filler that
 * is syntactically base64 and semantically nothing.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * One line of body filler. The odd stride keeps consecutive characters
 * different: six identical characters in a row read as padding to the value
 * test, which would change what the sample measures.
 */
function bodyLine(seed: number, width: number): string {
  let out = '';
  for (let at = 0; at < width; at += 1) {
    out += BASE64_ALPHABET[(seed * 31 + at * 17 + 7) % BASE64_ALPHABET.length];
  }
  return out;
}

/** A key body: `lines` full-width lines and a short final block, as PEM wraps. */
function keyBody(seed: number, width: number, lines: number): string[] {
  const body: string[] = [];
  for (let n = 0; n < lines; n += 1) body.push(bodyLine(seed + n, width));
  body.push(bodyLine(seed + lines, Math.max(8, Math.floor(width / 3))));
  return body;
}

/** 64 hex characters — a container id, as wide as a key line and not one. */
function containerSha(seed: number): string {
  let out = '';
  for (let at = 0; at < 64; at += 1) out += '0123456789abcdef'[(seed * 7 + at * 3) % 16];
  return out;
}

/**
 * One measurable sample. `material` and `bystanders` are counted per run, not
 * per sample: a detector that claims one line of a 26-line key and one that
 * claims all of it both "detect" the key.
 */
export interface PemSample {
  /** Describes the shape, never a run or a date. */
  name: string;
  text: string;
  /** Runs that must NOT survive redaction. */
  material: readonly string[];
  /** Runs that MUST survive redaction. */
  bystanders: readonly string[];
}

interface BlockOptions {
  label?: string;
  width?: number;
  lines?: number;
  headers?: readonly string[];
  terminated?: boolean;
  seed?: number;
}

function block(opts: BlockOptions): { lines: string[]; material: string[] } {
  const label = opts.label ?? 'RSA';
  const body = keyBody(opts.seed ?? 1, opts.width ?? 64, opts.lines ?? 24);
  const lines = [
    `-----BEGIN ${label} PRIVATE KEY-----`,
    ...(opts.headers ?? []),
    ...(opts.headers !== undefined && opts.headers.length > 0 ? [''] : []),
    ...body,
    ...(opts.terminated === false ? [] : [`-----END ${label} PRIVATE KEY-----`]),
  ];
  return { lines, material: body };
}

/** How a key arrives when an agent quotes it out of something it was reading. */
const EMBEDDINGS: ReadonlyArray<{ name: string; wrap: (line: string, at: number) => string }> = [
  {
    name: 'docker-timestamp',
    // A `docker logs -t` nanosecond stamp carries an eight-character run of its own.
    wrap: (line) => `2026-08-25T10:00:00.000000000Z ${line}`,
  },
  { name: 'logfmt', wrap: (line) => `level=info component=keyloader msg="${line}"` },
  {
    name: 'k8s-json-envelope',
    wrap: (line) =>
      `{"log":"${line}\\n","stream":"stdout","time":"2026-08-25T10:00:00.000000000Z"}`,
  },
  {
    name: 'spring-boot-prefix',
    // Decoration wider than the key's own wrap width.
    wrap: (line) =>
      `2026-08-25 10:00:00.000  INFO 12345 --- [           main] c.e.KeyLoader            : ${line}`,
  },
  {
    name: 'container-sha-prefix',
    // 64 hex characters: a full-width base64 run in the decoration.
    wrap: (line, at) => `${containerSha(at)} ${line}`,
  },
  { name: 'quoted-string-literal', wrap: (line) => `  '${line}\\n' +` },
  { name: 'json-array-element', wrap: (line) => `    "${line}",` },
];

/** RFC 1421 wraps at 64; no tool in practice goes past 76. */
const WRAP_WIDTHS = [60, 64, 70, 76] as const;

/** A key under each embedding, at each wrap width. The whole body is material. */
export const DECORATED_KEYS: readonly PemSample[] = EMBEDDINGS.flatMap((embedding) =>
  WRAP_WIDTHS.map((width, index): PemSample => {
    const { lines, material } = block({ width, seed: index + 2 });
    return {
      name: `decorated/${embedding.name}/w${width}`,
      text: lines.map((line, at) => embedding.wrap(line, at)).join('\n'),
      material,
      bystanders: [],
    };
  })
);

/**
 * An encapsulated header whose value is a base64 run longer than the body wraps
 * at. A scan that takes its width from the first long run it sees fixes on the
 * header and then reads every real body line as too wide.
 */
export const HEADERS_CARRYING_RUNS: readonly PemSample[] = [
  { name: 'openpgp-comment', header: `Comment: ${bodyLine(9, 72)}` },
  { name: 'rfc1421-mic-info', header: `MIC-Info: RSA-MD5,RSA,${bodyLine(11, 88)}` },
  { name: 'ssh-comment-sha256', header: `Comment: SHA256:${bodyLine(13, 43)}` },
].map(({ name, header }): PemSample => {
  const { lines, material } = block({ width: 64, headers: [header], seed: 5 });
  return {
    name: `header-run/${name}`,
    text: lines.join('\n'),
    material,
    bystanders: [],
  };
});

/**
 * The block's opening body line one character short of the rest. A width taken
 * from that line makes every following line look too wide.
 */
export const FIRST_LINE_WIDTH_VARIANCE: readonly PemSample[] = WRAP_WIDTHS.map(
  (width, index): PemSample => {
    const { lines, material } = block({ width, seed: index + 20 });
    const bodyStart = 1;
    const narrowed = [...lines];
    narrowed[bodyStart] = narrowed[bodyStart]!.slice(0, width - 1);
    return {
      name: `first-line-narrow/w${width}`,
      text: narrowed.join('\n'),
      material: [...material.slice(1)],
      bystanders: [],
    };
  }
);

/**
 * A marker named in prose, with base64-dense benign content behind it. Nothing
 * here is key material, so every line is a bystander: this family measures
 * over-claim only.
 */
export const PROSE_BESIDE_DENSE: readonly PemSample[] = [
  {
    name: 'npm-lockfile-integrity',
    tail: [
      '    "node_modules/left-pad": {',
      `      "integrity": "sha512-${bodyLine(31, 86)}==",`,
      `      "integrity": "sha512-${bodyLine(33, 86)}==",`,
      `      "integrity": "sha512-${bodyLine(35, 86)}==",`,
      '    }',
    ],
  },
  {
    name: 'subresource-integrity',
    tail: [
      `<script integrity="sha384-${bodyLine(37, 64)}"></script>`,
      `<script integrity="sha384-${bodyLine(39, 64)}"></script>`,
    ],
  },
  {
    name: 'commit-sha-listing',
    tail: [
      `${containerSha(3).slice(0, 40)}  fix the loader`,
      `${containerSha(5).slice(0, 40)}  add a test`,
    ],
  },
  {
    name: 'definition-list',
    // `Word: value` lines read as encapsulated headers.
    tail: ['Rotation: quarterly', 'Storage: the platform vault', 'Owner: the platform team'],
  },
].map(({ name, tail }): PemSample => {
  const text = [
    'The key file opens with -----BEGIN RSA PRIVATE KEY----- on its first line.',
    'Rotate it per the runbook; the loader reads it from the vault, never the repo.',
    '',
    ...tail,
  ].join('\n');
  return { name: `prose-mention/${name}`, text, material: [], bystanders: tail };
});

/**
 * A line that is both an encapsulated header and a `-----BEGIN` marker. If
 * header lines are admitted free of the scan budget, every marker rescans the
 * tail behind it — quadratic in input reachable from evaluator output.
 */
export const HEADER_AND_MARKER: readonly PemSample[] = [1, 4, 16].map((count): PemSample => {
  const text = Array.from(
    { length: count },
    (_, at) => `X-Key-${at}: -----BEGIN RSA PRIVATE KEY-----`
  ).join('\n');
  return {
    name: `header-and-marker/x${count}`,
    text,
    material: [],
    bystanders: [text.split('\n')[0]!],
  };
});

/**
 * An unterminated block beside an unrelated file, joined as the diff redactor
 * joins every hunk body into one document. The truncated key must be claimed
 * and the file behind it must not.
 */
export const UNTERMINATED_BESIDE_FILE: readonly PemSample[] = [
  { name: 'lockfile', tail: [`      "integrity": "sha512-${bodyLine(41, 86)}==",`, '    }'] },
  { name: 'yaml-workflow', tail: ['  runs-on: ubuntu-latest', '  timeout-minutes: 20'] },
  {
    name: 'certificate',
    tail: ['-----BEGIN CERTIFICATE-----', bodyLine(43, 64), '-----END CERTIFICATE-----'],
  },
].map(({ name, tail }): PemSample => {
  const { lines, material } = block({ width: 64, lines: 3, terminated: false, seed: 7 });
  return {
    name: `unterminated-beside/${name}`,
    text: [...lines, ...tail].join('\n'),
    material,
    bystanders: tail,
  };
});

/**
 * Ordinary diffs with no key in them. The over-redaction regression half: the
 * block scan runs over every hunk body as one joined document, so anything it
 * claims here it claims across files.
 */
export const CLEAN_DIFFS: readonly PemSample[] = [
  {
    name: 'source-edit',
    lines: [
      'diff --git a/src/loader.ts b/src/loader.ts',
      '@@ -1,4 +1,4 @@',
      ' import { readFile } from "node:fs/promises";',
      '-const KEY_PATH = "/etc/keys/id_rsa";',
      '+const KEY_PATH = process.env.KEY_PATH ?? "/etc/keys/id_rsa";',
      ' export async function load() {',
    ],
  },
  {
    name: 'lockfile-bump',
    lines: [
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
      '@@ -10,3 +10,3 @@',
      `-      integrity: sha512-${bodyLine(51, 86)}==`,
      `+      integrity: sha512-${bodyLine(53, 86)}==`,
      '       version: 1.2.3',
    ],
  },
  {
    name: 'docs-mentioning-a-marker',
    lines: [
      'diff --git a/docs/keys.md b/docs/keys.md',
      '@@ -1,2 +1,3 @@',
      ' A private key file starts with -----BEGIN RSA PRIVATE KEY-----.',
      '+Store it in the vault, never in the repository.',
    ],
  },
].map(
  ({ name, lines }): PemSample => ({
    name: `clean-diff/${name}`,
    text: lines.join('\n'),
    material: [],
    bystanders: lines
      .filter((line) => line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))
      .map((line) => line.slice(1)),
  })
);

/** Every family, in the order the table reports them. */
export const PEM_CORPUS: ReadonlyArray<{ family: string; samples: readonly PemSample[] }> = [
  { family: 'decorated', samples: DECORATED_KEYS },
  { family: 'header-run', samples: HEADERS_CARRYING_RUNS },
  { family: 'first-line-narrow', samples: FIRST_LINE_WIDTH_VARIANCE },
  { family: 'prose-mention', samples: PROSE_BESIDE_DENSE },
  { family: 'header-and-marker', samples: HEADER_AND_MARKER },
  { family: 'unterminated-beside', samples: UNTERMINATED_BESIDE_FILE },
  { family: 'clean-diff', samples: CLEAN_DIFFS },
];
