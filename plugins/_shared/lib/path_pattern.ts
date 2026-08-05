import { normalizePath } from './normalize.js';

export type PathPatternKind = 'exact' | 'directory' | 'pattern';

type SegmentToken =
  | { kind: 'double-star' }
  | { kind: 'segment'; pattern: string };

export interface ParsedPathPattern {
  source: string;
  kind: PathPatternKind;
  tokens: SegmentToken[];
}

export type PathPatternParseResult =
  | { ok: true; pattern: ParsedPathPattern }
  | { ok: false; reason: string };

const UNSUPPORTED_SYNTAX = /[\[\]{}?]/;
const EXTGLOB_SYNTAX = /(?:^|[^\\])[@+?!*]\(/;

function fail(source: string, reason: string): PathPatternParseResult {
  return { ok: false, reason: `"${source}": ${reason}` };
}

export function parsePathPattern(source: string): PathPatternParseResult {
  const normalized = normalizePath(source);
  if (!normalized.ok) return fail(source, normalized.reason);

  let value = normalized.path;
  const trailingDirectory = value.endsWith('/');
  if (trailingDirectory) value = value.slice(0, -1);

  if (UNSUPPORTED_SYNTAX.test(value) || EXTGLOB_SYNTAX.test(value)) {
    return fail(source, 'unsupported pattern syntax');
  }

  const segments = value.split('/');
  const tokens: SegmentToken[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === '**') {
      if (trailingDirectory) {
        return fail(source, 'a trailing-slash directory marker must contain only literal segments');
      }
      tokens.push({ kind: 'double-star' });
      continue;
    }
    if (segment.includes('**')) {
      return fail(source, 'double-star must occupy a complete path segment');
    }
    if (segment.includes('*') && index !== segments.length - 1) {
      return fail(source, 'single-star is supported only in the final path segment');
    }
    if (trailingDirectory && segment.includes('*')) {
      return fail(source, 'a trailing-slash directory marker must contain only literal segments');
    }
    tokens.push({ kind: 'segment', pattern: segment });
  }

  if (trailingDirectory) {
    tokens.push({ kind: 'double-star' });
    return {
      ok: true,
      pattern: { source: normalized.path, kind: 'directory', tokens },
    };
  }

  const terminalDirectory =
    tokens.length > 1 &&
    tokens.at(-1)?.kind === 'double-star' &&
    tokens.slice(0, -1).every(
      (token) => token.kind === 'segment' && !token.pattern.includes('*'),
    );

  const hasPattern = tokens.some(
    (token) => token.kind === 'double-star' || token.pattern.includes('*'),
  );

  return {
    ok: true,
    pattern: {
      source: normalized.path,
      kind: terminalDirectory ? 'directory' : hasPattern ? 'pattern' : 'exact',
      tokens,
    },
  };
}

function parseConcretePath(source: string):
  | { ok: true; segments: string[]; path: string }
  | { ok: false; reason: string } {
  const normalized = normalizePath(source);
  if (!normalized.ok) return normalized;
  if (normalized.path.endsWith('/')) {
    return { ok: false, reason: 'concrete paths must not use a trailing slash' };
  }
  if (
    normalized.path.includes('*') ||
    UNSUPPORTED_SYNTAX.test(normalized.path) ||
    EXTGLOB_SYNTAX.test(normalized.path)
  ) {
    return { ok: false, reason: 'concrete paths must not contain pattern syntax' };
  }
  return {
    ok: true,
    path: normalized.path,
    segments: normalized.path.split('/'),
  };
}

function segmentMatches(pattern: string, value: string): boolean {
  const patternChars = Array.from(pattern);
  const valueChars = Array.from(value);
  const memo = new Map<string, boolean>();

  const visit = (patternIndex: number, valueIndex: number): boolean => {
    const key = `${patternIndex}:${valueIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (patternIndex === patternChars.length) {
      result = valueIndex === valueChars.length;
    } else if (patternChars[patternIndex] === '*') {
      result =
        visit(patternIndex + 1, valueIndex) ||
        (valueIndex < valueChars.length && visit(patternIndex, valueIndex + 1));
    } else {
      result =
        valueIndex < valueChars.length &&
        patternChars[patternIndex] === valueChars[valueIndex] &&
        visit(patternIndex + 1, valueIndex + 1);
    }

    memo.set(key, result);
    return result;
  };

  return valueChars.length > 0 && visit(0, 0);
}

function matchesParsed(pattern: ParsedPathPattern, segments: string[]): boolean {
  const memo = new Map<string, boolean>();

  const visit = (tokenIndex: number, segmentIndex: number): boolean => {
    const key = `${tokenIndex}:${segmentIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    const token = pattern.tokens[tokenIndex];
    let result: boolean;
    if (!token) {
      result = segmentIndex === segments.length;
    } else if (token.kind === 'double-star') {
      result =
        visit(tokenIndex + 1, segmentIndex) ||
        (segmentIndex < segments.length && visit(tokenIndex, segmentIndex + 1));
    } else {
      result =
        segmentIndex < segments.length &&
        segmentMatches(token.pattern, segments[segmentIndex]!) &&
        visit(tokenIndex + 1, segmentIndex + 1);
    }

    memo.set(key, result);
    return result;
  };

  return segments.length > 0 && visit(0, 0);
}

export function matchesPathPattern(pattern: string, path: string): boolean {
  const parsedPattern = parsePathPattern(pattern);
  const parsedPath = parseConcretePath(path);
  return (
    parsedPattern.ok &&
    parsedPath.ok &&
    matchesParsed(parsedPattern.pattern, parsedPath.segments)
  );
}

export function pathMatchesAnyPattern(
  path: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => matchesPathPattern(pattern, path));
}

type PositionSet = ReadonlySet<number>;
const OTHER = Symbol('other-character');

function closure(pattern: string[], input: PositionSet): Set<number> {
  const result = new Set(input);
  const pending = [...result];
  while (pending.length > 0) {
    const position = pending.pop()!;
    if (pattern[position] === '*' && !result.has(position + 1)) {
      result.add(position + 1);
      pending.push(position + 1);
    }
  }
  return result;
}

function moveCharacter(
  pattern: string[],
  positions: PositionSet,
  symbol: string | typeof OTHER,
): Set<number> {
  const next = new Set<number>();
  for (const position of positions) {
    const token = pattern[position];
    if (token === '*') {
      next.add(position);
    } else if (token !== undefined && symbol !== OTHER && token === symbol) {
      next.add(position + 1);
    }
  }
  return closure(pattern, next);
}

function stateKey(state: PositionSet): string {
  return [...state].sort((a, b) => a - b).join(',');
}

interface SegmentDfa {
  pattern: string[];
  start: Set<number>;
  accept: number;
}

function makeSegmentDfa(pattern: string): SegmentDfa {
  const chars = Array.from(pattern);
  return {
    pattern: chars,
    start: closure(chars, new Set([0])),
    accept: chars.length,
  };
}

function realizableSegmentAtoms(patterns: readonly string[]): bigint[] {
  const unique = [...new Set(patterns)];
  if (unique.length === 0) return [0n];

  const dfas = unique.map(makeSegmentDfa);
  const literalAlphabet = new Set<string>();
  for (const dfa of dfas) {
    for (const token of dfa.pattern) {
      if (token !== '*') literalAlphabet.add(token);
    }
  }
  const alphabet: Array<string | typeof OTHER> = [...literalAlphabet, OTHER];

  type ProductState = { states: Set<number>[]; consumed: boolean };
  const start: ProductState = {
    states: dfas.map((dfa) => dfa.start),
    consumed: false,
  };
  const keyOf = (state: ProductState) =>
    `${state.consumed ? 1 : 0}|${state.states.map(stateKey).join('|')}`;

  const queue = [start];
  const seen = new Set([keyOf(start)]);
  const masks = new Set<bigint>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.consumed) {
      let mask = 0n;
      current.states.forEach((state, index) => {
        if (state.has(dfas[index]!.accept)) mask |= 1n << BigInt(index);
      });
      masks.add(mask);
    }

    for (const symbol of alphabet) {
      const next: ProductState = {
        states: current.states.map((state, index) =>
          moveCharacter(dfas[index]!.pattern, state, symbol),
        ),
        consumed: true,
      };
      const key = keyOf(next);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(next);
      }
    }
  }

  return [...masks].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function pathClosure(tokens: SegmentToken[], input: PositionSet): Set<number> {
  const result = new Set(input);
  const pending = [...result];
  while (pending.length > 0) {
    const position = pending.pop()!;
    if (tokens[position]?.kind === 'double-star' && !result.has(position + 1)) {
      result.add(position + 1);
      pending.push(position + 1);
    }
  }
  return result;
}

function moveSegment(
  tokens: SegmentToken[],
  positions: PositionSet,
  atom: bigint,
  predicateIndexes: ReadonlyMap<string, number>,
): Set<number> {
  const next = new Set<number>();
  for (const position of positions) {
    const token = tokens[position];
    if (!token) continue;
    if (token.kind === 'double-star') {
      next.add(position);
      continue;
    }
    const predicateIndex = predicateIndexes.get(token.pattern);
    if (
      predicateIndex !== undefined &&
      (atom & (1n << BigInt(predicateIndex))) !== 0n
    ) {
      next.add(position + 1);
    }
  }
  return pathClosure(tokens, next);
}

function compareLanguages(
  left: ParsedPathPattern,
  right: ParsedPathPattern,
  mode: 'overlap' | 'subset',
): boolean {
  const predicates = [
    ...new Set(
      [...left.tokens, ...right.tokens]
        .filter(
          (token): token is Extract<SegmentToken, { kind: 'segment' }> =>
            token.kind === 'segment',
        )
        .map((token) => token.pattern),
    ),
  ];
  const predicateIndexes = new Map(
    predicates.map((predicate, index) => [predicate, index]),
  );
  const atoms = realizableSegmentAtoms(predicates);

  type Pair = {
    left: Set<number>;
    right: Set<number>;
    consumed: boolean;
  };
  const start: Pair = {
    left: pathClosure(left.tokens, new Set([0])),
    right: pathClosure(right.tokens, new Set([0])),
    consumed: false,
  };
  const keyOf = (pair: Pair) =>
    `${pair.consumed ? 1 : 0}|${stateKey(pair.left)}|${stateKey(pair.right)}`;
  const queue = [start];
  const seen = new Set([keyOf(start)]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const leftAccepts =
      current.consumed && current.left.has(left.tokens.length);
    const rightAccepts =
      current.consumed && current.right.has(right.tokens.length);

    if (mode === 'overlap' && leftAccepts && rightAccepts) return true;
    if (mode === 'subset' && leftAccepts && !rightAccepts) return false;

    for (const atom of atoms) {
      const nextLeft = moveSegment(
        left.tokens,
        current.left,
        atom,
        predicateIndexes,
      );
      if (nextLeft.size === 0) continue;
      const nextRight = moveSegment(
        right.tokens,
        current.right,
        atom,
        predicateIndexes,
      );
      if (mode === 'overlap' && nextRight.size === 0) continue;

      const next: Pair = {
        left: nextLeft,
        right: nextRight,
        consumed: true,
      };
      const key = keyOf(next);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(next);
      }
    }
  }

  return mode === 'subset';
}

export function pathPatternsOverlap(left: string, right: string): boolean {
  const parsedLeft = parsePathPattern(left);
  const parsedRight = parsePathPattern(right);
  return (
    parsedLeft.ok &&
    parsedRight.ok &&
    compareLanguages(parsedLeft.pattern, parsedRight.pattern, 'overlap')
  );
}

export function pathPatternWithin(candidate: string, root: string): boolean {
  const parsedCandidate = parsePathPattern(candidate);
  const parsedRoot = parsePathPattern(root);
  return (
    parsedCandidate.ok &&
    parsedRoot.ok &&
    compareLanguages(parsedCandidate.pattern, parsedRoot.pattern, 'subset')
  );
}
