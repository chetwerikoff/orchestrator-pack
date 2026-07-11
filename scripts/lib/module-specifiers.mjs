const STATIC_MODULE_IMPORT_RE =
  /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_MODULE_IMPORT_LITERAL_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const FROM_CLAUSE_IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const UNESTABLISHABLE_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(?![\s]*['"])/m;
const UNESTABLISHABLE_DYNAMIC_IMPORT_TEMPLATE_RE = /\bimport\s*\(\s*`/m;

export function collectLocalModuleSpecifiers(content) {
  const specifiers = [];
  let establishable = !UNESTABLISHABLE_DYNAMIC_IMPORT_RE.test(content)
    && !UNESTABLISHABLE_DYNAMIC_IMPORT_TEMPLATE_RE.test(content);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('`')) {
      continue;
    }

    STATIC_MODULE_IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = STATIC_MODULE_IMPORT_RE.exec(line)) !== null) {
      const specifier = match[1] ?? match[2];
      if (specifier) {
        specifiers.push(specifier);
      }
    }

    DYNAMIC_MODULE_IMPORT_LITERAL_RE.lastIndex = 0;
    while ((match = DYNAMIC_MODULE_IMPORT_LITERAL_RE.exec(line)) !== null) {
      const specifier = match[1];
      if (specifier) {
        specifiers.push(specifier);
      }
    }

    FROM_CLAUSE_IMPORT_RE.lastIndex = 0;
    while ((match = FROM_CLAUSE_IMPORT_RE.exec(line)) !== null) {
      const specifier = match[1];
      if (specifier) {
        specifiers.push(specifier);
      }
    }
  }

  return { specifiers, establishable };
}
