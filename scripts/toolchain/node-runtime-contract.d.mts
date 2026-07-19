export const SUPPORTED_NODE_MAJOR: 22;
export const NODE_VERSION_FILE: '.nvmrc';
export const NODE_ENGINE_DECLARATION: '22.x';
export const OPERATOR_RUNBOOK: 'scripts/toolchain/NODE_22_OPERATOR_RUNBOOK.md';

export interface NodeRuntimeContractInput {
  readonly nvmrcText: string;
  readonly engineText: string;
  readonly actualVersion: string;
}

export interface NodeRuntimeContractResult {
  readonly supportedMajor: 22;
  readonly versionFileMajor: number;
  readonly engineMajor: number;
  readonly actualMajor: number;
  readonly actualVersion: string;
}

export function parseNodeVersionMajor(value: string, label?: string): number;
export function parseNvmrcMajor(value: string): number;
export function parseEngineMajor(value: string): number;
export function evaluateNodeRuntimeContract(input: NodeRuntimeContractInput): NodeRuntimeContractResult;
export function readNodeRuntimeDeclarations(repoRoot: string): {
  readonly nvmrcText: string;
  readonly engineText: string;
};
export function assertNodeRuntimeContract(repoRoot: string, actualVersion?: string): NodeRuntimeContractResult;
