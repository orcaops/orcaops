#!/usr/bin/env node
// Structural checker for the dependency policy. Asserts that
// config/dependency-policy.json, .github/dependabot.yml, .syncpackrc.json,
// and pnpm-workspace.yaml still agree with each other.
//
// Everything here PARSES its inputs. Never text-scan: pnpm-workspace.yaml
// deliberately names the forbidden auditConfig keys in a comment explaining
// why they are absent, and a scanner would match that warning.
//
// Deliberately NOT checked here: whether an exception is past `expiresOn`.
// Temporal expiry belongs to scripts/run-production-audit.mjs — putting it in
// the globally-run lint job would block unrelated feature PRs on the calendar.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  GHSA_PATTERN,
  SUPPORTED_SCHEMA_VERSION,
  VALID_SOURCES,
  isNonEmptyString,
  isPlainObject,
  isRealIsoDate,
} from './dependency-policy-schema.mjs';

const POLICY_FILE = 'config/dependency-policy.json';
const DEPENDABOT_FILE = '.github/dependabot.yml';
const SYNCPACK_FILE = '.syncpackrc.json';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const ROOT_MANIFEST = 'package.json';

const POLICY_KEYS = ['schemaVersion', 'manuallyManagedDependencies', 'advisoryExceptions'];
const ENTRY_KEYS = ['dependency', 'source', 'owner', 'rationale', 'evidence'];
const EXCEPTION_KEYS = ['ghsa', 'owner', 'rationale', 'expiresOn', 'evidence'];

const GLOB_CHARS = /[*?![\]]/;

function unexpectedKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

function readFile(rootDir, relPath, errors) {
  try {
    return readFileSync(path.join(rootDir, relPath), 'utf8');
  } catch (err) {
    errors.push(
      err.code === 'ENOENT'
        ? `${relPath}: file not found. The dependency policy requires it; restore it or update the checker.`
        : `${relPath}: could not be read (${err.code ?? err.message}).`
    );
    return null;
  }
}

function parseFile(rootDir, relPath, parser, errors) {
  const text = readFile(rootDir, relPath, errors);
  if (text === null) return null;
  try {
    return parser(text);
  } catch (err) {
    errors.push(`${relPath}: could not be parsed — ${err.message}. Fix the syntax error.`);
    return null;
  }
}

/**
 * Concrete external dependency names carrying a syncpack `pinVersion`.
 * Excludes meta-selectors (`$LOCAL`, `$PACKAGE`, …) and workspace-protocol
 * pins: those are layout rules, not external version pins, and must never
 * become a Dependabot ignore.
 */
function collectSyncpackPins(syncpack, errors) {
  const pins = new Set();
  const groups = Array.isArray(syncpack?.versionGroups) ? syncpack.versionGroups : [];

  for (const [i, group] of groups.entries()) {
    if (!isPlainObject(group) || typeof group.pinVersion !== 'string') continue;
    if (group.pinVersion.startsWith('workspace:')) continue;

    const deps = Array.isArray(group.dependencies) ? group.dependencies : [];
    for (const dep of deps) {
      if (!isNonEmptyString(dep)) {
        errors.push(
          `${SYNCPACK_FILE}: versionGroups[${i}].dependencies contains a non-string entry. Every pinned dependency must be an exact name.`
        );
        continue;
      }
      if (dep.startsWith('$')) continue; // meta-selector
      if (GLOB_CHARS.test(dep)) {
        errors.push(
          `${SYNCPACK_FILE}: versionGroups[${i}] pins "${dep}", which is a pattern. Policy schema version ${SUPPORTED_SCHEMA_VERSION} can only represent exact dependency names — list them individually or extend the schema.`
        );
        continue;
      }
      pins.add(dep);
    }
  }
  return pins;
}

/** npm `ignore` names, rejecting any entry the version-one schema cannot represent. */
function collectDependabotIgnores(dependabot, errors) {
  const names = new Set();
  const updates = Array.isArray(dependabot?.updates) ? dependabot.updates : [];
  const npmBlocks = updates.filter(
    (u) => isPlainObject(u) && u['package-ecosystem'] === 'npm' && u.directory === '/'
  );

  if (npmBlocks.length === 0) {
    errors.push(
      `${DEPENDABOT_FILE}: no npm update block for directory "/". The policy has nothing to compare its ignore list against.`
    );
    return names;
  }
  if (npmBlocks.length > 1) {
    errors.push(
      `${DEPENDABOT_FILE}: ${npmBlocks.length} npm update blocks for directory "/". Merge them — the checker cannot tell which one owns the ignore list.`
    );
    return names;
  }

  const ignores = npmBlocks[0].ignore ?? [];
  if (!Array.isArray(ignores)) {
    errors.push(`${DEPENDABOT_FILE}: the npm block's "ignore" must be a list.`);
    return names;
  }

  for (const [i, entry] of ignores.entries()) {
    const at = `${DEPENDABOT_FILE}: npm ignore[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(
        `${at} is not a mapping. Every ignore entry must be { dependency-name: <exact name> }.`
      );
      continue;
    }
    const extra = unexpectedKeys(entry, ['dependency-name']);
    if (extra.length > 0) {
      // `versions` / `update-types` suppress a SUBSET of updates. The policy
      // file records only whole-dependency manual management, so it cannot
      // represent — and therefore cannot verify — a partial ignore.
      errors.push(
        `${at} uses ${extra.map((k) => `"${k}"`).join(', ')}. Policy schema version ${SUPPORTED_SCHEMA_VERSION} represents whole-dependency ignores only; extend the schema before suppressing specific versions or update types.`
      );
      continue;
    }
    const name = entry['dependency-name'];
    if (!isNonEmptyString(name)) {
      errors.push(`${at} has a missing or empty "dependency-name".`);
      continue;
    }
    if (GLOB_CHARS.test(name)) {
      errors.push(
        `${at} "${name}" is a wildcard. Ignore dependencies by exact name so each one has its own policy entry and owner.`
      );
      continue;
    }
    if (names.has(name)) {
      errors.push(`${at} "${name}" is listed twice.`);
      continue;
    }
    names.add(name);
  }
  return names;
}

function checkManuallyManaged(policy, syncpackPins, errors) {
  const entries = policy.manuallyManagedDependencies;
  const names = new Set();

  if (!Array.isArray(entries)) {
    errors.push(`${POLICY_FILE}: "manuallyManagedDependencies" must be a list.`);
    return names;
  }

  for (const [i, entry] of entries.entries()) {
    const at = `${POLICY_FILE}: manuallyManagedDependencies[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at} is not an object.`);
      continue;
    }
    const extra = unexpectedKeys(entry, ENTRY_KEYS);
    if (extra.length > 0) {
      errors.push(
        `${at} has unsupported key(s) ${extra.map((k) => `"${k}"`).join(', ')}. Allowed: ${ENTRY_KEYS.join(', ')}.`
      );
    }

    const name = entry.dependency;
    const label = isNonEmptyString(name) ? `"${name}"` : `index ${i}`;
    if (!isNonEmptyString(name)) {
      errors.push(`${at} is missing a "dependency" name.`);
    } else if (GLOB_CHARS.test(name)) {
      errors.push(
        `${at} ${label} is a wildcard. List each dependency by exact name so it carries its own rationale and owner.`
      );
    } else if (names.has(name)) {
      errors.push(`${at} ${label} is declared more than once.`);
    } else {
      names.add(name);
    }

    if (!isNonEmptyString(entry.owner)) {
      errors.push(
        `${at} ${label} has no "owner". Name the GitHub login or team accountable for upgrading it.`
      );
    }
    if (!isNonEmptyString(entry.rationale)) {
      errors.push(`${at} ${label} has no "rationale". State why automation must not move it.`);
    }
    if (!isNonEmptyString(entry.source)) {
      errors.push(`${at} ${label} has no "source". Use one of: ${VALID_SOURCES.join(', ')}.`);
    } else if (!VALID_SOURCES.includes(entry.source)) {
      errors.push(
        `${at} ${label} has source "${entry.source}". Allowed: ${VALID_SOURCES.join(', ')}. There is no generic source — a new kind of suppression must extend the schema so the rule stays verifiable.`
      );
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      errors.push(
        `${at} ${label} needs at least one "evidence" reference (a file, commit, or URL).`
      );
    } else if (!entry.evidence.every(isNonEmptyString)) {
      errors.push(`${at} ${label} has an empty or non-string "evidence" entry.`);
    }

    // A syncpack-pin entry must still describe a live syncpack pin.
    if (entry.source === 'syncpack-pin' && isNonEmptyString(name) && !syncpackPins.has(name)) {
      errors.push(
        `${POLICY_FILE}: ${label} claims source "syncpack-pin" but no concrete pinVersion rule in ${SYNCPACK_FILE} pins it. Remove the stale entry, or change its source to "manual" if it is still managed by hand.`
      );
    }
  }

  // …and every syncpack pin must be declared.
  for (const pinned of syncpackPins) {
    const entry = entries.find((e) => isPlainObject(e) && e.dependency === pinned);
    if (!entry) {
      errors.push(
        `${POLICY_FILE}: ${SYNCPACK_FILE} pins "${pinned}" but it has no policy entry. Add one with source "syncpack-pin", or drop the syncpack pin.`
      );
    } else if (entry.source !== 'syncpack-pin') {
      errors.push(
        `${POLICY_FILE}: "${pinned}" is pinned by ${SYNCPACK_FILE} but its policy source is "${entry.source}". Use "syncpack-pin" so the pin's real origin stays recorded.`
      );
    }
  }

  return names;
}

function checkAdvisoryExceptions(policy, errors) {
  const exceptions = policy.advisoryExceptions;
  if (!Array.isArray(exceptions)) {
    errors.push(
      `${POLICY_FILE}: "advisoryExceptions" must be a list (use [] when there are none).`
    );
    return;
  }

  const seen = new Set();
  for (const [i, entry] of exceptions.entries()) {
    const at = `${POLICY_FILE}: advisoryExceptions[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at} is not an object.`);
      continue;
    }

    // The key allowlist is what rejects CVE-based, package-wide, and
    // severity-wide exceptions: each would need a key this schema refuses.
    const extra = unexpectedKeys(entry, EXCEPTION_KEYS);
    if (extra.length > 0) {
      errors.push(
        `${at} has unsupported key(s) ${extra.map((k) => `"${k}"`).join(', ')}. Schema version ${SUPPORTED_SCHEMA_VERSION} accepts only ${EXCEPTION_KEYS.join(', ')} — an exception must name one exact GHSA, never a CVE, package, or severity.`
      );
    }

    const ghsa = entry.ghsa;
    const label = isNonEmptyString(ghsa) ? `"${ghsa}"` : `index ${i}`;
    if (!isNonEmptyString(ghsa)) {
      errors.push(`${at} is missing "ghsa". Name the exact GitHub advisory being accepted.`);
    } else if (!GHSA_PATTERN.test(ghsa)) {
      errors.push(
        `${at} ${label} is not a valid GHSA identifier. Expected the exact form GHSA-xxxx-xxxx-xxxx; CVE ids, wildcards, and package names are not accepted.`
      );
    } else if (seen.has(ghsa)) {
      errors.push(`${at} ${label} is excepted more than once. Keep one entry per advisory.`);
    } else {
      seen.add(ghsa);
    }

    if (!isNonEmptyString(entry.owner)) {
      errors.push(`${at} ${label} has no "owner". Name who is accepting this risk.`);
    }
    if (!isNonEmptyString(entry.rationale)) {
      errors.push(
        `${at} ${label} has no "rationale". State why accepting it beats the available remediation.`
      );
    }

    const expiresOn = entry.expiresOn;
    if (!isNonEmptyString(expiresOn)) {
      errors.push(
        `${at} ${label} has no "expiresOn". Exceptions are time-boxed; a permanent exception is not representable.`
      );
    } else if (!isRealIsoDate(expiresOn)) {
      errors.push(
        `${at} ${label} has expiresOn "${expiresOn}", which is not a real YYYY-MM-DD calendar date.`
      );
    }

    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      errors.push(
        `${at} ${label} needs at least one "evidence" reference supporting the decision.`
      );
    } else if (!entry.evidence.every(isNonEmptyString)) {
      errors.push(`${at} ${label} has an empty or non-string "evidence" entry.`);
    }
  }
}

/**
 * pnpm must not filter the audit before the wrapper sees it. In pnpm 10.18.2 a
 * configured `ignoreGhsas` is stripped from JSON `advisories` while the exit
 * code and metadata keep pre-filter totals, so the report and the signal
 * disagree. Any auditConfig at all is rejected, in either location pnpm reads.
 */
function checkNoPnpmAuditSuppression(sources, errors) {
  for (const [where, auditConfig] of sources) {
    if (auditConfig === undefined) continue;
    const keys = isPlainObject(auditConfig) ? Object.keys(auditConfig) : [];
    const detail = keys.length > 0 ? ` (found ${keys.map((k) => `"${k}"`).join(', ')})` : '';
    errors.push(
      `${where}: remove "auditConfig"${detail}. pnpm-level audit suppression hides findings before scripts/run-production-audit.mjs can classify them; record accepted advisories in ${POLICY_FILE} instead.`
    );
  }
}

/**
 * @param {string} rootDir repository root to check
 * @returns {{ errors: string[] }}
 */
export function checkDependencyPolicy(rootDir) {
  const errors = [];

  const policy = parseFile(rootDir, POLICY_FILE, JSON.parse, errors);
  const syncpack = parseFile(rootDir, SYNCPACK_FILE, JSON.parse, errors);
  const dependabot = parseFile(rootDir, DEPENDABOT_FILE, parseYaml, errors);
  const workspace = parseFile(rootDir, WORKSPACE_FILE, parseYaml, errors);
  const rootManifest = parseFile(rootDir, ROOT_MANIFEST, JSON.parse, errors);

  if (workspace !== null || rootManifest !== null) {
    checkNoPnpmAuditSuppression(
      [
        [WORKSPACE_FILE, workspace?.auditConfig],
        [`${ROOT_MANIFEST} (pnpm.auditConfig)`, rootManifest?.pnpm?.auditConfig],
      ],
      errors
    );
  }

  if (policy === null) return { errors };
  if (!isPlainObject(policy)) {
    errors.push(`${POLICY_FILE}: top level must be an object.`);
    return { errors };
  }

  const extraTop = unexpectedKeys(policy, POLICY_KEYS);
  if (extraTop.length > 0) {
    errors.push(
      `${POLICY_FILE}: unsupported top-level key(s) ${extraTop.map((k) => `"${k}"`).join(', ')}. Allowed: ${POLICY_KEYS.join(', ')}.`
    );
  }

  if (policy.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.push(
      `${POLICY_FILE}: schemaVersion ${JSON.stringify(policy.schemaVersion)} is not supported. This checker understands version ${SUPPORTED_SCHEMA_VERSION}.`
    );
    return { errors };
  }

  const syncpackPins = syncpack === null ? new Set() : collectSyncpackPins(syncpack, errors);
  const policyNames = checkManuallyManaged(policy, syncpackPins, errors);
  checkAdvisoryExceptions(policy, errors);

  if (dependabot !== null) {
    const ignored = collectDependabotIgnores(dependabot, errors);
    // An ignore without a policy entry is an unowned suppression; a policy
    // entry without an ignore is a rule nothing enforces. Both are drift.
    for (const name of ignored) {
      if (!policyNames.has(name)) {
        errors.push(
          `${DEPENDABOT_FILE} ignores "${name}" but ${POLICY_FILE} has no entry for it. Ignoring a dependency also suppresses its security PRs, so it needs a recorded owner and rationale.`
        );
      }
    }
    for (const name of policyNames) {
      if (!ignored.has(name)) {
        errors.push(
          `${POLICY_FILE} declares "${name}" manually managed but ${DEPENDABOT_FILE} does not ignore it. Add { dependency-name: '${name}' } to the npm ignore list, or drop the policy entry.`
        );
      }
    }
  }

  return { errors };
}

function main() {
  const rootDir =
    process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { errors } = checkDependencyPolicy(rootDir);

  if (errors.length > 0) {
    console.error(`Dependency policy check failed with ${errors.length} problem(s):\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error('\nSee docs/dependency-policy.md.');
    process.exit(1);
  }
  console.log('Dependency policy OK.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
