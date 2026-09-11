export interface ArtifactPaths {
  dir: string;
  artifactJson: string;
  eventsNdjson: string;
  sidecarsDir: string;
  planMd: string;
  planJson: string;
  checkpointMd: (n: number) => string;
  checkpointJson: (n: number) => string;
  evaluatorsJson: string;
  summaryMd: string;
  summaryJson: string;
  digestMd: string;
  resumeMd: string;
  digestMeta: string;
  artifactId: string;
}
