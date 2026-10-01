import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const NODE_VERSION_FILE = 'scripts/toolchain/node-version.json';
export const OPERATOR_RUNBOOK = 'scripts/toolchain/NODE_RUNTIME_OPERATOR_RUNBOOK.md';

function contractError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export function parseRuntimeVersionDeclaration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError(
      'OPK_NODE_RUNTIME_VERSION_FILE_MALFORMED',
      `${NODE_VERSION_FILE} must contain a JSON object`,
    );
  }
  const record = value;
  if (record.schemaVersion !== 1
    || !Number.isInteger(record.nodeMajor) || record.nodeMajor <= 0
    || !Number.isInteger(record.npmMajor) || record.npmMajor <= 0) {
    throw contractError(
      'OPK_NODE_RUNTIME_VERSION_FILE_MALFORMED',
      `${NODE_VERSION_FILE} must contain positive integer nodeMajor and npmMajor fields under schemaVersion 1`,
    );
  }
  return { nodeMajor: Number(record.nodeMajor), npmMajor: Number(record.npmMajor) };
}

function readBundledRuntimeDeclaration() {
  try {
    return parseRuntimeVersionDeclaration(JSON.parse(readFileSync(new URL('./node-version.json', import.meta.url), 'utf8')));
  } catch (error) {
    if (error?.code && String(error.code).startsWith('OPK_')) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw contractError('OPK_NODE_RUNTIME_VERSION_FILE_MISSING', `${NODE_VERSION_FILE} is missing beside the runtime contract`);
    }
    throw contractError(
      'OPK_NODE_RUNTIME_VERSION_FILE_MALFORMED',
      `cannot read bundled ${NODE_VERSION_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const BUNDLED_RUNTIME_DECLARATION = readBundledRuntimeDeclaration();
export const SUPPORTED_NODE_MAJOR = BUNDLED_RUNTIME_DECLARATION.nodeMajor;
export const SUPPORTED_NPM_MAJOR = BUNDLED_RUNTIME_DECLARATION.npmMajor;
export const NODE_ENGINE_DECLARATION = `${SUPPORTED_NODE_MAJOR}.x`;
export const NPM_ENGINE_DECLARATION = `${SUPPORTED_NPM_MAJOR}.x`;

export function parseRuntimeVersionMajor(
  value,
  label = 'runtime version',
  expectedMajor = SUPPORTED_NODE_MAJOR,
) {
  const text = String(value ?? '').trim();
  const match = /^v?(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.exec(text);
  if (!match?.[1]) {
    throw contractError(
      'OPK_NODE_RUNTIME_VERSION_MALFORMED',
      `${label} must be a semantic version such as v${expectedMajor}.0.0; received ${JSON.stringify(text)}`,
    );
  }
  return Number(match[1]);
}

export function parseNodeVersionMajor(value, label = 'Node.js version') {
  return parseRuntimeVersionMajor(value, label);
}

export function parseEngineMajor(
  value,
  label = 'package.json engines declaration',
  expectedDeclaration = NODE_ENGINE_DECLARATION,
) {
  const text = String(value ?? '').trim();
  const match = /^(\d+)\.x$/u.exec(text);
  if (!match?.[1]) {
    throw contractError(
      'OPK_NODE_RUNTIME_ENGINE_DECLARATION_MALFORMED',
      `${label} must use an exact major contract such as "${expectedDeclaration}"; received ${JSON.stringify(text)}`,
    );
  }
  return Number(match[1]);
}

export function parseNodeVersionDeclaration(value) {
  return parseRuntimeVersionDeclaration(value).nodeMajor;
}

export function evaluateNodeRuntimeContract({
  versionFileMajor,
  versionFileNpmMajor,
  engineText,
  npmEngineText,
  actualVersion,
}) {
  const canonicalMajor = Number(versionFileMajor);
  const canonicalNpmMajor = Number(versionFileNpmMajor);
  if (!Number.isInteger(canonicalMajor) || !Number.isInteger(canonicalNpmMajor)) {
    throw contractError(
      'OPK_NODE_RUNTIME_VERSION_FILE_MALFORMED',
      `${NODE_VERSION_FILE} nodeMajor and npmMajor must be integers`,
    );
  }
  const engineMajor = parseEngineMajor(engineText, 'package.json engines.node', NODE_ENGINE_DECLARATION);
  const npmEngineMajor = parseEngineMajor(npmEngineText, 'package.json engines.npm', NPM_ENGINE_DECLARATION);
  const actualMajor = parseNodeVersionMajor(actualVersion, 'installed Node.js version');

  if (canonicalMajor !== engineMajor || canonicalNpmMajor !== npmEngineMajor) {
    throw contractError(
      'OPK_NODE_RUNTIME_DECLARATION_DRIFT',
      `${NODE_VERSION_FILE} declares Node ${canonicalMajor} / npm ${canonicalNpmMajor}, but package.json engines declare Node ${String(engineText).trim()} / npm ${String(npmEngineText).trim()}`,
    );
  }
  if (canonicalMajor !== SUPPORTED_NODE_MAJOR || canonicalNpmMajor !== SUPPORTED_NPM_MAJOR) {
    throw contractError(
      'OPK_NODE_RUNTIME_DECLARATION_UNSUPPORTED',
      `${NODE_VERSION_FILE} and package.json must match the runtime authority loaded by this toolchain; received Node ${canonicalMajor} / npm ${canonicalNpmMajor}`,
    );
  }
  if (actualMajor !== SUPPORTED_NODE_MAJOR) {
    throw contractError(
      'OPK_NODE_RUNTIME_UNSUPPORTED',
      `Node.js ${SUPPORTED_NODE_MAJOR}.x is required by ${NODE_VERSION_FILE}; running ${String(actualVersion).trim()}. `
        + 'Select the declared Node major, then run "npm run check:node-major". '
        + `See ${OPERATOR_RUNBOOK}.`,
    );
  }

  return {
    supportedMajor: SUPPORTED_NODE_MAJOR,
    supportedNpmMajor: SUPPORTED_NPM_MAJOR,
    canonicalMajor,
    canonicalNpmMajor,
    engineMajor,
    npmEngineMajor,
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
  const declaration = parseRuntimeVersionDeclaration(versionValue);
  const engineText = packageManifest?.engines?.node;
  const npmEngineText = packageManifest?.engines?.npm;
  if (typeof engineText !== 'string' || typeof npmEngineText !== 'string') {
    throw contractError(
      'OPK_NODE_RUNTIME_ENGINE_DECLARATION_MALFORMED',
      'package.json engines.node and engines.npm must both be present and string-valued',
    );
  }
  return {
    versionFileMajor: declaration.nodeMajor,
    versionFileNpmMajor: declaration.npmMajor,
    engineText,
    npmEngineText,
  };
}

export function assertNodeRuntimeContract(repoRoot, actualVersion = process.versions.node) {
  return evaluateNodeRuntimeContract({
    ...readNodeRuntimeDeclaration(repoRoot),
    actualVersion,
  });
}

export function evaluateNpmRuntimeContract({
  versionFileNpmMajor,
  npmEngineText,
  actualVersion,
}) {
  const canonicalMajor = Number(versionFileNpmMajor);
  if (!Number.isInteger(canonicalMajor)) {
    throw contractError('OPK_NPM_RUNTIME_VERSION_FILE_MALFORMED', `${NODE_VERSION_FILE} npmMajor must be an integer`);
  }
  const engineMajor = parseEngineMajor(npmEngineText, 'package.json engines.npm', NPM_ENGINE_DECLARATION);
  const actualMajor = parseRuntimeVersionMajor(actualVersion, 'installed npm version', SUPPORTED_NPM_MAJOR);
  if (canonicalMajor !== engineMajor || canonicalMajor !== SUPPORTED_NPM_MAJOR) {
    throw contractError(
      'OPK_NPM_RUNTIME_DECLARATION_DRIFT',
      `${NODE_VERSION_FILE} npmMajor ${canonicalMajor} must match package.json engines.npm ${String(npmEngineText).trim()} and the loaded authority`,
    );
  }
  if (actualMajor !== SUPPORTED_NPM_MAJOR) {
    throw contractError(
      'OPK_NPM_RUNTIME_UNSUPPORTED',
      `npm ${SUPPORTED_NPM_MAJOR}.x is required by ${NODE_VERSION_FILE}; running ${String(actualVersion).trim()}. Select the declared npm major, then run "npm run check:npm-major".`,
    );
  }
  return { supportedMajor: SUPPORTED_NPM_MAJOR, canonicalMajor, engineMajor, actualMajor, actualVersion: String(actualVersion).trim() };
}

export function assertNpmRuntimeContract(repoRoot, actualVersion) {
  if (typeof actualVersion !== 'string' || actualVersion.trim() === '') {
    throw contractError('OPK_NPM_RUNTIME_VERSION_MISSING', 'installed npm version must be observed by the caller');
  }
  const declaration = readNodeRuntimeDeclaration(repoRoot);
  return evaluateNpmRuntimeContract({
    versionFileNpmMajor: declaration.versionFileNpmMajor,
    npmEngineText: declaration.npmEngineText,
    actualVersion,
  });
}
