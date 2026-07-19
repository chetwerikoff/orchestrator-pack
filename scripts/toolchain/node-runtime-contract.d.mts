export const SUPPORTED_NODE_MAJOR: 22;
export const NODE_VERSION_FILE: 'scripts/toolchain/node-version.json';
export const NODE_ENGINE_DECLARATION: '22.x';
export const OPERATOR_RUNBOOK: 'scripts/toolchain/NODE_22_OPERATOR_RUNBOOK.md';

export interface NodeRuntimeContractInput {
  readonly versionFileMajor: number;
  readonly engineText: string;
  readonly actualVersion: string;
}

export interface NodeRuntimeContractResult {
  readonly supportedMajor: 22;
  readonly canonicalMajor: number;
  readonly engineMajor: number;
  readonly actualMajor: number;
  readonly actualVersion: string;
}

export function parseNodeVersionMajor(value: unknown, label?: string): number;
export function parseEngineMajor(value: unknown): number;
export function parseNodeVersionDeclaration(value: unknown): number;
export function evaluateNodeRuntimeContract(input: NodeRuntimeContractInput): NodeRuntimeContractResult;
export function readNodeRuntimeDeclaration(repoRoot: string): {
  readonly versionFileMajor: number;
  readonly engineText: string;
};
export function assertNodeRuntimeContract(repoRoot: string, actualVersion?: string): NodeRuntimeContractResult;
