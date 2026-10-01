function stripOpenCodeAnsi(line: string): string {
  return line.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '').trim();
}

/**
 * Return only user-visible text rows from the last rendered OpenCode composer.
 * Undefined means the composer geometry itself is not trustworthy.
 */
export function openCodeComposerContentLines(lines: readonly string[]): string[] | undefined {
  let bottomEdge = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/╹▀▀▀/u.test(lines[index] ?? '')) {
      bottomEdge = index;
      break;
    }
  }
  if (bottomEdge < 0) return undefined;

  const content: string[] = [];
  let sawLeftEdge = false;
  for (let index = bottomEdge - 1; index >= 0; index -= 1) {
    const trimmed = stripOpenCodeAnsi(lines[index] ?? '');
    if (!trimmed) continue;
    const body = trimmed.replace(/^[┃│]\s*/u, '');
    if (/^Ask anything(?:\.\.\.|…)(?:\s+"[^"]*")?$/u.test(body)) {
      sawLeftEdge = true;
      continue;
    }
    if (/^┃\s+TeamoRouter 钱包余额不足，请前往 https:\/\/teamorouter\.cn\/dashboard\?buy=1 充值后继续使用$/u.test(trimmed)) {
      sawLeftEdge = true;
      continue;
    }
    if (!trimmed.startsWith('┃')) break;
    sawLeftEdge = true;
    if (/^┃\s+(?:Pack-Opk-|Pack\s+·\s|[0-9a-f]{16,}(?:\s|$))/iu.test(trimmed)) continue;
    if (trimmed === '┃') continue;
    if (body) content.unshift(body);
  }
  return sawLeftEdge ? content : undefined;
}

export function openCodeComposerMatchesText(lines: readonly string[], text: string): boolean {
  const content = openCodeComposerContentLines(lines);
  if (!content || content.length === 0) return false;
  const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
  return normalize(content.join(' ')) === normalize(text);
}
