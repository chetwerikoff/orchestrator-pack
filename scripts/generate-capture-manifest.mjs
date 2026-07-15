import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  writeFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const PRODUCER_BY_CAPTURE_DIR = {
  'ao-worker-report': 'ao',
  'ao-status-session': 'ao',
  'ao-review-run': 'ao',
  'ao-webhook-notification': 'ao',
  'gh-pr-open': 'gh',
  'scalar-json': 'ao',
  'array-json': 'ao',
  'unstructured-text': 'ao',
  'cli-behavior': 'ao',
  'path with spaces': 'ao',
};

/**
 * @param {string} repoRoot
 * @param {string} corpusRoot relative to repoRoot
 */
export function defaultCaptureCorpusRoot(repoRoot, corpusRoot = 'tests/external-output-references') {
  return path.join(repoRoot, corpusRoot);
}

/**
 * @param {string} filePath
 */
function sha256File(filePath) {
  const content = readFileSync(filePath);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * @param {string} content
 */
export function detectCaptureKind(content) {
  const trimmed = content.trim();
  if (!trimmed) {
    return 'unstructured';
  }
  try {
    JSON.parse(trimmed);
    return 'structured';
  } catch {
    return 'unstructured';
  }
}

/**
 * @param {string} provenancePath
 */
function readProvenanceFields(provenancePath) {
  if (!existsSync(provenancePath)) {
    return { sourceCommand: null, exitStatus: undefined };
  }
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  const exitStatus =
    provenance.exitStatus ?? provenance.exitCode ?? provenance.exit_status ?? provenance.exit_code;
  return {
    sourceCommand: provenance.sourceCommand ?? provenance.source_command ?? null,
    exitStatus: exitStatus === undefined ? undefined : Number(exitStatus),
  };
}

/**
 * @param {string} repoRoot
 * @param {{ corpusRoot?: string }} [options]
 */
export function generateCaptureManifest(repoRoot, options = {}) {
  const corpusRelative = options.corpusRoot ?? 'tests/external-output-references';
  const retiredCatalogPath = path.join(repoRoot, 'scripts', 'json-producers', 'retired-surfaces.json');
  const retiredSurfaces = existsSync(retiredCatalogPath)
    ? JSON.parse(readFileSync(retiredCatalogPath, 'utf8')).surfaces ?? []
    : [];
  const referencesRoot = path.join(repoRoot, corpusRelative);
  const capturesDir = path.join(referencesRoot, 'captures');
  /** @type {Record<string, object>} */
  const entries = {};

  if (!existsSync(capturesDir)) {
    return { version: 1, corpusRoot: corpusRelative, entries };
  }

  for (const producerDir of readdirSync(capturesDir)) {
    const producerDirPath = path.join(capturesDir, producerDir);
    if (!statSync(producerDirPath).isDirectory()) {
      continue;
    }
    const producer = PRODUCER_BY_CAPTURE_DIR[producerDir] ?? producerDir;
    for (const file of readdirSync(producerDirPath)) {
      if (!file.endsWith('.raw.json') && !file.endsWith('.raw.txt')) {
        continue;
      }
      const baseName = file.replace(/\.raw\.(json|txt)$/, '');
      const captureRel = path.posix.join('captures', producerDir, file);
      const capturePath = path.join(referencesRoot, captureRel);
      const provenanceRel = path.posix.join(
        'captures',
        producerDir,
        `${baseName}.provenance.json`,
      );
      const provenancePath = path.join(referencesRoot, provenanceRel);
      const content = readFileSync(capturePath, 'utf8');
      const kind = file.endsWith('.raw.txt') ? 'unstructured' : detectCaptureKind(content);
      const { sourceCommand, exitStatus } = readProvenanceFields(provenancePath);
      const id = `${producerDir}/${baseName}`;
      /** @type {Record<string, unknown>} */
      const entry = {
        id,
        producer,
        sourceCommand,
        kind,
        path: captureRel,
        contentHash: sha256File(capturePath),
      };
      if (exitStatus !== undefined && !Number.isNaN(exitStatus)) {
        entry.exitStatus = exitStatus;
      }
      const retiredSurface = retiredSurfaces.find((surface) => {
        if (!surface || typeof surface.id !== 'string' || typeof surface.sourceCommandPattern !== 'string') {
          return false;
        }
        return new RegExp(surface.sourceCommandPattern, 'i').test(sourceCommand ?? '');
      });
      if (retiredSurface) {
        entry.status = 'historical';
        entry.retiredSurface = retiredSurface.id;
      }
      entries[id] = entry;
    }
  }

  const sortedEntries = Object.fromEntries(
    Object.keys(entries)
      .sort()
      .map((key) => [key, entries[key]]),
  );

  return {
    version: 1,
    corpusRoot: corpusRelative,
    entries: sortedEntries,
  };
}

/**
 * @param {string} repoRoot
 * @param {string} manifestPath relative to repoRoot
 */
export function loadCommittedCaptureManifest(repoRoot, manifestPath) {
  const absolute = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.join(repoRoot, manifestPath);
  return JSON.parse(readFileSync(absolute, 'utf8'));
}

/**
 * @param {object} committed
 * @param {object} regenerated
 */
export function compareCaptureManifests(committed, regenerated) {
  const errors = [];
  const committedJson = JSON.stringify(
    { version: committed.version, corpusRoot: committed.corpusRoot, entries: committed.entries },
    null,
    2,
  );
  const regeneratedJson = JSON.stringify(
    {
      version: regenerated.version,
      corpusRoot: regenerated.corpusRoot,
      entries: regenerated.entries,
    },
    null,
    2,
  );
  if (committedJson !== regeneratedJson) {
    errors.push('capture manifest does not match regenerated corpus manifest');
  }
  return errors;
}

/**
 * @param {string} repoRoot
 * @param {string} relativePath
 */
export function isGitTracked(repoRoot, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  try {
    const output = execFileSync('git', ['ls-files', '--error-unmatch', normalized], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} corpusRoot relative
 * @param {string} captureRel path under corpus root (posix)
 */
export function assertCapturePathConfined(repoRoot, corpusRoot, captureRel) {
  const errors = [];
  if (path.isAbsolute(captureRel)) {
    errors.push('capture manifest path must be relative');
    return errors;
  }
  if (captureRel.includes('..')) {
    errors.push('capture manifest path must not contain .. segments');
    return errors;
  }
  const referencesRoot = path.join(repoRoot, corpusRoot);
  const capturePath = path.resolve(referencesRoot, captureRel);
  const corpusReal = existsSync(referencesRoot) ? realpathSync(referencesRoot) : referencesRoot;
  let captureReal = capturePath;
  if (existsSync(capturePath)) {
    const stat = lstatSync(capturePath);
    captureReal = stat.isSymbolicLink() ? realpathSync(capturePath) : capturePath;
  }
  if (!captureReal.startsWith(corpusReal + path.sep) && captureReal !== corpusReal) {
    errors.push('capture manifest path escapes capture corpus');
  }
  const repoRelative = path.relative(repoRoot, capturePath).replace(/\\/g, '/');
  if (!isGitTracked(repoRoot, repoRelative)) {
    errors.push('capture manifest path is not git-tracked');
  }
  return errors;
}


import { fileURLToPath } from 'node:url';

function isCliMain() {
  const entry = process.argv[1]?.replace(/\\/g, '/');
  return Boolean(entry?.endsWith('generate-capture-manifest.mjs'));
}

if (isCliMain()) {
  const repoRoot = process.argv.includes('--repo-root')
    ? process.argv[process.argv.indexOf('--repo-root') + 1]
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const corpusFlag = process.argv.indexOf('--corpus-root');
  const corpusRoot = corpusFlag >= 0 ? process.argv[corpusFlag + 1] : 'tests/external-output-references';
  const outFlag = process.argv.indexOf('--out');
  const manifest = generateCaptureManifest(repoRoot, { corpusRoot });
  if (process.argv.includes('--verify')) {
    const manifestPath = process.argv[process.argv.indexOf('--verify') + 1];
    const committed = loadCommittedCaptureManifest(repoRoot, manifestPath);
    const errors = compareCaptureManifests(committed, manifest);
    if (errors.length > 0) {
      for (const error of errors) {
        process.stderr.write(`${error}\n`);
      }
      process.exit(1);
    }
    process.stdout.write('capture-manifest: PASS\n');
    process.exit(0);
  }
  const outPath = outFlag >= 0
    ? process.argv[outFlag + 1]
    : path.join(repoRoot, corpusRoot, 'capture-manifest.json');
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`wrote ${outPath}\n`);
}
