export function escapeRegexLiteral(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegex(glob) {
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
    pattern += escapeRegexLiteral(glob[index]);
    index += 1;
  }
  return new RegExp(`^${pattern}$`);
}

export function globMatches(pattern, candidate) {
  return globToRegex(pattern.replace(/\\/g, '/')).test(candidate.replace(/\\/g, '/'));
}
