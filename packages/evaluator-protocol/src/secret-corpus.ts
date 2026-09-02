/**
 * The shared secret fixture corpus.
 *
 * One detector (`./secrets`) finds these shapes; several layers act on them
 * differently — the storage redactor replaces the matched value, the payload
 * guard refuses a write and never echoes it, CLI output redacts at render
 * time, and the archive mirror asserts what it copies. Each consumer iterates
 * this list and asserts ITS OWN semantics against it.
 *
 * What none of them should have separately is the list of shapes that must be
 * caught. Duplicated fixtures drift, and a layer silently weakened on one side
 * is exactly the failure this corpus prevents.
 *
 * It lives here for the same reason `./subprocess` does: evaluator-protocol is
 * already a dependency of every consumer and depends on none of them, so
 * sharing adds no edge and cannot create a cycle. It is a `./secret-corpus`
 * subpath rather than a barrel export, so no pack runtime pulls it in.
 *
 * NEVER put a real credential here. Every sample below is syntactically
 * valid and semantically dead.
 */

import type { SecretTier } from './secrets.js';

export type { SecretTier };

export interface SecretSample {
  /** Pattern name both implementations know it by. */
  name: string;
  /** A string that MUST be detected. */
  sample: string;
  /** The strongest action a write boundary may take on this shape. */
  tier: SecretTier;
}

/**
 * Values that sit exactly on a threshold of the credential-shape predicate,
 * each paired with one that sits exactly below it and differs in nothing else.
 * A threshold moved in either direction flips a tier here.
 *
 * The figures are what make them boundaries, and cannot be read off the
 * strings: character classes count letters and digits only, and entropy is in
 * bits per character.
 */
export const VALUE_SHAPE_BOUNDARY = {
  /** 24 chars, three classes — the shortest value the diversity branch takes. */
  atDiversityLength: 'R7mKq2XvT4bNw9ZcJ5hLp3Ds',
  /** The same value one character shorter. */
  belowDiversityLength: 'R7mKq2XvT4bNw9ZcJ5hLp3D',
  /** 32 chars, two classes, 3.67 bits — the shortest the entropy branch takes. */
  atEntropyLength: 'c4ca4238a0b923820dcc509a6f75849b',
  /** The same value one character shorter, at 3.65 bits. */
  belowEntropyLength: 'c4ca4238a0b923820dcc509a6f75849',
  /** 32 chars, two classes, exactly 3.00 bits — the entropy bar itself. */
  atEntropyBar: 'acef37k9acef37k9acef37k9acef37k9',
  /** One character different, dropping it to 2.99 bits. */
  belowEntropyBar: 'acef37k9acef37k9acef37k9acef37ka',
} as const;

/** Shapes that must be caught. One per recognized shape the implementations share. */
export const SECRET_POSITIVES: readonly SecretSample[] = [
  { name: 'bearer-token', sample: 'Bearer opaque-token-value-0000000000000000', tier: 'warn' },
  {
    name: 'jwt',
    tier: 'warn',
    sample:
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb3JwdXMtdXNlciJ9.0000000000000000000000000000000000000000000',
  },
  {
    name: 'authorization-header',
    tier: 'warn',
    sample: 'Authorization: Basic ZGVhZC1maXh0dXJlOnNlY3JldA== \t',
  },
  {
    name: 'authorization-header',
    tier: 'warn',
    sample: 'Authorization: Bearer abcdefghijklmnop',
  },
  {
    name: 'authorization-header',
    tier: 'warn',
    sample: 'Authorization: Basic ZGVhZC1maXh0dXJlOnNlY3JldA==.',
  },
  {
    name: 'authorization-header',
    tier: 'warn',
    sample: 'Authorization: Token abcdefgh.ijklmnop',
  },
  {
    name: 'secret-query-param',
    tier: 'warn',
    sample: '/callback?access_token=dead.token-00000',
  },
  {
    name: 'anthropic-api-key',
    tier: 'refuse',
    sample:
      'sk-ant-api03-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  },
  {
    name: 'openai-project-key',
    tier: 'refuse',
    sample: 'sk-proj-000000000000000000000000000000000000000000000000',
  },
  {
    name: 'openai-legacy-key',
    sample: 'sk-00000000000000000000000000000000000000000000000000',
    tier: 'refuse',
  },
  { name: 'github-token', sample: 'ghp_0000000000000000000000000000000000000', tier: 'refuse' },
  {
    name: 'google-api-key',
    tier: 'refuse',
    sample: 'AIza00000000000000000000000000000000000',
  },
  {
    name: 'google-api-key',
    tier: 'refuse',
    sample: 'AIza0000000000000000000000000000000000-',
  },
  { name: 'aws-access-key-id', sample: 'AKIA0000000000000000', tier: 'refuse' },
  {
    name: 'slack-token',
    // Assembled at load time: as a contiguous literal this is the one sample
    // in the repo that trips GitHub push protection (verified empirically),
    sample: ['xoxb', '000000000000', '000000000000', '000000000000000000000000'].join('-'),
    tier: 'refuse',
  },
  {
    name: 'slack-token',
    // The refresh token and the rotating user token it mints. The dot is the
    // reason this is a separate shape: no token character class spans one.
    sample: 'xoxe.xoxp-1-000000000000-000000000000-000000000000000000000000',
    tier: 'refuse',
  },
  {
    name: 'slack-app-token',
    sample: 'xapp-1-A00000000-0000000000000-0000000000000000000000000000000000000000',
    tier: 'refuse',
  },
  {
    name: 'npm-token',
    sample: 'npm_000000000000000000000000000000000000',
    tier: 'refuse',
  },
  {
    name: 'azure-client-secret',
    // Microsoft Entra's v2 shape. `8Q~` is the format marker; without it the
    // length and alphabet describe a great deal of ordinary text.
    sample: 'aB8Q~0000000000000000000000000000000000_0',
    tier: 'refuse',
  },
  {
    name: 'pem-private-key',
    tier: 'refuse',
    sample: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0000\n-----END RSA PRIVATE KEY-----',
  },
  {
    name: 'pem-private-key',
    tier: 'refuse',
    // OpenPGP armors a secret keyring as `PRIVATE KEY BLOCK`, which the
    // single-suffix marker parser could not read at all — so a PGP secret key
    // never paired with its terminator and was never claimed. The trailing
    // `=Ab3D` is the armor's CRC24 checksum line.
    sample:
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOYBGAAAAABCADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n=Ab3D\n-----END PGP PRIVATE KEY BLOCK-----',
  },
  {
    // The detector keys on the embedded private_key VALUE, not on the
    // surrounding service-account envelope — a distinction the first draft of
    // this corpus got wrong, which is precisely what a shared corpus is for.
    // The envelope escapes its newlines, so it is also the shape that proves
    // the block scan reads an escaped line break as one.
    name: 'pem-private-key',
    tier: 'refuse',
    sample:
      '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADAN0000\\n-----END PRIVATE KEY-----\\n"}',
  },
  {
    name: 'generic-assignment',
    sample: 'api_key=0000000000000000000000000000000000000000',
    tier: 'warn',
  },

  // ── Realistic key material ───────────────────────────────────────────────
  // The bare three-line PEM above is shorter than the thresholds either
  // implementation uses to decide what a key body is, so it exercised none of
  // them and the two detectors drifted apart underneath it. A real key is
  // twenty-odd full-width lines, and it is normally quoted out of something —
  // a log, a console, a captured stdout — that decorates every line.
  {
    name: 'pem-private-key',
    tier: 'refuse',
    sample:
      '-----BEGIN RSA PRIVATE KEY-----\nANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmz\nHUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6\nObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0B\nViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7I\ncp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CP\njw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JW\nq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQd\nx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXk\n4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer\n/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly\nGTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5\nNan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzA\nUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6H\nbo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BO\niv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IV\np2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPc\nw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWj\n3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq\n+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx\nFSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4\nMZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/\nTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5G\nan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzAN\nhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HU\nMEKUyWouUVN0000\n-----END RSA PRIVATE KEY-----',
  },
  {
    name: 'pem-private-key',
    tier: 'refuse',
    // Every line carries a docker `-t` timestamp, whose own base64 run is long
    // enough to be mistaken for the key material behind it.
    sample:
      '2026-08-25T10:00:00.000000000Z -----BEGIN RSA PRIVATE KEY-----\n2026-08-25T10:00:00.000000000Z ANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmz\n2026-08-25T10:00:00.000000000Z HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6\n2026-08-25T10:00:00.000000000Z Obo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0B\n2026-08-25T10:00:00.000000000Z Viv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7I\n2026-08-25T10:00:00.000000000Z cp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CP\n2026-08-25T10:00:00.000000000Z jw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JW\n2026-08-25T10:00:00.000000000Z q3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQd\n2026-08-25T10:00:00.000000000Z x+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXk\n2026-08-25T10:00:00.000000000Z 4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer\n2026-08-25T10:00:00.000000000Z /MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly\n2026-08-25T10:00:00.000000000Z GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5\n2026-08-25T10:00:00.000000000Z Nan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzA\n2026-08-25T10:00:00.000000000Z Uhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6H\n2026-08-25T10:00:00.000000000Z bo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BO\n2026-08-25T10:00:00.000000000Z iv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IV\n2026-08-25T10:00:00.000000000Z p2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPc\n2026-08-25T10:00:00.000000000Z w9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWj\n2026-08-25T10:00:00.000000000Z 3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq\n2026-08-25T10:00:00.000000000Z +LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx\n2026-08-25T10:00:00.000000000Z FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4\n2026-08-25T10:00:00.000000000Z MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/\n2026-08-25T10:00:00.000000000Z Tgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5G\n2026-08-25T10:00:00.000000000Z an0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HUhu7IViv8JWjw9KXkx+LYly/MZmzAN\n2026-08-25T10:00:00.000000000Z hu7IViv8JWjw9KXkx+LYly/MZmzANan0BObo1CPcp2DQdq3ERer4FSfs5GTgt6HU\n2026-08-25T10:00:00.000000000Z MEKUyWouUVN0000\n2026-08-25T10:00:00.000000000Z -----END RSA PRIVATE KEY-----',
  },

  // ── The value-shape boundary ─────────────────────────────────────────────
  // `generic-assignment`'s key half is broad, so the VALUE decides whether a
  // match is a credential or an identifier that follows the same label. These
  // two sit either side of that line and are the reason the split exists: an
  // AWS key id refused while its paired secret only warned left the sensitive
  // half of a credential pair unguarded.
  {
    name: 'generic-assignment-strong',
    tier: 'refuse',
    // AWS's own published documentation example. 40 chars, three classes.
    sample: 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    // Just below the boundary: 21 chars, and the kebab-case shape this
    // repository's OAuth fixtures use. It draws on one character class, so it
    // warns whatever the length bar is; the shape is what keeps it here.
    sample: "refresh_token: 'invalid-refresh-token'",
  },

  // ── The threshold boundaries ─────────────────────────────────────────────
  // The pairs from {@link VALUE_SHAPE_BOUNDARY}. Each threshold decides
  // whether a real credential is refused or merely warned, so raising one
  // silently downgrades key material; these fail on a move of one character
  // or a fraction of a bit, in either direction.
  {
    name: 'generic-assignment-strong',
    tier: 'refuse',
    sample: `api_key=${VALUE_SHAPE_BOUNDARY.atDiversityLength}`,
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: `api_key=${VALUE_SHAPE_BOUNDARY.belowDiversityLength}`,
  },
  {
    // Two classes, so only the entropy branch can reach it and only its
    // length separates the two.
    name: 'generic-assignment-strong',
    tier: 'refuse',
    sample: `api_key=${VALUE_SHAPE_BOUNDARY.atEntropyLength}`,
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: `api_key=${VALUE_SHAPE_BOUNDARY.belowEntropyLength}`,
  },
  {
    // Same length and class count as the pair below it; entropy is the only
    // thing between them.
    name: 'generic-assignment-strong',
    tier: 'refuse',
    sample: `api_key=${VALUE_SHAPE_BOUNDARY.atEntropyBar}`,
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: `api_key=${VALUE_SHAPE_BOUNDARY.belowEntropyBar}`,
  },

  // ── The character-class boundary ─────────────────────────────────────────
  // Identifiers orcaops' own messages carry, each of which refused before the
  // rules narrowed: some reached three classes only because punctuation
  // counted, the rest cleared the entropy branch before it required a solid
  // alphanumeric run. A change that promotes any of them back to refuse means
  // the tool blocks writes on its own bookkeeping again.
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: "token: 'a-hyphenated-branch-name-01'",
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: 'api_key=packages/evaluator-runner/src/discovery/validate-pack.ts',
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: "secret: '01a02ff6-7cd9-7149-bf87-9625a5b88bca'",
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: 'token=refs/orcaops/snapshots/01a02ff6-7cd2-7c8f/close/1',
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: "secret: 'ORCAOPS_CHECKPOINT_OVERLAP_ERROR_CODE'",
  },
  {
    name: 'generic-assignment-strong',
    tier: 'refuse',
    // KNOWN COLLISION, pinned deliberately. A 40-character lowercase hex git
    // SHA is structurally indistinguishable from a hex API key, so any rule
    // that spares this spares the key too. Refusing it is the side of that
    // trade this subsystem takes; the alternative is a silent miss.
    sample: 'secret=d167a165c0ffee1234567890abcdef0123456789',
  },

  // ── Env-style assignment names ───────────────────────────────────────────
  // A word boundary cannot fire when an underscore precedes the keyword, so
  // these went undetected — and therefore unredacted — while SECURITY.md names
  // env files as the threat model. They warn rather than refuse: the value
  // shape decides that, and these carry none of it.
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: 'DB_PASSWORD=hunter2hunter2hunter2',
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    sample: 'STRIPE_SECRET_KEY=sk_live_0000000000000000',
  },

  // ── Why these are positives rather than negatives ────────────────────────
  // Each of the shapes below IS detected, and must stay detected: they are
  // genuine `generic-assignment` / `jwt` matches, and demoting them to
  // negatives would mean weakening those patterns for everyone.
  //
  // They are here because they are the realistic FALSE-POSITIVE class — the
  // shapes an agent quotes into a checkpoint summary or `done_criteria`
  // evidence while doing perfectly ordinary work. They pin the tier, which is
  // the thing that keeps such a quote from blocking a write. A change that
  // moves any of them to `refuse` should fail loudly here.
  {
    name: 'generic-assignment',
    tier: 'warn',
    // A TypeScript type annotation. `HeldToken` is nine matching characters.
    sample: 'const token: HeldToken = { lockPath, live: true };',
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    // Any object-literal property named accessToken/refreshToken/apiKey.
    sample: "accessToken: 'opaque-token-fixture'",
  },
  {
    name: 'generic-assignment',
    tier: 'warn',
    // Ordinary prose about secret handling, of the kind a plan step contains.
    sample: 'secret: management is output-time redaction only for now',
  },
  {
    name: 'jwt',
    tier: 'warn',
    // Byte-identical to the fixture at apps/orcaops-cli/src/io/output.test.ts,
    // which an agent may legitimately paste as test evidence.
    sample:
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  },

  // ── Invisible characters ──────────────────────────────────────────────────
  // These render as nothing, so the credential a reader sees is whole while
  // the bytes carry a break no pattern matches. Written as escapes on purpose:
  // a literal zero-width character in this file is invisible to whoever edits
  // it next. See `normalizeForDetection`.
  {
    name: 'generic-assignment-strong',
    tier: 'refuse',
    // One zero-width space in the KEY half. The value is AWS's own published
    // documentation example, unbroken and fully live-shaped.
    sample: 'aws_secret\u200Baccess_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  {
    name: 'anthropic-api-key',
    tier: 'refuse',
    // Splitting the vendor prefix is the sharpest version: every provider
    // pattern is anchored on it, so one character defeats all of them.
    sample:
      'sk-ant-\u200Dapi03-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  },
  {
    name: 'github-token',
    tier: 'refuse',
    // A soft hyphen renders only where a line happens to wrap.
    sample: 'ghp_00000\u00AD0000000000000000000000000000000000',
  },
  {
    name: 'slack-token',
    tier: 'refuse',
    // A variation selector rides along after any character.
    sample: 'xoxb-000000000000\uFE0F-000000000000-000000000000000000000000',
  },
];

/**
 * Shapes that must NOT be caught. A detector that flags these is worse than
 * useless: it trains people to ignore it, and in the CLI's case it destroys
 * diagnostics. The identifiers here are ones orcaops' own messages carry.
 */
export const SECRET_NEGATIVES: readonly string[] = [
  'password=foo',
  'token=short',
  'api_key=${MY_KEY}',
  'artifact 019fbf11-9ce0-7793-bd50-8476e6fac30c',
  'base sha d167a165c0ffee1234567890abcdef0123456789',
  'packages/evaluator-runner/src/discovery/validate-pack.test.ts',
  'https://api.orcaops.ai/api/trpc/user.me',
  'Bearer authentication is configured by the provider',
  'Bearer authentication-based access is configured',
  'Authorization: add RBAC middleware to the API',
  'Authorization: Bearer authentication-based access is configured',
  'Authorization: Basic authentication is documented',
  'Authorization: Basic authentication. Then verify.',
  'Authorization: Basic authentication... Then verify.',
  'Authorization: middleware-configuration is documented',
  'Authorization: Basic authentication, as documented',
  'Authorization: Bearer authentication-based; see configuration',
  'https://docs.example.com/page?key=intro',
  'https://docs.example.com/page?key=installation-guide',
  'https://docs.example.com/page?access_token=dead.token-0000',
  'AIza000000000000000000000000000000000000',
  'AKIA-not-a-key',
  '-----BEGIN CERTIFICATE----- certificate material is public',
  '-----BEGIN PGP PUBLIC KEY BLOCK----- public key material is public',
  'npm_short',
  'xapp-not-a-token',

  // Orcaops' own machine identifiers. A payload-walking detector scans every
  // string leaf, not just the prose ones, so these travel through it on every
  // capture — flagging one would block writes on the tool's own bookkeeping.
  '01a02ff6-7cd9-7149-bf87-9625a5b88bca',
  'plan_revision_id 01a02ff6-7cd2-7c8f-9612-70e396748d63',
  'refs/orcaops/snapshots/01a02ff6-7cd2-7c8f-9612-70e396748d63/close/1',
  'a-hyphenated-branch-name',
  'feat/branch-name-with-slashes',

  // A no-break space renders as a space, so it is folded to one rather than
  // removed. Removing it would join `Authorization:` to the prose after it and
  // manufacture a credential nobody wrote.
  'Authorization:\u00A0add RBAC middleware to the API',
];
