import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractAtJsonPath,
  formatShapeErrors,
  loadVariantCatalog,
  runExternalOutputShapeGuard,
  validateExternalObject,
  validateObjectShape,
} from './external-output-shape-guard.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const referencesRoot = path.join(repoRoot, 'tests/external-output-references');
const guardFixturesDir = path.join(repoRoot, 'tests/fixtures/external-output-shape-guard');
type VariantShape = {
  id: string;
  allowedFields: string[];
  forbiddenFields: string[];
  forbiddenTogether: string[][];
};

const { catalog } = loadVariantCatalog(referencesRoot);

function getVariant(id: string): VariantShape {
  return catalog.get(id) as VariantShape;
}

function loadGuardFixture(name: string) {
  return JSON.parse(readFileSync(path.join(guardFixturesDir, name), 'utf8'));
}

describe('validateObjectShape', () => {
  it('rejects phantom headRefOid on a worker report with fixture+path', () => {
    const variant = getVariant('ao-worker-report/ready_for_review');
    const errors = validateObjectShape(
      loadGuardFixture('phantom-headRefOid-on-report.json').report,
      variant,
      'phantom-headRefOid-on-report.json',
      '$.report',
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(formatShapeErrors(errors)).toMatch(/headRefOid/);
    expect(formatShapeErrors(errors)).toMatch(/phantom-headRefOid-on-report\.json/);
  });

  it('accepts variant-valid ready_for_review fields', () => {
    const variant = getVariant('ao-worker-report/ready_for_review');
    const errors = validateObjectShape(
      loadGuardFixture('valid-ready-for-review.json').report,
      variant,
      'valid-ready-for-review.json',
      '$.report',
    );
    expect(errors).toEqual([]);
  });

  it('rejects impossible cross-state field combination on completed variant', () => {
    const variant = getVariant('ao-worker-report/completed');
    const errors = validateObjectShape(
      loadGuardFixture('cross-state-impossible-combo.json').report,
      variant,
      'cross-state-impossible-combo.json',
      '$.report',
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(formatShapeErrors(errors)).toMatch(/prUrl|prNumber|impossible|variant reference/);
  });

  it('detects nested phantom fields', () => {
    const variant = getVariant('ao-worker-report/ready_for_review');
    const errors = validateObjectShape(
      loadGuardFixture('nested-phantom-field.json').report,
      variant,
      'nested-phantom-field.json',
      '$.report',
    );
    expect(formatShapeErrors(errors)).toMatch(/nested/);
    expect(formatShapeErrors(errors)).toMatch(/headRefOid/);
  });
});

describe('dynamic-key maps', () => {
  it('does not treat ciChecksByPr keys as schema fields', () => {
    const payload = loadGuardFixture('dynamic-key-map.json');
    const result = runExternalOutputShapeGuard(repoRoot);
    const dynamicErrors = result.errors.filter((error: { path: string }) =>
      String(error.path).includes('ciChecksByPr."'),
    );
    expect(dynamicErrors).toEqual([]);
    const extracted = extractAtJsonPath(payload, '$.ciChecksByPr');
    expect(extracted).toHaveLength(1);
  });
});

describe('runExternalOutputShapeGuard', () => {
  it('passes on anchored trigger fixtures and inline opt-outs', () => {
    const result = runExternalOutputShapeGuard(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails on unclassified phantom inline report literals', () => {
    const classification = JSON.parse(
      readFileSync(path.join(referencesRoot, 'trigger-fixture-classification.json'), 'utf8'),
    );
    const brokenClassification = {
      ...classification,
      inlineOptOuts: [],
    };
    const result = runExternalOutputShapeGuard(repoRoot, {
      classification: brokenClassification,
      catalog,
    });
    expect(result.ok).toBe(false);
    expect(formatShapeErrors(result.errors)).toMatch(/review-head-ready\.test\.ts:107/);
    expect(formatShapeErrors(result.errors)).toMatch(/headRefOid/);
  });
});

describe('validateExternalObject', () => {
  it('resolves gh-pr-open variant and allows headRefOid on PR rows', () => {
    const errors = validateExternalObject(
      { number: 1, headRefOid: 'abc' },
      'gh-pr-open',
      'open',
      catalog,
      'inline',
      '$',
    );
    expect(errors).toEqual([]);
  });
});
