from pathlib import Path
p=Path('scripts/gate-runner/census.ts')
text=p.read_text()
text=text.replace("import ts from 'typescript';\n","")
start=text.index('function childProcessFunctionName(')
end=text.index('\nfunction hasBehaviorContainerReference', start)
new=r'''interface ParsedCall {
  readonly name: string;
  readonly arguments: readonly string[];
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
    calls.push({ name, arguments: splitTopLevel(text.slice(opening + 1, closing)) });
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
  return { name: finalName, arguments: splitTopLevel(trimmed.slice(index + 1, closing)) };
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

function normalizedPathExpression(expression: string): string | undefined {
  const literal = parseStringLiteral(expression);
  if (literal !== undefined) return literal.replaceAll('\\', '/').replace(/^\.\//u, '');
  const call = parseCallExpression(expression, new Set(['join', 'resolve']));
  if (!call) return undefined;
  const segments: string[] = [];
  for (const argument of call.arguments) {
    const value = normalizedPathExpression(argument);
    if (value !== undefined && value.length > 0) segments.push(value.replace(/^\/+|\/+$/gu, ''));
  }
  return segments.length > 0 ? segments.join('/') : undefined;
}

function pathExpressionTargets(expression: string, target: string): boolean {
  const candidate = normalizedPathExpression(expression)?.replaceAll('\\', '/').replace(/^\.\//u, '');
  return candidate === target || candidate?.endsWith(`/${target}`) === true;
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

function hasTestInvocation(text: string, marker: string): boolean {
  const target = referencedScriptPath(marker).replaceAll('\\', '/');
  const calls = parseCalls(text, new Set(['spawnSync', 'execFileSync', 'runProcessSync']));
  return calls.some((call) => invocationTargets(call, target));
}
'''
text=text[:start]+new+text[end:]
p.write_text(text)
