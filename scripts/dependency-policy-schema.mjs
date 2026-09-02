// Shared vocabulary of the dependency policy: what a valid GHSA id, expiry
// date, and policy source look like.
//
// This module imports NOTHING outside Node built-ins, and it must stay that
// way. scripts/run-production-audit.mjs runs in the CI audit job, which
// deliberately performs no `pnpm install` — a third-party import here would
// make the audit crash on a missing module instead of reporting a result.
// The YAML-parsing checker is what depends on `yaml`, and only it.

export const SUPPORTED_SCHEMA_VERSION = 1;
export const VALID_SOURCES = ['syncpack-pin', 'manual'];

// GHSA ids are `GHSA-` plus three 4-character groups over a reduced base32
// alphabet. Strict on purpose: an unparseable id fails closed, blocking the
// exception rather than silently accepting something that will never match a
// real advisory.
export const GHSA_PATTERN =
  /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
export const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A real calendar date, not merely a well-shaped string: 2026-02-30 is not. */
export function isRealIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  );
}
