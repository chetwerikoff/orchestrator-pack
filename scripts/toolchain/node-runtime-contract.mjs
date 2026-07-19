import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SUPPORTED_NODE_MAJOR = 22;
export const NODE_VERSION_FILE = 'scripts/toolchain/node-version.json';
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
      'OPK_NODE_RUNTIME_ENGINE_DECLARATION_MALFORMED',
      `package.json engines.node must use an exact major contract such as "${NODE_ENGINE_DECLARATION}"; received ${JSON.stringify(text)}`,
    );
  }
  return Number(match[1]);
}

export function parseNodeVersionDeclaration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError(
      'OPK_NODE_RUNTIME_VERSION_FILE_MALFORMED',
      `${NODE_VERSION_FILE} must contain a JSON object`,
    );
  }
  const record = value;
  if (record.schemaVersion !== 1 || !Number.isInteger(record.nodeMajor)) {
    throw contractError(
      'OPK_NODE_RUNTIME_VERSION_FILE_MALFORMED',
      `${NODE_VERSION_FILE} must contain { "schemaVersion": 1, "nodeMajor": ${SUPPORTED_NODE_MAJOR} }`,
    );
  }
  return Number(record.nodeMajor);
}

export function evaluateNodeRuntimeContract({ versionFileMajor, engineText, actualVersion }) {
  const canonicalMajor = Number(versionFileMajor);
  if (!Number.isInteger(canonicalMajor)) {
    throw contractError(
      'OPK_NODE_RUNTIME_VERSION_FILE_MALFORMED',
      `${NODE_VERSION_FILE} nodeMajor must be an integer`,
    );
  }
  const engineMajor = parseEngineMajor(engineText);
  const actualMajor = parseNodeVersionMajor(actualVersion, 'installed Node.js version');

  if (canonicalMajor !== engineMajor) {
    throw contractError(
      'OPK_NODE_RUNTIME_DECLARATION_DRIFT',
      `${NODE_VERSION_FILE} declares Node ${canonicalMajor}, but package.json engines.node declares ${String(engineText).trim()}`,
    );
  }
  if (canonicalMajor !== SUPPORTED_NODE_MAJOR) {
    throw contractError(
      'OPK_NODE_RUNTIME_DECLARATION_UNSUPPORTED',
      `${NODE_VERSION_FILE} and package.json must declare Node ${SUPPORTED_NODE_MAJOR}; received ${canonicalMajor}`,
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
    canonicalMajor,
    engineMajor,
    actualMajor,
    actualVersion: String(actualVersion).trim(),
  };
}

function readJson(path, missingCode, malformedCode, label) {
  if (!existsSync(path)) {
    throw contractError(missingCode, `${label} is missing at ${path}`);
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw contractError(malformedCode, `cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw contractError(malformedCode, `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readNodeRuntimeDeclaration(repoRoot) {
  const root = resolve(repoRoot);
  const versionPath = resolve(root, NODE_VERSION_FILE);
  const packagePath = resolve(root, 'package.json');
  const versionValue = readJson(
    versionPath,
    'OPK_NODE_RUNTIME_VERSION_FILE_MISSING',
    'OPK_NODE_RUNTIME_VERSION_FILE_MALFORMED',
    NODE_VERSION_FILE,
  );
  const packageManifest = readJson(
    packagePath,
    'OPK_NODE_RUNTIME_PACKAGE_MISSING',
    'OPK_NODE_RUNTIME_PACKAGE_MALFORMED',
    'package.json',
  );
  const engineText = packageManifest?.engines?.node;
  if (typeof engineText !== 'string') {
    throw contractError(
      'OPK_NODE_RUNTIME_ENGINE_DECLARATION_MALFORMED',
      'package.json engines.node must be present and string-valued',
    );
  }
  return {
    versionFileMajor: parseNodeVersionDeclaration(versionValue),
    engineText,
  };
}

export function assertNodeRuntimeContract(repoRoot, actualVersion = process.versions.node) {
  return evaluateNodeRuntimeContract({
    ...readNodeRuntimeDeclaration(repoRoot),
    actualVersion,
  });
}
