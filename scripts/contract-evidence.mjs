import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAtJsonPath } from './external-output-shape-guard.mjs';
import { normalizeLine, parseKeyValueBlock } from './markdown-key-value.mjs';
import {
  assertCapturePathConfined,
  compareCaptureManifests,
  detectCaptureKind,
  generateCaptureManifest,
  loadCommittedCaptureManifest,
} from './generate-capture-manifest.mjs';

const require = createRequire(import.meta.url);
const producerRegistry = require('./contract-evidence-producer-registry.json');

const FENCE_PATTERN = /```([a-z0-9-]+)\s*\r?\n([\s\S]*?)```/gi;
const GENERIC_FENCE_PATTERN = /```([^\r\n]*)\r?\n([\s\S]*?)```/g;
const NEW_EVIDENCE_PATTERN = /^NEW\(produced-by AC#(\d+)\)$/i;
const CAPTURE_EVIDENCE_PATTERN = /^capture@(.+)$/i;
export const PRODUCTION_CAPTURE_CORPUS_ROOT = 'tests/external-output-references';
const CLI_BINDING_ID_KINDS = new Set(['flag', 'command', 'option']);
const CAPTURE_BINDING_TYPES = new Set(['structured', 'unstructured', 'cli-behavior']);


/**
 * @param {string} repoRoot
 * @param {string | undefined} manifestPath
 */
function resolveManifestCorpusRoot(repoRoot, manifestPath) {
  const resolved = manifestPath
    ? resolveRepoPath(repoRoot, manifestPath)
    : path.join(repoRoot, PRODUCTION_CAPTURE_CORPUS_ROOT, 'capture-manifest.json');
  const rel = path.relative(repoRoot, resolved).replace(/\\/g, '/');
  if (rel === `${PRODUCTION_CAPTURE_CORPUS_ROOT}/capture-manifest.json`) {
    return PRODUCTION_CAPTURE_CORPUS_ROOT;
  }
  return path.dirname(rel).replace(/\\/g, '/');
}

/**
 * @param {string} bindingId
 */
function bindingIdKind(bindingId) {
  const parts = bindingId.split(':');
  if (parts.length < 3) {
    return null;
  }
  return parts[1].trim().toLowerCase();
}

/**
 * @param {string} bindingId
 */
function bindingIdRequiresCliBehavior(bindingId) {
  const kind = bindingIdKind(bindingId);
  return Boolean(kind && CLI_BINDING_ID_KINDS.has(kind));
}

/**
 * @param {Record<string, string>} block
 */
export function producerEmissionHasExecutableProof(block) {
  const command = (block['proof-command'] ?? block.command ?? '').trim();
  const capture = (block['proof-capture'] ?? block.capture ?? '').trim();
  return Boolean(command || capture);
}

/**
 * @param {Record<string, string>} block
 */
export function producerEmissionIsComplete(block) {
  return Boolean(
    block.producer
    && (block.datum || block.selector)
    && block.expected !== undefined
    && producerEmissionHasExecutableProof(block),
  );
}

function resolveRepoPath(repoRoot, candidate) {
  if (!candidate) {
    return null;
  }
  return path.isAbsolute(candidate) ? candidate : path.join(repoRoot, candidate);
}

const PRODUCER_EMISSION_PATTERN = /```producer-emission\s*\r?\n([\s\S]*?)```/gi;

/**
 * @param {string} markdown
 * @param {RegExp} headingPattern
 * @returns {Array<{ start: number, end: number }>}
 */
function headingSectionSpans(markdown, headingPattern) {
  /** @type {Array<{ start: number, end: number }>} */
  const spans = [];
  const pattern = new RegExp(headingPattern.source, headingPattern.flags.includes('g') ? headingPattern.flags : `${headingPattern.flags}g`);
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    const start = match.index;
    const level = (match[0].match(/^#+/) ?? ['##'])[0].length;
    const rest = markdown.slice(start);
    const nextHeading = rest.slice(match[0].length).search(new RegExp(`^#{1,${level}}\\s+`, 'm'));
    const end = nextHeading >= 0 ? start + match[0].length + nextHeading : markdown.length;
    spans.push({ start, end });
  }
  return spans;
}

/**
 * @param {string} markdown
 */
export function extractAuthoritativeContractEvidenceBody(markdown) {
  const genericFences = [];
  let match;
  const pattern = new RegExp(GENERIC_FENCE_PATTERN.source, GENERIC_FENCE_PATTERN.flags);
  while ((match = pattern.exec(markdown)) !== null) {
    genericFences.push({ start: match.index, end: match.index + match[0].length, kind: match[1].trim() });
  }

  const exampleSpans = headingSectionSpans(markdown, /^#{1,6}\s+example\b/i);
  const candidates = [];
  const contractPattern = new RegExp(FENCE_PATTERN.source, FENCE_PATTERN.flags);
  while ((match = contractPattern.exec(markdown)) !== null) {
    if (match[1].toLowerCase() !== 'contract-evidence') {
      continue;
    }
    const start = match.index;
    const lineStart = markdown.lastIndexOf('\n', start) + 1;
    const linePrefix = markdown.slice(lineStart, start);
    if (/^\s*>/.test(linePrefix)) {
      continue;
    }
    const insideGeneric = genericFences.some(
      (fence) => fence.kind !== 'contract-evidence' && start >= fence.start && start < fence.end,
    );
    if (insideGeneric) {
      continue;
    }
    if (exampleSpans.some((span) => start >= span.start && start < span.end)) {
      continue;
    }
    candidates.push(match[2].trim());
  }
  return candidates[0] ?? null;
}

/**
 * @param {string} body
 */
export function parseContractEvidenceRows(body) {
  if (!body) {
    return { none: false, rows: [], malformed: true };
  }
  if (/^none\s*$/i.test(body.trim())) {
    return { none: true, rows: [], malformed: false };
  }

  /** @type {Array<Record<string, string>>} */
  const rows = [];
  const chunks = body.split(/\n\s*\n+/);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }
    const fields = parseKeyValueBlock(trimmed);
    if (Object.keys(fields).length === 0) {
      return { none: false, rows: [], malformed: true };
    }
    rows.push(fields);
  }
  return { none: false, rows, malformed: rows.length === 0 };
}

/**
 * @param {string} producer
 */
export function canonicalProducer(producer) {
  const normalized = producer.trim().toLowerCase();
  return producerRegistry.aliases?.[normalized] ?? normalized;
}

/**
 * @param {string} selector
 */
function normalizeSelector(selector) {
  return selector.trim().replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1');
}

/**
 * @param {string} token
 */
function normalizeToken(token) {
  return token.trim().toLowerCase();
}

/**
 * @param {string} datum
 * @param {'structured' | 'unstructured'} kind
 * @param {Record<string, string>} row
 */
function normalizeDatumIdentity(datum, kind, row) {
  if (kind === 'structured') {
    return normalizeSelector(row.selector ?? datum);
  }
  return normalizeToken(row.token ?? row.expected ?? datum);
}

/**
 * @param {Record<string, string>} row
 * @param {'structured' | 'unstructured'} kind
 */
export function canonicalBindingIdentity(row, kind) {
  const producer = canonicalProducer(row.producer ?? '');
  if (row['binding-id']) {
    const parts = row['binding-id'].split(':');
    const datum = parts.slice(1).join(':');
    if (datum) {
      return `${producer}:${normalizeDatumIdentity(datum, kind, row)}`;
    }
  }
  const datum = kind === 'structured'
    ? normalizeSelector(row.selector ?? row.datum ?? '')
    : normalizeToken(row.token ?? row.expected ?? row.datum ?? '');
  return `${producer}:${datum}`;
}

/**
 * @param {string} markdown
 */
export function parseProducerEmissionBlocks(markdown) {
  /** @type {Array<Record<string, string>>} */
  const blocks = [];
  let match;
  const pattern = new RegExp(PRODUCER_EMISSION_PATTERN.source, PRODUCER_EMISSION_PATTERN.flags);
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push(parseKeyValueBlock(match[1]));
  }
  return blocks;
}

/**
 * @param {string} markdown
 */
export function acceptanceCriteriaRegion(markdown) {
  const heading = markdown.match(/^#{1,6}\s+acceptance criteria\b/im);
  if (!heading) {
    return null;
  }
  const start = heading.index ?? 0;
  const rest = markdown.slice(start);
  const level = (heading[0].match(/^#+/) ?? ['##'])[0].length;
  const nextHeading = rest.slice(heading[0].length).search(new RegExp(`^#{1,${level}}\\s+`, 'm'));
  return nextHeading >= 0 ? rest.slice(0, heading[0].length + nextHeading) : rest;
}

/**
 * @param {string} markdown
 * @param {number} criterionNumber
 */
export function acceptanceCriterionSection(markdown, criterionNumber) {
  const region = acceptanceCriteriaRegion(markdown);
  if (!region) {
    return null;
  }
  const pattern = new RegExp(`^${criterionNumber}\\.\\s+(.+)$`, 'im');
  const match = region.match(pattern);
  if (!match) {
    return null;
  }
  const start = match.index ?? 0;
  const rest = region.slice(start);
  const next = rest.slice(match[0].length).search(/^\d+\.\s+/m);
  return next >= 0 ? rest.slice(0, match[0].length + next) : rest;
}

/**
 * @param {string} markdown
 * @param {number} criterionNumber
 */

/**
 * @param {Record<string, string>} row
 */
export function extractRowProducerEmissionExpectation(row) {
  const producer = canonicalProducer(row.producer ?? '');
  if (row['binding-id']) {
    const parts = row['binding-id'].split(':');
    if (parts.length >= 3) {
      return {
        producer: canonicalProducer(parts[0]),
        datum: parts.slice(1, -1).join(':') || parts[1],
        expected: parts[parts.length - 1],
      };
    }
    if (parts.length === 2) {
      return {
        producer: canonicalProducer(parts[0]),
        datum: parts[1],
        expected: row.expected ?? '',
      };
    }
  }
  return {
    producer,
    datum: row.datum ?? row.selector ?? '',
    expected: row.expected ?? '',
  };
}

/**
 * @param {Record<string, string>} block
 * @param {Record<string, string>} row
 */
export function producerEmissionMatchesRow(block, row) {
  const want = extractRowProducerEmissionExpectation(row);
  if (!want.producer || !want.datum || want.expected === '') {
    return false;
  }
  const blockProducer = canonicalProducer(block.producer ?? '');
  const blockDatum = normalizeSelector(block.datum ?? block.selector ?? '');
  const wantDatum = normalizeSelector(want.datum);
  return (
    blockProducer === want.producer
    && blockDatum === wantDatum
    && String(block.expected) === String(want.expected)
  );
}

/**
 * @param {Record<string, string>} row
 * @param {{ exitStatus?: number }} [manifestEntry]
 */
export function isCliBehaviorBinding(row) {
  return row['binding-type']?.trim().toLowerCase() === 'cli-behavior';
}

export function criterionHasProducerEmission(markdown, criterionNumber) {
  const section = acceptanceCriterionSection(markdown, criterionNumber);
  if (!section) {
    return false;
  }
  return parseProducerEmissionBlocks(section).some((block) => producerEmissionIsComplete(block));
}

/**
 * @param {string} markdown
 * @param {number} criterionNumber
 * @param {Record<string, string>} row
 */
export function criterionHasMatchingProducerEmission(markdown, criterionNumber, row) {
  const section = acceptanceCriterionSection(markdown, criterionNumber);
  if (!section) {
    return false;
  }
  return parseProducerEmissionBlocks(section).some(
    (block) => producerEmissionIsComplete(block) && producerEmissionMatchesRow(block, row),
  );
}

/**
 * @param {unknown} value
 * @param {string} expected
 */
function valuesEqual(value, expected) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value) === expected;
  }
  return JSON.stringify(value) === expected;
}

/**
 * @param {string} content
 */
function redactCaptureContent(content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  return `<redacted capture sha256:${hash}>`;
}

/**
 * @param {string} markdown
 * @param {{ repoRoot?: string, manifestPath?: string, legacyListPath?: string, draftPath?: string }} [options]
 */
export function checkContractEvidence(markdown, options = {}) {
  const repoRoot = options.repoRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = resolveRepoPath(
    repoRoot,
    options.manifestPath ?? 'tests/external-output-references/capture-manifest.json',
  );
  const legacyListPath = resolveRepoPath(
    repoRoot,
    options.legacyListPath ?? 'scripts/contract-evidence-legacy-drafts.json',
  );
  const draftPath = options.draftPath ?? '';

  /** @type {string[]} */
  const errors = [];

  const legacy = JSON.parse(readFileSync(legacyListPath, 'utf8'));
  const legacyPaths = new Set((legacy.paths ?? []).map((entry) => entry.replace(/\\/g, '/')));
  let normalizedDraft = draftPath.replace(/\\/g, '/');
  if (normalizedDraft && path.isAbsolute(normalizedDraft)) {
    normalizedDraft = path.relative(repoRoot, normalizedDraft).replace(/\\/g, '/');
  }
  const isLegacy = normalizedDraft && legacyPaths.has(normalizedDraft);
  if (isLegacy) {
    return { ok: true, errors: [], skipped: true };
  }

  const body = extractAuthoritativeContractEvidenceBody(markdown);
  if (body === null) {
    errors.push('contract-evidence block is missing from its canonical location');
    return { ok: false, errors, skipped: false };
  }

  const parsed = parseContractEvidenceRows(body);
  if (parsed.malformed) {
    errors.push('contract-evidence entry is malformed or missing required fields');
    return { ok: false, errors, skipped: false };
  }
  if (parsed.none) {
    return { ok: true, errors: [], skipped: false };
  }

  let committedManifest;
  try {
    committedManifest = loadCommittedCaptureManifest(repoRoot, manifestPath ?? '');
  } catch {
    errors.push('capture manifest is missing or unreadable');
    return { ok: false, errors, skipped: false };
  }

  const corpusRoot = resolveManifestCorpusRoot(repoRoot, manifestPath);
  if (committedManifest.corpusRoot !== corpusRoot) {
    errors.push(`capture manifest corpusRoot must be ${corpusRoot}`);
  }
  const regenerated = generateCaptureManifest(repoRoot, { corpusRoot });
  errors.push(...compareCaptureManifests(committedManifest, regenerated));

  /** @type {Map<string, Record<string, string>>} */
  const identities = new Map();

  for (const [index, row] of parsed.rows.entries()) {
    const rowLabel = `contract-evidence row ${index + 1}`;
    const required = ['binding', 'producer', 'evidence'];
    for (const field of required) {
      if (!row[field]) {
        errors.push(`${rowLabel}: missing required field ${field}`);
      }
    }
    if (errors.some((error) => error.startsWith(rowLabel))) {
      continue;
    }

    const producer = canonicalProducer(row.producer);
    const evidence = row.evidence;
    const newMatch = evidence.match(NEW_EVIDENCE_PATTERN);
    const captureMatch = evidence.match(CAPTURE_EVIDENCE_PATTERN);

    if (newMatch && captureMatch) {
      errors.push(`${rowLabel}: evidence must be exactly one of capture@ or NEW(...)`);
      continue;
    }
    if (!newMatch && !captureMatch) {
      errors.push(`${rowLabel}: evidence must be capture@<manifest-id> or NEW(produced-by AC#N)`);
      continue;
    }

    if (newMatch) {
      const acNumber = Number(newMatch[1]);
      const repoOwned = producerRegistry['repo-owned'] ?? producerRegistry.repoOwned ?? [];
      if (producerRegistry.external?.includes(producer)) {
        errors.push(`${rowLabel}: NEW evidence cannot target external producer ${producer}`);
        continue;
      }
      if (!repoOwned.includes(producer)) {
        errors.push(`${rowLabel}: producer ${producer} is not in the repo-owned registry`);
        continue;
      }
      if (!criterionHasMatchingProducerEmission(markdown, acNumber, row)) {
        errors.push(
          `${rowLabel}: NEW(produced-by AC#${acNumber}) must name a matching producer-emission assertion for this binding`,
        );
        continue;
      }
      const identity = canonicalBindingIdentity(row, 'structured');
      const prior = identities.get(identity);
      if (prior && prior.evidence !== evidence) {
        errors.push(`${rowLabel}: conflicting evidence for binding identity ${identity}`);
      } else {
        identities.set(identity, row);
      }
      continue;
    }

    if (!row['binding-id']) {
      errors.push(`${rowLabel}: missing required field binding-id`);
      continue;
    }
    if (!row['binding-type']) {
      errors.push(`${rowLabel}: missing required field binding-type`);
      continue;
    }
    const bindingType = row['binding-type'].trim().toLowerCase();
    if (!CAPTURE_BINDING_TYPES.has(bindingType)) {
      errors.push(`${rowLabel}: binding-type must be structured, unstructured, or cli-behavior`);
      continue;
    }
    const requiresCliBehavior = bindingIdRequiresCliBehavior(row['binding-id']);
    if (requiresCliBehavior && bindingType !== 'cli-behavior') {
      errors.push(`${rowLabel}: binding-id kind ${bindingIdKind(row['binding-id'])} requires binding-type cli-behavior`);
      continue;
    }
    if (bindingType === 'cli-behavior' && !requiresCliBehavior) {
      errors.push(`${rowLabel}: binding-type cli-behavior requires binding-id kind flag, command, or option`);
      continue;
    }

    const manifestId = captureMatch[1].trim();
    const entry = committedManifest.entries?.[manifestId];
    if (!entry) {
      errors.push(`${rowLabel}: manifest entry ${manifestId} does not exist`);
      continue;
    }
    if (!entry.sourceCommand) {
      errors.push(`${rowLabel}: manifest entry ${manifestId} lacks capture-generation source command`);
      continue;
    }
    errors.push(
      ...assertCapturePathConfined(repoRoot, corpusRoot, entry.path).map(
        (message) => `${rowLabel}: ${message}`,
      ),
    );
    if (canonicalProducer(entry.producer) !== producer) {
      errors.push(
        `${rowLabel}: declared producer ${producer} does not match manifest producer ${entry.producer}`,
      );
      continue;
    }

    const referencesRoot = path.join(repoRoot, corpusRoot);
    const capturePath = path.join(referencesRoot, entry.path);
    if (!existsSync(capturePath)) {
      errors.push(`${rowLabel}: capture file ${entry.path} is missing`);
      continue;
    }
    const captureContent = readFileSync(capturePath, 'utf8');
    const actualHash = `sha256:${createHash('sha256').update(captureContent).digest('hex')}`;
    if (actualHash !== entry.contentHash) {
      errors.push(`${rowLabel}: capture hash mismatch for ${entry.path}`);
      continue;
    }

    const parsedKind = detectCaptureKind(captureContent);
    const manifestKind = entry.kind ?? parsedKind;
    if ((manifestKind === 'structured' || parsedKind === 'structured') && bindingType !== 'structured') {
      errors.push(`${rowLabel}: structured capture requires binding-type structured`);
      continue;
    }
    if (manifestKind === 'unstructured' && parsedKind === 'unstructured' && bindingType === 'structured') {
      errors.push(`${rowLabel}: unstructured capture cannot use binding-type structured`);
      continue;
    }
    const isCliBehavior = isCliBehaviorBinding(row);
    if (isCliBehavior) {
      if (entry.exitStatus === undefined) {
        errors.push(`${rowLabel}: CLI behavior binding requires manifest exit status`);
        continue;
      }
      if (Number(entry.exitStatus) !== 0) {
        errors.push(
          `${rowLabel}: CLI behavior evidence requires successful capture (manifest exit status 0), got ${entry.exitStatus}`,
        );
        continue;
      }
      const expectedExit = row['exit-status'] ?? row['expected-exit-status'] ?? '0';
      if (String(expectedExit) !== '0') {
        errors.push(
          `${rowLabel}: CLI behavior binding must assert successful exit status 0, got ${expectedExit}`,
        );
        continue;
      }
    }

    if (manifestKind === 'structured' || parsedKind === 'structured') {
      if (row.token) {
        errors.push(`${rowLabel}: token evidence is not allowed for structured captures`);
        continue;
      }
      if (!row.selector || row.expected === undefined) {
        errors.push(`${rowLabel}: structured capture evidence requires selector and expected`);
        continue;
      }
      let parsedCapture;
      try {
        parsedCapture = JSON.parse(captureContent);
      } catch {
        errors.push(`${rowLabel}: structured capture ${entry.path} is not valid JSON (${redactCaptureContent(captureContent)})`);
        continue;
      }
      const matches = extractAtJsonPath(parsedCapture, row.selector);
      if (matches.length === 0) {
        errors.push(`${rowLabel}: selector ${row.selector} did not resolve in capture (${redactCaptureContent(captureContent)})`);
        continue;
      }
      const matched = matches.some((item) => valuesEqual(item.value, row.expected));
      if (!matched) {
        errors.push(`${rowLabel}: selector ${row.selector} value does not match expected ${row.expected} (${redactCaptureContent(captureContent)})`);
        continue;
      }
      const identity = canonicalBindingIdentity(row, 'structured');
      const prior = identities.get(identity);
      if (prior && prior.evidence !== evidence) {
        errors.push(`${rowLabel}: conflicting evidence for binding identity ${identity}`);
      } else {
        identities.set(identity, row);
      }
      continue;
    }

    if (!row.token) {
      errors.push(`${rowLabel}: unstructured capture evidence requires token`);
      continue;
    }
    if (!captureContent.includes(row.token)) {
      errors.push(`${rowLabel}: token not found in unstructured capture (${redactCaptureContent(captureContent)})`);
      continue;
    }
    const identity = canonicalBindingIdentity(row, 'unstructured');
    const prior = identities.get(identity);
    if (prior && prior.evidence !== evidence) {
      errors.push(`${rowLabel}: conflicting evidence for binding identity ${identity}`);
    } else {
      identities.set(identity, row);
    }
  }

  return { ok: errors.length === 0, errors, skipped: false };
}

/**
 * @param {string} repoRoot
 * @param {string} manifestPath
 */
export function verifyCaptureManifestIntegrity(repoRoot, manifestPath) {
  const committed = loadCommittedCaptureManifest(repoRoot, manifestPath);
  const corpusRoot = resolveManifestCorpusRoot(repoRoot, manifestPath);
  const errors = [];
  if (committed.corpusRoot !== corpusRoot) {
    errors.push(`capture manifest corpusRoot must be ${corpusRoot}`);
  }
  const regenerated = generateCaptureManifest(repoRoot, { corpusRoot });
  errors.push(...compareCaptureManifests(committed, regenerated));
  return { ok: errors.length === 0, errors };
}
