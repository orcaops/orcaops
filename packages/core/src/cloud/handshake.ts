import { type OrcaopsCapability, OSS_PROTOCOL_VERSION, OssCliHandshake } from '@orcaops/protocol';

import { getDefaultCliVersion } from './cli-version.js';

// Re-exported so CLI call sites can name the capability they need without
// taking a direct dependency on @orcaops/protocol — the same reason client.ts
// re-exports the SDK pieces its consumers commonly reach for.
export { ORCAOPS_CAPABILITIES } from '@orcaops/protocol';
export type { OrcaopsCapability, OssCliHandshake } from '@orcaops/protocol';

/**
 * Why a capability-gated operation was refused locally. Values are drawn from
 * the existing `CloudSyncFailureKind` vocabulary so doctor / sync-status
 * remediation language reads the same whether a skew was caught proactively
 * here or reactively by the push classifier.
 */
export type CloudCapabilityRefusalKind = 'server-behind' | 'upgrade-required' | 'wire-invalid';

const REMEDIATION: Record<CloudCapabilityRefusalKind, string> = {
  'server-behind': 'The cloud does not offer this operation yet; no local change will enable it.',
  'upgrade-required': 'Upgrade your orcaops install, then retry.',
  'wire-invalid': 'The cloud returned a handshake this client cannot read. Report this.',
};

/**
 * Thrown BEFORE the request that would mutate, when the resolved cloud cannot
 * serve the operation the user asked for. Refusing here rather than letting the
 * call proceed is the point: the mutating `plan review` verbs issue several
 * requests, so a refusal discovered part-way through would strand a partial
 * write the CLI has no path to roll back.
 */
export class CloudCapabilityError extends Error {
  readonly name = 'CloudCapabilityError';
  constructor(
    readonly kind: CloudCapabilityRefusalKind,
    readonly operation: string,
    detail: string
  ) {
    super(`Cannot run ${operation}: ${detail} ${REMEDIATION[kind]}`);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Strict SemVer 2.0.0
 *
 * Deliberately mirrors the cloud's `cli-version-policy.ts` rather than reaching
 * for a looser local comparator. The two implementations decide the SAME
 * question — is this client at or above the floor — on either side of the wire,
 * and a client that ranks versions differently from the server produces exactly
 * the skew this gate exists to prevent: a local "you're fine" against a remote
 * rejection, or a local refusal the cloud would have served. Any change here
 * must land on both sides together.
 * ---------------------------------------------------------------------------
 */

/** Current wire bound for version metadata carried in request headers. */
const MAX_VERSION_LENGTH = 64;

// SemVer 2.0.0 (semver.org §Backus–Naur) — no `v` prefix, no leading zeros.
const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export interface ParsedSemver {
  major: string;
  minor: string;
  patch: string;
  /** Dot-separated prerelease identifiers; empty for a release version. */
  prerelease: string[];
}

/**
 * Core parts stay DIGIT STRINGS, never numbers: `Number()` loses precision
 * above 2^53, which would make `9007199254740992.0.0` and `…93.0.0` compare
 * equal. The strict regex forbids leading zeros, so digit strings order exactly
 * by length-then-lexicographic at any magnitude. Build metadata parses and is
 * then discarded — SemVer §10 excludes it from precedence.
 */
export function parseStrictSemver(value: string): ParsedSemver | null {
  if (value.length > MAX_VERSION_LENGTH) return null;
  const match = STRICT_SEMVER_RE.exec(value);
  if (!match) return null;
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareDigitStrings(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return compareDigitStrings(a, b);
  // §11.4.3: numeric identifiers always have lower precedence.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Full SemVer 2.0.0 precedence. Negative when `a` precedes `b`. */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return compareDigitStrings(a.major, b.major);
  if (a.minor !== b.minor) return compareDigitStrings(a.minor, b.minor);
  if (a.patch !== b.patch) return compareDigitStrings(a.patch, b.patch);
  // §11.3: a prerelease sorts BELOW its release.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const cmp = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (cmp !== 0) return cmp;
  }
  return a.prerelease.length - b.prerelease.length;
}

/** A `cli.ping` response, narrowed to the field this module reads. */
export interface HandshakeCarrier {
  handshake: unknown;
}

export interface AssertCloudSupportsOptions {
  /** Override the process-wide CLI version. Test seam; production reads the
   *  bootstrap value set by the CLI at startup. */
  cliVersion?: string | null;
  /** Override the protocol version this client speaks. Test seam. */
  protocolVersion?: string;
}

/**
 * Enforce both advertised version floors on every negotiated operation.
 */
function assertVersionFloors(
  handshake: OssCliHandshake,
  operation: string,
  opts: AssertCloudSupportsOptions
): void {
  const cliVersion = opts.cliVersion !== undefined ? opts.cliVersion : getDefaultCliVersion();
  const axes: { label: string; received: string | null; minimum: string }[] = [
    { label: 'CLI', received: cliVersion, minimum: handshake.min_cli_version },
    {
      label: 'protocol',
      received: opts.protocolVersion ?? OSS_PROTOCOL_VERSION,
      minimum: handshake.min_protocol_version,
    },
  ];

  for (const axis of axes) {
    const floor = parseStrictSemver(axis.minimum);
    if (!floor) {
      throw new CloudCapabilityError(
        'wire-invalid',
        operation,
        `the cloud advertised a minimum ${axis.label} version ("${axis.minimum}") that is not a ` +
          `strict semantic version.`
      );
    }
    if (axis.received === null) {
      throw new CloudCapabilityError(
        'upgrade-required',
        operation,
        `the cloud requires ${axis.label} >= ${axis.minimum} and this client reports no ` +
          `${axis.label} version.`
      );
    }
    const received = parseStrictSemver(axis.received);
    if (!received || compareSemver(received, floor) < 0) {
      throw new CloudCapabilityError(
        'upgrade-required',
        operation,
        `the cloud requires ${axis.label} >= ${axis.minimum}; this client reports ` +
          `${axis.received}.`
      );
    }
  }
}

/**
 * Validate a `cli.ping` handshake and refuse the operation unless the cloud
 * advertises every capability it needs. Returns the parsed handshake so a
 * caller can record what it negotiated against.
 *
 * `required` must name ONLY the capabilities this specific operation consumes.
 * A blanket capability check would couple unrelated commands to each other's
 * rollout and turn a partial deploy into a total outage. Callers that already
 * ping but consume no named capability pass `[]` so the handshake and version
 * floors are still validated.
 *
 * Unknown capability identifiers in the cloud's array are ignored rather than
 * rejected: this client asks only whether the names IT understands are present
 * and says nothing about the rest, so a cloud that adds capabilities stays
 * compatible with an older client.
 */
export function assertCloudSupports(
  ping: HandshakeCarrier,
  required: readonly OrcaopsCapability[],
  operation: string,
  opts: AssertCloudSupportsOptions = {}
): OssCliHandshake {
  const parsed = OssCliHandshake.safeParse(ping.handshake);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new CloudCapabilityError(
      'wire-invalid',
      operation,
      `the cloud's capability handshake did not match the wire contract (${issues}).`
    );
  }
  const handshake = parsed.data;

  // Floors are NOT capability-scoped — they bind every operation. They are
  // checked here only because the handshake is already in hand; no path pays a
  // round trip to learn them, and the cloud still enforces them authoritatively
  // on every request regardless of what this client concluded.
  assertVersionFloors(handshake, operation, opts);

  const offered = new Set<string>(handshake.capabilities);
  const missing = required.filter((capability) => !offered.has(capability));
  if (missing.length > 0) {
    throw new CloudCapabilityError(
      'server-behind',
      operation,
      `the cloud does not advertise ${missing.join(', ')}.`
    );
  }

  return handshake;
}
