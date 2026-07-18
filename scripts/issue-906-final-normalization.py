from pathlib import Path

path = Path('scripts/estate-cut/manifest-generator.mjs')
text = path.read_text()
old = """function pruneDeletedPowerShellPathEntries(text, deletedSet) {
  const lines = text.split(/\\r?\\n/u).filter((line) => {
    const match = /^\\s*'([^']+)'\\s*,?\\s*$/u.exec(line);
    return !(match && deletedSet.has(normalize(match[1])));
  });
  return `${lines.join('\\n').trimEnd()}\\n`;
}
"""
new = """function pruneDeletedPowerShellPathEntries(text, deletedSet) {
  const lines = text.split(/\\r?\\n/u).filter((line) => {
    const match = /^\\s*'([^']+)'\\s*,?\\s*$/u.exec(line);
    return !(match && deletedSet.has(normalize(match[1])));
  });
  const rewritten = lines.join('\\n')
    .replace(/,\\n(\\s*\\))/gu, '\\n$1')
    .trimEnd();
  return `${rewritten}\\n`;
}
"""
if text.count(old) != 1:
    raise SystemExit('issue-906 PowerShell path normalization target drifted')
path.write_text(text.replace(old, new, 1))
