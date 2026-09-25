import { rationaleTerms } from './rationale-accounts.js';

const GENERIC_PATH_TERMS = new Set(
  'src lib app apps packages index main layout test tests ts tsx js jsx'.split(' ')
);
const GENERIC_DISCOVERY_TERMS = new Set([
  ...GENERIC_PATH_TERMS,
  ...'add added keep retain preserve remove replace update change work task source file files code project record recorded'.split(
    ' '
  ),
]);

export function rationaleLexicalSupport(
  wording: string,
  reason: string | null,
  seeds: readonly string[]
) {
  const head = new Set(rationaleTerms(wording.slice(0, 1024)));
  const local = new Set([...head, ...rationaleTerms((reason ?? '').slice(0, 512))]);
  return Math.max(
    0,
    ...seeds.map((text) => {
      const terms = rationaleTerms(text)
        .slice(0, 16)
        .filter((term) => !GENERIC_DISCOVERY_TERMS.has(term));
      const shared = terms.filter((term) => local.has(term));
      return terms.some((term) => head.has(term)) && shared.length >= 2 ? shared.length : 0;
    })
  );
}

export function rationaleChangePassage(wording: string): boolean {
  return /\b(remove[d]?|replace[d]?|supersede[sd]?|retire[d]?|correct(ed|ion)?|challenge[sd]?|revoke[sd]?)\b/i.test(
    wording
  );
}

export function rationaleTargetMatch(text: string, file?: string) {
  if (!file) return { kind: 'candidate_context' as const, terms: [] as string[] };
  const normalized = file.replaceAll('\\', '/');
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|[^\\w/.-])${escaped}(?=$|[^\\w/.-]|\\.(?:\\s|$))`, 'i').test(text))
    return { kind: 'explicit_path' as const, terms: [normalized] };
  const words = new Set(rationaleTerms(text));
  const terms = rationaleTerms(normalized.replace(/\.[^/.]+$/, ''))
    .filter((term) => !GENERIC_PATH_TERMS.has(term))
    .slice(0, 16)
    .filter((term) => words.has(term));
  return { kind: terms.length ? ('target_terms' as const) : ('candidate_context' as const), terms };
}

export function rationaleTargetRank(match: ReturnType<typeof rationaleTargetMatch>): number {
  return match.kind === 'explicit_path' ? 0 : match.kind === 'target_terms' ? 1 : 2;
}

export function rationaleSourcePath(path: string): string {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\.(reason|alternatives_considered\..*)$/, '.decision');
}
