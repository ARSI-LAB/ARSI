export interface Candidate {
  ref: string;
  artifactRef: string;
  parentRef: string | null;
  experimentId: string;
}
