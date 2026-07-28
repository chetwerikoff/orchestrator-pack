/**
 * Minimal glob matching for declaration-time scope validation (#3.A).
 */

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob: string): RegExp {
  let pattern = '';
  let index = 0;

  while (index < glob.length) {
    if (glob[index] === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 3;
        continue;
      }
      pattern += '.*';
      index += 2;
      continue;
    }

    if (glob[index] === '*') {
      pattern += '[^/]*';
      index += 1;
      continue;
    }

    if (glob[index] === '?') {
      pattern += '[^/]';
      index += 1;
      continue;
    }

    pattern += escapeRegexLiteral(glob[index]!);
    index += 1;
  }

  return new RegExp(`^${pattern}$`);
}

export function matchesGlob(pattern: string, value: string): boolean {
  return globToRegex(pattern).test(value);
}

export function globPatternsOverlap(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  if (left === '**' || right === '**') {
    return true;
  }

  const leftPrefix = left.replace(/(\*\*|\*|\?).*$/, '');
  const rightPrefix = right.replace(/(\*\*|\*|\?).*$/, '');

  if (!leftPrefix || !rightPrefix) {
    return left.includes('*') || right.includes('*');
  }

  return left.startsWith(rightPrefix) || right.startsWith(leftPrefix);
}

export function pathMatchesAnyPattern(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path));
}

export function globIsWithinAllowedRoot(glob: string, allowedRoot: string): boolean {
  if (glob === allowedRoot) {
    return true;
  }

  if (allowedRoot.endsWith('/**')) {
    const prefix = allowedRoot.slice(0, -3);
    if (prefix === '') {
      return true;
    }
    return glob === prefix || glob.startsWith(`${prefix}/`);
  }

  if (allowedRoot.endsWith('/*')) {
    const prefix = allowedRoot.slice(0, -2);
    return glob === prefix || glob.startsWith(`${prefix}/`);
  }

  return glob === allowedRoot || glob.startsWith(`${allowedRoot}/`);
}
