export interface ShapeError {
  fixture: string;
  path: string;
  field: string;
  reason: string;
  variantId?: string;
}

export function runExternalOutputShapeGuard(
  repoRoot: string,
  options?: {
    classification?: Record<string, unknown>;
    catalog?: Map<string, unknown>;
  },
): { ok: boolean; errors: ShapeError[] };

export function validateObjectShape(
  obj: Record<string, unknown>,
  variant: {
    id: string;
    allowedFields: string[];
    forbiddenFields: string[];
    forbiddenTogether: string[][];
  },
  fixtureLabel: string,
  objectPath: string,
  options?: { dynamicMap?: boolean },
): ShapeError[];

export function validateExternalObject(
  obj: Record<string, unknown>,
  command: string,
  variantKey: string,
  catalog: Map<string, unknown>,
  fixtureLabel: string,
  objectPath: string,
): ShapeError[];

export function formatShapeErrors(errors: ShapeError[]): string;

export function loadVariantCatalog(referencesRoot: string): {
  manifest: Record<string, unknown>;
  catalog: Map<string, unknown>;
};

export function extractAtJsonPath(
  root: unknown,
  jsonPath: string,
): Array<{ value: unknown; path: string }>;

export const INLINE_IDENTIFIER_VALUE: unique symbol;

export function findInlineWorkerReports(
  filePath: string,
  sourceText: string,
  optOuts?: Array<{ file: string; line: number; reason: string }>,
): Array<{ line: number; object: Record<string, unknown> }>;
