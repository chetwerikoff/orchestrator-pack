export type TokenKind = 'runtime' | 'script';

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface TokenOccurrence {
  readonly sourcePath: string;
  readonly line: number;
  readonly column: number;
  readonly tokenKind: TokenKind;
  readonly matchedBytes: string;
  readonly byteOffset: number;
}

export type WholePathResolver = (candidate: string) => boolean;

const RUNTIME = /(?:^|[^A-Za-z0-9_.-])(pwsh(?:\.exe)?|powershell(?:\.exe)?)(?=$|[^A-Za-z0-9_.-])/iy;
const SCRIPT = /(?:^|[^A-Za-z0-9_.$@{}()+:=/\\-])((?:[A-Za-z0-9_.$@{}()+:=.-]+[\\/])*[A-Za-z0-9_.$@{}()+:=.-]+\.ps1)(?=$|[^A-Za-z0-9_.$@{}()+:=/\\-])/iy;

function isDelimiter(byte: number): boolean {
  return byte === 0x27 || byte === 0x22 || byte === 0x60;
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString('latin1');
}

function coordinates(buffer: Buffer, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (buffer[index] === 0x0a) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function matchAnchored(regex: RegExp, text: string, cursor: number): RegExpExecArray | null {
  regex.lastIndex = cursor;
  return regex.exec(text);
}

function captureOffset(match: RegExpExecArray, capture: string): number {
  const full = match[0];
  const index = full.toLowerCase().indexOf(capture.toLowerCase());
  return match.index + Math.max(0, index);
}

function wholeDelimitedPath(interior: string, resolver: WholePathResolver): boolean {
  if (!interior.toLowerCase().endsWith('.ps1') || /[\r\n]/u.test(interior)) return false;
  if (!/^[^"'`\r\n]+\.ps1$/iu.test(interior)) return false;
  const firstSegment = interior.split(/[\\/]/u, 1)[0] ?? '';
  return !/[\t ]/u.test(firstSegment) || resolver(interior);
}

interface RelativeMatch {
  readonly kind: TokenKind;
  readonly capture: string;
  readonly captureStart: number;
  readonly consumedEnd: number;
}

function firstTokenAt(text: string, cursor: number): RelativeMatch | null {
  const runtime = matchAnchored(RUNTIME, text, cursor);
  const script = matchAnchored(SCRIPT, text, cursor);
  const candidates: RelativeMatch[] = [];
  if (runtime?.[1]) candidates.push({ kind: 'runtime', capture: runtime[1], captureStart: captureOffset(runtime, runtime[1]), consumedEnd: runtime.index + runtime[0].length });
  if (script?.[1]) candidates.push({ kind: 'script', capture: script[1], captureStart: captureOffset(script, script[1]), consumedEnd: script.index + script[0].length });
  candidates.sort((left, right) => left.captureStart - right.captureStart || (left.kind === 'runtime' ? -1 : 1));
  return candidates[0] ?? null;
}

function scanPlain(text: string, start: number, end: number): RelativeMatch[] {
  const matches: RelativeMatch[] = [];
  let cursor = start;
  while (cursor < end) {
    const match = firstTokenAt(text, cursor);
    if (match && match.captureStart < end && match.consumedEnd <= end) {
      matches.push(match);
      cursor = Math.max(cursor + 1, match.captureStart + match.capture.length);
    } else cursor += 1;
  }
  return matches;
}

function scanLine(text: string, lineStart: number, lineEnd: number, resolver: WholePathResolver): RelativeMatch[] {
  const matches: RelativeMatch[] = [];
  let cursor = lineStart;
  while (cursor < lineEnd) {
    const byte = text.charCodeAt(cursor);
    if (!isDelimiter(byte)) {
      const token = firstTokenAt(text, cursor);
      if (token && token.captureStart < lineEnd && token.consumedEnd <= lineEnd) {
        matches.push(token);
        cursor = Math.max(cursor + 1, token.captureStart + token.capture.length);
      } else cursor += 1;
      continue;
    }
    const delimiter = text[cursor]!;
    const close = text.indexOf(delimiter, cursor + 1);
    if (close < 0 || close >= lineEnd) {
      cursor += 1;
      continue;
    }
    const interior = text.slice(cursor + 1, close);
    if (wholeDelimitedPath(interior, resolver)) {
      matches.push({ kind: 'script', capture: interior, captureStart: cursor + 1, consumedEnd: close + 1 });
    } else {
      matches.push(...scanPlain(text, cursor + 1, close));
    }
    cursor = close + 1;
  }
  return matches;
}

function mergedRanges(buffer: Buffer, ranges: readonly ByteRange[] | undefined): readonly ByteRange[] {
  if (!ranges) return [{ start: 0, end: buffer.length }];
  const valid = ranges
    .map(({ start, end }) => ({ start: Math.max(0, start), end: Math.min(buffer.length, end) }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const result: Array<{ start: number; end: number }> = [];
  for (const range of valid) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

export function scanPowerShellTokens(input: {
  readonly sourcePath: string;
  readonly bytes: Buffer;
  readonly ranges?: readonly ByteRange[];
  readonly resolvesWholePath: WholePathResolver;
}): readonly TokenOccurrence[] {
  const text = input.bytes.toString('latin1');
  const result: TokenOccurrence[] = [];
  for (const range of mergedRanges(input.bytes, input.ranges)) {
    let segmentStart = range.start;
    while (segmentStart < range.end) {
      const lf = input.bytes.indexOf(0x0a, segmentStart);
      const lineEnd = lf < 0 || lf >= range.end ? range.end : lf;
      for (const match of scanLine(text, segmentStart, lineEnd, input.resolvesWholePath)) {
        const matchedBytes = ascii(input.bytes, match.captureStart, match.captureStart + match.capture.length);
        const { line, column } = coordinates(input.bytes, match.captureStart);
        result.push({ sourcePath: input.sourcePath, line, column, tokenKind: match.kind, matchedBytes, byteOffset: match.captureStart });
      }
      if (lf < 0 || lf >= range.end) break;
      segmentStart = lf + 1;
    }
  }
  result.sort((left, right) => left.byteOffset - right.byteOffset || left.tokenKind.localeCompare(right.tokenKind));
  return result;
}

function lineRanges(bytes: Buffer): readonly ByteRange[] {
  const ranges: ByteRange[] = [];
  let start = 0;
  while (start < bytes.length) {
    const lf = bytes.indexOf(0x0a, start);
    const end = lf < 0 ? bytes.length : lf;
    ranges.push({ start, end });
    if (lf < 0) break;
    start = lf + 1;
  }
  return ranges;
}

function commentStart(text: string): number {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') return index;
  }
  return text.length;
}

function colonOutsideQuotes(text: string): number {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ':') return index;
  }
  return -1;
}

export function yamlScalarRanges(bytes: Buffer): readonly ByteRange[] {
  const ranges: ByteRange[] = [];
  let blockIndent: number | undefined;
  for (const line of lineRanges(bytes)) {
    const raw = bytes.subarray(line.start, line.end).toString('latin1');
    const indentation = /^ */u.exec(raw)?.[0].length ?? 0;
    const trimmed = raw.trim();
    if (blockIndent !== undefined) {
      if (trimmed === '') continue;
      if (indentation > blockIndent) {
        ranges.push({ start: line.start + indentation, end: line.end });
        continue;
      }
      blockIndent = undefined;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const visibleEnd = commentStart(raw);
    const visible = raw.slice(0, visibleEnd);
    const colon = colonOutsideQuotes(visible);
    let valueStart = -1;
    if (colon >= 0) valueStart = colon + 1;
    else {
      const sequence = /^\s*-\s+/u.exec(visible);
      if (sequence) valueStart = sequence[0].length;
    }
    if (valueStart < 0) continue;
    while (valueStart < visible.length && /[ \t]/u.test(visible[valueStart]!)) valueStart += 1;
    const value = visible.slice(valueStart);
    if (/^[|>][0-9+-]*\s*$/u.test(value)) {
      blockIndent = indentation;
      continue;
    }
    if (valueStart < visible.length) ranges.push({ start: line.start + valueStart, end: line.start + visible.length });
  }
  return ranges;
}

export function jsonStringValueRanges(bytes: Buffer): readonly ByteRange[] {
  const text = bytes.toString('latin1');
  const ranges: ByteRange[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '"') {
      cursor += 1;
      continue;
    }
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2;
      else if (text[cursor] === '"') break;
      else cursor += 1;
    }
    if (cursor >= text.length) throw new Error('unterminated JSON string while scanning config values');
    const end = cursor;
    cursor += 1;
    let after = cursor;
    while (after < text.length && /\s/u.test(text[after]!)) after += 1;
    if (text[after] !== ':') ranges.push({ start: start + 1, end });
  }
  return ranges;
}

export function tsStringRanges(bytes: Buffer): readonly ByteRange[] {
  const text = bytes.toString('latin1');
  const ranges: ByteRange[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text.startsWith('//', cursor)) {
      const lf = text.indexOf('\n', cursor + 2);
      cursor = lf < 0 ? text.length : lf + 1;
      continue;
    }
    if (text.startsWith('/*', cursor)) {
      const close = text.indexOf('*/', cursor + 2);
      cursor = close < 0 ? text.length : close + 2;
      continue;
    }
    const quote = text[cursor];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      cursor += 1;
      continue;
    }
    const start = cursor + 1;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2;
      else if (text[cursor] === quote) break;
      else cursor += 1;
    }
    if (cursor >= text.length) throw new Error('unterminated TypeScript string literal while scanning config values');
    ranges.push({ start, end: cursor });
    cursor += 1;
  }
  return ranges;
}
