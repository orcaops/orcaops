export function buildAcknowledgeByRef(
  evaluators: readonly {
    ref: string;
    severity: string;
    resolution: { acknowledge: { enabled: boolean } };
  }[]
): (ref: string) => boolean {
  const map = new Map<string, boolean>();
  for (const e of evaluators) {
    map.set(e.ref, e.severity === 'block' && e.resolution.acknowledge.enabled);
  }
  return (ref) => map.get(ref) === true;
}
