/**
 * Minimal glob matching for runtime scope validation (#3.A).
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

export function pathMatchesAnyPattern(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path));
}
