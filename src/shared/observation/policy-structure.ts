import type { JsonValue } from '../../contracts/json.js';

/** Static initial-definition projection. No coordinates, execution state or evaluated values. */
export type StructureAvailability = 'complete' | 'partial' | 'unavailable';
export type PolicyStepType =
  | 'invoke'
  | 'state'
  | 'if'
  | 'loop'
  | 'foreach'
  | 'control'
  | 'reflection';
export interface StructureDiagnostic {
  category:
    | 'missing-source'
    | 'unsupported-source'
    | 'invalid-source'
    | 'analysis'
    | 'oversized';
  view: 'all' | 'flow' | 'data' | 'details';
  nodeId: string | null;
  location: string | null;
  message: string;
}
export interface StructureStep {
  id: string;
  localId: string;
  type: PolicyStepType;
  label: string;
  location: string;
  scopeId: string;
  childScopeIds: string[];
  detailId: string;
}
export interface StructureScope {
  id: string;
  parentStepId: string | null;
  region: 'root' | 'then' | 'else' | 'iteration' | 'item';
  location: string;
  stepIds: string[];
  entryId: string;
  exitId: string;
}
export interface StructureFlowNode {
  id: string;
  kind: 'step' | 'entry' | 'exit' | 'failure';
  stepId: string | null;
  scopeId: string;
  label: string;
}
export interface StructureFlowEdge {
  id: string;
  source: string;
  target: string;
  kind: 'sequence' | 'branch' | 'repetition' | 'break' | 'continue' | 'fail';
  label: string | null;
  location: string;
}
export interface StructurePort {
  id: string;
  label: string;
  role: 'field' | 'input' | 'output' | 'expression';
  /** Static field segments; dynamic suffixes are never fabricated. */
  path: string[];
  location: string;
}
export interface StructureDataNode {
  id: string;
  kind:
    | 'step'
    | 'input'
    | 'config'
    | 'state'
    | 'output'
    | 'application'
    | 'loop'
    | 'item';
  stepId: string | null;
  label: string;
  scopeId: string;
  detailId: string;
  ports: StructurePort[];
}
export interface StructureDataEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  kind: 'reference' | 'state-write' | 'item-binding' | 'output-mapping';
  dynamic: boolean;
  /** Branch origin or symbolic collection mapping, not an observed result. */
  label: string | null;
  location: string;
}
export type StructureExpressionPreview =
  | { location: string; kind: 'config'; path: string[] }
  | { location: string; kind: 'value'; value: JsonValue }
  | { location: string; kind: 'range'; start: number; end: number };

export interface StructureDetail {
  id: string;
  declaration: JsonValue;
  configuration: JsonValue;
  bindingId: string | null;
  expressionPreviews?: StructureExpressionPreview[];
}
export interface StructureBinding {
  id: string;
  name: string;
  contract: string | null;
  plugin: string | null;
  /** Description from the current registry for the saved plugin ID, when available. */
  pluginDescription?: string;
  configuration: JsonValue;
}
export interface PolicyStructure {
  source: {
    experimentId: string;
    policyId: string | null;
    definitionDigest: string | null;
    snapshot: 'initial';
  };
  availability: {
    overall: StructureAvailability;
    flow: StructureAvailability;
    data: StructureAvailability;
    details: StructureAvailability;
  };
  steps: StructureStep[];
  scopes: StructureScope[];
  flow: { nodes: StructureFlowNode[]; edges: StructureFlowEdge[] };
  data: { nodes: StructureDataNode[]; edges: StructureDataEdge[] };
  details: StructureDetail[];
  bindings: StructureBinding[];
  diagnostics: StructureDiagnostic[];
}
