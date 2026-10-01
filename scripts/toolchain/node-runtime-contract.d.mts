export const NODE_VERSION_FILE: 'scripts/toolchain/node-version.json';
export const OPERATOR_RUNBOOK: 'scripts/toolchain/NODE_RUNTIME_OPERATOR_RUNBOOK.md';
export const SUPPORTED_NODE_MAJOR: number;
export const SUPPORTED_NPM_MAJOR: number;
export const NODE_ENGINE_DECLARATION: string;
export const NPM_ENGINE_DECLARATION: string;

export interface RuntimeVersionDeclaration {
  readonly nodeMajor: number;
  readonly npmMajor: number;
}

export interface NodeRuntimeContractInput {
  readonly versionFileMajor: number;
  readonly versionFileNpmMajor: number;
  readonly engineText: string;
  readonly npmEngineText: string;
  readonly actualVersion: string;
}

export interface NodeRuntimeContractResult {
  readonly supportedMajor: number;
  readonly supportedNpmMajor: number;
  readonly canonicalMajor: number;
  readonly canonicalNpmMajor: number;
  readonly engineMajor: number;
  readonly npmEngineMajor: number;
  readonly actualMajor: number;
  readonly actualVersion: string;
}

export interface NpmRuntimeContractInput {
  readonly versionFileNpmMajor: number;
  readonly npmEngineText: string;
  readonly actualVersion: string;
}

export interface NpmRuntimeContractResult {
  readonly supportedMajor: number;
  readonly canonicalMajor: number;
  readonly engineMajor: number;
  readonly actualMajor: number;
  readonly actualVersion: string;
}

export function parseRuntimeVersionDeclaration(value: unknown): RuntimeVersionDeclaration;
export function parseRuntimeVersionMajor(value: unknown, label?: string): number;
export function parseNodeVersionMajor(value: unknown, label?: string): number;
export function parseEngineMajor(value: unknown, label?: string): number;
export function parseNodeVersionDeclaration(value: unknown): number;
export function evaluateNodeRuntimeContract(input: NodeRuntimeContractInput): NodeRuntimeContractResult;
export function readNodeRuntimeDeclaration(repoRoot: string): {
  readonly versionFileMajor: number;
  readonly versionFileNpmMajor: number;
  readonly engineText: string;
  readonly npmEngineText: string;
};
export function assertNodeRuntimeContract(repoRoot: string, actualVersion?: string): NodeRuntimeContractResult;
export function evaluateNpmRuntimeContract(input: NpmRuntimeContractInput): NpmRuntimeContractResult;
export function assertNpmRuntimeContract(repoRoot: string, actualVersion: string): NpmRuntimeContractResult;
