/**
 * External-tool output fixture shape guard (Issue #223).
 * Vitest: scripts/external-output-shape-guard.test.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {{ id: string, command: string, variant: string, allowedFields: string[], forbiddenFields: string[], forbiddenTogether: string[][], captureRef?: string, provenanceRef?: string }} VariantRef */
/** @typedef {{ fixture: string, path: string, field: string, reason: string, variantId?: string }} ShapeError */

const WORKER_REPORT_SHARED_FORBIDDEN = [
  'headRefOid',
  'head_ref_oid',
  'forHeadSha',
  'for_head_sha',
  'prHeadSha',
  'pr_head_sha',
  'before',
  'after',
  'actor',
];

const WORKER_REPORT_SHARED_ALLOWED = ['source'];

const DYNAMIC_MAP_KEY_SUFFIXES = ['ByPr', 'BySession', 'ByRun'];

/**
 * @param {string} repoRoot
 */
export function defaultReferencesRoot(repoRoot) {
  return path.join(repoRoot, 'tests/external-output-references');
}

/**
 * @param {string} repoRoot
 */
export function defaultClassificationPath(repoRoot) {
  return path.join(defaultReferencesRoot(repoRoot), 'trigger-fixture-classification.json');
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} dir
 */
function resolveVariant(raw, dir) {
  /** @type {Record<string, unknown>} */
  let merged = { ...raw };
  if (raw.extends) {
    const parentPath = path.join(dir, String(raw.extends));
    const parent = JSON.parse(readFileSync(parentPath, 'utf8'));
    merged = {
      ...parent,
      ...raw,
      allowedFields: [
        ...new Set([
          ...toArray(parent.allowedFields),
          ...toArray(raw.allowedFields),
        ]),
      ],
      forbiddenFields: [
        ...new Set([
          ...toArray(parent.forbiddenFields),
          ...toArray(raw.forbiddenFields),
        ]),
      ],
      forbiddenTogether: raw.forbiddenTogether ?? parent.forbiddenTogether ?? [],
    };
    delete merged.extends;
  }

  if (merged.id?.startsWith('ao-worker-report/')) {
    merged.forbiddenFields = [
      ...new Set([...WORKER_REPORT_SHARED_FORBIDDEN, ...toArray(merged.forbiddenFields)]),
    ];
    merged.allowedFields = [
      ...new Set([...WORKER_REPORT_SHARED_ALLOWED, ...toArray(merged.allowedFields)]),
    ];
  }

  if (merged.id?.startsWith('ao-review-run/') && !merged.allowedFields?.length) {
    const sharedPath = path.join(dir, '_shared.json');
    if (existsSync(sharedPath)) {
      const shared = JSON.parse(readFileSync(sharedPath, 'utf8'));
      merged.allowedFields = shared.allowedFields ?? [];
      merged.forbiddenFields = [
        ...new Set([...toArray(shared.forbiddenFields), ...toArray(merged.forbiddenFields)]),
      ];
    }
  }

  return /** @type {VariantRef} */ ({
    id: String(merged.id),
    command: String(merged.command ?? ''),
    variant: String(merged.variant ?? ''),
    allowedFields: toArray(merged.allowedFields).map(String),
    forbiddenFields: toArray(merged.forbiddenFields).map(String),
    forbiddenTogether: toArray(merged.forbiddenTogether).map((group) => toArray(group).map(String)),
    captureRef: merged.captureRef ? String(merged.captureRef) : undefined,
    provenanceRef: merged.provenanceRef ? String(merged.provenanceRef) : undefined,
  });
}

/**
 * @param {unknown} value
 */
export function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * @param {string} referencesRoot
 */
export function loadVariantCatalog(referencesRoot) {
  /** @type {Map<string, VariantRef>} */
  const catalog = new Map();
  const manifestPath = path.join(referencesRoot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const [command, meta] of Object.entries(manifest.commands ?? {})) {
    const variantDir = path.join(referencesRoot, meta.variantDir);
    for (const file of readdirSync(variantDir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      const fullPath = path.join(variantDir, file);
      const raw = JSON.parse(readFileSync(fullPath, 'utf8'));
      const variant = resolveVariant(raw, variantDir);
      catalog.set(variant.id, variant);
      catalog.set(`${command}/${variant.variant}`, variant);
    }
  }
  return { manifest, catalog };
}

/**
 * @param {string} referencesRoot
 * @param {Map<string, VariantRef>} catalog
 */
export function validateReferenceProvenance(referencesRoot, catalog) {
  /** @type {string[]} */
  const errors = [];
  for (const variant of catalog.values()) {
    if (!variant.captureRef || !variant.provenanceRef) continue;
    const capturePath = path.join(referencesRoot, variant.captureRef);
    const provenancePath = path.join(referencesRoot, variant.provenanceRef);
    if (!existsSync(capturePath)) {
      errors.push(`missing capture for ${variant.id}: ${variant.captureRef}`);
    }
    if (!existsSync(provenancePath)) {
      errors.push(`missing provenance for ${variant.id}: ${variant.provenanceRef}`);
    }
  }
  return errors;
}

/**
 * @param {string} command
 * @param {string} variantKey
 * @param {Map<string, VariantRef>} catalog
 */
export function resolveVariantRef(command, variantKey, catalog) {
  const id = `${command}/${variantKey}`;
  return catalog.get(id) ?? catalog.get(variantKey) ?? null;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {VariantRef} variant
 * @param {string} fixtureLabel
 * @param {string} objectPath
 * @param {{ dynamicMap?: boolean }} [options]
 * @returns {ShapeError[]}
 */
export function validateObjectShape(obj, variant, fixtureLabel, objectPath, options = {}) {
  /** @type {ShapeError[]} */
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return errors;
  }

  const allowed = new Set(variant.allowedFields);
  const forbidden = new Set(variant.forbiddenFields);

  for (const key of Object.keys(obj)) {
    if (options.dynamicMap) {
      continue;
    }
    if (forbidden.has(key)) {
      errors.push({
        fixture: fixtureLabel,
        path: `${objectPath}.${key}`,
        field: key,
        reason: 'forbidden phantom field',
        variantId: variant.id,
      });
      continue;
    }
    if (!allowed.has(key)) {
      errors.push({
        fixture: fixtureLabel,
        path: `${objectPath}.${key}`,
        field: key,
        reason: 'field not in variant reference',
        variantId: variant.id,
      });
    }
  }

  for (const group of variant.forbiddenTogether ?? []) {
    if (group.length < 2) continue;
    if (group.every((field) => Object.prototype.hasOwnProperty.call(obj, field))) {
      errors.push({
        fixture: fixtureLabel,
        path: objectPath,
        field: group.join(' + '),
        reason: 'impossible field combination for variant',
        variantId: variant.id,
      });
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    const childPath = `${objectPath}.${key}`;
    if (isDynamicMapKey(key)) {
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          value.forEach((item, index) => {
            errors.push(
              ...scanNestedPhantomFields(
                item,
                forbidden,
                fixtureLabel,
                `${childPath}[${index}]`,
                variant.id,
              ),
            );
          });
        } else {
          for (const [mapKey, mapValue] of Object.entries(value)) {
            errors.push(
              ...scanNestedPhantomFields(
                mapValue,
                forbidden,
                fixtureLabel,
                `${childPath}[${mapKey}]`,
                variant.id,
              ),
            );
          }
        }
      }
      continue;
    }
    errors.push(
      ...scanNestedPhantomFields(value, forbidden, fixtureLabel, childPath, variant.id),
    );
  }

  return errors;
}

/**
 * @param {string} key
 */
function isDynamicMapKey(key) {
  return DYNAMIC_MAP_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/**
 * Recursively detect forbidden / unknown fields below the validated object.
 *
 * @param {unknown} value
 * @param {Set<string>} forbidden
 * @param {string} fixtureLabel
 * @param {string} objectPath
 * @param {string} variantId
 */
function scanNestedPhantomFields(value, forbidden, fixtureLabel, objectPath, variantId) {
  /** @type {ShapeError[]} */
  const errors = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      errors.push(
        ...scanNestedPhantomFields(item, forbidden, fixtureLabel, `${objectPath}[${index}]`, variantId),
      );
    });
    return errors;
  }
  if (!value || typeof value !== 'object') {
    return errors;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${objectPath}.${key}`;
    if (forbidden.has(key)) {
      errors.push({
        fixture: fixtureLabel,
        path: childPath,
        field: key,
        reason: 'forbidden phantom field (nested)',
        variantId,
      });
    }
    errors.push(...scanNestedPhantomFields(child, forbidden, fixtureLabel, childPath, variantId));
  }
  return errors;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} command
 * @param {string} variantKey
 * @param {Map<string, VariantRef>} catalog
 * @param {string} fixtureLabel
 * @param {string} objectPath
 */
export function validateExternalObject(obj, command, variantKey, catalog, fixtureLabel, objectPath) {
  const variant = resolveVariantRef(command, variantKey, catalog);
  if (!variant) {
    return [
      {
        fixture: fixtureLabel,
        path: objectPath,
        field: variantKey,
        reason: `unknown variant for command ${command}`,
      },
    ];
  }
  return validateObjectShape(obj, variant, fixtureLabel, objectPath);
}

/**
 * @param {unknown} root
 * @param {string} jsonPath
 */
export function extractAtJsonPath(root, jsonPath) {
  const segments = jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean);
  /** @type {Array<{ value: unknown, path: string }>} */
  let current = [{ value: root, path: '$' }];

  for (const segment of segments) {
    const match = segment.match(/^(.+)\[(\*|\d+)\]$/);
    if (match) {
      const [, key, indexToken] = match;
      /** @type {Array<{ value: unknown, path: string }>} */
      const next = [];
      for (const item of current) {
        const base = getChild(item.value, key);
        if (indexToken === '*') {
          const arr = toArray(base);
          arr.forEach((entry, index) => {
            next.push({ value: entry, path: `${item.path}.${key}[${index}]` });
          });
        } else {
          const arr = toArray(base);
          const index = Number(indexToken);
          if (arr[index] != null) {
            next.push({ value: arr[index], path: `${item.path}.${key}[${index}]` });
          }
        }
      }
      current = next;
      continue;
    }

    /** @type {Array<{ value: unknown, path: string }>} */
    const next = [];
    for (const item of current) {
      const child = getChild(item.value, segment);
      if (child !== undefined) {
        next.push({ value: child, path: `${item.path}.${segment}` });
      }
    }
    current = next;
  }

  return current;
}

/**
 * @param {unknown} value
 * @param {string} key
 */
function getChild(value, key) {
  if (value == null || typeof value !== 'object') return undefined;
  return /** @type {Record<string, unknown>} */ (value)[key];
}

/**
 * @param {string} repoRoot
 * @param {string} glob
 */
export function expandFixtureGlob(repoRoot, glob) {
  const normalized = glob.replace(/\\/g, '/');
  const starIndex = normalized.indexOf('*');
  if (starIndex < 0) {
    const full = path.join(repoRoot, normalized);
    return existsSync(full) ? [full] : [];
  }
  const base = path.join(repoRoot, normalized.slice(0, starIndex).replace(/\/$/, ''));
  if (!existsSync(base)) return [];
  const suffix = normalized.slice(starIndex + 1).replace(/^\//, '');
  /** @type {string[]} */
  const results = [];
  for (const entry of readdirSync(base)) {
    const full = path.join(base, entry);
    if (!statSync(full).isFile()) continue;
    if (suffix && !entry.endsWith(suffix.replace(/^\*/, ''))) continue;
    if (entry.endsWith('.json')) {
      results.push(full);
    }
  }
  return results.sort();
}

/**
 * @param {string} filePath
 * @param {{ command: string, variant?: string, variantFrom?: string, jsonPath: string }} shape
 * @param {Map<string, VariantRef>} catalog
 */
export function validateFixtureFileShapes(filePath, shape, catalog) {
  const payload = JSON.parse(readFileSync(filePath, 'utf8'));
  const label = path.basename(filePath);
  /** @type {ShapeError[]} */
  const errors = [];
  for (const { value, path: objectPath } of extractAtJsonPath(payload, shape.jsonPath)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = /** @type {Record<string, unknown>} */ (value);
    const variantKey = shape.variantFrom
      ? String(record[shape.variantFrom] ?? '')
      : String(shape.variant ?? '');
    if (!variantKey) {
      errors.push({
        fixture: label,
        path: objectPath,
        field: shape.variantFrom ?? 'variant',
        reason: 'missing variant selector value',
      });
      continue;
    }
    errors.push(
      ...validateExternalObject(record, shape.command, variantKey, catalog, label, objectPath),
    );
  }
  return errors;
}

/**
 * @param {string} source
 * @param {number} openBraceIdx
 */
function extractBalancedObject(source, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIdx, i + 1);
      }
    }
  }
  return null;
}

/**
 * @param {string} snippet
 */
/** Marker for object-literal properties whose value is a variable reference, not a literal. */
export const INLINE_IDENTIFIER_VALUE = Symbol('inline-identifier-value');

function parseObjectLiteralSnippet(snippet) {
  /** @type {Record<string, unknown>} */
  const obj = {};
  const body = snippet.slice(1, -1);
  const propPattern =
    /([A-Za-z_][\w]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|(true|false)|(-?\d+(?:\.\d+)?)|(\{[\s\S]*?\})|([A-Za-z_$][\w$]*))/g;
  let match;
  while ((match = propPattern.exec(body)) !== null) {
    const key = match[1];
    if (match[2] !== undefined) obj[key] = match[2];
    else if (match[3] !== undefined) obj[key] = match[3];
    else if (match[4] !== undefined) obj[key] = match[4] === 'true';
    else if (match[5] !== undefined) obj[key] = Number(match[5]);
    else if (match[6] !== undefined) obj[key] = parseObjectLiteralSnippet(match[6]);
    else if (match[7] !== undefined) obj[key] = INLINE_IDENTIFIER_VALUE;
  }
  return obj;
}

/**
 * @param {string} filePath
 * @param {string} sourceText
 * @param {Array<{ file: string, line: number, reason: string }>} optOuts
 */
export function findInlineWorkerReports(filePath, sourceText, optOuts = []) {
  const rel = filePath.replace(/\\/g, '/');
  const optOutLines = new Set(
    optOuts.filter((o) => rel.endsWith(o.file.replace(/\\/g, '/'))).map((o) => o.line),
  );
  /** @type {Array<{ line: number, object: Record<string, unknown> }>} */
  const results = [];
  const reportStatePattern = /reportState\s*:\s*['"][^'"]+['"]/g;
  let match;
  while ((match = reportStatePattern.exec(sourceText)) !== null) {
    const line = sourceText.slice(0, match.index).split('\n').length;
    if (optOutLines.has(line)) {
      continue;
    }
    let openBrace = sourceText.lastIndexOf('{', match.index);
    while (openBrace >= 0) {
      const snippet = extractBalancedObject(sourceText, openBrace);
      if (snippet && snippet.includes('reportState')) {
        results.push({ line, object: parseObjectLiteralSnippet(snippet) });
        break;
      }
      openBrace = sourceText.lastIndexOf('{', openBrace - 1);
    }
  }
  return results;
}

/**
 * @param {string} repoRoot
 * @param {{ classification?: Record<string, unknown>, catalog?: Map<string, VariantRef> }} [options]
 */
export function runExternalOutputShapeGuard(repoRoot, options = {}) {
  const referencesRoot = defaultReferencesRoot(repoRoot);
  const { catalog } = options.catalog
    ? { catalog: options.catalog }
    : loadVariantCatalog(referencesRoot);
  const classificationPath = defaultClassificationPath(repoRoot);
  const classification = options.classification ?? JSON.parse(readFileSync(classificationPath, 'utf8'));

  /** @type {ShapeError[]} */
  const errors = [];
  errors.push(...validateReferenceProvenance(referencesRoot, catalog).map((message) => ({
    fixture: 'references',
    path: referencesRoot,
    field: '',
    reason: message,
  })));

  for (const root of toArray(classification.fixtureRoots)) {
    const files = expandFixtureGlob(repoRoot, String(root.glob));
    for (const filePath of files) {
      for (const shape of toArray(root.shapes)) {
        errors.push(
          ...validateFixtureFileShapes(
            filePath,
            /** @type {{ command: string, variant?: string, variantFrom?: string, jsonPath: string }} */ (
              shape
            ),
            catalog,
          ),
        );
      }
    }
  }

  const optOuts = toArray(classification.inlineOptOuts);
  for (const suite of toArray(classification.triggerTestSuites)) {
    const suitePath = path.join(repoRoot, String(suite));
    if (!existsSync(suitePath)) {
      errors.push({
        fixture: String(suite),
        path: suitePath,
        field: '',
        reason: 'missing trigger test suite file',
      });
      continue;
    }
    const sourceText = readFileSync(suitePath, 'utf8');
    const inlineReports = findInlineWorkerReports(suitePath, sourceText, optOuts);
    const relSuite = path.relative(repoRoot, suitePath).replace(/\\/g, '/');
    for (const { line, object } of inlineReports) {
      const variantKey = String(object.reportState ?? '');
      const label = `${relSuite}:${line}`;
      errors.push(
        ...validateExternalObject(
          object,
          'ao-worker-report',
          variantKey,
          catalog,
          label,
          '$',
        ),
      );
    }
  }

  const inventoryPath = path.join(referencesRoot, 'inventory.json');
  if (existsSync(inventoryPath)) {
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    for (const entry of toArray(inventory.entries)) {
      if (!entry.glob || !entry.owner || !entry.followUp) {
        errors.push({
          fixture: 'inventory.json',
          path: String(entry.glob ?? ''),
          field: '',
          reason: 'inventory entry missing owner or followUp',
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {ShapeError[]} errors
 */
export function formatShapeErrors(errors) {
  return errors
    .map((error) => {
      const variant = error.variantId ? ` [${error.variantId}]` : '';
      const field = error.field ? ` field=${error.field}` : '';
      return `${error.fixture} @ ${error.path}${field}${variant}: ${error.reason}`;
    })
    .join('\n');
}

function isCliMain() {
  const entry = process.argv[1];
  return entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isCliMain()) {
  const repoRoot = process.argv.includes('--repo-root')
    ? path.resolve(process.argv[process.argv.indexOf('--repo-root') + 1])
    : path.join(__dirname, '..');
  const result = runExternalOutputShapeGuard(repoRoot);
  if (!result.ok) {
    console.error(formatShapeErrors(result.errors));
    process.exit(1);
  }
  console.log('[PASS] external-output shape guard (Issue #223)');
}
