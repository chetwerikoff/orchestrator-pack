import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SUPPORTED_NODE_MAJOR = 22;
export const NODE_VERSION_SOURCE = 'package.json engines.node';
export const NODE_ENGINE_DECLARATION = '22.x';
export const OPERATOR_RUNBOOK = 'scripts/toolchain/NODE_22_OPERATOR_RUNBOOK.md';

function contractError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export function parseNodeVersionMajor(value, label = 'Node.js version') {
  const text = String(value ?? '').trim();
  const match = /^v?(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.exec(text);
  if (!match?.[1]) {
    throw contractError(
      'OPK_NODE_RUNTIME_VERSION_MALFORMED',
      `${label} must be a semantic version such as v22.16.0; received ${JSON.stringify(text)}`,
    );
  }
  return Number(match[1]);
}

export function parseEngineMajor(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d+)\.x$/u.exec(text);
  if (!match?.[1]) {
    throw contractError(
      'OPK_NODE_RUNTIME_DECLARATION_MALFORMED',
      `package.json engines.node must use the exact major contract "${NODE_ENGINE_DECLARATION}"; received ${JSON.stringify(text)}`,
    );
  }
  return Number(match[1]);
}

export function evaluateNodeRuntimeContract({ engineText, actualVersion }) {
  const engineMajor = parseEngineMajor(engineText);
  const actualMajor = parseNodeVersionMajor(actualVersion, 'installed Node.js version');

  if (engineMajor !== SUPPORTED_NODE_MAJOR) {
    throw contractError(
      'OPK_NODE_RUNTIME_DECLARATION_UNSUPPORTED',
      `package.json engines.node must declare Node ${SUPPORTED_NODE_MAJOR}.x; received ${String(engineText).trim()}`,
    );
  }
  if (actualMajor !== SUPPORTED_NODE_MAJOR) {
    throw contractError(
      'OPK_NODE_RUNTIME_UNSUPPORTED',
      `Node.js ${SUPPORTED_NODE_MAJOR}.x is required; running ${String(actualVersion).trim()}. `
        + `Install/use Node ${SUPPORTED_NODE_MAJOR}, then run "npm run check:node-major". `
        + `See ${OPERATOR_RUNBOOK}.`,
    );
  }

  return {
    supportedMajor: SUPPORTED_NODE_MAJOR,
    engineMajor,
    actualMajor,
    actualVersion: String(actualVersion).trim(),
  };
}

export function readNodeRuntimeDeclaration(repoRoot) {
  const root = resolve(repoRoot);
  let packageManifest;
  try {
    packageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  } catch (error) {
    throw contractError(
      'OPK_NODE_RUNTIME_DECLARATION_UNREADABLE',
      `cannot read package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const engineText = packageManifest?.engines?.node;
  if (typeof engineText !== 'string') {
    throw contractError(
      'OPK_NODE_RUNTIME_DECLARATION_MALFORMED',
      'package.json engines.node must be present and string-valued',
    );
  }
  return { engineText };
}

export function assertNodeRuntimeContract(repoRoot, actualVersion = process.versions.node) {
  return evaluateNodeRuntimeContract({
    ...readNodeRuntimeDeclaration(repoRoot),
    actualVersion,
  });
}
