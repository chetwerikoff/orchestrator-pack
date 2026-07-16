from __future__ import annotations

import json
from pathlib import Path

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8', newline='')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def replace_block(text: str, start_marker: str, end_marker: str, new_block: str, label: str) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f'{label}: start marker missing')
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f'{label}: end marker missing')
    return text[:start] + new_block.rstrip() + '\n\n' + text[end:]


path = 'scripts/gate-runner/census-generator.ts'
s = read(path)
s = replace_once(s, "import type { CensusSourceKind } from './census.ts';", "import type { CensusClassification, CensusSourceKind, PortedWave } from './census.ts';", 'generator imports')
s = replace_once(s, "  readonly marker: string;\n}", "  readonly marker: string;\n  readonly classification?: CensusClassification;\n  readonly gateIds?: readonly string[];\n  readonly portedInWave?: PortedWave;\n}", 'generator entry ownership fields')
s = replace_once(s, "  readonly populationDigest: string;\n  readonly entries: readonly CensusPopulationEntry[];", "  readonly populationDigest: string;\n  readonly migrationOwnershipDigest: string;\n  readonly entries: readonly CensusPopulationEntry[];", 'generator result ownership digest')
old_population = """export function populationDigest(entries: readonly CensusPopulationEntry[]): string {
  const payload = entries
    .map(({ id, sourceKind, sourcePath, marker }) => ({ id, sourceKind, sourcePath, marker }))
    .sort((left, right) => compareOrdinal(left.id, right.id))
    .map((entry) => JSON.stringify(entry))
    .join('\\n');
  return sha256(`${payload}\\n`);
}
"""
new_population = old_population + """
export function migrationOwnershipDigest(entries: readonly CensusPopulationEntry[]): string {
  const payload = entries
    .map(({ id, classification, gateIds, portedInWave }) => ({
      id,
      classification: classification ?? null,
      gateIds: [...(gateIds ?? [])].sort(compareOrdinal),
      portedInWave: portedInWave ?? null,
    }))
    .sort((left, right) => compareOrdinal(left.id, right.id))
    .map((entry) => JSON.stringify(entry))
    .join('\\n');
  return sha256(`${payload}\\n`);
}
"""
s = replace_once(s, old_population, new_population, 'generator ownership digest function')
s = replace_once(s, "    populationDigest: populationDigest(entries),\n    entries,", "    populationDigest: populationDigest(entries),\n    migrationOwnershipDigest: migrationOwnershipDigest(entries),\n    entries,", 'generator ownership digest result')
write(path, s)

path = 'scripts/gate-runner/census-generator.test.ts'
s = read(path)
s = replace_once(s, "import { generatePrechangePopulation, populationDigest } from './census-generator.ts';", "import { generatePrechangePopulation, migrationOwnershipDigest, populationDigest } from './census-generator.ts';", 'generator test import')
s = replace_once(s, "    expect(census.generation.populationDigest).toMatch(/^[0-9a-f]{64}$/u);\n    expect(populationDigest(census.entries)).toBe(census.generation.populationDigest);", "    expect(census.generation.populationDigest).toMatch(/^[0-9a-f]{64}$/u);\n    expect(populationDigest(census.entries)).toBe(census.generation.populationDigest);\n    expect(census.generation.migrationOwnershipDigest).toMatch(/^[0-9a-f]{64}$/u);\n    expect(migrationOwnershipDigest(census.entries)).toBe(census.generation.migrationOwnershipDigest);", 'generator test ownership assertion')
write(path, s)

path = 'scripts/gate-runner/custom/bulk-static-gates.ts'
s = read(path)
s = replace_once(s, 'const VERIFY_CONTRACT_MARKERS: Readonly<Record<string, readonly string[]>> = {', 'export const VERIFY_CONTRACT_MARKERS: Readonly<Record<string, readonly string[]>> = {', 'export contract markers')
s = replace_once(s, "};\n\nexport function evaluateVerifyStructureContract(snapshot: SourceSnapshot): GateResult {", "};\n\nexport const VERIFY_PROMPT_GLOB = 'prompts/*.md';\n\nfunction matchesVerifyPromptGlob(path: string): boolean {\n  const [prefix, suffix = ''] = VERIFY_PROMPT_GLOB.split('*', 2);\n  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;\n  return !path.slice(prefix.length, path.length - suffix.length).includes('/');\n}\n\nexport function evaluateVerifyStructureContract(snapshot: SourceSnapshot): GateResult {", 'prompt glob rule')
s = replace_once(s, "  const promptFiles = snapshot.paths.filter((path) => /^prompts\\/[^/]+\\.md$/u.test(path));", '  const promptFiles = snapshot.paths.filter(matchesVerifyPromptGlob);', 'prompt glob evaluator binding')
write(path, s)

path = 'scripts/gate-runner/census.ts'
s = read(path)
s = replace_once(s, "import { populationDigest } from './census-generator.ts';\nimport type { SourceSnapshot } from './source-snapshot.ts';", "import { migrationOwnershipDigest, populationDigest } from './census-generator.ts';\nimport { VERIFY_REQUIRED_FILES } from './bulk-declarative-gates.ts';\nimport { VERIFY_CONTRACT_MARKERS, VERIFY_PROMPT_GLOB } from './custom/bulk-static-gates.ts';\nimport {\n  WAVE_3B_MIGRATION_INVENTORY_PATH,\n  parseWave3bMigrationInventory,\n  validateWave3bMigrationInventory,\n} from './wave-3b-migration-inventory.ts';\nimport type { SourceSnapshot } from './source-snapshot.ts';", 'census imports')
s = replace_once(s, "  readonly migrationIssue?: 841;\n  readonly baseCommitSha: string;", "  readonly migrationIssue?: 841;\n  readonly migrationInventoryPath?: typeof WAVE_3B_MIGRATION_INVENTORY_PATH;\n  readonly baseCommitSha: string;", 'census inventory path field')
s = replace_once(s, "    readonly populationDigest: string;\n  };", "    readonly populationDigest: string;\n    readonly migrationOwnershipDigest: string;\n  };", 'census generation ownership field')
s = replace_once(s, "const EXPECTED_BASE_COMMIT = 'b7394065b9ee1b046abb4cf29aff456df1935571';", "const EXPECTED_BASE_COMMIT = 'b7394065b9ee1b046abb4cf29aff456df1935571';\nconst EXPECTED_MIGRATION_OWNERSHIP_DIGEST = 'e72c1eb63da367470283a8f3f684f9b03f2eccd90fb68ddb40da337cc261f9f1';", 'census expected ownership digest')
new_call_block = r'''interface ParsedCall {
  readonly name: string;
  readonly arguments: readonly string[];
  readonly start: number;
  readonly end: number;
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_$]/u.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/u.test(character);
}

function skipLineComment(text: string, start: number): number {
  const end = text.indexOf('\n', start + 2);
  return end < 0 ? text.length : end + 1;
}

function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2);
  return end < 0 ? text.length : end + 2;
}

function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

function skipTrivia(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (/\s/u.test(text[index] ?? '')) {
      index += 1;
      continue;
    }
    if (text.startsWith('//', index)) {
      index = skipLineComment(text, index);
      continue;
    }
    if (text.startsWith('/*', index)) {
      index = skipBlockComment(text, index);
      continue;
    }
    break;
  }
  return index;
}

function matchingDelimiter(text: string, start: number): number {
  const opening = text[start];
  const closingByOpening: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
  const closing = opening ? closingByOpening[opening] : undefined;
  if (!closing) return -1;
  const stack = [closing];
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = skipQuoted(text, index);
      continue;
    }
    if (text.startsWith('//', index)) {
      index = skipLineComment(text, index);
      continue;
    }
    if (text.startsWith('/*', index)) {
      index = skipBlockComment(text, index);
      continue;
    }
    const nestedClosing = character ? closingByOpening[character] : undefined;
    if (nestedClosing) {
      stack.push(nestedClosing);
      index += 1;
      continue;
    }
    if (character === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function splitTopLevel(text: string, separator = ','): string[] {
  const values: string[] = [];
  let start = 0;
  let index = 0;
  const closingByOpening: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = skipQuoted(text, index);
      continue;
    }
    if (text.startsWith('//', index)) {
      index = skipLineComment(text, index);
      continue;
    }
    if (text.startsWith('/*', index)) {
      index = skipBlockComment(text, index);
      continue;
    }
    const closing = character ? closingByOpening[character] : undefined;
    if (closing) {
      stack.push(closing);
      index += 1;
      continue;
    }
    if (character === stack.at(-1)) {
      stack.pop();
      index += 1;
      continue;
    }
    if (character === separator && stack.length === 0) {
      values.push(text.slice(start, index).trim());
      start = index + 1;
    }
    index += 1;
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0 || values.length > 0) values.push(tail);
  return values;
}

function topLevelSeparator(text: string, separator: string): number {
  let index = 0;
  const closingByOpening: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = skipQuoted(text, index);
      continue;
    }
    if (text.startsWith('//', index)) {
      index = skipLineComment(text, index);
      continue;
    }
    if (text.startsWith('/*', index)) {
      index = skipBlockComment(text, index);
      continue;
    }
    const closing = character ? closingByOpening[character] : undefined;
    if (closing) {
      stack.push(closing);
      index += 1;
      continue;
    }
    if (character === stack.at(-1)) {
      stack.pop();
      index += 1;
      continue;
    }
    if (character === separator && stack.length === 0) return index;
    index += 1;
  }
  return -1;
}

function parseCalls(text: string, acceptedNames: ReadonlySet<string>): ParsedCall[] {
  const calls: ParsedCall[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = skipQuoted(text, index);
      continue;
    }
    if (text.startsWith('//', index)) {
      index = skipLineComment(text, index);
      continue;
    }
    if (text.startsWith('/*', index)) {
      index = skipBlockComment(text, index);
      continue;
    }
    if (!isIdentifierStart(character)) {
      index += 1;
      continue;
    }
    const nameStart = index;
    index += 1;
    while (isIdentifierPart(text[index])) index += 1;
    const name = text.slice(nameStart, index);
    if (!acceptedNames.has(name)) continue;
    const opening = skipTrivia(text, index);
    if (text[opening] !== '(') continue;
    const closing = matchingDelimiter(text, opening);
    if (closing < 0) continue;
    calls.push({ name, arguments: splitTopLevel(text.slice(opening + 1, closing)), start: nameStart, end: closing + 1 });
    index = closing + 1;
  }
  return calls;
}

function parseStringLiteral(expression: string): string | undefined {
  const trimmed = expression.trim();
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return undefined;
  let value = '';
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index];
    if (character !== '\\') {
      value += character;
      continue;
    }
    index += 1;
    const escaped = trimmed[index];
    if (escaped === undefined) return undefined;
    switch (escaped) {
      case 'n': value += '\n'; break;
      case 'r': value += '\r'; break;
      case 't': value += '\t'; break;
      case 'b': value += '\b'; break;
      case 'f': value += '\f'; break;
      case 'v': value += '\v'; break;
      default: value += escaped; break;
    }
  }
  return value;
}

function unwrapDelimited(expression: string, opening: string, closing: string): string | undefined {
  const trimmed = expression.trim();
  if (trimmed[0] !== opening) return undefined;
  const end = matchingDelimiter(trimmed, 0);
  if (end !== trimmed.length - 1 || trimmed[end] !== closing) return undefined;
  return trimmed.slice(1, end);
}

function parseCallExpression(expression: string, acceptedNames: ReadonlySet<string>): ParsedCall | undefined {
  const trimmed = expression.trim();
  let index = 0;
  let finalName: string | undefined;
  while (index < trimmed.length) {
    if (!isIdentifierStart(trimmed[index])) return undefined;
    const start = index;
    index += 1;
    while (isIdentifierPart(trimmed[index])) index += 1;
    finalName = trimmed.slice(start, index);
    index = skipTrivia(trimmed, index);
    if (trimmed[index] !== '.') break;
    index = skipTrivia(trimmed, index + 1);
  }
  if (!finalName || !acceptedNames.has(finalName) || trimmed[index] !== '(') return undefined;
  const closing = matchingDelimiter(trimmed, index);
  if (closing < 0 || skipTrivia(trimmed, closing + 1) !== trimmed.length) return undefined;
  return { name: finalName, arguments: splitTopLevel(trimmed.slice(index + 1, closing)), start: 0, end: trimmed.length };
}

function parseArrayExpression(expression: string): readonly string[] | undefined {
  const contents = unwrapDelimited(expression, '[', ']');
  return contents === undefined ? undefined : splitTopLevel(contents);
}

function parseObjectExpression(expression: string): ReadonlyMap<string, string> | undefined {
  const contents = unwrapDelimited(expression, '{', '}');
  if (contents === undefined) return undefined;
  const properties = new Map<string, string>();
  for (const property of splitTopLevel(contents)) {
    if (property.startsWith('...')) continue;
    const colon = topLevelSeparator(property, ':');
    if (colon < 0) continue;
    const rawName = property.slice(0, colon).trim();
    const name = parseStringLiteral(rawName) ?? (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(rawName) ? rawName : undefined);
    if (name) properties.set(name, property.slice(colon + 1).trim());
  }
  return properties;
}

function normalizedRelativeLiteral(expression: string): string | undefined {
  const literal = parseStringLiteral(expression);
  if (literal === undefined) return undefined;
  const normalized = literal.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) || normalized.split('/').includes('..')) {
    return undefined;
  }
  return normalized;
}

function isRepositoryRootExpression(expression: string): boolean {
  const trimmed = expression.trim();
  return trimmed === 'repoRoot' || trimmed === 'root';
}

function pathExpressionTargets(expression: string, target: string): boolean {
  const literal = normalizedRelativeLiteral(expression);
  if (literal !== undefined) return literal === target;
  const call = parseCallExpression(expression, new Set(['join', 'resolve']));
  if (!call || call.arguments.length < 2 || !isRepositoryRootExpression(call.arguments[0] ?? '')) return false;
  const suffix: string[] = [];
  for (const argument of call.arguments.slice(1)) {
    const segment = normalizedRelativeLiteral(argument);
    if (segment === undefined) return false;
    suffix.push(segment.replace(/^\/+|\/+$/gu, ''));
  }
  return suffix.join('/') === target;
}

function invocationTargets(call: ParsedCall, target: string): boolean {
  let executable: string | undefined;
  let argv: readonly string[] | undefined;
  if (call.name === 'spawnSync' || call.name === 'execFileSync') {
    executable = call.arguments[0] ? parseStringLiteral(call.arguments[0])?.toLocaleLowerCase() : undefined;
    argv = call.arguments[1] ? parseArrayExpression(call.arguments[1]) : undefined;
  } else if (call.name === 'runProcessSync' && call.arguments[0]) {
    const options = parseObjectExpression(call.arguments[0]);
    const command = options?.get('command');
    const args = options?.get('args');
    executable = command ? parseStringLiteral(command)?.toLocaleLowerCase() : undefined;
    argv = args ? parseArrayExpression(args) : undefined;
  }
  if ((executable !== 'pwsh' && executable !== 'pwsh.exe') || !argv) return false;
  for (let index = 0; index < argv.length - 1; index += 1) {
    const flag = argv[index];
    const candidate = argv[index + 1];
    if (!flag || !candidate || flag.trim().startsWith('...') || candidate.trim().startsWith('...')) continue;
    if (parseStringLiteral(flag)?.toLocaleLowerCase() !== '-file') continue;
    if (pathExpressionTargets(candidate, target)) return true;
  }
  return false;
}

function assignedIdentifier(text: string, call: ParsedCall): string | undefined {
  const lineStart = text.lastIndexOf('\n', call.start - 1) + 1;
  const prefix = text.slice(lineStart, call.start);
  return /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$/u.exec(prefix)?.[1];
}

function statusIsAsserted(text: string, identifier: string): boolean {
  const escaped = escapeRegExp(identifier);
  return new RegExp(`expect\\(\\s*${escaped}\\.status(?:\\s*,[\\s\\S]*?)?\\)\\.toBe\\(`, 'u').test(text)
    || new RegExp(`if\\s*\\([^)]*${escaped}\\.status[^)]*\\)\\s*\\{?[\\s\\S]{0,240}?throw\\b`, 'u').test(text);
}

function processResultIsFailClosed(text: string, identifier: string): boolean {
  const escaped = escapeRegExp(identifier);
  return new RegExp(`if\\s*\\(\\s*!\\s*${escaped}\\.ok\\s*\\)\\s*\\{[\\s\\S]{0,500}?throw\\b`, 'u').test(text)
    || new RegExp(`expect\\(\\s*${escaped}\\.ok(?:\\s*,[\\s\\S]*?)?\\)\\.toBe\\(true\\)`, 'u').test(text)
    || (new RegExp(`expect\\(\\s*${escaped}\\.outcome`, 'u').test(text)
      && new RegExp(`expect\\(\\s*${escaped}\\.exitCode`, 'u').test(text));
}

function returnedHelperName(text: string, call: ParsedCall): string | undefined {
  const prefix = text.slice(0, call.start);
  const functionMatches = [...prefix.matchAll(/function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/gu)];
  const candidate = functionMatches.at(-1);
  if (!candidate || candidate.index === undefined) return undefined;
  const open = text.indexOf('{', candidate.index);
  const close = matchingDelimiter(text, open);
  if (open < 0 || close < call.end) return undefined;
  if (!/return\s*$/u.test(text.slice(Math.max(open + 1, call.start - 40), call.start))) return undefined;
  return candidate[1];
}

function helperStatusIsAsserted(text: string, helper: string): boolean {
  const escaped = escapeRegExp(helper);
  if (new RegExp(`expect\\(\\s*${escaped}\\([^)]*\\)\\.status(?:\\s*,[\\s\\S]*?)?\\)\\.toBe\\(`, 'u').test(text)) return true;
  for (const match of text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*${escaped}\\(`, 'gu'))) {
    const identifier = match[1];
    if (identifier && statusIsAsserted(text, identifier)) return true;
  }
  return false;
}

function execFileSyncFailureIsNotSwallowed(text: string, call: ParsedCall): boolean {
  const before = text.slice(Math.max(0, call.start - 800), call.start);
  const after = text.slice(call.end, Math.min(text.length, call.end + 800));
  const lastTry = before.lastIndexOf('try');
  const lastBrace = before.lastIndexOf('}');
  return !(lastTry > lastBrace && /catch\s*(?:\([^)]*\))?\s*\{/u.test(after));
}

function invocationFailureIsFailClosed(text: string, call: ParsedCall): boolean {
  if (call.name === 'execFileSync') return execFileSyncFailureIsNotSwallowed(text, call);
  const identifier = assignedIdentifier(text, call);
  if (call.name === 'runProcessSync') return identifier !== undefined && processResultIsFailClosed(text, identifier);
  if (call.name === 'spawnSync') {
    if (identifier && statusIsAsserted(text, identifier)) return true;
    const helper = returnedHelperName(text, call);
    return helper !== undefined && helperStatusIsAsserted(text, helper);
  }
  return false;
}

function hasTestInvocation(text: string, marker: string): boolean {
  const target = referencedScriptPath(marker).replaceAll('\\', '/');
  const calls = parseCalls(text, new Set(['spawnSync', 'execFileSync', 'runProcessSync']));
  return calls.some((call) => invocationTargets(call, target) && invocationFailureIsFailClosed(text, call));
}'''
s = replace_block(s, 'interface ParsedCall {', 'function hasBehaviorContainerReference', new_call_block, 'census test invocation parser')
new_validate_header = r'''function validateHeader(census: GateCensus, failures: string[]): void {
  if (census.issue !== 830) failures.push('census provenance must remain bound to issue 830');
  if (census.version === 1) {
    if (census.wave !== '3.a' || census.migrationIssue !== undefined) {
      failures.push('schema v1 census must bind to issue 830 / wave 3.a');
    }
    return;
  }
  if (census.version !== 2 || census.wave !== '3.b' || census.migrationIssue !== 841) {
    failures.push('schema v2 census must bind to migration issue 841 / wave 3.b while retaining issue 830 provenance');
  }
  if (census.migrationInventoryPath !== WAVE_3B_MIGRATION_INVENTORY_PATH) {
    failures.push(`schema v2 census must bind to ${WAVE_3B_MIGRATION_INVENTORY_PATH}`);
  }
}'''
s = replace_block(s, 'function validateHeader(', 'export function validateCensusSchema', new_validate_header, 'census header validation')
s = replace_once(s, "  const digest = populationDigest(census.entries);\n  if (census.generation?.populationDigest !== digest) failures.push(`generated population digest drift: committed=${census.generation?.populationDigest ?? '<missing>'} actual=${digest}`);", "  const digest = populationDigest(census.entries);\n  if (census.generation?.populationDigest !== digest) failures.push(`generated population digest drift: committed=${census.generation?.populationDigest ?? '<missing>'} actual=${digest}`);\n  const ownershipDigest = migrationOwnershipDigest(census.entries);\n  if (census.generation?.migrationOwnershipDigest !== ownershipDigest) {\n    failures.push(`generated migration ownership digest drift: committed=${census.generation?.migrationOwnershipDigest ?? '<missing>'} actual=${ownershipDigest}`);\n  }\n  if (ownershipDigest !== EXPECTED_MIGRATION_OWNERSHIP_DIGEST) {\n    failures.push(`frozen migration ownership digest drift: expected=${EXPECTED_MIGRATION_OWNERSHIP_DIGEST} actual=${ownershipDigest}`);\n  }", 'census ownership digest validation')
s = replace_once(s, "  const failures = validateCensusSchema(census);\n  const baselineScripts = new Map(", "  const failures = validateCensusSchema(census);\n  const inventoryText = snapshot.files.get(WAVE_3B_MIGRATION_INVENTORY_PATH);\n  if (inventoryText === undefined) {\n    failures.push(`Wave 3.b migration inventory is missing: ${WAVE_3B_MIGRATION_INVENTORY_PATH}`);\n  } else {\n    try {\n      const inventory = parseWave3bMigrationInventory(inventoryText);\n      failures.push(...validateWave3bMigrationInventory(\n        inventory,\n        census.entries,\n        registeredGateIds,\n        {\n          requiredFiles: VERIFY_REQUIRED_FILES,\n          contractMarkers: VERIFY_CONTRACT_MARKERS,\n          promptGlob: VERIFY_PROMPT_GLOB,\n        },\n      ));\n    } catch (error) {\n      failures.push(`Wave 3.b migration inventory is invalid: ${error instanceof Error ? error.message : String(error)}`);\n    }\n  }\n  const baselineScripts = new Map(", 'census inventory evaluation')
write(path, s)

path = 'scripts/gate-runner/census.test.ts'
s = read(path)
ownership_test = r'''
  it('binds classification, gateIds, and portedInWave to the frozen migration ownership digest', () => {
    const census = clone(loadCensus(repoRoot));
    const index = census.entries.findIndex((entry) => entry.portedInWave === '3.b');
    expect(index).toBeGreaterThanOrEqual(0);
    const classificationEntries = [...census.entries];
    classificationEntries[index] = { ...classificationEntries[index]!, classification: classificationEntries[index]!.classification === 'ported-declarative' ? 'ported-custom' : 'ported-declarative' };
    expect(validateCensusSchema({ ...census, entries: classificationEntries }).join('\n')).toContain('migration ownership digest drift');
    const gateEntries = [...census.entries];
    gateEntries[index] = { ...gateEntries[index]!, gateIds: [...(gateEntries[index]!.gateIds ?? []), 'ghost-gate'] };
    expect(validateCensusSchema({ ...census, entries: gateEntries }).join('\n')).toContain('migration ownership digest drift');
    const waveEntries = [...census.entries];
    waveEntries[index] = { ...waveEntries[index]!, portedInWave: '3.a' };
    expect(validateCensusSchema({ ...census, entries: waveEntries }).join('\n')).toContain('migration ownership digest drift');
  });
'''
s = replace_once(s, "\n  it('rejects unnamed/invalid deferrals, provisional rows, and terminal-field leakage', () => {", ownership_test + "\n  it('rejects unnamed/invalid deferrals, provisional rows, and terminal-field leakage', () => {", 'census ownership mutation test')
invocation_tests = r'''

  it('rejects a suffix-matching path outside the repository-owned wrapper', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.legacyReference?.kind === 'test-invocation');
    expect(row).toBeDefined();
    const files = Object.fromEntries(captureSourceSnapshot(repoRoot).files);
    files[row!.legacyReference!.path] = ["import { spawnSync } from 'node:child_process';", `const result = spawnSync('pwsh', ['-NoProfile', '-File', '/tmp/foreign/${row!.sourcePath}']);`, 'expect(result.status).toBe(0);', ''].join('\n');
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain(`${row!.id}: typed legacy invocation is no longer executable`);
  });

  it('rejects an ignored spawnSync result for the retained wrapper', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.legacyReference?.kind === 'test-invocation');
    expect(row).toBeDefined();
    const files = Object.fromEntries(captureSourceSnapshot(repoRoot).files);
    files[row!.legacyReference!.path] = ["import { spawnSync } from 'node:child_process';", `spawnSync('pwsh', ['-NoProfile', '-File', '${row!.sourcePath}']);`, 'expect(true).toBe(true);', ''].join('\n');
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain(`${row!.id}: typed legacy invocation is no longer executable`);
  });

  it('rejects a swallowed execFileSync failure for the retained wrapper', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.legacyReference?.kind === 'test-invocation');
    expect(row).toBeDefined();
    const files = Object.fromEntries(captureSourceSnapshot(repoRoot).files);
    files[row!.legacyReference!.path] = ["import { execFileSync } from 'node:child_process';", 'try {', `  execFileSync('pwsh', ['-NoProfile', '-File', '${row!.sourcePath}']);`, '} catch {', '  // swallowed', '}', ''].join('\n');
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain(`${row!.id}: typed legacy invocation is no longer executable`);
  });
'''
s = replace_once(s, "\n  it('fails when a deferred legacy invocation disappears', () => {", invocation_tests + "\n  it('fails when a deferred legacy invocation disappears', () => {", 'census invocation mutation tests')
s = replace_once(s, "    expect(validateCensusSchema({ ...census, generation: { ...census.generation, populationDigest: '0'.repeat(64) } }).join('\\n')).toContain('generated population digest drift');", "    expect(validateCensusSchema({ ...census, generation: { ...census.generation, populationDigest: '0'.repeat(64) } }).join('\\n')).toContain('generated population digest drift');\n    expect(validateCensusSchema({ ...census, generation: { ...census.generation, migrationOwnershipDigest: '0'.repeat(64) } }).join('\\n')).toContain('generated migration ownership digest drift');", 'census generation ownership mutation')
write(path, s)

path = 'scripts/gate-runner/custom/bulk-cli-parity.test.ts'
s = read(path)
s = replace_once(s, "import { bulkDeclarativeGateDefinitions } from '../bulk-declarative-gates.ts';", "import { bulkDeclarativeGateDefinitions, VERIFY_REQUIRED_FILES } from '../bulk-declarative-gates.ts';", 'parity required files import')
s = replace_once(s, "import { formatGateRunnerReport, runGateRunner } from '../runner.ts';", "import { formatGateRunnerReport, registeredGateIds, runGateRunner } from '../runner.ts';", 'parity registered gates import')
s = replace_once(s, "  evaluateVerifyStructureContract,\n} from './bulk-static-gates.ts';", "  evaluateVerifyStructureContract,\n  VERIFY_CONTRACT_MARKERS,\n  VERIFY_PROMPT_GLOB,\n} from './bulk-static-gates.ts';", 'parity replacement surface imports')
s = replace_once(s, "import { evaluateNodeBackedGate, nodeBackedGateCommands } from './node-backed-gates.ts';", "import { evaluateNodeBackedGate, nodeBackedGateCommands } from './node-backed-gates.ts';\nimport { WAVE_3B_MIGRATION_INVENTORY_PATH, parseWave3bMigrationInventory, validateWave3bMigrationInventory, type Wave3bReplacementSurface } from '../wave-3b-migration-inventory.ts';", 'parity migration inventory imports')
s = replace_once(s, "const wave3b = JSON.parse(readFileSync(resolve(import.meta.dirname, '../goldens/wave-3b-pre-delete-captures.json'), 'utf8')) as CaptureManifest;", "const wave3b = JSON.parse(readFileSync(resolve(import.meta.dirname, '../goldens/wave-3b-pre-delete-captures.json'), 'utf8')) as CaptureManifest;\nconst wave3bInventory = parseWave3bMigrationInventory(readFileSync(resolve(repoRoot, WAVE_3B_MIGRATION_INVENTORY_PATH), 'utf8'));", 'parity migration inventory load')
new_completeness = r'''function replacementSurface(overrides: Partial<Wave3bReplacementSurface> = {}): Wave3bReplacementSurface {
  return { requiredFiles: VERIFY_REQUIRED_FILES, contractMarkers: VERIFY_CONTRACT_MARKERS, promptGlob: VERIFY_PROMPT_GLOB, ...overrides };
}

function wave3bParityCompletenessFailures(captures: readonly Capture[], surface: Wave3bReplacementSurface = replacementSurface()): string[] {
  const census = loadCensus(repoRoot);
  const failures = validateWave3bMigrationInventory(wave3bInventory, census.entries, registeredGateIds, surface);
  const standalone = wave3bInventory.entries.filter((entry) => entry.sourceKind === 'check-script');
  const byScript = capturesByScript(captures);
  for (const entry of standalone) {
    const evidence = byScript.get(entry.sourcePath) ?? [];
    if (!evidence.some((capture) => capture.exitCode === 0)) failures.push(`${entry.sourcePath}: missing successful legacy capture`);
    if (!evidence.some((capture) => capture.exitCode !== 0)) failures.push(`${entry.sourcePath}: missing failing legacy capture`);
    for (const gateId of entry.gateIds) if (!evidence.some((capture) => capture.gateId === gateId)) failures.push(`${entry.sourcePath}: missing capture for ${gateId}`);
  }
  const members = wave3bInventory.entries.filter((entry) => entry.sourceKind === 'verify-script-member');
  for (const member of members) {
    const ownerId = member.replacement.kind === 'standalone-owner' ? member.replacement.ownerId : '';
    const source = wave3bInventory.entries.find((entry) => entry.id === ownerId);
    if (!source) failures.push(`${member.id}: missing Wave 3.b standalone migration owner`);
    for (const gateId of member.gateIds) if (!source?.gateIds.includes(gateId)) failures.push(`${member.id}: gate ${gateId} is not covered by its standalone migration`);
  }
  const verifyRows = wave3bInventory.entries.filter((entry) => entry.sourceKind === 'verify-inline');
  for (const gateId of new Set(verifyRows.flatMap((entry) => [...entry.gateIds]))) {
    const evidence = captures.filter((capture) => capture.legacyScript === 'scripts/verify.ps1' && capture.gateId === gateId);
    if (!evidence.some((capture) => capture.exitCode === 0)) failures.push(`scripts/verify.ps1:${gateId}: missing successful legacy capture`);
    if (!evidence.some((capture) => capture.exitCode !== 0)) failures.push(`scripts/verify.ps1:${gateId}: missing failing legacy capture`);
  }
  for (const row of verifyRows) for (const gateId of row.gateIds) if (!captures.some((capture) => capture.legacyScript === 'scripts/verify.ps1' && capture.gateId === gateId)) failures.push(`${row.id}: missing verify behavior capture for ${gateId}`);
  return failures;
}'''
s = replace_block(s, 'function isPorted(', 'function extractPowerShellFunction', new_completeness, 'parity completeness source')
s = replace_once(s, "    const census = loadCensus(repoRoot);\n    const sourcePath = census.entries.find((entry) => entry.portedInWave === '3.b' && entry.sourceKind === 'check-script')?.sourcePath;", "    const sourcePath = wave3bInventory.entries.find((entry) => entry.sourceKind === 'check-script')?.sourcePath;", 'parity manifest mutation source')
replacement_tests = r'''

  it('fails completeness when one concrete required-file replacement rule is removed', () => {
    const row = wave3bInventory.entries.find((entry) => entry.replacement.kind === 'required-file-rule');
    expect(row).toBeDefined();
    const replacement = row!.replacement;
    if (replacement.kind !== 'required-file-rule') throw new Error('expected required-file replacement');
    const failures = wave3bParityCompletenessFailures(wave3b.captures, replacementSurface({ requiredFiles: VERIFY_REQUIRED_FILES.filter((path) => path !== replacement.path) }));
    expect(failures.join('\n')).toContain(`${row!.id}: required-file replacement rule is missing`);
  });

  it('fails completeness when one concrete contract marker replacement is removed', () => {
    const row = wave3bInventory.entries.find((entry) => entry.replacement.kind === 'contract-marker-rule');
    expect(row).toBeDefined();
    const replacement = row!.replacement;
    if (replacement.kind !== 'contract-marker-rule') throw new Error('expected contract-marker replacement');
    const [marker] = replacement.markers;
    expect(marker).toBeDefined();
    const failures = wave3bParityCompletenessFailures(wave3b.captures, replacementSurface({ contractMarkers: { ...VERIFY_CONTRACT_MARKERS, [replacement.path]: (VERIFY_CONTRACT_MARKERS[replacement.path] ?? []).filter((value) => value !== marker) } }));
    expect(failures.join('\n')).toContain(`${row!.id}: concrete replacement marker is missing: ${marker}`);
  });
'''
s = replace_once(s, "\n  it('binds standalone fixtures and verify replay predicates to frozen source evidence', () => {", replacement_tests + "\n  it('binds standalone fixtures and verify replay predicates to frozen source evidence', () => {", 'parity concrete replacement mutation tests')
write(path, s)

baseline_path = ROOT / 'scripts/gate-runner/census/pre-change-baseline.json'
baseline = json.loads(baseline_path.read_text(encoding='utf-8'))
baseline['migrationInventoryPath'] = 'scripts/gate-runner/census/wave-3b-migration-inventory.json'
baseline_path.write_text(json.dumps(baseline, separators=(',', ':')) + '\n', encoding='utf-8')

generation_path = ROOT / 'scripts/gate-runner/census/generation.json'
generation = json.loads(generation_path.read_text(encoding='utf-8'))
generation['migrationOwnershipDigest'] = 'e72c1eb63da367470283a8f3f684f9b03f2eccd90fb68ddb40da337cc261f9f1'
generation_path.write_text(json.dumps(generation, indent=2) + '\n', encoding='utf-8')

contract_markers = {
    'plugins/ao-task-declaration/README.md': ['DD-026', 'DD-027', 'declared_files', 'denylist', 'one amendment', 'baseline'],
    'plugins/ao-scope-guard/README.md': ['DD-024', 'runtime guard', 'git add', 'commit', 'PR-level CI', 'second line'],
    'plugins/ao-token-chain-ledger/README.md': ['chain_id', 'planner', 'reviewer', 'worker', 'per-session cost', 'estimated_cost_usd'],
    'plugins/ao-codex-pr-reviewer/README.md': ['Codex', 'gpt-5.5', 'PR review', 'GitHub Issues', 'no core patch'],
}
entries = []
for entry in baseline['entries']:
    if entry.get('portedInWave') != '3.b':
        continue
    item = {key: entry[key] for key in ('id', 'sourceKind', 'sourcePath', 'marker', 'classification', 'gateIds', 'portedInWave')}
    if entry['sourceKind'] == 'check-script':
        replacement = {'kind': 'registered-gate', 'gateIds': entry['gateIds']}
    elif entry['sourceKind'] == 'verify-script-member':
        replacement = {'kind': 'standalone-owner', 'ownerId': f"check-script:{entry['marker']}", 'gateIds': entry['gateIds']}
    elif entry['id'].startswith('verify-inline:required-file:'):
        replacement = {'kind': 'required-file-rule', 'gateId': 'verify-required-files', 'path': entry['marker']}
    elif entry['id'].startswith('verify-inline:contract-marker:'):
        marker_path = entry['id'].removeprefix('verify-inline:contract-marker:')
        replacement = {'kind': 'contract-marker-rule', 'gateId': 'verify-structure-contract', 'path': marker_path, 'markers': contract_markers[marker_path]}
    elif entry['id'] == 'verify-inline:write-check:prompts/*.md':
        replacement = {'kind': 'prompt-glob-rule', 'gateId': 'verify-structure-contract', 'pattern': 'prompts/*.md'}
    else:
        raise RuntimeError(f"unmapped Wave 3.b ownership row: {entry['id']}")
    item['replacement'] = replacement
    entries.append(item)
inventory = {'version': 1, 'issue': 841, 'baseCommitSha': '0e8846b1e7caf063d73792700968971d75e0524f', 'entries': entries}
inventory_path = ROOT / 'scripts/gate-runner/census/wave-3b-migration-inventory.json'
inventory_path.write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')
print(f'Applied issue 841 proof remediation to {len(entries)} frozen Wave 3.b ownership rows.')
