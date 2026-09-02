// The gap-expansion stores, published to the two places that render a diff.
//
// A context rather than a prop drill because the diff column is reached down two
// independent paths (the synthesized walk and the deterministic floor), and both
// need the same three things: where to fetch source from, what is open, and how
// to toggle. Drilling would mean threading four props through four components
// twice — and the file cards add a third path.
//
// The default is INERT, not a throw: a component rendered outside the provider
// (a snapshot test, a fixture) gets "nothing expanded, nothing fetchable" and
// renders the collapsed rows exactly as it does today.

import { createContext, type ReactNode, useContext } from 'react';

import type { DiffFile } from '@orcaops/diff-render';

import type { ExpandedGaps, SourceStatusByFile } from './gapExpansion';
import type { PatchIndexSource } from './walkDiff';

export interface GapExpansionValue {
  /**
   * Repo root + review slug. `buildPatchIndex` needs these to attach the
   * tree-source fetcher; without them a file's `sourceFetcher` is undefined and
   * every expansion is inert: a call site that passes the diff and nothing else
   * gets a reader whose gaps can never open.
   */
  source: PatchIndexSource | undefined;
  expandedGaps: ExpandedGaps;
  sourceStatusByFile: SourceStatusByFile;
  /** Toggle one gap of one file. The DiffFile carries the fetcher the expand needs. */
  toggleGap: (file: string, gap: string, diff: DiffFile) => void;
}

const INERT: GapExpansionValue = {
  source: undefined,
  expandedGaps: new Map(),
  sourceStatusByFile: new Map(),
  toggleGap: () => {},
};

const GapExpansionContext = createContext<GapExpansionValue>(INERT);

export function GapExpansionProvider({
  value,
  children,
}: {
  value: GapExpansionValue;
  children: ReactNode;
}) {
  return <GapExpansionContext.Provider value={value}>{children}</GapExpansionContext.Provider>;
}

export function useGapExpansion(): GapExpansionValue {
  return useContext(GapExpansionContext);
}
