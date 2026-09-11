/** The one spelling of the imported-provenance badge on row-level renders. */
export const IMPORTED_BADGE = '[imported]';

/**
 * Row badge for an imported artifact, trailing-space form for inline
 * prefixing. One helper so the disclosure tag cannot drift across the
 * list/show/search/digest surfaces.
 */
export function importedTag(originKind: string | null | undefined): string {
  return originKind === 'git-import' ? `${IMPORTED_BADGE} ` : '';
}
