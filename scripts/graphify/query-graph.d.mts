export interface GraphNode {
  id: string;
  label: string;
  source_file?: string;
  source_location?: string;
  community?: number;
  [key: string]: unknown;
}

export interface GraphLink {
  source: string;
  target: string;
  relation: string;
  [key: string]: unknown;
}

export interface GraphifyGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  [key: string]: unknown;
}

export interface HubResult {
  label: string;
  sourceFile: string | null;
  degree: number;
}

export interface ClusterResult {
  found: boolean;
  file: string;
  community?: number;
  siblingFiles?: string[];
}

export interface CycleResult {
  found: boolean;
  file: string;
  onCycle?: boolean;
  cycleMembers?: string[];
}

export declare function loadGraph(graphPath: string): GraphifyGraph;
export declare function rankHubs(graph: GraphifyGraph, top?: number): HubResult[];
export declare function findCluster(graph: GraphifyGraph, fileFragment: string): ClusterResult;
export declare function findCycle(graph: GraphifyGraph, fileFragment: string): CycleResult;
